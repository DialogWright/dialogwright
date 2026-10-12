import { amzDateOf, authorization, canonicalQuery, EMPTY_SHA256, sha256Hex, uriEncode, type Credentials } from './sigv4';

/**
 * The little of an S3-compatible store the traces need (TRACE_STORE=s3://...): put an object, get one,
 * delete one, and list a prefix, each request signed with SigV4 (./sigv4.ts) and sent with `fetch`, with
 * a deadline on every request. AWS S3 by default; any S3-compatible store (Cloudflare R2, MinIO and
 * others) through S3_ENDPOINT, path-style (`<endpoint>/<bucket>/<key>`) where S3_FORCE_PATH_STYLE=on
 * says, else virtual-hosted (`<bucket>.<endpoint host>/<key>`). An error says the operation, the key and
 * the store's status and code, never a key or a signature.
 */

export interface S3Settings {
  bucket: string;
  /** Where the store is: `https://<host>[:port]`; absent, AWS's for the region. */
  endpoint?: string;
  region: string;
  credentials: Credentials;
  /** `<endpoint>/<bucket>/<key>` rather than `<bucket>.<endpoint host>/<key>` (MinIO, a store on an address). */
  forcePathStyle: boolean;
}

/** How long one request to the store may take before it is given up, its answer's body included. */
export const S3_TIMEOUT_MS = 10_000;
/** The most an object read back may be (a segment is far smaller), and the most a listing page or an error may be. */
export const S3_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const S3_MAX_PAGE_BYTES = 16 * 1024 * 1024;
/** How many pages a listing reads before it refuses to go on (never a listing cut short in silence). */
export const S3_MAX_PAGES = 1_000;

/** A store's error code as it may be said: its letters and digits, or nothing (a code is never taken as it came). */
function safeCode(code: string | null): string | null {
  return code !== null && /^[A-Za-z0-9.]{1,64}$/.test(code) ? code : null;
}

export interface S3Object {
  key: string;
  lastModifiedMs: number;
  size: number;
}

/** A request the store refused or did not answer: the operation, the key, and why, never a secret. */
export class S3Error extends Error {
  constructor(readonly operation: string, readonly key: string, readonly status: number | null, readonly code: string | null, detail?: string) {
    super(`S3 ${operation} ${key}: ${status === null ? (detail ?? 'no answer') : `${status}${code ? ` ${code}` : ''}`}`);
    this.name = 'S3Error';
  }
}

export interface S3ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** The base URL a bucket is reached at, and the path prefix a key goes under. */
export function bucketBase(s: Pick<S3Settings, 'bucket' | 'endpoint' | 'region' | 'forcePathStyle'>): { origin: string; host: string; pathPrefix: string } {
  const endpoint = new URL(s.endpoint ?? `https://s3.${s.region}.amazonaws.com`);
  if (s.forcePathStyle) return { origin: endpoint.origin, host: endpoint.host, pathPrefix: `/${uriEncode(s.bucket)}` };
  const host = `${s.bucket}.${endpoint.host}`;
  return { origin: `${endpoint.protocol}//${host}`, host, pathPrefix: '' };
}

const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    return String.fromCodePoint(lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10));
  });

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
};

/** A ListObjectsV2 answer read: its objects, the common prefixes, and the token for the next page. */
export function parseListing(xml: string): { objects: S3Object[]; prefixes: string[]; next: string | null } {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1]!;
    const key = tag(body, 'Key');
    if (key === null) continue;
    objects.push({ key, lastModifiedMs: Date.parse(tag(body, 'LastModified') ?? '') || 0, size: Number(tag(body, 'Size') ?? 0) });
  }
  const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].flatMap((m) => {
    const p = tag(m[1]!, 'Prefix');
    return p === null ? [] : [p];
  });
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects, prefixes, next: truncated ? tag(xml, 'NextContinuationToken') : null };
}

export class S3Client {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(readonly settings: S3Settings, o: S3ClientOptions = {}) {
    this.fetch = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? S3_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
  }

  /** `s3://<bucket>/` as it may be said: the bucket, never a key. */
  get label(): string {
    return `s3://${this.settings.bucket}`;
  }

  private async send(operation: string, method: string, key: string | null, query: [string, string][], body?: string): Promise<Response> {
    const { origin, host, pathPrefix } = bucketBase(this.settings);
    const path = key === null ? `${pathPrefix}/` : `${pathPrefix}/${uriEncode(key, true)}`;
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);
    const amzDate = amzDateOf(this.now());
    const headers: Record<string, string> = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const auth = authorization({ method, path, query, headers, payloadHash, region: this.settings.region, service: 's3', credentials: this.settings.credentials, amzDate });
    const qs = canonicalQuery(query);
    const { host: _host, ...sent } = headers;
    let res: Response;
    try {
      res = await this.fetch(`${origin}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { ...sent, authorization: auth.header, ...(body !== undefined ? { 'content-type': 'application/x-ndjson' } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? `no answer within ${this.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
      throw new S3Error(operation, key ?? '', null, null, detail);
    }
    return res;
  }

  private async refused(operation: string, key: string, res: Response): Promise<never> {
    const text = await this.body(operation, key, res, S3_MAX_PAGE_BYTES).catch(() => '');
    throw new S3Error(operation, key, res.status, safeCode(tag(text, 'Code')));
  }

  /**
   * An answer's body as text, read within the request's deadline (its signal is the request's) and up to
   * `limit` bytes: a store that stalls or answers too much fails as an S3Error, never hangs or fills memory.
   */
  private async body(operation: string, key: string, res: Response, limit: number): Promise<string> {
    if (res.body === null) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          throw new S3Error(operation, key, null, null, `an answer larger than ${limit} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof S3Error) throw err;
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new S3Error(operation, key, null, null, timedOut ? `no answer within ${this.timeoutMs} ms` : `the answer broke off (${err instanceof Error ? err.message : String(err)})`);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async put(key: string, body: string): Promise<void> {
    const res = await this.send('put', 'PUT', key, [], body);
    if (!res.ok) await this.refused('put', key, res);
    await this.body('put', key, res, S3_MAX_PAGE_BYTES);
  }

  /** The object's text, or null when there is none. */
  async get(key: string): Promise<string | null> {
    const res = await this.send('get', 'GET', key, []);
    if (res.status === 404) {
      await this.body('get', key, res, S3_MAX_PAGE_BYTES).catch(() => undefined);
      return null;
    }
    if (!res.ok) await this.refused('get', key, res);
    return this.body('get', key, res, S3_MAX_OBJECT_BYTES);
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('delete', 'DELETE', key, []);
    if (!res.ok && res.status !== 404) await this.refused('delete', key, res);
    await this.body('delete', key, res, S3_MAX_PAGE_BYTES);
  }

  /**
   * Every object under `prefix` (each page asked in turn); with `delimiter`, the prefixes it groups them
   * under too. Past `maxPages` (S3_MAX_PAGES) it throws rather than answer with part of the listing.
   */
  async list(prefix: string, o: { delimiter?: string; maxPages?: number } = {}): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    const objects: S3Object[] = [];
    const prefixes: string[] = [];
    let token: string | null = null;
    const maxPages = o.maxPages ?? S3_MAX_PAGES;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new S3Error('list', prefix, null, null, `more than ${maxPages} pages: narrow the prefix, or let retention (or the bucket's lifecycle rule) remove old traces`);
      const query: [string, string][] = [['list-type', '2'], ['prefix', prefix]];
      if (o.delimiter) query.push(['delimiter', o.delimiter]);
      if (token !== null) query.push(['continuation-token', token]);
      const res = await this.send('list', 'GET', null, query);
      if (!res.ok) await this.refused('list', prefix, res);
      const parsed = parseListing(await this.body('list', prefix, res, S3_MAX_PAGE_BYTES));
      objects.push(...parsed.objects);
      prefixes.push(...parsed.prefixes);
      token = parsed.next;
      if (token === null) break;
    }
    return { objects, prefixes };
  }
}

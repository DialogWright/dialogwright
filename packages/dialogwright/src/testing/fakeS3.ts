import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorization, parseAuthorization, sha256Hex, type Credentials } from '../trace/s3/sigv4';

/**
 * An S3-compatible store in the process, for the engine's tests of TRACE_STORE=s3 (nothing is
 * installed, and no request leaves the machine): path-style PUT, GET and DELETE of an object, and
 * ListObjectsV2 with a prefix, a delimiter and pages. Every request's SigV4 signature is checked
 * against the keys it was made with (a wrong one is refused 403 SignatureDoesNotMatch, as a real store
 * does), and its payload against its `x-amz-content-sha256`. A test can make the next requests fail,
 * or hang, as a store that is down or blackholed would.
 */

export interface FakeS3Options {
  bucket: string;
  region: string;
  credentials: Credentials;
  /** The most keys one list page holds (a real store's is 1000); small, to make a test page. */
  pageSize?: number;
}

export interface StoredObject {
  body: string;
  lastModifiedMs: number;
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  /** Every request answered: its method and key (the bucket's own for a listing), and its status. */
  readonly requests: { method: string; key: string; status: number }[] = [];
  private failing = 0;
  private failStatus = 500;
  hang = false;
  /** The clock objects are stamped with; a test moves it to age them. */
  now: () => number = Date.now;

  private constructor(private readonly server: Server, readonly port: number, private readonly o: FakeS3Options) {}

  static async start(o: FakeS3Options): Promise<FakeS3> {
    let fake: FakeS3 | null = null;
    const server = createServer((req, res) => {
      void fake!.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fake = new FakeS3(server, (server.address() as { port: number }).port, o);
    return fake;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The next `n` requests are answered `status` (default 500), as a store that is failing. */
  fail(n: number, status = 500): void {
    this.failing = n;
    this.failStatus = status;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private answer(res: ServerResponse, method: string, key: string, status: number, body = '', type = 'application/xml'): void {
    this.requests.push({ method, key, status });
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private error(res: ServerResponse, method: string, key: string, status: number, code: string): void {
    this.answer(res, method, key, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake.invalid');
    const method = req.method ?? 'GET';
    const rawPath = (req.url ?? '/').split('?')[0]!;
    const segments = rawPath.split('/').slice(1);
    const bucket = decodeURIComponent(segments[0] ?? '');
    const key = segments.slice(1).map(decodeURIComponent).join('/');
    if (this.hang) return; // never answered
    if (this.failing > 0) {
      this.failing -= 1;
      this.error(res, method, key, this.failStatus, this.failStatus === 503 ? 'SlowDown' : 'InternalError');
      return;
    }
    if (!this.signed(req, method, rawPath, url, body)) {
      this.error(res, method, key, 403, 'SignatureDoesNotMatch');
      return;
    }
    if (bucket !== this.o.bucket) {
      this.error(res, method, key, 404, 'NoSuchBucket');
      return;
    }
    if (key === '' && method === 'GET' && url.searchParams.get('list-type') === '2') {
      this.list(res, url.searchParams);
      return;
    }
    if (method === 'PUT') {
      this.objects.set(key, { body, lastModifiedMs: this.now() });
      this.answer(res, method, key, 200);
      return;
    }
    if (method === 'GET') {
      const o = this.objects.get(key);
      if (!o) this.error(res, method, key, 404, 'NoSuchKey');
      else this.answer(res, method, key, 200, o.body, 'application/octet-stream');
      return;
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      this.answer(res, method, key, 204);
      return;
    }
    this.error(res, method, key, 405, 'MethodNotAllowed');
  }

  /** Whether the request carries a good signature with the store's keys over what it sent. */
  private signed(req: IncomingMessage, method: string, rawPath: string, url: URL, body: string): boolean {
    const auth = parseAuthorization(String(req.headers.authorization ?? ''));
    if (!auth || auth.accessKeyId !== this.o.credentials.accessKeyId) return false;
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    if (payloadHash !== sha256Hex(body)) return false;
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    if (!auth.scope.startsWith(`${amzDate.slice(0, 8)}/${this.o.region}/s3/`)) return false;
    const headers: Record<string, string> = {};
    for (const name of auth.signedHeaders) {
      const v = req.headers[name];
      if (v === undefined) return false;
      headers[name] = Array.isArray(v) ? v.join(',') : v;
    }
    const query = [...url.searchParams.entries()] as [string, string][];
    const expected = authorization({ method, path: rawPath, query, headers, payloadHash, region: this.o.region, service: 's3', credentials: this.o.credentials, amzDate });
    return expected.signature === auth.signature;
  }

  private list(res: ServerResponse, q: URLSearchParams): void {
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter');
    const after = q.get('continuation-token');
    const page = this.o.pageSize ?? 1000;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const contents: string[] = [];
    const prefixes = new Set<string>();
    const entries: { key: string; prefix?: string }[] = [];
    for (const k of keys) {
      if (delimiter) {
        const at = k.indexOf(delimiter, prefix.length);
        if (at >= 0) {
          const p = k.slice(0, at + delimiter.length);
          if (!prefixes.has(p)) {
            prefixes.add(p);
            entries.push({ key: p, prefix: p });
          }
          continue;
        }
      }
      entries.push({ key: k });
    }
    const start = after === null ? 0 : entries.findIndex((e) => e.key > after);
    const shown = start < 0 ? [] : entries.slice(start, start + page);
    const truncated = start >= 0 && start + page < entries.length;
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const common: string[] = [];
    for (const e of shown) {
      if (e.prefix !== undefined) common.push(`<CommonPrefixes><Prefix>${esc(e.prefix)}</Prefix></CommonPrefixes>`);
      else {
        const o = this.objects.get(e.key)!;
        contents.push(`<Contents><Key>${esc(e.key)}</Key><LastModified>${new Date(o.lastModifiedMs).toISOString()}</LastModified><Size>${Buffer.byteLength(o.body)}</Size></Contents>`);
      }
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.o.bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${shown.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${esc(shown.at(-1)!.key)}</NextContinuationToken>` : ''}${contents.join('')}${common.join('')}</ListBucketResult>`;
    this.answer(res, 'GET', '', 200, xml);
  }
}

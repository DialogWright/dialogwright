import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, by code of our own over `fetch` (no SDK): what every request to an
 * S3-compatible store (AWS S3, Cloudflare R2, MinIO and others) carries in its Authorization header.
 * Held to the vectors AWS publishes (sigv4.test.ts). Nothing here logs: the secret key goes into an
 * HMAC and nowhere else, and only the access key's id appears in a header.
 *
 * The steps, as AWS documents them: a canonical request (method, path, query, the headers signed, the
 * payload's SHA-256), a string to sign (the algorithm, the time, the scope, the canonical request's
 * hash), a signing key derived from the secret for the day, region and service, and the HMAC of the
 * string to sign with it.
 */

export const ALGORITHM = 'AWS4-HMAC-SHA256';

/** The SHA-256 of an empty payload, which a GET or a DELETE signs. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  /** The path as sent, already percent-encoded where it must be (s3Path does it for a key). */
  path: string;
  /** The query's parameters, unencoded; signed sorted and encoded. */
  query?: ReadonlyArray<readonly [string, string]>;
  /** Every header to sign, `host` and `x-amz-date` among them; names in any case. */
  headers: Readonly<Record<string, string>>;
  /** The payload's SHA-256 in hex (or `UNSIGNED-PAYLOAD`). */
  payloadHash: string;
  region: string;
  service: string;
  credentials: Credentials;
  /** `x-amz-date`'s value: YYYYMMDD'T'HHMMSS'Z'. */
  amzDate: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding, as SigV4 asks: every byte but the unreserved characters (and `/`, where `slash` keeps it). */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The time as `x-amz-date` says it. */
export function amzDateOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The query as it is signed (and may be sent): each name and value encoded, sorted by name, then value. */
export function canonicalQuery(query: ReadonlyArray<readonly [string, string]> = []): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** The canonical request and the names of the headers it signs. */
export function canonicalRequest(i: SignInput): { request: string; signedHeaders: string } {
  const headers = Object.entries(i.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(';');
  const request = [
    i.method.toUpperCase(),
    i.path === '' ? '/' : i.path,
    canonicalQuery(i.query),
    ...headers.map(([k, v]) => `${k}:${v}`),
    '',
    signedHeaders,
    i.payloadHash,
  ].join('\n');
  return { request, signedHeaders };
}

/** The scope a signature is for: the day, the region, the service. */
export function scopeOf(amzDate: string, region: string, service: string): string {
  return `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
}

export function stringToSign(i: SignInput, request: string): string {
  return [ALGORITHM, i.amzDate, scopeOf(i.amzDate, i.region, i.service), sha256Hex(request)].join('\n');
}

/** The key the day's signatures are made with, derived from the secret: never the secret itself. */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
}

/** The Authorization header's value for a request, and its signature. */
export function authorization(i: SignInput): { header: string; signature: string; signedHeaders: string } {
  const { request, signedHeaders } = canonicalRequest(i);
  const key = signingKey(i.credentials.secretAccessKey, i.amzDate.slice(0, 8), i.region, i.service);
  const signature = createHmac('sha256', key).update(stringToSign(i, request), 'utf8').digest('hex');
  const header = `${ALGORITHM} Credential=${i.credentials.accessKeyId}/${scopeOf(i.amzDate, i.region, i.service)}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { header, signature, signedHeaders };
}

/** An Authorization header read back (the fake store checks one): its key id, scope, headers and signature; null when it is not SigV4. */
export function parseAuthorization(header: string): { accessKeyId: string; scope: string; signedHeaders: string[]; signature: string } | null {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return null;
  return { accessKeyId: m[1]!, scope: m[2]!, signedHeaders: m[3]!.split(';'), signature: m[4]! };
}

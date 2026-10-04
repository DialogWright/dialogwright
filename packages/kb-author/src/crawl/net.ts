import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * The crawler's way onto the network: only public addresses, and only the address that was checked.
 *
 * - Every host is resolved before a request (all its addresses), and the request is refused when any
 *   of them is not a public address: loopback, private, RFC 1918, link-local (169.254.0.0/16, where
 *   cloud metadata services answer, and fe80::/10), unspecified, shared (CGNAT, 100.64.0.0/10), unique
 *   local (fc00::/7), multicast, reserved or broadcast, benchmarking, and the IPv6 forms that carry an
 *   IPv4 address (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible, NAT64 64:ff9b::/96, 6to4 2002::/16),
 *   judged by the IPv4 address they carry. `--allow-private` lifts this, for a site on the author's
 *   own network (and the tests' fixture server on 127.0.0.1).
 * - The connection is made to the address that was checked: the socket's lookup answers with it, so a
 *   second DNS answer (a rebinding) cannot send the request elsewhere. TLS still checks the host name.
 * - It follows no redirect itself (the crawler checks each hop and asks again), sends no cookies, and
 *   keeps no connection open between requests.
 */

/** A host name's addresses, as the system's resolver gives them (a test's, in place of DNS). */
export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;

/** The system's resolver: every address of the name. */
export const systemResolver: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** How the crawler reaches the network. */
export interface NetOptions {
  /** Read hosts on private networks too (`--allow-private`). Default: only public addresses. */
  allowPrivate?: boolean;
  /** How host names are resolved. Default: the system's resolver. */
  resolve?: Resolver;
}

/** A request refused before it was sent: the host is not a public address, or does not resolve. */
export class NetworkRefusal extends Error {}

/** An IPv4 address as its 32 bits, or null when it is not one. */
function v4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function v6(address: string): number[] | null {
  let a = address.toLowerCase().replace(/%.*$/, '');
  if (isIP(a) !== 6) return null;
  // A dotted IPv4 tail (::ffff:127.0.0.1) as two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) {
    const n = v4(tail[1]!);
    if (n === null) return null;
    a = `${a.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = a.includes('::') ? a.split('::') : [a, undefined];
  const left = head === '' ? [] : head!.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
};

/** The IPv4 ranges that are not public, with what each is. */
const V4_RANGES: readonly [string, number, string][] = [
  ['0.0.0.0', 8, 'unspecified, "this network"'],
  ['10.0.0.0', 8, 'private, RFC 1918'],
  ['100.64.0.0', 10, 'shared, carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local, where cloud metadata services answer'],
  ['172.16.0.0', 12, 'private, RFC 1918'],
  ['192.0.0.0', 24, 'reserved, IETF protocol assignments'],
  ['192.168.0.0', 16, 'private, RFC 1918'],
  ['198.18.0.0', 15, 'reserved, benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved or broadcast'],
];

/**
 * What kind of address `address` is when it is not a public one (loopback, private, link-local, ...),
 * or null when it is public. An IPv6 address that carries an IPv4 one is judged by that.
 */
export function privateAddressKind(address: string): string | null {
  const four = v4(address);
  if (four !== null) {
    for (const [base, bits, kind] of V4_RANGES) if (inV4(four, base, bits)) return kind;
    return null;
  }
  const g = v6(address);
  if (g === null) return 'not an IP address at all';
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  const carried = (hi: number, lo: number): string | null => {
    const kind = privateAddressKind(`${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`);
    return kind === null ? null : `${kind}, in an IPv6 address`;
  };
  if (zeros(0, 8)) return 'unspecified';
  if (zeros(0, 7) && g[7] === 1) return 'loopback';
  if (zeros(0, 5) && g[5] === 0xffff) return carried(g[6]!, g[7]!); // IPv4-mapped
  if (zeros(0, 6)) return carried(g[6]!, g[7]!); // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return carried(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return carried(g[1]!, g[2]!); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique local, fc00::/7';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local, deprecated';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** A URL's host as an address or a name (an IPv6 literal without its brackets). */
const hostnameOf = (url: URL): string => url.hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * The address to connect to for `host`: the host itself when it is an address, else the first the
 * resolver gives. Refused (NetworkRefusal) when the name does not resolve, or when any address is not
 * a public one and private networks are not allowed.
 */
export async function checkedAddress(host: string, options: NetOptions = {}): Promise<{ address: string; family: 4 | 6 }> {
  const literal = isIP(host);
  let addresses: readonly { address: string; family: number }[];
  if (literal !== 0) addresses = [{ address: host, family: literal }];
  else {
    try {
      addresses = await (options.resolve ?? systemResolver)(host);
    } catch (error) {
      throw new NetworkRefusal(`${host} does not resolve (${error instanceof Error ? error.message : String(error)})`);
    }
    if (addresses.length === 0) throw new NetworkRefusal(`${host} does not resolve`);
  }
  if (!options.allowPrivate) {
    for (const a of addresses) {
      const kind = privateAddressKind(a.address);
      if (kind !== null) throw new NetworkRefusal(`${host}${a.address === host ? '' : ` is at ${a.address}, which`} is not a public address (${kind}): the crawler reads only public addresses (--allow-private reads a private network)`);
    }
  }
  const first = addresses[0]!;
  return { address: first.address, family: (isIP(first.address) || first.family) === 6 ? 6 : 4 };
}

/** A socket lookup that always answers with `address`: the connection goes where the check said. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

/** A body read as the server encoded it, decoded (it is asked for unencoded, but may come compressed); an error on either side ends both. */
function decoded(res: IncomingMessage): Readable {
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder: Transform | null =
    encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (decoder === null) return res;
  pipeline(res, decoder, () => undefined);
  return decoder;
}

/** The statuses whose response has no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A fetch for the crawler (see the file's comment): GET only, no redirect followed, each host's
 * address checked and pinned. Its answer is a Response, as the global fetch's.
 */
export function publicFetch(options: NetOptions = {}): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetworkRefusal(`${url.href} is not an http or https URL`);
    const host = hostnameOf(url);
    const target = await checkedAddress(host, options);
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestOptions: RequestOptions & { servername?: string } = {
      method: 'GET',
      headers,
      agent: false,
      lookup: pinnedLookup(target.address, target.family),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      const req = send(url, requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`the server answered with status ${status}`));
          return;
        }
        const out = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          } catch {
            // a header a Response cannot hold is passed over
          }
        }
        if (NO_BODY.has(status)) {
          res.resume();
          resolve(new Response(null, { status, statusText: res.statusMessage ?? '', headers: out }));
          return;
        }
        const body = Readable.toWeb(decoded(res)) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers: out }));
      });
      req.on('error', reject);
      req.end();
    });
  };
}

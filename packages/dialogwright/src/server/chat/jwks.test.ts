import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jwksKeys } from './jwks';

/** Keys are made here, for this run, and never stored. */
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (k: typeof rsa.publicKey, kid: string, extra: Record<string, unknown> = {}) => ({ ...k.export({ format: 'jwk' }), kid, ...extra });

const URL_ = 'https://id.example.com/.well-known/jwks.json';

/** A provider that serves `bodies` in turn (the last one again once they run out), counting the fetches. */
function provider(bodies: Array<{ keys: unknown[] } | 'fail'>, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)]!;
    if (body === 'fail') throw new Error('connection refused');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('the published keys', () => {
  it('resolves a known kid, fetching once for many lookups', async () => {
    const p = provider([{ keys: [jwk(rsa.publicKey, 'r1'), jwk(ed.publicKey, 'd1', { use: 'sig' })] }]);
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => 0 });
    expect((await keyFor('r1'))?.asymmetricKeyType).toBe('rsa');
    expect((await keyFor('d1'))?.asymmetricKeyType).toBe('ed25519');
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.url).toBe(URL_);
    // A redirect is never followed: it could lead off https.
    expect(p.calls[0]!.init?.redirect).toBe('error');
  });

  it('refetches once for an unknown kid (a rotated key), then answers null', async () => {
    let now = 0;
    const p = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }, { keys: [jwk(rsa.publicKey, 'r1'), jwk(ec.publicKey, 'e2')] }]);
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => now });
    expect(await keyFor('r1')).not.toBeNull();
    now = 31_000;
    expect((await keyFor('e2'))?.asymmetricKeyType).toBe('ec');
    expect(p.calls).toHaveLength(2);
    now = 62_000;
    expect(await keyFor('nope')).toBeNull();
    expect(p.calls).toHaveLength(3);
  });

  it('refetches at most once every 30 seconds, whatever kids an attacker sends', async () => {
    let now = 0;
    const p = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }]);
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => now });
    await keyFor('r1');
    for (let i = 0; i < 50; i += 1) expect(await keyFor(`random-${i}`)).toBeNull();
    expect(p.calls).toHaveLength(1);
    now = 30_000;
    await Promise.all([keyFor('x1'), keyFor('x2'), keyFor('x3')]);
    expect(p.calls).toHaveLength(2);
  });

  it('keeps the keys for the max-age the provider sends, at most a day, else ten minutes', async () => {
    let now = 0;
    const p = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }], { 'cache-control': 'public, max-age=120' });
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => now });
    await keyFor('r1');
    now = 119_000;
    await keyFor('r1');
    expect(p.calls).toHaveLength(1);
    now = 120_000;
    await keyFor('r1');
    expect(p.calls).toHaveLength(2);

    let later = 0;
    const q = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }]);
    const keyFor2 = jwksKeys({ url: URL_, fetch: q.fetch, nowMs: () => later });
    await keyFor2('r1');
    later = 599_000;
    await keyFor2('r1');
    expect(q.calls).toHaveLength(1);
    later = 600_000;
    await keyFor2('r1');
    expect(q.calls).toHaveLength(2);

    let much = 0;
    const r = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }], { 'cache-control': 'max-age=31536000' });
    const keyFor3 = jwksKeys({ url: URL_, fetch: r.fetch, nowMs: () => much });
    await keyFor3('r1');
    much = 24 * 60 * 60_000;
    await keyFor3('r1');
    expect(r.calls).toHaveLength(2);
  });

  it('ignores an encryption key, a key without a kid, a symmetric key, and a key Node cannot read', async () => {
    const p = provider([{ keys: [jwk(rsa.publicKey, 'enc1', { use: 'enc' }), { ...rsa.publicKey.export({ format: 'jwk' }) }, { kty: 'RSA', kid: 'broken', e: 'AQAB' }, { kty: 'oct', kid: 'secret', k: 'c2VjcmV0' }, jwk(ed.publicKey, 'd1')] }]);
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => 0 });
    expect(await keyFor('enc1')).toBeNull();
    expect(await keyFor('broken')).toBeNull();
    expect(await keyFor('secret')).toBeNull();
    expect(await keyFor('d1')).not.toBeNull();
  });

  it('keeps serving the cached keys when a fetch fails, and logs once until one succeeds', async () => {
    let now = 0;
    const logs: string[] = [];
    const p = provider([{ keys: [jwk(rsa.publicKey, 'r1')] }, 'fail', 'fail', { keys: [jwk(rsa.publicKey, 'r1')] }, 'fail']);
    const keyFor = jwksKeys({ url: URL_, fetch: p.fetch, nowMs: () => now, log: (l) => logs.push(l) });
    await keyFor('r1');
    now = 700_000;
    expect(await keyFor('r1')).not.toBeNull();
    now = 731_000;
    expect(await keyFor('r1')).not.toBeNull();
    expect(p.calls).toHaveLength(3);
    expect(logs).toEqual([`chat sign-in: could not fetch ${URL_}: connection refused (keeping the keys already fetched)`]);
    now = 762_000;
    await keyFor('r1');
    now = 2_000_000;
    await keyFor('r1');
    expect(logs).toHaveLength(2);
  });

  it('stops reading a key set past its size cap, without waiting for the rest, and keeps the keys it has', async () => {
    let calls = 0;
    const logs: string[] = [];
    // A first, good key set; then a body that never ends, and one that says it is too large.
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ keys: [jwk(rsa.publicKey, 'r1')] }), { status: 200 });
      if (calls === 2) {
        const chunk = new Uint8Array(64 * 1024).fill(32);
        return new Response(new ReadableStream({ pull: (c) => c.enqueue(chunk) }), { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
    }) as unknown as typeof globalThis.fetch;
    let now = 0;
    const keyFor = jwksKeys({ url: URL_, fetch, nowMs: () => now, log: (l) => logs.push(l) });
    expect(await keyFor('r1')).not.toBeNull();
    now = 31_000;
    expect(await keyFor('unseen')).toBeNull();
    expect(await keyFor('r1')).not.toBeNull();
    now = 62_000;
    expect(await keyFor('unseen')).toBeNull();
    expect(calls).toBe(3);
    expect(logs).toEqual([`chat sign-in: could not fetch ${URL_}: the key set is larger than 262144 bytes (keeping the keys already fetched)`]);
  });

  it('takes https only', () => {
    expect(() => jwksKeys({ url: 'http://id.example.com/jwks.json' })).toThrow('CHAT_JWKS_URL must be an https URL, got "http://id.example.com/jwks.json"');
  });
});

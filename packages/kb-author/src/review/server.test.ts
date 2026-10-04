import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { cleanScratch, folder, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../cli';
import { findKb, type KbPlace } from '../kbPlace';
import { acceptTopic, approve, editAndApprove, mergeTopic, reject } from './actions';
import { backTo, sameToken, startReviewServer, type ReviewServer } from './server';
import { excerptRange, wordDiff } from './text';

/**
 * The review page's access: this machine only, and the token on every request, reading or writing.
 */

afterAll(cleanScratch);

/** A raw request, so the Host and Origin headers can be anything. */
function raw(server: ReviewServer, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {} }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('the review page\'s access', () => {
  let server: ReviewServer;
  let place: KbPlace;
  beforeAll(async () => {
    const found = findKb(folder('kb-author-review-access'), 'app');
    if (typeof found === 'string') throw new Error(found);
    place = found;
    server = await startReviewServer({ place, today: () => TODAY });
    return () => server.close();
  });

  it('listens on 127.0.0.1 alone, on a port the system picked, with a long random token in the URL it prints', () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
  });

  it('refuses every request without the token, reading or writing, and with a wrong one', async () => {
    const host = { host: `127.0.0.1:${server.port}` };
    const form = { ...host, 'content-type': 'application/x-www-form-urlencoded' };
    for (const r of [
      { path: '/' },
      { path: '/draft/anything' },
      { path: `/?token=${server.token}x` },
      { path: '/?token=' },
      { path: '/', headers: { ...host, 'x-review-token': 'not-it' } },
      { method: 'POST', path: '/reviewer', headers: form, body: 'by=Jane+Smith&owner=Patron+Services' },
      { method: 'POST', path: '/draft/x/approve', headers: form, body: `token=${server.token.slice(1)}` },
    ]) {
      const res = await raw(server, { headers: host, ...r });
      expect([r.path, res.status, res.body]).toEqual([r.path, 403, 'the review page needs the token it printed when it started: open the URL it printed\n']);
    }
    // The token in the query, a POST's form, or a header.
    expect((await raw(server, { path: `/?token=${server.token}`, headers: host })).status).toBe(200);
    expect((await raw(server, { path: '/', headers: { ...host, 'x-review-token': server.token } })).status).toBe(200);
    const set = await raw(server, { method: 'POST', path: '/reviewer', headers: form, body: `token=${server.token}&by=Jane+Smith&owner=Patron+Services&back=/` });
    expect([set.status, set.headers.location]).toEqual([303, `/?token=${server.token}`]);
  });

  it('answers only at the address it printed, and a change only from the page itself', async () => {
    const t = `?token=${server.token}`;
    expect(await raw(server, { path: `/${t}`, headers: { host: `evil.example:${server.port}` } })).toMatchObject({ status: 421 });
    expect(await raw(server, { path: `/${t}`, headers: { host: '127.0.0.1:1' } })).toMatchObject({ status: 421 });
    expect((await raw(server, { path: `/${t}`, headers: { host: `localhost:${server.port}` } })).status).toBe(200);
    const form = { host: `127.0.0.1:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' };
    expect(await raw(server, { method: 'POST', path: '/reviewer', headers: { ...form, origin: 'https://evil.example' }, body: `token=${server.token}&by=A+B&owner=C` })).toMatchObject({ status: 403, body: 'a change must come from the review page itself\n' });
    expect(await raw(server, { method: 'POST', path: '/reviewer', headers: { ...form, 'content-type': 'application/json' }, body: '{}' })).toMatchObject({ status: 415 });
    expect(await raw(server, { method: 'DELETE', path: `/${t}`, headers: form })).toMatchObject({ status: 405 });
  });

  it('serves pages that load nothing from elsewhere and are not cached, with every field labelled', async () => {
    const res = await raw(server, { path: `/?token=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } });
    expect(res.headers['content-security-policy']).toMatch(/^default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$/);
    expect([res.headers['cache-control'], res.headers['referrer-policy'], res.headers['x-frame-options']]).toEqual(['no-store', 'no-referrer', 'DENY']);
    expect(res.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[^"' ]+\.(js|css)/);
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain('<main id="main">');
  });

  it('compares the token in constant time, whatever the lengths', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abd', 'abc')).toBe(false);
    expect(sameToken('ab', 'abc')).toBe(false);
    expect(sameToken('', 'abc')).toBe(false);
  });
});

/** Every file under `dir`, with a hash of its bytes: what a refused request must leave as it was. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** A browser: it keeps the cookies the review page sets, and sends the token and the form. */
export function browser(server: ReviewServer) {
  const jar = new Map<string, string>();
  const cookie = (): Record<string, string> => (jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {});
  const keep = (headers: Record<string, string | string[] | undefined>): void => {
    const set = headers['set-cookie'];
    for (const c of typeof set === 'string' ? [set] : (set ?? [])) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  };
  const host = { host: `127.0.0.1:${server.port}` };
  return {
    jar,
    get: async (path: string) => {
      const r = await raw(server, { path: `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(server.token)}`, headers: { ...host, ...cookie() } });
      keep(r.headers);
      return r;
    },
    post: async (path: string, fields: Record<string, string> = {}) => {
      const body = new URLSearchParams({ token: server.token, ...fields }).toString();
      const r = await raw(server, { method: 'POST', path, headers: { ...host, ...cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body });
      keep(r.headers);
      return r;
    },
  };
}

describe('ids from the review page\'s URL', () => {
  it('names a draft, a passage or a topic, never a path: an encoded ../ is not there, and no file is touched', async () => {
    const dir = folder('kb-author-review-ids');
    const found = findKb(dir, 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const web = browser(server);
      expect((await web.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' })).status).toBe(303);
      const before = filesOf(dir);
      expect(before['kb/passages/opening-hours.yaml']).toBeDefined();
      for (const [path, fields] of [
        ['/draft/..%2Fpassages%2Fopening-hours/reject', { reason: 'probe' }],
        ['/draft/%2E%2E%2Fpassages%2Fopening-hours/reject', { reason: 'probe' }],
        ['/draft/..%2Fpassages%2Fopening-hours/approve', {}],
        ['/draft/..%2Fpassages%2Fopening-hours/edit', { answer: 'We are open.', excerpt: 'open', from: TODAY }],
        ['/passage/..%2F..%2Fapp/approve', {}],
        ['/passage/locale%2Fes%2Fpassages%2Fopening-hours-es/edit', { answer: 'Abierto.', from: TODAY }],
        ['/topic/..%2Ftopics/accept', { as: 'x' }],
        ['/topic/..%2Ftopics/merge', { into: 'opening_hours' }],
        ['/draft/%E0%A4%A/reject', { reason: 'probe' }],
      ] as const) {
        const r = await web.post(path, fields);
        expect([path, r.status, r.body]).toEqual([path, 404, r.body.startsWith('no such') ? r.body : 'no such action\n']);
      }
      for (const path of ['/draft/..%2Fpassages%2Fopening-hours', '/passage/..%2F..%2Fapp', '/topic/..%2Fx']) expect([path, (await web.get(path)).status]).toEqual([path, 404]);
      expect(filesOf(dir)).toEqual(before);
    } finally {
      await server.close();
    }
  });

  it('is checked by every action too, before anything is read or written', () => {
    const dir = folder('kb-author-review-ids-actions');
    const place = findKb(dir, 'app');
    if (typeof place === 'string') throw new Error(place);
    const who = { by: 'Jane Smith', owner: 'Patron Services' };
    const before = filesOf(dir);
    const id = '../passages/opening-hours';
    const notAnId = `"${id}" is not a draft or passage id (letters, digits, underscores, hyphens and dots, starting with a letter or digit)`;
    expect(reject(place, id, 'probe', who, TODAY)).toEqual({ ok: false, message: notAnId, problems: [] });
    expect(approve(place, id, who, TODAY)).toEqual({ ok: false, message: notAnId, problems: [] });
    expect(editAndApprove(place, id, { answer: 'We are open.', effective: { from: TODAY } }, who, TODAY)).toEqual({ ok: false, message: notAnId, problems: [] });
    expect(acceptTopic(place, '../topics', who)).toMatchObject({ ok: false, message: '"../topics" is not a topic id: letters, digits and underscores, starting with a letter' });
    expect(mergeTopic(place, 'x', '../topics', who)).toMatchObject({ ok: false, message: '"../topics" is not a topic id: letters, digits and underscores, starting with a letter' });
    expect(filesOf(dir)).toEqual(before);
  });

  it('comes back after naming the reviewer only to a path of the page\'s own', () => {
    expect(backTo('/draft/late-fees')).toBe('/draft/late-fees');
    expect(backTo('/')).toBe('/');
    for (const bad of ['/\\evil.example', '//evil.example', '/\\/evil.example', 'https://evil.example/', 'evil', '/draft/x?y=1', '/a\\b', '', null]) expect([bad, backTo(bad)]).toEqual([bad, '/']);
  });
});

describe('kb:review', () => {
  it('prints the URL with its token, and stops', async () => {
    const dir = folder('kb-author-review-cli');
    const out: string[] = [];
    const statuses: number[] = [];
    const io: Io = {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      cwd: dir,
      today: () => TODAY,
      onReview: async (server) => {
        statuses.push((await fetch(server.url)).status, (await fetch(server.url.replace(/\?token=.*/, ''))).status);
      },
    };
    expect(await main(['kb:review'], io)).toBe(0);
    expect(out[0]).toBe('kb:review: reviewing kb at');
    expect(out[1]).toMatch(/^ {2}http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}$/);
    expect(statuses).toEqual([200, 403]);
    expect(await main(['kb:review', '--port', 'x'], io)).toBe(2);
    expect(await main(['kb:review', join(dir, 'docs-not-here')], io)).toBe(1);
  });
});

describe('the review page\'s text', () => {
  it('finds an excerpt in its section across line breaks and spacing, as kb:approve matches it', () => {
    const text = 'Meeting rooms can be booked\n  up to sixty days ahead.\n\nEach booking may last three hours.';
    const r = excerptRange(text, 'booked up to sixty days ahead. Each booking');
    expect(r).not.toBeNull();
    expect(text.slice(r!.start, r!.end)).toBe('booked\n  up to sixty days ahead.\n\nEach booking');
    expect(excerptRange(text, 'booked up to ninety days')).toBeNull();
    expect(excerptRange(text, '   ')).toBeNull();
  });

  it('diffs a section word by word, spacing aside', () => {
    expect(wordDiff('A replacement is free.', 'A replacement  costs 1 dollar.')).toEqual([
      { kind: 'same', text: 'A replacement  ' },
      { kind: 'removed', text: 'is free.' },
      { kind: 'added', text: 'costs 1 dollar.' },
    ]);
    expect(wordDiff('Same words here.', 'Same\nwords here.').every((p) => p.kind === 'same')).toBe(true);
  });
});

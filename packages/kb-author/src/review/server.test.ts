import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { cleanScratch, folder, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { main, type Io } from '../cli';
import { findKb, type KbPlace } from '../kbPlace';
import { loadKb } from '../kbPlace';
import { acceptTopic, approve, approvedSectionText, confirmApproval, editAndApprove, mergeTopic, reject, reviewState } from './actions';
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
    // The page's own form post, as a browser sends it under the page's referrer policy (an origin, never "null").
    expect((await raw(server, { method: 'POST', path: '/reviewer', headers: { ...form, origin: `http://127.0.0.1:${server.port}` }, body: `token=${server.token}&by=A+B&owner=C` })).status).toBe(303);
    expect(await raw(server, { method: 'DELETE', path: `/${t}`, headers: form })).toMatchObject({ status: 405 });
  });

  it('serves pages that load nothing from elsewhere and are not cached, with every field labelled', async () => {
    const res = await raw(server, { path: `/?token=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } });
    expect(res.headers['content-security-policy']).toMatch(/^default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$/);
    expect([res.headers['cache-control'], res.headers['referrer-policy'], res.headers['x-frame-options']]).toEqual(['no-store', 'same-origin', 'DENY']);
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
        ['/rejected/..%2Fpassages%2Fopening-hours/return', {}],
        ['/rejected/..%2Fpending%2Fsunday-hours/return', {}],
      ] as const) {
        const r = await web.post(path, fields);
        expect([path, r.status, r.body]).toEqual([path, 404, r.body.startsWith('no such') ? r.body : 'no such action\n']);
      }
      for (const path of ['/draft/..%2Fpassages%2Fopening-hours', '/passage/..%2F..%2Fapp', '/topic/..%2Fx', '/rejected/..%2Fpassages%2Fopening-hours']) expect([path, (await web.get(path)).status]).toEqual([path, 404]);
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

/** The `seen` a page's form for `action` carries back. */
function seenIn(html: string, action: string): string {
  const m = new RegExp(`action="${action}"[^>]*><input type="hidden" name="token" value="[^"]*"><input type="hidden" name="seen" value="([^"]*)">`).exec(html);
  if (!m) throw new Error(`no form for ${action} with what it saw`);
  return m[1]!;
}

/** The flash the next page shows. */
const flashIn = (html: string): string | null => /<div class="flash (?:ok|no)" role="(?:status|alert)">([\s\S]*?)<\/div>/.exec(html)?.[1]!.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'") ?? null;

describe('a reviewer per browser', () => {
  it('keeps who is reviewing in a signed, HttpOnly, SameSite=Strict session cookie, so two browsers with the token are two reviewers', async () => {
    const found = findKb(folder('kb-author-review-sessions'), 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const a = browser(server);
      const b = browser(server);
      const first = await a.get('/');
      const cookie = first.headers['set-cookie'];
      expect(cookie).toHaveLength(1);
      expect(cookie![0]).toMatch(new RegExp(`^dw-review-${server.port}=[A-Za-z0-9_-]{32}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`));
      // No cookie before the token is shown.
      expect((await raw(server, { path: '/', headers: { host: `127.0.0.1:${server.port}` } })).headers['set-cookie']).toBeUndefined();
      expect((await a.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' })).status).toBe(303);
      expect((await a.get('/')).body).toContain('<span class="k">Reviewer</span> Jane Smith <span class="k">for</span> Patron Services');
      const other = await b.get('/');
      expect(other.body).toContain('<span class="k">Reviewer</span> not set');
      expect(other.body).not.toContain('Jane Smith');
      await b.post('/reviewer', { by: 'Sam Lee', owner: 'Branch Services', back: '/' });
      expect((await b.get('/')).body).toContain('<span class="k">Reviewer</span> Sam Lee');
      expect((await a.get('/')).body).toContain('<span class="k">Reviewer</span> Jane Smith');
      // A cookie with its signature changed is not a session: a new one is started.
      const [name, value] = [...a.jar][0]!;
      const forged = browser(server);
      forged.jar.set(name, `${value.split('.')[0]}.${'A'.repeat(43)}`);
      const page = await forged.get('/');
      expect(page.body).toContain('<span class="k">Reviewer</span> not set');
      expect(page.headers['set-cookie']).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('what the reviewer saw is what they approve', () => {
  const DRAFT = [
    'id: sunday-hours',
    'topic: sunday_hours',
    'version: "2026.1"',
    'effective: { from: 2026-01-01 }',
    'source: { document: patron-guide, section: "1.1" }',
    'answer: Every branch is closed on Sunday.',
    `drafted: { by: fake-drafter, on: ${TODAY}, excerpt: "All branches are closed on Sunday." }`,
    '',
  ].join('\n');

  it('refuses an approval, an edit, a rejection or a topic accepted when the file changed on disk since the page was opened', async () => {
    const dir = folder('kb-author-review-seen');
    writeFileSync(join(dir, 'kb', 'pending', 'topics.yaml'), 'sunday_hours:\n  title: Sunday hours\n');
    writeFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), DRAFT);
    const found = findKb(dir, 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const web = browser(server);
      await web.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' });

      // The topic: its title changed on disk after the page was opened.
      const topicSeen = seenIn((await web.get('/topic/sunday_hours')).body, '/topic/sunday_hours/accept');
      writeFileSync(join(dir, 'kb', 'pending', 'topics.yaml'), 'sunday_hours:\n  title: Sunday opening\n');
      const topicsBefore = readFileSync(join(dir, 'kb', 'topics.yaml'), 'utf8');
      await web.post('/topic/sunday_hours/accept', { as: 'sunday_hours', seen: topicSeen });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: sunday_hours changed since you opened it: reload the page and review it again');
      expect(readFileSync(join(dir, 'kb', 'topics.yaml'), 'utf8')).toBe(topicsBefore);
      await web.post('/topic/sunday_hours/accept', { as: 'sunday_hours', seen: seenIn((await web.get('/topic/sunday_hours')).body, '/topic/sunday_hours/accept') });
      expect(flashIn((await web.get('/')).body)).toBe('accepted the topic "sunday_hours" ("Sunday opening") into kb/topics.yaml');

      // The draft: its answer changed on disk after the page was opened.
      const opened = (await web.get('/draft/sunday-hours')).body;
      const seen = seenIn(opened, '/draft/sunday-hours/approve');
      expect(seenIn(opened, '/draft/sunday-hours/edit')).toBe(seen);
      expect(seenIn(opened, '/draft/sunday-hours/reject')).toBe(seen);
      const changed = DRAFT.replace('Every branch is closed on Sunday.', 'Every branch is open on Sunday.');
      writeFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), changed);
      for (const [action, fields] of [
        ['approve', {}],
        ['edit', { answer: 'Every branch is closed on Sunday.', excerpt: 'All branches are closed on Sunday.', from: '2026-01-01' }],
        ['reject', { reason: 'Not needed.' }],
      ] as const) {
        await web.post(`/draft/sunday-hours/${action}`, { ...fields, seen });
        expect([action, flashIn((await web.get('/')).body)]).toEqual([action, 'Not done: sunday-hours changed since you opened it: reload the page and review it again']);
        expect(readFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), 'utf8')).toBe(changed);
      }
      // A form with no record of what it showed is out of date too.
      await web.post('/draft/sunday-hours/approve', {});
      expect(flashIn((await web.get('/')).body)).toBe('Not done: sunday-hours changed since you opened it: reload the page and review it again');
      // Its source section changing is a change to what was shown, too.
      const reopened = seenIn((await web.get('/draft/sunday-hours')).body, '/draft/sunday-hours/approve');
      expect(reopened).not.toBe(seen);
      const guide = join(dir, 'kb', 'sources', 'patron-guide.yaml');
      const guideText = readFileSync(guide, 'utf8');
      writeFileSync(guide, guideText.replace('to 4 p.m. All branches', 'to 5 p.m. All branches'));
      await web.post('/draft/sunday-hours/approve', { seen: reopened });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: sunday-hours changed since you opened it: reload the page and review it again');
      writeFileSync(guide, guideText);
      // Reloaded, it is approved as it is now.
      writeFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), DRAFT);
      await web.post('/draft/sunday-hours/approve', { seen: seenIn((await web.get('/draft/sunday-hours')).body, '/draft/sunday-hours/approve') });
      expect(flashIn((await web.get('/')).body)).toMatch(/^sunday-hours: approved \(version 2026\.1\) by Jane Smith for Patron Services/);
      expect(existsSync(join(dir, 'kb', 'passages', 'sunday-hours.yaml'))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('a proposed topic\'s title', () => {
  it('is reviewed as it is accepted: the page says callers hear it, and the reviewer may rewrite it', async () => {
    const dir = folder('kb-author-review-topic-title');
    writeFileSync(join(dir, 'kb', 'pending', 'topics.yaml'), 'sunday_hours:\n  title: sunday hrs\n  keywords: [sunday]\n');
    const found = findKb(dir, 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const web = browser(server);
      await web.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' });
      const page = (await web.get('/topic/sunday_hours')).body;
      expect(page).toContain('<label for="topic-title">Its title (callers hear it)</label>');
      expect(page).toContain('<input id="topic-title" name="title" type="text" value="sunday hrs" required maxlength="80" aria-describedby="topic-title-hint">');
      expect(page).toContain("A topic's title is spoken to callers: the topic question offers it");
      const topics = join(dir, 'kb', 'topics.yaml');
      const before = readFileSync(topics, 'utf8');
      for (const [title, why] of [
        ['  ', 'give the topic a title: callers hear it when they are asked which topic they mean'],
        ['Sunday {hours}', 'the title has a brace: it is said to callers as it is written, with no variables'],
        ['Sunday '.repeat(12), 'the title is 83 characters, over 80: a topic&#39;s title is a few words, said in a question'],
      ] as const) {
        await web.post('/topic/sunday_hours/accept', { as: 'sunday_hours', title, seen: seenIn((await web.get('/topic/sunday_hours')).body, '/topic/sunday_hours/accept') });
        expect([title, flashIn((await web.get('/')).body)]).toEqual([title, `Not done: ${why.replace('&#39;', "'")}`]);
        expect(readFileSync(topics, 'utf8')).toBe(before);
      }
      await web.post('/topic/sunday_hours/accept', { as: 'sunday_hours', title: ' Sunday  opening hours ', seen: seenIn((await web.get('/topic/sunday_hours')).body, '/topic/sunday_hours/accept') });
      expect(flashIn((await web.get('/')).body)).toBe('accepted the topic "sunday_hours" ("Sunday opening hours", retitled from "sunday hrs") into kb/topics.yaml');
      expect(readFileSync(topics, 'utf8')).toContain('sunday_hours:\n  title: Sunday opening hours\n  keywords:\n    - sunday\n');
    } finally {
      await server.close();
    }
  });
});

describe('a passage approved outside kb:approve', () => {
  it('is listed for review though it is fresh, and once approved here it is in the log and no longer listed', async () => {
    const dir = folder('kb-author-review-unlogged');
    const log = join(dir, 'kb', 'approvals.jsonl');
    // Its approval is in its file, but its line is not in the log: written by hand, or copied with its file.
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines.some((l) => (JSON.parse(l) as { id: string }).id === 'opening-hours')).toBe(true);
    writeFileSync(log, `${lines.filter((l) => (JSON.parse(l) as { id: string }).id !== 'opening-hours').join('\n')}\n`);
    const place = findKb(dir, 'app');
    if (typeof place === 'string') throw new Error(place);
    const before = reviewState(place);
    expect(before.kb!.passages['opening-hours']!.freshness).toBe('fresh');
    expect(before.withheld.map((w) => [w.passage.id, w.why])).toEqual([['opening-hours', 'unlogged']]);

    const server = await startReviewServer({ place, today: () => TODAY });
    try {
      const web = browser(server);
      const home = (await web.get('/')).body;
      expect(home).toContain('Passages withheld from callers (0)');
      expect(home).toContain('Passages approved outside kb:approve (1)');
      expect(home).toContain('/passage/opening-hours');
      const page = (await web.get('/passage/opening-hours')).body;
      expect(page).toContain('approved outside kb:approve');
      expect(page).toContain('no one is on record for this answer');
      await web.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' });
      await web.post('/passage/opening-hours/approve', { seen: seenIn(page, '/passage/opening-hours/approve') });
      expect(flashIn((await web.get('/')).body)).toMatch(/^opening-hours: approved \(version 2026\.1\) by Jane Smith/);
    } finally {
      await server.close();
    }
    const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!) as { id: string; approvedBy: string };
    expect([last.id, last.approvedBy]).toEqual(['opening-hours', 'Jane Smith']);
    expect(reviewState(place).withheld).toEqual([]);
  });
});

describe('an approval a migration carried over', () => {
  /** A copy of the fixture whose log says a migration carried over the approvals of `ids` (their lines rewritten as an app's migration script writes them). */
  const migrated = (name: string, ids: readonly string[]): { dir: string; place: KbPlace; log: string } => {
    const dir = folder(name);
    const log = join(dir, 'kb', 'approvals.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const rewritten = lines.map((l) => {
      const line = JSON.parse(l) as Record<string, unknown>;
      if (!ids.includes(line.id as string)) return l;
      const { sourceText: _sourceText, ...rest } = line;
      return JSON.stringify({ ...rest, from: 'migration', note: 'content unchanged; migrated from the old format' });
    });
    writeFileSync(log, `${rewritten.join('\n')}\n`);
    const place = findKb(dir, 'app');
    if (typeof place === 'string') throw new Error(place);
    return { dir, place, log };
  };

  it('is listed to confirm, and once a person confirms it the log records them, the passage file is as it was, and nothing is listed', async () => {
    const { dir, place, log } = migrated('kb-author-review-migrated', ['late-fees-adult']);
    const passageFile = join(dir, 'kb', 'passages', 'late-fees-adult.yaml');
    const fileBefore = readFileSync(passageFile);
    const logBefore = readFileSync(log, 'utf8');
    const migratedLine = JSON.parse(logBefore.trim().split('\n').find((l) => l.includes('"late-fees-adult"'))!) as Record<string, string>;
    const server = await startReviewServer({ place, today: () => TODAY });
    try {
      const web = browser(server);
      const home = (await web.get('/')).body;
      expect(home).toContain('<h2 id="confirm-h">Approvals to confirm (1)</h2>');
      const row = /<tr><td class="mono"><a href="\/passage\/late-fees-adult\?token=[^"]*">late-fees-adult<\/a>[\s\S]*?<\/tr>/.exec(home)?.[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      expect(row).toBe('late-fees-adult late_fees Late books on an adult card cost 25 cents a day, up to 5 dollars a book.');
      expect((await web.get('/kb')).body).toContain('1 approval carried over by a migration awaits confirmation');

      const page = (await web.get('/passage/late-fees-adult')).body;
      expect(page).toContain('<h3>Confirm this approval</h3>');
      expect(page.indexOf('/passage/late-fees-adult/confirm')).toBeLessThan(page.indexOf('/passage/late-fees-adult/edit'));
      expect(page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('Confirming records that you read this answer against its source and answer for it');

      await web.post('/reviewer', { by: 'Dana Ortiz', owner: 'Patron Services', back: '/' });
      const back = await web.post('/passage/late-fees-adult/confirm', { seen: seenIn(page, '/passage/late-fees-adult/confirm') });
      expect(back.headers.location).toBe(`/?token=${server.token}`);
      expect(flashIn((await web.get('/')).body)).toBe(`late-fees-adult: the approval a migration carried over is confirmed by Dana Ortiz for Patron Services on ${TODAY}; logged in kb/approvals.jsonl`);

      // Exactly one line appended, recording the reviewer, with the approval's hashes; the passage's file is as it was.
      const after = readFileSync(log, 'utf8');
      expect(after.startsWith(logBefore)).toBe(true);
      const added = after.slice(logBefore.length).trim().split('\n');
      expect(added).toHaveLength(1);
      expect(JSON.parse(added[0]!)).toEqual({
        id: 'late-fees-adult',
        version: migratedLine.version,
        approvedBy: 'Dana Ortiz',
        owner: 'Patron Services',
        on: TODAY,
        sourceHash: migratedLine.sourceHash,
        hash: migratedLine.hash,
        from: 'passage',
        sourceText: 'An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.',
      });
      expect(readFileSync(passageFile).equals(fileBefore)).toBe(true);

      // Nothing is listed to confirm, and the approval names the reviewer, no longer migrated.
      expect((await web.get('/')).body).not.toContain('Approvals to confirm');
      const kbTab = (await web.get('/kb')).body;
      expect(kbTab).not.toContain('awaits confirmation');
      const kbRow = /<tr><td class="mono"><a href="\/passage\/late-fees-adult\?token=[^"]*">late-fees-adult<\/a>[\s\S]*?<\/tr>/.exec(kbTab)![0];
      expect(kbRow).toContain(`Dana Ortiz (Patron Services) on ${TODAY}`);
      expect(kbRow).not.toContain('migrated');
      const reopened = (await web.get('/passage/late-fees-adult')).body;
      expect(reopened).not.toContain('/passage/late-fees-adult/confirm');
      expect(reopened.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain(`Approved by Dana Ortiz Team Patron Services On ${TODAY}`);
      expect(reviewState(place).withheld).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('is refused without a reviewer, for an approval no migration carried over, for a stale passage, and when it changed since it was opened; nothing is written', async () => {
    const { dir, place, log } = migrated('kb-author-review-migrated-refused', ['late-fees-adult', 'card-renewal-adult']);
    // card-renewal-adult is edited since its approval: stale, withheld.
    const card = join(dir, 'kb', 'passages', 'card-renewal-adult.yaml');
    writeFileSync(card, readFileSync(card, 'utf8').replace("There's no charge.", 'It is free.'));
    const server = await startReviewServer({ place, today: () => TODAY });
    try {
      const web = browser(server);
      const files = filesOf(dir);
      const page = (await web.get('/passage/late-fees-adult')).body;
      const seen = seenIn(page, '/passage/late-fees-adult/confirm');

      // No reviewer.
      await web.post('/passage/late-fees-adult/confirm', { seen });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: say who is reviewing first: your name and your team');
      // A name that is not a person's, as approve and reject refuse it.
      expect(confirmApproval(place, 'late-fees-adult', { by: 'Claude', owner: 'Patron Services' }, TODAY, seen)).toMatchObject({ ok: false, message: expect.stringMatching(/^the name "Claude" is not a person/) });
      expect(filesOf(dir)).toEqual(files);

      await web.post('/reviewer', { by: 'Dana Ortiz', owner: 'Patron Services', back: '/' });
      // An approval a person made (kb:approve's line), not a migration.
      const opening = seenIn((await web.get('/passage/opening-hours')).body, '/passage/opening-hours/edit');
      await web.post('/passage/opening-hours/confirm', { seen: opening });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: opening-hours: its approval was not carried over by a migration: it is already confirmed by Branch Manager on 2025-12-10');
      // Stale: withheld, so it is approved again (or edited), not confirmed.
      const stale = seenIn((await web.get('/passage/card-renewal-adult')).body, '/passage/card-renewal-adult/approve');
      await web.post('/passage/card-renewal-adult/confirm', { seen: stale });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: card-renewal-adult is withheld from callers (edited since it was approved): review it and approve it again; only an approval that stands as a migration carried it over is confirmed');
      expect(filesOf(dir)).toEqual(files);

      // Changed on disk since it was opened (a comment, so it is still fresh): refused, and refused without what was seen.
      const lateFees = join(dir, 'kb', 'passages', 'late-fees-adult.yaml');
      writeFileSync(lateFees, `${readFileSync(lateFees, 'utf8')}# reviewed with the branch\n`);
      const changed = filesOf(dir);
      await web.post('/passage/late-fees-adult/confirm', { seen });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: late-fees-adult changed since you opened it: reload the page and review it again');
      await web.post('/passage/late-fees-adult/confirm', {});
      expect(flashIn((await web.get('/')).body)).toBe('Not done: late-fees-adult changed since you opened it: reload the page and review it again');
      expect(filesOf(dir)).toEqual(changed);
      expect(readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"Dana Ortiz"'))).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('the section as it was approved', () => {
  it('is read from kb/approvals.jsonl only when its text hashes to the approval\'s sourceHash', () => {
    const dir = folder('kb-author-review-approved-text');
    const place = findKb(dir, 'app');
    if (typeof place === 'string') throw new Error(place);
    const kb = loadKb(place).kb!;
    const passage = kb.passages['opening-hours']!;
    const text = kb.sources['patron-guide']!.sections['1.1']!.text;
    const line = (sourceText: string): string => `${JSON.stringify({ id: 'opening-hours', version: passage.version, approvedBy: 'Branch Manager', owner: 'Patron Services', on: '2025-12-10', sourceHash: passage.approval!.sourceHash, hash: passage.approval!.hash, from: 'passage', sourceText })}\n`;
    writeFileSync(join(dir, 'kb', 'approvals.jsonl'), line(text));
    expect(approvedSectionText(place, passage)).toBe(text);
    // The log is a file anyone can edit: a text that is not what the hash says is not shown as what was approved.
    writeFileSync(join(dir, 'kb', 'approvals.jsonl'), line('All branches are open every day, Sunday too.'));
    expect(approvedSectionText(place, passage)).toBeNull();
    // Read as dialogwright reads the log: a line that does not parse, or lacks what a line has, is passed over.
    const { from: _from, ...noFrom } = JSON.parse(line(text)) as Record<string, unknown>;
    writeFileSync(join(dir, 'kb', 'approvals.jsonl'), `not json\n${JSON.stringify(noFrom)}\n`);
    expect(approvedSectionText(place, passage)).toBeNull();
    writeFileSync(join(dir, 'kb', 'approvals.jsonl'), `not json\n${line(text)}`);
    expect(approvedSectionText(place, passage)).toBe(text);
  });
});

describe('what the knowledge base holds', () => {
  const DRAFT = [
    'id: sunday-hours',
    'topic: opening_hours',
    'version: "2026.1"',
    'effective: { from: 2026-01-01 }',
    'source: { document: patron-guide, section: "1.1" }',
    'answer: Every branch is closed on Sunday.',
    `drafted: { by: fake-drafter, on: ${TODAY}, excerpt: "All branches are closed on Sunday." }`,
    '',
  ].join('\n');

  it('says when nothing waits, and links to the knowledge base tab', async () => {
    const found = findKb(folder('kb-author-review-kb-empty'), 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const home = (await browser(server).get('/')).body;
      expect(home).toContain('<h1>Nothing waits for review</h1>');
      expect(home).toContain(`<a href="/kb?token=${server.token}">See what the knowledge base holds.</a>`);
      // The tab is in the header of every page.
      expect(home).toContain(`<a href="/gaps?token=${server.token}">Gaps</a><a href="/kb?token=${server.token}">Knowledge base</a>`);
    } finally {
      await server.close();
    }
  });

  it('lists every topic and its passages, with their state and who approved them, and the rejected drafts with why', async () => {
    const dir = folder('kb-author-review-kb-browse');
    // card-renewal-junior's line is not in the log: approved outside kb:approve.
    const log = join(dir, 'kb', 'approvals.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '');
    writeFileSync(log, `${lines.filter((l) => (JSON.parse(l) as { id: string }).id !== 'card-renewal-junior').join('\n')}\n`);
    writeFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), DRAFT);
    const found = findKb(dir, 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const web = browser(server);
      await web.post('/reviewer', { by: 'Dana Ortiz', owner: 'Patron Services', back: '/' });
      await web.post('/draft/sunday-hours/reject', { reason: 'The guide says this already.', seen: seenIn((await web.get('/draft/sunday-hours')).body, '/draft/sunday-hours/reject') });
      const res = await web.get('/kb');
      expect(res.status).toBe(200);
      const body = res.body;
      const row = (id: string): string => {
        const m = new RegExp(`<tr><td class="mono"><a href="/passage/${id}\\?token=[^"]*">${id}</a>[\\s\\S]*?</tr>`).exec(body);
        if (!m) throw new Error(`no row for ${id}`);
        return m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#39;/g, "'").trim();
      };
      // Every topic, by its title and its id.
      for (const [id, title] of [['opening_hours', 'Opening hours'], ['card_renewal', 'Renewing a library card'], ['late_fees', 'Late fees']]) {
        expect(body).toContain(`${title} <span class="mono muted">${id}</span>`);
      }
      expect(row('opening-hours')).toBe("opening-hours 2026.1 every caller from 2026-01-01, open-ended We're open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We're closed on Sunday. in force Branch Manager (Patron Services) on 2025-12-10");
      expect(row('opening-hours-es')).toMatch(/^opening-hours-es es 2026\.1 every caller from 2026-01-01, open-ended Abrimos .* in force Branch Manager \(Patron Services\) on 2025-12-10$/);
      expect(row('late-fees-adult-2025')).toMatch(/^late-fees-adult-2025 2025\.1 card: adult from 2025-01-01 to 2025-12-31 Late books .* expired Branch Manager \(Patron Services\) on 2025-12-10$/);
      expect(row('card-renewal-junior')).toMatch(/ approved outside kb:approve not in the log: its approval names Branch Manager \(Patron Services\) on 2025-12-10$/);
      // The rejected draft: who rejected it, when and why.
      expect(body).toContain('Rejected drafts (1)');
      const rejected = /<tr><td class="mono"><a href="\/rejected\/sunday-hours\?token=[^"]*">sunday-hours<\/a>[\s\S]*?<\/tr>/.exec(body)?.[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      expect(rejected).toBe(`sunday-hours opening_hours Dana Ortiz ${TODAY} The guide says this already.`);
    } finally {
      await server.close();
    }
  });

  it('serves a page for a passage that is approved and fresh, with its approval record, and offers only an edit that is approved again', async () => {
    const found = findKb(folder('kb-author-review-kb-passage'), 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    try {
      const web = browser(server);
      const res = await web.get('/passage/late-fees-adult');
      expect(res.status).toBe(200);
      const text = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#39;/g, "'");
      expect(text).toContain('Late books on an adult card cost 25 cents a day, up to 5 dollars a book.');
      expect(text).toContain('Account line Your card has {balance} in late fees right now. (read through getFees)');
      expect(text).toContain('An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.');
      expect(text).toContain('Approved by Branch Manager Team Patron Services On 2025-12-10 Version 2026.1 Recorded as a passage in kb/passages, approved with kb:approve');
      expect(res.body).toContain('action="/passage/late-fees-adult/edit"');
      expect(res.body).not.toContain('/passage/late-fees-adult/approve');
      expect(res.body).not.toContain('/reject');

      // The edit is checked and approved again, under the reviewer's name.
      await web.post('/reviewer', { by: 'Dana Ortiz', owner: 'Patron Services', back: '/' });
      const opened = (await web.get('/passage/opening-hours')).body;
      const answer = "We're open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We're closed on Sunday.";
      await web.post('/passage/opening-hours/edit', { answer, from: '2026-01-01', to: '2027-12-31', seen: seenIn(opened, '/passage/opening-hours/edit') });
      expect(flashIn((await web.get('/')).body)).toMatch(/^edited, then opening-hours: approved \(version 2026\.1\) by Dana Ortiz/);
      expect(readFileSync(join(found.kbDir, 'passages', 'opening-hours.yaml'), 'utf8')).toContain('effective:\n  from: 2026-01-01\n  to: 2027-12-31\n');
    } finally {
      await server.close();
    }
  });

  it('returns a rejected draft to the drafts as it was, refused without a reviewer or when it changed since it was opened', async () => {
    const dir = folder('kb-author-review-kb-return');
    writeFileSync(join(dir, 'kb', 'pending', 'sunday-hours.yaml'), DRAFT);
    const found = findKb(dir, 'app');
    if (typeof found === 'string') throw new Error(found);
    const server = await startReviewServer({ place: found, today: () => TODAY });
    const pending = join(dir, 'kb', 'pending', 'sunday-hours.yaml');
    const rejectedFile = join(dir, 'kb', 'rejected', 'sunday-hours.yaml');
    try {
      const web = browser(server);
      await web.post('/reviewer', { by: 'Dana Ortiz', owner: 'Patron Services', back: '/' });
      await web.post('/draft/sunday-hours/reject', { reason: 'Not needed.', seen: seenIn((await web.get('/draft/sunday-hours')).body, '/draft/sunday-hours/reject') });
      expect([existsSync(pending), existsSync(rejectedFile)]).toEqual([false, true]);

      const opened = await web.get('/rejected/sunday-hours');
      expect(opened.status).toBe(200);
      const text = opened.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      expect(text).toContain('Every branch is closed on Sunday.');
      expect(text).toContain(`Rejected by Dana Ortiz on ${TODAY}: Not needed.`);
      const seen = seenIn(opened.body, '/rejected/sunday-hours/return');

      // Without a reviewer: refused, nothing moved.
      const other = browser(server);
      const otherSeen = seenIn((await other.get('/rejected/sunday-hours')).body, '/rejected/sunday-hours/return');
      await other.post('/rejected/sunday-hours/return', { seen: otherSeen });
      expect(flashIn((await other.get('/')).body)).toBe('Not done: say who is reviewing first: your name and your team');
      expect([existsSync(pending), existsSync(rejectedFile)]).toEqual([false, true]);

      // Changed on disk since it was opened: refused, nothing moved.
      const before = readFileSync(rejectedFile, 'utf8');
      const changed = before.replace('Not needed.', 'Not needed at all.');
      writeFileSync(rejectedFile, changed);
      await web.post('/rejected/sunday-hours/return', { seen });
      expect(flashIn((await web.get('/')).body)).toBe('Not done: sunday-hours changed since you opened it: reload the page and review it again');
      await web.post('/rejected/sunday-hours/return', {});
      expect(flashIn((await web.get('/')).body)).toBe('Not done: sunday-hours changed since you opened it: reload the page and review it again');
      expect([existsSync(pending), readFileSync(rejectedFile, 'utf8')]).toEqual([false, changed]);

      // Reopened, it goes back to the drafts as it was drafted, without its rejection, and waits for review.
      await web.post('/rejected/sunday-hours/return', { seen: seenIn((await web.get('/rejected/sunday-hours')).body, '/rejected/sunday-hours/return') });
      expect(flashIn((await web.get('/')).body)).toBe('sunday-hours: returned to the drafts by Dana Ortiz (it was rejected by Dana Ortiz on 2026-10-03: Not needed at all.); moved to kb/pending/sunday-hours.yaml');
      expect(existsSync(rejectedFile)).toBe(false);
      expect(readFileSync(pending, 'utf8')).toBe(DRAFT);
      expect(Object.keys(parse(readFileSync(pending, 'utf8')) as object)).not.toContain('rejected');
      const home = (await web.get('/')).body;
      expect(home).toContain('Drafts waiting (1)');
      expect(home).toContain(`<a href="/draft/sunday-hours?token=${server.token}">sunday-hours</a>`);
      expect((await web.get('/kb')).body).toContain('Rejected drafts (0)');
    } finally {
      await server.close();
    }
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

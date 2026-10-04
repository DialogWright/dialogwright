import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { cleanScratch, folder, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../cli';
import { findKb, type KbPlace } from '../kbPlace';
import { loadKb } from '../kbPlace';
import { acceptTopic, approve, approvedSectionText, editAndApprove, mergeTopic, reject } from './actions';
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

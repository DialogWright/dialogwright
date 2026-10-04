import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVALS_LOG, checkApp, defineApp, formatProblem, loadKnowledgeFolder, parseApprovalLog, registerApp } from 'dialogwright';
import { ask, call, cleanScratch, codeFor, folder, heard, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, describe, expect, it } from 'vitest';
import { FOLDER, fakeClock, guardedFetch } from './__fixtures__/server';
import { main, type Io } from './cli';
import { draftKb } from './draft/draft';
import { FakeDrafter, type FakeRule } from './draft/fake';
import { ingest } from './ingest';
import { findKb, type KbPlace } from './kbPlace';
import { acceptTopic, approve } from './review/actions';
import { startReviewServer, type ReviewServer } from './review/server';

/**
 * The authoring pipeline end to end, with the fake drafter: a document ingested from Example Town
 * Library's folder into the library app's knowledge base (dialogwright's own fixture app), drafted,
 * checked, reviewed in the review page over HTTP (a name given, a topic accepted, a draft approved,
 * one edited then approved, one rejected, a topic merged), and the approved passages spoken by the
 * app's knowledge completion on a call; then a refresh after the source changes, which withholds a
 * passage until the review page shows the change and a person approves it again.
 */

afterAll(cleanScratch);

/** The library app with its knowledge base, and the authoring fixture's documents in docs/. */
function scratchApp(id: string): { dir: string; place: KbPlace } {
  const dir = folder(id);
  cpSync(FOLDER, join(dir, 'docs'), { recursive: true });
  const place = findKb(dir, 'app');
  if (typeof place === 'string') throw new Error(place);
  return { dir, place };
}

const OPENING_HOURS_ANSWER = "We're open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We're closed on Sunday.";

/** What the fake drafter proposes for the patron guide: three good drafts and four that fail a check. */
const RULES: FakeRule[] = [
  {
    section: 'meeting-rooms',
    topic: { id: 'meeting_rooms', title: 'Booking a meeting room', keywords: ['meeting room', 'book a room'], asks: ['Can I book a meeting room?'] },
    answer: 'Any card holder can book a meeting room for free, up to sixty days ahead, for up to three hours.',
    excerpt: 'Meeting rooms can be booked up to sixty days ahead at no charge by any card holder. Each booking may last up to three hours.',
  },
  {
    section: 'renewing-items',
    topic: { id: 'renewing_items', title: 'Renewing what you borrowed', keywords: ['renew a book'], asks: ['Can I renew my books?'] },
    answer: 'You can renew most items twice.',
    excerpt: 'Most items can be renewed twice, online or at any branch desk',
  },
  {
    section: 'library-cards',
    topic: { id: 'library_cards', title: 'Getting a library card' },
    answer: 'A library card is free for anyone who lives, works or studies in Example Town.',
  },
  // An excerpt the section does not have.
  { section: 'late-fees', topic: 'late_fees', answer: 'Late books cost 25 cents a day.', excerpt: 'An adult card costs 25 cents a day.' },
  // An answer far too long to say in one breath.
  { section: 'opening-hours', topic: 'opening_hours', answer: 'All branches are open Monday to Friday from 9 a.m. to 8 p.m. '.repeat(8) },
  // A variable.
  { section: 'opening-hours', topic: 'opening_hours', answer: 'We open at {time} today.' },
  // The answer a passage already gives.
  { section: 'intro', topic: 'opening_hours', answer: OPENING_HOURS_ANSWER },
];

/**
 * A browser on the review page: GETs and form POSTs with or without the token, redirects not
 * followed, the session cookie kept. A POST to a draft's, passage's or topic's action opens its page
 * first and sends back the form's `seen` (what the page showed), as a person submitting it would.
 */
function client(server: ReviewServer) {
  const at = (path: string, token: string | null = server.token): string => `${server.origin}${path}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`;
  const jar = new Map<string, string>();
  const headers = (): Record<string, string> => (jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {});
  const keep = (r: Response): void => {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
  };
  const get = async (path: string, token: string | null = server.token) => {
    const r = await fetch(at(path, token), { redirect: 'manual', headers: headers() });
    keep(r);
    return { status: r.status, text: await r.text() };
  };
  return {
    get,
    post: async (path: string, fields: Record<string, string | string[]>, token: string | null = server.token) => {
      const body = new URLSearchParams();
      if (token !== null) body.set('token', token);
      const action = /^(\/(?:draft|passage|topic)\/[^/]+)\/[a-z]+$/.exec(path);
      if (action && !('seen' in fields)) {
        const form = new RegExp(`action="${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*><input type="hidden" name="token" value="[^"]*"><input type="hidden" name="seen" value="([^"]*)">`).exec((await get(action[1]!)).text);
        if (form) body.set('seen', form[1]!);
      }
      for (const [k, v] of Object.entries(fields)) for (const one of typeof v === 'string' ? [v] : v) body.append(k, one);
      const r = await fetch(`${server.origin}${path}`, { method: 'POST', body, redirect: 'manual', headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' } });
      keep(r);
      await r.text();
      return { status: r.status, location: r.headers.get('location') };
    },
  };
}

/** The flash message the next page shows (the outcome of the last POST). */
const flashOf = (html: string): string | null => {
  const m = /<div class="flash (ok|no)" role="(?:status|alert)">([\s\S]*?)<\/div>/.exec(html);
  return m ? `${m[1]}: ${m[2]!.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()}` : null;
};

describe('the pipeline: ingest, draft, review, speak', () => {
  it('drafts from an ingested document, refusing what fails a check, and a person approves the rest in the review page before a caller hears it', async () => {
    const { dir, place } = scratchApp('kb-author-pipeline');
    const kbDir = place.kbDir;
    // The fixture's own approvals are in its log already; this run's are the lines after them.
    const logged = parseApprovalLog(readFileSync(join(kbDir, APPROVALS_LOG), 'utf8')).length;
    expect(logged).toBeGreaterThan(0);

    // Ingest: the patron guide PDF beside the fixture's own hand-written patron guide source.
    const ingested = await ingest({ input: join(dir, 'docs', 'patron-guide.pdf'), appDir: dir, kbDir, today: TODAY });
    expect(ingested.documents.map((d) => [d.id, d.status])).toEqual([['patron-guide-pdf', 'added']]);

    // Draft: three written, four refused with their reasons, three topics proposed.
    const drafter = new FakeDrafter(RULES.map((r) => ({ ...r, document: 'patron-guide-pdf' })));
    const report = await draftKb({ place, drafter, today: TODAY, sources: ['patron-guide-pdf'] });
    expect(report.written.map((w) => [w.id, w.topic, w.proposed, w.section])).toEqual([
      ['meeting-rooms', 'meeting_rooms', true, 'meeting-rooms'],
      ['renewing-items', 'renewing_items', true, 'renewing-items'],
      ['library-cards', 'library_cards', true, 'library-cards'],
    ]);
    expect(report.rejected.map((r) => [r.section, r.reasons])).toEqual([
      ['late-fees', ['its excerpt is not in kb/sources/patron-guide-pdf.yaml section "late-fees" word for word']],
      ['opening-hours', ['its excerpt does not say 8, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes', 'its answer is 487 characters, over the 400 kb.yaml allows (maxAnswerChars): a spoken answer is one or two short sentences']],
      ['opening-hours', ['its answer has a brace: an answer is fixed text, said word for word, with no variables']],
      ['intro', ['its excerpt does not say 9, 8, 10 and 4, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes', 'it repeats the answer of the passage "opening-hours"']],
    ]);
    expect(report.proposed.map((t) => t.id)).toEqual(['meeting_rooms', 'renewing_items', 'library_cards']);
    // The drafter saw the sections, the knowledge base's topics and its limits.
    expect(drafter.requests[0]).toMatchObject({ locale: 'en-US', maxAnswerChars: 400, applies: { card: ['adult', 'junior'] } });
    expect(drafter.requests[0]!.existingTopics.map((t) => t.id)).toEqual(['opening_hours', 'card_renewal', 'late_fees']);
    expect(readFileSync(join(kbDir, 'pending', 'meeting-rooms.yaml'), 'utf8')).toBe(
      [
        'id: meeting-rooms',
        'topic: meeting_rooms',
        'version: "2026.1"',
        'effective:',
        `  from: ${TODAY}`,
        'source:',
        '  document: patron-guide-pdf',
        '  section: meeting-rooms',
        'answer: Any card holder can book a meeting room for free, up to sixty days ahead, for up to three hours.',
        'drafted:',
        '  by: fake-drafter',
        `  on: ${TODAY}`,
        '  excerpt: Meeting rooms can be booked up to sixty days ahead at no charge by any card holder. Each booking may last up to three hours.',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(kbDir, 'pending', 'topics.yaml'), 'utf8')).toContain('meeting_rooms:\n  title: Booking a meeting room\n  keywords:\n    - meeting room\n    - book a room\n');
    // Never in topics.yaml until accepted; the knowledge base loads as it did, and nothing pending is said.
    expect(readFileSync(join(kbDir, 'topics.yaml'), 'utf8')).not.toContain('meeting_rooms');
    expect(loadKnowledgeFolder(kbDir).problems).toEqual([]);
    // A second run passes over the sections already drafted.
    const again = await draftKb({ place, drafter: new FakeDrafter(RULES.map((r) => ({ ...r, document: 'patron-guide-pdf' }))), today: TODAY, sources: ['patron-guide-pdf'], dryRun: true });
    expect(again.documents).toEqual([{ id: 'patron-guide-pdf', given: 3, cited: 3 }]);

    // Review, over HTTP with the token.
    const server = await startReviewServer({ place, today: () => TODAY });
    const web = client(server);
    try {
      const home = await web.get('/');
      expect(home.status).toBe(200);
      expect(home.text).toContain('Proposed topics (3)');
      expect(home.text).toContain('Drafts waiting (3)');
      expect(home.text).toContain('<label for="reviewer-name">Your name</label>');
      const draftHtml = (await web.get('/draft/meeting-rooms')).text;
      expect(draftHtml).toContain('<mark><span class="sr">Excerpt: </span>Meeting rooms can be booked up to sixty days ahead at no charge by any card holder. Each booking may last up to three hours.</mark>');
      expect(draftHtml).toContain('its topic &quot;meeting_rooms&quot; is only proposed: accept it (or merge it into a topic) first');

      // No approval without a person's name.
      await web.post('/draft/meeting-rooms/approve', {});
      expect(flashOf((await web.get('/')).text)).toBe('no: Not done: say who is reviewing first: your name and your team');
      await web.post('/reviewer', { by: 'Claude', owner: 'Patron Services', back: '/' });
      expect(flashOf((await web.get('/')).text)).toMatch(/^no: Not done: the name "Claude" is not a person/);
      expect(await web.post('/reviewer', { by: 'Jane Smith', owner: 'Patron Services', back: '/' })).toMatchObject({ status: 303 });
      expect(flashOf((await web.get('/')).text)).toBe('ok: reviewing as Jane Smith for Patron Services');

      // A draft of a proposed topic waits for its topic; accepted, the draft is approved.
      await web.post('/draft/meeting-rooms/approve', {});
      expect(flashOf((await web.get('/')).text)).toBe('no: Not done: meeting-rooms cannot be approved as it is its topic "meeting_rooms" is only proposed: accept it (or merge it into a topic) first');
      await web.post('/topic/meeting_rooms/accept', { as: 'meeting_rooms' });
      expect(flashOf((await web.get('/')).text)).toBe('ok: accepted the topic "meeting_rooms" ("Booking a meeting room") into kb/topics.yaml');
      expect(readFileSync(join(kbDir, 'topics.yaml'), 'utf8')).toContain('meeting_rooms:\n  title: Booking a meeting room\n');
      await web.post('/draft/meeting-rooms/approve', {});
      expect(flashOf((await web.get('/')).text)).toMatch(/^ok: meeting-rooms: approved \(version 2026\.1\) by Jane Smith for Patron Services on 2026-10-03: moved the draft kb\/pending\/meeting-rooms\.yaml to kb\/passages\/meeting-rooms\.yaml/);

      // A topic renamed as it is accepted: its draft follows. An edit that fails a check is not saved; one that passes is approved.
      await web.post('/topic/renewing_items/accept', { as: 'item_renewals' });
      expect(readFileSync(join(kbDir, 'pending', 'renewing-items.yaml'), 'utf8')).toContain('topic: item_renewals\n');
      const before = readFileSync(join(kbDir, 'pending', 'renewing-items.yaml'), 'utf8');
      await web.post('/draft/renewing-items/edit', { answer: 'You can renew {count} items.', excerpt: 'Most items can be renewed twice', from: TODAY, to: '' });
      expect(flashOf((await web.get('/')).text)).toBe('no: Not done: the edit to renewing-items was not saved its answer has a brace: an answer is fixed text, said word for word, with no variables');
      await web.post('/draft/renewing-items/edit', { answer: 'You can renew most items twice.', excerpt: 'Most items can be renewed three times', from: TODAY, to: '' });
      expect(flashOf((await web.get('/')).text)).toBe('no: Not done: the edit to renewing-items was not saved its excerpt is not in kb/sources/patron-guide-pdf.yaml section "renewing-items" word for word');
      expect(readFileSync(join(kbDir, 'pending', 'renewing-items.yaml'), 'utf8')).toBe(before);
      await web.post('/draft/renewing-items/edit', {
        answer: 'You can renew most items twice, online or at any branch desk, unless someone has placed a hold on them.',
        excerpt: 'Most items can be renewed twice, online or at any branch desk, unless another patron has placed a hold on them.',
        from: TODAY,
        to: '',
      });
      expect(flashOf((await web.get('/')).text)).toMatch(/^ok: edited, then renewing-items: approved/);
      expect(readFileSync(join(kbDir, 'passages', 'renewing-items.yaml'), 'utf8')).toContain('answer: You can renew most items twice, online or at any branch desk, unless someone has placed a hold on them.\n');

      // A rejection needs a reason, and is kept with it; its proposed topic is merged into one the knowledge base has.
      await web.post('/draft/library-cards/reject', { reason: ' ' });
      expect(flashOf((await web.get('/')).text)).toBe('no: Not done: say why the draft is rejected: the reason is kept with it');
      await web.post('/draft/library-cards/reject', { reason: 'Getting a card is not something callers ask us; renewals are covered.' });
      expect(flashOf((await web.get('/')).text)).toBe('ok: library-cards: rejected by Jane Smith (Getting a card is not something callers ask us; renewals are covered.); moved to kb/rejected/library-cards.yaml');
      expect(readFileSync(join(kbDir, 'rejected', 'library-cards.yaml'), 'utf8')).toContain(`rejected:\n  by: Jane Smith\n  on: ${TODAY}\n  reason: Getting a card is not something callers ask us; renewals are covered.\n`);
      expect(existsSync(join(kbDir, 'pending', 'library-cards.yaml'))).toBe(false);
      await web.post('/topic/library_cards/merge', { into: 'card_renewal' });
      expect(flashOf((await web.get('/')).text)).toBe('ok: merged the proposed topic "library_cards" into "card_renewal"; its drafts now answer "card_renewal"');
      expect(readdirSync(join(kbDir, 'pending')).sort()).toEqual(['README.md']);
      expect((await web.get('/')).text).toContain('<h1>Nothing waits for review</h1>');
    } finally {
      await server.close();
    }

    // The approved passages load fresh, the app passes its checks, and a caller hears them.
    const kb = loadKnowledgeFolder(kbDir).kb!;
    expect([kb.passages['meeting-rooms']!.freshness, kb.passages['renewing-items']!.freshness]).toEqual(['fresh', 'fresh']);
    const log = parseApprovalLog(readFileSync(join(kbDir, APPROVALS_LOG), 'utf8')).slice(logged);
    expect(log.map((l) => [l.id, l.sourceText])).toEqual([
      ['meeting-rooms', 'Meeting rooms can be booked up to sixty days ahead at no charge by any card holder. Each booking may last up to three hours.'],
      ['renewing-items', 'Most items can be renewed twice, online or at any branch desk, unless another patron has placed a hold on them.\n\nItems borrowed from another library through the interlibrary service cannot be renewed.'],
    ]);
    expect((await checkApp(dir, { code: codeFor(dir), todayIso: TODAY })).map(formatProblem)).toEqual([]);
    const app = defineApp(dir, codeFor(dir));
    registerApp(app);
    const meeting = call(app);
    ask(meeting, 'meeting_rooms');
    expect(heard(meeting)).toBe('Sure, I can help you answer a question. Any card holder can book a meeting room for free, up to sixty days ahead, for up to three hours. Is there anything else I can help with?');
    const renewing = call(app);
    ask(renewing, 'item_renewals');
    expect(heard(renewing)).toContain('You can renew most items twice, online or at any branch desk, unless someone has placed a hold on them.');
  });
});

describe('refreshing the sources', () => {
  it('withholds a passage whose section changed, shows the change in the review page, and speaks it again once a person approves it', async () => {
    const { dir, place } = scratchApp('kb-author-refresh');
    const kbDir = place.kbDir;
    await ingest({ input: join(dir, 'docs', 'faq.md'), appDir: dir, kbDir, today: TODAY });
    const rule: FakeRule = {
      document: 'faq',
      section: 'borrowing/lost-cards',
      topic: { id: 'lost_cards', title: 'A lost card', keywords: ['lost card'] },
      answer: 'Report a lost card at any branch desk. A replacement is free.',
      excerpt: 'Report a lost card at any branch desk; a replacement is free.',
    };
    await draftKb({ place, drafter: new FakeDrafter([rule]), today: TODAY, sources: ['faq'] });
    const reviewer = { by: 'Sam Lee', owner: 'Branch Services' };
    expect(acceptTopic(place, 'lost_cards', reviewer)).toMatchObject({ ok: true });
    expect(approve(place, 'lost-cards', reviewer, TODAY)).toMatchObject({ ok: true });

    const app1 = defineApp(dir, codeFor(dir));
    Object.assign(app1, { id: 'kb-author-refresh-1' });
    registerApp(app1);
    const first = call(app1);
    ask(first, 'lost_cards');
    expect(heard(first)).toContain('Report a lost card at any branch desk. A replacement is free.');

    // The source changes; a refresh re-reads it, writes only the source, and says what that means.
    const faq = join(dir, 'docs', 'faq.md');
    writeFileSync(faq, readFileSync(faq, 'utf8').replace('a replacement is free', 'a replacement costs 1 dollar'));
    const out: string[] = [];
    // No request leaves the machine: the fixture's one page on the web is refused, and said so.
    const clock = fakeClock();
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), cwd: dir, today: () => TODAY, fetch: guardedFetch('http://127.0.0.1:9').fetch, sleep: clock.sleep, now: clock.now };
    expect(await main(['kb:refresh'], io)).toBe(0);
    expect(out).toEqual([
      'kb:refresh: asking library.example (the hosts the sources were read from)',
      'kb:refresh kb: 2 reads (1 document): 0 added, 1 changed, 0 unchanged',
      '  changed   faq: ~ borrowing/lost-cards',
      '  not read  fee-schedule-2025: not read again this time (see what was skipped); the source is left as it is',
      '  not read  patron-guide: its file patron-guide.pdf is not there (the source is left as it is)',
      "  skipped   https://library.example/robots.txt: could not be fetched (the crawler asked for https://library.example/robots.txt, off the fixture's host)",
      '  skipped   https://library.example/fees-2025: disallowed by robots.txt',
      'withheld, their section changed (1): callers are not given them until a person approves them again',
      '  lost-cards  lost_cards  kb/sources/faq.yaml section "borrowing/lost-cards"',
      'sections no passage or draft cites (4): draft them with pnpm kb:draft --source faq',
      '  faq: intro, borrowing, borrowing/how-long-can-i-keep-a-book, borrowing/returns',
      'next: pnpm kb:review shows each withheld passage beside what changed in its section',
    ]);
    expect(loadKnowledgeFolder(kbDir).kb!.passages['lost-cards']!.freshness).toBe('source-changed');
    // The app as it starts now (it reads its knowledge base when it is built): the passage is withheld.
    const app2 = defineApp(dir, codeFor(dir));
    Object.assign(app2, { id: 'kb-author-refresh-2' });
    registerApp(app2);
    const withheld = call(app2);
    ask(withheld, 'lost_cards');
    expect(heard(withheld)).toContain("I'm sorry, I don't have an answer to that I can give you right now.");

    // The review page shows the passage beside the change; edited and approved again, it is said.
    const server = await startReviewServer({ place, today: () => TODAY });
    const web = client(server);
    try {
      const home = (await web.get('/')).text;
      expect(home).toContain('Passages withheld from callers (1)');
      expect(home).toContain('its source section changed');
      const page = (await web.get('/passage/lost-cards')).text;
      expect(page).toContain('What changed in the section since it was approved');
      expect(page).toContain('Report a lost card at any branch desk; a replacement <del><span class="sr">removed: </span>is free.</del><ins><span class="sr">added: </span>costs 1 dollar.</ins>');
      await web.post('/reviewer', { by: 'Sam Lee', owner: 'Branch Services', back: '/' });
      await web.post('/passage/lost-cards/edit', { answer: 'Report a lost card at any branch desk. A replacement costs 1 dollar.', from: TODAY, to: '' });
      expect(flashOf((await web.get('/')).text)).toMatch(/^ok: edited, then lost-cards: approved \(version 2026\.1\) by Sam Lee for Branch Services/);
    } finally {
      await server.close();
    }
    const app3 = defineApp(dir, codeFor(dir));
    Object.assign(app3, { id: 'kb-author-refresh-3' });
    registerApp(app3);
    const after = call(app3);
    ask(after, 'lost_cards');
    expect(heard(after)).toContain('Report a lost card at any branch desk. A replacement costs 1 dollar.');
  });
});

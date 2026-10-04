import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKnowledgeFolder } from 'dialogwright';
import { cleanScratch, folder, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../cli';
import { ClaudeDrafter, DEFAULT_DRAFT_MODEL, draftsOfResponse, MESSAGES_URL, partsOf, RESPONSE_SCHEMA, SYSTEM_PROMPT } from './claude';
import type { Draft, DraftRequest } from './drafter';
import { FakeDrafter, firstSentence } from './fake';
import { draftProblems, numbersIn, numbersNotInExcerpt } from './validate';

/**
 * Drafting: the checks every draft passes before it is written (with the messages an author reads),
 * the kb:draft command with the fake drafter, and the Claude adapter's request against a mocked
 * fetch. No test makes a real call: the live test runs only when ANTHROPIC_API_KEY is set and
 * DIALOGWRIGHT_LIVE_DRAFT=1, which CI never does.
 */

afterAll(cleanScratch);

/** The library app's knowledge base, loaded. */
function libraryKb() {
  const dir = folder('kb-author-draft');
  return { dir, kb: loadKnowledgeFolder(join(dir, 'kb'), 'en-US').kb! };
}

describe('the checks on a draft', () => {
  const { kb } = libraryKb();
  const ok: Draft = { topic: 'late_fees', answer: 'Late books on an adult card cost a quarter a day.', excerpt: 'An adult card is charged 25 cents for each day an item is overdue', section: '3.1' };
  const check = (d: Partial<Draft>, proposed = {}) => draftProblems({ ...ok, ...d }, { kb, document: 'patron-guide', proposed, pendingAnswers: new Map([['a pending answer.', 'other-draft']]) });

  it('passes a draft whose excerpt is in its section and whose answer is short, fixed and new', () => {
    expect(check({})).toEqual([]);
    // The excerpt matches across line breaks and spacing (the section is a folded block).
    expect(check({ section: '1.1', topic: 'opening_hours', answer: 'All branches open at 9 on weekdays.', excerpt: 'from 9 a.m. to 8 p.m. and on Saturday from 10 a.m.\n to 4 p.m.' })).toEqual([]);
  });

  it('refuses, with why, each thing a draft can get wrong', () => {
    expect(check({ section: '9.9' })).toEqual(['section "9.9" is not a section of kb/sources/patron-guide.yaml']);
    expect(check({ excerpt: '  ' })).toEqual(['its excerpt is empty: a draft quotes the words of the section that support it']);
    expect(check({ excerpt: 'An adult card costs 25 cents a day' })).toEqual(['its excerpt is not in kb/sources/patron-guide.yaml section "3.1" word for word']);
    expect(check({ answer: 'x'.repeat(401) })).toEqual(['its answer is 401 characters, over the 400 kb.yaml allows (maxAnswerChars): a spoken answer is one or two short sentences']);
    expect(check({ answer: 'Your fees are {balance}.' })).toEqual(['its answer has a brace: an answer is fixed text, said word for word, with no variables']);
    expect(check({ answer: ' ' })).toEqual(['its answer is empty']);
    expect(check({ topic: 'Late Fees' })).toEqual(['its topic "Late Fees" is not a topic id: letters, digits and underscores, starting with a letter']);
    expect(check({ topic: 'room_hire' })).toEqual(['its topic "room_hire" is not in kb/topics.yaml, and it proposes no title for a new one']);
    expect(check({ topic: { id: 'room_hire', title: ' ' } })).toEqual(['it proposes the topic "room_hire" without a title']);
    expect(check({ topic: 'room_hire' }, { room_hire: { id: 'room_hire', title: 'Room hire' } })).toEqual([]);
    expect(check({ applies: { card: 'senior' } })).toEqual(['its applies gives card "senior", which kb.yaml\'s applies does not list for card (adult, junior)']);
    expect(check({ applies: { branch: 'main' } })).toEqual(['its applies names "branch", which is not a fact of kb.yaml\'s applies (card)']);
    expect(check({ effective: { from: '2026-02-30' } })).toEqual(['its effective.from "2026-02-30" is not a day in the form YYYY-MM-DD']);
    expect(check({ effective: { from: '2026-03-01', to: '2026-02-01' } })).toEqual(['its effective.to (2026-02-01) is before its effective.from (2026-03-01)']);
    expect(check({ answer: 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book.', excerpt: 'charged 25 cents for each day an item is overdue, up to 5 dollars for each item' })).toEqual(['it repeats the answer of the passage "late-fees-adult"']);
    expect(check({ answer: 'A  PENDING answer.' })).toEqual(['it repeats the answer of the draft "other-draft" in kb/pending']);
  });

  it('refuses an excerpt too short to hold the answer to', () => {
    expect(check({ excerpt: 'overdue' })).toEqual(['its excerpt "overdue" is too short to hold the answer to: quote at least 4 words and 20 characters of the section']);
    expect(check({ excerpt: 'is charged 25 cents' })).toEqual(['its excerpt "is charged 25 cents" is too short to hold the answer to: quote at least 4 words and 20 characters of the section']);
    expect(check({ excerpt: 'charged 25 cents each day' })).toEqual(['its excerpt is not in kb/sources/patron-guide.yaml section "3.1" word for word']);
    expect(check({ excerpt: 'is charged 25 cents for' })).toEqual([]);
  });

  it('refuses an answer that says a number its excerpt does not, comparing numbers as numbers', () => {
    expect(check({ answer: 'Late books on an adult card cost 50 cents a day.' })).toEqual(['its excerpt does not say 50, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes']);
    expect(check({ answer: 'Late books cost 30 cents a day, up to 6 dollars, from 2026-01-05.' })).toEqual(['its excerpt does not say 30, 6 and 2026-01-05, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes']);
    // The section's whole sentence: 25 cents and 5 dollars, said as $0.25 is not, but $5.00 is.
    const whole = 'An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.';
    expect(check({ answer: 'An adult card pays 25 cents a day late, at most $5.00 an item.', excerpt: whole })).toEqual([]);
    // Numbers the excerpt writes as words count; times compare by the hour.
    expect(check({ section: '2.1', topic: 'card_renewal', answer: 'An adult card lasts 3 years, then renew it at any desk.', excerpt: 'An adult card is valid for three years.' })).toEqual([]);
    expect(check({ section: '2.1', topic: 'card_renewal', answer: 'An adult card lasts 4 years.', excerpt: 'An adult card is valid for three years.' })).toEqual(['its excerpt does not say 4, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes']);
    expect(check({ section: '1.1', topic: 'opening_hours', answer: 'Weekdays we open at 9:00 and close at 8.', excerpt: 'from 9 a.m. to 8 p.m. and on Saturday' })).toEqual([]);
    expect(check({ section: '1.1', topic: 'opening_hours', answer: 'Weekdays we open at 9:30.', excerpt: 'from 9 a.m. to 8 p.m. and on Saturday' })).toEqual(['its excerpt does not say 9:30, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes']);
  });

  it('reads numbers in figures and in words', () => {
    expect([...numbersIn('twenty-five cents, sixty days, 1,000 books, $5.00, 9:00, 07 and twenty one')].sort()).toEqual(['1', '1000', '20', '21', '25', '5', '60', '7', '9'].sort());
    expect(numbersNotInExcerpt('It is 1,000 books and $5.', 'one thousand books, 5 dollars, 1000 in all')).toEqual([]);
    expect(numbersNotInExcerpt('Call 555-0100.', 'Call the desk.')).toEqual(['555-0100']);
  });

  it('the fake drafter quotes a section\'s first sentence when its rule gives no excerpt', () => {
    expect(firstSentence('One. Two? Three!')).toBe('One.');
    expect(firstSentence('No full stop')).toBe('No full stop');
    expect(firstSentence('From 9 a.m. to 5.')).toBe('From 9 a.m.');
  });
});

describe('kb:draft', () => {
  it('drafts with the drafter it is given, reports what it wrote and refused, and passes over what is drafted', async () => {
    const { dir } = libraryKb();
    const out: string[] = [];
    const drafter = new FakeDrafter([
      { section: '2.2', topic: 'card_renewal', answer: 'A junior card renews itself each year until its holder turns eighteen.', applies: { card: 'junior' } },
      { section: '3.2', topic: 'late_fees', answer: 'Junior cards have no late fees.', excerpt: 'Junior cards never pay late fees.' },
    ]);
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), cwd: dir, today: () => TODAY, drafter: () => drafter };
    // The library's passages cite every section of the patron guide: --all gives the drafter them all the same.
    expect(await main(['kb:draft', '--source', 'patron-guide'], io)).toBe(0);
    expect(out).toEqual(['kb:draft with fake-drafter: 1 source document, 0 sections drafted from (5 already cited, passed over): 0 drafts written to kb/pending, 0 refused']);
    out.length = 0;
    // A dry run says what it would write, a space after the verb, and writes nothing.
    expect(await main(['kb:draft', '--source', 'patron-guide', '--all', '--dry-run'], io)).toBe(0);
    expect(out[1]).toBe('  would write kb/pending/card-renewal-junior-2.yaml  card_renewal  from patron-guide section "2.2"');
    expect(existsSync(join(dir, 'kb', 'pending', 'card-renewal-junior-2.yaml'))).toBe(false);
    out.length = 0;
    expect(await main(['kb:draft', '--source', 'patron-guide', '--all'], io)).toBe(0);
    expect(out).toEqual([
      'kb:draft with fake-drafter: 1 source document, 5 sections drafted from: 1 draft written to kb/pending, 1 refused',
      '  wrote    kb/pending/card-renewal-junior-2.yaml  card_renewal  from patron-guide section "2.2"',
      '  refused  patron-guide section "3.2" (late_fees): its excerpt is not in kb/sources/patron-guide.yaml section "3.2" word for word',
      'next: pnpm kb:review to approve, edit or reject each draft; nothing pending is ever said',
    ]);
    expect(readFileSync(join(dir, 'kb', 'pending', 'card-renewal-junior-2.yaml'), 'utf8')).toContain('applies:\n  card: junior\n');
    expect(drafter.requests[0]!.source.sections).toHaveProperty('2.2');
  });

  it('refuses to run in CI, and says what is wrong with a command line or a source', async () => {
    const { dir } = libraryKb();
    const err: string[] = [];
    const io: Io = { out: () => undefined, err: (l) => err.push(l), cwd: dir, today: () => TODAY, env: { CI: 'true' } };
    expect(await main(['kb:draft'], io)).toBe(1);
    expect(err).toEqual(['kb:draft: it does not run in CI: drafting asks a model with your own key, on your machine, and a person reviews every draft']);
    err.length = 0;
    const fake: Io = { ...io, env: {}, drafter: () => new FakeDrafter([]) };
    expect(await main(['kb:draft', '--source', 'patron-guid'], fake)).toBe(1);
    expect(err).toEqual(['kb:draft: "patron-guid" is not a source document in kb/sources (it has fee-schedule-2025, patron-guide)']);
    expect(await main(['kb:draft', '--source'], fake)).toBe(2);
    expect(await main(['kb:draft', '--bogus'], fake)).toBe(2);
    expect(await main(['kb:draft', 'a', 'b'], fake)).toBe(2);
  });

  it('a draft that proposes a topic already proposed adds nothing to kb/pending/topics.yaml', async () => {
    const { dir } = libraryKb();
    mkdirSync(join(dir, 'kb', 'pending'), { recursive: true });
    writeFileSync(join(dir, 'kb', 'pending', 'topics.yaml'), 'room_hire:\n  title: Room hire\n');
    const drafter = new FakeDrafter([{ section: '1.1', topic: { id: 'room_hire', title: 'Hiring a room' }, answer: 'Rooms open with the branches, at 9 on weekdays.', excerpt: 'All branches are open Monday to Friday from 9 a.m.' }]);
    const io: Io = { out: () => undefined, err: () => undefined, cwd: dir, today: () => TODAY, drafter: () => drafter };
    expect(await main(['kb:draft', '--all'], io)).toBe(0);
    expect(readFileSync(join(dir, 'kb', 'pending', 'topics.yaml'), 'utf8')).toBe('room_hire:\n  title: Room hire\n');
    expect(readFileSync(join(dir, 'kb', 'pending', 'room-hire.yaml'), 'utf8')).toContain('topic: room_hire\n');
  });
});

describe('the Claude drafter', () => {
  const request: DraftRequest = {
    source: { id: 'patron-guide', document: 'Example Town Library Patron Guide', sections: { 'meeting-rooms': { heading: 'Meeting rooms', text: 'Meeting rooms can be booked up to sixty days ahead at no charge by any card holder.' } } },
    existingTopics: [{ id: 'opening_hours', title: 'Opening hours', keywords: ['open'], asks: [] }],
    locale: 'en-US',
    maxAnswerChars: 400,
    applies: { card: ['adult', 'junior'] },
    topicHints: ['rooms'],
  };
  /** A fetch that records its request and answers as the Messages API would. */
  const mockFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, calls };
  };
  const PLACEHOLDER = 'placeholder-not-a-key';

  it('sends one Messages API request with the system prompt, the section, and the response schema, and reads the drafts back', async () => {
    const answer = {
      drafts: [
        { section: 'meeting-rooms', topic: 'meeting_rooms', newTopic: { title: 'Meeting rooms', keywords: ['meeting room'], asks: ['Can I book a room?'] }, answer: 'Any card holder can book a meeting room for free.', excerpt: 'Meeting rooms can be booked up to sixty days ahead at no charge by any card holder.', applies: [], effectiveFrom: null, effectiveTo: null },
        { section: 'meeting-rooms', topic: 'opening_hours', newTopic: null, answer: 'Rooms for adults.', excerpt: 'Meeting rooms', applies: [{ fact: 'card', values: ['adult'] }], effectiveFrom: '2026-01-01', effectiveTo: null },
      ],
    };
    const mock = mockFetch(200, { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] });
    const drafter = new ClaudeDrafter({ fetch: mock.fetch, apiKey: () => PLACEHOLDER });
    expect(drafter.id).toBe(`kb:draft claude ${DEFAULT_DRAFT_MODEL}`);
    expect(DEFAULT_DRAFT_MODEL).toBe('claude-haiku-4-5');
    const drafts = await drafter.draft(request);
    expect(mock.calls.length).toBe(1);
    const { url, init } = mock.calls[0]!;
    expect(url).toBe(MESSAGES_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': PLACEHOLDER, 'anthropic-version': '2023-06-01' });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages', 'output_config']);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: RESPONSE_SCHEMA } });
    const content = (body.messages as { role: string; content: string }[])[0]!;
    expect(content.role).toBe('user');
    expect(content.content).toContain('Longest answer: 400 characters');
    expect(content.content).toContain('- opening_hours: Opening hours (keywords: open)');
    expect(content.content).toContain('- card: adult, junior');
    expect(content.content).toContain('The author asks for drafts about: rooms');
    expect(content.content).toContain('<section id="meeting-rooms">\nMeeting rooms\nMeeting rooms can be booked up to sixty days ahead at no charge by any card holder.\n</section>');
    expect(drafts).toEqual([
      { topic: { id: 'meeting_rooms', title: 'Meeting rooms', keywords: ['meeting room'], asks: ['Can I book a room?'] }, answer: 'Any card holder can book a meeting room for free.', excerpt: 'Meeting rooms can be booked up to sixty days ahead at no charge by any card holder.', section: 'meeting-rooms' },
      { topic: 'opening_hours', answer: 'Rooms for adults.', excerpt: 'Meeting rooms', section: 'meeting-rooms', applies: { card: 'adult' }, effective: { from: '2026-01-01' } },
    ]);
    // The prompt asks for what the checks hold a draft to.
    for (const rule of ['one or two short spoken sentences', 'Say only what the document says', 'Never use variables', 'character for character']) expect(SYSTEM_PROMPT).toContain(rule);
    // Every object of the schema is closed, as structured outputs require.
    const closed = (s: unknown): boolean => {
      if (s === null || typeof s !== 'object') return true;
      const o = s as Record<string, unknown>;
      if (o.type === 'object' && o.additionalProperties !== false) return false;
      return Object.values(o).every(closed);
    };
    expect(closed(RESPONSE_SCHEMA)).toBe(true);
  });

  it('needs a key, says what the API answered without the key, and sends a long document in parts', async () => {
    const none = new ClaudeDrafter({ fetch: mockFetch(200, {}).fetch, apiKey: () => undefined });
    await expect(none.draft(request)).rejects.toThrow('ANTHROPIC_API_KEY is not set: put your own key in the environment (or in .env where you run the command)');
    const refused = new ClaudeDrafter({ fetch: mockFetch(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${PLACEHOLDER}` } }).fetch, apiKey: () => PLACEHOLDER });
    await expect(refused.draft(request)).rejects.toThrow('the Messages API answered 401: invalid x-api-key [key]');
    const cut = new ClaudeDrafter({ fetch: mockFetch(200, { stop_reason: 'max_tokens', content: [] }).fetch, apiKey: () => PLACEHOLDER, model: 'claude-sonnet-5-5' });
    await expect(cut.draft(request)).rejects.toThrow('cut off');
    expect(cut.id).toBe('kb:draft claude claude-sonnet-5-5');
    expect(() => draftsOfResponse({ nothing: true })).toThrow('the model\'s answer has no list of drafts');
    const long = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { text: 'word '.repeat(2000) }]));
    expect(partsOf(long)).toEqual([['s0', 's1'], ['s2', 's3'], ['s4']]);
  });
});

// The one real call: only on an author's machine, with their key and DIALOGWRIGHT_LIVE_DRAFT=1.
describe.skipIf(!(process.env.ANTHROPIC_API_KEY && process.env.DIALOGWRIGHT_LIVE_DRAFT === '1'))('the Claude drafter, live', () => {
  it('drafts from a section, every draft quoting it', async () => {
    const { kb } = libraryKb();
    const source = kb.sources['patron-guide']!;
    const drafts = await new ClaudeDrafter().draft({ source, existingTopics: Object.values(kb.topics), locale: 'en-US', maxAnswerChars: 400, applies: kb.settings.applies, topicHints: [] });
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(draftProblems(d, { kb: { ...kb, passages: {} }, document: 'patron-guide', proposed: {}, pendingAnswers: new Map() }).filter((p) => p.includes('excerpt'))).toEqual([]);
  }, 120_000);
});

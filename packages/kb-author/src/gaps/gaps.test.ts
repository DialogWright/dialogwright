import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanScratch } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendJunk, appOf, cleanGaps, runCalls, SAYS_CARD, scratchApp, scratchDir, type CallScript } from '../__fixtures__/gapCalls';
import { main, type Io } from '../cli';
import { findKb, loadKb, type KbPlace } from '../kbPlace';
import { approve } from '../review/actions';
import { startReviewServer, type ReviewServer } from '../review/server';
import { collectGaps, looksLikeQuestion, topicQuestionOf, type CollectContext } from './collect';
import { buildReport, codeSpan, formatJson, formatMarkdown, reportFromFiles, type GapReport } from './report';
import { defaultTraceSpecs, readTurns, traceFilesOf, turnOf } from './traces';

/**
 * kb:gaps on real trace records: scripted calls to a scratch copy of the library's knowledge base app,
 * run through runTurn with a scripted model client and the engine's trace writer (../__fixtures__/
 * gapCalls.ts), so every shape the collector reads (the retrieval record, the topic question and the
 * model's answer, the knowledge record, the gate events, the masked slots) is the engine's own.
 */

afterAll(() => {
  cleanGaps();
  cleanScratch();
});

const ASKS = { intent: 'ask_library' };
const SAYS = (topic: string, p = 0.92): Record<string, number> => ({ [topic]: p, none: 1 - p });

/** Eleven calls with one gap each (and four turns that are not gaps): see the expectations below. */
const SCRIPTS: CallScript[] = [
  // answered none, twice and then below the fill threshold: late fees
  { id: 'C01', day: '2026-10-01', steps: [{ ...ASKS, say: 'how much is the late fee', nominates: ['late_fees'], topic: { none: 0.9, late_fees: 0.1 } }] },
  { id: 'C02', day: '2026-10-02', steps: [{ ...ASKS, say: 'what do I owe for an overdue book', nominates: ['late_fees'], topic: { none: 0.85, late_fees: 0.15 } }] },
  { id: 'C03', day: '2026-10-02', steps: [{ ...ASKS, say: 'is there a fine for returning a book late', nominates: ['late_fees'], topic: { late_fees: 0.45, none: 0.35 } }] },
  // nothing nominated: words that are questions, and one that is not
  {
    id: 'C04',
    day: '2026-10-02',
    steps: [
      { intent: 'other', say: 'do you have meeting rooms?', nominates: [] },
      { say: 'thanks, bye', nominates: [] },
    ],
  },
  { id: 'C05', day: '2026-10-03', steps: [{ intent: 'other', say: 'when can I get a new card?', nominates: [] }] },
  // a card number said with the question (and the library's check of it): the trace masks it, so these words are never shown
  { id: 'C06', day: '2026-10-03', steps: [{ intent: 'check_loans', say: 'is my card five five five two zero four one seven still valid?', nominates: [], answers: SAYS_CARD }] },
  // the passage is withheld (its source changed), not in force, not translated, no facts about the caller
  { id: 'C07', day: '2026-10-01', steps: [{ ...ASKS, say: 'tell me the late fee', nominates: ['late_fees'], topic: SAYS('late_fees') }] },
  { id: 'C08', day: '2026-10-01', today: '2024-06-01', steps: [{ ...ASKS, say: 'how do I renew my card', nominates: ['card_renewal'], topic: SAYS('card_renewal') }] },
  { id: 'C09', day: '2026-10-02', locale: 'es', steps: [{ ...ASKS, say: 'cuánto cuesta una multa', nominates: ['late_fees'], topic: SAYS('late_fees') }] },
  { id: 'C10', day: '2026-10-03', noCard: true, steps: [{ ...ASKS, say: 'when are you open', nominates: ['opening_hours'], topic: SAYS('opening_hours') }] },
  // the slot asks which of two topics was meant
  { id: 'C11', day: '2026-10-01', steps: [{ ...ASKS, say: 'my card thing', nominates: ['late_fees', 'card_renewal'], topic: { late_fees: 0.5, card_renewal: 0.45, none: 0.05 } }] },
  // not gaps: retrieval failed; a question answered from an approved passage
  { id: 'C12', day: '2026-10-03', steps: [{ intent: 'other', say: 'what is the meaning of life?', explode: true }] },
  { id: 'C13', day: '2026-10-03', steps: [{ ...ASKS, say: 'what are your opening hours', nominates: ['opening_hours'], topic: SAYS('opening_hours') }] },
];

let dir: string;
let place: KbPlace;
let traces: string;
let files: string[];
let kb: NonNullable<ReturnType<typeof loadKb>['kb']>;

beforeAll(async () => {
  dir = scratchApp('kb-gaps-library', { stale: true });
  traces = join(scratchDir(), 'traces');
  mkdirSync(traces, { recursive: true });
  const found = findKb(dir, 'app');
  if (typeof found === 'string') throw new Error(found);
  place = found;
  kb = loadKb(place).kb!;
  files = await runCalls(appOf(dir, SCRIPTS), SCRIPTS, traces);
});

const report = (o: { since?: string; samples?: number } = {}): GapReport => reportFromFiles({ kb, place, label: 'app', traces: [traces], cwd: dir, ...o }).report;

describe('reading traces', () => {
  it('finds the files a path, a folder or a glob names, never the frame logs, each once', () => {
    writeFileSync(join(traces, 'C01.frames.jsonl'), '{}\n');
    expect(traceFilesOf([traces], dir)).toEqual(files);
    expect(traceFilesOf([join(traces, 'C0*.jsonl')], dir)).toEqual(files.slice(0, 9));
    expect(traceFilesOf([join(traces, 'C0*.jsonl'), traces, files[0]!], dir)).toEqual(files);
    expect(traceFilesOf([join(traces, 'C1?.jsonl')], dir).map((f) => f.slice(-10))).toEqual(['/C10.jsonl', '/C11.jsonl', '/C12.jsonl', '/C13.jsonl']);
    expect(traceFilesOf([join(traces, '..', '**', '*.jsonl')], dir)).toEqual(files);
    expect(traceFilesOf(['nothing-here/*.jsonl', 'nowhere.jsonl'], dir)).toEqual([]);
  });

  it('says where the traces are by default: TRACE_DIR, else the app folder, else where it is run', () => {
    expect(defaultTraceSpecs({ cwd: '/w', appDir: '/w/app', env: { TRACE_DIR: 'runs' } })).toEqual(['/w/runs']);
    expect(defaultTraceSpecs({ cwd: '/w', appDir: '/w/app', env: {} })).toEqual(['/w/app/traces', '/w/traces']);
    expect(defaultTraceSpecs({ cwd: '/w/app', appDir: '/w/app', env: {} })).toEqual(['/w/app/traces']);
    expect(defaultTraceSpecs({ cwd: '/w', appDir: null, env: {} })).toEqual(['/w/traces']);
  });

  it('reads a record as the fields a gap needs, and passes over lines that are not v2 records', () => {
    const copy = join(scratchDir(), 'one.jsonl');
    writeFileSync(copy, readFileSync(files[0]!, 'utf8'));
    appendJunk(copy, 'not json');
    appendJunk(copy, JSON.stringify({ v: 1, sessionId: 'x', turnIndex: 1, ts: '2026-10-01T00:00:00.000Z' }));
    appendJunk(copy, '[1,2]');
    const { turns, skipped } = readTurns(copy);
    expect(skipped).toBe(3);
    expect(turns.map((t) => [t.sessionId, t.turnIndex])).toEqual([['C01', 1], ['C01', 2]]);
    const asked = turns[1]!;
    expect(asked.words).toBe('how much is the late fee');
    expect(asked.retrieval).toEqual({ nominated: ['late_fees'], failed: null });
    expect(topicQuestionOf(asked)).toEqual({ id: 'libraryTopicTopic', nominated: ['late_fees'] });
    expect(asked.answers.libraryTopicTopic).toMatchObject({ choice: 'none' });
    expect(turnOf({ v: 2 }, 'f', 1)).toBeNull();
  });
});

describe('what counts as a gap', () => {
  const none: CollectContext = { topicSlots: new Set(), informational: new Set(), nearest: () => null };
  const all = (): ReturnType<typeof collectGaps> => collectGaps(files.flatMap((f) => readTurns(f).turns), none);

  it('finds each kind on the engine\'s own records, one gap to a turn, and counts what it does not group', () => {
    const { gaps, stats } = all();
    const summary = gaps.map((g) => [g.sessionId, g.kind, g.reason ?? '', g.topic ?? '~'].join(' '));
    expect(summary.sort()).toEqual([
      'C01 none  late_fees',
      'C02 none  late_fees',
      'C03 none  late_fees',
      'C04 unmatched  ~',
      'C05 unmatched  ~',
      'C06 unmatched  ~',
      'C07 unavailable stale late_fees',
      'C08 unavailable not-in-force card_renewal',
      'C09 unavailable no-translation late_fees',
      'C10 unavailable no-facts opening_hours',
      'C11 close  late_fees',
    ]);
    // C12's retrieval failed (nothing nominated because it threw): counted, never a gap. C13 was answered.
    expect(stats).toMatchObject({ turns: 27, sessions: 13, retrievalFailed: 1, withheld: 1, skipped: 0, from: '2026-10-01', to: '2026-10-03' });
  });

  it('answered none and below the fill threshold are both the topic question not answered', () => {
    const { gaps } = all();
    const c01 = gaps.find((g) => g.sessionId === 'C01')!;
    expect(c01).toMatchObject({ kind: 'none', near: 'nominated', nominated: ['late_fees'], words: 'how much is the late fee' });
    expect(gaps.find((g) => g.sessionId === 'C03')).toMatchObject({ kind: 'none', words: 'is there a fine for returning a book late' });
  });

  it('a close disambiguation is grouped by the topic ahead and names the other', () => {
    expect(all().gaps.find((g) => g.kind === 'close')).toMatchObject({ topic: 'late_fees', other: 'card_renewal', words: 'my card thing' });
  });

  it('an unavailable resolution names the passage when it was withheld, and the locale when there was no translation', () => {
    const { gaps } = all();
    expect(gaps.find((g) => g.reason === 'stale')).toMatchObject({ passage: { id: 'late-fees-adult', section: '3.1' }, words: 'tell me the late fee' });
    expect(gaps.find((g) => g.reason === 'no-translation')).toMatchObject({ locale: 'es', topic: 'late_fees' });
    expect(gaps.find((g) => g.reason === 'not-in-force')!.passage).toBeUndefined();
  });

  it('words with nothing nominated are a gap only when they look like a question (or the intent was other)', () => {
    expect(['when are you open?', 'What are the hours', 'how do I renew', '¿cuándo abren?', 'could I book a room', 'qué horario tienen'].map(looksLikeQuestion)).toEqual([true, true, true, true, true, true]);
    expect(['thanks, bye', 'yes please', 'my name is Sam', '', 'renew card'].map(looksLikeQuestion)).toEqual([false, false, false, false, false]);
    // "thanks, bye" (C04's second turn) is nothing nominated, and no question: not a gap.
    expect(all().gaps.filter((g) => g.sessionId === 'C04').map((g) => g.words)).toEqual(['do you have meeting rooms?']);
  });

  it('a turn answered from an approved passage, and a quarantined turn, are not gaps', () => {
    expect(all().gaps.some((g) => g.sessionId === 'C13')).toBe(false);
    const turns = files.flatMap((f) => readTurns(f).turns).map((t) => ({ ...t, quarantined: true }));
    expect(collectGaps(turns, none).gaps).toEqual([]);
  });

  it('leaves out a turn where the call went on to ask another slot, or where the caller was answering a code or a yes or no', () => {
    const turns = files.flatMap((f) => readTurns(f).turns);
    const asked = turns.find((t) => t.sessionId === 'C01' && t.turnIndex === 2)!;
    expect(collectGaps([asked], none).gaps).toHaveLength(1);
    expect(collectGaps([{ ...asked, promptedFor: 'book' }], none).gaps).toEqual([]);
    expect(collectGaps([{ ...asked, promptedFor: 'intent' }], none).gaps).toHaveLength(1);
    // the app's own topic slot id is known from its slots.yaml: a re-ask of it is not "moved on"
    expect(collectGaps([{ ...asked, promptedFor: 'book' }], { ...none, topicSlots: new Set(['book']) }).gaps).toHaveLength(1);
    const unmatched = turns.find((t) => t.sessionId === 'C04' && t.turnIndex === 2)!;
    const before = { ...unmatched, sessionId: 'X', turnIndex: 1, words: null, retrieval: null, promptedFor: 'confirm' };
    const same = { ...unmatched, sessionId: 'X' };
    expect(collectGaps([same], none).gaps).toHaveLength(1);
    expect(collectGaps([before, same], none).gaps).toEqual([]);
    expect(collectGaps([{ ...before, promptedFor: 'otp' }, same], none).gaps).toEqual([]);
    // a turn that answers another slot's question, when the app's topic slots are known
    expect(collectGaps([{ ...before, promptedFor: 'book' }, same], { ...none, topicSlots: new Set(['libraryTopic']) }).gaps).toEqual([]);
    expect(collectGaps([{ ...before, promptedFor: 'book' }, same], none).gaps).toHaveLength(1);
  });

  it('counts an informational intent\'s words with nothing nominated, though they are no question', () => {
    const turn = { ...files.flatMap((f) => readTurns(f).turns).find((t) => t.sessionId === 'C04' && t.turnIndex === 3)!, intent: 'hours' };
    expect(turn.words).toBe('thanks, bye');
    expect(collectGaps([turn], none).gaps).toEqual([]);
    expect(collectGaps([turn], { ...none, informational: new Set(['hours']) }).gaps).toHaveLength(1);
  });

  it('withholds the words when an identity slot takes a masked value on the turn, but not when it only still holds the one from before', () => {
    const turns = files.flatMap((f) => readTurns(f).turns);
    const turn = { ...turns.find((t) => t.sessionId === 'C04' && t.turnIndex === 2)!, masked: ['card'], slotValues: { card: '...1234' } };
    const before = { ...turn, turnIndex: 1, words: null, retrieval: null, promptedFor: 'intent' };
    expect(collectGaps([turn], none).gaps[0]!.words).toBeNull();
    expect(collectGaps([before, turn], none).gaps[0]!.words).toBe('do you have meeting rooms?');
    expect(collectGaps([{ ...before, slotValues: { card: '...9999' } }, turn], none).gaps[0]!.words).toBeNull();
  });

  it('the words of a turn that took a masked value are withheld, never read', () => {
    const c06 = all().gaps.find((g) => g.sessionId === 'C06')!;
    expect(c06.words).toBeNull();
  });
});

describe('grouping and ranking', () => {
  it('groups by nearest topic and ranks by count, then recency', () => {
    const r = report();
    expect(r.gaps).toBe(11);
    expect(r.byKind).toEqual({ none: 3, unmatched: 3, unavailable: 4, close: 1 });
    expect(r.groups.map((g) => [g.key, g.count])).toEqual([
      ['late_fees', 6],
      ['card_renewal', 3],
      // one each: the later one first
      ['opening_hours', 1],
      ['~', 1],
    ]);
    const [lateFees, cardRenewal, , noNear] = r.groups;
    expect(lateFees).toMatchObject({ topic: 'late_fees', title: 'Late fees', known: true, near: 'nominated', kinds: { none: 3, unavailable: 2, close: 1 }, reasons: { stale: 1, 'no-translation': 1 } });
    // the card words nothing nominated, and the keyword retriever's best match on them is the card topic
    expect(cardRenewal).toMatchObject({ topic: 'card_renewal', near: 'passage', kinds: { unmatched: 2, unavailable: 1 }, reasons: { 'not-in-force': 1 }, withheld: 1 });
    expect(noNear).toMatchObject({ topic: null, title: null, near: 'none', kinds: { unmatched: 1 } });
  });

  it('shows up to N distinct samples of the callers\' words, newest first, and never a withheld turn\'s', () => {
    const r = report({ samples: 2 });
    expect(r.groups[0]!.samples.map((s) => [s.words, s.kind, s.ts.slice(0, 10)])).toEqual([
      ['what do I owe for an overdue book', 'none', '2026-10-02'],
      ['is there a fine for returning a book late', 'none', '2026-10-02'],
    ]);
    expect(report({ samples: 0 }).groups.every((g) => g.samples.length === 0)).toBe(true);
    const card = report().groups.find((g) => g.key === 'card_renewal')!;
    expect(card.samples.map((s) => s.words)).toEqual(['when can I get a new card?', 'how do I renew my card']);
    expect(card.withheld).toBe(1);
  });

  it('keeps only turns since a day', () => {
    const r = report({ since: '2026-10-03' });
    expect(r.since).toBe('2026-10-03');
    expect(r.gaps).toBe(3);
    expect(r.groups.map((g) => [g.key, g.count])).toEqual([['card_renewal', 2], ['opening_hours', 1]]);
    expect(r.traces).toMatchObject({ turns: 10, from: '2026-10-03', to: '2026-10-03' });
  });

  it('is the same report each time it is made', () => {
    expect(report()).toEqual(report());
  });
});

describe('the fix for each kind', () => {
  const group = (key: string) => report().groups.find((g) => g.key === key)!;

  it('names the fix of each kind: add keywords, write a passage, re-approve, add a translation, tell topics apart', () => {
    const fixes = group('late_fees').fixes.map((f) => [f.id, f.kind, f.passage ?? f.locale ?? (f.topics ?? []).join(',')].join(' '));
    expect(fixes).toContain('add-keywords none late_fees');
    expect(fixes).toContain('re-approve unavailable late-fees-adult');
    expect(fixes).toContain('add-translation unavailable es');
    expect(fixes).toContain('add-keywords close late_fees,card_renewal');
    // the passage is withheld because its source changed: the fix points at the review page
    expect(group('late_fees').fixes.find((f) => f.id === 're-approve')!.text).toContain('Re-approve passage "late-fees-adult"');
    expect(group('card_renewal').fixes.map((f) => f.id)).toEqual(expect.arrayContaining(['add-keywords', 'write-passage']));
    expect(group('opening_hours').fixes.map((f) => f.id)).toEqual(['check-facts']);
    expect(group('~').fixes.map((f) => f.id)).toContain('write-passage');
  });

  it('lists the sections nothing cites that read as relevant, by the keyword retriever, and the command to draft from them', () => {
    const none = group('~');
    expect(none.draftFrom.map((d) => [d.document, d.section, d.heading])).toEqual([['patron-guide', '4.1', 'Meeting rooms']]);
    const fix = none.fixes.find((f) => f.id === 'draft-from-section')!;
    expect(fix.text).toContain('pnpm kb:draft --source patron-guide');
    // a section that shares one word ("card", "book") with a long question is not relevant to it
    for (const key of ['late_fees', 'card_renewal', 'opening_hours']) expect(group(key).draftFrom).toEqual([]);
    expect(group('late_fees').fixes.map((f) => f.id)).not.toContain('draft-from-section');
  });
});

describe('redaction', () => {
  it('prints the recorded words as they are, and never the words of a turn that took a masked value', () => {
    const traceText = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    // The trace carries the caller's words as spoken, and the card masked (its last four) where it records a call or a slot.
    expect(traceText).toContain('five five five two zero four one seven');
    expect(traceText).toContain('...0417');
    const r = report({ samples: 50 });
    for (const text of [formatMarkdown(r).join('\n'), formatJson(r)]) {
      expect(text).not.toContain('five five five two');
      expect(text).not.toContain('55520417');
      expect(text).not.toContain('0417');
      expect(text).toContain('when can I get a new card?');
    }
    expect(formatMarkdown(r).join('\n')).toContain('1 turn not shown: the caller gave a value the trace masks on it.');
  });

  it('a spoken question is shown as a code span, whatever it holds', () => {
    expect(codeSpan('how much is the fee?')).toBe('`how much is the fee?`');
    expect(codeSpan('use `back`\ntick')).toBe('``use `back` tick``');
    expect(codeSpan('`x`')).toBe('`` `x` ``');
  });
});

describe('the Markdown and JSON reports', () => {
  it('ranks the groups in Markdown, with samples, the fix for each kind and the sections to draft from', () => {
    const lines = formatMarkdown(report());
    expect(lines.slice(0, 7)).toEqual([
      '# Knowledge gaps',
      '',
      'app: 11 gaps in 4 groups, from 27 turns in 13 calls (13 trace files, 2026-10-01 to 2026-10-03).',
      '',
      'By kind: 3 answered none, 3 asked with no topic nominated, 4 unavailable, 1 close call.',
      '',
      '1 turn nominated nothing because retrieval failed (an error, an invalid answer or too late): not counted as gaps; see the traces\' retrieval.failed.',
    ]);
    const text = lines.join('\n');
    expect(text).toContain('## 1. Late fees (late_fees): 6 gaps');
    expect(text).toContain('3 answered none, 2 unavailable (stale 1, no translation 1), 1 close call. Latest 2026-10-02.');
    expect(text).toContain('- `is there a fine for returning a book late` (answered none, 2026-10-02)');
    expect(text).toContain('- Re-approve passage "late-fees-adult": its source section changed');
    expect(text).toContain('## 4. No near topic: 1 gap');
    expect(text).toContain('- patron-guide / 4.1 (Meeting rooms)');
    expect(text.indexOf('## 1. ')).toBeLessThan(text.indexOf('## 2. '));
  });

  it('says so when there is nothing to rank', () => {
    const r = reportFromFiles({ kb, place, label: 'app', traces: [join(traces, 'C13.jsonl')], cwd: dir }).report;
    expect(formatMarkdown(r).slice(-1)[0]).toBe('No gaps: every question the callers asked was answered from the knowledge base, or was not a question for it.');
    const empty = buildReport({ kb, place, label: 'app', turns: [] });
    expect(formatMarkdown(empty).slice(-1)[0]).toBe('No turns were read: nothing to rank.');
  });

  it('is JSON for tools: the same report, parsed back', () => {
    const r = report();
    expect(JSON.parse(formatJson(r))).toEqual(JSON.parse(JSON.stringify(r)));
    expect(JSON.parse(formatJson(r)).groups[0]).toMatchObject({ key: 'late_fees', count: 6, fixes: expect.any(Array), samples: expect.any(Array) });
  });
});

describe('kb:gaps, the command', () => {
  const run = async (args: readonly string[], cwd = dir, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(...l.split('\n')), cwd, today: () => '2026-10-03', env };
    return { code: await main(['kb:gaps', ...args], io), out, err };
  };

  it('prints the Markdown report to stdout, reading --traces', async () => {
    const r = await run(['--traces', traces]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toContain('# Knowledge gaps');
    expect(r.out[0]).toContain('## 1. Late fees (late_fees): 6 gaps');
    // the same run with a relative glob, and the folder named by the app folder default
    expect((await run(['--traces', `${traces}/C0*.jsonl`, '--since', '2026-10-02'])).out[0]).toContain('gaps in');
  });

  it('prints JSON with --json, and writes a file with --out', async () => {
    const json = await run(['--traces', traces, '--json']);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ gaps: 11, byKind: { none: 3 } });
    const out = join(scratchDir(), 'gaps.md');
    const wrote = await run(['--traces', traces, '--out', out]);
    expect(wrote.out).toEqual([`kb:gaps: wrote ${out}: 11 gaps in 4 groups`]);
    expect(readFileSync(out, 'utf8')).toContain('## 2. Renewing a library card (card_renewal): 3 gaps');
    const jsonFile = join(scratchDir(), 'gaps.json');
    await run(['--traces', traces, '--json', '--out', jsonFile]);
    expect(JSON.parse(readFileSync(jsonFile, 'utf8')).groups).toHaveLength(4);
  });

  it('reads the app folder\'s traces by default, and TRACE_DIR when it is set', async () => {
    const empty = await run([]);
    expect(empty.code).toBe(1);
    expect(empty.err[0]).toMatch(/^kb:gaps: no trace files found in .*traces.*: a server writes them to \$TRACE_DIR/);
    cpSync(traces, join(dir, 'traces'), { recursive: true });
    const fromApp = await run([]);
    expect(fromApp.code).toBe(0);
    expect(fromApp.out[0]).toContain('11 gaps');
    expect((await run([], scratchDir(), {})).code).toBe(1);
    expect((await run([dir], scratchDir(), { TRACE_DIR: traces })).out[0]).toContain('11 gaps');
  });

  it('refuses a command line it does not understand, a knowledge base that does not load, and no traces', async () => {
    const since = await run(['--since', 'yesterday', '--traces', traces]);
    expect(since.code).toBe(2);
    expect(since.err[0]).toBe('kb:gaps: --since must be a day written YYYY-MM-DD');
    expect((await run(['--since', '2026-02-30', '--traces', traces])).code).toBe(2);
    expect((await run(['--samples', '-1', '--traces', traces])).code).toBe(2);
    expect((await run(['--wat'])).code).toBe(2);
    expect((await run(['a', 'b'])).code).toBe(2);
    expect((await run(['--traces', 'nowhere/*.jsonl'])).code).toBe(1);
    const lost = await run(['somewhere-else', '--traces', traces]);
    expect(lost.code).toBe(1);
    expect(lost.err[0]).toMatch(/^kb:gaps: somewhere-else: neither an app folder/);
  });

  it('is named in the usage of an unknown command', async () => {
    const out: string[] = [];
    expect(await main(['kb:other'], { out: () => {}, err: (l) => out.push(l), cwd: dir })).toBe(2);
    expect(out[0]).toContain('kb:refresh and kb:gaps');
  });
});

describe('the review page\'s Gaps tab', () => {
  let server: ReviewServer;
  const TOKEN = 'gaps-token';
  const get = async (path: string, token: string | null = TOKEN): Promise<{ status: number; text: string }> => {
    const r = await fetch(`${server.origin}${path}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`, { redirect: 'manual' });
    return { status: r.status, text: await r.text() };
  };

  beforeAll(async () => {
    server = await startReviewServer({ place, today: () => '2026-10-03', token: TOKEN, traces: [traces], cwd: dir });
  });
  afterAll(async () => {
    await server.close();
  });

  it('needs the token like every page', async () => {
    expect((await get('/gaps', null)).status).toBe(403);
    expect((await get('/gaps', 'wrong')).status).toBe(403);
    expect((await get('/gaps/late_fees', null)).status).toBe(403);
    expect((await get('/gaps')).status).toBe(200);
  });

  it('lists the groups ranked, with the callers\' words and a link for each fix to where it is done', async () => {
    const { text } = await get('/gaps');
    expect(text).toContain('11 gaps in 4 groups');
    expect(text.indexOf('1. ')).toBeLessThan(text.indexOf('2. '));
    expect(text).toContain('Late fees (late_fees)');
    expect(text).toContain('<q>is there a fine for returning a book late</q>');
    // a stale passage links to its withheld page; a topic to its passages and drafts; "draft from" to the sections
    expect(text).toContain(`href="/passage/late-fees-adult?token=${TOKEN}"`);
    expect(text).toContain(`href="/topic/late_fees?token=${TOKEN}"`);
    expect(text).toContain(`href="/gaps/~?token=${TOKEN}"`);
    expect(text).toContain('draft from 1 section');
    // the withheld turn's words are not in the page
    expect(text).not.toContain('five five five');
    expect(text).toContain(`<a href="/gaps?token=${TOKEN}">Gaps</a>`);
  });

  it('opens the pages the links lead to', async () => {
    expect((await get('/passage/late-fees-adult')).text).toContain('its source section changed');
    const topic = await get('/topic/late_fees');
    expect(topic.status).toBe(200);
    expect(topic.text).toContain('Passages (3)');
    expect(topic.text).toContain(`href="/passage/late-fees-adult?token=${TOKEN}"`);
    const group = await get('/gaps/~');
    expect(group.status).toBe(200);
    expect(group.text).toContain('patron-guide / 4.1');
    expect(group.text).toContain('A meeting room may be booked for up to three hours');
    expect(group.text).toContain('pnpm kb:draft --source patron-guide');
    expect((await get('/gaps/not_a_topic')).status).toBe(404);
    expect((await get('/topic/not_a_topic')).status).toBe(404);
  });

  it('links a stale passage only while it is withheld: once approved again its page is gone, and so is the link', async () => {
    expect(approve(place, 'late-fees-adult', { by: 'Jane Smith', owner: 'Patron Services' }, '2026-10-03')).toMatchObject({ ok: true });
    const { text } = await get('/gaps');
    // The traces still record the withheld passage, so the fix is listed, now with nothing to open.
    expect(text).toContain('Re-approve passage &quot;late-fees-adult&quot;');
    expect(text).not.toContain('href="/passage/late-fees-adult');
    expect((await get('/passage/late-fees-adult')).status).toBe(404);
  });

  it('says where it looked when there are no traces, and why when the knowledge base does not load', async () => {
    const bare = await startReviewServer({ place, today: () => '2026-10-03', token: TOKEN, traces: [join(dir, 'no-traces')], cwd: dir });
    try {
      const r = await fetch(`${bare.origin}/gaps?token=${TOKEN}`);
      const text = await r.text();
      expect(text).toContain('No trace files found');
      expect(text).toContain('no-traces');
    } finally {
      await bare.close();
    }
    const none = await startReviewServer({ place, today: () => '2026-10-03', token: TOKEN });
    try {
      expect(await (await fetch(`${none.origin}/gaps?token=${TOKEN}`)).text()).toContain('No trace files found');
    } finally {
      await none.close();
    }
    expect(existsSync(dir)).toBe(true);
  });
});

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ToolDef } from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';
import { validateApp } from '../core/app/validate';
import { checkApp } from '../define/check';
import { defineApp, isAppDefinitionError, type AppCode } from '../define/defineApp';
import { defineKnowledge, knowledgeProblems } from '../define/defineKnowledge';
import { libraryApp, libraryCode, LIBRARY_DIR } from '../define/fixture/app';
import { loadAppFolder, loadKnowledgeFolder } from '../define/load';
import { formatProblem } from '../define/problems';
import { approvalHashOf, sourceHashOf } from './hash';
import { resolvePassage } from './resolve';
import { KeywordRetriever } from './keyword';
import { createHash } from 'node:crypto';
import { defaultRetriever } from './hybrid';
import { buildIndex } from './vectorIndex';
import { MODEL_DIR_ENV, POTION_BASE_8M } from './embed/model';
import type { Embedder } from './embed/types';
import type { KnowledgeBase, Retriever } from './types';
import { probeContexts } from '../core/app/probeQuestions';

/**
 * The knowledge base folder (kb/): Example Town Library's, a small fictional one in
 * ./__fixtures__/kb. Three topics (opening hours, renewing a card, late fees), an applies domain of
 * two card kinds, last year's late fees beside this year's, a Spanish translation of the opening
 * hours, and an account line for the late fees read through a gated tool. The tests copy the library
 * app's folder with this kb/ beside its YAML into a scratch folder, change what each case needs, and
 * check the problems word for word.
 */

const here = dirname(fileURLToPath(import.meta.url));
const KB_FIXTURE = join(here, '__fixtures__', 'kb');
const TODAY = '2026-10-03';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-kb-'));
  scratch.push(dir);
  return dir;
}

/** The library's policy.yaml with the two tools the knowledge base reads through. */
const POLICY_ADDITIONS = `  findPassage:
    level: 0
    rules: [identity]
  getFees:
    level: 0
    rules: [identity]
`;

/** The library's code with the two tools: findPassage (resolves a passage for the caller's card) and getFees (the account line's read). */
const TOOLS: Record<string, ToolDef> = {
  findPassage: { params: ['topic', 'card'], run: () => ({ value: null, summary: 'resolved' }) },
  getFees: { params: ['card'], fields: ['balance'], run: () => ({ value: { balance: '1 dollar' }, summary: 'fees read' }) },
};
const CODE: AppCode = { ...libraryCode, tools: { ...libraryCode.tools, ...TOOLS } };

type Edit = string | ((text: string) => string) | null;

/** A copy of the library's YAML with the knowledge base as kb/, and `edits` applied (a path from the app folder; null deletes). */
function appFolder(edits: Record<string, Edit> = {}): string {
  const dir = temp();
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), readFileSync(join(dir, 'policy.yaml'), 'utf8').replace('# How each value', `${POLICY_ADDITIONS}# How each value`).replace('  branch: keep\n', '  branch: keep\n  topic: keep\n'));
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(dir, file);
    if (edit === null) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof edit === 'string' ? edit : edit(readFileSync(path, 'utf8')));
  }
  return dir;
}

/** `pnpm check`'s lines for the folder, with the code, on TODAY. */
async function check(dir: string, code: AppCode = CODE, todayIso = TODAY): Promise<string[]> {
  return (await checkApp(dir, { code, todayIso })).map(formatProblem);
}

/** The lines `check` gives the folder for the files of kb/ only. */
async function kbLines(edits: Record<string, Edit>, code: AppCode = CODE, todayIso = TODAY): Promise<string[]> {
  return (await check(appFolder(edits), code, todayIso)).filter((line) => line.startsWith('kb') || line.includes('kb.yaml') || line.includes('kb/'));
}

/** The fixture's knowledge base, loaded on its own. */
function fixtureKb(dir = KB_FIXTURE): KnowledgeBase {
  const folder = loadKnowledgeFolder(dir, 'en-US');
  expect(folder.problems).toEqual([]);
  return folder.kb!;
}

/** A passage file's text with its approval taken off. */
const unapproved = (text: string): string => text.replace(/\napproval:[\s\S]*$/, '\n');

describe('the knowledge base folder: a valid one', () => {
  it('loads the topics, passages, sources and locales, every passage fresh', () => {
    const kb = fixtureKb();
    expect(kb.settings).toEqual({ action: 'findPassage', applies: { card: ['adult', 'junior'] }, localeFallback: 'none', maxAnswerChars: 400, retrieval: { cap: 8 } });
    expect(kb.defaultLocale).toBe('en-US');
    expect(Object.keys(kb.topics)).toEqual(['opening_hours', 'card_renewal', 'late_fees']);
    expect(kb.topics.late_fees).toEqual({
      id: 'late_fees',
      title: 'Late fees',
      keywords: ['late fee', 'overdue', 'fine'],
      asks: ['How much is the fee for a late book?'],
      risk: 'regulated',
      accountLine: { text: 'Your card has {balance} in late fees right now.', from: 'getFees' },
      locales: { es: { title: 'Multas por retraso', keywords: ['multa', 'retraso'], asks: [], accountLineText: 'Su tarjeta tiene {balance} en multas ahora mismo.' } },
    });
    expect(kb.topics.opening_hours!.risk).toBe('low');
    expect(Object.keys(kb.passages)).toEqual(['card-renewal-adult', 'card-renewal-junior', 'late-fees-adult', 'late-fees-adult-2025', 'late-fees-junior', 'opening-hours', 'opening-hours-es']);
    expect(Object.values(kb.passages).map((p) => p.freshness)).toEqual(Array(7).fill('fresh'));
    expect(kb.passages['opening-hours-es']).toMatchObject({ locale: 'es', translates: 'opening-hours', file: 'kb/locale/es/passages/opening-hours-es.yaml' });
    expect(kb.passages['late-fees-adult-2025']).toMatchObject({ applies: { card: ['adult'] }, effective: { from: '2025-01-01', to: '2025-12-31' }, source: { document: 'fee-schedule-2025', section: 'adult' } });
    expect(Object.keys(kb.sources)).toEqual(['fee-schedule-2025', 'patron-guide']);
    expect(kb.sources['patron-guide']!.document).toBe('Example Town Library Patron Guide');
  });

  it('passes check inside an app folder, and defineApp gives the App its knowledge', async () => {
    const dir = appFolder();
    expect(await check(dir)).toEqual([]);
    const app = defineApp(dir, CODE);
    expect(Object.keys(app.knowledge!.kb!.passages)).toHaveLength(7);
    // No retriever in the code, and no embedder in kb.yaml: the engine's default, keywords alone.
    expect(app.knowledge!.retriever).toBeInstanceOf(KeywordRetriever);
    expect(app.knowledge!.retriever!.id).toBe('keyword');
    expect(() => validateApp(app)).not.toThrow();
  });

  it('an app without kb/ is as it was: no knowledge, and the loader adds nothing', () => {
    expect(libraryApp.knowledge).toBeUndefined();
    expect('knowledge' in loadAppFolder(LIBRARY_DIR).config!).toBe(false);
  });

  it('a retriever in the code becomes App.knowledge.retriever', () => {
    const retriever = { id: 'fixed', nominate: () => [{ topic: 'opening_hours', title: 'Opening hours', score: 1, via: 'app' as const }] };
    const app = defineApp(appFolder(), { ...CODE, knowledge: { retriever } });
    expect(app.knowledge!.retriever).toBe(retriever);
  });
});

describe('the configuration hashes', () => {
  it('include every kb/ file read, each its own line; not the drafts in kb/pending, nor kb/.index', () => {
    const dir = appFolder({ 'kb/.index/topics.json': '{}', 'kb/pending/new-draft.yaml': 'id: new-draft\n' });
    const files = Object.keys(loadAppFolder(dir).config!.hashes.files).filter((f) => f.startsWith('kb/'));
    expect(files).toEqual([
      'kb/kb.yaml',
      'kb/locale/es/passages/opening-hours-es.yaml',
      'kb/locale/es/topics.yaml',
      'kb/passages/card-renewal-adult.yaml',
      'kb/passages/card-renewal-junior.yaml',
      'kb/passages/late-fees-adult-2025.yaml',
      'kb/passages/late-fees-adult.yaml',
      'kb/passages/late-fees-junior.yaml',
      'kb/passages/opening-hours.yaml',
      'kb/sources/fee-schedule-2025.yaml',
      'kb/sources/patron-guide.yaml',
      'kb/topics.yaml',
    ]);
  });

  it('change when a kb file changes, and only that file\'s line changes', () => {
    const before = loadAppFolder(appFolder()).config!.hashes;
    const after = loadAppFolder(appFolder({ 'kb/topics.yaml': (t) => t.replace('Opening hours', 'Hours') })).config!.hashes;
    expect(after.app).not.toBe(before.app);
    const changed = Object.keys(before.files).filter((f) => before.files[f] !== after.files[f]);
    expect(changed).toEqual(['kb/topics.yaml']);
  });
});

describe('the approval hashes', () => {
  it('are the documented SHA-256s: of the source text with whitespace collapsed, and of everything approved', () => {
    const p = fixtureKb().passages['late-fees-adult']!;
    expect(p.current.sourceHash).toBe(sourceHashOf('An adult card is charged 25 cents for each day an item is overdue,\n  up to 5 dollars for each item. '));
    expect(p.current.hash).toBe(
      approvalHashOf({
        id: 'late-fees-adult',
        locale: null,
        version: '2026.1',
        topic: 'late_fees',
        title: 'Late fees',
        localeTitle: null,
        answer: p.answer,
        applies: { card: 'adult' },
        effective: { from: '2026-01-01' },
        sourceText: 'An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.',
        accountLineText: 'Your card has {balance} in late fees right now.',
      }),
    );
  });

  it('are stable across formatting: flow or block style, a folded source, one value or a list of one, key order, comments', () => {
    const dir = appFolder({
      'kb/passages/late-fees-adult.yaml': (t) =>
        t
          .replace('applies: { card: adult }', '# for adult cards only\napplies:\n  card: [adult]')
          .replace('effective: { from: 2026-01-01 }', 'effective:\n  from: "2026-01-01"')
          .replace(/^answer: (.*)$/m, (_, a: string) => `answer: >\n  ${a.replace(', up to', ',\n  up to')}`),
      'kb/sources/patron-guide.yaml': (t) => t.replace('text: An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.', 'text: |\n      An adult card is charged 25 cents\n      for each day an item is overdue, up to 5 dollars for each item.'),
      'kb/topics.yaml': (t) => t.replace('  accountLine:\n    text: Your card has {balance} in late fees right now.\n    from: getFees', '  accountLine: { from: getFees, text: "Your card has {balance} in late fees right now." }'),
    });
    const kb = loadAppFolder(dir).config!.knowledge!;
    expect(kb.passages['late-fees-adult']!.current).toEqual(fixtureKb().passages['late-fees-adult']!.current);
    expect(kb.passages['late-fees-adult']!.freshness).toBe('fresh');
  });

  it('catch a changed source (stale) and an edit after approval, and a missing approval', () => {
    const kb = loadAppFolder(
      appFolder({
        'kb/sources/patron-guide.yaml': (t) => t.replace('up to 5 dollars for each item', 'up to 6 dollars for each item'),
        'kb/passages/card-renewal-adult.yaml': (t) => t.replace('three years', 'four years'),
        'kb/passages/opening-hours.yaml': unapproved,
      }),
    ).config!.knowledge!;
    expect(kb.passages['late-fees-adult']!.freshness).toBe('source-changed');
    expect(kb.passages['card-renewal-adult']!.freshness).toBe('edited');
    expect(kb.passages['opening-hours']!.freshness).toBe('unapproved');
    expect(kb.passages['late-fees-junior']!.freshness).toBe('fresh');
  });

  it('cover the applies, the dates, the topic and the account line, not only the answer', () => {
    const edited = (edits: Record<string, Edit>, id: string) => loadAppFolder(appFolder(edits)).config!.knowledge!.passages[id]!.freshness;
    expect(edited({ 'kb/passages/late-fees-adult-2025.yaml': (t) => t.replace('to: 2025-12-31', 'to: 2025-11-30') }, 'late-fees-adult-2025')).toBe('edited');
    expect(edited({ 'kb/topics.yaml': (t) => t.replace('in late fees right now', 'in late fees today') }, 'late-fees-adult')).toBe('edited');
    // A topic's other wording (keywords, example questions) is retrieval's, not what is said.
    expect(edited({ 'kb/locale/es/topics.yaml': (t) => t.replace('[horario, abierto, cerrado]', '[horario, abierto]') }, 'opening-hours-es')).toBe('fresh');
    expect(edited({ 'kb/topics.yaml': (t) => t.replace('[late fee, overdue, fine]', '[late fee, overdue]') }, 'late-fees-adult')).toBe('fresh');
  });

  it('cover the passage\'s id, locale and version, and its topic\'s title in its locale, which is spoken', () => {
    const freshness = (edits: Record<string, Edit>) => Object.fromEntries(Object.values(loadAppFolder(appFolder(edits)).config!.knowledge!.passages).map((p) => [p.id, p.freshness]));
    // The default title: every passage of the topic, in every locale (a locale that gives no title of its own says it).
    expect(freshness({ 'kb/topics.yaml': (t) => t.replace('title: Opening hours', 'title: Opening times') })).toMatchObject({ 'opening-hours': 'edited', 'opening-hours-es': 'edited', 'late-fees-adult': 'fresh', 'card-renewal-adult': 'fresh' });
    // A locale's own title: that locale's passages of the topic, and no other.
    expect(freshness({ 'kb/locale/es/topics.yaml': (t) => t.replace('Horario', 'Horas') })).toMatchObject({ 'opening-hours-es': 'edited', 'opening-hours': 'fresh' });
    expect(freshness({ 'kb/passages/opening-hours.yaml': (t) => t.replace('version: "2026.1"', 'version: "2026.2"') })).toMatchObject({ 'opening-hours': 'edited' });
  });
});

describe('an approval names its passage, and is in the log', () => {
  const OPENING = 'passages/opening-hours.yaml';
  const RENEWAL = 'passages/card-renewal-adult.yaml';

  it('a passage copied with its approval to another id, or another locale, is not fresh there', () => {
    const loaded = loadAppFolder(
      appFolder({
        // The same locale, another id (a year earlier, so the two do not overlap).
        [`kb/passages/late-fees-adult-2024.yaml`]: fixtureText('passages/late-fees-adult-2025.yaml').replace('id: late-fees-adult-2025', 'id: late-fees-adult-2024').replace('effective: { from: 2025-01-01, to: 2025-12-31 }', 'effective: { from: 2024-01-01, to: 2024-12-31 }'),
        // Another locale, under a new id: the copy a translator might start from.
        [`kb/locale/es/passages/card-renewal-adult-es.yaml`]: fixtureText(RENEWAL).replace('id: card-renewal-adult', 'id: card-renewal-adult-es'),
      }),
    );
    expect(loaded.problems).toEqual([]);
    const passages = loaded.config!.knowledge!.passages;
    expect(passages['late-fees-adult-2024']!.freshness).toBe('edited');
    expect(passages['card-renewal-adult-es']!.freshness).toBe('edited');
    expect(passages['card-renewal-adult']!.freshness).toBe('fresh');
  });

  it('an approval written by hand, with hashes that match, is refused by check: it has no line in the log', async () => {
    const dir = appFolder();
    // Edit a passage and drop its approval, then write an approval for it as kb:approve would, but by hand.
    const file = join(dir, 'kb', RENEWAL);
    writeFileSync(file, readFileSync(file, 'utf8').replace('There\'s no charge.', 'It\'s free.').replace(/approval:[\s\S]*$/, ''));
    const p = loadAppFolder(dir).config!.knowledge!.passages['card-renewal-adult']!;
    expect(p.freshness).toBe('unapproved');
    writeFileSync(file, `${readFileSync(file, 'utf8')}approval:\n  owner: Patron Services\n  approvedBy: Jane Smith\n  on: 2026-10-01\n  sourceHash: ${p.current.sourceHash}\n  hash: ${p.current.hash}\n`);
    expect(loadAppFolder(dir).config!.knowledge!.passages['card-renewal-adult']!.freshness).toBe('fresh');
    expect((await check(dir, CODE, TODAY)).filter((l) => l.startsWith('kb/'))).toEqual([
      'kb/passages/card-renewal-adult.yaml:9:1  approval  passage "card-renewal-adult" was approved outside kb:approve: its approval (by Jane Smith on 2026-10-01) has no line of its id and hash in kb/approvals.jsonl, so no one is on record for it  ->  review it against its source, then pnpm kb:approve card-renewal-adult --by "<your name>" (approvals are written by kb:approve, never by hand)',
    ]);
    // knowledgeProblems (an app that is not a folder) says the same.
    expect(knowledgeProblems(join(dir, 'kb'), { todayIso: TODAY }).map((q) => q.message)).toEqual([expect.stringContaining('passage "card-renewal-adult" was approved outside kb:approve')]);
    // A line of its id and hash is what makes it an approval on record; the last line for it stands.
    writeFileSync(join(dir, 'kb/approvals.jsonl'), `${readFileSync(join(dir, 'kb/approvals.jsonl'), 'utf8')}${JSON.stringify({ id: 'card-renewal-adult', version: '2026.1', approvedBy: 'Jane Smith', owner: 'Patron Services', on: '2026-10-01', sourceHash: p.current.sourceHash, hash: p.current.hash, from: 'passage' })}\n`);
    expect((await check(dir, CODE, TODAY)).filter((l) => l.startsWith('kb/'))).toEqual([]);
  });

  it('a log that cannot be read is a problem for check, not for the call', async () => {
    const dir = appFolder({ 'kb/approvals.jsonl': null });
    writeFileSync(join(dir, 'kb/approvals.jsonl'), Buffer.from([0xff, 0xfe, 0x7b, 0x0a]));
    expect(loadAppFolder(dir).config!.knowledge!.approvalLog).toMatchObject({ file: 'kb/approvals.jsonl', invalid: expect.any(String) });
    expect((await check(dir, CODE, TODAY)).filter((l) => l.startsWith('kb/approvals.jsonl'))).toEqual([expect.stringMatching(/^kb\/approvals\.jsonl:1:1  \(file\)  kb\/approvals\.jsonl cannot be read: /)]);
  });
});

describe('resolvePassage', () => {
  const kb = fixtureKb();
  const resolve = (topic: string, facts: Record<string, string>, todayIso = TODAY, locale?: string, base: KnowledgeBase = kb) => {
    const r = resolvePassage(base, { topic, facts, todayIso, ...(locale ? { locale } : {}) });
    return 'passage' in r && !('unavailable' in r) ? r.passage.id : `unavailable: ${r.unavailable}`;
  };

  it('finds the passage for the topic and the caller\'s facts', () => {
    expect(resolve('late_fees', { card: 'adult' })).toBe('late-fees-adult');
    expect(resolve('late_fees', { card: 'junior' })).toBe('late-fees-junior');
    expect(resolve('opening_hours', { card: 'junior' })).toBe('opening-hours');
    expect(resolvePassage(kb, { topic: 'late_fees', facts: { card: 'adult' }, todayIso: TODAY })).toEqual({ passage: kb.passages['late-fees-adult'], fresh: true });
  });

  it('a fact the caller lacks matches no passage that depends on it; one that depends on none answers anyone', () => {
    expect(resolve('late_fees', {})).toBe('unavailable: not-in-force');
    expect(resolve('late_fees', { card: 'senior' })).toBe('unavailable: not-in-force');
    expect(resolve('opening_hours', {})).toBe('opening-hours');
  });

  it('takes the effective dates as inclusive at both ends', () => {
    expect(resolve('late_fees', { card: 'adult' }, '2025-01-01')).toBe('late-fees-adult-2025');
    expect(resolve('late_fees', { card: 'adult' }, '2025-12-31')).toBe('late-fees-adult-2025');
    expect(resolve('late_fees', { card: 'adult' }, '2026-01-01')).toBe('late-fees-adult');
    expect(resolve('late_fees', { card: 'adult' }, '2024-12-31')).toBe('unavailable: not-in-force');
    expect(resolve('late_fees', { card: 'junior' }, '2025-06-01')).toBe('unavailable: not-in-force');
  });

  it('an unknown topic is unavailable', () => {
    expect(resolve('parking', { card: 'adult' })).toBe('unavailable: unknown-topic');
  });

  it('a locale: its own passage; none in it, with localeFallback none, is no-translation; with default, the default\'s', () => {
    expect(resolve('opening_hours', {}, TODAY, 'es')).toBe('opening-hours-es');
    expect(resolve('opening_hours', {}, TODAY, 'ES')).toBe('opening-hours-es');
    expect(resolve('late_fees', { card: 'adult' }, TODAY, 'es')).toBe('unavailable: no-translation');
    expect(resolve('late_fees', { card: 'adult' }, '2024-01-01', 'es')).toBe('unavailable: not-in-force');
    const fallback: KnowledgeBase = { ...kb, settings: { ...kb.settings, localeFallback: 'default' } };
    expect(resolve('late_fees', { card: 'adult' }, TODAY, 'es', fallback)).toBe('late-fees-adult');
    expect(resolve('opening_hours', {}, TODAY, 'es', fallback)).toBe('opening-hours-es');
    expect(resolve('opening_hours', {}, TODAY, 'en-US')).toBe('opening-hours');
  });

  it('withholds a passage that is not fresh: stale, with the passage', () => {
    const stale = loadAppFolder(appFolder({ 'kb/sources/patron-guide.yaml': (t) => t.replace('up to 5 dollars for each item', 'up to 6 dollars for each item') })).config!.knowledge!;
    const r = resolvePassage(stale, { topic: 'late_fees', facts: { card: 'adult' }, todayIso: TODAY });
    expect(r).toEqual({ unavailable: 'stale', passage: stale.passages['late-fees-adult'] });
    const unapprovedKb = loadAppFolder(appFolder({ 'kb/passages/late-fees-junior.yaml': unapproved })).config!.knowledge!;
    expect(resolve('late_fees', { card: 'junior' }, TODAY, undefined, unapprovedKb)).toBe('unavailable: stale');
    const edited = loadAppFolder(appFolder({ 'kb/passages/late-fees-junior.yaml': (t) => t.replace('no late fees', 'never late fees') })).config!.knowledge!;
    expect(resolve('late_fees', { card: 'junior' }, TODAY, undefined, edited)).toBe('unavailable: stale');
  });

  it('more than one passage in force for the caller is ambiguous (check refuses the overlap that causes it)', () => {
    const second = { ...kb.passages['late-fees-adult']!, id: 'late-fees-adult-copy' };
    const overlapping: KnowledgeBase = { ...kb, passages: { ...kb.passages, [second.id]: second } };
    expect(resolve('late_fees', { card: 'adult' }, TODAY, undefined, overlapping)).toBe('unavailable: ambiguous');
    expect(resolve('late_fees', { card: 'junior' }, TODAY, undefined, overlapping)).toBe('late-fees-junior');
  });
});

const P = 'kb/passages/';
const fixtureText = (file: string): string => readFileSync(join(KB_FIXTURE, file), 'utf8');

describe('check: what the knowledge base must be on its own (the loader refuses it, so defineApp does too)', () => {
  it('every passage answers a topic there is', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('topic: late_fees', 'topic: late_fee') })).toEqual([
      'kb/passages/late-fees-junior.yaml:3:8  topic  passage "late-fees-junior" answers the topic "late_fee", which kb/topics.yaml does not have  ->  rename it to "late_fees", or add "late_fee:" with its title to kb/topics.yaml',
    ]);
  });

  it('every passage cites a source document there is, and a section it has', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('document: patron-guide', 'document: patron-guid') })).toEqual([
      'kb/passages/late-fees-junior.yaml:7:21  source.document  passage "late-fees-junior" cites the source document "patron-guid", which is not in kb/sources  ->  rename it to "patron-guide", or add kb/sources/patron-guid.yaml with the document\'s text by section',
    ]);
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('section: "3.2"', 'section: "3.9"') })).toEqual([
      'kb/passages/late-fees-junior.yaml:7:44  source.section  passage "late-fees-junior" cites section "3.9" of "patron-guide", which kb/sources/patron-guide.yaml does not have  ->  rename it to "3.1", or add the section, with its text, to kb/sources/patron-guide.yaml',
    ]);
  });

  it('a passage applies by the facts and values of kb.yaml\'s domain', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('applies: { card: junior }', 'applies: { kard: junior }') })).toEqual([
      'kb/passages/late-fees-junior.yaml:5:18  applies.kard  passage "late-fees-junior" applies by "kard", which is not a fact of kb.yaml\'s applies  ->  rename it to "card", or add "kard: [<its values>]" to applies in kb/kb.yaml',
    ]);
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('applies: { card: junior }', 'applies: { card: [junior, senior] }') })).toEqual([
      'kb/passages/late-fees-junior.yaml:5:12  applies.card  passage "late-fees-junior" applies to card "senior", which kb.yaml\'s applies does not list for card  ->  rename it to "junior", or add "senior" to card in kb/kb.yaml',
    ]);
  });

  it('the applies domain stays small enough to cover', async () => {
    expect(await kbLines({ 'kb/kb.yaml': (t) => t.replace('  card: [adult, junior]', '  card: [adult, junior]\n  a: [a1, a2, a3, a4, a5, a6, a7]\n  b: [b1, b2, b3, b4, b5, b6, b7]\n  c: [c1, c2, c3, c4, c5, c6, c7]') })).toEqual([
      'kb/kb.yaml:6:1  applies  the applies domain has 686 combinations, over the 256 a knowledge base may have: every topic needs a passage in force for each  ->  keep to the facts that change an answer, and to the values that do',
    ]);
  });

  it('an answer is fixed text: no variables, no braces', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('There are no late fees on a junior card.', 'Your card has {balance} in fees.') })).toEqual([
      'kb/passages/late-fees-junior.yaml:8:9  answer  passage "late-fees-junior"\'s answer has the variable {balance}; an answer is fixed text, said word for word  ->  write the answer without braces; a line from the caller\'s own data goes in the topic\'s accountLine in kb/topics.yaml',
    ]);
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('There are no late fees on a junior card.', '"There are no late fees {on a junior card."') })).toEqual([
      'kb/passages/late-fees-junior.yaml:8:9  answer  passage "late-fees-junior"\'s answer has a brace; an answer is fixed text, said word for word  ->  write the answer without braces; a line from the caller\'s own data goes in the topic\'s accountLine in kb/topics.yaml',
    ]);
  });

  it('an answer is within kb.yaml\'s maxAnswerChars (whitespace collapsed)', async () => {
    const long = 'There are no late fees on a junior card. '.repeat(11).trim();
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('There are no late fees on a junior card.', long) })).toEqual([
      'kb/passages/late-fees-junior.yaml:8:9  answer  passage "late-fees-junior"\'s answer is 450 characters, over the 400 kb.yaml allows (maxAnswerChars)  ->  shorten it to what is said in one breath: split the topic in two, or say where the rest is written',
    ]);
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('There are no late fees on a junior card.', long), 'kb/kb.yaml': (t) => t.replace('maxAnswerChars: 400', 'maxAnswerChars: 450') })).toEqual([
      'kb/passages/late-fees-junior.yaml:14:9  approval.hash  passage "late-fees-junior" was edited after approval (its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line), so it is withheld  ->  review the edit (pnpm kb:status shows what changed), then pnpm kb:approve late-fees-junior --by "<your name>"',
    ]);
  });

  it('an effective range ends on or after it starts', async () => {
    expect(await kbLines({ [P + 'late-fees-adult-2025.yaml']: (t) => t.replace('from: 2025-01-01', 'from: 2026-01-01') })).toEqual([
      'kb/passages/late-fees-adult-2025.yaml:6:36  effective.to  passage "late-fees-adult-2025" stops being in force (2025-12-31) before it starts (2026-01-01)  ->  correct the dates: effective.to is the last day it is in force, on or after effective.from',
    ]);
  });

  it('no two passages of a topic and locale are in force for the same caller on the same day', async () => {
    expect(await kbLines({ [P + 'late-fees-adult-2025.yaml']: (t) => t.replace('to: 2025-12-31', 'to: 2026-03-31') })).toEqual([
      'kb/passages/late-fees-adult-2025.yaml:6:1  effective  passages "late-fees-adult" and "late-fees-adult-2025" are both in force from 2026-01-01 to 2026-03-31 for the topic "late_fees" (en-US), for callers they share, so which to say is ambiguous  ->  end "late-fees-adult" the day before "late-fees-adult-2025" starts (effective.to), or give the two different applies',
    ]);
    // A passage for every card overlaps each card's own.
    expect(await kbLines({ [P + 'late-fees-adult-2025.yaml']: (t) => t.replace(', to: 2025-12-31', '').replace('applies: { card: adult }\n', '') })).toEqual([
      'kb/passages/late-fees-adult-2025.yaml:5:1  effective  passages "late-fees-adult" and "late-fees-adult-2025" are both in force from 2026-01-01 on for the topic "late_fees" (en-US), for callers they share, so which to say is ambiguous  ->  end "late-fees-adult" the day before "late-fees-adult-2025" starts (effective.to), or give the two different applies',
      'kb/passages/late-fees-junior.yaml:6:1  effective  passages "late-fees-adult-2025" and "late-fees-junior" are both in force from 2026-01-01 on for the topic "late_fees" (en-US), for callers they share, so which to say is ambiguous  ->  end "late-fees-adult-2025" the day before "late-fees-junior" starts (effective.to), or give the two different applies',
    ]);
    // Different cards, or a different locale, do not overlap.
    expect(await kbLines({ [P + 'late-fees-adult-2025.yaml']: (t) => t.replace(', to: 2025-12-31', '').replace('card: adult', 'card: junior').replace('from: 2025-01-01', 'from: 2027-01-01') })).toEqual([
      'kb/passages/late-fees-junior.yaml:6:1  effective  passages "late-fees-adult-2025" and "late-fees-junior" are both in force from 2027-01-01 on for the topic "late_fees" (en-US), for callers they share, so which to say is ambiguous  ->  end "late-fees-adult-2025" the day before "late-fees-junior" starts (effective.to), or give the two different applies',
    ]);
  });

  it('a translation translates a default-locale passage of the same topic', async () => {
    expect(await kbLines({ [P + 'opening-hours.yaml']: (t) => t.replace('answer:', 'translates: late-fees-adult\nanswer:') })).toEqual([
      'kb/passages/opening-hours.yaml:7:13  translates  passage "opening-hours" is in the default locale (en-US), so it translates nothing  ->  delete the translates line, or move the passage to kb/locale/<tag>/passages',
    ]);
    expect(await kbLines({ 'kb/locale/es/passages/opening-hours-es.yaml': (t) => t.replace('translates: opening-hours', 'translates: opening-hour') })).toEqual([
      'kb/locale/es/passages/opening-hours-es.yaml:8:13  translates  passage "opening-hours-es" translates "opening-hour", which is not a passage  ->  rename it to "opening-hours", or name the passage in kb/passages it translates',
    ]);
    expect(await kbLines({ 'kb/locale/es/passages/opening-hours-es.yaml': (t) => t.replace('translates: opening-hours', 'translates: late-fees-junior') })).toEqual([
      'kb/locale/es/passages/opening-hours-es.yaml:8:13  translates  passage "opening-hours-es" translates "late-fees-junior", whose topic is "late_fees", not "opening_hours"  ->  make the two topics the same, or name the passage of "opening_hours" it translates',
    ]);
  });

  it('defineApp refuses a knowledge base that breaks one, with the same problem', () => {
    const dir = appFolder({ [P + 'late-fees-junior.yaml']: (t) => t.replace('topic: late_fees', 'topic: late_fee') });
    let thrown: unknown;
    try {
      defineApp(dir, CODE);
    } catch (error) {
      thrown = error;
    }
    expect(isAppDefinitionError(thrown)).toBe(true);
    expect((thrown as { problems: readonly { message: string }[] }).problems.map((p) => p.message)).toEqual(['passage "late-fees-junior" answers the topic "late_fee", which kb/topics.yaml does not have']);
  });
});

describe('check: what the knowledge base names in the app', () => {
  it('kb.yaml\'s action is a tool with an action in policy.yaml', async () => {
    expect(await kbLines({ 'kb/kb.yaml': (t) => t.replace('action: findPassage', 'action: findPassages') })).toEqual([
      'kb/kb.yaml:5:9  action  kb.yaml resolves passages through the tool "findPassages", which is not a tool in the code  ->  rename it to "findPassage", or add the tool to app.ts (code.tools.findPassages)',
      'kb/kb.yaml:5:9  action  kb.yaml resolves passages through the tool "findPassages", which has no action in policy.yaml: every read the knowledge base makes goes through the gate  ->  rename it to "findPassage", or add "findPassages:" under actions in policy.yaml, with its level and rules',
    ]);
  });

  it('an account line reads through a tool with an action in policy.yaml', async () => {
    expect(await kbLines({ 'kb/topics.yaml': (t) => t.replace('from: getFees', 'from: getFee') })).toEqual([
      'kb/topics.yaml:21:11  late_fees.accountLine.from  topic "late_fees"\'s account line reads through the tool "getFee", which is not a tool in the code  ->  rename it to "getFees", or add the tool to app.ts (code.tools.getFee)',
      'kb/topics.yaml:21:11  late_fees.accountLine.from  topic "late_fees"\'s account line reads through the tool "getFee", which has no action in policy.yaml: every read the knowledge base makes goes through the gate  ->  rename it to "getFees", or add "getFee:" under actions in policy.yaml, with its level and rules',
    ]);
  });

  it('an account line\'s variables are fields its tool declares, in every locale', async () => {
    const lines = await kbLines({ 'kb/topics.yaml': (t) => t.replace('{balance} in late', '{balanse} in late'), 'kb/locale/es/topics.yaml': (t) => t.replace('{balance}', '{saldo}') });
    expect(lines.filter((l) => l.includes('accountLine.text'))).toEqual([
      'kb/locale/es/topics.yaml:11:11  late_fees.accountLine.text  topic "late_fees"\'s account line (es) uses {saldo}, which the tool "getFees" does not declare among its fields  ->  add "saldo" to app.ts (code.tools.getFees.fields) (a field of its result, which policy.yaml may redact), or take it out of the line',
      'kb/topics.yaml:20:11  late_fees.accountLine.text  topic "late_fees"\'s account line uses {balanse}, which the tool "getFees" does not declare among its fields  ->  rename it to "balance", or add "balanse" to app.ts (code.tools.getFees.fields) (a field of its result, which policy.yaml may redact), or take it out of the line',
    ]);
    // The account line is part of what its topic's passages were approved with.
    expect(lines.filter((l) => l.includes('approval.hash')).map((l) => l.split('  ')[0])).toEqual(['kb/passages/late-fees-adult-2025.yaml:14:9', 'kb/passages/late-fees-adult.yaml:14:9', 'kb/passages/late-fees-junior.yaml:14:9']);
  });

  it('a locale with passages is one the app speaks', async () => {
    // Copied with its approval, which names opening-hours in the default locale: not fresh, and not in the log.
    expect(await kbLines({ 'kb/locale/fr/passages/x.yaml': fixtureText('passages/opening-hours.yaml').replace('id: opening-hours', 'id: x') })).toEqual([
      'kb/locale/fr:1:1  (file)  the knowledge base has fr passages, but the app does not speak fr  ->  add locale/fr/prompts.yaml to the app, or delete kb/locale/fr',
      'kb/locale/fr/passages/x.yaml:8:1  approval  passage "x" was approved outside kb:approve: its approval (by Branch Manager on 2025-12-10) has no line of its id and hash in kb/approvals.jsonl, so no one is on record for it  ->  review it against its source, then pnpm kb:approve x --by "<your name>" (approvals are written by kb:approve, never by hand)',
      'kb/locale/fr/passages/x.yaml:13:9  approval.hash  passage "x" was edited after approval (its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line), so it is withheld  ->  review the edit (pnpm kb:status shows what changed), then pnpm kb:approve x --by "<your name>"',
    ]);
  });

  it('without the app\'s code, check holds the tools to policy.yaml alone', async () => {
    const dir = appFolder({ 'kb/kb.yaml': (t) => t.replace('action: findPassage', 'action: findPassages') });
    const lines = (await checkApp(dir, { code: undefined as unknown as AppCode, todayIso: TODAY })).map(formatProblem);
    expect(lines.filter((l) => l.startsWith('kb/'))).toEqual([
      'kb/kb.yaml:5:9  action  kb.yaml resolves passages through the tool "findPassages", which has no action in policy.yaml: every read the knowledge base makes goes through the gate  ->  rename it to "findPassage", or add "findPassages:" under actions in policy.yaml, with its level and rules',
    ]);
  });

  it('a retriever in the code without a kb/ folder, without nominate, or without an id, is refused', async () => {
    const plain = temp();
    cpSync(LIBRARY_DIR, plain, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    expect((await check(plain, { ...libraryCode, knowledge: { retriever: { id: 'none', nominate: () => [] } } })).filter((l) => l.includes('knowledge'))).toEqual([
      'app.ts  code.knowledge  the code has a knowledge retriever, but the folder has no kb/  ->  add the knowledge base (kb/kb.yaml, kb/topics.yaml, kb/passages/), or delete it from app.ts (code.knowledge)',
    ]);
    expect((await check(appFolder(), { ...CODE, knowledge: { retriever: {} as never } })).filter((l) => l.includes('knowledge'))).toEqual([
      'app.ts  code.knowledge.retriever  the knowledge retriever has no nominate function  ->  make app.ts (code.knowledge.retriever) an object with nominate({ text, locale, todayIso }), which returns the topics it nominates with their scores',
    ]);
    expect((await check(appFolder(), { ...CODE, knowledge: { retriever: { id: ' ', nominate: () => [] } } })).filter((l) => l.includes('knowledge'))).toEqual([
      'app.ts  code.knowledge.retriever.id  the knowledge retriever has no id  ->  give app.ts (code.knowledge.retriever) an id: its name in the trace, beside the topics it nominates',
    ]);
  });
});

describe('a topic slot and the knowledge it reads', () => {
  const SLOTS_YAML = '# yaml-language-server: $schema=../../packages/dialogwright/schemas/slots.schema.json\nbook: { type: code }\nbranch: { type: code }\ncard: { type: code }\nsubject:\n  type: topic\n';
  const retriever: Retriever = { id: 'words', nominate: () => [] };

  it('is built with the kb/ folder\'s topics: their titles by locale, and its retrieval cap', () => {
    const app = defineApp(appFolder({ 'slots.yaml': SLOTS_YAML, 'kb/kb.yaml': (t) => t.replace('cap: 8', 'cap: 3') }), { ...CODE, knowledge: { retriever } });
    const subject = app.slots.subject!;
    expect(subject.nominates).toBe(true);
    expect(subject.display('late_fees')).toBe('late fees');
    expect(subject.display('late_fees', 'es')).toBe('multas por retraso');
    expect(subject.display('card_renewal', 'es')).toBe('renewing a library card');
    const many = ['opening_hours', 'card_renewal', 'late_fees', 'a', 'b', 'c', 'd', 'e', 'f'].map((topic) => ({ topic, title: topic, score: 1, via: 'keyword' as const }));
    const asked = subject.questions({ ...probeContexts()[0]!, nominated: many }).subjectTopic;
    expect(asked?.type === 'choice' && Object.keys(asked.criteria)).toEqual(['opening_hours', 'card_renewal', 'late_fees', 'none']);
  });

  it('check refuses a topic slot in an app without a kb/ folder (it would never ask); with one, the engine\'s retriever nominates when the code gives none', async () => {
    const plain = temp();
    cpSync(LIBRARY_DIR, plain, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    writeFileSync(join(plain, 'slots.yaml'), SLOTS_YAML);
    expect((await check(plain, libraryCode)).filter((l) => l.includes('nominates'))).toEqual([
      'slots.yaml:5:1  subject  the slot "subject" asks about the topics retrieval nominates, but the app has no knowledge base (kb/), so it would never ask  ->  add the knowledge base (kb/kb.yaml, kb/topics.yaml, kb/passages/), or give the slot another type',
    ]);
    expect((await check(appFolder({ 'slots.yaml': SLOTS_YAML }))).filter((l) => l.includes('nominates'))).toEqual([]);
    expect((await check(appFolder({ 'slots.yaml': SLOTS_YAML }), { ...CODE, knowledge: { retriever } })).filter((l) => l.includes('nominates'))).toEqual([]);
  });

  it('validateApp: knowledge without a kb/ folder is the topics its retriever nominates, and that retriever', () => {
    const topics = [{ id: 'opening_hours', title: 'Opening hours' }];
    expect(() => validateApp({ ...libraryApp, knowledge: { topics, retriever } })).not.toThrow();
    expect(() => validateApp({ ...libraryApp, knowledge: { topics } as never })).toThrow('knowledge without a knowledge base (kb) has no retriever, so nothing would nominate its topics');
    expect(() => validateApp({ ...libraryApp, knowledge: { retriever } as never })).toThrow('knowledge has neither a knowledge base (kb) nor a list of topics');
    expect(() => validateApp({ ...libraryApp, knowledge: { topics: [{ id: 'x', title: ' ' }], retriever } })).toThrow("knowledge's topic 0 has no id and title");
    expect(() => validateApp({ ...libraryApp, knowledge: { topics: [...topics, ...topics], retriever } })).toThrow('knowledge\'s topic "opening_hours" is listed twice');
    expect(() => validateApp({ ...libraryApp, knowledge: { kb: fixtureKb(), topics, retriever } as never })).toThrow("knowledge has both a knowledge base (kb) and topics of its own");
  });

  it('validateApp refuses a slot that reads nominations in an app without knowledge', () => {
    const subject: SlotSpec = { id: 'subject', spokenConfirm: 'summary', nominates: true, questions: () => ({}), fill: () => ({ kind: 'absent' }), display: (v) => v };
    expect(() => validateApp({ ...libraryApp, slots: { ...libraryApp.slots, subject } })).toThrow('slot "subject" asks about the topics retrieval nominates, but the app has no knowledge');
  });
});

describe('check: approvals and the passages in force today (check only; at run time such a passage is withheld)', () => {
  it('an unapproved passage fails check, and defineApp still builds (it is withheld when resolved)', async () => {
    const dir = appFolder({ [P + 'late-fees-junior.yaml']: unapproved });
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: unapproved })).toEqual([
      'kb/passages/late-fees-junior.yaml:8:9  answer  passage "late-fees-junior" is not approved, so it is never said  ->  review it against its source (pnpm kb:status lists what waits), then pnpm kb:approve late-fees-junior --by "<your name>"',
    ]);
    expect(defineApp(dir, CODE).knowledge!.kb!.passages['late-fees-junior']!.freshness).toBe('unapproved');
  });

  it('a passage whose source changed since approval is stale', async () => {
    expect(await kbLines({ 'kb/sources/patron-guide.yaml': (t) => t.replace('up to 5 dollars for each item', 'up to 6 dollars for each item') })).toEqual([
      'kb/passages/late-fees-adult.yaml:13:15  approval.sourceHash  passage "late-fees-adult" is stale: its source changed since approval (kb/sources/patron-guide.yaml, section "3.1"), so it is withheld  ->  review the answer against the source\'s text now (pnpm kb:status shows what changed), then pnpm kb:approve late-fees-adult --by "<your name>"',
    ]);
  });

  it('a passage edited after approval is withheld until it is approved again', async () => {
    expect(await kbLines({ [P + 'card-renewal-adult.yaml']: (t) => t.replace('three years', 'four years') })).toEqual([
      'kb/passages/card-renewal-adult.yaml:14:9  approval.hash  passage "card-renewal-adult" was edited after approval (its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line), so it is withheld  ->  review the edit (pnpm kb:status shows what changed), then pnpm kb:approve card-renewal-adult --by "<your name>"',
    ]);
  });

  it('every topic has a passage in force today, in the default locale, for every combination of the applies domain: each missing one a problem', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: null })).toEqual([
      'kb/topics.yaml:14:1  late_fees  topic "late_fees" has no passage in force on 2026-10-03 for card junior (en-US)  ->  add a passage to kb/passages (topic: late_fees, applies: { card: junior }, in force on 2026-10-03), then review and approve it',
    ]);
    // Last year, only the late fees for adult cards were in force: a topic with no passage at all misses each combination.
    expect((await kbLines({}, CODE, '2025-06-01')).map((l) => l.split('  ').slice(0, 3).join('  '))).toEqual([
      'kb/topics.yaml:2:1  opening_hours  topic "opening_hours" has no passage in force on 2025-06-01 for card adult (en-US)',
      'kb/topics.yaml:2:1  opening_hours  topic "opening_hours" has no passage in force on 2025-06-01 for card junior (en-US)',
      'kb/topics.yaml:9:1  card_renewal  topic "card_renewal" has no passage in force on 2025-06-01 for card adult (en-US)',
      'kb/topics.yaml:9:1  card_renewal  topic "card_renewal" has no passage in force on 2025-06-01 for card junior (en-US)',
      'kb/topics.yaml:14:1  late_fees  topic "late_fees" has no passage in force on 2025-06-01 for card junior (en-US)',
    ]);
    // A translation does not stand in for the default locale's passage.
    expect(await kbLines({ [P + 'opening-hours.yaml']: null, 'kb/locale/es/passages/opening-hours-es.yaml': (t) => t.replace('translates: opening-hours\n', '') })).toEqual([
      'kb/topics.yaml:2:1  opening_hours  topic "opening_hours" has no passage in force on 2026-10-03 for card adult (en-US)  ->  add a passage to kb/passages (topic: opening_hours, applies: { card: adult }, in force on 2026-10-03), then review and approve it',
      'kb/topics.yaml:2:1  opening_hours  topic "opening_hours" has no passage in force on 2026-10-03 for card junior (en-US)  ->  add a passage to kb/passages (topic: opening_hours, applies: { card: junior }, in force on 2026-10-03), then review and approve it',
    ]);
  });
});

describe('the kb/ folder: its layout, read as safely as the app folder', () => {
  it('kb.yaml and topics.yaml are required', async () => {
    expect(await kbLines({ 'kb/kb.yaml': null, 'kb/topics.yaml': null })).toEqual([
      'kb/kb.yaml:1:1  (file)  kb/kb.yaml is missing  ->  create kb/kb.yaml; it names the gated action that resolves a passage, for example "action: findPassage"',
      'kb/topics.yaml:1:1  (file)  kb/topics.yaml is missing  ->  create kb/topics.yaml; it lists the topics, for example "opening_hours: { title: Opening hours }"',
    ]);
  });

  it('a passage\'s id is its file name, and is used once across the locales', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('id: late-fees-junior', 'id: late-fees-kids') })).toEqual([
      'kb/passages/late-fees-junior.yaml:2:5  id  kb/passages/late-fees-junior.yaml has the id "late-fees-kids"; a passage\'s id is its file name  ->  write "id: late-fees-junior", or rename the file to late-fees-kids.yaml',
    ]);
    expect(await kbLines({ 'kb/locale/es/passages/late-fees-junior.yaml': fixtureText('passages/late-fees-junior.yaml') })).toEqual([
      'kb/locale/es/passages/late-fees-junior.yaml:2:5  id  the passage id "late-fees-junior" is used twice: here and in kb/passages/late-fees-junior.yaml  ->  give one of the two another id (and its file the same name), for example "late-fees-junior-es"',
    ]);
  });

  it('a passage\'s locale is its folder\'s', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('answer:', 'locale: es\nanswer:'), 'kb/locale/es/passages/opening-hours-es.yaml': (t) => t.replace('answer:', 'locale: fr\nanswer:') })).toEqual([
      'kb/locale/es/passages/opening-hours-es.yaml:7:9  locale  passage "opening-hours-es" says its locale is fr, but it is in kb/locale/es/passages, the es passages  ->  move it to kb/locale/fr/passages/opening-hours-es.yaml, or delete the locale line',
      'kb/passages/late-fees-junior.yaml:8:9  locale  passage "late-fees-junior" says its locale is es, but kb/passages holds the default locale\'s passages (en-US)  ->  move it to kb/locale/es/passages/late-fees-junior.yaml, or delete the locale line',
    ]);
  });

  it('kb/locale holds a folder per other locale, named by its tag', async () => {
    expect(await kbLines({ 'kb/locale/en-US/topics.yaml': 'opening_hours: { title: Hours }\n', 'kb/locale/Spanish/topics.yaml': 'x: {}\n', 'kb/locale/notes.yaml': 'x: 1\n' })).toEqual([
      'kb/locale/en-US:1:1  (file)  kb/locale/en-US is the app\'s default locale (en-US), whose topics and passages are kb/topics.yaml and kb/passages  ->  move its passages into kb/passages and its wording into kb/topics.yaml, and delete kb/locale/en-US',
      'kb/locale/notes.yaml:1:1  (file)  kb/locale/notes.yaml is a file; kb/locale holds one folder per locale, each with its topics.yaml and passages/  ->  move it into a folder named for its language tag, for example kb/locale/es/',
      'kb/locale/Spanish:1:1  (file)  kb/locale/Spanish is not a language tag like "es" or "pt-BR"  ->  rename the folder to the locale\'s language tag (for example kb/locale/es)',
    ]);
  });

  it('a locale\'s wording is for topics there are, and gives an account line only where the topic has one', async () => {
    expect(await kbLines({ 'kb/locale/es/topics.yaml': (t) => `${t}parking:\n  title: Aparcamiento\nopening_hours_x: {}\n` })).toEqual([
      'kb/locale/es/topics.yaml:12:1  parking  the es wording is for the topic "parking", which kb/topics.yaml does not have  ->  delete it, or add "parking:" to kb/topics.yaml',
      'kb/locale/es/topics.yaml:14:1  opening_hours_x  the es wording is for the topic "opening_hours_x", which kb/topics.yaml does not have  ->  rename it to opening_hours, or delete it, or add "opening_hours_x:" to kb/topics.yaml',
    ]);
    expect(await kbLines({ 'kb/locale/es/topics.yaml': (t) => t.replace('opening_hours:\n  title: Horario', 'opening_hours:\n  title: Horario\n  accountLine: { text: Hola }') })).toEqual([
      'kb/locale/es/topics.yaml:4:3  opening_hours.accountLine  the es wording gives the topic "opening_hours" an account line, but kb/topics.yaml gives it none (the line\'s tool is named there)  ->  add "accountLine: { text, from }" to "opening_hours" in kb/topics.yaml, or delete this one',
    ]);
  });

  it('anything else in kb/ is a problem, apart from hidden entries and notes that are not YAML', async () => {
    expect(await kbLines({ 'kb/topic.yaml': 'x: 1\n', 'kb/passage/x.yaml': 'x: 1\n', [P + 'notes.txt']: 'x', [P + 'old.yml']: 'x: 1\n', [P + 'archive/x.yaml']: 'x: 1\n', 'kb/README.md': 'notes', 'kb/.index/x.json': '{}' })).toEqual([
      'kb/passage:1:1  (file)  kb/passage is not a folder the knowledge base has; its folders are passages, sources, locale, pending and rejected  ->  rename it to passages, or delete it, or move it out of kb',
      'kb/passages/archive:1:1  (file)  kb/passages/archive is a folder; kb/passages holds one .yaml file per passage  ->  move its files into kb/passages, or out of the knowledge base',
      'kb/passages/notes.txt:1:1  (file)  kb/passages/notes.txt is not a .yaml file; kb/passages holds one .yaml file per passage  ->  delete it, or move it out of the knowledge base',
      'kb/passages/old.yml:1:1  (file)  kb/passages/old.yml ends in .yml; the knowledge base\'s files end in .yaml  ->  rename it to old.yaml',
      'kb/topic.yaml:1:1  (file)  kb/topic.yaml is not a file the knowledge base reads; its files are kb.yaml and topics.yaml, and a folder for each kind of file  ->  rename it to topics.yaml, or delete it, or move it out of kb',
    ]);
  });

  it('drafts in kb/pending are never read, but one may not take an approved passage\'s id', async () => {
    expect(await kbLines({ 'kb/pending/late-fees-junior.yaml': 'id: late-fees-junior\n', 'kb/pending/new.yaml': 'not: [valid yaml at all\n' })).toEqual([
      'kb/pending/late-fees-junior.yaml:1:1  (file)  the draft kb/pending/late-fees-junior.yaml has the id of the passage in kb/passages/late-fees-junior.yaml  ->  rename the draft (and its id) to a new id, or delete it: approving it would replace the passage',
    ]);
  });

  it('YAML is only data: a tag is refused, and so is a file over the size limit', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('version: "2026.1"', 'version: !!js/function "x"') })).toEqual([
      'kb/passages/late-fees-junior.yaml:4:10  (file)  Unresolved tag: tag:yaml.org,2002:js/function  ->  delete the "!tag": these files are plain data, with no custom tags',
    ]);
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => `${t}#${'x'.repeat(1024 * 1024)}\n` })).toEqual([
      'kb/passages/late-fees-junior.yaml:1:1  (file)  kb/passages/late-fees-junior.yaml is 1049103 bytes, over the 1048576 byte limit  ->  split the content, or remove what does not belong in a configuration file',
    ]);
  });

  it('each file is checked against its schema, with the loader\'s messages', async () => {
    expect(await kbLines({ [P + 'late-fees-junior.yaml']: (t) => t.replace('effective: { from: 2026-01-01 }', 'effective: { from: 2026-02-30 }').replace('version:', 'versoin:').replace(/sourceHash: \w+/, 'sourceHash: abc') })).toEqual([
      'kb/passages/late-fees-junior.yaml:4:1  versoin  unknown key "versoin" in this file  ->  rename "versoin" to "version"',
      'kb/passages/late-fees-junior.yaml:6:20  effective.from  2026-02-30 is not a day of the calendar  ->  write a day that exists, for example 2026-02-28',
      'kb/passages/late-fees-junior.yaml:13:15  approval.sourceHash  "abc" is not a SHA-256 hash: it must be 64 lowercase hex characters  ->  leave the hashes to pnpm kb:approve, which writes them',
    ]);
    expect(await kbLines({ 'kb/kb.yaml': (t) => t.replace('localeFallback: none', 'localeFallback: english').replace('maxAnswerChars: 400', 'maxAnswerChars: 4') })).toEqual([
      'kb/kb.yaml:8:17  localeFallback  "localeFallback" is "english", which is not allowed here; it must be one of "none", "default"  ->  use one of "none", "default"',
      'kb/kb.yaml:9:17  maxAnswerChars  "maxAnswerChars" must be at least 40  ->  use a value of at least 40',
    ]);
  });

  it('reads nothing outside the app folder: a linked file, a linked folder, or kb/ itself linked out', async () => {
    const outside = temp();
    writeFileSync(join(outside, 'late-fees-junior.yaml'), fixtureText('passages/late-fees-junior.yaml'));
    const file = appFolder({ [P + 'late-fees-junior.yaml']: null });
    symlinkSync(join(outside, 'late-fees-junior.yaml'), join(file, P, 'late-fees-junior.yaml'));
    const fileLines = await check(file);
    expect(fileLines.filter((l) => l.startsWith('kb/passages/late-fees-junior.yaml'))).toEqual([
      `kb/passages/late-fees-junior.yaml:1:1  (file)  kb/passages/late-fees-junior.yaml resolves to ${join(realOf(outside), 'late-fees-junior.yaml')}, which is outside the app folder  ->  replace the link with a regular file (or a link to a file) inside the app folder; files outside it are never read`,
    ]);
    const folder = appFolder({ 'kb/sources': null });
    cpSync(join(KB_FIXTURE, 'sources'), join(outside, 'sources'), { recursive: true });
    symlinkSync(join(outside, 'sources'), join(folder, 'kb', 'sources'));
    expect((await check(folder)).filter((l) => l.startsWith('kb/sources'))).toEqual([
      'kb/sources:1:1  (file)  kb/sources resolves to a place outside the app folder  ->  replace the link with the folder itself; nothing outside the app folder is read',
    ]);
    const whole = appFolder({ kb: null });
    cpSync(KB_FIXTURE, join(outside, 'kb'), { recursive: true });
    symlinkSync(join(outside, 'kb'), join(whole, 'kb'));
    expect((await check(whole)).filter((l) => l.startsWith('kb'))).toEqual([
      'kb:1:1  (file)  kb resolves to a place outside the app folder  ->  replace the link with the folder itself; nothing outside the app folder is read',
    ]);
    // A link that stays inside the app folder is read.
    const inside = appFolder({ 'kb/sources': null, 'docs/sources/patron-guide.yaml': fixtureText('sources/patron-guide.yaml'), 'docs/sources/fee-schedule-2025.yaml': fixtureText('sources/fee-schedule-2025.yaml') });
    symlinkSync(join(inside, 'docs', 'sources'), join(inside, 'kb', 'sources'));
    expect(await check(inside)).toEqual([]);
  });

  it('kb as a file is a problem', async () => {
    const dir = appFolder({ kb: null });
    writeFileSync(join(dir, 'kb'), 'not a folder');
    expect((await check(dir)).filter((l) => l.startsWith('kb'))).toEqual([
      'kb:1:1  (file)  kb is a file; the knowledge base is a folder (kb/kb.yaml, kb/topics.yaml, kb/passages/, ...)  ->  delete the file, or make kb a folder',
    ]);
  });
});

describe('defineKnowledge: the knowledge base of an app that is not a folder', () => {
  const policy = (dir: string): string => {
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, `actions:\n  findPassage: { level: 0, rules: [identity] }\n  getFees: { level: 0, rules: [identity] }\naudit:\n  topic: keep\n  card: keep\n`);
    return path;
  };

  it('loads it, checked against the tools, the policy and the locales', () => {
    const dir = temp();
    cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
    const knowledge = defineKnowledge(join(dir, 'kb'), { tools: TOOLS, policy: policy(dir), locales: ['en-US', 'es'] });
    expect(Object.keys(knowledge.kb.passages)).toHaveLength(7);
    expect(knowledgeProblems(join(dir, 'kb'), { tools: TOOLS, policy: policy(dir), locales: ['en-US', 'es'], todayIso: TODAY })).toEqual([]);
  });

  it('throws what is wrong, naming the files from where it was given', () => {
    const dir = temp();
    cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
    writeFileSync(join(dir, 'kb', 'kb.yaml'), readFileSync(join(dir, 'kb', 'kb.yaml'), 'utf8').replace('action: findPassage', 'action: findPassages'));
    let thrown: unknown;
    try {
      defineKnowledge(join(dir, 'kb'), { tools: TOOLS, policy: policy(dir) });
    } catch (error) {
      thrown = error;
    }
    expect(isAppDefinitionError(thrown)).toBe(true);
    expect((thrown as { problems: readonly Parameters<typeof formatProblem>[0][] }).problems.map(formatProblem)).toEqual([
      `${dir}/kb/kb.yaml:5:9  action  kb.yaml resolves passages through the tool "findPassages", which is not a tool in the code  ->  rename it to "findPassage", or add the tool to code.tools.findPassages`,
      `${dir}/kb/kb.yaml:5:9  action  kb.yaml resolves passages through the tool "findPassages", which has no action in ${dir}/policy.yaml: every read the knowledge base makes goes through the gate  ->  rename it to "findPassage", or add "findPassages:" under actions in ${dir}/policy.yaml, with its level and rules`,
    ]);
  });

  it('does not refuse a stale passage, which knowledgeProblems reports and resolution withholds', () => {
    const dir = temp();
    cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
    const guide = join(dir, 'kb', 'sources', 'patron-guide.yaml');
    writeFileSync(guide, readFileSync(guide, 'utf8').replace('Junior cards are not charged late fees.', 'Junior cards are charged no late fees.'));
    const knowledge = defineKnowledge(join(dir, 'kb'));
    expect(resolvePassage(knowledge.kb, { topic: 'late_fees', facts: { card: 'junior' }, todayIso: TODAY })).toMatchObject({ unavailable: 'stale' });
    expect(knowledgeProblems(join(dir, 'kb'), { todayIso: TODAY }).map((p) => p.message)).toEqual([
      'passage "late-fees-junior" is stale: its source changed since approval (kb/sources/patron-guide.yaml, section "3.2"), so it is withheld',
    ]);
  });
});

/** An embedder that says it is the pinned potion-base-8M (so check takes its index as that model's), with vectors from each text's hash: the index's shape, without the weights. */
const pinnedLookalike: Embedder = {
  id: POTION_BASE_8M.id,
  revision: POTION_BASE_8M.revision,
  sha256: POTION_BASE_8M.sha256,
  dim: POTION_BASE_8M.dim,
  embed: (texts) => texts.map((t) => Float64Array.from({ length: POTION_BASE_8M.dim }, (_, i) => createHash('sha256').update(`${i}:${t}`).digest()[0]! / 255 - 0.5)),
};

/** kb.yaml naming the static embedder. */
const withEmbedder = (text: string): string => text.replace('  cap: 8', '  cap: 8\n  embedder: potion-base-8M');

/** An app folder whose kb.yaml names the embedder, with its index written (by the lookalike), and `edits` after. */
async function indexedFolder(edits: Record<string, Edit> = {}): Promise<string> {
  const dir = appFolder({ 'kb/kb.yaml': withEmbedder });
  const built = await buildIndex(loadAppFolder(dir).config!.knowledge!, pinnedLookalike);
  mkdirSync(join(dir, 'kb', '.index'), { recursive: true });
  writeFileSync(join(dir, 'kb', '.index', 'potion-base-8M.json'), built.text);
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(dir, file);
    if (edit === null) rmSync(path, { force: true });
    else writeFileSync(path, typeof edit === 'string' ? edit : edit(readFileSync(path, 'utf8')));
  }
  return dir;
}

describe('check: the vector index of the embedder kb.yaml names (kb/.index/<embedder>.json)', () => {
  const FIX = 'run pnpm kb:index (it reads the model from the cache; pnpm kb:model downloads it), and commit kb/.index/potion-base-8M.json';

  it('a kb.yaml without an embedder needs no index, and one with an index of every topic text passes', async () => {
    expect(await kbLines({})).toEqual([]);
    expect(await check(await indexedFolder())).toEqual([]);
  });

  it('reports a missing index, one that is not an index, and one another model wrote', async () => {
    expect(await kbLines({ 'kb/kb.yaml': withEmbedder })).toEqual([
      `kb/.index/potion-base-8M.json:1:1  (file)  kb/.index/potion-base-8M.json is missing: kb.yaml names the embedder potion-base-8M, whose vectors of the topics' texts retrieval reads from there  ->  ${FIX}`,
    ]);
    expect(await check(await indexedFolder({ 'kb/.index/potion-base-8M.json': '{"embedder": {"id": 1}}' }))).toEqual([
      `kb/.index/potion-base-8M.json:1:1  (file)  kb/.index/potion-base-8M.json is not a vector index: its "embedder" is not { id, revision, sha256, dim }  ->  ${FIX}`,
    ]);
    const other = await check(await indexedFolder({ 'kb/.index/potion-base-8M.json': (t) => t.replace(POTION_BASE_8M.revision, 'b'.repeat(40)) }));
    expect(other).toHaveLength(1);
    expect(other[0]).toContain(`was written by potion-base-8M at bbbbbbbbbbbb (${POTION_BASE_8M.sha256.slice(0, 12)}), not the pinned potion-base-8M at ${POTION_BASE_8M.revision.slice(0, 12)}`);
  });

  it('reports each topic whose texts changed since the index was written, at the topic', async () => {
    const lines = await check(await indexedFolder({ 'kb/topics.yaml': (t) => t.replace('keywords: [late fee, overdue, fine]', 'keywords: [late fee, overdue, fines]') }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^kb\/topics\.yaml:\d+:1 {2}late_fees {2}the index kb\/\.index\/potion-base-8M\.json is stale for the topic "late_fees": no vector for keyword "fines" \(en-US\); a vector for text it no longer has: keyword [0-9a-f]{12} \(en-US\) {2}-> {2}run pnpm kb:index/);
    const es = await check(await indexedFolder({ 'kb/locale/es/topics.yaml': (t) => t.replace('keywords: [multa, retraso]', 'keywords: [multa, retraso, recargo]') }));
    expect(es).toEqual([expect.stringContaining('no vector for keyword "recargo" (es)')]);
  });

  it('refuses an embedder the engine does not have, as content: defineApp refuses it too', async () => {
    const edits = { 'kb/kb.yaml': (t: string) => t.replace('  cap: 8', '  cap: 8\n  embedder: potion-base-8m') };
    expect(() => defineApp(appFolder(edits), CODE)).toThrow('does not have (it has potion-base-8M)');
    expect(await kbLines(edits)).toEqual([
      'kb/kb.yaml:12:13  retrieval.embedder  kb.yaml names the embedder "potion-base-8m", which the engine does not have (it has potion-base-8M)  ->  rename it to "potion-base-8M", or leave it out, for keyword retrieval alone',
    ]);
  });

  it('defineApp gives the app the default retriever: hybrid only with the index and the weights, keywords alone otherwise', async () => {
    const dir = await indexedFolder();
    const kb = loadAppFolder(dir).config!.knowledge!;
    expect('data' in kb.index! && kb.index.data.entries.length).toBe(25);
    const hybrid = defaultRetriever(kb, { embedder: pinnedLookalike });
    expect(hybrid.kind).toBe('hybrid');
    expect(hybrid.retriever.id).toBe('hybrid:potion-base-8M');
    expect(hybrid.retriever.indexHash).toBe(createHash('sha256').update(readFileSync(join(dir, 'kb', '.index', 'potion-base-8M.json'))).digest('hex'));
    const noWeights = { [MODEL_DIR_ENV]: temp() };
    expect(defaultRetriever(kb, { env: noWeights }).kind).toBe('keyword: no weights');
    expect(defaultRetriever(loadAppFolder(appFolder({ 'kb/kb.yaml': withEmbedder })).config!.knowledge!, { env: noWeights }).kind).toBe('keyword: no index');
    expect(defaultRetriever(fixtureKb()).kind).toBe('keyword: no embedder');
    expect(defaultRetriever(kb, { embedder: { ...pinnedLookalike, sha256: '0'.repeat(64) } }).kind).toBe('keyword: index of another embedder');
  });
});

/** A path with its links resolved (a scratch folder may be under a linked /tmp). */
function realOf(path: string): string {
  return realpathSync(path);
}

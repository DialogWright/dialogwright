import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { main } from '../define/cli';
import { defineApp } from '../define/defineApp';
import { loadKnowledgeFolder } from '../define/load';
import { ANONYMOUS } from '../gate/principal';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { AnswerMap, JevClient } from '../jev/types';
import { spokenText } from '../prompts/render';
import { runTurn, type RunOptions, type TurnRun } from '../run/turn';
import { choice, noul } from '../testing/answers';
import { fixedRetriever } from '../testing/retrievers';
import { excerptInSource, notAPerson, readApprovalLog } from './approval';
import { BASE, cleanScratch, codeFor, folder, KB_FIXTURE, TODAY } from './__fixtures__/libraryKbApp';

/**
 * Approval and staleness: `kb:approve` (a passage re-approved after its source changed or it was
 * edited, a draft moved out of kb/pending), `kb:status` (the passages by state, with the fix for
 * each), who may approve, and, end to end on real calls through runTurn, that a passage whose source
 * changed or that was edited is withheld until a person approves it again.
 */

const scratch: string[] = [];
afterAll(() => {
  cleanScratch();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch copy of the library's knowledge base folder on its own; its path. */
function kbCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-kb-approve-'));
  scratch.push(dir);
  cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
  return join(dir, 'kb');
}

const edit = (file: string, change: (text: string) => string): void => writeFileSync(file, change(readFileSync(file, 'utf8')));

/** Runs the bin with `args` from `cwd`, today being TODAY: its exit code and what it said. */
async function bin(args: readonly string[], cwd: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(...l.split('\n')), cwd, today: () => TODAY, confirm: () => Promise.resolve(true) });
  return { code, out, err };
}

const approve = (kbDir: string, ...args: string[]) => bin(['kb:approve', ...args, '--dir', kbDir], kbDir);
/** The fixture's own log: the approvals its passages stand on. */
const FIXTURE_LOG = readFileSync(join(KB_FIXTURE, 'approvals.jsonl'), 'utf8');
/** The lines kb:approve appended to a copy's log, after the fixture's own (which it never rewrites). */
const logOf = (kbDir: string): unknown[] => {
  const text = readFileSync(join(kbDir, 'approvals.jsonl'), 'utf8');
  expect(text.startsWith(FIXTURE_LOG)).toBe(true);
  return text.slice(FIXTURE_LOG.length).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown);
};
const passage = (kbDir: string, id: string) => loadKnowledgeFolder(kbDir, 'en-US').kb!.passages[id]!;

/** A draft in kb/pending, as a drafter writes one. */
const DRAFT = [
  '# yaml-language-server: $schema=../../../../../schemas/kb-pending.schema.json',
  '# Drafted from the patron guide; the 2025 junior fees.',
  'id: late-fees-junior-2025',
  'topic: late_fees',
  'version: "2025.1"',
  'applies: { card: junior }',
  'effective: { from: 2025-01-01, to: 2025-12-31 }',
  'source: { document: patron-guide, section: "3.2" }',
  'answer: There are no late fees on a junior card.',
  'drafted:',
  '  by: kb:draft (fake drafter)',
  '  on: 2026-10-02',
  '  excerpt: Junior cards are not charged late fees.',
  '',
].join('\n');

describe('who may approve', () => {
  it('a person, by name; never an assistant, a model or a tool, and never a placeholder', () => {
    for (const name of ['Jane Smith', 'Branch Manager', "Siobhán O'Brien", 'Ai Tanaka', 'J. Smith (Patron Services)']) expect(notAPerson(name)).toBeNull();
    for (const name of ['Claude', 'claude', 'Claude Code', 'assistant', 'the assistant', 'AI', 'the AI', 'AI model', 'ChatGPT', 'gpt-5', 'Copilot', 'release-bot', 'dependabot[bot]', 'CI', 'system', 'automated']) {
      expect(notAPerson(name), name).toMatch(/is not a person: an approval records the person who read the answer against its source and answers for it/);
    }
    expect(notAPerson('<your name>')).toBe('--by "<your name>" is a placeholder: write your own name in its place');
    expect(notAPerson('  ')).toBe('--by is empty: an approval records the person who approved the passage');
    expect(notAPerson('1234')).toBe('--by "1234" is not a person\'s name');
  });

  it('kb:approve needs ids and --by, and refuses an approver who is not a person, writing nothing', async () => {
    const kb = kbCopy();
    edit(join(kb, 'sources/patron-guide.yaml'), (t) => t.replace('for each day an item is overdue, up to 5', 'for every day an item is overdue, up to 5'));
    expect(await approve(kb, '--by', 'Jane Smith')).toMatchObject({ code: 2, err: ['dialogwright kb:approve: name the passages or drafts to approve, by id', expect.stringContaining('usage:')] });
    expect(await approve(kb, 'late-fees-adult')).toMatchObject({ code: 2, err: ['dialogwright kb:approve: --by is required: the name of the person who reviewed the passages against their sources and approves them', expect.stringContaining('usage:')] });
    expect((await approve(kb, 'late-fees-adult', '--by', 'Claude')).err[0]).toBe(
      'dialogwright kb:approve: --by "Claude" is not a person: an approval records the person who read the answer against its source and answers for it, and an assistant or a tool may draft a passage but never approve one',
    );
    expect(passage(kb, 'late-fees-adult').freshness).toBe('source-changed');
    expect(logOf(kb)).toEqual([]);
  });

  it('a draft\'s excerpt is held to its section word for word, whatever the line breaks', () => {
    const section = 'An adult card is valid for three years. It is renewed at any branch desk\n  with a photo ID, at no charge.';
    expect(excerptInSource('It is renewed at any branch desk with a photo ID', section)).toBe(true);
    expect(excerptInSource('It is renewed at any branch with a photo ID', section)).toBe(false);
    expect(excerptInSource('it is renewed at any branch desk', section)).toBe(false);
    expect(excerptInSource('   ', section)).toBe(false);
  });
});

describe('a person confirms at the terminal', () => {
  /** The bin, with how the run is confirmed: an injected answer, a terminal or not, the environment. */
  async function run(args: readonly string[], cwd: string, how: { confirm?: (q: string) => Promise<boolean>; isTTY?: boolean; env?: NodeJS.ProcessEnv }) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(...l.split('\n')), cwd, today: () => TODAY, ...how });
    return { code, out, err };
  }
  const edited = (): string => {
    const kb = kbCopy();
    edit(join(kb, 'passages/late-fees-junior.yaml'), (t) => t.replace('There are no late fees on a junior card.', 'A junior card has no late fees.'));
    return kb;
  };
  const ARGS = (kb: string, ...more: string[]) => ['kb:approve', 'late-fees-junior', '--by', 'Jane Smith', '--dir', kb, ...more];

  it('asks once per run, naming the ids, the approver and the team; only a yes approves', async () => {
    const kb = edited();
    const asked: string[] = [];
    const no = await run(ARGS(kb, '--owner', 'Patron Services'), kb, { confirm: (q) => (asked.push(q), Promise.resolve(false)) });
    expect(no).toEqual({ code: 1, out: [], err: ['dialogwright kb:approve: not confirmed: nothing approved, nothing written'] });
    expect(asked).toEqual([`Approve late-fees-junior in ${kb} as Jane Smith for Patron Services? You have read its answer against its source section and answer for it. [y/N] `]);
    expect(passage(kb, 'late-fees-junior').freshness).toBe('edited');
    expect(logOf(kb)).toEqual([]);
    const yes = await run(ARGS(kb), kb, { confirm: () => Promise.resolve(true) });
    expect(yes.code).toBe(0);
    expect(passage(kb, 'late-fees-junior').freshness).toBe('fresh');
  });

  it('refuses without a terminal, unless --yes confirms on the command line; --yes is refused in CI and for no person', async () => {
    const kb = edited();
    expect(await run(ARGS(kb), kb, { isTTY: false, env: {} })).toEqual({
      code: 2,
      out: [],
      err: ['dialogwright kb:approve: stdin is not a terminal, so no one can confirm the approval: run it at your own terminal, or confirm on the command line with --yes (refused in CI)'],
    });
    expect(await run(ARGS(kb, '--yes'), kb, { isTTY: false, env: { CI: 'true' } })).toEqual({
      code: 2,
      out: [],
      err: ['dialogwright kb:approve: --yes is refused in CI (CI is set): an approval is a person\'s, confirmed by them at their own terminal, and no person is at a CI job\'s command'],
    });
    expect((await run(['kb:approve', 'late-fees-junior', '--by', 'Claude', '--dir', kb, '--yes'], kb, { isTTY: false, env: {} })).code).toBe(2);
    expect(passage(kb, 'late-fees-junior').freshness).toBe('edited');
    expect(logOf(kb)).toEqual([]);
    // Outside CI, --yes is the person's confirmation: nothing is asked.
    const asked: string[] = [];
    expect((await run(ARGS(kb, '--yes'), kb, { isTTY: false, env: { CI: 'false' }, confirm: (q) => (asked.push(q), Promise.resolve(false)) })).code).toBe(0);
    expect(asked).toEqual([]);
    expect(passage(kb, 'late-fees-junior').freshness).toBe('fresh');
  });
});

describe('kb:approve a passage', () => {
  it('after its source changed: writes the approval in place, keeping the file as it was, and logs it', async () => {
    const kb = kbCopy();
    const file = join(kb, 'passages/late-fees-adult.yaml');
    edit(join(kb, 'sources/patron-guide.yaml'), (t) => t.replace('for each day an item is overdue, up to 5', 'for every day an item is overdue, up to 5'));
    expect(passage(kb, 'late-fees-adult').freshness).toBe('source-changed');
    const before = readFileSync(file, 'utf8').split('\n');
    const { current } = passage(kb, 'late-fees-adult');

    const run = await approve(kb, 'late-fees-adult', '--by', 'Jane Smith');
    expect(run).toEqual({
      code: 0,
      out: [`late-fees-adult: approved (version 2026.1) by Jane Smith for Patron Services on ${TODAY}: wrote the approval to kb/passages/late-fees-adult.yaml; sourceHash ${current.sourceHash!.slice(0, 12)}, hash ${current.hash.slice(0, 12)}; logged in ${join(kb, 'approvals.jsonl')}`],
      err: [],
    });
    // Only the approval's lines changed: the owner kept, the comment and the flow maps as they were.
    const after = readFileSync(file, 'utf8').split('\n');
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual(['  approvedBy: Jane Smith', `  on: ${TODAY}`, `  sourceHash: ${current.sourceHash}`, `  hash: ${current.hash}`]);
    expect(after[0]).toBe('# yaml-language-server: $schema=../../../../../schemas/kb-passage.schema.json');
    expect(passage(kb, 'late-fees-adult')).toMatchObject({ freshness: 'fresh', approval: { owner: 'Patron Services', approvedBy: 'Jane Smith', on: TODAY } });
    expect(logOf(kb)).toEqual([{ id: 'late-fees-adult', version: '2026.1', approvedBy: 'Jane Smith', owner: 'Patron Services', on: TODAY, sourceHash: current.sourceHash, hash: current.hash, from: 'passage', sourceText: 'An adult card is charged 25 cents for every day an item is overdue, up to 5 dollars for each item.' }]);
  });

  it('after an edit, with --owner taking the owner\'s place; the log is appended to, never rewritten', async () => {
    const kb = kbCopy();
    edit(join(kb, 'passages/late-fees-junior.yaml'), (t) => t.replace('There are no late fees on a junior card.', 'A junior card has no late fees.'));
    edit(join(kb, 'passages/card-renewal-adult.yaml'), (t) => t.replace('There\'s no charge.', 'It\'s free.'));
    expect(passage(kb, 'late-fees-junior').freshness).toBe('edited');
    expect((await approve(kb, 'late-fees-junior', '--by', 'Jane Smith')).code).toBe(0);
    const first = readFileSync(join(kb, 'approvals.jsonl'), 'utf8');
    expect((await approve(kb, 'card-renewal-adult', '--by', 'Sam Lee', '--owner', 'Branch Services')).code).toBe(0);
    expect(readFileSync(join(kb, 'approvals.jsonl'), 'utf8').startsWith(first)).toBe(true);
    expect(logOf(kb)).toEqual([
      expect.objectContaining({ id: 'late-fees-junior', approvedBy: 'Jane Smith', owner: 'Patron Services', from: 'passage' }),
      expect.objectContaining({ id: 'card-renewal-adult', approvedBy: 'Sam Lee', owner: 'Branch Services', from: 'passage' }),
    ]);
    expect(passage(kb, 'card-renewal-adult')).toMatchObject({ freshness: 'fresh', approval: { owner: 'Branch Services', approvedBy: 'Sam Lee' } });
  });

  it('one already fresh: nothing written; one never approved needs an owner', async () => {
    const kb = kbCopy();
    const text = readFileSync(join(kb, 'passages/opening-hours.yaml'), 'utf8');
    expect(await approve(kb, 'opening-hours', '--by', 'Jane Smith')).toEqual({ code: 0, out: ['opening-hours: already approved and fresh (by Branch Manager on 2025-12-10): nothing written'], err: [] });
    expect(readFileSync(join(kb, 'passages/opening-hours.yaml'), 'utf8')).toBe(text);
    expect(logOf(kb)).toEqual([]);

    edit(join(kb, 'passages/late-fees-junior.yaml'), (t) => t.slice(0, t.indexOf('approval:')));
    expect(passage(kb, 'late-fees-junior').freshness).toBe('unapproved');
    expect(await approve(kb, 'late-fees-junior', '--by', 'Jane Smith')).toMatchObject({
      code: 1,
      err: ['late-fees-junior: refused: "late-fees-junior" has never been approved, so it has no owner yet: give the team that owns its content with --owner "<team>"'],
    });
    expect((await approve(kb, 'late-fees-junior', '--by', 'Jane Smith', '--owner', 'Patron Services')).code).toBe(0);
    expect(passage(kb, 'late-fees-junior')).toMatchObject({ freshness: 'fresh', approval: { owner: 'Patron Services', approvedBy: 'Jane Smith' } });
  });

  it('one approved outside kb:approve (fresh, no line in the log): listed by kb:status, and approved again by a person', async () => {
    const kb = kbCopy();
    const file = join(kb, 'passages/late-fees-junior.yaml');
    // An edit, and an approval written for it by hand: fresh, but no one is on record for it.
    edit(file, (t) => t.replace('There are no late fees on a junior card.', 'A junior card has no late fees.'));
    const { current } = passage(kb, 'late-fees-junior');
    edit(file, (t) => t.replace(/  hash: [0-9a-f]{64}/, `  hash: ${current.hash}`));
    expect(passage(kb, 'late-fees-junior').freshness).toBe('fresh');
    const status = await bin(['kb:status', kb], kb);
    expect(status.out[0]).toBe(`${kb}: 7 passages (6 approved and fresh, 0 stale, 0 unapproved, 1 approved outside kb:approve), 0 pending drafts`);
    expect(status.out.slice(8, 11)).toEqual([
      'approved outside kb:approve, not in kb/approvals.jsonl: pnpm check refuses (1):',
      '  late-fees-junior  2026.1  late_fees  its approval (by Branch Manager on 2025-12-10) was written by hand or copied with its file, so no one is on record for it',
      '    -> review it against kb/sources/patron-guide.yaml section "3.2", then pnpm kb:approve late-fees-junior --by "<your name>"',
    ]);
    expect(status.out.at(-1)).toBe('pnpm check fails while a passage is stale or unapproved; a draft is never said until it is approved');
    const run = await approve(kb, 'late-fees-junior', '--by', 'Jane Smith');
    expect(run.out).toEqual([expect.stringMatching(/^late-fees-junior: approved \(version 2026\.1\) by Jane Smith for Patron Services/)]);
    expect(logOf(kb)).toEqual([expect.objectContaining({ id: 'late-fees-junior', approvedBy: 'Jane Smith', hash: current.hash, from: 'passage' })]);
    expect((await bin(['kb:status', kb], kb)).out.at(-1)).toBe('every passage is approved and fresh, and nothing waits for review');
  });

  it('refuses an id that is no passage or draft, and approves the others it is given', async () => {
    const kb = kbCopy();
    edit(join(kb, 'passages/late-fees-junior.yaml'), (t) => t.replace('There are no late fees on a junior card.', 'A junior card has no late fees.'));
    const run = await approve(kb, 'late-fee-junior', 'late-fees-junior', '../policy', '--by', 'Jane Smith');
    expect(run.code).toBe(1);
    expect(run.err).toEqual([
      'late-fee-junior: refused: there is no passage or draft "late-fee-junior" (kb/passages, kb/locale/<tag>/passages, kb/pending); did you mean "late-fees-junior"?',
      '../policy: refused: "../policy" is not a passage id (letters, digits, underscores, hyphens and dots, starting with a letter or digit)',
    ]);
    expect(run.out).toEqual([expect.stringMatching(/^late-fees-junior: approved \(version 2026\.1\) by Jane Smith/)]);
  });

  it('refuses a passage that would fail check for more than its approval, writing nothing', async () => {
    const kb = kbCopy();
    const file = join(kb, 'passages/late-fees-junior.yaml');
    edit(file, (t) => t.replace('There are no late fees on a junior card.', 'There are no late fees on a junior card, {first}.'));
    const text = readFileSync(file, 'utf8');
    expect(await approve(kb, 'late-fees-junior', '--by', 'Jane Smith')).toEqual({
      code: 1,
      out: [],
      err: [
        'late-fees-junior: refused: it would fail pnpm check: fix these first',
        '  kb/passages/late-fees-junior.yaml:8:9  answer  passage "late-fees-junior"\'s answer has the variable {first}; an answer is fixed text, said word for word  ->  write the answer without braces; a line from the caller\'s own data goes in the topic\'s accountLine in kb/topics.yaml',
      ],
    });
    expect(readFileSync(file, 'utf8')).toBe(text);
    // A problem elsewhere stops it too: the knowledge base does not load.
    edit(file, () => text.replace(', {first}.', '.'));
    edit(join(kb, 'passages/card-renewal-adult.yaml'), (t) => t.replace('topic: card_renewal', 'topic: card_renewals'));
    expect((await approve(kb, 'late-fees-junior', '--by', 'Jane Smith')).err).toEqual(['late-fees-junior: refused: the knowledge base does not load (1 problem elsewhere): fix it first; pnpm check lists it']);
  });
});

describe('kb:approve a draft', () => {
  it('checks it, drops `drafted`, and moves it into passages with its approval, keeping its comments', async () => {
    const kb = kbCopy();
    writeFileSync(join(kb, 'pending/late-fees-junior-2025.yaml'), DRAFT);
    const run = await approve(kb, 'late-fees-junior-2025', '--by', 'Jane Smith', '--owner', 'Patron Services');
    const p = passage(kb, 'late-fees-junior-2025');
    expect(run).toEqual({
      code: 0,
      out: [`late-fees-junior-2025: approved (version 2025.1) by Jane Smith for Patron Services on ${TODAY}: moved the draft kb/pending/late-fees-junior-2025.yaml to kb/passages/late-fees-junior-2025.yaml; sourceHash ${p.approval!.sourceHash.slice(0, 12)}, hash ${p.approval!.hash.slice(0, 12)}; logged in ${join(kb, 'approvals.jsonl')}`],
      err: [],
    });
    expect(existsSync(join(kb, 'pending/late-fees-junior-2025.yaml'))).toBe(false);
    expect(readFileSync(join(kb, 'passages/late-fees-junior-2025.yaml'), 'utf8')).toBe([
      '# yaml-language-server: $schema=../../../../../schemas/kb-passage.schema.json',
      '# Drafted from the patron guide; the 2025 junior fees.',
      ...DRAFT.split('\n').slice(2, 9),
      'approval:',
      '  owner: Patron Services',
      '  approvedBy: Jane Smith',
      `  on: ${TODAY}`,
      `  sourceHash: ${p.approval!.sourceHash}`,
      `  hash: ${p.approval!.hash}`,
      '',
    ].join('\n'));
    expect(p).toMatchObject({ freshness: 'fresh', applies: { card: ['junior'] }, effective: { from: '2025-01-01', to: '2025-12-31' } });
    expect(logOf(kb)).toEqual([{ id: 'late-fees-junior-2025', version: '2025.1', approvedBy: 'Jane Smith', owner: 'Patron Services', on: TODAY, sourceHash: p.approval!.sourceHash, hash: p.approval!.hash, from: 'pending', sourceText: 'Junior cards are not charged late fees.' }]);
  });

  it('a draft in another locale goes to that locale\'s passages', async () => {
    const kb = kbCopy();
    writeFileSync(join(kb, 'pending/late-fees-junior-es.yaml'), DRAFT.replace('id: late-fees-junior-2025', 'id: late-fees-junior-es\nlocale: es\ntranslates: late-fees-junior').replace('effective: { from: 2025-01-01, to: 2025-12-31 }', 'effective: { from: 2026-01-01 }').replace('answer: There are no late fees on a junior card.', 'answer: No hay multas con una tarjeta juvenil.'));
    expect((await approve(kb, 'late-fees-junior-es', '--by', 'Ana Ruiz', '--owner', 'Patron Services')).out[0]).toContain('moved the draft kb/pending/late-fees-junior-es.yaml to kb/locale/es/passages/late-fees-junior-es.yaml');
    expect(readFileSync(join(kb, 'locale/es/passages/late-fees-junior-es.yaml'), 'utf8').split('\n')[0]).toBe('# yaml-language-server: $schema=../../../../../../../schemas/kb-passage.schema.json');
    expect(passage(kb, 'late-fees-junior-es')).toMatchObject({ locale: 'es', freshness: 'fresh', translates: 'late-fees-junior' });
  });

  it('refuses a draft whose excerpt is not in its section word for word, one with no owner, and one that is not a draft, leaving each in pending', async () => {
    const kb = kbCopy();
    const pending = join(kb, 'pending/late-fees-junior-2025.yaml');
    writeFileSync(pending, DRAFT.replace('excerpt: Junior cards are not charged late fees.', 'excerpt: Junior cards are never charged late fees.'));
    expect((await approve(kb, 'late-fees-junior-2025', '--by', 'Jane Smith', '--owner', 'Patron Services')).err).toEqual([
      'late-fees-junior-2025: refused: its excerpt is not in kb/sources/patron-guide.yaml section "3.2" word for word, so the answer cannot be held to its source',
      '  quote the section exactly in drafted.excerpt (or correct source.section), then review the answer against it again',
    ]);
    writeFileSync(pending, DRAFT);
    expect((await approve(kb, 'late-fees-junior-2025', '--by', 'Jane Smith')).err).toEqual([
      'late-fees-junior-2025: refused: "late-fees-junior-2025" is a draft, so it has no owner yet: give the team that owns its content with --owner "<team>"',
    ]);
    writeFileSync(pending, DRAFT.replace('drafted:\n  by: kb:draft (fake drafter)\n  on: 2026-10-02\n  excerpt: Junior cards are not charged late fees.\n', 'approval: { owner: Me }\n'));
    expect((await approve(kb, 'late-fees-junior-2025', '--by', 'Jane Smith', '--owner', 'Patron Services')).err).toEqual([
      'late-fees-junior-2025: refused: kb/pending/late-fees-junior-2025.yaml is not a draft passage',
      '  kb/pending/late-fees-junior-2025.yaml:3:1  drafted  required key "drafted" is missing at the top of the file  ->  add "drafted:" (a map) at the top of the file. Where the draft came from.',
      '  kb/pending/late-fees-junior-2025.yaml:10:1  approval  unknown key "approval" in this file  ->  delete "approval"; the keys allowed in this file are id, topic, version, locale, applies, effective, source, answer, translates, drafted',
    ]);
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(join(kb, 'passages/late-fees-junior-2025.yaml'))).toBe(false);
    expect(logOf(kb)).toEqual([]);
  });

  it('refuses a draft with no excerpt, one too short to hold its answer to, and one missing a number its answer says', async () => {
    const kb = kbCopy();
    const pending = join(kb, 'pending/late-fees-junior-2025.yaml');
    const go = () => approve(kb, 'late-fees-junior-2025', '--by', 'Jane Smith', '--owner', 'Patron Services');
    writeFileSync(pending, DRAFT.replace('  excerpt: Junior cards are not charged late fees.\n', ''));
    expect((await go()).err).toEqual(['late-fees-junior-2025: refused: a draft quotes the words of its source section that support it: add drafted.excerpt']);
    writeFileSync(pending, DRAFT.replace('excerpt: Junior cards are not charged late fees.', 'excerpt: late fees.'));
    expect((await go()).err).toEqual([
      'late-fees-junior-2025: refused: its excerpt cannot hold its answer to its source',
      '  its excerpt "late fees." is too short to hold the answer to: quote at least 4 words and 20 characters of the section',
    ]);
    // The adult fees: the answer's amounts are in the section, but not in the words it quotes.
    const adult = DRAFT.replace('applies: { card: junior }', 'applies: { card: adult }').replace('effective: { from: 2025-01-01, to: 2025-12-31 }', 'effective: { from: 2024-01-01, to: 2024-12-31 }').replace('section: "3.2"', 'section: "3.1"').replace('There are no late fees on a junior card.', 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book.');
    writeFileSync(pending, adult.replace('excerpt: Junior cards are not charged late fees.', 'excerpt: An adult card is charged 25 cents for each day an item is overdue'));
    expect((await go()).err).toEqual([
      'late-fees-junior-2025: refused: its excerpt cannot hold its answer to its source',
      '  its excerpt does not say 5, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes',
    ]);
    expect(existsSync(pending)).toBe(true);
    expect(logOf(kb)).toEqual([]);
    // kb:status says why it cannot be approved as it is.
    expect((await bin(['kb:status', kb], kb)).out).toContain('    ! its excerpt does not say 5, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes');
    // Quoting the whole sentence, with its amounts: approved.
    writeFileSync(pending, adult.replace('excerpt: Junior cards are not charged late fees.', 'excerpt: An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.'));
    expect((await go()).code).toBe(0);
  });

  it('refuses a draft that would fail check (an overlap with a passage in force), or that has a passage\'s id', async () => {
    const kb = kbCopy();
    writeFileSync(join(kb, 'pending/late-fees-junior-2027.yaml'), DRAFT.replace('id: late-fees-junior-2025', 'id: late-fees-junior-2027').replace('effective: { from: 2025-01-01, to: 2025-12-31 }', 'effective: { from: 2027-01-01 }'));
    expect((await approve(kb, 'late-fees-junior-2027', '--by', 'Jane Smith', '--owner', 'Patron Services')).err).toEqual([
      'late-fees-junior-2027: refused: it would fail pnpm check: fix these first',
      '  kb/pending/late-fees-junior-2027.yaml:7:1  effective  passages "late-fees-junior" and "late-fees-junior-2027" are both in force from 2027-01-01 on for the topic "late_fees" (en-US), for callers they share, so which to say is ambiguous  ->  end "late-fees-junior" the day before "late-fees-junior-2027" starts (effective.to), or give the two different applies',
    ]);
    writeFileSync(join(kb, 'pending/late-fees-junior.yaml'), DRAFT.replace('id: late-fees-junior-2025', 'id: late-fees-junior'));
    expect((await approve(kb, 'late-fees-junior', '--by', 'Jane Smith', '--owner', 'Patron Services')).err).toEqual([
      'late-fees-junior: refused: both kb/passages/late-fees-junior.yaml and the draft kb/pending/late-fees-junior.yaml have the id "late-fees-junior": approving the draft would replace the passage',
      '  rename the draft (its file and its id) to a new id, or delete it',
    ]);
  });

  it('in an app folder, refuses a draft in a locale the app does not speak', async () => {
    const dir = folder('library-kb-approve-fr');
    writeFileSync(join(dir, 'kb/pending/late-fees-junior-fr.yaml'), DRAFT.replace('id: late-fees-junior-2025', 'id: late-fees-junior-fr\nlocale: fr\ntranslates: late-fees-junior').replace('effective: { from: 2025-01-01, to: 2025-12-31 }', 'effective: { from: 2026-01-01 }'));
    const run = await bin(['kb:approve', 'late-fees-junior-fr', '--by', 'Jane Smith', '--owner', 'Patron Services'], dir);
    expect(run.err).toEqual([
      'late-fees-junior-fr: refused: it would fail pnpm check: fix these first',
      '  kb/locale/fr:1:1  (file)  the knowledge base has fr passages, but the app does not speak fr  ->  add locale/fr/prompts.yaml to the app, or delete kb/locale/fr',
    ]);
    expect(existsSync(join(dir, 'kb/locale/fr'))).toBe(false);
  });
});

describe('kb:status', () => {
  it('lists the passages by state and the drafts, with the fix for each', async () => {
    const kb = kbCopy();
    edit(join(kb, 'sources/patron-guide.yaml'), (t) => t.replace('for each day an item is overdue, up to 5', 'for every day an item is overdue, up to 5'));
    edit(join(kb, 'passages/late-fees-junior.yaml'), (t) => t.replace('There are no late fees on a junior card.', 'A junior card has no late fees.'));
    edit(join(kb, 'passages/card-renewal-junior.yaml'), (t) => t.slice(0, t.indexOf('approval:')));
    writeFileSync(join(kb, 'pending/late-fees-junior-2025.yaml'), DRAFT);
    writeFileSync(join(kb, 'pending/broken.yaml'), DRAFT.replace('id: late-fees-junior-2025', 'id: broken').replace('excerpt: Junior cards are not charged late fees.', 'excerpt: Junior cards cost nothing.'));
    const run = await bin(['kb:status', kb], kb);
    expect(run).toEqual({
      code: 0,
      err: [],
      out: [
        `${kb}: 7 passages (4 approved and fresh, 2 stale, 1 unapproved), 2 pending drafts`,
        'approved and fresh (4):',
        '  card-renewal-adult  2026.1  card_renewal  approved by Branch Manager (Patron Services) on 2025-12-10',
        '  late-fees-adult-2025  2025.1  late_fees  approved by Branch Manager (Patron Services) on 2025-12-10',
        '  opening-hours  2026.1  opening_hours  approved by Branch Manager (Patron Services) on 2025-12-10',
        '  opening-hours-es  2026.1  opening_hours  approved by Branch Manager (Patron Services) on 2025-12-10',
        'stale, its source changed: withheld (1):',
        '  late-fees-adult  2026.1  late_fees  kb/sources/patron-guide.yaml section "3.1" changed since Branch Manager approved it on 2025-12-10',
        '    -> read the answer against the section\'s text now; correct the answer if the source says something else, then pnpm kb:approve late-fees-adult --by "<your name>"',
        'stale, edited after approval: withheld (1):',
        '  late-fees-junior  2026.1  late_fees  its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line changed since Branch Manager approved it on 2025-12-10 (the source is as approved)',
        '    -> review the edit against kb/sources/patron-guide.yaml section "3.2" (git diff kb/passages/late-fees-junior.yaml), then pnpm kb:approve late-fees-junior --by "<your name>"',
        'unapproved: never said (1):',
        '  card-renewal-junior  2026.1  card_renewal  never approved',
        '    -> review it against kb/sources/patron-guide.yaml section "2.2", then pnpm kb:approve card-renewal-junior --by "<your name>" --owner "<team>"',
        'pending drafts: never said (2):',
        '  broken  late_fees  drafted by kb:draft (fake drafter) on 2026-10-02 from kb/sources/patron-guide.yaml section "3.2"',
        '    ! its excerpt is not in kb/sources/patron-guide.yaml section "3.2" word for word',
        '    -> correct the draft in kb/pending/broken.yaml, then review it',
        '  late-fees-junior-2025  late_fees  drafted by kb:draft (fake drafter) on 2026-10-02 from kb/sources/patron-guide.yaml section "3.2"',
        '    -> review it against its source, then pnpm kb:approve late-fees-junior-2025 --by "<your name>" --owner "<team>"',
        'pnpm check fails while a passage is stale or unapproved; a draft is never said until it is approved',
      ],
    });
  });

  it('lists the topics drafts propose (kb/pending/topics.yaml, never a draft), and passes over rejected drafts', async () => {
    const kb = kbCopy();
    writeFileSync(join(kb, 'pending/topics.yaml'), '# yaml-language-server: $schema=../../../../../schemas/kb-topics.schema.json\nmeeting_rooms:\n  title: Meeting rooms\n  keywords: [meeting room]\n');
    mkdirSync(join(kb, 'rejected'));
    writeFileSync(join(kb, 'rejected/late-fees-junior-2025.yaml'), `${DRAFT}rejected: { by: Jane Smith, on: ${TODAY}, reason: Says nothing new }\n`);
    // A knowledge base with both loads as it did, and pnpm kb:approve takes neither for a draft.
    expect(loadKnowledgeFolder(kb, 'en-US').problems).toEqual([]);
    expect((await approve(kb, 'topics', '--by', 'Jane Smith', '--owner', 'Patron Services')).err[0]).toBe('topics: refused: there is no passage or draft "topics" (kb/passages, kb/locale/<tag>/passages, kb/pending)');
    const run = await bin(['kb:status', kb], kb);
    expect(run.out[0]).toBe(`${kb}: 7 passages (7 approved and fresh, 0 stale, 0 unapproved), 0 pending drafts`);
    expect(run.out.slice(-4)).toEqual([
      'proposed topics, not yet in topics.yaml (1):',
      '  meeting_rooms  "Meeting rooms"',
      '    -> accept, rename or merge each in pnpm kb:review (kb/pending/topics.yaml); a draft of a proposed topic is approved after its topic',
      'pnpm check fails while a passage is stale or unapproved; a draft is never said until it is approved',
    ]);
  });

  it('marks an approval a migration carried over (from: migration in the log), and only while the passage is as migrated', async () => {
    const kb = kbCopy();
    const line = (id: string, from: string, extra: Record<string, string> = {}): string => {
      const p = passage(kb, id);
      return JSON.stringify({ id, version: p.version, approvedBy: p.approval!.approvedBy, owner: p.approval!.owner, on: p.approval!.on, sourceHash: p.approval!.sourceHash, hash: p.approval!.hash, from, ...extra });
    };
    // Appended to the log, as an app's migration script appends its lines.
    writeFileSync(
      join(kb, 'approvals.jsonl'),
      FIXTURE_LOG + [
        line('opening-hours', 'migration', { note: 'content unchanged; migrated from the old format' }),
        line('late-fees-adult', 'migration'),
        'not a line of the log',
        // A later line for the same approval is the one the passage stands on.
        line('card-renewal-adult', 'migration', { note: 'content unchanged' }),
        line('card-renewal-adult', 'passage'),
        '',
      ].join('\n'),
    );
    expect(readApprovalLog(kb).slice(7).map((l) => `${l.id} ${l.from}`)).toEqual(['opening-hours migration', 'late-fees-adult migration', 'card-renewal-adult migration', 'card-renewal-adult passage']);
    const run = await bin(['kb:status', kb], kb);
    expect(run.out.slice(0, 9)).toEqual([
      `${kb}: 7 passages (7 approved and fresh, 0 stale, 0 unapproved), 0 pending drafts`,
      'approved and fresh (7):',
      '  card-renewal-adult  2026.1  card_renewal  approved by Branch Manager (Patron Services) on 2025-12-10',
      '  card-renewal-junior  2026.1  card_renewal  approved by Branch Manager (Patron Services) on 2025-12-10',
      '  late-fees-adult  2026.1  late_fees  approved by Branch Manager (Patron Services) on 2025-12-10  (migrated)',
      '  late-fees-adult-2025  2025.1  late_fees  approved by Branch Manager (Patron Services) on 2025-12-10',
      '  late-fees-junior  2026.1  late_fees  approved by Branch Manager (Patron Services) on 2025-12-10',
      '  opening-hours  2026.1  opening_hours  approved by Branch Manager (Patron Services) on 2025-12-10  (migrated: content unchanged; migrated from the old format)',
      '  opening-hours-es  2026.1  opening_hours  approved by Branch Manager (Patron Services) on 2025-12-10',
    ]);
    // Edited and approved again by a person: the migration no longer stands for it.
    edit(join(kb, 'passages/late-fees-adult.yaml'), (t) => t.replace('25 cents a day', '30 cents a day'));
    expect((await approve(kb, 'late-fees-adult', '--by', 'Jane Smith')).code).toBe(0);
    expect((await bin(['kb:status', kb], kb)).out[4]).toBe(`  late-fees-adult  2026.1  late_fees  approved by Jane Smith (Patron Services) on ${TODAY}`);
  });

  it('says when all is approved and fresh, from the app folder; and why a knowledge base does not load', async () => {
    const dir = folder('library-kb-status');
    const fresh = await bin(['kb:status'], dir);
    expect(fresh.code).toBe(0);
    expect(fresh.out[0]).toBe('kb: 7 passages (7 approved and fresh, 0 stale, 0 unapproved), 0 pending drafts');
    expect(fresh.out.at(-1)).toBe('every passage is approved and fresh, and nothing waits for review');
    edit(join(dir, 'kb/passages/late-fees-junior.yaml'), (t) => t.replace('topic: late_fees', 'topic: late_feez'));
    expect(await bin(['kb:status'], dir)).toEqual({
      code: 1,
      out: [],
      err: [
        'kb: the knowledge base does not load, so its passages\' state cannot be read:',
        '  kb/passages/late-fees-junior.yaml:3:8  topic  passage "late-fees-junior" answers the topic "late_feez", which kb/topics.yaml does not have  ->  rename it to "late_fees", or add "late_feez:" with its title to kb/topics.yaml',
      ],
    });
  });
});

describe('end to end: a passage withheld on a real call until a person approves it again', () => {
  const QUESTION = 'how much is the fee for a late book';
  const UNAVAILABLE = 'I\'m sorry, I don\'t have an answer to that I can give you right now.';
  const OFFER = 'Would you like me to connect you to a librarian, or keep going?';
  const ANSWER = 'Late books on an adult card cost 25 cents a day, up to 5 dollars a book.';
  let built = 0;

  /** The app the folder is now (its kb/ read again), registered under an id of its own; its retriever nominates the late fees for the question. */
  function appOf(dir: string): App {
    built += 1;
    edit(join(dir, 'app.yaml'), (t) => t.replace(/^id: .*$/m, `id: library-kb-e2e-${built}`));
    const app = defineApp(dir, { ...codeFor(dir), knowledge: { retriever: fixedRetriever({ [QUESTION]: ['late_fees'] }) } });
    registerApp(app);
    return app;
  }

  /** A model that answers the questions it is asked as the turn's `answers` say, and the rest as BASE (or the heuristics). */
  function model(app: App): JevClient & { answers: AnswerMap } {
    const heuristic = new HeuristicStubClient({ app, todayIso: TODAY });
    const client = {
      answers: {} as AnswerMap,
      async ask(req: Parameters<JevClient['ask']>[0]) {
        const r = await heuristic.ask(req);
        const given: AnswerMap = { ...BASE, ...client.answers };
        return { ...r, answers: { ...r.answers, ...Object.fromEntries(Object.keys(req.questions).filter((k) => Object.hasOwn(given, k)).map((k) => [k, given[k]!])) } };
      },
    };
    return client;
  }

  interface RealCall {
    app: App;
    session: Session;
    opts: RunOptions;
    client: ReturnType<typeof model>;
  }

  async function start(app: App): Promise<RealCall> {
    const client = model(app);
    // The library's systems, as the call's: the caller's card is an adult's, with 2 dollars of late fees on it.
    const opts: RunOptions = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 1_000, tools: { ...app.systems(), codes: mockCodeVerifier } };
    const greeted = await runTurn(newSession(`${app.id}-call`, 0, VOICE_RELAY, ANONYMOUS, app.id), startEvent(), opts);
    return { app, session: greeted.result.session, opts, client };
  }

  async function turn(c: RealCall, words: string, answers: AnswerMap): Promise<{ run: TurnRun; heard: string }> {
    c.client.answers = answers;
    const run = await runTurn(c.session, speechEvent(words, true), c.opts);
    c.session = run.result.session;
    return { run, heard: spokenText(c.app, run.result.decision, c.session.locale) };
  }

  const asks = (c: RealCall) => turn(c, QUESTION, { intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }) });
  const gate = (run: TurnRun): string[] => run.result.gateEvents.map((e) => `${e.decision.call.tool} ${e.decision.verdict}${e.summary !== null ? `: ${e.summary}` : ''}`);

  it('a source section that changed: withheld, the unavailable line and a person offered once; approved again: said', async () => {
    const dir = folder('library-kb-e2e');
    const before = await start(appOf(dir));
    const said = await asks(before);
    expect(said.heard).toContain(ANSWER);
    expect(said.run.record.kb).toMatchObject({ passageId: 'late-fees-adult', fresh: true, approvedBy: 'Branch Manager' });

    // The patron guide's section 3.1 is reworded: the passage is withheld until someone reads it again.
    edit(join(dir, 'kb/sources/patron-guide.yaml'), (t) => t.replace('for each day an item is overdue, up to 5', 'for every day an item is overdue, up to 5'));
    const stale = await start(appOf(dir));
    const withheld = await asks(stale);
    expect(withheld.run.record.retrieval?.nominated.map((n) => n.topic)).toEqual(['late_fees']);
    expect(gate(withheld.run)).toEqual(['findPassage ALLOW: no passage (stale)']);
    expect(withheld.heard).toBe(`Sure, I can help you answer a question. ${UNAVAILABLE} ${OFFER}`);
    expect(withheld.heard).not.toContain('25 cents');
    // The trace's knowledge record names the passage withheld, as not fresh, and the audit row says the same.
    expect(withheld.run.record.kb).toMatchObject({ passageId: 'late-fees-adult', version: '2026.1', fresh: false });
    expect(withheld.run.result.audit.filter((a) => a.type === 'kb_answer')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ passageId: 'late-fees-adult', fresh: false }) })]);
    // Declined, the caller is not offered a person again when the next answer is withheld too.
    const declined = await turn(stale, 'no thanks', { confirmsYes: noul(0.03), confirmsNo: noul(0.95) });
    expect(declined.run.result.session.transferDeclined).toBe(true);
    const again = await asks(stale);
    expect(again.heard).toBe(`Sure, I can help you answer a question. ${UNAVAILABLE} Is there anything else I can help with?`);

    // A person reads it against the reworded section and approves it again: it is said.
    const approved = await bin(['kb:approve', 'late-fees-adult', '--by', 'Jane Smith'], dir);
    expect(approved.code).toBe(0);
    const after = await asks(await start(appOf(dir)));
    expect(gate(after.run)).toEqual(['findPassage ALLOW: late-fees-adult', 'getFees ALLOW: fees read']);
    expect(after.heard).toBe(`Sure, I can help you answer a question. ${ANSWER} Your card has 2 dollars in late fees right now. Is there anything else I can help with?`);
    expect(after.run.record.kb).toMatchObject({ passageId: 'late-fees-adult', fresh: true, approvedBy: 'Jane Smith', approvedOn: TODAY });
  });

  it('an answer edited after approval: withheld, and recorded as not fresh, until it is approved', async () => {
    const dir = folder('library-kb-e2e-edit');
    edit(join(dir, 'kb/passages/late-fees-adult.yaml'), (t) => t.replace('25 cents a day', '30 cents a day'));
    const withheld = await asks(await start(appOf(dir)));
    expect(gate(withheld.run)).toEqual(['findPassage ALLOW: no passage (stale)']);
    expect(withheld.heard).toBe(`Sure, I can help you answer a question. ${UNAVAILABLE} ${OFFER}`);
    expect(withheld.heard).not.toContain('30 cents');
    expect(withheld.run.record.kb).toMatchObject({ passageId: 'late-fees-adult', fresh: false });
    expect((await bin(['kb:status'], dir)).out).toContain('  late-fees-adult  2026.1  late_fees  its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line changed since Branch Manager approved it on 2025-12-10 (the source is as approved)');
    expect((await bin(['kb:approve', 'late-fees-adult', '--by', 'Jane Smith'], dir)).code).toBe(0);
    const said = await asks(await start(appOf(dir)));
    expect(said.heard).toContain('Late books on an adult card cost 30 cents a day, up to 5 dollars a book.');
    expect(said.run.record.kb).toMatchObject({ passageId: 'late-fees-adult', fresh: true, approvedBy: 'Jane Smith' });
  });
});

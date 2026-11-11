import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addModelPrice } from '../converse/model/price';
import { fakeModel } from '../converse/model/fake';
import type { ModelEvent } from '../converse/model/types';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';
import type { Persona } from './personas';
import { PUBLISHED_LIMIT, RUN_FILE, type RunRecord, type StoredRun } from './report';
import { rejudgeCommand } from './rejudge';

/**
 * eval:rejudge: stored calls judged again under the material-claims rubric, with no call made again. Every
 * judge here is a fake model; nothing reaches a real one.
 */

const JUDGE = 'anthropic:rejudge-test';
addModelPrice(JUDGE, { input: 1, output: 5, source: 'a test, 2026-11-11' });

const personas: Persona[] = [
  { id: 'booker', goal: 'Book a visit on Tuesday.', truth: { name: 'Pat Example' }, manner: 'Plain.', expects: 'booking' },
  { id: 'asker', goal: 'Ask the price.', truth: { name: 'Sam Example' }, manner: 'Plain.', expects: 'answer' },
];

const record = (persona: string, run: number, o: Partial<RunRecord> = {}): RunRecord => ({
  persona, run, today: 'Wednesday, November 11, 2026',
  call: { persona, turns: [{ who: 'line', text: 'Hello.', atMs: 0 }, { who: 'caller', text: `I am ${persona}.`, atMs: 10 }, { who: 'line', text: 'It is $50, and it is booked.', atMs: 900 }], ended: 'caller', firstWordMs: [400], callId: `c-${persona}-${run}` },
  judged: { completed: true, correct: true, unsupportedClaims: ['old claim'], honestWhenAsked: null, repeatedQuestions: 0, notes: '' },
  actions: [{ tool: 'book', params: { day: '2026-11-17' }, verdict: 'ALLOW', result: 'booked (R101)' }],
  agentCostUsd: 0.001, failures: [], cooperative: persona === 'booker', turns: [{ requests: [{ firstMs: 300, ms: 700 }] }],
  ...o,
});

const run = (o: Partial<StoredRun> = {}): StoredRun => ({ app: 'example', business: 'Visits cost $40.', personas, callerModel: 'anthropic:caller-test', decisionClient: 'the heuristic stub', runsPerPersona: 1, lineModel: 'inception:line-test (effort minimal)', timeoutMs: 6000, ...o });

function folder(records: RunRecord[], stored: StoredRun | null = run()): string {
  const dir = mkdtempSync(join(tmpdir(), 'rejudge-'));
  writeFileSync(join(dir, 'results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (stored !== null) writeFileSync(join(dir, RUN_FILE), JSON.stringify(stored));
  return dir;
}

const verdict = (o: Record<string, unknown> = {}): ModelEvent[] => [
  { type: 'tool_call', id: 'v', name: 'verdict', args: { completed: true, correct: false, materialClaims: [{ said: 'It is $50, and it is booked.', kind: 'price', why: 'Visits cost $40.' }], benignClaims: [{ said: 'Hello.', kind: 'friendly', why: 'A greeting.' }], honestWhenAsked: null, repeatedQuestions: 0, notes: 'It quoted a price of its own.', ...o } },
  { type: 'done', stop: 'tool', usage: { inputTokens: 1000, outputTokens: 200 } },
];

function judges(turns: ModelEvent[][]) {
  const model = { ...fakeModel(turns), id: JUDGE };
  return { model, judge: () => model };
}

function io(o: { env?: Record<string, string>; judge?: () => ReturnType<typeof judges>['model'] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), invokedFrom: process.cwd(), env: o.env ?? {}, ...(o.judge ? { judge: o.judge } : {}) } };
}

const readJsonl = (file: string): RunRecord[] => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as RunRecord);

describe('dialogwright eval:rejudge', () => {
  it('refuses in CI', async () => {
    const t = io({ env: { CI: '1' } });
    expect(await rejudgeCommand(['x'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/refused in CI/);
  });

  it('refuses a judge whose price is not known', async () => {
    const t = io();
    expect(await rejudgeCommand([folder([record('booker', 0)]), '--judge', 'anthropic:never-priced-test'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/no price is known for the judge model/);
  });

  it('judges each stored call again, with its transcript, actions, results and day, and writes rejudged/ beside it: no call made again', async () => {
    const dir = folder([record('booker', 0), record('asker', 0)]);
    const j = judges([verdict(), verdict({ correct: true, materialClaims: [], notes: '' })]);
    const t = io({ judge: j.judge });
    expect(await rejudgeCommand([dir, '--judge', JUDGE, '--parallel', '1'], t.io)).toBe(0);
    expect(j.model.requests).toHaveLength(2);
    const asked = JSON.stringify(j.model.requests[0]!.messages);
    for (const part of ['Visits cost $40.', 'Book a visit on Tuesday.', 'It is $50, and it is booked.', 'book(day=2026-11-17): ALLOW; result: booked (R101)', 'Wednesday, November 11, 2026']) expect(asked).toContain(part);
    const again = readJsonl(join(dir, 'rejudged', 'results.jsonl'));
    expect(again.map((r) => [r.persona, r.judged.unsupportedClaims])).toEqual([['booker', ['It is $50, and it is booked.']], ['asker', []]]);
    expect(again[0]!.call).toEqual(record('booker', 0).call);
    const summary = readFileSync(join(dir, 'rejudged', 'summary.md'), 'utf8');
    expect(summary).toContain(`Re-judged by ${JUDGE} from the stored transcripts`);
    expect(summary).toContain('Line: inception:line-test (effort minimal).');
    expect(summary).toContain('| Unsupported material claims (price / time / policy / done) | 1 (1 / 0 / 0 / 0) |');
    expect(summary).toContain('| Benign claims (not counted) | 2 |');
    expect(readFileSync(join(dir, 'results.jsonl'), 'utf8')).toContain('old claim');
  });

  it('keeps a budget: it stops once the judge has spent it, keeping what it judged, and says so', async () => {
    const dir = folder([record('booker', 0), record('asker', 0), record('booker', 1)]);
    const j = judges([verdict(), verdict(), verdict()]);
    const t = io({ judge: j.judge });
    // Each verdict costs $0.002 at the test price: the budget is spent after the first.
    expect(await rejudgeCommand([dir, '--judge', JUDGE, '--budget', '0.001', '--parallel', '1'], t.io)).toBe(0);
    expect(j.model.requests).toHaveLength(1);
    expect(readFileSync(join(dir, 'rejudged', 'summary.md'), 'utf8')).toContain('stopped at the budget');
  });

  it('judges again only what has no verdict yet, so a stopped re-judge goes on where it stopped', async () => {
    const dir = folder([record('booker', 0), record('asker', 0)]);
    await rejudgeCommand([dir, '--judge', JUDGE, '--budget', '0.001', '--parallel', '1'], io({ judge: judges([verdict()]).judge }).io);
    const j = judges([verdict({ materialClaims: [], correct: true })]);
    expect(await rejudgeCommand([dir, '--judge', JUDGE, '--parallel', '1'], io({ judge: j.judge }).io)).toBe(0);
    expect(j.model.requests).toHaveLength(1);
    expect(readJsonl(join(dir, 'rejudged', 'results.jsonl')).map((r) => r.persona).sort()).toEqual(['asker', 'booker']);
  });

  it('re-judges a comparison folder, each candidate\'s results beside it, and writes the table again under the material-claims bar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rejudge-compare-'));
    for (const [sub, line] of [['inception_line-test', 'inception:line-test (effort minimal)'], ['anthropic_other-test', 'anthropic:other-test (effort low)']] as const) {
      mkdirSync(join(root, sub));
      writeFileSync(join(root, sub, 'results.jsonl'), JSON.stringify(record('booker', 0)) + '\n');
      writeFileSync(join(root, sub, RUN_FILE), JSON.stringify(run({ lineModel: line })));
    }
    const j = judges([verdict(), verdict({ materialClaims: [], correct: true })]);
    expect(await rejudgeCommand([root, '--judge', JUDGE, '--parallel', '1'], io({ judge: j.judge }).io)).toBe(0);
    for (const sub of ['inception_line-test', 'anthropic_other-test']) expect(existsSync(join(root, sub, 'rejudged', 'summary.md'))).toBe(true);
    const table = readFileSync(join(root, 'rejudged', 'comparison.md'), 'utf8');
    expect(table).toContain('unsupported material claims ≤ 0');
    expect(table).toMatch(/\| anthropic:other-test \(low\) \|/);
    expect(table).toMatch(/\| inception:line-test \(minimal\) \|/);
    expect(table).toContain(`Re-judged by ${JUDGE}`);
  });

  it('--publish writes the page to commit: no per-call notes, each claim by its sentence alone, the personas\' names withheld', async () => {
    const dir = folder([record('booker', 0)]);
    const j = judges([verdict({ notes: 'Pat Example was told a price of its own.', materialClaims: [{ said: 'It is $50, Pat, and it is booked.', kind: 'price', why: 'Pat was owed $40.' }] })]);
    expect(await rejudgeCommand([dir, '--judge', JUDGE, '--publish'], io({ judge: j.judge }).io)).toBe(0);
    const page = readFileSync(join(dir, 'rejudged', 'summary.md'), 'utf8');
    expect(page).not.toContain('What the judge noted');
    expect(page).not.toContain('owed $40');
    expect(page).not.toContain('Pat');
    expect(page).toContain('- booker (run 1): "It is $50, [name], and it is booked."');
    expect(page).toContain(`- ${PUBLISHED_LIMIT}`);
    // Without it, the author's own page keeps the notes.
    const own = folder([record('booker', 0)]);
    await rejudgeCommand([own, '--judge', JUDGE], io({ judge: judges([verdict({ notes: 'Pat Example was told a price of its own.' })]).judge }).io);
    expect(readFileSync(join(own, 'rejudged', 'summary.md'), 'utf8')).toContain('What the judge noted');
  });

  it('a folder with no run.json needs the app and the personas, and the day where its records have none', async () => {
    const old = folder([record('booker', 0, { today: undefined })], null);
    writeFileSync(join(old, 'summary.md'), '# Simulated callers on example\n\n1 calls over the chat wire, 1 per persona planned. Line: inception:old-test (effort minimal). Caller: anthropic:caller-test. Judge: anthropic:judge-test. Decision model: the real decision model (Jev). Spent: $0.01 of $1.00.\n');
    const t = io({ judge: judges([]).judge });
    expect(await rejudgeCommand([old, '--judge', JUDGE], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/no run\.json: give --app <dir> and --personas <file>/);
    const personasFile = join(old, 'personas.yaml');
    writeFileSync(personasFile, 'personas:\n  - id: booker\n    goal: Book a visit on Tuesday.\n    truth: { name: Pat Example }\n    manner: Plain.\n    expects: booking\n');
    const noDay = io({ judge: judges([]).judge });
    expect(await rejudgeCommand([old, '--judge', JUDGE, '--app', CONVERSE_FIXTURE_DIR, '--personas', personasFile], noDay.io)).toBe(2);
    expect(noDay.err.join('\n')).toMatch(/--today/);
    const j = judges([verdict()]);
    expect(await rejudgeCommand([old, '--judge', JUDGE, '--app', CONVERSE_FIXTURE_DIR, '--personas', personasFile, '--today', '2026-11-11'], io({ judge: j.judge }).io)).toBe(0);
    const asked = JSON.stringify(j.model.requests[0]!.messages);
    expect(asked).toContain(readFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), 'utf8').split('\n').find((l) => l.includes('name:'))!.trim().replace(/"/g, '\\"'));
    expect(asked).toContain('Wednesday, November 11, 2026');
    expect(readFileSync(join(old, 'rejudged', 'summary.md'), 'utf8')).toContain('Line: inception:old-test (effort minimal).');
  });
});

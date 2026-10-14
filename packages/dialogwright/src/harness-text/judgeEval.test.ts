import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../define/cli';
import { loadCassette } from '../jev/cassette';
import type { JevClient, JevRequest } from '../jev/types';
import { renderSpanDriftQuestion, renderSpanDriftState } from '../render/checks';
import { actOf, DEFAULT_CASES_FILE, evaluateCases, judgeRequest, loadJudgeCases, REALISTIC, saidRates, type JudgeCase } from '../render/judgeEval';
import { judgeCassettePath, judgeEvalCommand } from './judgeEvalCommand';

/**
 * `render:judge-eval` (live findings item 23): the case file, the three readers, the report, and the
 * command recording into a cassette and replaying it. No model is asked: the judge is a fake client.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-judge-eval-'));
  scratch.push(dir);
  return dir;
};
/** A made-up key, so the tests can hold that it is never printed. */
const FAKE_KEY = 'fake-judge-key-0000';

/** A judge that answers from the span said: 0.9 where `unfaithful` lists it, else 0.1; or that fails. */
function fakeJudge(unfaithful: ReadonlySet<string>, opts: { fail?: string } = {}): JevClient & { asked: number } {
  const judge = {
    asked: 0,
    async ask(req: JevRequest) {
      judge.asked++;
      if (opts.fail !== undefined) throw new Error(opts.fail);
      const said = (req.state as { span: { said: string } }).span.said;
      return { answers: { renderSpanDrift: { type: 'noul' as const, noul: unfaithful.has(said) ? 0.9 : 0.1 } }, model: 'jev-1.13.0', usage: { inputTokens: 10, outputTokens: 1, estimated: false }, latencyMs: 1, source: 'jev' as const };
    },
  };
  return judge;
}

const line = (c: Partial<JudgeCase> & Pick<JudgeCase, 'id'>): string => JSON.stringify({ family: 'realistic', expected: 'faithful', speaks: 'as-caller', content: 'call me back about the invoice', span: 'call me about the invoice', note: 'a test case', ...c });

/** A small case file: two everyday read-backs, a slip, and a hard case of each kind. */
function smallCases(dir: string): string {
  const path = join(dir, 'cases.jsonl');
  writeFileSync(path, [
    line({ id: 'r-1' }),
    line({ id: 'r-2', speaks: 'to-caller', names: { recipient: 'Sam Ortiz' }, content: 'I need to move my meeting to Thursday', span: 'you need to move your meeting to Thursday' }),
    line({ id: 'r-slip', expected: 'unfaithful', content: "I'm running late, I'll be there at two", span: "I'm running late" }),
    line({ id: 'h-neg', family: 'dropped-negation', expected: 'unfaithful', content: 'send the samples, not the originals', span: 'send the samples and the originals' }),
    line({ id: 'h-ok', family: 'faithful-paraphrase', content: "it's not urgent, call me when you can", span: 'no rush, call me when you can' }),
  ].join('\n') + '\n');
  return path;
}

function io(env: Record<string, string | undefined>, judge?: JevClient) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), invokedFrom: tempDir(), env, ...(judge ? { judge } : {}) }, out, err };
}

describe('the case file', () => {
  const cases = loadJudgeCases(DEFAULT_CASES_FILE);

  it('parses, balanced: unfaithful and faithful cases, an everyday family of its own, both perspectives', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    const count = (f: (c: JudgeCase) => boolean): number => cases.filter(f).length;
    expect(count((c) => c.expected === 'unfaithful')).toBeGreaterThanOrEqual(40);
    expect(count((c) => c.expected === 'faithful')).toBeGreaterThanOrEqual(40);
    expect(count((c) => c.family === REALISTIC && c.expected === 'faithful')).toBeGreaterThanOrEqual(30);
    expect(count((c) => c.family === REALISTIC && c.expected === 'unfaithful')).toBeGreaterThanOrEqual(5);
    for (const speaks of ['as-caller', 'to-caller'] as const) expect(count((c) => c.speaks === speaks), speaks).toBeGreaterThanOrEqual(20);
    for (const family of ['dropped-negation', 'dropped-condition', 'dropped-detail', 'role-swap', 'gender-swap', 'added-claim', 'injection']) {
      expect(count((c) => c.family === family && c.expected === 'unfaithful'), family).toBeGreaterThan(0);
    }
  });

  it('holds invented data only: every phone number in the 555 range', () => {
    for (const c of cases) {
      for (const text of [c.content, c.span]) {
        for (const run of text.match(/\d[\d -]{5,}\d/g) ?? []) expect(run.replace(/\D/g, '').startsWith('555') || run.startsWith('555'), `${c.id}: ${run}`).toBe(true);
      }
    }
  });

  it('refuses a line that is not JSON, a case missing a field, an id given twice, and names on a span in the caller\'s own terms', () => {
    const dir = tempDir();
    const bad = (lines: string[]): string => {
      const path = join(dir, `bad-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(path, lines.join('\n'));
      return path;
    };
    expect(() => loadJudgeCases(bad(['{']))).toThrow(/:1: not JSON/);
    expect(() => loadJudgeCases(bad([JSON.stringify({ id: 'x', family: 'realistic', expected: 'faithful', speaks: 'as-caller', content: 'a', note: 'n' })]))).toThrow(/:1: span/);
    expect(() => loadJudgeCases(bad([line({ id: 'a' }), line({ id: 'a' })]))).toThrow(/:2: the id a is given twice/);
    expect(() => loadJudgeCases(bad([line({ id: 'a', names: { recipient: 'Sam Ortiz' } })]))).toThrow(/names are for a to-caller span only/);
    expect(() => loadJudgeCases(bad([line({ id: 'a', expected: 'maybe' as never })]))).toThrow(/expected/);
    expect(() => loadJudgeCases(bad(['']))).toThrow(/no cases/);
  });

  it('sends the judge what a call sends: the span\'s state and its question, to-caller with its names', () => {
    const toCaller = cases.find((c) => c.id === 'role-01')!;
    const act = actOf(toCaller);
    expect(act).toMatchObject({ kind: 'span', speaks: 'to-caller', names: [{ name: 'recipient', value: 'Sam Ortiz' }], content: [{ name: 'message', value: toCaller.content }] });
    expect(judgeRequest(toCaller)).toEqual({ state: renderSpanDriftState(act, toCaller.span), questions: renderSpanDriftQuestion('to-caller') });
    const plain = actOf(cases.find((c) => c.speaks === 'as-caller')!);
    expect('speaks' in plain || 'names' in plain).toBe(false);
  });
});

describe('the readers', () => {
  const byId = new Map(loadJudgeCases(DEFAULT_CASES_FILE).map((c) => [c.id, c]));

  it('puts each case to the full checks, the core checks, the stub\'s judge and the judge', async () => {
    const picked = ['neg-09', 'role-01', 'gen-01', 'val-01', 'cond-02', 'real-02a'].map((id) => byId.get(id)!);
    const results = await evaluateCases(picked, fakeJudge(new Set(['you can sign'])));
    const got = Object.fromEntries(results.map((r) => [r.case.id, { code: r.code, core: r.core, judge: r.judge }]));
    // A "no" about a person, who owes whom, a gender, a condition: the full checks' alone.
    expect(got['neg-09']).toEqual({ code: 'negation', core: null, judge: { p: 0.9 } });
    expect(got['role-01']).toMatchObject({ code: 'person', core: null });
    expect(got['gen-01']).toMatchObject({ code: 'person', core: null });
    expect(got['cond-02']).toMatchObject({ code: 'omitted', core: null });
    // Another day: both.
    expect(got['val-01']).toMatchObject({ code: 'foreign', core: 'foreign' });
    expect(got['real-02a']).toEqual({ code: null, core: null, judge: { p: 0.1 } });
    expect(results.find((r) => r.case.id === 'role-01')!.stub).toBe(true);
  });

  it('a span that is its content\'s own words is said unchanged, as on a call, and counts as said', async () => {
    const same: JudgeCase = { id: 'same', family: REALISTIC, expected: 'faithful', speaks: 'as-caller', content: 'Call me back.', span: 'call me back', note: 'n' };
    const [r] = await evaluateCases([same], fakeJudge(new Set(['call me back'])));
    expect(r!.code).toBe('unchanged');
    expect(saidRates([r!])).toMatchObject({ fullAndJudge: 1, coreAndJudge: 1, judgeAlone: 1, fullAlone: 1 });
  });

  it('stops asking after three failures running, keeping the reason with the key masked', async () => {
    const cases = loadJudgeCases(smallCases(tempDir()));
    const judge = fakeJudge(new Set(), { fail: `HTTP 401 for ${FAKE_KEY}` });
    const results = await evaluateCases(cases, judge, { redact: (s) => s.split(FAKE_KEY).join('***') });
    expect(judge.asked).toBe(3);
    expect(results.map((r) => r.judge)).toEqual([...Array(3).fill({ error: 'HTTP 401 for ***' }), ...Array(2).fill({ error: 'not asked: the judge failed 3 cases running (HTTP 401 for ***)' })]);
  });
});

describe('render:judge-eval', () => {
  it('records the judge\'s answers into a cassette beside the cases, tables the everyday cases first, and never prints the key', async () => {
    const dir = tempDir();
    const cases = smallCases(dir);
    const judge = fakeJudge(new Set(["I'm running late", 'send the samples and the originals', 'no rush, call me when you can']));
    const run = io({ TYPESAFE_API_KEY: FAKE_KEY }, judge);
    const out = join(dir, 'report.md');
    expect(await judgeEvalCommand(['--cases', cases, '--out', out], run.io)).toBe(0);
    expect(judge.asked).toBe(5);
    const cassette = judgeCassettePath(cases, 'jev-1.13.0');
    expect(cassette).toBe(join(dir, 'recorded', 'jev-1.13.0.jsonl'));
    expect(loadCassette(cassette).size).toBe(5);
    const text = run.out.join('\n');
    expect(text.indexOf('## Everyday messages')).toBeLessThan(text.indexOf('## The hard cases, by family'));
    // Two good read-backs, both said whichever checks run; the slip caught by the judge.
    expect(text).toContain('with the full code checks and the judge 2 of 2 (100%); with the core code checks and the judge 2 of 2 (100%); with the judge alone 2 of 2 (100%)');
    expect(text).toMatch(/\| h-ok \| faithful-paraphrase \| as-caller \| faithful \| negation \| negation \| passed \| 0\.90 \|/);
    expect(text).toContain('## Faithful spans the judge refused (1)');
    expect(text).toContain('"it\'s not urgent, call me when you can" read back "no rush, call me when you can"');
    // The report written is the one printed (between the run's first line and its last, which says where it was written).
    expect(readFileSync(out, 'utf8')).toBe(`${run.out.slice(2, -1).join('\n')}\n`);
    expect(run.out.at(-1)).toBe(`written to ${out}`);
    expect([...run.out, ...run.err].join('\n')).not.toContain(FAKE_KEY);

    // Recording again asks nothing the cassette has.
    const again = fakeJudge(new Set());
    expect(await judgeEvalCommand(['--cases', cases], io({ TYPESAFE_API_KEY: FAKE_KEY }, again).io)).toBe(0);
    expect(again.asked).toBe(0);
  });

  it('--replay tables the cassette with no key; a case it lacks is "not recorded" and the run exits 1', async () => {
    const dir = tempDir();
    const cases = smallCases(dir);
    expect(await judgeEvalCommand(['--cases', cases], io({ TYPESAFE_API_KEY: FAKE_KEY }, fakeJudge(new Set(["I'm running late"]))).io)).toBe(0);
    const replay = io({});
    expect(await judgeEvalCommand(['--cases', cases, '--replay', '--json'], replay.io)).toBe(0);
    const json = JSON.parse(replay.out.join('\n')) as { replay: boolean; cases: { id: string; judge: unknown }[]; realisticSaid: { fullAndJudge: number } };
    expect(json.replay).toBe(true);
    expect(json.cases.find((c) => c.id === 'r-slip')!.judge).toEqual({ p: 0.9 });
    expect(json.realisticSaid.fullAndJudge).toBe(2);
    writeFileSync(cases, readFileSync(cases, 'utf8') + line({ id: 'new', span: 'call about the invoice' }) + '\n');
    const stale = io({});
    expect(await judgeEvalCommand(['--cases', cases, '--replay'], stale.io)).toBe(1);
    expect(stale.out.join('\n')).toContain('5 of 6 answered, 1 not recorded (record them: the command without --replay)');
  });

  it('refuses to record in CI, and without the decision model\'s key, naming the variable', async () => {
    const dir = tempDir();
    const cases = smallCases(dir);
    const ci = io({ CI: 'true', TYPESAFE_API_KEY: FAKE_KEY }, fakeJudge(new Set()));
    expect(await judgeEvalCommand(['--cases', cases], ci.io)).toBe(1);
    expect(ci.err.join('\n')).toContain('it does not record in CI');
    const noKey = io({});
    expect(await judgeEvalCommand(['--cases', cases], noKey.io)).toBe(1);
    expect(noKey.err.join('\n')).toContain("recording needs the decision model's key, TYPESAFE_API_KEY");
    expect(existsSync(join(dir, 'recorded'))).toBe(false);
    // A replay in CI is allowed: it asks nothing (here nothing is recorded, so each case is "not recorded").
    const replay = io({ CI: 'true' });
    expect(await judgeEvalCommand(['--cases', cases, '--replay'], replay.io)).toBe(1);
    expect(replay.err.join('\n')).not.toContain('does not record in CI');
    expect(replay.out.join('\n')).toContain('0 of 5 answered, 5 not recorded');
  });

  it('answers a command line it does not understand, and a case file it cannot read', async () => {
    const bogus = io({});
    expect(await judgeEvalCommand(['--bogus'], bogus.io)).toBe(2);
    expect(bogus.err[0]).toContain('usage: dialogwright render:judge-eval');
    const missing = io({});
    expect(await judgeEvalCommand(['--replay', '--cases', 'nowhere.jsonl'], missing.io)).toBe(1);
    expect(missing.err.join('\n')).toMatch(/nowhere\.jsonl/);
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(['render:judge-eval', '--bogus'], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: tempDir(), env: {} })).toBe(2);
    expect(err[0]).toContain('usage: dialogwright render:judge-eval');
  });
});

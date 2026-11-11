import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimsCassettePath, claimsEvalCommand } from '../harness-text/claimsEvalCommand';
import { JevClientError, type AnswerMap, type JevClient, type JevRequest } from '../jev/types';
import { CassetteClient } from '../jev/cassette';
import current from './claimsVariants/current';
import { askVariant, averagePrecision, formatClaimsEval, latencyOf, loadCases, loadLabels, loadVariant, measure, type ClaimsCase, type ClaimsLabel, type ClaimsVariant } from './claimsEval';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (name = 'run'): string => {
  const d = join(mkdtempSync(join(tmpdir(), 'claims-eval-')), name);
  mkdirSync(d);
  dirs.push(d);
  return d;
};

/** Reads by reply: contradicted, notDone, gap; a reply listed as 'fails' makes the model err. */
type Read = [number, number, number] | 'fails';
function fakeJev(reads: Record<string, Read>): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      const reply = (req.state as { reply: string }).reply;
      const r = reads[reply];
      if (r === undefined || r === 'fails') throw new JevClientError('down');
      const answers: AnswerMap = { contradicted: { type: 'noul', noul: r[0] }, notDone: { type: 'noul', noul: r[1] }, gap: { type: 'noul', noul: r[2] } };
      return { answers, model: 'fake', usage: { inputTokens: 1, outputTokens: 1, estimated: true }, latencyMs: 1, source: 'jev' };
    },
  };
}

const kase = (id: string, reply: string): ClaimsCase => ({ id, state: { business: 'B', today: 'Wednesday, November 11, 2026 (2026-11-11)', actions: [], reply } });
const label = (id: string, wrong: boolean, severity: number, kinds: string[], gap = false): ClaimsLabel => ({ id, wrong, severity, kinds, gap, why: '' });

// A wrong at .9, B wrong at .6, C wrong (missed) at .2, D right but .8, E right at .1, F wrong and unread, G unlabelled.
const CASES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => kase(`run/${id}`, `reply ${id}`));
const READS: Record<string, Read> = { 'reply A': [0.9, 0.1, 0.1], 'reply B': [0.2, 0.6, 0.1], 'reply C': [0.2, 0.1, 0.8], 'reply D': [0.8, 0.1, 0.1], 'reply E': [0.1, 0.1, 0.1], 'reply F': 'fails', 'reply G': [0.5, 0.5, 0.5] };
const LABELS = new Map([
  label('run/A', true, 3, ['price']), label('run/B', true, 1, ['time']), label('run/C', true, 2, ['price'], true),
  label('run/D', false, 0, []), label('run/E', false, 0, []), label('run/F', true, 2, ['done']),
].map((l) => [l.id, l]));

describe('averagePrecision', () => {
  it('is the mean of the precision at each positive, the unread positives counting last', () => {
    // ranked: pos, neg, pos, pos, neg; 4 positives in all (one unread).
    const scored = [{ score: 0.9, positive: true }, { score: 0.8, positive: false }, { score: 0.6, positive: true }, { score: 0.2, positive: true }, { score: 0.1, positive: false }];
    expect(averagePrecision(scored, 4)).toBeCloseTo((1 + 2 / 3 + 3 / 4) / 4, 6);
    expect(averagePrecision(scored, 0)).toBeNull();
  });

  it('shares one precision among tied scores', () => {
    expect(averagePrecision([{ score: 0.5, positive: true }, { score: 0.5, positive: false }], 1)).toBeCloseTo(0.5, 6);
  });
});

describe('measure', () => {
  it('counts recall, precision, unread, severity and kind on a hand-made set, and skips the unlabelled', async () => {
    const answers = await askVariant(fakeJev(READS), current, CASES, { timeoutMs: 1000 });
    const r = measure(CASES, LABELS, [{ variant: current, answers }]);
    expect(r).toMatchObject({ cases: 7, labelled: 6, unlabelled: 1, wrong: 4, gap: 1, orphanLabels: 0 });
    const wrong = r.rules.find((x) => x.rule === 'contradictedOrNotDone')!;
    expect(wrong).toMatchObject({ cases: 6, scored: 5, unread: 1, positives: 4 });
    const at = (t: number) => wrong.thresholds.find((x) => x.threshold === t)!;
    expect(at(0.5)).toMatchObject({ flagged: 3, tp: 2, fp: 1, fn: 2 });
    expect(at(0.5).recall).toBeCloseTo(0.5, 6);
    expect(at(0.5).precision).toBeCloseTo(2 / 3, 6);
    expect(at(0.7)).toMatchObject({ flagged: 2, tp: 1, fp: 1, fn: 3 });
    expect(at(0.9)).toMatchObject({ flagged: 1, tp: 1, fp: 0, fn: 3 });
    // Severity 2 or more: A, C and F; at 0.5 only A is flagged.
    expect(wrong.severeRecall.positives).toBe(3);
    expect(wrong.severeRecall.at[2]).toBeCloseTo(1 / 3, 6);
    expect(wrong.kindRecall.map((k) => [k.kind, k.positives])).toEqual([['done', 1], ['price', 2], ['time', 1]]);
    expect(wrong.kindRecall.find((k) => k.kind === 'price')!.at[2]).toBeCloseTo(0.5, 6);
    expect(wrong.averagePrecision).toBeCloseTo((1 + 2 / 3 + 3 / 4) / 4, 6);
    // The gap rule: C is the one case with a gap, read at .8.
    const gap = r.rules.find((x) => x.rule === 'gap')!;
    expect(gap).toMatchObject({ target: 'gap', positives: 1, scored: 5, unread: 1 });
    expect(gap.thresholds.find((x) => x.threshold === 0.8)).toMatchObject({ flagged: 1, tp: 1, fn: 0, recall: 1, precision: 1 });
    // The table of wrong and gap cases: each with its scores under each rule, and no words of the call.
    expect(r.wrongCases.map((c) => c.id)).toEqual(['run/A', 'run/B', 'run/C', 'run/F']);
    expect(r.wrongCases[0]!.scores).toEqual({ 'current/contradictedOrNotDone': 0.9, 'current/gap': 0.1 });
    expect(r.wrongCases[3]!.scores['current/contradictedOrNotDone']).toBeNull();
    const text = formatClaimsEval(r).join('\n');
    expect(text).toContain('| run/A | wrong | price | 3 | 0.90 | 0.10 |');
    expect(text).toContain('unread 1');
    expect(text).not.toContain('reply A');
  });

  it('scores a rule on its own variant\'s questions: two variants, one request each per case', async () => {
    const other: ClaimsVariant = { name: 'narrow', questions: { x: { type: 'noul', instructions: 'x' } }, rules: { first: { target: 'wrong', score: (a) => (a.contradicted?.type === 'noul' ? 1 - a.contradicted.noul : null) } } };
    const jev = fakeJev(READS);
    await askVariant(jev, current, CASES.slice(0, 2), { timeoutMs: 1000 });
    await askVariant(jev, other, CASES.slice(0, 2), { timeoutMs: 1000 });
    expect(jev.asked.map((a) => Object.keys(a.questions).join())).toEqual(['contradicted,notDone,gap', 'contradicted,notDone,gap', 'x', 'x']);
  });

  it('asks identical requests that are in flight together once', async () => {
    const jev = fakeJev(READS);
    await askVariant(jev, current, [kase('a/1', 'reply A'), kase('b/1', 'reply A')], { timeoutMs: 1000 });
    expect(jev.asked).toHaveLength(1);
  });

  it('gives the median and p95 of live request times', () => {
    expect(latencyOf('v', [])).toBeNull();
    expect(latencyOf('v', [10, 20, 30, 40, 100])).toEqual({ variant: 'v', requests: 5, medianMs: 30, p95Ms: 100 });
  });
});

describe('the files', () => {
  it('prefixes case ids with the folder, takes the latest business line, and refuses an id that is not unique', () => {
    const a = folder('one');
    const b = folder('two');
    const row = (id: string) => JSON.stringify({ id, persona: 'p', run: 0, turn: 0, today: 'T', actions: [], reply: `r ${id}`, reading: null });
    writeFileSync(join(a, 'claims-cases.jsonl'), [JSON.stringify({ v: 1, business: 'B1' }), row('p-0/t0'), JSON.stringify({ v: 1, business: 'B2' }), row('p-0/t1')].join('\n') + '\n');
    writeFileSync(join(b, 'claims-cases.jsonl'), [JSON.stringify({ v: 1, business: 'B1' }), row('p-0/t0')].join('\n') + '\n');
    const cases = loadCases([join(a, 'claims-cases.jsonl'), join(b, 'claims-cases.jsonl')]);
    expect(cases.map((c) => c.id)).toEqual(['one/p-0/t0', 'one/p-0/t1', 'two/p-0/t0']);
    expect((cases[0]!.state as { business: string }).business).toBe('B1');
    expect((cases[1]!.state as { business: string }).business).toBe('B2');
    expect(Object.keys(cases[0]!.state as object).sort()).toEqual(['actions', 'business', 'reply', 'today']);
    expect(() => loadCases([join(a, 'claims-cases.jsonl'), join(a, 'claims-cases.jsonl')])).toThrow(/not unique/);
  });

  it('loads a variant module, and the current one is the runtime\'s own questions', async () => {
    const v = await loadVariant(join(__dirname, 'claimsVariants', 'current.ts'));
    expect(v.name).toBe('current');
    expect(Object.keys(v.rules)).toEqual(['contradictedOrNotDone', 'gap']);
    expect(v.rules.contradictedOrNotDone!.target).toBe('wrong');
    await expect(loadVariant(join(__dirname, 'claims.ts'))).rejects.toThrow(/default export/);
  });
});

describe('dialogwright converse:claims-eval', () => {
  function setup() {
    const dir = folder('calls');
    const rows = CASES.map((c, i) => JSON.stringify({ id: `p-0/t${i}`, persona: 'p', run: 0, turn: i, today: 'T', actions: [], reply: (c.state as { reply: string }).reply, reading: null }));
    writeFileSync(join(dir, 'claims-cases.jsonl'), [JSON.stringify({ v: 1, business: 'B' }), ...rows].join('\n') + '\n');
    const labels = join(dir, 'labels.jsonl');
    writeFileSync(labels, [...LABELS.values()].map((l) => JSON.stringify({ ...l, id: `calls/p-0/t${CASES.findIndex((c) => c.id === l.id)}` })).join('\n') + '\n');
    return { dir, cases: join(dir, 'claims-cases.jsonl'), labels };
  }
  const variantFile = join(__dirname, 'claimsVariants', 'current.ts');
  // The cases' texts are in the state, so the fake reads by reply: calls' replies are 'reply A'...
  const io = (dir: string, extra: { judge?: JevClient; env?: Record<string, string> }) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l), invokedFrom: dir, env: extra.env ?? { TYPESAFE_API_KEY: 'test-value' }, ...(extra.judge !== undefined ? { judge: extra.judge } : {}) } };
  };

  it('records into a cassette beside the labels, then replays it with no key and no request, to the same report', async () => {
    const { dir, cases, labels } = setup();
    const jev = fakeJev(READS);
    const rec = io(dir, { judge: jev });
    // F fails, so the recording exits 1 (a request unanswered) but reports it unread.
    expect(await claimsEvalCommand(['--cases', cases, '--labels', labels, '--variant', variantFile], rec.io)).toBe(1);
    expect(jev.asked).toHaveLength(6);
    expect(readFileSync(claimsCassettePath(labels), 'utf8').trim().split('\n')).toHaveLength(5);
    const report = rec.out.join('\n');
    expect(report).toContain('Cases scored 5 of 6, unread 1');
    expect(report).toContain('Live requests');
    // Replayed: nothing asked, no key; the one case the cassette lacks is unread again.
    const again = fakeJev(READS);
    const rep = io(dir, { env: {}, judge: again });
    expect(await claimsEvalCommand(['--cases', cases, '--labels', labels, '--variant', variantFile, '--replay', '--json'], rep.io)).toBe(1);
    expect(again.asked).toHaveLength(0);
    const json = JSON.parse(rep.out.join('\n')) as { rules: { rule: string; scored: number; averagePrecision: number }[]; latency: unknown[] };
    expect(json.rules[0]!.scored).toBe(5);
    expect(json.rules[0]!.averagePrecision).toBeCloseTo((1 + 2 / 3 + 3 / 4) / 4, 6);
    expect(json.latency).toEqual([]);
  });

  it('refuses to record in CI and without a key, and needs its three options', async () => {
    const { dir, cases, labels } = setup();
    const args = ['--cases', cases, '--labels', labels, '--variant', variantFile];
    const ci = io(dir, { env: { CI: '1' } });
    expect(await claimsEvalCommand(args, ci.io)).toBe(1);
    expect(ci.err.join('\n')).toMatch(/does not record in CI/);
    const nokey = io(dir, { env: {} });
    expect(await claimsEvalCommand(args, nokey.io)).toBe(1);
    expect(nokey.err.join('\n')).toMatch(/needs the decision model's key, TYPESAFE_API_KEY/);
    expect(await claimsEvalCommand(['--labels', labels], io(dir, {}).io)).toBe(2);
  });

  it('replays a cassette written by a CassetteClient directly (the file format is the repository\'s)', async () => {
    const { dir, cases, labels } = setup();
    const path = claimsCassettePath(labels);
    const rec = new CassetteClient({ path, mode: 'record', inner: fakeJev(READS), answeredBy: { provider: 'typesafe', model: 'fake', official: true } });
    await askVariant(rec, current, loadCases([cases]).filter((c) => c.id !== 'calls/p-0/t5'), { timeoutMs: 1000 });
    const rep = io(dir, { env: {} });
    expect(await claimsEvalCommand(['--cases', cases, '--labels', labels, '--variant', variantFile, '--replay'], rep.io)).toBe(1);
    expect(rep.out.join('\n')).toContain('Cases scored 5 of 6, unread 1');
  });
});

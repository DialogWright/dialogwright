import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from './sweep';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CassetteClient } from '../jev/cassette';
import { loadCorpus } from '../jev/corpus';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { runAll } from './runAll';
import { writeExpected, REGRESS_TODAY } from './baseline';
import { useTestkit } from '../testing/apps';

useTestkit();

// Two of three entries answer the part-of-day question, so their fill can be pushed below the fill
// threshold; the third (a request for a person) never differs and is what keeps both counts above 0.
const CORPUS = [
  '{"id":"t-1","text":"in the morning","intent":"none","context":"delivery_window","prompted":"deliveryPart","slots":{"deliveryPart":"morning"}}',
  '{"id":"t-2","text":"afternoon","intent":"none","context":"delivery_window","prompted":"deliveryPart","slots":{"deliveryPart":"afternoon"}}',
  '{"id":"t-3","text":"i want to talk to a person","intent":"agent","context":"no_form"}',
].join('\n') + '\n';

// Same ids and text as CORPUS -- the cassette key is state plus questions, not corpus content, so
// a recording made from this corpus still replays cleanly against CORPUS below -- but the
// deliveryPart answer is overridden so its top probability (0.5) lands between SLOT_CHOICE_CONFIRM
// (0.45) and the default SLOT_CHOICE_FILL (0.55): at the default the part of the day is not taken and
// the question is asked again, so the fill (a decision field) differs from the baseline until
// SLOT_CHOICE_FILL drops to 0.5 or below.
const SOFT_CORPUS = [
  '{"id":"t-1","text":"in the morning","intent":"none","context":"delivery_window","prompted":"deliveryPart","slots":{"deliveryPart":"morning"},"answers":{"deliveryPart":{"probabilities":{"morning":0.5}}}}',
  '{"id":"t-2","text":"afternoon","intent":"none","context":"delivery_window","prompted":"deliveryPart","slots":{"deliveryPart":"afternoon"},"answers":{"deliveryPart":{"probabilities":{"afternoon":0.5}}}}',
  '{"id":"t-3","text":"i want to talk to a person","intent":"agent","context":"no_form"}',
].join('\n') + '\n';

describe('runSweep', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    writeFileSync(join(dir, 'corpus.jsonl'), CORPUS);
    mkdirSync(join(dir, 'scenarios'));
    writeFileSync(join(dir, 'scenarios', 'core.json'), '[]\n');
    const corpus = loadCorpus(join(dir, 'corpus.jsonl'));
    const thresholds = { ...DEFAULT_THRESHOLDS };
    const stub = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const base = await runAll(corpus, [], { client: stub, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeExpected({ corpus: base.corpus, scenarios: base.scenarios }, join(dir, 'expected'));
    writeFileSync(join(dir, 'corpus-soft.jsonl'), SOFT_CORPUS);
    const softCorpus = loadCorpus(join(dir, 'corpus-soft.jsonl'));
    const soft = new FixtureStubClient(softCorpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const recorder = new CassetteClient({ path: join(dir, 'cassette.jsonl'), mode: 'record', inner: soft });
    await runAll(softCorpus, [], { client: recorder, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeFileSync(join(dir, 'thresholds.ts'), readFileSync('src/core/thresholds.ts', 'utf8'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = (over: object) => ({
    corpusFile: join(dir, 'corpus.jsonl'), scenariosDir: join(dir, 'scenarios'), expectedDir: join(dir, 'expected'),
    cassette: join(dir, 'cassette.jsonl'), only: ['SLOT_CHOICE_FILL' as const], passes: 3, apply: false,
    thresholdsFile: join(dir, 'thresholds.ts'), reportDir: join(dir, 'tuning'), json: null, ...over,
  });

  it('lowers SLOT_CHOICE_FILL to the plateau center and explains the move', async () => {
    const r = await runSweep(config({}));
    expect(r.result.before).toMatchObject({ primary: 1, secondary: 1 });
    expect(r.result.after).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.moves).toHaveLength(1);
    expect(r.result.moves[0]).toMatchObject({ name: 'SLOT_CHOICE_FILL', from: DEFAULT_THRESHOLDS.SLOT_CHOICE_FILL, to: 0.45, reason: 'primary', plateau: { from: 0.45, to: 0.5 } });
    expect(r.result.moves[0]!.flips.gained).toEqual(['t-1', 't-2']);
    expect(r.result.moves[0]!.flips.lost).toEqual([]);
    // Below SLOT_CHOICE_CONFIRM (0.45) the constraint SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL forbids the value.
    expect(r.result.table.SLOT_CHOICE_FILL?.points.find((p) => p.value === 0.4)?.status).toBe('skipped');
    // Above the stub's own deliveryPart probability (0.9 at STUB_SHARPNESS), the plain corpus's fresh
    // stub run stops taking the part of the day too, and no longer matches the DEFAULT_THRESHOLDS baseline.
    expect(r.result.table.SLOT_CHOICE_FILL?.points.find((p) => p.value === 0.95)?.status).toBe('breaks_stub');
    expect(r.result.converged).toBe(true);
    expect(r.result.evaluations).toBe(new Set(r.result.table.SLOT_CHOICE_FILL?.points.filter((p) => p.status !== 'skipped')).size);
    expect(r.misses).toEqual([]);
  });

  it('stops on a stale cassette when only the injection screen missed, since the screen fails open', async () => {
    // Drop the screen's answers: perception still replays, and each turn would look answered.
    const path = join(dir, 'cassette.jsonl');
    const kept = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '' && !('manipulation' in JSON.parse(l).answers));
    writeFileSync(path, kept.join('\n') + '\n');
    await expect(runSweep(config({}))).rejects.toThrow(/stale cassette: corpus entry t-1/);
  });

  it('applies the result to the thresholds file and writes the report', async () => {
    const r = await runSweep(config({ apply: true, json: join(dir, 'logs', 'out.json') }));
    expect(readFileSync(join(dir, 'thresholds.ts'), 'utf8')).toContain('  SLOT_CHOICE_FILL: 0.45,');
    const report = readFileSync(r.reportPath!, 'utf8');
    expect(report).toContain(`pass 1: SLOT_CHOICE_FILL ${DEFAULT_THRESHOLDS.SLOT_CHOICE_FILL.toFixed(2)} -> 0.45`);
    expect(report).toContain(`passes ${r.result.passes} (converged)`);
    expect(report).toContain(`evaluations ${r.result.evaluations}`);
    // --json created its parent directory rather than failing on a path that does not exist yet
    const json = JSON.parse(readFileSync(join(dir, 'logs', 'out.json'), 'utf8'));
    expect(json.moves).toHaveLength(1);
    expect(json).toMatchObject({ converged: true, evaluations: r.result.evaluations });
  });

  it('writes a second report beside the first rather than over it', async () => {
    const first = await runSweep(config({ apply: true }));
    const second = await runSweep(config({ apply: true }));
    expect(second.reportPath).toBe(first.reportPath!.replace(/\.md$/, '-2.md'));
    expect(existsSync(first.reportPath!)).toBe(true);
  });
});

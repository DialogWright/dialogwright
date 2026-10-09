import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SHORT_TMP, withShortTmp } from '../testing/shortTmp';

/**
 * The regression run's command line, end to end on the testkit (`pnpm --filter dialogwright
 * regress:testkit ...`): `--corpus <id> --json`, a line's model answers against a cassette, the
 * triage line after a run against one, and the app's settings file. The testkit has no cassette, so
 * every replayed turn misses: nothing is recorded, and no model is called.
 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = realpathSync(join(PACKAGE_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
const scratch = mkdtempSync(join(SHORT_TMP, 'dialogwright-regress-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A settings file for the run, so no .env or model variable of this machine's reaches it. */
function settings(text: string): string {
  const path = join(scratch, `settings-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(path, text);
  return path;
}

function regress(args: string[], envFile = settings(''), launcher = 'src/testing/testkit/regress.ts'): { code: number | null; stdout: string; stderr: string } {
  const env = Object.fromEntries(Object.entries(withShortTmp()).filter(([key]) => !key.startsWith('VITEST') && key !== 'FORCE_COLOR' && !/^(JEV_|TYPESAFE_|OPENROUTER_|AI_GATEWAY_)/.test(key)));
  const r = spawnSync(process.execPath, [TSX, launcher, ...args], {
    cwd: PACKAGE_DIR,
    env: { ...env, NO_COLOR: '1', ENV_FILE: envFile },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const baseline = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(PACKAGE_DIR, 'src', 'testing', 'testkit', 'fixtures', 'expected', file), 'utf8')) as Record<string, unknown>;

describe('regress --json', () => {
  it("prints a corpus line's outcome alone, as the baseline file holds it, to paste", () => {
    const r = regress(['--corpus', 'tk-01', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ 'tk-01': baseline('corpus.json')['tk-01'] }, null, 2)}\n`);
  });

  it("prints a scripted call's outcome as scenarios.json holds it", () => {
    const r = regress(['--scenario', 'track-other-customers-parcel', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ 'track-other-customers-parcel': baseline('scenarios.json')['track-other-customers-parcel'] });
  });

  it('needs one kind of id, and says so', () => {
    for (const args of [['--json'], ['--json', '--corpus', 'tk-01', '--scenario', 'track-other-customers-parcel']]) {
      const r = regress(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--json prints one baseline file's entries");
      expect(r.stdout).toBe('');
    }
  });

  it('keeps stdout to the JSON against a cassette, and exits 1 for an outcome the model did not answer', () => {
    const r = regress(['--client', 'recorded', '--corpus', 'tk-01', '--json']);
    expect(r.code).toBe(1);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain('model jev-1.13.0 from typesafe, replayed from its cassette');
    expect(r.stderr).toMatch(/tk-01: the client did not answer a turn \(cassette miss/);
  });
});

describe('regress against a cassette', () => {
  it("reads the settings file, shows a corpus line's model answers, and on a whole run ends with what to triage", () => {
    const file = settings('JEV_MODEL=example-testkit-model\n');
    const line = regress(['--client', 'recorded', '--corpus', 'tk-01'], file);
    expect(line.stderr).toContain(`settings from ${file} (1 set)`);
    expect(line.stdout).toContain('model example-testkit-model from typesafe, replayed from its cassette');
    expect(line.stdout).toMatch(/\n {2}model answers: none \(cassette miss/);

    const run = regress(['--client', 'recorded'], file);
    expect(run.code).toBe(1);
    const last = run.stdout.trimEnd().split('\n').at(-1)!;
    expect(last).toMatch(/^to triage: \d+ untagged corpus differences, \d+ failing scripted calls, \d+ passing scripted calls? that differs? from the baseline, \d+ cassette misses$/);
    const misses = /cassette misses (\d+)\n/.exec(run.stdout)?.[1];
    expect(last).toContain(`, ${misses} cassette misses`);
  });

  it('a stub run reads no settings file, shows no model answers and prints no triage line', () => {
    const file = settings('JEV_MODEL=example-testkit-model\n');
    const run = regress([], file);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).not.toContain('settings from');
    expect(run.stdout).not.toContain('to triage');
    expect(regress(['--corpus', 'tk-01'], file).stdout).not.toContain('model answers');
  });
});

describe('regress with the adversarial suite (app.yaml testing.adversarial)', () => {
  const ON = 'src/testing/testkit/regressAdversarial.ts';

  it('an app that does not turn it on runs as before: no word of it', () => {
    const run = regress([]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).not.toContain('adversarial');
  });

  it('on the stub, it runs after the baseline and holds every case', () => {
    const run = regress([], settings(''), ON);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('no changes');
    expect(run.stdout).toMatch(/\nadversarial (\d+)\/\1 cases hold, \d+ not run {2}\(injection \d+\/\d+, relationship \d+\/\d+, off-scope \d+\/\d+, spoken-code \d+\/\d+, hostile-reply \d+\/\d+\)\n/);
    expect(run.stdout).not.toContain('FAIL');
  });

  it('against a recording that has none of its answers, lists its cases as not yet recorded, failing none', () => {
    const run = regress(['--client', 'recorded'], settings(''), ON);
    expect(run.stdout).toMatch(/\nadversarial \d+\/\d+ cases hold, \d+ not yet recorded/);
    expect(run.stdout).toContain("not yet recorded (they are recorded with the app's next --client record): injection/open/ignore-instructions/correct/en");
    expect(run.stdout).not.toContain('FAIL adversarial');
  });

  it('--adversarial <id> shows the cases it starts, turn by turn, whether or not the app turns the suite on', () => {
    const run = regress(['--adversarial', 'injection/open/ignore-instructions/correct']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('adversarial injection/open/ignore-instructions/correct/en');
    expect(run.stdout).toContain('screen: quarantined');
    expect(run.stdout).toMatch(/\n {2}hold\n/);
    const wrong = regress(['--adversarial', 'injection/opne']);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('no adversarial case "injection/opne"; did you mean');
  });
});

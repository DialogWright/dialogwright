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

function regress(args: string[], envFile = settings('')): { code: number | null; stdout: string; stderr: string } {
  const env = Object.fromEntries(Object.entries(withShortTmp()).filter(([key]) => !key.startsWith('VITEST') && key !== 'FORCE_COLOR' && !/^(JEV_|TYPESAFE_|OPENROUTER_|AI_GATEWAY_)/.test(key)));
  const r = spawnSync(process.execPath, [TSX, 'src/testing/testkit/regress.ts', ...args], {
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

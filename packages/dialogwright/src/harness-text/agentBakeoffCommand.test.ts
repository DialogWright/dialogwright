import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_BAKEOFF_USAGE, agentBakeoffCommand } from './agentBakeoffCommand';

/**
 * `agent:bakeoff` as its author runs it, on an invented library's cases (../agent/fixture/): the keys from
 * the environment or a settings file, never printed; recording refused in CI; the recordings beside the
 * cases (or where --recorded says); and a recording made through the real provider over a fake fetch (no
 * model is asked) replayed into the same table.
 */

const FIXTURE = fileURLToPath(new URL('../agent/fixture/library.cases.yaml', import.meta.url));
const KEY = 'sk-test-not-a-real-key';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agent-bakeoff-'));
  dirs.push(d);
  return d;
};
/** The fixture's cases in a folder of their own, where the recordings go beside them. */
const casesHere = (): { dir: string; file: string } => {
  const dir = scratch();
  copyFileSync(FIXTURE, join(dir, 'cases.yaml'));
  return { dir, file: join(dir, 'cases.yaml') };
};

function io(extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), invokedFrom: scratch(), ...extra }, out, err };
}

/** An OpenAI-compatible API that answers every turn with nothing understood, but the `fails`th request (from 1), which it refuses. */
function fakeApi(fails?: number): { fetchFn: typeof fetch; asked: () => number; keys: string[] } {
  let n = 0;
  const keys: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    n += 1;
    keys.push(String((init?.headers as Record<string, string>).authorization));
    if (n === fails) return new Response(JSON.stringify({ error: { message: `overloaded, key ${KEY}` } }), { status: 503 });
    const answer = { reply: 'Happy to help with that.', values: [], action: 'none', fromFacts: false };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked: () => n, keys };
}

/** The table a run printed: from the line under its header to the end, less what it says it wrote. */
const tableOf = (out: readonly string[]): string[] => out.slice(out.indexOf('') + 1).filter((l) => !l.startsWith('written to')).map((l) => l.replace(', replayed from their cassettes', ''));

describe('agent:bakeoff', () => {
  it('needs its cases; refuses to record in CI; names every missing key, never a value', async () => {
    const { file } = casesHere();
    const none = io({ env: {} });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3'], none.io)).toBe(2);
    expect(none.err.join('\n')).toContain('--cases <file>');
    const ci = io({ env: { CI: 'true', INCEPTION_API_KEY: KEY } });
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3:instant:realtime'], ci.io)).toBe(1);
    expect(ci.err.join('\n')).toContain('does not record in CI');
    const keys = io({ env: {} });
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3,openrouter:vendor/model'], keys.io)).toBe(1);
    expect(keys.err.join('\n')).toContain('INCEPTION_API_KEY (inception:mercury-3)');
    expect(keys.err.join('\n')).toContain('OPENROUTER_API_KEY (openrouter:vendor/model)');
    const bad = io({ env: {} });
    expect(await agentBakeoffCommand(['--cases', join(scratch(), 'missing.yaml'), '--models', 'inception:mercury-3', '--replay'], bad.io)).toBe(1);
  });

  it('reads the key from the settings file beside it (ENV_FILE unset), never printing it', async () => {
    const envDir = scratch();
    writeFileSync(join(envDir, '.env'), `INCEPTION_API_KEY=${KEY}\n`);
    const api = fakeApi();
    const { file } = casesHere();
    // No io.env: the settings file is read into the process's environment, put back as it was after.
    const run = io({ envDir, fetchFn: api.fetchFn });
    const saved = { ...process.env };
    try {
      delete process.env.INCEPTION_API_KEY;
      delete process.env.ENV_FILE;
      delete process.env.CI;
      expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3:instant:realtime', '--examples', 'off'], run.io)).toBe(0);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(api.keys.every((k) => k === `Bearer ${KEY}`)).toBe(true);
    expect([...run.out, ...run.err].join('\n')).not.toContain(KEY);
    expect(run.err.join('\n')).toContain('settings from');
  });

  it('records beside the cases through the provider, a failed request included, a turn once; its replay tables alike, asking nothing', async () => {
    const { dir, file } = casesHere();
    // The first request is the warm-up; the fourth, a turn of the cases, fails.
    const api = fakeApi(4);
    const rec = io({ env: { INCEPTION_API_KEY: KEY }, fetchFn: api.fetchFn });
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3:low:realtime', '--examples', 'both', '--price', 'mercury-3=0.25,1', '--by-turn'], rec.io)).toBe(0);
    expect(readdirSync(join(dir, 'recorded'))).toEqual(['inception__mercury-3.low.realtime.jsonl']);
    const recording = readFileSync(join(dir, 'recorded', 'inception__mercury-3.low.realtime.jsonl'), 'utf8');
    expect(recording).not.toContain(KEY);
    expect(api.asked()).toBe(1 + 2 * 8);
    expect(rec.out.join('\n')).toContain('warm-up, 1 request before the first turn asked (not in the table)');
    const table = tableOf(rec.out.filter((l) => !l.includes('warm-up')));
    expect(table.join('\n')).toContain('7/8 (88%)');
    expect(table.join('\n')).toContain('1 failed request, not answered: inception: HTTP 503');
    expect(table.join('\n')).toMatch(/\$0\.\d{4}/);

    // Recording again asks only the turn that failed (and the warm-up before it).
    const again = io({ env: { INCEPTION_API_KEY: KEY }, fetchFn: api.fetchFn });
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3:low:realtime', '--examples', 'on'], again.io)).toBe(0);
    expect(api.asked()).toBe(1 + 2 * 8 + 2);

    // A replay of the first recording's file, as it was, tables as the recording did.
    const before = join(scratch(), 'recorded');
    mkdirSync(before);
    writeFileSync(join(before, 'inception__mercury-3.low.realtime.jsonl'), recording);
    const out = join(scratch(), 'agent-bakeoff.md');
    const replay = io({ env: {} });
    expect(await agentBakeoffCommand(['--cases', file, '--recorded', before, '--models', 'inception:mercury-3:low:realtime', '--replay', '--price', 'mercury-3=0.25,1', '--by-turn', '--out', out], replay.io)).toBe(0);
    expect(tableOf(replay.out)).toEqual(table);
    expect(existsSync(out)).toBe(true);
  });

  it('prints one turn\'s prompt and asks nothing; refuses a command line it does not understand', async () => {
    const { file } = casesHere();
    const p = io({ env: {} });
    expect(await agentBakeoffCommand(['--cases', file, '--print-prompt'], p.io)).toBe(0);
    expect(p.out.join('\n')).toContain('hold-request, turn 2');
    expect(p.out.join('\n')).toContain('<critical_rules>');
    expect(p.out.join('\n')).toContain('Example Library');
    const bad = io({ env: {} });
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'mercury-3'], bad.io)).toBe(2);
    expect(bad.err.join('\n')).toContain(AGENT_BAKEOFF_USAGE);
    expect(await agentBakeoffCommand(['--cases', file, '--models', 'inception:mercury-3', '--examples', 'maybe'], io({ env: {} }).io)).toBe(2);
  });
});

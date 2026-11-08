import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_BAKEOFF_USAGE, agentBakeoffCommand } from './agentBakeoffCommand';

/**
 * `agent:bakeoff` as its author runs it: the keys from the environment or a settings file, never
 * printed; recording refused in CI; and a recording made through a fake provider (no model is asked)
 * replayed into the same table.
 */

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

function io(extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), invokedFrom: scratch(), ...extra }, out, err };
}

/** An OpenAI-compatible API that answers every turn with nothing understood. */
function fakeApi(): { fetchFn: typeof fetch; asked: () => number; keys: string[] } {
  let n = 0;
  const keys: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    n += 1;
    keys.push(String((init?.headers as Record<string, string>).authorization));
    const answer = { reply: 'Happy to help with that.', values: [], action: 'none', fromFacts: false };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked: () => n, keys };
}

describe('agent:bakeoff', () => {
  it('refuses to record in CI, and names every missing key, never a value', async () => {
    const ci = io({ env: { CI: 'true', INCEPTION_API_KEY: KEY } });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3:instant:realtime'], ci.io)).toBe(1);
    expect(ci.err.join('\n')).toContain('does not record in CI');
    const none = io({ env: {} });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3,openrouter:inception/mercury-3'], none.io)).toBe(1);
    expect(none.err.join('\n')).toContain('INCEPTION_API_KEY (inception:mercury-3)');
    expect(none.err.join('\n')).toContain('OPENROUTER_API_KEY (openrouter:inception/mercury-3)');
  });

  it('reads the key from the settings file beside it (ENV_FILE unset), never printing it', async () => {
    const envDir = scratch();
    writeFileSync(join(envDir, '.env'), `INCEPTION_API_KEY=${KEY}\n`);
    const api = fakeApi();
    const recordedDir = scratch();
    // No io.env: the settings file is read into the process's environment, put back as it was after.
    const run = io({ envDir, recordedDir, fetchFn: api.fetchFn });
    const saved = { ...process.env };
    try {
      delete process.env.INCEPTION_API_KEY;
      delete process.env.ENV_FILE;
      delete process.env.CI;
      expect(await agentBakeoffCommand(['--models', 'inception:mercury-3:instant:realtime', '--examples', 'off'], run.io)).toBe(0);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(api.keys.every((k) => k === `Bearer ${KEY}`)).toBe(true);
    expect([...run.out, ...run.err].join('\n')).not.toContain(KEY);
    expect(run.err.join('\n')).toContain('settings from');
  });

  it('records through the provider, a turn once, then replays the same table asking nothing', async () => {
    const recordedDir = scratch();
    const api = fakeApi();
    const rec = io({ env: { INCEPTION_API_KEY: KEY }, recordedDir, fetchFn: api.fetchFn });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3:low:realtime', '--examples', 'both', '--price', 'mercury-3=0.25,1'], rec.io)).toBe(0);
    expect(readdirSync(recordedDir)).toEqual(['inception__mercury-3.low.realtime.jsonl']);
    const asked = api.asked();
    expect(asked).toBeGreaterThan(10);
    const table = rec.out.slice(rec.out.indexOf('') + 1);
    expect(table.join('\n')).toContain('no examples');
    expect(table.join('\n')).toMatch(/\$0\.\d{4}/);

    // Recording again asks nothing already recorded.
    const again = io({ env: { INCEPTION_API_KEY: KEY }, recordedDir, fetchFn: api.fetchFn });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3:low:realtime', '--price', 'mercury-3=0.25,1'], again.io)).toBe(0);
    expect(api.asked()).toBe(asked);

    const out = join(scratch(), 'agent-bakeoff.md');
    const replay = io({ env: {}, recordedDir });
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3:low:realtime', '--replay', '--price', 'mercury-3=0.25,1', '--out', out], replay.io)).toBe(0);
    expect(replay.out.slice(replay.out.indexOf('') + 1).filter((l) => !l.startsWith('written to'))).toEqual(table.map((l) => l.replace(/^agent models on (.*?);/, (m) => m.replace(';', ', replayed from their cassettes;'))));
    expect(existsSync(out)).toBe(true);
  });

  it('prints one turn\'s prompt and asks nothing; refuses a command line it does not understand', async () => {
    const p = io({ env: {} });
    expect(await agentBakeoffCommand(['--print-prompt'], p.io)).toBe(0);
    expect(p.out.join('\n')).toContain('<critical_rules>');
    expect(p.out.join('\n')).toContain('Example Wheel Works');
    const bad = io({ env: {} });
    expect(await agentBakeoffCommand(['--models', 'mercury-3'], bad.io)).toBe(2);
    expect(bad.err.join('\n')).toContain(AGENT_BAKEOFF_USAGE);
    expect(await agentBakeoffCommand(['--models', 'inception:mercury-3', '--examples', 'maybe'], io({ env: {} }).io)).toBe(2);
  });
});

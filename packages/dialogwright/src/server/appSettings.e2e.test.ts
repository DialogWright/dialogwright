import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { routedApp } from '../testing/routed/app';
import { HeuristicStubClient } from '../jev/heuristicStub';

/**
 * An app's code reads its own settings by name with ctx.env (AppContext.env, a tool's and a predicate's),
 * on a server of one app: the server's environment, as the server reads the app's YAML `env.` values
 * from (overrides.env in a test, else process.env). The routed fixture's vip predicate reads
 * VIP_NUMBERS; its host-file case (the app's own settings file) is in host.e2e.test.ts.
 */

resetAppsForTest();
registerApp(routedApp);

/** A weekday morning in the routed app's time zone, inside its hours (11:00 in New York). */
const OPEN = Date.parse('2026-09-18T15:00:00Z');
/** The routed app's own variables: invented numbers, 555 range. */
const APP_ENV: Env = { MAIN_LINE: '+15555550201', AFTER_HOURS_DESK: '+15555550202', VIP_DESK: '+15555550203', SPANISH_LINE: '+15555550312' };
const VIP_LINE = 'Welcome back. Let me connect you to your team.';
const GREETING = 'Thanks for calling Example Service Line. I can take a report of a problem, or check on a request. How can I help?';

let running: RunningServer | null = null;
const dirs: string[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(env: Env): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'app-settings-'));
  dirs.push(dir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
  });
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: () => {}, now: () => OPEN, env });
  return `ws://127.0.0.1:${running.port}`;
}

/** A call from `from` to the service line: its first line. */
async function firstLine(ws: string, callSid: string, from: string): Promise<string> {
  const token = running!.tokens.mint(callSid, 'twilio') as string;
  const relay = await FakeRelay.connect(`${ws}/conversation/twilio?token=${token}`);
  relays.push(relay);
  relay.setup(callSid, `VX-${callSid}`, { from, to: '+15555550311' });
  return (await relay.waitForTexts(1))[0]!;
}

describe('a server of one app: its code reads its settings with ctx.env', () => {
  it('the vip predicate reads VIP_NUMBERS from the server\'s environment, at call time', async () => {
    const ws = await start({ ...APP_ENV, VIP_NUMBERS: '+15555550100,+15555550177' });
    expect(await firstLine(ws, 'CA00000000000000000000000000000001', '+15555550177')).toBe(VIP_LINE);
    expect(await firstLine(ws, 'CA00000000000000000000000000000002', '+15555550178')).toBe(GREETING);
  });

  it('unset, the predicate finds no setting, and the call is greeted', async () => {
    const ws = await start({ ...APP_ENV });
    expect(await firstLine(ws, 'CA00000000000000000000000000000003', '+15555550177')).toBe(GREETING);
  });
});

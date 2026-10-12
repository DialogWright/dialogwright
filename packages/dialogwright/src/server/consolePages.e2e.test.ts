import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { loadHost, type HostRouting } from './host';
import { FakeRelay } from '../testing/fakeRelay';
import { registerTestkit } from '../testing/testkit';
import { callbackApp } from '../testing/callback/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { HealthAnswer, InsightsAnswer, KnowledgeApp } from './dashboard/routes';

/**
 * The console's Insights, Knowledge and Health pages over a host of two apps with calls (Console 2):
 * the callback app (the default, no knowledge base) and the utility (its kb/ approved by people), each
 * call placed through the server as a carrier places it, the figures read back from the traces the
 * server wrote, each in its own app's words, the carrier's minutes priced by its rate.
 */

resetAppsForTest();
registerApp(callbackApp);
registerTestkit();

const dirs: string[] = [];
const relays: FakeRelay[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function host(): Promise<HostRouting> {
  const dir = mkdtempSync(join(tmpdir(), 'console-pages-host-'));
  dirs.push(dir);
  const callback = fileURLToPath(new URL('../testing/callback', import.meta.url));
  const utility = fileURLToPath(new URL('../../../../apps/utility', import.meta.url));
  writeFileSync(join(dir, 'utility.env'), 'HANDOFF_NUMBER=+15555550499\n');
  writeFileSync(join(dir, 'callback.env'), 'MAIN_LINE=+15555550101\nPRIORITY_LINE=+15555550102\nCALLBACK_DESK=+15555550103\nSECURITY_DESK=+15555550104\n');
  writeFileSync(join(dir, 'host.yaml'), [
    'apps:',
    `  - { folder: ${relative(dir, callback)}, env: callback.env }`,
    `  - { folder: ${relative(dir, utility)}, env: utility.env }`,
    'numbers:',
    '  - { number: env.POWER_LINE, app: utility }',
    'default: callback',
    '',
  ].join('\n'));
  delete process.env.DIALOGWRIGHT_REQUIRE_EMBEDDER;
  return loadHost(join(dir, 'host.yaml'), { POWER_LINE: '+15555550330' });
}

const form = (params: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

async function call(base: string, ws: string, callSid: string, to: string): Promise<FakeRelay> {
  const doc = await (await fetch(`${base}/voice/twilio`, form({ CallSid: callSid, From: '+15555550110', To: to, CallStatus: 'ringing' }))).text();
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  const parameters = Object.fromEntries([...doc.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((p) => [p[1]!, p[2]!]));
  const relay = await FakeRelay.connect(`${ws}${m[1]}?token=${m[2]}`);
  relays.push(relay);
  relay.setup(callSid, `VX-${callSid}`, { to, customParameters: parameters });
  await relay.waitForTexts(1);
  return relay;
}

async function say(relay: FakeRelay, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    const n = relay.texts().length;
    relay.prompt(line);
    await relay.waitFor(() => relay.texts().length > n || relay.received.some((x) => x.type === 'end'), 4000);
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('Insights, Knowledge and Health over a host of two apps', () => {
  it('every app\'s calls, or one app\'s; each in its own words; the carrier priced; the knowledge base counted; this server\'s health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-pages-'));
    dirs.push(dir);
    const config = loadConfig({
      PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0', JEV_CLIENT: 'stub',
      CARRIER_RATE_PER_MIN_TWILIO: '0.02',
    });
    running = await startServer(config, { host: '127.0.0.1', apps: await host(), log: () => {} });
    const base = `http://127.0.0.1:${running.port}`;
    const ws = `ws://127.0.0.1:${running.port}`;
    const from = Date.now() - 3_600_000;

    // The utility: an answer from its knowledge base, then the caller hangs up.
    const asked = await call(base, ws, 'CA0000000000000000000000000000pg1', '+15555550330');
    await say(asked, ['how do outage credits work', 'do you sell gift cards for the holidays?']);
    // A hang-up, as the carrier does it: the socket closes, then the callback.
    asked.close();
    await new Promise((r) => setTimeout(r, 100));
    await fetch(`${base}/cr-action/twilio`, form({ CallSid: 'CA0000000000000000000000000000pg1', CallStatus: 'completed', SessionStatus: 'ended' }));
    // The callback app: a person asked for.
    const person = await call(base, ws, 'CA0000000000000000000000000000pg2', '+15555550999');
    await say(person, ['can I talk to a person']);
    await person.waitFor((m) => m.type === 'end');
    await fetch(`${base}/cr-action/twilio`, form({ CallSid: 'CA0000000000000000000000000000pg2', CallStatus: 'completed', SessionStatus: 'ended' }));
    await new Promise((r) => setTimeout(r, 100));
    const to = Date.now() + 60_000;

    const all = (await (await fetch(`${base}/dashboard/insights?from=${from}&to=${to}`)).json()) as InsightsAnswer;
    expect(all.insights.totals.calls).toBe(2);
    expect(all.insights.totals.ended).toBe(2);
    expect(all.insights.totals.hungUp).toBe(1);
    expect(all.insights.abandoned.map((r) => r.app)).toEqual(['Example Power & Light']);
    expect(all.insights.totals.toPerson).toBe(1);
    expect(all.insights.transfers.map((r) => r.app)).toEqual(['Example Callbacks']);
    // Both calls came in on Twilio, which has a rate: every minute priced.
    expect(all.insights.carrier).toMatchObject({ byCarrier: [{ carrier: 'twilio', minutes: 2, ratePerMin: 0.02, usd: 0.04 }], unpriced: 0 });
    expect(all.knowledge).toEqual({ apps: 1, command: 'pnpm kb:gaps' });
    // Nothing a caller said or gave.
    const text = JSON.stringify(all);
    for (const said of ['outage credits work', 'gift cards', 'talk to a person', '5555550110']) expect(text).not.toContain(said);

    const one = (await (await fetch(`${base}/dashboard/insights?from=${from}&to=${to}&app=utility`)).json()) as InsightsAnswer;
    expect(one.insights.totals.calls).toBe(1);
    expect(one.insights.transfers).toEqual([]);

    const k = (await (await fetch(`${base}/dashboard/knowledge`)).json()) as { apps: KnowledgeApp[] };
    const byId = Object.fromEntries(k.apps.map((x) => [x.id, x]));
    expect(byId.callback!.status.kind).toBe('none');
    expect(byId.utility!.status.kind).toBe('kb');
    expect(byId.utility!.status.passages!.total).toBeGreaterThan(0);
    expect(byId.utility!.status.passages!.fresh).toBe(byId.utility!.status.passages!.total);
    expect(byId.utility!.status.drafts).not.toBeNull();
    // The question nothing answered, counted by kb:gaps' rules under its nearest topic (none), never its words.
    expect(byId.utility!.unanswered).toMatchObject({ total: 1, top: [{ topic: '~', label: 'no near topic', n: 1 }] });
    expect(all.insights.totals.gapKinds).toEqual({ unmatched: 1 });
    expect(JSON.stringify(k)).not.toContain('gift cards');

    const h = (await (await fetch(`${base}/dashboard/health`)).json()) as HealthAnswer;
    expect(h.shared).toBe(false);
    expect(h.servers).toHaveLength(1);
    expect(h.servers[0]).toMatchObject({ self: true, calls: 0 });
    expect(h.numbers).toMatchObject({ sessions: 0 });
    expect(h.latency.asks).toBeGreaterThan(0);
    const verified = (await (await fetch(`${base}/dashboard/health/audit`)).json()) as { ok: boolean; kind: string; chains: number };
    expect(verified).toMatchObject({ ok: true, kind: 'files' });
    expect(verified.chains).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, loadHost, type HostRouting } from './host';
import { FakeRelay } from '../testing/fakeRelay';
import { registerTestkit, testkitApp } from '../testing/testkit';
import { callbackApp } from '../testing/callback/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { serviceResultEvent } from '../channel/events';
import type { ServiceResolveOptions } from '../core/app/types';
import type { AuditEntry } from '../audit/types';
import type { ServerMessage } from '../channel/chat/protocol';

/**
 * A host's apps each doing their own work, in an app that is NOT the default (the reviewer's C1: every
 * app's tools ran against the default app's systems): with JEV_CLIENT=stub, each app's own client (its
 * corpus, its heuristics). In the routed fixture app (the host fixture's second app): a write (a report
 * filed), a read behind identity held to the caller's own account (the scope rule's lookup is routed's),
 * a handoff put through to its own transfer target, on Twilio and on Telnyx, and the same on its chat.
 * In the testkit as a second app (a host built in code, the callback app its default): identity with a
 * one-time code, a write, a downstream service request sent to the testkit's own URL (host.yaml's
 * `services`), and its chat.
 */

// The registry's default is the callback app (as a host's default is registered first), which has no
// account or birth date: a record masked by the default app's slots in place of its own app's would show them.
resetAppsForTest();
registerApp(callbackApp);
registerTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };
const ORIGIN = 'https://www.example.com';
const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
/** Monday 2026-10-12 at 10:00 in New York, inside the routed app's hours (its scripted calls' time). */
const MORNING = Date.parse('2026-10-12T14:00:00Z');
/** The same day at 16:30 in New York: the billing desk still open. */
const AFTERNOON = Date.parse('2026-10-12T20:30:00Z');

let host: HostRouting;
beforeAll(async () => {
  host = await loadHost(FIXTURE, { ...NUMBERS });
}, 60_000);

const dirs: string[] = [];
const relays: FakeRelay[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(apps: HostRouting, now: number, extra: Env = {}): Promise<{ base: string; ws: string; dir: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'host-apps-'));
  dirs.push(dir);
  const logs: string[] = [];
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: new Date(now).toISOString().slice(0, 10), TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, NO_INPUT_MS: '0',
    // Each app's own stub: its corpus, its heuristics (no client override, so the server builds one per app).
    JEV_CLIENT: 'stub',
    VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY,
    ...extra,
  });
  running = await startServer(config, { host: '127.0.0.1', apps, log: (l) => logs.push(l), now: () => now });
  return { base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, dir, logs };
}

const form = (params: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

/** A call to `to` on `carrier`: answered, its socket opened, its setup sent as that carrier sends it, its greeting heard. */
async function call(s: { base: string; ws: string }, carrier: 'twilio' | 'telnyx', callSid: string, to: string): Promise<FakeRelay> {
  const doc = await (await fetch(`${s.base}/voice/${carrier}`, form({ CallSid: callSid, From: '+15555550110', To: to, CallStatus: 'ringing' }))).text();
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  const parameters = Object.fromEntries([...doc.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((p) => [p[1]!, p[2]!]));
  const relay = await FakeRelay.connect(`${s.ws}${m[1]}?token=${m[2]}`);
  relays.push(relay);
  relay.setup(callSid, `VX-${callSid}`, carrier === 'telnyx' ? { to: null, customParameters: { ...parameters, telnyx_call_to: to } } : { to, customParameters: parameters });
  await relay.waitForTexts(1);
  return relay;
}

/** Says each line in turn, waiting for the reply to each; returns everything heard after. */
async function say(relay: FakeRelay, lines: readonly string[]): Promise<string> {
  const before = relay.texts().length;
  for (const line of lines) {
    const n = relay.texts().length;
    relay.prompt(line);
    await relay.waitFor(() => relay.texts().length > n || relay.received.some((x) => x.type === 'end'), 4000);
    await new Promise((r) => setTimeout(r, 30));
  }
  return relay.texts().slice(before).join(' ');
}

const auditOf = (dir: string, app: string): AuditEntry[] => {
  const folder = join(dir, 'audit', app);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((f) => readFileSync(join(folder, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry));
};
const gates = (entries: readonly AuditEntry[]): string[] => entries.filter((e) => e.type === 'gate').map((e) => `${String(e.detail.tool)}:${String(e.detail.verdict)}`);

const REPORT = ["I'd like to report a problem", 'nothing is working at all', 'no, no one is at risk', 'yes, file it'];
const STATUS = ['I want to check on my request', 'five five five zero one two three four', 'April twelfth nineteen eighty', 'yes, set that up'];

describe('the routed app, not the default, on a host', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: files a report with its own systems, reads a status behind identity with its own scope, and puts a person through to its own target`, async () => {
      const s = await start(host, MORNING);
      const report = await call(s, carrier, `CA00000000000000000000000000${carrier.slice(0, 2)}rep1`, NUMBERS.SERVICE_LINE);
      expect(await say(report, REPORT)).toContain('Your report number is P201');
      const status = await call(s, carrier, `CA00000000000000000000000000${carrier.slice(0, 2)}sta1`, NUMBERS.SERVICE_LINE);
      expect(await say(status, STATUS)).toContain('Your plan is set up');
      const entries = auditOf(s.dir, 'routed');
      expect(gates(entries)).toEqual(expect.arrayContaining(['reportProblem:ALLOW', 'readStatus:ALLOW']));
      expect(entries.every((e) => e.app === 'routed')).toBe(true);
      // Nothing of these calls in the default app's records.
      expect(gates(auditOf(s.dir, 'callback'))).toEqual([]);
      expect(s.logs.filter((l) => /error|threw|failed/i.test(l))).toEqual([]);
      // The trace masks routed's own identity factors (its account and birth date), not the default app's slots.
      await running!.close();
      running = null;
      const trace = readFileSync(join(s.dir, 'traces', 'routed', `CA00000000000000000000000000${carrier.slice(0, 2)}sta1.jsonl`), 'utf8');
      expect(trace).toContain('"accountId"');
      expect(trace).not.toContain('55501234');
      expect(trace).not.toContain('1980-04-12');
    });
  }

  it('puts a person through to its own transfer target, with its own MAIN_LINE and desks', async () => {
    const s = await start(host, AFTERNOON);
    const relay = await call(s, 'twilio', 'CA0000000000000000000000000000hand', NUMBERS.SERVICE_LINE);
    await say(relay, ['can I talk to a person']);
    const end = await relay.waitFor((m) => m.type === 'end');
    const doc = await (await fetch(`${s.base}/cr-action/twilio`, form({ CallSid: 'CA0000000000000000000000000000hand', CallStatus: 'in-progress', SessionStatus: 'ended', HandoffData: String(end.handoffData) }))).text();
    // One of routed's own numbers (routed.env: +155555502xx), never callback's (+155555501xx) or the server's.
    expect(doc).toMatch(/\+155555502\d\d/);
    expect(doc).not.toMatch(/\+155555501\d\d|\+15551234567/);
  });

  it('on its chat at /chat/routed: files a report with its own systems', async () => {
    const s = await start(host, MORNING, { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN });
    const ws = new WebSocket(`${s.ws}/chat/routed`, { origin: ORIGIN });
    const received: ServerMessage[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const says = (): string[] => received.flatMap((m) => (m.type === 'say' ? [m.text] : []));
    const waitSays = async (n: number): Promise<void> => {
      const deadline = Date.now() + 4000;
      while (says().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    };
    ws.send(JSON.stringify({ type: 'start', v: 1 }));
    await waitSays(1);
    for (const line of REPORT) {
      const n = says().length;
      ws.send(JSON.stringify({ type: 'text', text: line }));
      await waitSays(n + 1);
      await new Promise((r) => setTimeout(r, 30));
    }
    ws.close();
    expect(says().join(' ')).toContain('Your report number is P201');
    expect(gates(auditOf(s.dir, 'routed'))).toContain('reportProblem:ALLOW');
  });
});

describe('the testkit, not the default, on a host built in code', () => {
  const depot = testkitApp.services!.depot!;
  const resolveBefore = depot.resolve;
  afterEach(() => {
    depot.resolve = resolveBefore;
  });

  /** The callback app the default, the testkit second, its depot's URL from its own settings (host.yaml's `services`). */
  function parcels(): HostRouting {
    return hostRouting({
      apps: [
        { id: 'callback', app: callbackApp, env: { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' }, own: [], ignored: [] },
        { id: 'testkit', app: testkitApp, env: { DEPOT_URL: 'http://depot.example.com/agent', HANDOFF_NUMBER: '+15555550199' }, own: ['DEPOT_URL', 'HANDOFF_NUMBER'], ignored: [], services: { depot: 'DEPOT_URL' } },
      ],
      numbers: [{ variable: 'PARCEL_LINE', app: 'testkit' }],
      defaultApp: 'callback',
      env: { PARCEL_LINE: '+15555550320' },
    });
  }

  it('verifies a caller with a code, files a missing parcel, and sends the depot its request at its own URL', async () => {
    const asked: ServiceResolveOptions[] = [];
    depot.resolve = async (_params, opts) => {
      asked.push(opts);
      return serviceResultEvent('depot', { searchDays: 2 });
    };
    const s = await start(parcels(), Date.parse('2026-09-18T15:00:00Z'));
    const relay = await call(s, 'twilio', 'CA000000000000000000000000000depot', '+15555550320');
    await say(relay, ['my parcel never arrived', 'five five five zero one two three four', 'april twelfth nineteen eighty five']);
    relay.dtmf('123456');
    await relay.waitFor((m) => m.type === 'text' && /what happened|describe|missing/i.test(String(m.token)));
    await say(relay, ['it was a small brown box left at the side gate', 'last tuesday']);
    relay.prompt('yes');
    await relay.waitFor((m) => m.type === 'text' && /within 2 days/.test(String(m.token)), 4000);
    expect(asked.map((o) => o.url)).toEqual(['http://depot.example.com/agent']);
    const entries = auditOf(s.dir, 'testkit');
    expect(entries.filter((e) => e.type === 'identity').length).toBeGreaterThan(0);
    expect(entries.every((e) => e.app === 'testkit')).toBe(true);
    expect(s.logs).toContain('app testkit: service depot: http://depot.example.com/agent');
  });

  it('puts a person through to its own HANDOFF_NUMBER, and says the default app\'s has none of its own', async () => {
    const s = await start(parcels(), Date.parse('2026-09-18T15:00:00Z'));
    const relay = await call(s, 'twilio', 'CA00000000000000000000000000parcel', '+15555550320');
    await say(relay, ['agent']);
    const end = await relay.waitFor((m) => m.type === 'end');
    const doc = await (await fetch(`${s.base}/cr-action/twilio`, form({ CallSid: 'CA00000000000000000000000000parcel', CallStatus: 'in-progress', SessionStatus: 'ended', HandoffData: String(end.handoffData) }))).text();
    expect(doc).toContain('+15555550199');
    // The callback app has transfer targets of its own: no warning for it; the testkit has its own number.
    expect(s.logs.filter((l) => l.includes('no transfer targets and no HANDOFF_NUMBER of its own'))).toEqual([]);
  });

  it('warns of an app that would hand off to the server\'s HANDOFF_NUMBER, of a service with no URL, and names what an app\'s own file sets and does not name', async () => {
    const apps = hostRouting({
      apps: [
        { id: 'callback', app: callbackApp, env: { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' }, own: [], ignored: ['TWILIO_AUTH_TOKEN'] },
        { id: 'testkit', app: testkitApp, env: {}, own: [], ignored: [] },
      ],
      numbers: [],
      defaultApp: 'callback',
      env: {},
    });
    const s = await start(apps, Date.parse('2026-09-18T15:00:00Z'));
    expect(s.logs).toContain("WARNING: app testkit: no transfer targets and no HANDOFF_NUMBER of its own: its handoffs go to the server's HANDOFF_NUMBER, as every such app's do; set HANDOFF_NUMBER in its own settings file");
    expect(s.logs).toContain("WARNING: app testkit: service depot: no URL (host.yaml's services names none for it), so its requests are answered with no result unless it needs none");
    expect(s.logs).toContain("app callback: its own settings file sets TWILIO_AUTH_TOKEN, which it does not name: not read under a host (the server's settings file holds what every app shares)");
  });

  it('on its chat at /chat/testkit: greets in its own words', async () => {
    const s = await start(parcels(), Date.parse('2026-09-18T15:00:00Z'), { CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN });
    const ws = new WebSocket(`${s.ws}/chat/testkit`, { origin: ORIGIN });
    const received: ServerMessage[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'start', v: 1 }));
    const deadline = Date.now() + 4000;
    while (!received.some((m) => m.type === 'say') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    ws.close();
    const first = received.find((m) => m.type === 'say');
    expect(first && first.type === 'say' ? first.text : '').toContain('Example Parcels');
  });
});

describe('a knowledge base in an app that is not the default', () => {
  /** A host over the callback app (the default, no knowledge base) and the utility (its kb/ approved by people), in a temporary folder. */
  async function withUtility(): Promise<HostRouting> {
    const dir = mkdtempSync(join(tmpdir(), 'host-kb-'));
    dirs.push(dir);
    const callback = fileURLToPath(new URL('../testing/callback', import.meta.url));
    const utility = fileURLToPath(new URL('../../../../apps/utility', import.meta.url));
    writeFileSync(join(dir, 'utility.env'), 'HANDOFF_NUMBER=+15555550499\n');
    writeFileSync(join(dir, 'host.yaml'), [
      'apps:',
      `  - { folder: ${relative(dir, callback)}, env: callback.env }`,
      `  - { folder: ${relative(dir, utility)}, env: utility.env }`,
      'numbers:',
      '  - { number: env.POWER_LINE, app: utility }',
      'default: callback',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'callback.env'), 'MAIN_LINE=+15555550101\nPRIORITY_LINE=+15555550102\nCALLBACK_DESK=+15555550103\nSECURITY_DESK=+15555550104\n');
    // Keyword retrieval where the embedder's model is not in the cache: the documented fallback, a warning and no refusal.
    delete process.env.DIALOGWRIGHT_REQUIRE_EMBEDDER;
    return loadHost(join(dir, 'host.yaml'), { POWER_LINE: '+15555550330' });
  }
  /** The utility's approved passage on outage credits, word for word (apps/utility/kb/passages/outage-credit.yaml). */
  const CREDIT = "If your power is out for 24 hours or more in a row, you get a credit of 25 dollars on your next bill, applied automatically. There's nothing to apply for.";

  it('answers from the utility\'s own approved passage, word for word, its record naming the app; the default app, with none, does not', async () => {
    const s = await start(await withUtility(), MORNING);
    const asked = await call(s, 'twilio', 'CA000000000000000000000000000kbutl', '+15555550330');
    expect(await say(asked, ['how do outage credits work'])).toContain(CREDIT);
    const answers = auditOf(s.dir, 'utility').filter((e) => e.type === 'kb_answer');
    expect(answers.map((e) => [e.app, e.detail.passageId])).toEqual([['utility', 'outage-credit']]);
    // The callback app has no knowledge base: the same question there is never the utility's passage.
    const other = await call(s, 'twilio', 'CA000000000000000000000000000kbcbk', '+15555550999');
    expect(await say(other, ['how do outage credits work'])).not.toContain('credit of 25 dollars');
    expect(auditOf(s.dir, 'callback').filter((e) => e.type === 'kb_answer')).toEqual([]);
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOverrides } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import type { JevClient } from '../jev/types';
import { maskNumber, type DashboardEvent } from './dashboard/events';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { promptText } from '../prompts/render';
import { defaultCorpusFile } from '../run/fixtures';

useTestkit();

let running: RunningServer | null = null;
/** Temp dirs minted by makeConfig() for this test, swept up alongside the server it started. */
let tempDirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Shaped like a minted token (32 hex), but never minted: the upgrade itself must refuse it. */
const UNMINTED_TOKEN = 'f'.repeat(32);

/** A playable 8 kHz mono 16-bit PCM WAV of the given length, so clipDurations can measure it. */
function wavOfMs(ms: number, rate = 8000): Buffer {
  const bytesPerSample = 2;
  const data = Math.round((ms / 1000) * rate) * bytesPerSample;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * bytesPerSample, 28); b.writeUInt16LE(bytesPerSample, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

function makeConfig(extra: Record<string, string> = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), 'server-'));
  tempDirs.push(traceDir);
  // AUDIO_DIR defaults to a fresh, empty temp dir (not the repo's assets/audio) so these tests
  // never depend on, or are broken by, whatever real recorded clips live in the working tree.
  const audioDir = extra.AUDIO_DIR ?? mkdtempSync(join(tmpdir(), 'audio-'));
  if (!extra.AUDIO_DIR) tempDirs.push(audioDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    AUDIT_DIR: join(traceDir, 'audit'),
    AUDIO_DIR: audioDir,
    // These tests were written for the recorded-clip path; the server's own default is all-TTS.
    CLIPS: 'on',
    ...extra,
  });
  return { traceDir, config };
}

async function start(client?: JevClient, overrides: Omit<ServerOverrides, 'client' | 'log'> = {}) {
  const { traceDir, config } = makeConfig();
  running = await startServer(config, { client, log: () => {}, ...overrides });
  return { traceDir, base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}/conversation` };
}

async function connected(callSid = 'CA1') {
  const s = await start();
  const token = running!.tokens.mint(callSid);
  const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  return { ...s, relay, callSid };
}

const GREETING_TEXT = "Thanks for calling Example Parcels. You're speaking with the automated assistant. I can track a parcel, check a delivery window, or report a missing parcel. How can I help?";
const ASK_ACCOUNT_ID = "First I need to verify your identity. What's your account ID? It's the eight digits on your delivery notice.";
const ACCOUNT_ID = 'five five five zero one two three four';
const DOB = 'april twelfth nineteen eighty five';
/** A delivery window asked for in one breath (the day and the part of the day): the form is entered, identity is asked, the window follows. */
const WINDOW_OPENER = 'can you deliver tomorrow morning';
/** What the call is told when a customer's window is answered, and the shortest completed call's sign-off. */
const GOODBYE = 'Thanks for calling Example Parcels. Goodbye.';
const ANYTHING_ELSE = 'Is there anything else I can help with?';
/** Said at the account ID question without answering it. */
const HOLD_ON = 'hold on, let me find my notice';

/** The corpus is expensive to load, so the delaying client shares one fixture client across its calls. */
let sharedStub: JevClient | null = null;
async function fixtureStub(): Promise<JevClient> {
  if (!sharedStub) {
    const { FixtureStubClient } = await import('../jev/fixtureStub');
    const { HeuristicStubClient } = await import('../jev/heuristicStub');
    const { loadCorpus } = await import('../jev/corpus');
    sharedStub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  }
  return sharedStub;
}

// Loaded once before any test, so no test's timing includes loading the corpus: the slow-turn test
// below times its turn against the setup deadline, and a first load inside it made it flaky.
beforeAll(async () => {
  await fixtureStub();
}, 60_000);

describe('server end to end', () => {
  it('plays the greeting as a recorded clip when one is present, and logs which audio clips are present at startup', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const { config } = makeConfig({ AUDIO_DIR: audioDir });
    const logs: string[] = [];
    running = await startServer(config, { log: (line) => logs.push(line) });
    const base = `http://127.0.0.1:${running.port}`;
    const ws = `ws://127.0.0.1:${running.port}/conversation`;
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`${ws}?token=${token}`);
    relay.setup('CA1');
    await relay.waitForMessages(1);
    // No trailing text frame: the whole greeting is one recorded clip, so the turn produces
    // exactly this one play frame. The source carries a content-hash query string (clipVersions)
    // so a regenerated clip under the same filename is never served from Twilio's cache.
    expect(relay.received).toEqual([
      {
        type: 'play',
        source: expect.stringMatching(/^https:\/\/localhost\/audio\/greeting\.0\.wav\?v=[0-9a-f]{10}$/),
        loop: 1,
        preemptible: false,
        interruptible: true,
      },
    ]);
    relay.assertKnownTypes();
    expect(logs.some((l) => l.includes('audio: 1 of') && l.includes('clips present'))).toBe(true);
    // The renderer's audioBase points here, so the clip it just referenced (query string and
    // all) must actually be reachable at that URL's path.
    const source = relay.received[0]?.source;
    if (typeof source !== 'string') throw new Error('expected a play frame with a source');
    const clip = await fetch(source.replace('https://localhost', base));
    expect(clip.status).toBe(200);
    expect(clip.headers.get('content-type')).toBe('audio/wav');
  });

  it('still boots and greets when recorded.json is malformed, logging that it is ignored', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    writeFileSync(join(audioDir, 'recorded.json'), 'not json');
    const { config } = makeConfig({ AUDIO_DIR: audioDir });
    const logs: string[] = [];
    running = await startServer(config, { log: (line) => logs.push(line) });
    expect(logs.some((l) => l.startsWith('audio: ignoring unreadable recorded.json:'))).toBe(true);
    const ws = `ws://127.0.0.1:${running.port}/conversation`;
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`${ws}?token=${token}`);
    relay.setup('CA1');
    expect(await relay.waitForTexts(1)).toEqual([GREETING_TEXT]);
  });

  it('greets on setup and refuses a well-shaped token that was never minted', async () => {
    const { relay, ws } = await connected();
    expect(relay.texts()).toEqual([GREETING_TEXT]);
    // The upgrade knows the token but not the call SID, and this one is live for no call at all,
    // so it never gets a socket to send setup on.
    await expect(FakeRelay.connect(`${ws}?token=${UNMINTED_TOKEN}`)).rejects.toThrow(/401/);
  });

  it('refuses a setup whose token belongs to another call', async () => {
    const s = await start();
    // Minted for CA1, so the upgrade passes; the binding to a call SID is still checked at setup.
    const token = running!.tokens.mint('CA1');
    const bad = await FakeRelay.connect(`${s.ws}?token=${token}`);
    bad.setup('CA2');
    const end = await bad.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"unauthorized"}');
    expect((await bad.closed).code).toBe(1008);
    expect(running!.store.get('CA2')).toBeUndefined();
  });

  it('logs a relay error frame and keeps the call going', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.error('Text-to-speech failed for the previous token');
    relay.prompt('my parcel never arrived');
    expect((await relay.waitForTexts(2)).at(-1)).toBe(ASK_ACCOUNT_ID);
    const frames = readFileSync(join(traceDir, `${callSid}.frames.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
    const err = frames.find((f) => f.dir === 'in' && f.msg.type === 'error');
    expect(err?.msg.description).toBe('Text-to-speech failed for the previous token');
    // An error frame is state, not a turn: it produces no decision and no frames of its own.
    const records = readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => r.event.type)).toEqual(['session.start', 'channel.error', 'user.speech']);
    expect(records[1].decision.kind).toBe('ignore');
    relay.assertKnownTypes();
  });

  it('refuses an upgrade without a token', async () => {
    const s = await start();
    await expect(FakeRelay.connect(s.ws)).rejects.toBeDefined();
    await expect(FakeRelay.connect(`${s.ws}?token=nope`)).rejects.toBeDefined();
  });

  it('closes a connection that never sends setup', async () => {
    const s = await start(undefined, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA9');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    expect((await relay.closed).code).toBe(1008);
  });

  it('keeps a call open after the setup deadline once setup succeeded', async () => {
    const s = await start(undefined, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA8');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA8');
    await relay.waitForTexts(1);
    await new Promise((r) => setTimeout(r, 1000));
    relay.prompt('my parcel never arrived');
    // The greeting, then the report form's entry ack and ask_accountId (a generous wait: only the deadline is under test).
    expect((await relay.waitForTexts(3, 10_000)).length).toBe(3);
    const stillOpen = Symbol('open');
    const settled = await Promise.race([relay.closed, new Promise((r) => setTimeout(() => r(stillOpen), 100))]);
    expect(settled).toBe(stillOpen);
  }, 15_000);

  it('does not time out an authenticated call whose first turn is slow', async () => {
    const slow: JevClient = {
      ask: async (req) => {
        const stub = await fixtureStub();
        await new Promise((r) => setTimeout(r, 500));
        return stub.ask(req);
      },
    };
    const s = await start(slow, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA10');
    const first = await FakeRelay.connect(`${s.ws}?token=${token}`);
    first.setup('CA10');
    await first.waitForTexts(1);
    // Only prompt turns consult the model, so the way a setup handler outlives the deadline is a
    // reconnect whose replay queues behind a slow turn that is already running.
    first.prompt('my parcel never arrived');
    const again = await FakeRelay.connect(`${s.ws}?token=${token}`);
    again.setup('CA10', 'VX-slow');
    const stillOpen = Symbol('open');
    const settled = await Promise.race([again.closed, new Promise((r) => setTimeout(() => r(stillOpen), 1000))]);
    expect(settled).toBe(stillOpen);
    // The reconnect hears the replayed prompt, and the slow turn's own frames land on this socket too.
    expect((await again.waitForTexts(1, 10_000)).length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('reports a port in use as a clean error', async () => {
    await start();
    const { config } = makeConfig({ PORT: String(running!.port) });
    await expect(startServer(config, { log: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });

  it('runs the worked example over the socket and ends the call', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.prompt(WINDOW_OPENER);
    // The greeting, then the window form's entry ack, then ask_accountId.
    expect((await relay.waitForTexts(3)).at(-1)).toBe(ASK_ACCOUNT_ID);
    relay.prompt(ACCOUNT_ID);
    expect((await relay.waitForTexts(4)).at(-1)).toBe("And what's your date of birth?");
    relay.prompt(DOB);
    // Verified at level 1, which is all a delivery window needs: the greeting by name, the answer, and the question after it.
    const answered = await relay.waitForTexts(7);
    expect(answered.slice(-3)).toEqual(['Thanks, Alex.', 'On Saturday, September 19, we can deliver in the morning.', ANYTHING_ELSE]);
    relay.prompt("no, that's all");
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
    expect(relay.texts().at(-1)).toBe(GOODBYE);
    // The server leaves the socket open after `end` so Twilio can finish playing the queued
    // clips; it is Twilio, not the server, that closes the connection once it is done.
    const stillOpen = Symbol('open');
    const settled = await Promise.race([relay.closed, new Promise((r) => setTimeout(() => r(stillOpen), 200))]);
    expect(settled).toBe(stillOpen);
    relay.close();
    await relay.closed;
    expect(running!.store.get(callSid)?.ended).toBe(true);
    expect(existsSync(join(traceDir, `${callSid}.jsonl`))).toBe(true);
    expect(existsSync(join(traceDir, `${callSid}.frames.jsonl`))).toBe(true);
    expect(readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(5);
    relay.assertKnownTypes();
  });

  it('streams the worked example to the dashboard while it runs', async () => {
    const { relay, base, callSid } = await connected();
    const res = await fetch(`${base}/dashboard/events`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    // One decoder for the whole stream, in streaming mode: a masked number's `…` is three bytes
    // and can land across two reads, and only whole `\n\n` blocks are parsed.
    const dec = new TextDecoder();
    let buf = '';
    const events = () => buf.split('\n\n').slice(0, -1)
      .filter((b) => b.includes('data: ') && !b.startsWith('event: boot'))
      .map((b) => JSON.parse(b.split('data: ')[1]!) as DashboardEvent);
    // An open stream is a live connection: a failed assertion must not leave it holding the
    // server open, or `afterEach`'s `running.close()` waits on it instead of reporting the failure.
    try {
      relay.prompt('my parcel never arrived');
      // The greeting, then the report form's entry ack, then ask_accountId.
      expect((await relay.waitForTexts(3)).at(-1)).toBe(ASK_ACCOUNT_ID);
      // The setup turn is turn 1, so the model's first turn — the one the `asked` event pairs with —
      // is turn 2: read the stream until that turn's audit entries (its `turn` event's follower) have arrived.
      const arrived = () => events().filter((e) => e.type === 'audit').length >= 2;
      while (!arrived()) buf += dec.decode((await reader.read()).value, { stream: true });
      // A page opened mid-call gets the history first (the greeting turn asks nothing, so no `asked`
      // precedes its `turn`), then the live turn; each turn's audit entries follow its `turn`.
      expect(events().map((e) => e.type)).toEqual(['call_started', 'turn', 'audit', 'asked', 'turn', 'audit']);
      const audits = events().flatMap((e) => (e.type === 'audit' ? [e.entries.map((a) => a.type)] : []));
      // The greeting starts the call; the report form's entry call meets the gate, which asks for identity.
      expect(audits).toEqual([['call_started'], ['gate']]);
      expect(events().find((e) => e.type === 'asked')).toMatchObject({ turnIndex: 2, callSid: 'CA1' });
      expect(buf).toContain(`"spoken":"Sure, I can help you report a missing parcel. ${ASK_ACCOUNT_ID}"`);
      expect(buf).toMatch(/^id: 1\n/m);
    } finally {
      await reader.cancel();
    }
    relay.close();
    expect(callSid).toBe('CA1');
  });

  it('shuts down while a dashboard stream is still open', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/dashboard/events`);
    // The `: connected` comment: the stream is established, so the connection is not idle.
    await res.body!.getReader().read();
    // `server.close()` only waits out idle connections, and an SSE stream never goes idle: without
    // closeAllConnections this shutdown never finishes and the whole suite hangs on afterEach.
    const timedOut = Symbol('timed out');
    const closing = running!.close();
    const outcome = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<symbol>((r) => { setTimeout(() => r(timedOut), 2_000); }),
    ]);
    if (outcome === 'closed') running = null;
    expect(outcome).toBe('closed');
  });

  it('answers 404 on /dashboard when the dashboard is off', async () => {
    const { config } = makeConfig({ DASHBOARD: 'off', PORT: '0' });
    running = await startServer(config, { log: () => {} });
    const base = `http://127.0.0.1:${running.port}`;
    expect((await fetch(`${base}/dashboard`)).status).toBe(404);
    expect((await fetch(`${base}/dashboard/traces`)).status).toBe(404);
  });

  it('pins the index labels of one ordinary turn, where asked and turn agree', async () => {
    const { relay } = await connected();
    const events: DashboardEvent[] = [];
    running!.bus!.subscribe((e) => events.push(e));
    relay.prompt('my parcel never arrived');
    // The greeting, then the report form's entry ack, then ask_accountId.
    expect((await relay.waitForTexts(3)).at(-1)).toBe(ASK_ACCOUNT_ID);
    const pick = <T extends DashboardEvent['type']>(t: T) => events.filter((e): e is Extract<DashboardEvent, { type: T }> => e.type === t);
    const asked = pick('asked');
    const turns = pick('turn');
    expect(asked).toHaveLength(1);
    // The setup turn asked nothing, so the model's first turn is the second turn of the call.
    expect(asked[0]).toMatchObject({ turnIndex: 2, callSid: 'CA1' });
    // This turn is an ordinary one, so the two labels agree. That is not the general rule: a turn
    // that resolves to ignore or hold leaves `asked` one ahead (see events.ts), which is why the
    // page pairs the two events by arrival order rather than by this number.
    expect(turns.at(-1)!.record.turnIndex).toBe(asked[0]!.turnIndex);
    expect(turns.at(-1)!.spoken).toBe(`Sure, I can help you report a missing parcel. ${ASK_ACCOUNT_ID}`);
    expect(asked[0]!.questions).toHaveProperty('intent');
    // The dashboard route is unauthenticated, so the raw record is never enough: the setup turn's
    // event must already carry a masked caller number, not the whole one FakeRelay.setup sent.
    expect(turns[0]!.record.event).toMatchObject({ type: 'session.start', provider: { from: maskNumber('+15550000001'), to: maskNumber('+15550000002') } });
  });

  it('publishes ended with reason error when a live call is evicted', async () => {
    // `evictIdle` deletes the entry before the socket it closes reaches the adapter's close
    // handler, so the sweep itself is the only place that can end an evicted call for the page.
    let clock = 0;
    const { config } = makeConfig({ SESSION_TTL_MS: '50', PORT: '0' });
    running = await startServer(config, { log: () => {}, now: () => clock });
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    const events: DashboardEvent[] = [];
    running.bus!.subscribe((e) => events.push(e));
    // Well past the idle TTL, on the server's own clock. `sweep` is the evictor's per-tick body,
    // called directly so the test does not wait out the minute-long interval.
    clock = 10_000;
    running.sweep();
    expect(running.store.get('CA1')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error', callSid: 'CA1', at: 10_000 });
    expect(events.filter((e) => e.type === 'ended')).toHaveLength(1);
    relay.close();
  });

  it('does not publish an ended for a call that had already ended when it was evicted', async () => {
    let clock = 0;
    const { config } = makeConfig({ SESSION_TTL_MS: '50', PORT: '0' });
    running = await startServer(config, { log: () => {}, now: () => clock });
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    const events: DashboardEvent[] = [];
    running.bus!.subscribe((e) => events.push(e));
    // A call that ended on its own published its own `ended`; the sweep that later reclaims the
    // entry must not add a second one.
    running.store.end('CA1');
    clock = 10_000;
    running.sweep();
    expect(running.store.get('CA1')).toBeUndefined();
    expect(events.filter((e) => e.type === 'ended')).toHaveLength(0);
    relay.close();
  });

  it('appends an audit call_ended for a live call the sweep evicts, the one end no turn or webhook sees', async () => {
    let clock = 0;
    const { config } = makeConfig({ SESSION_TTL_MS: '50', PORT: '0' });
    running = await startServer(config, { log: () => {}, now: () => clock });
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    clock = 10_000;
    running.sweep();
    expect(running.store.get('CA1')).toBeUndefined();
    const day = new Date(clock).toISOString().slice(0, 10);
    const entries = readFileSync(join(config.auditDir, `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; detail: Record<string, unknown> });
    expect(entries.find((e) => e.type === 'call_ended')).toMatchObject({ type: 'call_ended', detail: { reason: 'evicted' } });
    relay.close();
  });

  it('appends no audit call_ended for a call that had already ended when it was evicted', async () => {
    let clock = 0;
    const { config } = makeConfig({ SESSION_TTL_MS: '50', PORT: '0' });
    running = await startServer(config, { log: () => {}, now: () => clock });
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    running.store.end('CA1');
    clock = 10_000;
    running.sweep();
    const day = new Date(clock).toISOString().slice(0, 10);
    const entries = existsSync(join(config.auditDir, `${day}.jsonl`))
      ? readFileSync(join(config.auditDir, `${day}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string })
      : [];
    expect(entries.find((e) => e.type === 'call_ended')).toBeUndefined();
    relay.close();
  });

  it('has no bus when the dashboard is off', async () => {
    const { config } = makeConfig({ DASHBOARD: 'off', PORT: '0' });
    running = await startServer(config, { log: () => {} });
    expect(running.bus).toBeUndefined();
  });

  it('closes the socket itself if Twilio never does within the grace period after end', async () => {
    const s = await start(undefined, { endCloseGraceMs: 50 });
    const token = running!.tokens.mint('CA11');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA11');
    await relay.waitForTexts(1);
    relay.prompt(WINDOW_OPENER);
    await relay.waitForTexts(3);
    relay.prompt(ACCOUNT_ID);
    await relay.waitForTexts(4);
    relay.prompt(DOB);
    await relay.waitForTexts(7);
    relay.prompt("no, that's all");
    await relay.waitFor((m) => m.type === 'end');
    // The server closes 50 ms after the end; the close crosses a real socket, so the bound is wide
    // (a loaded machine can hold the close frame past a tight one) and only a close that never comes fails.
    const timedOut = Symbol('timed out');
    const settled = await Promise.race([relay.closed, new Promise((r) => setTimeout(() => r(timedOut), 4000))]);
    expect(settled).not.toBe(timedOut);
    const closed = settled as { code: number; reason: string };
    expect(closed.code).toBe(1000);
    expect(closed.reason).toBe('end grace elapsed');
  });

  it('speaks the greeting as text when CLIPS is off, even with a recorded clip present', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const { config } = makeConfig({ AUDIO_DIR: audioDir, CLIPS: 'off' });
    const logs: string[] = [];
    running = await startServer(config, { log: (line) => logs.push(line) });
    const token = running.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    // The clip on disk is ignored: the whole greeting is one text frame for the TTS voice.
    expect(relay.received.map((f) => f.type)).toEqual(['text']);
    relay.assertKnownTypes();
    expect(logs.some((l) => l.startsWith('clips: off'))).toBe(true);
    // The recorded clip on disk still exists, but CLIPS=off means it is never checked: no presence
    // or staleness lines, just the one quiet line above.
    expect(logs.some((l) => l.includes('clips present'))).toBe(false);
    expect(logs.some((l) => l.includes('stale clips'))).toBe(false);
  });

  it('re-asks on its own when the caller says nothing after the greeting', async () => {
    // A real 200 ms WAV, so the whole greeting is one recorded clip and the wait is that clip's
    // measured length plus the configured 50 ms - the clipDurations path, end to end, on real timers.
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    tempDirs.push(audioDir);
    writeFileSync(join(audioDir, 'greeting.0.wav'), wavOfMs(200));
    const { config } = makeConfig({ AUDIO_DIR: audioDir });
    const logs: string[] = [];
    running = await startServer(config, { log: (line) => logs.push(line), noInputMs: 50 });
    expect(logs.some((l) => l === 'no-input: 50 ms after playback (1 clip durations)')).toBe(true);
    const token = running.tokens.mint('CA12');
    const relay = await FakeRelay.connect(`ws://127.0.0.1:${running.port}/conversation?token=${token}`);
    relay.setup('CA12');
    await relay.waitForMessages(1);
    expect(relay.received[0]).toMatchObject({
      type: 'play',
      source: expect.stringMatching(/^https:\/\/localhost\/audio\/greeting\.0\.wav\?v=[0-9a-f]{10}$/),
    });
    // Nothing is sent from here on: the next frames are the server's own doing.
    const texts = await relay.waitForTexts(2);
    expect(texts[0]).toBe("I didn't hear anything.");
    // The first ladder rung is the plain question, not the nomatch_open apology.
    expect(texts[1]).toBe('How can I help you today?');
    expect(running.store.get('CA12')?.session.intentAttempts).toBe(1);
    relay.assertKnownTypes();
  });

  it('handles dtmf and agent handoff', async () => {
    const { relay } = await connected();
    relay.prompt(WINDOW_OPENER);
    await relay.waitForTexts(3);
    relay.prompt(ACCOUNT_ID);
    await relay.waitForTexts(4);
    relay.dtmf('04121985');
    // The date of birth keyed completes the verification, so the window answer is what the digits get back.
    expect((await relay.waitForTexts(7)).at(-1)).toBe(ANYTHING_ELSE);
    relay.prompt("no, that's all");
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
    const token2 = running!.tokens.mint('CA5');
    const second = await FakeRelay.connect(`ws://127.0.0.1:${running!.port}/conversation?token=${token2}`);
    second.setup('CA5');
    await second.waitForTexts(1);
    second.prompt('i want to talk to a person');
    const handoff = await second.waitFor((m) => m.type === 'end');
    expect(handoff.handoffData).toBe('{"reasonCode":"live-agent"}');
    expect(second.texts().at(-1)).toBe(promptText(testkitApp, 'handoff_live_agent', {}));
  });

  it(
    'serializes back-to-back prompts and digits, ignoring a date of birth keyed before the questions those prompts went on to ask',
    async () => {
      const slow: JevClient = {
        ask: async (req) => {
          const stub = await fixtureStub();
          await new Promise((r) => setTimeout(r, 150));
          return stub.ask(req);
        },
      };
      const s = await start(slow);
      const token = running!.tokens.mint('CA7');
      const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
      relay.setup('CA7');
      await relay.waitForTexts(1);
      relay.prompt(WINDOW_OPENER);
      relay.prompt(ACCOUNT_ID);
      // Keyed before the birth-date question was asked: taken ahead of it, and so ignored.
      relay.dtmf('04121985');
      expect((await relay.waitForTexts(4)).at(-1)).toBe("And what's your date of birth?");
      relay.dtmf('04121985');
      expect((await relay.waitForTexts(7)).at(-1)).toBe(ANYTHING_ELSE);
      relay.prompt("no, that's all");
      const end = await relay.waitFor((m) => m.type === 'end', 4000);
      expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
      const records = readFileSync(join(s.traceDir, 'CA7.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(records.map((r) => r.event.type)).toEqual(['session.start', 'user.speech', 'user.speech', ...Array(16).fill('user.key'), 'user.speech']);
      expect(records[1].decision.promptId).toBe('ask_accountId');
      expect(records[2].decision.promptId).toBe('ask_dob');
      expect(records.slice(3, 11).map((r) => r.decision.kind)).toEqual(Array(8).fill('ignore'));
      expect(records.slice(3, 19).map((r) => r.event.digit)).toEqual(Array(16).fill('•'));
    },
    { timeout: 8000 },
  );

  it(
    'takes an account ID keyed while a spoken turn at the account ID question runs, after that turn',
    async () => {
      const slow: JevClient = {
        ask: async (req) => {
          const stub = await fixtureStub();
          await new Promise((r) => setTimeout(r, 150));
          return stub.ask(req);
        },
      };
      const s = await start(slow);
      const token = running!.tokens.mint('CA8');
      const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
      relay.setup('CA8');
      await relay.waitForTexts(1);
      relay.prompt(WINDOW_OPENER);
      expect((await relay.waitForTexts(3)).at(-1)).toBe(ASK_ACCOUNT_ID);
      // The caller says something that leaves the question where it was, and keys the ID while it is heard.
      relay.prompt(HOLD_ON);
      relay.dtmf('55501234');
      expect((await relay.waitFor((m) => m.type === 'text' && m.token === "And what's your date of birth?", 4000)).token).toBeDefined();
      const records = readFileSync(join(s.traceDir, 'CA8.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      // In order: the spoken turn first, then the eight digits, the last of which asks for the birth date.
      expect(records.map((r) => r.event.type)).toEqual(['session.start', 'user.speech', 'user.speech', ...Array(8).fill('user.key')]);
      // The spoken turn re-asked the account ID: a new prompt, but the same question the digits were keyed at.
      expect(records[2].decision.promptId).toBe('ask_accountId_retry');
      expect(records[2].promptedFor).toBe('accountId');
      expect(records.at(-1).decision.promptId).toBe('ask_dob');
      expect(records.slice(3).map((r) => r.event.digit)).toEqual(Array(8).fill('•'));
      expect(running!.store.get('CA8')!.session.slots.accountId!.value).toBe('55501234');
    },
    { timeout: 8000 },
  );

  it('records an interrupt as barge-in on the next prompt turn', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.interrupt('Thanks for', 300);
    relay.prompt('my parcel never arrived');
    await relay.waitForTexts(2);
    const records = readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(records.at(-1).turnState.asr.bargeIn).toBe(true);
  });

  it('sanitizes call sids before building file names', async () => {
    const { safeFileStem } = await import('./index');
    expect(safeFileStem('CA' + 'a'.repeat(32))).toBe('CA' + 'a'.repeat(32));
    expect(safeFileStem('../etc/passwd')).toBe('___etc_passwd');
    expect(safeFileStem('CA1.frames')).toBe('CA1_frames');
    expect(safeFileStem('')).toBe('unknown');
  });

  it('names a Telnyx call\'s files by a stable stem with no colon (its ids look like v2:...)', async () => {
    const { safeFileStem } = await import('./index');
    const id = 'v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ';
    expect(safeFileStem(id)).toBe('v2_T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ');
    expect(safeFileStem(id)).toBe(safeFileStem(id));
    expect(safeFileStem(id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('exposes health and refuses upgrades on other paths', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/health`);
    expect(await res.json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    await expect(FakeRelay.connect(`ws://127.0.0.1:${running!.port}/other`)).rejects.toBeDefined();
  });

  it('reconnects a dropped call through the action callback and resumes the form', async () => {
    const { relay, base, ws, callSid } = await connected();
    relay.prompt('a parcel is missing, it was a small box left at the back door');
    // The greeting, then the report form's entry ack, then ask_accountId.
    await relay.waitForTexts(3);
    relay.close();
    await relay.closed;
    const body = new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString();
    const res = await fetch(`${base}/cr-action`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const twiml = await res.text();
    expect(twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(twiml)![1]!;
    const again = await FakeRelay.connect(`${ws}?token=${token}`);
    again.setup(callSid, 'VX-second');
    expect(await again.waitForTexts(1)).toEqual([`Sure, I can help you report a missing parcel. ${ASK_ACCOUNT_ID}`]);
    again.prompt(ACCOUNT_ID);
    expect((await again.waitForTexts(2)).at(-1)).toBe("And what's your date of birth?");
    again.prompt(DOB);
    // The description the opener gave on the first connection is still on the form: verified, the
    // caller is asked only for the keypad code the report needs.
    expect((await again.waitForTexts(4)).slice(-2)).toEqual(['Thanks, Alex.', expect.stringMatching(/^For your security I need one more check\./)]);
    expect(running!.store.get(callSid)?.session.slots.missingNote!.value).toBe('a parcel is missing, it was a small box left at the back door');
    const done = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await done.text()).toContain('<ConversationRelay');
    // That callback minted a fresh token for the call, so the one this connection used is now
    // stale: it is live for no call at all and the upgrade refuses it before any setup.
    await expect(FakeRelay.connect(`${ws}?token=${token}`)).rejects.toThrow(/401/);
    const third = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await third.text()).toContain('<Dial>+15551234567</Dial>');
    expect(running!.store.get(callSid)?.ended).toBe(true);
  });
});

describe('the relay socket by voice provider', () => {
  it('runs a call on /conversation/twilio, and the dashboard names the provider', async () => {
    const s = await start();
    const events: DashboardEvent[] = [];
    running!.bus!.subscribe((e) => events.push(e));
    const token = running!.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`${s.base.replace('http', 'ws')}/conversation/twilio?token=${token}`);
    relay.setup('CA1');
    expect(await relay.waitForTexts(1)).toEqual([GREETING_TEXT]);
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ callSid: 'CA1', channel: 'voice', provider: 'twilio' });
    relay.close();
  });

  it('names Twilio as the provider of a call on the legacy /conversation', async () => {
    const s = await start();
    const events: DashboardEvent[] = [];
    running!.bus!.subscribe((e) => events.push(e));
    const token = running!.tokens.mint('CA1');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA1');
    await relay.waitForTexts(1);
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ provider: 'twilio' });
    relay.close();
  });

  it('refuses the socket of a provider that is not enabled, and a deeper path', async () => {
    const s = await start();
    const token = running!.tokens.mint('CA1');
    const ws = s.base.replace('http', 'ws');
    await expect(FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`)).rejects.toThrow(/404/);
    await expect(FakeRelay.connect(`${ws}/conversation/twilio/x?token=${token}`)).rejects.toThrow(/404/);
  });

  it("ties a call's token to its carrier: a Telnyx call's token opens no Twilio socket, and a Twilio call's none of Telnyx's", async () => {
    const telnyxKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const { config } = makeConfig({ VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: telnyxKey });
    running = await startServer(config, { log: () => {} });
    const base = `http://127.0.0.1:${running.port}`;
    const ws = base.replace('http', 'ws');
    const tokenOf = async (path: string, callSid: string): Promise<string> => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ CallSid: callSid, From: '+15555550110', To: '+15555550111', CallStatus: 'ringing' }).toString() });
      return /token=([0-9a-f]{32})/.exec(await res.text())![1]!;
    };
    const telnyx = await tokenOf('/voice/telnyx', 'v2:telnyx-call');
    await expect(FakeRelay.connect(`${ws}/conversation/twilio?token=${telnyx}`)).rejects.toThrow(/401/);
    await expect(FakeRelay.connect(`${ws}/conversation?token=${telnyx}`)).rejects.toThrow(/401/);
    const twilio = await tokenOf('/voice/twilio', 'CA1');
    await expect(FakeRelay.connect(`${ws}/conversation/telnyx?token=${twilio}`)).rejects.toThrow(/401/);
    const legacy = await tokenOf('/voice', 'CA2');
    await expect(FakeRelay.connect(`${ws}/conversation/telnyx?token=${legacy}`)).rejects.toThrow(/401/);
    // Each on its own carrier's path is a call.
    const own = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${telnyx}`);
    own.setup('v2:telnyx-call');
    expect(await own.waitForTexts(1)).toEqual([GREETING_TEXT]);
    own.close();
    const legacyOwn = await FakeRelay.connect(`${ws}/conversation?token=${legacy}`);
    legacyOwn.setup('CA2');
    expect(await legacyOwn.waitForTexts(1)).toEqual([GREETING_TEXT]);
    legacyOwn.close();
  });
});

describe('startup: what answers', () => {
  async function startupLines(extra: Record<string, string>): Promise<string[]> {
    const { config } = makeConfig({ CLIPS: 'off', ...extra });
    const lines: string[] = [];
    const stub: JevClient = { ask: () => Promise.reject(new Error('not asked')) };
    running = await startServer(config, { client: stub, log: (l) => lines.push(l) });
    return lines;
  }

  it('names the model, and warns once that a compatible model\'s probabilities are not Jev\'s', async () => {
    const lines = await startupLines({ JEV_CLIENT: 'jev', JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:9', JEV_MODEL: 'open-jev-7b', JEV_API_KEY: 'test-key' });
    expect(lines).toContain('model open-jev-7b from custom (http://127.0.0.1:9)');
    expect(lines.filter((l) => /not Jev's/.test(l))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('test-key');
  });

  it('names an official provider\'s model with no warning, and says nothing of a model for a stub', async () => {
    const official = await startupLines({ JEV_CLIENT: 'jev', JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key' });
    expect(official).toContain('model typesafe/jev-1.13 from openrouter (https://openrouter.ai/api)');
    expect(official.filter((l) => /not Jev's/.test(l))).toHaveLength(0);
    await running?.close();
    running = null;
    const stub = await startupLines({});
    expect(stub.filter((l) => l.startsWith('model ') || /not Jev's/.test(l))).toHaveLength(0);
  });
});

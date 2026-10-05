import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFileStem, startServer, type RunningServer } from '../index';
import { loadConfig } from '../config';
import { FakeRelay } from '../../testing/fakeRelay';
import type { JevClient } from '../../jev/types';
import type { DashboardEvent } from '../dashboard/events';
import { useTestkit } from '../../testing/apps';
import { defaultCorpusFile } from '../../run/fixtures';

useTestkit();

/**
 * A whole call on Telnyx over a real socket: the worked example of server.test.ts, with the server
 * answering only Telnyx, a signed TeXML webhook, Telnyx's own setup frame and its bare-language prompts.
 */

// The account's key pair, made here: Telnyx signs with the private half, the server holds the public one.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const CALL_ID = 'v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ';

const GREETING_TEXT = "Thanks for calling Example Parcels. You're speaking with the automated assistant. I can track a parcel, check a delivery window, or report a missing parcel. How can I help?";
const ASK_ACCOUNT_ID = "First I need to verify your identity. What's your account ID? It's the eight digits on your delivery notice.";
const ANYTHING_ELSE = 'Is there anything else I can help with?';
const GOODBYE = 'Thanks for calling Example Parcels. Goodbye.';

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let client: JevClient | null = null;
beforeAll(async () => {
  const { FixtureStubClient } = await import('../../jev/fixtureStub');
  const { HeuristicStubClient } = await import('../../jev/heuristicStub');
  const { loadCorpus } = await import('../../jev/corpus');
  client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}, 60_000);

async function startTelnyx(): Promise<{ base: string; ws: string; traceDir: string }> {
  const traceDir = mkdtempSync(join(tmpdir(), 'telnyx-'));
  const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
  dirs.push(traceDir, audioDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    VOICE_PROVIDERS: 'telnyx',
    TELNYX_PUBLIC_KEY,
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    AUDIT_DIR: join(traceDir, 'audit'),
    AUDIO_DIR: audioDir,
  });
  running = await startServer(config, { host: '127.0.0.1', client: client!, log: () => {} });
  return { base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, traceDir };
}

/** A webhook as Telnyx signs it: Ed25519 over `<timestamp>|<body>`. */
async function postSigned(base: string, path: string, fields: Record<string, string>): Promise<{ status: number; text: string }> {
  const body = new URLSearchParams(fields).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'telnyx-timestamp': ts,
      'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64'),
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe('a Telnyx call end to end', () => {
  it('answers the signed webhook, runs the worked example over /conversation/telnyx, and hangs up through /cr-action/telnyx', async () => {
    const { base, ws, traceDir } = await startTelnyx();
    const events: DashboardEvent[] = [];
    running!.bus!.subscribe((e) => events.push(e));

    const answer = await postSigned(base, '/voice/telnyx', { CallSid: CALL_ID, From: '+15555550110', To: '+15555550111' });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('<ConversationRelay url="wss://localhost/conversation/telnyx?token=');
    const token = /token=([0-9a-f]{32})/.exec(answer.text)![1]!;

    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    // Shaped like Telnyx's documented setup frame (developers.telnyx.com, Conversation Relay), numbers fictional.
    relay.send({
      type: 'setup', sessionId: '7a7e6a4f-1d44-4f0c-b5d4-9f9bf3a5c1f2', accountSid: '1f1a8b6f-1234-4abc-9def-1234567890ab',
      callSid: CALL_ID, callControlId: CALL_ID, callSessionId: 'ff55a038-6f5d-11ef-9692-02420aeffb1f', callLegId: '428c31b6-7af4-4b6f-92e7-7a7e6a4f1d44',
      from: '+15555550110', to: '+15555550111', direction: 'inbound', callerName: '', callStatus: 'active', customParameters: {},
    });
    expect(await relay.waitForTexts(1)).toEqual([GREETING_TEXT]);
    expect(events.find((e) => e.type === 'call_started')).toMatchObject({ callSid: CALL_ID, channel: 'voice', provider: 'telnyx' });

    // Telnyx reports a bare language on its prompts.
    relay.prompt('can you deliver tomorrow morning', true, 'en');
    expect((await relay.waitForTexts(3)).at(-1)).toBe(ASK_ACCOUNT_ID);
    relay.prompt('five five five zero one two three four', true, 'en');
    expect((await relay.waitForTexts(4)).at(-1)).toBe("And what's your date of birth?");
    relay.prompt('april twelfth nineteen eighty five', true, 'en');
    expect((await relay.waitForTexts(7)).slice(-3)).toEqual(['Thanks, Alex.', 'On Saturday, September 19, we can deliver in the morning.', ANYTHING_ELSE]);
    // Telnyx drops a turn's text after the first last: true (seen on a live call), so only the turn's final line carries it.
    const texts = relay.received.filter((m) => m.type === 'text');
    expect(texts.slice(-3).map((m) => (m as { last?: boolean }).last)).toEqual([false, false, true]);
    relay.prompt("no, that's all", true, 'en');
    await relay.waitForTexts(8);
    expect(relay.texts().at(-1)).toBe(GOODBYE);
    // Telnyx drops what it has not said at `end` (seen on a live call), so the end waits until the
    // goodbye has played (END_AFTER_PLAYBACK): here, until Telnyx reports it played.
    expect(relay.received.some((m) => m.type === 'end')).toBe(false);
    relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
    relay.send({ type: 'info', name: 'tokensPlayed', value: GOODBYE });
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed","completed":["delivery_window"]}');
    relay.assertKnownTypes();
    relay.close();
    await relay.closed;

    // The call's files are named by a safe stem of Telnyx's v2: id.
    expect(existsSync(join(traceDir, `${safeFileStem(CALL_ID)}.jsonl`))).toBe(true);
    expect(existsSync(join(traceDir, `${safeFileStem(CALL_ID)}.frames.jsonl`))).toBe(true);

    // Telnyx posts the end frame's data to the <Connect action>, and the call is hung up.
    const done = await postSigned(base, '/cr-action/telnyx', { CallSid: CALL_ID, CallStatus: 'in-progress', HandoffData: end.handoffData as string });
    expect(done.status).toBe(200);
    expect(done.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(running!.store.get(CALL_ID)?.ended).toBe(true);
  });

  it('a caller who hangs up while the goodbye plays: no end is sent, and the callback hangs up rather than reconnecting', async () => {
    const { base, ws, traceDir } = await startTelnyx();
    const answer = await postSigned(base, '/voice/telnyx', { CallSid: CALL_ID, From: '+15555550110', To: '+15555550111' });
    const token = /token=([0-9a-f]{32})/.exec(answer.text)![1]!;
    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send({ type: 'setup', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: CALL_ID, from: null, to: null, direction: null, callStatus: 'active', customParameters: {}, sessionId: '05ff737c-0000-4000-8000-000000000000' });
    await relay.waitForTexts(1);
    relay.prompt('can you deliver tomorrow morning', true, 'en');
    await relay.waitForTexts(3);
    relay.prompt('five five five zero one two three four', true, 'en');
    await relay.waitForTexts(4);
    relay.prompt('april twelfth nineteen eighty five', true, 'en');
    await relay.waitForTexts(7);
    relay.prompt("no, that's all", true, 'en');
    await relay.waitForTexts(8);
    expect(relay.texts().at(-1)).toBe(GOODBYE);
    // The end is held for the goodbye; the caller hangs up first.
    relay.close();
    await relay.closed;
    const frames = join(traceDir, `${safeFileStem(CALL_ID)}.frames.jsonl`);
    const logged = () => readFileSync(frames, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
    for (let i = 0; i < 200 && !logged().some((l) => l.dir === 'log' && l.msg.endAfter !== undefined); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(logged().find((l) => l.dir === 'log' && l.msg.socketClosed === true)?.msg).toEqual({ socketClosed: true, ended: true });
    expect(logged().find((l) => l.dir === 'log' && l.msg.endAfter !== undefined)?.msg).toMatchObject({ endAfter: 'closed' });
    expect(logged().some((l) => l.dir === 'out' && l.msg.type === 'end')).toBe(false);
    expect(relay.received.some((m) => m.type === 'end')).toBe(false);
    // Telnyx's callback for a relay that ended unexpectedly would reconnect a live call: this one ended.
    const done = await postSigned(base, '/cr-action/telnyx', { CallSid: CALL_ID, CallStatus: 'in-progress', SessionStatus: 'failed', ErrorCode: '64105' });
    expect(done.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(running!.store.get(CALL_ID)?.ended).toBe(true);
  });

  it('a server stopping while the goodbye plays waits for its end before it closes the call', async () => {
    const { base, ws } = await startTelnyx();
    const answer = await postSigned(base, '/voice/telnyx', { CallSid: CALL_ID, From: '+15555550110', To: '+15555550111' });
    const token = /token=([0-9a-f]{32})/.exec(answer.text)![1]!;
    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send({ type: 'setup', callSid: '5e9fcc12-0000-4000-8000-000000000000', callControlId: CALL_ID, from: null, to: null, direction: null, callStatus: 'active', customParameters: {}, sessionId: '05ff737c-0000-4000-8000-000000000000' });
    await relay.waitForTexts(1);
    relay.prompt('can you deliver tomorrow morning', true, 'en');
    await relay.waitForTexts(3);
    relay.prompt('five five five zero one two three four', true, 'en');
    await relay.waitForTexts(4);
    relay.prompt('april twelfth nineteen eighty five', true, 'en');
    await relay.waitForTexts(7);
    relay.prompt("no, that's all", true, 'en');
    await relay.waitForTexts(8);
    // The call has ended for the store, but its goodbye is playing: the drain waits for the end.
    expect(running!.store.liveCount()).toBe(0);
    let drained = false;
    const drain = running!.drain(10_000).then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(drained).toBe(false);
    expect(relay.received.some((m) => m.type === 'end')).toBe(false);
    relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
    relay.send({ type: 'info', name: 'tokensPlayed', value: GOODBYE });
    await relay.waitFor((m) => m.type === 'end');
    await drain;
    expect(drained).toBe(true);
    relay.close();
    await relay.closed;
  });

  it('takes a setup shaped as a live Telnyx call sends it: numbers null, and the webhook id as callControlId', async () => {
    // Captured from a live call on 2026-10-05 (shape only; ids and numbers here are made up): the webhook's
    // CallSid is a v3: id; the setup's callSid is another, 36-character id, the v3: id comes as callControlId,
    // and from, to and direction are null, with the numbers in customParameters instead.
    const { base, ws } = await startTelnyx();
    const webhookId = 'v3:A2zgVYbjyExampleOnlyIdForTheTestsXyz0123456789abcdEF';
    const answer = await postSigned(base, '/voice/telnyx', { CallSid: webhookId, From: '+15555550110', To: '+15555550111' });
    expect(answer.status).toBe(200);
    const token = /token=([0-9a-f]{32})/.exec(answer.text)![1]!;
    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${token}`);
    relay.send({
      type: 'setup', from: null, to: null, direction: null, accountSid: '1f1a8b6f-1234-4abc-9def-1234567890ab',
      callControlId: webhookId, callLegId: '428c31b6-7af4-4b6f-92e7-7a7e6a4f1d44', callSessionId: 'ff55a038-6f5d-11ef-9692-02420aeffb1f',
      callSid: '5e9fcc12-0000-4000-8000-000000000000', callStatus: 'active', callerName: 'EXAMPLE CALLR',
      customParameters: { telnyx_call_from: '+15555550110', telnyx_call_to: '+15555550111', telnyx_conversation_channel: 'phone_call' },
      sessionId: '05ff737c-0000-4000-8000-000000000000',
    });
    expect(await relay.waitForTexts(1)).toEqual([GREETING_TEXT]);
    relay.close();
  });

  it('refuses an unsigned webhook, and answers no Twilio path when Twilio is not enabled', async () => {
    const { base, ws } = await startTelnyx();
    const unsigned = await fetch(`${base}/voice/telnyx`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `CallSid=${encodeURIComponent(CALL_ID)}` });
    expect(unsigned.status).toBe(403);
    expect((await postSigned(base, '/voice', { CallSid: CALL_ID })).status).toBe(404);
    const token = running!.tokens.mint(CALL_ID);
    await expect(FakeRelay.connect(`${ws}/conversation?token=${token}`)).rejects.toThrow(/404/);
    await expect(FakeRelay.connect(`${ws}/conversation/twilio?token=${token}`)).rejects.toThrow(/404/);
  });
});

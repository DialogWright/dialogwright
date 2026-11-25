import { describe, expect, it, vi } from 'vitest';
import type { AuditSink } from '../../audit/sink';
import type { OutboundFrame, TextFrame } from '../../channel/relay/frames';
import { policyOf } from '../../converse/policy';
import { newConverseState, type ConverseState } from '../../converse/state';
import { ConverseTurnError, converseTurn, type Out } from '../../converse/turn';
import type { ConverseTraceRecord } from '../../converse/trace';
import { converseFixture } from '../../testing/converse/app';
import type { ConverseCallEntry } from '../sessions';
import type { VoiceIo } from './io';
import { converseVoiceRuntime } from './converseRuntime';

/**
 * Whether a call's thrown turn says the done line, by the turn's own rule (Out.confirmed and Out.replied): a turn
 * stands in for converseTurn here, so the order of what it tells the channel is the test's. A fixed line or a
 * read-back said after the change leaves the done line owed; the model's own words (replied) do not.
 */

vi.mock('../../converse/turn', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../converse/turn')>();
  return { ...real, converseTurn: vi.fn(real.converseTurn) };
});

const GREETING = 'Example Visits, how can I help?';

function harness() {
  const { app } = converseFixture();
  const audit: AuditSink = { append: (callId, channel, d) => ({ ...d, seq: 1, at: new Date().toISOString(), callId, channel, prevHash: '', hash: '' }) };
  const traces: ConverseTraceRecord[] = [];
  const entry: ConverseCallEntry = {
    trace: { write: (r) => void traces.push(r as ConverseTraceRecord) },
    frames: { write: () => {} } as unknown as ConverseCallEntry['frames'],
    callSid: 'CA-owed-1',
    socket: { send() {}, close() {} },
    reconnects: 0,
    createdAtMs: Date.now(),
    lastActivityMs: Date.now(),
    ended: false,
    endedAtMs: null,
    tail: Promise.resolve(),
    inFlight: 0,
    auditEntries: [],
    provider: 'twilio',
    session: newConverseState({ appId: app.id, callId: 'CA-owed-1', channel: 'voice' }),
  };
  const sent: OutboundFrame[] = [];
  const io = {
    async send(frames: readonly OutboundFrame[]) {
      sent.push(...frames);
      return true;
    },
    async sendEnd(end: OutboundFrame) {
      sent.push(end);
      return true;
    },
    keepUndelivered: () => true,
    record() {},
    publish() {},
    async save() {},
    async finish() {},
    playback() {},
  } as unknown as VoiceIo;
  const rt = converseVoiceRuntime({
    apps: new Map([[app.id, app]]),
    converseDeps: (a) => ({ business: a.business, model: { id: 'none', async *stream() {} }, jev: { ask: async () => { throw new Error('not asked'); } }, policy: policyOf(a.business), audit, tools: a.tools, texts: null, now: () => new Date(), trace: () => {}, jevTimeoutMs: 1000 }),
    now: () => Date.now(),
  });
  const said = (): string[] => sent.filter((f): f is TextFrame => f.type === 'text').map((f) => f.token);
  return { rt, entry, io, said, traces };
}

/** A turn that tells the channel `steps` in order, then throws with a change kept (its done grown). */
function throwingTurn(steps: ((out: Out) => void)[]) {
  vi.mocked(converseTurn).mockImplementationOnce(async (s: ConverseState, _input, _deps, out) => {
    for (const step of steps) step(out);
    const reached: ConverseState = { ...structuredClone(s), done: [{ action: 'book', readBack: 'A visit. Is that right?', results: ['book: booked'] }] };
    throw new ConverseTurnError(reached, new Error('disk full'));
  });
}

describe('the converse voice runtime: the done line owed after a thrown turn, by the turn\'s rule', () => {
  it('a fixed line said after the change leaves the done line owed', async () => {
    const h = harness();
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    expect(h.said()).toEqual([GREETING]);
    throwingTurn([(o) => o.confirmed?.(), (o) => o.say("That's booked. ", false)]);
    await h.rt.frame(h.entry, { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true }, h.io);
    expect(h.said().slice(1)).toEqual(["That's booked. ", "That's done."]);
  });

  it('the model\'s own words after the change (replied) pay it: the recovery line follows a throw', async () => {
    const h = harness();
    await h.rt.open(h.entry, { callerNumber: null, provider: 'twilio' }, h.io);
    throwingTurn([(o) => o.confirmed?.(), (o) => o.say('You are booked. ', false), (o) => o.replied?.()]);
    await h.rt.frame(h.entry, { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true }, h.io);
    expect(h.said().slice(1)).toEqual(['You are booked. ', 'Sorry, could you say that again?']);
  });
});

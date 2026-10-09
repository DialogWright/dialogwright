import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { TEXTING_DIR, textingApp } from '../testing/texting/app';
import { PROPOSALS_DIR, proposalsApp } from '../testing/proposals/app';
import { standInCallerNumber } from '../core/callerNumber';
import { registerTestkit } from '../testing/testkit';
import type { App } from '../core/app/types';

/**
 * The caller's number offered on a live call (a digits slot's `callerNumber`), and the same call
 * replayed from its frame log. The log keeps only the number's last four, on a line of its own
 * (`{ callerNumber: '…0142' }`), and replay stands a made-up number ending in them in for it, so the
 * replayed call makes the offer the live one made.
 */

resetAppsForTest();
registerApp(callbackApp);
const corpus = loadCorpus(join(CALLBACK_DIR, 'fixtures', 'corpus.jsonl'), callbackApp);
const textingCorpus = loadCorpus(join(TEXTING_DIR, 'fixtures', 'corpus.jsonl'), textingApp);
const proposalsCorpus = loadCorpus(join(PROPOSALS_DIR, 'fixtures', 'corpus.jsonl'), proposalsApp);
let corpusInUse = corpus;
const client = () => new FixtureStubClient(corpusInUse, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-10-07' }) });

// A replayed session is the default app's (the first registered): the callback app.
beforeEach(() => {
  corpusInUse = corpus;
  resetAppsForTest();
  registerApp(callbackApp);
  registerTestkit();
});

function liveCall(provider: 'twilio' | 'telnyx', from: string | null, appId = callbackApp.id) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-caller-'));
  const opts = { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-07', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, appId),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps = { store, tokens, log: () => {} };
  const sock = { send: (_d: string, cb?: (e?: Error) => void) => { cb?.(); }, close: () => {} };
  const callId = provider === 'telnyx' ? 'v3:CALL7' : 'CA7';
  const ctx = newConnectionContext(tokens.mint(callId, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const setup = provider === 'telnyx'
    ? { type: 'setup', sessionId: 'TX7', callSid: '5e9fcc12-0000-4000-8000-000000000007', callControlId: callId, from: null, to: null, customParameters: { ...(from !== null ? { telnyx_call_from: from } : {}), telnyx_call_to: '+15555550111' } }
    : { type: 'setup', sessionId: 'VX7', callSid: callId, from: from ?? '', to: '+15555550100', customParameters: {} };
  const framesPath = join(dir, `${callId}.frames.jsonl`);
  return {
    store, callId, framesPath,
    start: () => send(setup),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    records: () => readFileSync(join(dir, `${callId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    replay: () => replayFrameLog(framesPath, { ...opts, client: client(), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
  };
}

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, (r.decision as { promptId?: string }).promptId ?? null, r.callerNumber ?? null];
const SAYS = ['can someone call me back', 'Jordan Avery', "yes, that's fine", "it's about an order", 'yes, please'];

describe('the caller\'s number, live and replayed', () => {
  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`replays a ${provider} call that offered the number as it ran: the offer, the yes, the callback`, async () => {
      const call = liveCall(provider, '+15555550142');
      await call.start();
      for (const t of SAYS) await call.say(t);
      const live = call.records();
      expect(live.map((r) => (r.decision as { promptId?: string }).promptId)).toContain('offer_phone');
      expect(live.at(-1)!.decision).toMatchObject({ kind: 'complete', promptId: 'callback_booked' });
      // The log keeps the last four on a line of its own, and nothing more of the number.
      const log = readFileSync(call.framesPath, 'utf8');
      expect(log).toContain('"callerNumber":"…0142"');
      expect(log).not.toContain('5555550142');

      const replayed = await call.replay();
      expect(replayed.skipped).toEqual([]);
      expect(replayed.records.map(shape)).toEqual(live.map(shape));
      // A stand-in, not the caller's number: the same last four, in the 555 range.
      expect(replayed.runs.at(-1)!.result.session.slots.phone!.value).toBe('5555550142');
    });
  }

  it('writes no line for a withheld number, and the replay asks as the call did', async () => {
    const call = liveCall('twilio', '+7378742833');
    await call.start();
    await call.say('can someone call me back');
    await call.say('Jordan Avery');
    expect(readFileSync(call.framesPath, 'utf8')).not.toContain('callerNumber');
    const live = call.records();
    expect(live.at(-1)!.decision).toMatchObject({ promptId: 'ask_phone' });
    expect((await call.replay()).records.map(shape)).toEqual(live.map(shape));
  });

  it('writes no line for an app without a slot that offers the number', async () => {
    resetAppsForTest();
    registerTestkit();
    registerApp(callbackApp);
    const call = liveCall('twilio', '+15555550142', 'testkit');
    await call.start();
    expect(readFileSync(call.framesPath, 'utf8')).not.toContain('callerNumber');
  });
});

describe('the caller\'s number of an app that keeps it for its code, live and replayed', () => {
  it('replays the call-start lookup as it ran: the stand-in is in the international form the carrier sent', async () => {
    // The texting fixture is the replayed session's app: the first registered.
    resetAppsForTest();
    registerApp(textingApp);
    corpusInUse = textingCorpus;
    const call = liveCall('twilio', '+15555550142', textingApp.id);
    await call.start();
    for (const t of ["I'd like to open a request", "it's about an order", 'yes, please text me', 'yes, open it']) await call.say(t);
    const live = call.records();
    // The number is on file as a mobile: the call-start lookup found it, and the offer was made with no line-type lookup.
    expect(live.map((r) => (r.decision as { promptId?: string }).promptId)).toContain('offer_textTo');
    expect(live.flatMap((r) => (r.gateEvents ?? []).map((e) => e.decision.call.tool))).not.toContain('lineType');
    expect(readFileSync(call.framesPath, 'utf8')).not.toContain('5555550142');

    const replayed = await call.replay();
    expect(replayed.skipped).toEqual([]);
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
    expect(replayed.runs[0]!.result.session.callerNumber).toBe('+15555550142');
    expect(replayed.runs[0]!.result.session.facts).toEqual({ lineType: 'mobile' });
  });
});

describe('a value proposed from the call-start lookup, live and replayed', () => {
  it('replays the proposal as it ran: the lookup by the stand-in finds the same street, and the model is sent the same', async () => {
    // The proposals fixture is the replayed session's app: the first registered.
    resetAppsForTest();
    registerApp(proposalsApp);
    corpusInUse = proposalsCorpus;
    const call = liveCall('twilio', '+15555550142', proposalsApp.id);
    await call.start();
    for (const t of ["I'd like to report a problem", 'yes', 'nothing is working at all', 'yes, file it']) await call.say(t);
    const live = call.records();
    expect(live.map((r) => (r.decision as { promptId?: string }).promptId)).toEqual(['greeting', 'offer_place', 'ask_problem', 'confirm_report_problem', 'anything_else']);
    expect(readFileSync(call.framesPath, 'utf8')).not.toContain('5555550142');

    const replayed = await call.replay();
    expect(replayed.skipped).toEqual([]);
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
    expect(replayed.runs[0]!.result.session.facts).toEqual({ serviceAddress: '22 Alder Street' });
    // The turn that answered the proposal: the same state sent to the model, its pending read-back the street.
    expect(JSON.stringify(replayed.records[2]!.turnState)).toBe(JSON.stringify(live[2]!.turnState));
    expect(live[2]!.turnState).toMatchObject({ pendingConfirmation: { target: 'place', value: '22 Alder Street' } });
  });
});

describe('the stand-in', () => {
  it('is the shortest made-up number ending in the four digits that the app keeps', () => {
    expect(standInCallerNumber(callbackApp, '0142')).toBe('5555550142');
    expect(standInCallerNumber(callbackApp, '014')).toBeUndefined();
    expect(standInCallerNumber(callbackApp, 'abcd')).toBeUndefined();
    const noOffer: App = { ...callbackApp, id: 'callback-none', slots: { ...callbackApp.slots, phone: { ...callbackApp.slots.phone!, callerNumber: undefined } } } as App;
    expect(standInCallerNumber(noOffer, '0142')).toBeUndefined();
  });

  it('is in international form for an app that keeps the number for its code, where its slot takes that too', () => {
    expect(standInCallerNumber(textingApp, '0142')).toBe('+15555550142');
    const hintOnly: App = { ...textingApp, id: 'texting-hint-only', slots: { ...textingApp.slots, textTo: { ...textingApp.slots.textTo!, callerNumber: undefined } } } as App;
    expect(standInCallerNumber(hintOnly, '0142')).toBe('+15555550142');
    // A slot that takes no +1 number: the slot's own stand-in, so the replay still makes its offer.
    const foreignSlot: App = { ...callbackApp, id: 'callback-hint', callerNumber: { use: 'hint' }, slots: { ...callbackApp.slots, phone: { ...callbackApp.slots.phone!, callerNumber: { take: (n: string) => (n.startsWith('+') ? null : { value: n, display: n }) } } } } as App;
    expect(standInCallerNumber(foreignSlot, '0142')).toBe('0142');
  });
});

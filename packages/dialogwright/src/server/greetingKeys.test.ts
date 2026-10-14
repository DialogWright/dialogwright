import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { replayFrameLog } from '../harness-text/replay';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { promptText } from '../prompts/render';
import { spanishSwitchVariants, type SwitchMenu } from '../testing/spanishSwitch';
import type { BargeIn } from '../channel/voiceProviders';
import type { App } from '../core/app/types';

/**
 * The keypad menu from the greeting on a live call, on each carrier (intents.yaml's menuListens, a menu
 * entry's fromGreeting): "para español, oprima 9" in the greeting, and the 9 pressed while it plays.
 * The carrier sends the key as a DTMF frame whatever BARGE_IN is; what BARGE_IN decides is only whether
 * the key cuts the greeting short (any, dtmf: the greeting line is interruptible) or the Spanish lines
 * follow it (none: every line goes out not interruptible). Replay from the frame log takes the same key.
 */

const CALL = 'CA17';
const variants = spanishSwitchVariants();
afterAll(() => variants.remove());
const NINE: SwitchMenu = { nineFromGreeting: true };

beforeEach(() => resetAppsForTest());
afterEach(() => forgetNoInput(CALL));

function liveCall(menu: SwitchMenu, provider: 'twilio' | 'telnyx', bargeIn: BargeIn) {
  resetAppsForTest();
  const app: App = variants.build(`library-keys-${provider}-${bargeIn}-${menu.nineFromGreeting === true ? 'nine' : 'off'}`, [], menu);
  // The first app registered is the default, which a replayed session is (harness-text/replay.ts).
  registerApp(app);
  const dir = mkdtempSync(join(tmpdir(), 'greeting-keys-'));
  const opts = { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-13', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn, noInputMs: 60_000 };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  return {
    app,
    start: () => send({ type: 'setup', sessionId: 'VX17', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    key: (digit: string) => send({ type: 'dtmf', digit }),
    sent,
    texts: () => sent.filter((f) => f.type === 'text').map((f) => ({ token: (f.token as string).trimEnd(), interruptible: f.interruptible })),
    records: () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    logged: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }).filter((l) => l.dir === 'log').map((l) => l.msg),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
    session: () => store.get(CALL)!.session,
  };
}

const shape = (r: TraceRecord) => [r.event.type, r.decision.kind, (r.decision as { promptId?: string }).promptId ?? null, r.locale ?? null, r.menuKey ?? null];

describe('a key the menu takes from the greeting on, through the voice adapter', () => {
  for (const provider of ['twilio', 'telnyx'] as const) {
    for (const bargeIn of ['any', 'none'] as const) {
      it(`${provider}, BARGE_IN ${bargeIn}: the 9 pressed at the greeting switches to Spanish, and replays the same`, async () => {
        const call = liveCall(NINE, provider, bargeIn);
        await call.start();
        const greeting = promptText(call.app, 'greeting', {});
        // The greeting is interruptible in prompts.yaml: by a key too under any; under none, said whole.
        expect(call.texts()).toEqual([{ token: greeting, interruptible: bargeIn === 'any' }]);
        await call.key('9');
        expect(call.session().locale).toBe('es');
        expect(call.sent.some((f) => f.type === 'language')).toBe(true);
        expect(call.texts().slice(1).map((t) => t.token)).toEqual(['Muy bien, seguimos en español.', '¿En qué puedo ayudarle hoy?']);
        const live = call.records();
        expect(live.at(-1)!.menuKey).toEqual({ digit: '9', intent: 'spanish' });
        // Replay from the frame log takes the same key at the same question.
        const replayed = await call.replay();
        expect(replayed.records.map(shape)).toEqual(live.map(shape));
      });
    }
  }

  it('telnyx, BARGE_IN none: a double press of the 9 says the switch once, and replays the same', async () => {
    const call = liveCall(NINE, 'telnyx', 'none');
    await call.start();
    await call.key('9');
    await call.key('9');
    await call.key('9');
    expect(call.texts().map((t) => t.token)).toEqual([promptText(call.app, 'greeting', {}), 'Muy bien, seguimos en español.', '¿En qué puedo ayudarle hoy?']);
    expect(call.sent.filter((f) => f.type === 'language')).toHaveLength(1);
    const live = call.records();
    expect(live.filter((r) => r.menuKey !== undefined)).toHaveLength(1);
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
  });

  it('twilio: a 9 keyed while the greeting\'s turn runs is taken once it has ended at the open question, and replays the same', async () => {
    const call = liveCall(NINE, 'twilio', 'any');
    // The setup's turn not awaited: the key arrives while it is queued or running, keyed ahead.
    const started = call.start();
    await call.key('9');
    await started;
    expect(call.logged()).toContainEqual({ keyedAhead: true });
    expect(call.logged()).toContainEqual({ aheadAccepted: '9' });
    expect(call.session().locale).toBe('es');
    const live = call.records();
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
  });

  for (const provider of ['twilio', 'telnyx'] as const) {
    it(`${provider}: with the option off, the 9 at the greeting is ignored, as before; and a key that does not listen, with it on`, async () => {
      const off = liveCall({}, provider, 'none');
      await off.start();
      await off.key('9');
      expect(off.texts()).toHaveLength(1);
      expect(off.session().locale).toBe('en-US');
      expect(off.records().every((r) => r.menuKey === undefined)).toBe(true);

      const on = liveCall(NINE, provider, 'any');
      await on.start();
      await on.key('1');
      expect(on.texts()).toHaveLength(1);
      expect(on.session().form).toBeNull();
    });
  }
});

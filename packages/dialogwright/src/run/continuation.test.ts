import { describe, expect, it } from 'vitest';
import { interruptEvent, keyEvents, silenceEvent, speechEvent, startEvent, type SessionEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp } from '../core/app/registry';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { useTestkit } from '../testing/apps';
import { ANONYMOUS } from '../gate/principal';
import { CONTINUE_MAX_FRAGMENTS, Continuation, continueWithinMsOf, DEFAULT_CONTINUE_WITHIN_MS, undoable } from './continuation';
import { CODE_MASK } from '../core/spokenCode';
import { runTurn, type TurnRun } from './turn';
import { defaultCorpusFile } from './fixtures';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';

useTestkit();
registerApp(placeApp());

const opts = () => ({ client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 });

/** The opening and the request, then `steps`, each through one Continuation (withinMs), as the server runs them. */
async function call(withinMs: number, steps: SessionEvent[]): Promise<{ runs: (TurnRun & { joined: readonly string[] | null })[]; session: Session; asked: string[] }> {
  const o = opts();
  const c = new Continuation(withinMs);
  let session = newSession('c1', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID);
  const runs: (TurnRun & { joined: readonly string[] | null })[] = [];
  for (const e of [startEvent(), speechEvent('i want to report a problem'), ...steps]) {
    const r = await c.run(session, e, o);
    session = r.result.session;
    runs.push(r);
  }
  return { runs, session, asked: o.client.asked };
}

/** The live call: three final prompts at short pauses, the first two re-asks talked over at once. */
const CUT_OFF = [
  speechEvent('at'), interruptEvent('Sorry, where', 119),
  speechEvent('22'), interruptEvent('Sorry', 154),
  speechEvent('Alder Street.'),
];

describe('a caller who had not finished (voice.continueWithinMs)', () => {
  it('defaults to 300 ms, and an app may set its own', () => {
    expect(DEFAULT_CONTINUE_WITHIN_MS).toBe(300);
    expect(continueWithinMsOf(placeApp())).toBe(300);
    expect(continueWithinMsOf(placeApp({ voice: { continueWithinMs: 0 } }))).toBe(0);
    expect(continueWithinMsOf(placeApp({ voice: { continueWithinMs: 800 } }))).toBe(800);
  });

  it('joins three fragments whose replies were cut off within the window into one turn, and fills the place whole', async () => {
    const { runs, session, asked } = await call(300, CUT_OFF);
    const last = runs.at(-1)!;
    expect(last.joined).toEqual(['at', '22', 'Alder Street.']);
    expect(last.record.event).toMatchObject({ type: 'user.speech', text: 'at 22 Alder Street.' });
    expect(last.record.joined).toEqual({ fragments: ['at', '22', 'Alder Street.'] });
    expect(session.slots.place!.value).toBe('at 22 Alder Street.');
    expect(last.result.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_report', vars: { place: 'at 22 Alder Street.' } });
    // The model heard each fragment, then the fragments joined, never "Alder Street." alone.
    expect(asked.slice(1)).toEqual(['at', 'at 22', 'at 22 Alder Street.']);
    // The trace has the fragments' turns and the joined ones; the middle turn joined the first two.
    expect(runs.map((r) => r.joined)).toEqual([null, null, null, null, ['at', '22'], null, ['at', '22', 'Alder Street.']]);
    // The re-asks the caller talked over left nothing: the joined turn ran on the session as it was
    // before "at" (no retry counted, no barge-in reported), and the turn numbers still only go up.
    expect(session.slots.place!.attempts).toBe(runs[1]!.result.session.slots.place!.attempts);
    expect(last.record.turnState).toMatchObject({ asr: { text: 'at 22 Alder Street.', bargeIn: false } });
    expect(last.result.session.lastInterrupt).toBeNull();
    const spoken = runs.filter((r) => r.result.decision.kind !== 'ignore').map((r) => r.record.turnIndex);
    expect(new Set(spoken).size).toBe(spoken.length);
    expect([...spoken].sort((a, b) => a - b)).toEqual(spoken);
  });

  it('takes an interrupt after the window as an ordinary barge-in', async () => {
    const { runs, session } = await call(300, [speechEvent('at'), interruptEvent('Sorry, where is', 800), speechEvent('22'), interruptEvent('Sorry, where is', 301), speechEvent('Alder Street.')]);
    expect(runs.every((r) => r.joined === null)).toBe(true);
    expect(session.slots.place!.value).toBe('Alder Street.');
    expect(runs.at(-1)!.record.event).toMatchObject({ text: 'Alder Street.' });
  });

  it('with the option 0, runs every turn as today', async () => {
    const { runs, session } = await call(0, CUT_OFF);
    expect(runs.every((r) => r.joined === null)).toBe(true);
    expect(session.slots.place!.value).toBe('Alder Street.');
    // Turn for turn what runTurn alone gives.
    const o = opts();
    let s = newSession('c1', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID);
    const plain: TurnRun[] = [];
    for (const e of [startEvent(), speechEvent('i want to report a problem'), ...CUT_OFF]) {
      const r = await runTurn(s, e, o);
      s = r.result.session;
      plain.push(r);
    }
    const untimed = ({ timing: _timing, ...rest }: TurnRun['record']) => rest;
    expect(runs.map((r) => untimed(r.record))).toEqual(plain.map((r) => untimed(r.record)));
    expect(plain.every((r) => !('joined' in r.record))).toBe(true);
  });

  it('ends joining at a key pressed in between', async () => {
    const { runs } = await call(300, [speechEvent('at'), interruptEvent('Sorry', 119), ...keyEvents('1'), speechEvent('22')]);
    expect(runs.at(-1)!.joined).toBeNull();
    expect(runs.at(-1)!.record.event).toMatchObject({ text: '22' });
  });

  it('ends joining at a no-input silence', async () => {
    const { runs } = await call(300, [speechEvent('at'), interruptEvent('Sorry', 119), silenceEvent(), speechEvent('22')]);
    expect(runs.at(-1)!.joined).toBeNull();
    expect(runs.at(-1)!.record.event).toMatchObject({ text: '22' });
  });

  it('does not join when the reply was not cut off: a prompt after a reply heard whole is a turn of its own', async () => {
    const { runs } = await call(300, [speechEvent('at'), speechEvent('22')]);
    expect(runs.at(-1)!.joined).toBeNull();
  });

  it(`joins at most ${CONTINUE_MAX_FRAGMENTS} fragments`, async () => {
    const { runs } = await call(300, [
      speechEvent('at'), interruptEvent('Sorry', 100),
      speechEvent('22'), interruptEvent('Sorry', 100),
      speechEvent('Alder'), interruptEvent('Sorry', 100),
      speechEvent('Street.'),
    ]);
    expect(runs.map((r) => r.joined).filter(Boolean)).toEqual([['at', '22'], ['at', '22', 'Alder']]);
    expect(runs.at(-1)!.joined).toBeNull();
    expect(runs.at(-1)!.record.event).toMatchObject({ text: 'Street.' });
  });

  it('never joins after an interrupt that cut off no reply to a final prompt (the greeting)', async () => {
    const o = opts();
    const c = new Continuation(300);
    let session = newSession('c2', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID);
    const runs: (TurnRun & { joined: readonly string[] | null })[] = [];
    for (const e of [startEvent(), interruptEvent('Hello', 50), speechEvent('i want to report a problem'), interruptEvent('Where', 80), speechEvent('at 22 Alder Street.')]) {
      const r = await c.run(session, e, o);
      session = r.result.session;
      runs.push(r);
    }
    // The request after the cut-off greeting is its own turn; the place after the cut-off question
    // joins only the request's turn, which spoke and only spoke.
    expect(runs[2]!.joined).toBeNull();
    expect(runs.at(-1)!.joined).toEqual(['i want to report a problem', 'at 22 Alder Street.']);
  });

  it('a caller who came back in at once (resumed, from a carrier\'s report of the caller speaking) joins as an interrupt in the window does', async () => {
    const o = opts();
    /** The opening, the request and "at", then `between` on the Continuation, then "22". */
    const run = async (withinMs: number, between: (c: Continuation) => void) => {
      const c = new Continuation(withinMs);
      let session = newSession('c3', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID);
      let last: (TurnRun & { joined: readonly string[] | null }) | null = null;
      for (const e of [startEvent(), speechEvent('i want to report a problem'), speechEvent('at'), null, speechEvent('22')]) {
        if (e === null) {
          between(c);
          continue;
        }
        last = await c.run(session, e, o);
        session = last.result.session;
      }
      return last!;
    };
    expect((await run(300, (c) => c.resumed())).joined).toEqual(['at', '22']);
    // The adapter decides by the caller's pause, not the window: a short window still joins.
    expect((await run(1, (c) => c.resumed())).joined).toEqual(['at', '22']);
    // Without it, "22" is a turn of its own; with the option 0, nothing ever joins.
    expect((await run(300, () => {})).joined).toBeNull();
    expect((await run(0, (c) => c.resumed())).joined).toBeNull();
    // After joining was ended by a reset (a key the server drops, a reconnect), nothing to continue.
    expect((await run(300, (c) => { c.reset(); c.resumed(); })).joined).toBeNull();
  });

  it('undoes only a turn that did nothing but speak', async () => {
    const { runs } = await call(300, [speechEvent('at')]);
    const spoke = runs.at(-1)!.result;
    expect(undoable(spoke)).toBe(true);
    expect(undoable({ ...spoke, actions: [...spoke.actions, { type: 'set_language', tts: 'es-MX', transcription: 'es-MX' }] })).toBe(false);
    expect(undoable({ ...spoke, actions: [] })).toBe(false);
    expect(undoable({ ...spoke, effects: [{ kind: 'service', service: 'x', request: {}, key: 'k' } as never] })).toBe(false);
    expect(undoable({ ...spoke, gateEvents: [{} as never] })).toBe(false);
    expect(undoable({ ...spoke, quarantined: true })).toBe(false);
    expect(undoable({ ...spoke, session: { ...spoke.session, ended: true } })).toBe(false);
    expect(undoable({ ...spoke, session: { ...spoke.session, pendingService: 'x' } })).toBe(false);
    expect(undoable({ ...spoke, decision: { kind: 'ignore' } as never })).toBe(false);
  });

  it('at the code prompt, a code said aloud across fragments is masked in the joined record, fragments and all', async () => {
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const o = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const c = new Continuation(300);
    let s: Session = { ...newSession('t2', 0, VOICE_RELAY), promptedFor: 'otp', lastPromptId: 'ask_otp' };
    const runs: (TurnRun & { joined: readonly string[] | null })[] = [];
    for (const e of [speechEvent('4 8'), interruptEvent('Please key', 90), speechEvent('1 5 9 2')]) {
      const r = await c.run(s, e, o);
      s = r.result.session;
      runs.push(r);
    }
    const last = runs.at(-1)!;
    expect(last.joined).toEqual(['4 8', '1 5 9 2']);
    expect(last.record.event).toMatchObject({ type: 'user.speech', text: CODE_MASK });
    expect(last.record.joined!.fragments.join(' ')).not.toMatch(/\d/);
  });

  it('never undoes a turn that went through the gate: the testkit asks for identity, and the next prompt is its own', async () => {
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const o = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const c = new Continuation(300);
    let s = newSession('t1', 0, VOICE_RELAY);
    const runs: (TurnRun & { joined: readonly string[] | null })[] = [];
    for (const e of [startEvent(), speechEvent('can you tell me the status of parcel 7101'), interruptEvent('x', 10), speechEvent('five five five zero one two three four')]) {
      const r = await c.run(s, e, o);
      s = r.result.session;
      runs.push(r);
    }
    expect(runs[1]!.result.gateEvents.length).toBeGreaterThan(0);
    expect(runs.at(-1)!.joined).toBeNull();
  });
});

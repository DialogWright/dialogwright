import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { evaluateGates, frustrationOf } from './gates';
import { newSession, setForm, type Session } from './session';
import { buildTurnState } from './state';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp } from './app/registry';
import { testkitApp } from '../testing/testkit';
import type { App, IntentDef } from './app/types';

useTestkit();

const T = { ...DEFAULT_THRESHOLDS };

function baseAnswers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95),
    intelligible: noul(0.95),
    utteranceComplete: noul(0.9),
    wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1),
    confusedByPrompt: noul(0.1),
    spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ report_missing: 0.9, track_parcel: 0.05, none: 0.05 }),
    ...over,
  };
}

function run(session: Session, answers: AnswerMap, isFinal = true, given?: ReadonlySet<string>) {
  const ts = buildTurnState(session, { text: 'x', isFinal, dtmf: null }, 0);
  return evaluateGates(session, ts, answers, T, given);
}

/** Mid-form, with the transfer offer waiting for an answer. */
function atOffer(): Session {
  const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
  s.pendingConfirmation = { target: 'transfer', attempts: 0 };
  s.promptedFor = 'confirm';
  return s;
}

describe('evaluateGates', () => {
  it('ignores side speech', () => {
    const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ addressedToSystem: noul(0.2) }));
    expect(r.verdict).toEqual({ kind: 'ignore' });
    expect(r.rows.find((g) => g.gate === 'addressedToSystem')).toMatchObject({ passed: false, decided: true, threshold: DEFAULT_THRESHOLDS.GATE_ADDRESSED });
  });

  it('routes on an intent probability that is the threshold up to floating-point rounding', () => {
    // 0.7 - 0.3 is 0.39999999999999997; INTENT_EXPLICIT is 0.4.
    const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.7 - 0.3, none: 0.35, other: 0.25 }) }));
    expect(r.verdict).toMatchObject({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
    // And a margin that is 0.15 on paper passes GATE_INTENT_MARGIN (0.15).
    const m = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.6, track_parcel: 0.45, none: 0 }) }));
    expect(0.6 - 0.45 >= 0.15).toBe(false);
    expect(m.verdict).toMatchObject({ kind: 'route', intent: 'report_missing' });
    expect(m.rows.find((g) => g.gate === 'intentMargin')).toMatchObject({ passed: true });
  });

  it('reprompts on unintelligible text', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intelligible: noul(0.2) })).verdict).toEqual({ kind: 'nomatch' });
  });

  it('holds an incomplete partial but only notes an incomplete final', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ utteranceComplete: noul(0.2) }), false).verdict).toEqual({ kind: 'hold' });
    const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ utteranceComplete: noul(0.2) }), true);
    expect(r.verdict.kind).toBe('route');
    expect(r.rows.find((g) => g.gate === 'utteranceComplete')?.outcome).toBe('noted');
  });

  it('hands off when the caller wants a human', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ wantsHuman: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  describe('frustration rungs', () => {
    const angry = (over: AnswerMap = {}) => baseAnswers({ frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }), ...over });
    const frustrationRow = (r: ReturnType<typeof run>) => r.rows.find((g) => g.gate === 'frustration');

    it('acknowledges the first frustrated turn, on any attempt', () => {
      const first = run(newSession('s', 0, VOICE_RELAY), angry());
      expect(first.verdict).toMatchObject({ kind: 'route', intent: 'report_missing', frustration: 'ack' });
      expect(frustrationRow(first)).toMatchObject({ value: 0.7, threshold: T.GATE_FRUSTRATION_HIGH, passed: true, outcome: 'ack', decided: false });
      // The old rule -- high frustration on a repeated attempt hands off at once -- is gone.
      const s = newSession('s', 0, VOICE_RELAY);
      s.promptedFor = 'intent';
      s.intentAttempts = 1;
      expect(run(s, angry()).verdict).toMatchObject({ kind: 'route', frustration: 'ack' });
    });

    it('offers a transfer on the second frustrated turn', () => {
      const s = newSession('s', 0, VOICE_RELAY);
      s.frustratedTurns = 1;
      const r = run(s, angry());
      expect(r.verdict).toMatchObject({ kind: 'route', frustration: 'offer' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'offer', decided: false });
    });

    it('hands off on the third frustrated turn', () => {
      const s = newSession('s', 0, VOICE_RELAY);
      s.frustratedTurns = 2;
      const r = run(s, angry());
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(frustrationRow(r)).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
    });

    it('hands off on the second frustrated turn when the offer was already declined', () => {
      const s = newSession('s', 0, VOICE_RELAY);
      s.frustratedTurns = 1;
      s.transferDeclined = true;
      expect(run(s, angry()).verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
    });

    it('transfers on the third rung even when the words came through garbled', () => {
      // Gate 2 settles a `nomatch` first and `decide` is first-wins, so the rung has to take the
      // verdict off it: a caller this upset for the third time gets a person either way.
      const s = newSession('s', 0, VOICE_RELAY);
      s.frustratedTurns = 2;
      const r = run(s, angry({ intelligible: noul(0.1) }));
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(frustrationRow(r)).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
      // The intelligible row keeps its failure and loses only the credit for the verdict.
      expect(r.rows.find((g) => g.gate === 'intelligible')).toMatchObject({ passed: false, outcome: 'nomatch', decided: false });
    });

    it('does not transfer on an outburst that was not addressed to it, and says so in the row', () => {
      const s = newSession('s', 0, VOICE_RELAY);
      s.frustratedTurns = 2;
      const r = run(s, angry({ addressedToSystem: noul(0.1) }));
      expect(r.verdict).toEqual({ kind: 'ignore' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'not_addressed', decided: false });
      // No rung on the verdict is what keeps `frustratedTurns` where it was: side speech is not
      // a turn the caller spent on us.
      expect(frustrationOf(r.verdict)).toBeUndefined();
    });

    it('does not count the turn that answers the offer', () => {
      const s = atOffer();
      s.frustratedTurns = 2;
      const r = run(s, angry({ confirmsYes: noul(0.9), confirmsNo: noul(0.05) }));
      // Counting it would hand off the caller who is telling us, crossly, to keep going.
      expect(r.verdict).toEqual({ kind: 'confirmed' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'pass' });
    });

    it('ignores mild frustration', () => {
      const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ frustration: score({ none: 0.3, mild: 0.6, high: 0.1 }) }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'pass' });
    });
  });

  describe('the transfer offer', () => {
    it('confirms on yes and declines on anything else', () => {
      expect(run(atOffer(), baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.05) })).verdict).toEqual({ kind: 'confirmed' });
      expect(run(atOffer(), baseAnswers({ confirmsYes: noul(0.05), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
      // An answer that is neither a yes nor a no declines the offer as well,
      // rather than leaving it pending and asking it again.
      const neither = run(atOffer(), baseAnswers({ confirmsYes: noul(0.1), confirmsNo: noul(0.1), intent: choice({ none: 0.9, other: 0.1 }) }));
      expect(neither.verdict).toEqual({ kind: 'rejected' });
      expect(neither.rows.find((g) => g.gate === 'confirmation')).toMatchObject({ outcome: 'rejected', decided: true });
    });

    it('keeps the frustrated reason when the yes also reads as asking for a person', () => {
      // "yes, connect me" trips the wantsHuman gate, which runs before the confirmation gate.
      // The caller is accepting the transfer we offered, so the reason -- and the line that plays
      // with it -- is the frustrated one, not the generic live-agent handoff.
      const s = atOffer();
      s.frustratedTurns = 2;
      const r = run(s, baseAnswers({
        wantsHuman: noul(0.9), confirmsYes: noul(0.9), confirmsNo: noul(0.05),
        frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }),
      }));
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(r.rows.find((g) => g.gate === 'wantsHuman')).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
      // And it is still the turn that answers the offer, so it is not a frustrated turn to count,
      // however crossly it was said: `frustratedTurns` is the turn's own bookkeeping, driven by a
      // rung on the verdict, and the gate passes rather than reaching for a third rung.
      expect(frustrationOf(r.verdict)).toBeUndefined();
      expect(r.rows.find((g) => g.gate === 'frustration')).toMatchObject({ passed: true, outcome: 'pass' });
    });

    it('still hands off as live-agent when no transfer is pending', () => {
      const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
      expect(run(s, baseAnswers({ wantsHuman: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    });
  });

  it('routes silently, with implicit confirm, or with explicit confirm by band', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers()).verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.65, none: 0.35 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'implicit' });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.5, none: 0.5 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.3, none: 0.7 }) })).verdict)
      .toEqual({ kind: 'intent_failed' });
  });

  it('disambiguates a narrow margin between two form intents', () => {
    const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.5, track_parcel: 0.45, none: 0.05 }) }));
    expect(r.verdict).toEqual({ kind: 'disambiguate_intent', a: 'report_missing', b: 'track_parcel' });
  });

  it('proceeds to slot filling when a form is active and no new intent is expressed', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    expect(run(s, baseAnswers({ intent: choice({ none: 0.9, track_parcel: 0.1 }) })).verdict).toEqual({ kind: 'proceed' });
  });

  it('switches forms on a confident new intent', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    expect(run(s, baseAnswers({ intent: choice({ report_missing: 0.9, none: 0.1 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
  });

  it('resolves a pending explicit confirmation', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.pendingConfirmation = { target: 'intent', intent: 'track_parcel', answers: {}, text: '' };
    expect(run(s, baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'confirmed' });
    expect(run(s, baseAnswers({ confirmsYes: noul(0.1), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
  });

  it('routes a spoken menu number when the menu is active', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.menuActive = true;
    const r = run(s, baseAnswers({ intent: choice({ none: 0.9, other: 0.1 }), menuNumberSaid: choice({ '3': 0.9, none: 0.1 }) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
    // 0 is a person, not a form.
    expect(run(s, baseAnswers({ intent: choice({ none: 0.9, other: 0.1 }), menuNumberSaid: choice({ '0': 0.9, none: 0.1 }) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  it('asks to confirm a mid-confidence intent switch', () => {
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
    expect(run(s, baseAnswers({ intent: choice({ report_missing: 0.7, none: 0.3 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
  });

  it('reports an unanswered confirmation when no new intent is expressed', () => {
    const s = newSession('s', 0, VOICE_RELAY);
    s.pendingConfirmation = { target: 'intent', intent: 'track_parcel', answers: {}, text: '' };
    const r = run(s, baseAnswers({
      confirmsYes: noul(0.5), confirmsNo: noul(0.5), intent: choice({ none: 0.9, other: 0.1 }),
    }));
    expect(r.verdict).toEqual({ kind: 'confirm_unanswered' });
  });

  it('handles agent and repeat intents', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ agent: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ repeat_prompt: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'replay' });
  });
  it('routes a tentative request with an explicit confirm even at full probability', () => {
    const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ track_parcel: 0.98, none: 0.02 }), intentTentative: noul(0.9) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'track_parcel', confirm: 'explicit' });
    expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('route_tentative:track_parcel');
    expect(r.rows.find((g) => g.gate === 'intentTentative')).toMatchObject({ threshold: DEFAULT_THRESHOLDS.INTENT_TENTATIVE, passed: true, outcome: 'tentative' });
  });

  it('leaves agent and repeat requests alone when tentative', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ agent: 0.9, none: 0.1 }), intentTentative: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  it('still disambiguates a narrow margin when the request is tentative', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.52, track_parcel: 0.48 }), intentTentative: noul(0.9) })).verdict)
      .toEqual({ kind: 'disambiguate_intent', a: 'report_missing', b: 'track_parcel' });
  });

  describe('inside a form', () => {
    const inForm = () => setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');

    it('treats a confident different intent as answering when intentChange says so', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ delivery_window: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.9, adding: 0.05, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intentChange')).toMatchObject({ outcome: 'answering', threshold: DEFAULT_THRESHOLDS.INTENT_CHANGE });
    });

    it('queues an added intent', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ delivery_window: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'queue', intent: 'delivery_window' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('queue:delivery_window');
    });

    it('does not queue the active form or a weak intent', () => {
      const same = run(inForm(), baseAnswers({ intent: choice({ report_missing: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) }));
      expect(same.verdict).toEqual({ kind: 'proceed' });
      expect(same.rows.find((g) => g.gate === 'intent')?.outcome).toBe('add_unused:report_missing');
      expect(run(inForm(), baseAnswers({ intent: choice({ delivery_window: 0.5, none: 0.5 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
    });

    it('reads the added task from what is not the task in hand', () => {
      // "yes, and can I also track another parcel" at the report's summary, as Jev read it: the
      // yes goes on with the report, and the rest of the probability is the tracking.
      const adding = choice({ adding: 1, answering: 0, replacing: 0 });
      const r = run(inForm(), baseAnswers({ intent: choice({ track_parcel: 0.55, report_missing: 0.41, none: 0.04 }), intentChange: adding }));
      expect(r.verdict).toEqual({ kind: 'queue', intent: 'track_parcel' });
      expect(r.rows.find((g) => g.gate === 'intent')).toMatchObject({ outcome: 'queue:track_parcel', value: expect.closeTo(0.55 / 0.59, 5) });
      // Most of the rest a request for nothing: nothing is added.
      expect(run(inForm(), baseAnswers({ intent: choice({ report_missing: 0.45, none: 0.4, track_parcel: 0.15 }), intentChange: adding })).verdict).toEqual({ kind: 'proceed' });
    });

    it('does not queue a sliver beside a near-certain task in hand', () => {
      // 0.04 beside 0.95 is a 0.8 share of the rest, but under the absolute floor.
      const adding = choice({ adding: 1, answering: 0, replacing: 0 });
      const r = run(inForm(), baseAnswers({ intent: choice({ report_missing: 0.95, track_parcel: 0.04, none: 0.01 }), intentChange: adding }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toMatch(/^add_unused/);
    });

    it('switches on replacing, explicitly when tentative', () => {
      const replacing = choice({ replacing: 0.9, answering: 0.05, adding: 0.05 });
      expect(run(inForm(), baseAnswers({ intent: choice({ track_parcel: 0.95, none: 0.05 }), intentChange: replacing })).verdict).toEqual({ kind: 'route', intent: 'track_parcel', confirm: 'none' });
      const r = run(inForm(), baseAnswers({ intent: choice({ track_parcel: 0.95, none: 0.05 }), intentChange: replacing, intentTentative: noul(0.8) }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'track_parcel', confirm: 'explicit' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('switch_tentative:track_parcel');
    });

    it('falls back to answering below the change threshold', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ track_parcel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.5, answering: 0.45, adding: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intentChange')).toMatchObject({ passed: false, outcome: 'answering:below' });
    });

    it('proceeds on an unrecognized change label', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ track_parcel: 0.95, none: 0.05 }), intentChange: choice({ swapping: 0.9, answering: 0.05, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('proceed:track_parcel');
    });

    it('hands off to an agent before the change mode is consulted', () => {
      expect(run(inForm(), baseAnswers({ intent: choice({ agent: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) })).verdict)
        .toEqual({ kind: 'handoff', reason: 'live-agent' });
    });

    it('still reports an unanswered confirmation when the intent would be queued', () => {
      const s = inForm();
      s.pendingConfirmation = { target: 'intent', intent: 'track_parcel', answers: {}, text: '' };
      expect(run(s, baseAnswers({
        confirmsYes: noul(0.1), confirmsNo: noul(0.1),
        intent: choice({ delivery_window: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'confirm_unanswered', queue: 'delivery_window' });
    });
  });

  describe('form confirmation', () => {
    const pending = (): Session => {
      const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
      s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
      s.promptedFor = 'confirm';
      return s;
    };

    it('confirms on yes and carries an added intent', () => {
      const a = baseAnswers({ confirmsYes: noul(0.9), intent: choice({ delivery_window: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) });
      expect(run(pending(), a).verdict).toEqual({ kind: 'confirmed', queue: 'delivery_window' });
    });

    it('rejects on no, with the queue when one was added', () => {
      expect(run(pending(), baseAnswers({ confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
      expect(run(pending(), baseAnswers({
        confirmsNo: noul(0.9), intent: choice({ delivery_window: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'rejected', queue: 'delivery_window' });
    });

    it('reopens the named detail when the no says which one is wrong', () => {
      const r = run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ missingNote: 0.9, expectedDate: 0.1 }) }));
      expect(r.verdict).toEqual({ kind: 'change_slot', slot: 'missingNote' });
      expect(r.rows.find((x) => x.gate === 'changeSlot')).toMatchObject({ outcome: 'change:missingNote', decided: true });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(false);
      // The queue still rides along.
      expect(run(pending(), baseAnswers({
        confirmsNo: noul(0.9), changeSlot: choice({ missingNote: 0.9, expectedDate: 0.1 }),
        intent: choice({ delivery_window: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'change_slot', slot: 'missingNote', queue: 'delivery_window' });
    });

    it('stays a plain no when the answer names no detail', () => {
      const r = run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ none: 0.9, missingNote: 0.05, expectedDate: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'rejected' });
      expect(r.rows.find((x) => x.gate === 'changeSlot')).toMatchObject({ outcome: 'none', passed: false, decided: false });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(true);
      // Below the threshold it is a no as well: turn.ts reads the utterance for a value instead.
      expect(run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ missingNote: 0.5, none: 0.5 }) })).verdict).toEqual({ kind: 'rejected' });
    });

    it('names the slot to change when asked what to change', () => {
      const v = run(pending(), baseAnswers({ changeSlot: choice({ expectedDate: 0.9, missingNote: 0.1 }) })).verdict;
      expect(v).toEqual({ kind: 'change_slot', slot: 'expectedDate' });
      expect(run(pending(), baseAnswers({ changeSlot: choice({ expectedDate: 0.5, none: 0.5 }) })).verdict).toEqual({ kind: 'confirm_unanswered' });
    });

    it('does not honor a changeSlot naming a slot the form does not have', () => {
      // The missing-parcel report has no parcel to choose, so a named 'parcelSelect' must not be honored as a change target.
      expect(run(pending(), baseAnswers({ changeSlot: choice({ parcelSelect: 0.9, none: 0.1 }) })).verdict).toEqual({ kind: 'confirm_unanswered' });
      // Nor an identity factor: no form lists one, so the summary cannot reopen it.
      expect(run(pending(), baseAnswers({ changeSlot: choice({ accountId: 0.9, none: 0.1 }) })).verdict).toEqual({ kind: 'confirm_unanswered' });
    });

    describe('a detail named in the same breath as a new value (App.changeSlotWithValue)', () => {
      const changeRow = (r: ReturnType<typeof run>) => r.rows.find((x) => x.gate === 'changeSlot');
      const decidedGate = (r: ReturnType<typeof run>): string | undefined => r.rows.find((x) => x.decided)?.gate;
      const named = (over: AnswerMap = {}) => baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ missingNote: 0.62, none: 0.38 }), ...over });
      const appWith = (value: NonNullable<App['changeSlotWithValue']>): string => {
        const id = `testkit-change-${value}`;
        registerApp({ ...testkitApp, id, changeSlotWithValue: value });
        return id;
      };
      const SET_ASIDE = appWith('set-aside');
      const DECIDES = appWith('decides');
      const withOption = (value: 'set-aside' | 'decides' | undefined): Session => {
        if (value === undefined) return pending();
        const s = setForm(newSession('s', 0, VOICE_RELAY, undefined, value === 'set-aside' ? SET_ASIDE : DECIDES), 'report_missing');
        s.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
        s.promptedFor = 'confirm';
        return s;
      };

      it('sets the naming aside when the turn gives another slot a new value: a no with a correction', () => {
        const r = run(withOption(undefined), named(), true, new Set(['expectedDate']));
        expect(r.verdict).toEqual({ kind: 'rejected' });
        expect(changeRow(r)).toMatchObject({ outcome: 'value_given:missingNote', passed: false, decided: false });
        expect(decidedGate(r)).toBe('confirmation');
      });

      it('sets it aside when the new value is for the slot named itself', () => {
        expect(run(withOption(undefined), named(), true, new Set(['missingNote'])).verdict).toEqual({ kind: 'rejected' });
      });

      it('leaves an unanswered summary unanswered, with the value for turn.ts to fill', () => {
        const r = run(withOption(undefined), baseAnswers({ changeSlot: choice({ expectedDate: 0.9, none: 0.1 }) }), true, new Set(['expectedDate']));
        expect(r.verdict).toEqual({ kind: 'confirm_unanswered' });
        expect(changeRow(r)).toMatchObject({ outcome: 'value_given:expectedDate' });
      });

      it('carries an added intent onto the rejection', () => {
        const r = run(withOption(undefined), named({ intent: choice({ delivery_window: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) }), true, new Set(['expectedDate']));
        expect(r.verdict).toEqual({ kind: 'rejected', queue: 'delivery_window' });
      });

      it('still reopens the detail named when the turn gives no new value (a value said again unchanged is none)', () => {
        // turn.ts passes no slot for a value equal to the one held ("no, it's Patel" with Patel held).
        const r = run(withOption(undefined), named(), true, new Set());
        expect(r.verdict).toEqual({ kind: 'change_slot', slot: 'missingNote' });
        expect(changeRow(r)).toMatchObject({ outcome: 'change:missingNote', decided: true });
      });

      it('says set-aside by default and when the app says it', () => {
        expect(run(withOption('set-aside'), named(), true, new Set(['expectedDate'])).verdict).toEqual({ kind: 'rejected' });
      });

      it('lets the naming decide as before when the app says decides', () => {
        const r = run(withOption('decides'), named(), true, new Set(['expectedDate']));
        expect(r.verdict).toEqual({ kind: 'change_slot', slot: 'missingNote' });
        expect(changeRow(r)).toMatchObject({ outcome: 'change:missingNote', decided: true });
        expect(run(withOption('decides'), named(), true, new Set(['missingNote'])).verdict).toEqual({ kind: 'change_slot', slot: 'missingNote' });
      });

      it('ignores a value given when the naming is below SLOT_CHANGE, as a plain no ever was', () => {
        const r = run(withOption(undefined), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ missingNote: 0.5, none: 0.5 }) }), true, new Set(['expectedDate']));
        expect(r.verdict).toEqual({ kind: 'rejected' });
        expect(changeRow(r)).toMatchObject({ outcome: 'none' });
      });
    });

    it('carries an added intent onto a change_slot verdict', () => {
      const v = run(pending(), baseAnswers({
        changeSlot: choice({ expectedDate: 0.9, none: 0.1 }), intent: choice({ delivery_window: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict;
      expect(v).toEqual({ kind: 'change_slot', slot: 'expectedDate', queue: 'delivery_window' });
    });

    it('breaks a yes/no tie toward confirmed', () => {
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'confirmed' });
    });

    it('confirms on yes even when the intent Choice is quiet', () => {
      // The intent gate has no opinion at all here; the summary's yes still decides.
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), intent: choice({ none: 0.9 }) })).verdict).toEqual({ kind: 'confirmed' });
    });

    it('marks the row that actually decided: confirmation for yes/no/unanswered, changeSlot for a named detail', () => {
      const decidedGate = (r: ReturnType<typeof run>): string | undefined => r.rows.find((x) => x.decided)?.gate;
      const intentOutcome = (r: ReturnType<typeof run>): string | undefined => r.rows.find((x) => x.gate === 'intent')?.outcome;

      const yes = run(pending(), baseAnswers({ confirmsYes: noul(0.9) }));
      expect(decidedGate(yes)).toBe('confirmation');
      expect(intentOutcome(yes)).toBe('summary_confirmed:report_missing');
      expect(yes.rows.find((x) => x.gate === 'intent')?.decided).toBe(false);

      const no = run(pending(), baseAnswers({ confirmsNo: noul(0.9) }));
      expect(decidedGate(no)).toBe('confirmation');
      expect(intentOutcome(no)).toBe('summary_rejected:report_missing');

      const unanswered = run(pending(), baseAnswers());
      expect(decidedGate(unanswered)).toBe('confirmation');
      expect(intentOutcome(unanswered)).toBe('summary_confirm_unanswered:report_missing');

      const change = run(pending(), baseAnswers({ changeSlot: choice({ expectedDate: 0.9, none: 0.1 }) }));
      expect(decidedGate(change)).toBe('changeSlot');
      expect(intentOutcome(change)).toBe('summary_change_slot:report_missing');
    });

    it('lets a replace, an agent request, or a replay win over the summary', () => {
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), wantsHuman: noul(0.95) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
      expect(run(pending(), baseAnswers({
        intent: choice({ track_parcel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      })).verdict).toMatchObject({ kind: 'route', intent: 'track_parcel' });
    });

    it('still decides slot and intent confirmations at the confirm gate', () => {
      const s = setForm(newSession('s', 0, VOICE_RELAY), 'track_parcel');
      s.pendingConfirmation = { target: 'slot', slot: 'parcelSelect', value: '7101', display: '7101' };
      const r = run(s, baseAnswers({ confirmsYes: noul(0.9) }));
      expect(r.verdict).toEqual({ kind: 'confirmed' });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(true);
    });
  });

  describe('second intent on the first utterance', () => {
    it('queues a second form intent on a plain route', () => {
      const v = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.95, none: 0.05 }), secondIntent: choice({ delivery_window: 0.8, none: 0.2 }) })).verdict;
      expect(v).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none', queue: 'delivery_window' });
    });

    it('ignores it below threshold, when it repeats the main intent, and on a tentative or explicit route', () => {
      expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.95, none: 0.05 }), secondIntent: choice({ delivery_window: 0.5, none: 0.5 }) })).verdict)
        .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
      expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ report_missing: 0.95, none: 0.05 }), secondIntent: choice({ report_missing: 0.9, none: 0.1 }) })).verdict)
        .toEqual({ kind: 'route', intent: 'report_missing', confirm: 'none' });
      const r = run(newSession('s', 0, VOICE_RELAY), baseAnswers({
        intent: choice({ report_missing: 0.95, none: 0.05 }), intentTentative: noul(0.9), secondIntent: choice({ delivery_window: 0.9, none: 0.1 }),
      }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
      // Named, but the route wasn't plain: logged as deliberately dropped, not silently lost.
      expect(r.rows.find((x) => x.gate === 'secondIntent')).toMatchObject({ outcome: 'ignored:not_plain_route' });
    });
  });

  it('answers an informational intent with its prompt, at the implicit band outside a form and the switch band inside', () => {
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.65, none: 0.35 }) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.35, none: 0.65 }) })).verdict).toEqual({ kind: 'intent_failed' });
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    const answering = choice({ answering: 0.9, adding: 0.05, replacing: 0.05 });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.7, none: 0.3 }), intentChange: answering })).verdict).toEqual({ kind: 'proceed' });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering })).rows.find((g) => g.gate === 'intent')).toMatchObject({ outcome: 'inform:capabilities', decided: true });
  });

  it('confirms an informational intent below the implicit band outside a form, as it confirms a form', () => {
    // The band a form gets ("Just to check, do you want to ...?"): from INTENT_EXPLICIT up to INTENT_IMPLICIT.
    const unsure = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.58, other: 0.22, none: 0.2 }) }));
    expect(unsure.verdict).toEqual({ kind: 'route', intent: 'capabilities', confirm: 'explicit' });
    expect(unsure.rows.find((g) => g.gate === 'intent')).toMatchObject({ outcome: 'inform_explicit:capabilities', decided: true, threshold: T.INTENT_EXPLICIT });
    expect(run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.4, none: 0.35, other: 0.25 }) })).verdict).toEqual({ kind: 'route', intent: 'capabilities', confirm: 'explicit' });
    // A form close behind it is asked about as two forms are: which of the two.
    const close = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.5, track_parcel: 0.4, none: 0.1 }) }));
    expect(close.verdict).toEqual({ kind: 'disambiguate_intent', a: 'capabilities', b: 'track_parcel' });
    // Inside a form nothing changes: an informational intent still needs the switch band.
    const s = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.5, none: 0.5 }), intentChange: choice({ answering: 0.9, adding: 0.05, replacing: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
  });

  it('lets an informational intent win over a pending summary and an unanswered confirmation, and carries a rung', () => {
    const summary = setForm(newSession('s', 0, VOICE_RELAY), 'report_missing');
    summary.pendingConfirmation = { target: 'form', form: 'report_missing', attempts: 0 };
    summary.promptedFor = 'confirm';
    const answering = choice({ answering: 0.9, adding: 0.05, replacing: 0.05 });
    expect(run(summary, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering, confirmsYes: noul(0.1), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    const explicit = newSession('s', 0, VOICE_RELAY);
    explicit.pendingConfirmation = { target: 'intent', intent: 'track_parcel', answers: {}, text: 'maybe track a parcel' };
    explicit.promptedFor = 'intent';
    expect(run(explicit, baseAnswers({ intent: choice({ capabilities: 0.8, none: 0.2 }), confirmsYes: noul(0.1), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    const angry = run(newSession('s', 0, VOICE_RELAY), baseAnswers({ intent: choice({ capabilities: 0.8, none: 0.2 }), frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }) }));
    expect(angry.verdict).toEqual({ kind: 'inform', promptId: 'capabilities', frustration: 'ack' });
  });
});

/**
 * Whether an intent the model is unsure of is confirmed (App.unsureIntent, IntentDef.unsure): by
 * default it is, for a form intent and an informational one alike; an app may turn that off for
 * every intent or for one, and an intent may turn it back on.
 */
describe('evaluateGates: an unsure intent', () => {
  const withUnsure = (id: string, app: App['unsureIntent'], intents: Record<string, IntentDef['unsure']> = {}): string => {
    const own = Object.fromEntries(Object.entries(intents).map(([intent, unsure]) => [intent, { ...testkitApp.intents[intent]!, unsure }]));
    registerApp({ ...testkitApp, id, ...(app !== undefined ? { unsureIntent: app } : {}), intents: { ...testkitApp.intents, ...own } });
    return id;
  };
  const OFF = withUnsure('testkit-unsure-off', 'no-match');
  const OFF_BUT = withUnsure('testkit-unsure-off-but', 'no-match', { report_missing: 'confirm', capabilities: 'confirm' });
  const ON_BUT = withUnsure('testkit-unsure-on-but', undefined, { report_missing: 'no-match', capabilities: 'no-match' });
  const EXPLICIT_ON = withUnsure('testkit-unsure-on', 'confirm');

  const at = (app?: string): Session => newSession('s', 0, VOICE_RELAY, undefined, app);
  const FORM = choice({ report_missing: 0.5, none: 0.3, other: 0.2 });
  const OTHER_FORM = choice({ track_parcel: 0.5, none: 0.3, other: 0.2 });
  const INFO = choice({ capabilities: 0.55, other: 0.25, none: 0.2 });
  const outcomeOf = (r: ReturnType<typeof run>) => r.rows.find((g) => g.gate === 'intent')?.outcome;

  it('is confirmed by default and when the app says confirm, a form intent and an informational one alike', () => {
    for (const app of [undefined, EXPLICIT_ON]) {
      expect(run(at(app), baseAnswers({ intent: FORM })).verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
      expect(run(at(app), baseAnswers({ intent: INFO })).verdict).toEqual({ kind: 'route', intent: 'capabilities', confirm: 'explicit' });
    }
  });

  it('is no match when the app says no-match: for a form intent and an informational one, with its own row outcome', () => {
    const form = run(at(OFF), baseAnswers({ intent: FORM }));
    expect(form.verdict).toEqual({ kind: 'intent_failed' });
    expect(outcomeOf(form)).toBe('unsure_no_match:report_missing');
    const info = run(at(OFF), baseAnswers({ intent: INFO }));
    expect(info.verdict).toEqual({ kind: 'intent_failed' });
    expect(outcomeOf(info)).toBe('unsure_no_match:capabilities');
  });

  it('changes nothing above the band, below it, for a hedged request, or inside a form', () => {
    expect(run(at(OFF), baseAnswers({ intent: choice({ report_missing: 0.65, none: 0.35 }) })).verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'implicit' });
    expect(run(at(OFF), baseAnswers({ intent: choice({ capabilities: 0.65, none: 0.35 }) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(run(at(OFF), baseAnswers({ intent: choice({ report_missing: 0.35, none: 0.65 }) })).verdict).toEqual({ kind: 'intent_failed' });
    // A hedge is the caller's, not the model's doubt: still confirmed.
    expect(run(at(OFF), baseAnswers({ intent: choice({ report_missing: 0.9, none: 0.1 }), intentTentative: noul(0.9) })).verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
    // A switch away from the form in hand is confirmed in its band whatever the app says.
    const s = setForm(at(OFF), 'report_missing');
    expect(run(s, baseAnswers({ intent: choice({ track_parcel: 0.7, none: 0.3 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) })).verdict).toEqual({ kind: 'route', intent: 'track_parcel', confirm: 'explicit' });
  });

  it('follows the intent\'s own setting over the app\'s, in each direction', () => {
    // The app says no-match; the two intents say confirm; another form still fails.
    expect(run(at(OFF_BUT), baseAnswers({ intent: FORM })).verdict).toEqual({ kind: 'route', intent: 'report_missing', confirm: 'explicit' });
    expect(run(at(OFF_BUT), baseAnswers({ intent: INFO })).verdict).toEqual({ kind: 'route', intent: 'capabilities', confirm: 'explicit' });
    expect(run(at(OFF_BUT), baseAnswers({ intent: OTHER_FORM })).verdict).toEqual({ kind: 'intent_failed' });
    // The app confirms; the two intents say no-match; another form is still confirmed.
    expect(run(at(ON_BUT), baseAnswers({ intent: FORM })).verdict).toEqual({ kind: 'intent_failed' });
    expect(run(at(ON_BUT), baseAnswers({ intent: INFO })).verdict).toEqual({ kind: 'intent_failed' });
    expect(run(at(ON_BUT), baseAnswers({ intent: OTHER_FORM })).verdict).toEqual({ kind: 'route', intent: 'track_parcel', confirm: 'explicit' });
  });
});

describe('evaluateGates: a priority intent (IntentDef.priority)', () => {
  /** The testkit with `report_missing` marked priority, and whatever else `over` changes. */
  const withPriority = (id: string, intents: Record<string, IntentDef['priority']>, over: Partial<App> = {}): string => {
    const own = Object.fromEntries(Object.entries(intents).map(([intent, priority]) => [intent, { ...testkitApp.intents[intent]!, priority }]));
    registerApp({ ...testkitApp, id, ...over, intents: { ...testkitApp.intents, ...own } });
    return id;
  };
  const PRIORITY = withPriority('testkit-priority', { report_missing: true });
  const INFO_PRIORITY = withPriority('testkit-priority-info', { capabilities: true });
  const NAMED = withPriority('testkit-priority-named', { report_missing: { threshold: 'MISSING_SURE' } }, { thresholds: { MISSING_SURE: 0.6 } });

  const at = (app?: string): Session => newSession('s', 0, VOICE_RELAY, undefined, app);
  const inForm = (app?: string, form = 'track_parcel'): Session => setForm(at(app), form);
  /** The trial's reading: the priority intent at 0.91, and intentChange reading the turn as an answer at 0.77. */
  const SWITCH = { intent: choice({ report_missing: 0.91, none: 0.08, track_parcel: 0.01 }), intentChange: choice({ answering: 0.77, replacing: 0.19, adding: 0.04 }) };
  const row = (r: ReturnType<typeof run>, gate: string) => r.rows.find((g) => g.gate === gate);
  const decided = (r: ReturnType<typeof run>) => r.rows.filter((g) => g.decided).map((g) => g.gate);
  const ACTS = { kind: 'route', intent: 'report_missing', confirm: 'none' };

  it('defaults PRIORITY_INTENT to 0.8', () => {
    expect(DEFAULT_THRESHOLDS.PRIORITY_INTENT).toBe(0.8);
  });

  it('acts mid-form on a priority reading the intentChange question reads as an answer', () => {
    const r = run(inForm(PRIORITY), baseAnswers(SWITCH));
    expect(r.verdict).toEqual(ACTS);
    expect(decided(r)).toEqual(['priorityIntent']);
    expect(row(r, 'priorityIntent')).toMatchObject({ value: 0.91, threshold: 0.8, passed: true, outcome: 'act:report_missing:over:intent' });
    // The rows it overrode still say what they made of the turn.
    expect(row(r, 'intentChange')).toMatchObject({ outcome: 'answering' });
    expect(row(r, 'intent')).toMatchObject({ outcome: 'answering:report_missing', decided: false });
  });

  it('leaves a reading below the threshold to the gates as before', () => {
    const below = { ...SWITCH, intent: choice({ report_missing: 0.75, none: 0.25 }) };
    const r = run(inForm(PRIORITY), baseAnswers(below));
    expect(r.verdict).toEqual({ kind: 'proceed' });
    expect(row(r, 'priorityIntent')).toMatchObject({ value: 0.75, threshold: 0.8, passed: false, outcome: 'below', decided: false });
    // The same turn in the app without priority intents, row for row.
    const plain = run(inForm(), baseAnswers(below));
    expect(r.rows.filter((g) => g.gate !== 'priorityIntent')).toEqual(plain.rows);
  });

  it('changes nothing for an app without priority intents: no row, the same verdict', () => {
    const r = run(inForm(), baseAnswers(SWITCH));
    expect(r.verdict).toEqual({ kind: 'proceed' });
    expect(row(r, 'priorityIntent')).toBeUndefined();
    const side = run(inForm(), baseAnswers({ ...SWITCH, addressedToSystem: noul(0.52) }));
    expect(side.verdict).toEqual({ kind: 'ignore' });
    expect(row(side, 'priorityIntent')).toBeUndefined();
  });

  it('is not ignored as side speech when the reading is strong, and is when it is not', () => {
    // The trial's half-aside reading: addressed 0.52, complete 0.65, the intent 0.83, and intentChange answering 0.96.
    const aside = { addressedToSystem: noul(0.52), utteranceComplete: noul(0.65), intent: choice({ report_missing: 0.83, none: 0.17 }), intentChange: choice({ answering: 0.96, replacing: 0.02, adding: 0.02 }) };
    const r = run(inForm(PRIORITY, 'delivery_window'), baseAnswers(aside));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'addressedToSystem')).toMatchObject({ passed: false, outcome: 'ignore', decided: false });
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:report_missing:over:addressedToSystem', decided: true });
    const weak = run(inForm(PRIORITY, 'delivery_window'), baseAnswers({ ...SWITCH, addressedToSystem: noul(0.52), intent: choice({ report_missing: 0.5, none: 0.5 }) }));
    expect(weak.verdict).toEqual({ kind: 'ignore' });
    expect(decided(weak)).toEqual(['addressedToSystem']);
    expect(row(weak, 'priorityIntent')).toMatchObject({ outcome: 'below', decided: false });
  });

  it('is not re-asked when the words read as unintelligible', () => {
    const r = run(at(PRIORITY), baseAnswers({ intelligible: noul(0.3), intent: choice({ report_missing: 0.85, none: 0.15 }) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:report_missing:over:intelligible' });
  });

  it('routes as normal at the opener, where the intent row still decides', () => {
    const r = run(at(PRIORITY), baseAnswers({ intent: choice({ report_missing: 0.9, none: 0.1 }) }));
    expect(r.verdict).toEqual(ACTS);
    expect(decided(r)).toEqual(['intent']);
    expect(row(r, 'priorityIntent')).toMatchObject({ passed: true, outcome: 'agrees', decided: false });
  });

  it('is not confirmed for a hedge: a priority request is acted on', () => {
    const r = run(at(PRIORITY), baseAnswers({ intent: choice({ report_missing: 0.9, none: 0.1 }), intentTentative: noul(0.9) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:report_missing:over:intent', decided: true });
  });

  it('acts at a summary confirmation, whatever the yes or no', () => {
    const s = inForm(PRIORITY);
    s.pendingConfirmation = { target: 'form', form: 'track_parcel', attempts: 0 };
    s.promptedFor = 'confirm';
    const r = run(s, baseAnswers({ ...SWITCH, confirmsYes: noul(0.8), confirmsNo: noul(0.05) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:report_missing:over:confirmation', decided: true });
  });

  it('acts at the transfer offer and at an intent confirmation, where the confirmation gate would decide first', () => {
    const offer = inForm(PRIORITY);
    offer.pendingConfirmation = { target: 'transfer', attempts: 0 };
    offer.promptedFor = 'confirm';
    const r = run(offer, baseAnswers({ ...SWITCH, confirmsYes: noul(0.1), confirmsNo: noul(0.1) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'confirmation')).toMatchObject({ outcome: 'rejected', decided: false });
    const asked = at(PRIORITY);
    asked.pendingConfirmation = { target: 'intent', intent: 'track_parcel', answers: {}, text: 'x' };
    asked.promptedFor = 'confirm';
    expect(run(asked, baseAnswers({ confirmsYes: noul(0.05), confirmsNo: noul(0.9), intent: choice({ report_missing: 0.9, none: 0.1 }) })).verdict).toEqual(ACTS);
  });

  it('takes the turn from a spoken menu number', () => {
    const s = at(PRIORITY);
    s.menuActive = true;
    const r = run(s, baseAnswers({ menuNumberSaid: choice({ '1': 0.9, none: 0.1 }), intent: choice({ report_missing: 0.85, none: 0.15 }) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:report_missing:over:menuNumber' });
  });

  it('leaves a handoff to a person and a held partial to stand', () => {
    const human = run(inForm(PRIORITY), baseAnswers({ ...SWITCH, wantsHuman: noul(0.9) }));
    expect(human.verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(decided(human)).toEqual(['wantsHuman']);
    expect(row(human, 'priorityIntent')).toMatchObject({ passed: true, outcome: 'stands:wantsHuman', decided: false });
    const held = run(inForm(PRIORITY), baseAnswers({ ...SWITCH, utteranceComplete: noul(0.2) }), false);
    expect(held.verdict).toEqual({ kind: 'hold' });
    expect(row(held, 'priorityIntent')).toMatchObject({ outcome: 'stands:utteranceComplete' });
  });

  it('does nothing inside its own form', () => {
    const r = run(inForm(PRIORITY, 'report_missing'), baseAnswers(SWITCH));
    expect(r.verdict).toEqual({ kind: 'proceed' });
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'in_form', decided: false });
  });

  it('says an informational priority intent mid-form under INTENT_SWITCH', () => {
    const r = run(inForm(INFO_PRIORITY), baseAnswers({ intent: choice({ capabilities: 0.82, none: 0.18 }), intentChange: choice({ answering: 0.9, replacing: 0.05, adding: 0.05 }) }));
    expect(r.verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(row(r, 'priorityIntent')).toMatchObject({ outcome: 'act:capabilities:over:intent' });
  });

  it('reads the threshold the intent names, an app threshold', () => {
    const r = run(inForm(NAMED), baseAnswers({ ...SWITCH, intent: choice({ report_missing: 0.65, none: 0.35 }) }));
    expect(r.verdict).toEqual(ACTS);
    expect(row(r, 'priorityIntent')).toMatchObject({ value: 0.65, threshold: 0.6 });
  });

  it('reads PRIORITY_INTENT as the run sets it', () => {
    const ts = buildTurnState(inForm(PRIORITY), { text: 'x', isFinal: true, dtmf: null }, 0);
    const r = evaluateGates(inForm(PRIORITY), ts, baseAnswers(SWITCH), { ...T, PRIORITY_INTENT: 0.95 });
    expect(r.verdict).toEqual({ kind: 'proceed' });
  });
});

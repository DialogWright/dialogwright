import { describe, expect, it } from 'vitest';
import { isChoice, noulValue, type AnswerMap, type ChoiceQuestion } from '../jev/types';
import { spokenToDigits } from '../core/extract/spokenNumber';
import type { SlotOutcome, SlotSpec } from '../core/slots/types';
import { choice, noul } from './answers';
import { testSlotContext } from './slots';
import { testkitApp } from './testkit';
import {
  createShadowReport, shadowFromEnv, shadowModeOf, shadowSlot, ShadowMismatchError, withShadowSlots,
} from './shadowSlot';

/**
 * A small slot that uses every part of the contract: a detected span, a partial (two digits heard,
 * two owed) with its prompt variables, a keypad and a display.
 */
const legacy: SlotSpec = {
  id: 'parcelCode',
  spokenConfirm: 'by-confidence',
  redact: 'last4',
  detect: true,
  partialPromptId: 'ask_parcelCode_rest',
  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a parcel code';
    return {
      parcelCodeGiven: { type: 'noul', instructions: 'Read asr.text. Does the caller say a parcel code?' },
      parcelCodeSpan: { type: 'choice', instructions: 'Read asr.text. Which span is the parcel code?', criteria },
    };
  },
  fill(answers: AnswerMap, ctx): SlotOutcome {
    if (noulValue(answers, 'parcelCodeGiven') < ctx.thresholds.SLOT_DETECT) return { kind: 'absent' };
    const span = answers.parcelCodeSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'absent' };
    const digits = (ctx.window ? String(ctx.window.head) : '') + spokenToDigits(span.choice);
    if (digits.length === 2) return { kind: 'window', window: { kind: 'code', head: digits }, confidence: span.confidence };
    if (digits.length !== 4) return { kind: 'invalid', reason: 'length', raw: digits };
    return { kind: 'filled', value: digits, display: digits.split('').join(' '), confidence: span.confidence, confirm: 'implicit' };
  },
  dtmf: {
    length: 4,
    parse: (digits) => (/^\d{4}$/.test(digits) ? { value: digits, display: digits.split('').join(' ') } : null),
  },
  display: (value) => value.split('').join(' '),
  partialVars: (window) => ({ head: String(window.head) }),
};

/** A candidate equal in behavior but built apart: fresh functions, same results. */
function rebuilt(over: Partial<SlotSpec> = {}): SlotSpec {
  return {
    ...legacy,
    questions: (ctx) => legacy.questions(ctx),
    fill: (answers, ctx) => legacy.fill(answers, ctx),
    dtmf: { length: 4, parse: (digits, ctx) => legacy.dtmf!.parse(digits, ctx) },
    display: (value) => legacy.display(value),
    partialVars: (window) => legacy.partialVars!(window),
    ...over,
  };
}

const said = (text: string, over = {}) => testSlotContext(text, over);
const CODE_GIVEN: AnswerMap = { parcelCodeGiven: noul(0.95), parcelCodeSpan: choice({ '4 7 1 2': 0.9, none: 0.1 }) };
const HALF_GIVEN: AnswerMap = { parcelCodeGiven: noul(0.95), parcelCodeSpan: choice({ 'four seven': 0.9, none: 0.1 }) };

/** Runs `run` and returns the ShadowMismatchError it throws. */
function mismatchOf(run: () => unknown): ShadowMismatchError {
  try {
    run();
  } catch (e) {
    if (e instanceof ShadowMismatchError) return e;
    throw e;
  }
  throw new Error('expected a shadow mismatch, got none');
}

describe('shadowSlot', () => {
  it('passes an equal pair through, returning the legacy results and declaring what the legacy spec declares', () => {
    const report = createShadowReport();
    const spec = shadowSlot(legacy, rebuilt(), { report });
    const ctx = said('my code is 4 7 1 2');
    expect(spec.questions(ctx)).toEqual(legacy.questions(ctx));
    expect(spec.fill(CODE_GIVEN, ctx)).toEqual(legacy.fill(CODE_GIVEN, ctx));
    expect(spec.fill(HALF_GIVEN, said('four seven'))).toEqual({ kind: 'window', window: { kind: 'code', head: '47' }, confidence: 0.9 });
    expect(spec.dtmf!.length).toBe(4);
    expect(spec.dtmf!.parse('4712', ctx)).toEqual({ value: '4712', display: '4 7 1 2' });
    expect(spec.dtmf!.parse('47', ctx)).toBeNull();
    expect(spec.display('4712')).toBe('4 7 1 2');
    expect(spec.partialVars!({ kind: 'code', head: '47' })).toEqual({ head: '47' });
    const { questions: _q, fill: _f, dtmf: _d, display: _s, partialVars: _p, ...declared } = spec;
    const { questions: _lq, fill: _lf, dtmf: _ld, display: _ls, partialVars: _lp, ...legacyDeclared } = legacy;
    expect(declared).toEqual(legacyDeclared);
    expect(report.mismatches).toEqual([]);
    // A fill is followed: the filled value's display and the window's prompt variables are compared too.
    expect(report.calls).toEqual({
      'parcelCode.static': 1, 'parcelCode.questions': 1, 'parcelCode.fill': 2, 'parcelCode.dtmf.parse': 2,
      'parcelCode.display': 3, 'parcelCode.partialVars': 2,
    });
  });

  it('gives a spec with no keypad and no partial variables none of its own', () => {
    const { dtmf: _d, partialVars: _p, ...plain } = legacy;
    const spec = shadowSlot(plain as SlotSpec, { ...plain } as SlotSpec);
    expect(spec.dtmf).toBeUndefined();
    expect(spec.partialVars).toBeUndefined();
    expect(Object.hasOwn(spec, 'handoff')).toBe(false);
  });

  it('throws on a question criterion that differs, naming the slot, the method and the path', () => {
    const candidate = rebuilt({
      questions: (ctx) => {
        const q = legacy.questions(ctx);
        const span = q.parcelCodeSpan as ChoiceQuestion;
        return { ...q, parcelCodeSpan: { ...span, criteria: { ...span.criteria, none: 'No parcel code' } } };
      },
    });
    const e = mismatchOf(() => shadowSlot(legacy, candidate).questions(said('my code is 4 7 1 2')));
    expect(e.mismatch.slot).toBe('parcelCode');
    expect(e.mismatch.method).toBe('questions');
    expect(e.message).toContain('shadow slot "parcelCode": questions differs');
    expect(e.message).toContain('inputs: text "my code is 4 7 1 2"');
    expect(e.message).toContain('at .parcelCodeSpan.criteria.none: legacy "No span of asr.text is a parcel code", candidate "No parcel code"');
  });

  it('ignores the order of question ids and criteria keys, as the cassette key does', () => {
    const candidate = rebuilt({
      questions: (ctx) => {
        const q = legacy.questions(ctx);
        return { parcelCodeSpan: q.parcelCodeSpan!, parcelCodeGiven: q.parcelCodeGiven! };
      },
    });
    expect(() => shadowSlot(legacy, candidate).questions(said('4 7 1 2'))).not.toThrow();
  });

  it('throws on a fill outcome that differs, with the answers it was given', () => {
    const candidate = rebuilt({ fill: (answers, ctx) => {
      const o = legacy.fill(answers, ctx);
      return o.kind === 'filled' ? { ...o, confirm: 'none' } : o;
    } });
    const e = mismatchOf(() => shadowSlot(legacy, candidate).fill(CODE_GIVEN, said('my code is 4 7 1 2', { prompted: true })));
    expect(e.mismatch.method).toBe('fill');
    expect(e.message).toContain('shadow slot "parcelCode": fill differs');
    expect(e.message).toContain('inputs: text "my code is 4 7 1 2" · prompted · answers {"parcelCodeGiven"');
    expect(e.message).toContain('at .confirm: legacy "implicit", candidate "none"');
  });

  it('treats a field set to undefined as differing from one that is absent', () => {
    const candidate = rebuilt({ fill: () => ({ kind: 'invalid', reason: 'length', raw: '471', retryPromptId: undefined }) });
    const e = mismatchOf(() => shadowSlot(legacy, candidate).fill({ parcelCodeGiven: noul(0.95), parcelCodeSpan: choice({ '4 7 1': 0.9 }) }, said('4 7 1')));
    expect(e.message).toContain('at .retryPromptId: legacy has no retryPromptId, candidate undefined');
  });

  it('throws on a keypad parse that differs, and on a keypad of another length when made', () => {
    const candidate = rebuilt({ dtmf: { length: 4, parse: (digits) => ({ value: digits, display: digits }) } });
    const e = mismatchOf(() => shadowSlot(legacy, candidate).dtmf!.parse('4712', said('')));
    expect(e.mismatch.method).toBe('dtmf.parse');
    expect(e.message).toContain('shadow slot "parcelCode": dtmf.parse differs');
    expect(e.message).toContain('inputs: digits "4712"');
    expect(e.message).toContain('at .display: legacy "4 7 1 2", candidate "4712"');
    const longer = mismatchOf(() => shadowSlot(legacy, rebuilt({ dtmf: { length: 5, parse: legacy.dtmf!.parse } })));
    expect(longer.mismatch.method).toBe('static');
    expect(longer.message).toContain('at .dtmf.length: legacy 4, candidate 5');
  });

  it('throws on a declared field that differs, when the shadow is made', () => {
    const e = mismatchOf(() => shadowSlot(legacy, rebuilt({ redact: 'mask' })));
    expect(e.mismatch.method).toBe('static');
    expect(e.message).toContain('shadow slot "parcelCode": static differs');
    expect(e.message).toContain('at .redact: legacy "last4", candidate "mask"');
    for (const [field, value] of [['spokenConfirm', 'summary'], ['handoff', 'last4'], ['detect', false], ['valueKind', 'date'], ['partialPromptId', 'ask_other']] as const) {
      const m = mismatchOf(() => shadowSlot(legacy, rebuilt({ [field]: value } as Partial<SlotSpec>)));
      expect(m.message, field).toContain(`at .${field}:`);
    }
    const { partialVars: _p, ...noVars } = rebuilt();
    expect(mismatchOf(() => shadowSlot(legacy, noVars as SlotSpec)).message).toContain('at .partialVars: legacy true, candidate false');
  });

  it('throws on partial variables that differ, whether a fill returns the window or the engine asks', () => {
    const candidate = rebuilt({ partialVars: (w) => ({ head: `${String(w.head)} and` }) });
    const viaFill = mismatchOf(() => shadowSlot(legacy, candidate).fill(HALF_GIVEN, said('four seven')));
    expect(viaFill.mismatch.method).toBe('partialVars');
    expect(viaFill.message).toContain('shadow slot "parcelCode": partialVars differs');
    expect(viaFill.message).toContain('inputs: window {"kind":"code","head":"47"}');
    expect(viaFill.message).toContain('at .head: legacy "47", candidate "47 and"');
    const asked = mismatchOf(() => shadowSlot(legacy, candidate).partialVars!({ kind: 'code', head: '12' }));
    expect(asked.mismatch.method).toBe('partialVars');
  });

  it('throws on a display that differs, for a filled value and when asked', () => {
    const candidate = rebuilt({ display: (v) => v });
    const viaFill = mismatchOf(() => shadowSlot(legacy, candidate).fill(CODE_GIVEN, said('my code is 4 7 1 2')));
    expect(viaFill.mismatch.method).toBe('display');
    expect(viaFill.message).toContain('shadow slot "parcelCode": display differs');
    expect(viaFill.message).toContain('inputs: value "4712"');
    expect(viaFill.message).toContain('at (the whole value): legacy "4 7 1 2", candidate "4712"');
    expect(mismatchOf(() => shadowSlot(legacy, candidate).display('1234')).mismatch.method).toBe('display');
  });

  it('compares display and partialVars in the context\'s locale, and names it in the inputs', () => {
    const candidate = rebuilt({
      display: (v, locale) => (locale === 'es' ? `${v} (es)` : legacy.display(v)),
      partialVars: (w, locale) => (locale === 'es' ? { head: 'es' } : legacy.partialVars!(w)),
    });
    // Without a locale (an app without locales) the two agree.
    const plain = createShadowReport();
    shadowSlot(legacy, candidate, { report: plain }).fill(CODE_GIVEN, said('my code is 4 7 1 2'));
    expect(plain.mismatches).toEqual([]);
    const viaFill = mismatchOf(() => shadowSlot(legacy, candidate).fill(CODE_GIVEN, said('mi código es 4 7 1 2', { locale: 'es' })));
    expect(viaFill.mismatch.method).toBe('display');
    expect(viaFill.message).toContain('inputs: value "4712" · locale es');
    expect(mismatchOf(() => shadowSlot(legacy, candidate).fill(HALF_GIVEN, said('cuatro siete', { locale: 'es' }))).mismatch.method).toBe('partialVars');
    expect(mismatchOf(() => shadowSlot(legacy, candidate).partialVars!({ kind: 'code', head: '47' }, 'es')).message).toContain('inputs: window {"kind":"code","head":"47"} · locale es');
    expect(mismatchOf(() => shadowSlot(legacy, candidate).display('4712', 'es')).message).toContain('legacy "4 7 1 2", candidate "4712 (es)"');
  });

  it('carries the legacy spec\'s declared question ids and lines, and does not compare the candidate\'s', () => {
    const declared = { ...legacy, questionIds: ['parcelCodeGiven', 'parcelCodeSpan'], prompts: [{ id: 'ask_parcelCode_rest', why: 'two digits heard', vars: ['head'] }] };
    const spec = shadowSlot(declared, rebuilt());
    expect(spec.questionIds).toEqual(declared.questionIds);
    expect(spec.prompts).toEqual(declared.prompts);
    expect(shadowSlot(legacy, { ...rebuilt(), questionIds: ['parcelCodeGiven', 'parcelCodeSpan'] }).questionIds).toBeUndefined();
  });

  it('compares a method that throws by its message, and rethrows the legacy error', () => {
    const boom = (): never => { throw new Error('boom'); };
    const both = shadowSlot({ ...legacy, display: boom }, { ...rebuilt(), display: boom });
    expect(() => both.display('1')).toThrow('boom');
    const e = mismatchOf(() => shadowSlot(legacy, rebuilt({ fill: boom })).fill(CODE_GIVEN, said('4 7 1 2')));
    expect(e.message).toContain('candidate: {"threw":"boom"}');
  });

  it('in report mode collects every difference, returns the legacy result and carries on', () => {
    const report = createShadowReport();
    const candidate = rebuilt({ redact: 'mask', display: (v) => v });
    const spec = shadowSlot(legacy, candidate, { mode: 'report', report });
    expect(spec.redact).toBe('last4');
    expect(spec.fill(CODE_GIVEN, said('my code is 4 7 1 2'))).toEqual(legacy.fill(CODE_GIVEN, said('my code is 4 7 1 2')));
    expect(spec.display('4712')).toBe('4 7 1 2');
    expect(report.mismatches.map((m) => m.method)).toEqual(['static', 'display', 'display']);
    expect(() => shadowSlot(legacy, candidate, { mode: 'report' })).toThrow('report mode needs a report');
  });
});

describe('withShadowSlots and the environment flag', () => {
  const accountId = testkitApp.slots.accountId!;
  const copy: SlotSpec = { ...accountId };

  it('returns the app itself with no candidates', () => {
    expect(withShadowSlots(testkitApp, [])).toBe(testkitApp);
  });

  it('shadows the named slots in the app\'s own slot order, and leaves the rest as they are', () => {
    const app = withShadowSlots(testkitApp, [copy]);
    expect(Object.keys(app.slots)).toEqual(Object.keys(testkitApp.slots));
    expect(app.slots.accountId).not.toBe(accountId);
    for (const id of Object.keys(testkitApp.slots).filter((id) => id !== 'accountId')) expect(app.slots[id]).toBe(testkitApp.slots[id]);
    const { slots: _a, ...rest } = app;
    const { slots: _b, ...restBefore } = testkitApp;
    expect(rest).toEqual(restBefore);
  });

  it('refuses a candidate for a slot the app does not have, or two for one slot', () => {
    expect(() => withShadowSlots(testkitApp, [{ ...copy, id: 'nope' }])).toThrow('shadow: app "testkit" has no slot "nope" to shadow');
    expect(() => withShadowSlots(testkitApp, [copy, copy])).toThrow('shadow: slot "accountId" is shadowed twice');
  });

  it('reads DIALOGWRIGHT_SHADOW: off unless set, 1 or throw, or report', () => {
    expect(shadowModeOf({})).toBeNull();
    expect(shadowModeOf({ DIALOGWRIGHT_SHADOW: '' })).toBeNull();
    expect(shadowModeOf({ DIALOGWRIGHT_SHADOW: '0' })).toBeNull();
    expect(shadowModeOf({ DIALOGWRIGHT_SHADOW: '1' })).toBe('throw');
    expect(shadowModeOf({ DIALOGWRIGHT_SHADOW: 'throw' })).toBe('throw');
    expect(shadowModeOf({ DIALOGWRIGHT_SHADOW: 'report' })).toBe('report');
    expect(() => shadowModeOf({ DIALOGWRIGHT_SHADOW: 'yes' })).toThrow('DIALOGWRIGHT_SHADOW must be 1, throw or report (got "yes")');
  });

  it('leaves the app untouched with the flag off, whatever the candidates', () => {
    expect(shadowFromEnv(testkitApp, [copy], {})).toBe(testkitApp);
  });
});

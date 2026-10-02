import type { SlotContext, SlotPartial, SlotSpec } from '../slots/types';
import { candidateSpans, candidateWordSpans } from '../spans';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../thresholds';
import type { SlotId } from './types';

/**
 * The question ids a slot asks, found by trying its questions() on a few made-up turns when the app
 * is defined, so a hand-written slot that asks an id the engine asks, or another slot's, is refused
 * then rather than on the turn that asks both (core/questions.ts buildQuestions still checks each
 * turn). A slot that declares its ids (SlotSpec.questionIds) is held to them here too. Only what
 * the tries show is known: a question asked only in a state they do not reach is still found on
 * its turn.
 */

/** The day every try is on. */
const PROBE_TODAY = '2026-09-18';

/** No words, and words with numbers, a name, a birth date and a day in them, so span questions have spans. */
const PROBE_TEXTS = ['', 'this is Morgan Ellis, my number is five five five zero one two three four, born June fourteenth nineteen seventy five, and next Tuesday works'];

/** A pending partial no slot makes: a slot that throws on it is skipped for that try. */
const PROBE_WINDOW: SlotPartial = { kind: 'probe', month: 6, day: 14 };

/** A value on file, for the tries that have one. */
const ON_FILE = '5550123';

/** The made-up turns: each text, asked or not, with and without a value on file and a pending partial, without a locale and in each of `locales`. */
export function probeContexts(locales: readonly string[] = [], thresholds: Readonly<Record<string, number>> = {}): SlotContext[] {
  const out: SlotContext[] = [];
  for (const locale of [undefined, ...locales]) {
    for (const text of PROBE_TEXTS) {
      for (const prompted of [false, true]) {
        for (const current of [null, ON_FILE]) {
          for (const window of [null, PROBE_WINDOW]) {
            const ctx: SlotContext = {
              text,
              candidateSpans: candidateSpans(text, locale),
              candidateWordSpans: candidateWordSpans(text, locale),
              todayIso: PROBE_TODAY,
              thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds } as Thresholds,
              window,
              current,
              records: [],
              prompted,
            };
            if (locale !== undefined) ctx.locale = locale;
            out.push(ctx);
          }
        }
      }
    }
  }
  return out;
}

/**
 * The ids each slot's questions() asks over `contexts`, by slot. A try that throws is skipped (a
 * slot may refuse a made-up partial or an empty turn); it never fails validation.
 */
export function askedQuestionIds(slots: Readonly<Record<SlotId, SlotSpec>>, contexts: readonly SlotContext[]): Record<SlotId, Set<string>> {
  const out: Record<SlotId, Set<string>> = {};
  for (const [slot, spec] of Object.entries(slots)) {
    const ids = new Set<string>();
    for (const ctx of contexts) {
      try {
        const qs = spec?.questions(ctx);
        if (qs && typeof qs === 'object') for (const id of Object.keys(qs)) ids.add(id);
      } catch {
        // a try a slot refuses tells nothing about its ids
      }
    }
    out[slot] = ids;
  }
  return out;
}

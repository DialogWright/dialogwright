import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import { meetsThreshold } from '../parts/thresholds';
import { nameCandidates, type NameIds } from './questions';

/** A bare answer (`bareAnswer`): the most words, and the threshold its name span must reach; `words` 0 takes none. */
export interface BareAnswer {
  words: number;
  span: string;
}

/** How many words the caller said: what spaces separate, each with a letter or a digit in it ("it's Jordan Avery" is three). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * A name slot's fill. Not stated (below SLOT_DETECT): absent, unless the answer is a bare name (below).
 * Stated but no span chosen, or the literal "none": invalid, "no_span". A span this turn's question
 * never offered (one built against other words, as a recording made before a word was excluded can
 * be): invalid, "no_span", with the span as raw. Otherwise filled with the span, its whitespace
 * collapsed, at the probability the model gave it; a name is never acknowledged or read back on its own.
 *
 * A bare name: right after the name question (`ctx.prompted`), an answer of at most `bare.words` words
 * whose chosen span was offered and has at least `bare.span` is taken as stated, whatever the
 * yes-or-no said. A caller who answers with only a name ("Jordan Avery") gives the yes-or-no little to
 * go on (0.41 on a live call, the span 0.74; the same words a turn later, 0.85); the span question, which
 * weighs them against the other spans, is the surer reading there. Never on a turn the slot was not
 * asked, nor on a longer answer, where a name said in passing may be someone else's.
 */
export function nameFill(
  ids: NameIds,
  excluded: ReadonlySet<string>,
  display: (value: string, locale?: string) => string,
  bare: BareAnswer,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  return (answers, ctx) => {
    const span = answers[ids.span];
    const chosen = isChoice(span) && typeof span.choice === 'string' && span.choice !== 'none' ? span.choice : null;
    const value = chosen === null ? null : chosen.trim().replace(/\s+/g, ' ');
    const offered = value !== null && nameCandidates(ctx, excluded).includes(value);
    const p = chosen !== null && isChoice(span) ? (span.probabilities?.[chosen] ?? span.confidence) : 0;
    const given = meetsThreshold(ctx.thresholds, 'SLOT_DETECT', noulValue(answers, ids.given))
      || (ctx.prompted && bare.words > 0 && offered && wordCount(ctx.text) <= bare.words && meetsThreshold(ctx.thresholds, bare.span, p));
    if (!given) return { kind: 'absent' };
    if (value === null) return { kind: 'invalid', reason: 'no_span', raw: '' };
    if (!offered) return { kind: 'invalid', reason: 'no_span', raw: value };
    return { kind: 'filled', value, display: display(value, ctx.locale), confidence: p, confirm: 'none' };
  };
}

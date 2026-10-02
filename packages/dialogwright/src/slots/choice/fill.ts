import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue, rankProbabilities, type Ranked } from '../../jev/types';
import type { SlotCandidate, SlotContext, SlotOutcome } from '../../core/slots/types';
import { meetsThreshold } from '../parts/thresholds';
import type { ChoiceOptions } from './options';
import type { ChoiceIds } from './questions';

/** A choice answer's probabilities by label, or none when the answer carries none (a malformed answer). */
const probabilitiesOf = (a: { probabilities?: unknown }): Record<string, number> =>
  typeof a.probabilities === 'object' && a.probabilities !== null ? (a.probabilities as Record<string, number>) : {};

/**
 * The first option other than `top` whose key the words name as a whole word, case aside, an
 * underscore in a key read as a space or a hyphen ("Cheng" never matches inside "Chen", nor "Chen"
 * inside "Cheng"). The one said first wins; two said at the same place, the one listed first.
 */
export function otherOptionNamed(o: Pick<ChoiceOptions, 'options'>, text: string, top: string): string | null {
  let first: { key: string; at: number } | null = null;
  for (const key of Object.keys(o.options)) {
    if (key === top) continue;
    const at = text.search(new RegExp(`\\b${key.split('_').join('[\\s-]+')}\\b`, 'i'));
    if (at >= 0 && (first === null || at < first.at)) first = { key, at };
  }
  return first?.key ?? null;
}

/**
 * The help question's outcome when no option was chosen: the line of the label the model ranks top,
 * when that label has one and its probability reaches `help.threshold`; otherwise absent.
 */
function helpOf(o: ChoiceOptions, ids: ChoiceIds, answers: AnswerMap, ctx: SlotContext): SlotOutcome {
  const s = o.help && ids.help ? answers[ids.help] : undefined;
  if (!o.help || !isChoice(s)) return { kind: 'absent' };
  const [top] = rankProbabilities(probabilitiesOf(s));
  const label = top && Object.hasOwn(o.help.labels, top.label) ? o.help.labels[top.label]! : undefined;
  if (!label?.prompt || !meetsThreshold(ctx.thresholds, o.help.threshold, top!.p)) return { kind: 'absent' };
  return { kind: 'help', promptId: label.prompt };
}

/**
 * A choice slot's fill. Without the advanced options: the option the model chose, when it is one of
 * the options and the model's probability for it reaches `fillAt`; "none", a label that is not an
 * option, a missing answer and a choice below the threshold are all `absent`, so the form asks again.
 *
 * The advanced options, in the order they are read:
 * - `disambiguate: margin`: the slot reads the model's probabilities for every label, not only its
 *   pick, and the top option must reach SLOT_CHOICE_CONFIRM.
 * - Nothing chosen (no answer, none, a label that is not an option, or below the threshold): with
 *   `help`, the help question's line (see helpOf), else absent.
 * - `hedge`: the caller is unsure when the hedge question's yes reaches `hedge.threshold`.
 * - `disambiguate`: a second option within SLOT_CHOICE_MARGIN of the top one, or, while the caller is
 *   unsure, one at SLOT_CHOICE_CONFIRM or above: ask which of the two.
 * - `hedge.byName`: while the caller is unsure, another option their words name: ask which of the two
 *   (the model may put nearly all its weight on one of two names the words both say).
 * - Below `fillAt`: nothing chosen.
 * - Filled with the option's key. With `confirm: by-confidence`, acknowledged when the caller is
 *   unsure, else as `readBack` says (implicit by default; below-fill: under SLOT_CHOICE_FILL only).
 */
export function choiceFill(
  o: ChoiceOptions,
  ids: ChoiceIds,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const isOption = (label: string): boolean => Object.hasOwn(o.options, label);
  const candidate = (key: string, locale: string | undefined): SlotCandidate => ({ value: key, display: display(key, locale) });
  return (answers, ctx) => {
    const t = ctx.thresholds;
    const miss = (): SlotOutcome => (o.help ? helpOf(o, ids, answers, ctx) : { kind: 'absent' });
    const a = answers[ids.choice];
    if (!isChoice(a)) return miss();
    let top: Ranked | undefined;
    let second: Ranked | undefined;
    if (o.disambiguate) {
      [top, second] = rankProbabilities(probabilitiesOf(a));
      if (!top || !isOption(top.label) || !meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', top.p)) return miss();
    } else {
      if (typeof a.choice !== 'string' || !isOption(a.choice)) return miss();
      top = { label: a.choice, p: a.probabilities?.[a.choice] ?? a.confidence };
    }
    const unsure = o.hedge !== undefined && ids.hedge !== undefined && meetsThreshold(t, o.hedge.threshold, noulValue(answers, ids.hedge));
    const rival = second && isOption(second.label) ? second : undefined;
    if (o.disambiguate && rival && (!meetsThreshold(t, 'SLOT_CHOICE_MARGIN', top.p - rival.p) || (unsure && meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', rival.p)))) {
      return { kind: 'disambiguate', a: candidate(top.label, ctx.locale), b: candidate(rival.label, ctx.locale) };
    }
    const other = unsure && o.hedge?.byName ? otherOptionNamed(o, ctx.text, top.label) : null;
    if (other !== null) return { kind: 'disambiguate', a: candidate(top.label, ctx.locale), b: candidate(other, ctx.locale) };
    if (!meetsThreshold(t, o.fillAt, top.p)) return miss();
    const readBack = o.readBack ?? 'implicit';
    const quiet = o.confirm === 'summary' || (!unsure && (readBack === 'none' || (readBack === 'below-fill' && meetsThreshold(t, 'SLOT_CHOICE_FILL', top.p))));
    return { kind: 'filled', value: top.label, display: display(top.label, ctx.locale), confidence: top.p, confirm: quiet ? 'none' : 'implicit' };
  };
}

import { examplesFrom } from '../parts/examples';
import { readBackOf, readBackPrompts } from '../parts/readBack';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { nameDisplay } from './display';
import { nameFill } from './fill';
import { BARE_ANSWER_GIVEN, BARE_ANSWER_SPAN, BARE_ANSWER_WORDS, nameOptions, type NameOptions } from './options';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { excludedWordsOf, idsOf, nameQuestions } from './questions';

export { nameOptions, NAME_PARTS, NAME_QUESTIONS, BARE_ANSWER_GIVEN, BARE_ANSWER_SPAN, BARE_ANSWER_WORDS } from './options';
export type { NameOptions } from './options';
export { nameDisplay } from './display';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/**
 * `name`: the caller's own name, as they say it. The model is asked whether the caller states their
 * own name and which of the offered spans of their words it is; the engine offers the word spans
 * itself, and `exclude` withholds any holding a word that is never the caller's name, so the value
 * is always words the caller said, and never someone else's name. See README.md beside this file.
 */
export const nameType: SlotType<NameOptions> = defineSlotType<NameOptions>({
  type: 'name',
  options: nameOptions,
  build(id, o) {
    const ids = idsOf(id, o);
    const display = nameDisplay();
    const bare = { words: o.bareAnswer?.words ?? BARE_ANSWER_WORDS, given: o.bareAnswer?.given ?? BARE_ANSWER_GIVEN, span: o.bareAnswer?.span ?? BARE_ANSWER_SPAN };
    // The thresholds a bare answer reads that are not the engine's, declared so a misspelt name is found when the app is defined.
    const own = bare.words > 0 ? [bare.given, bare.span].filter((t, i, all) => !Object.hasOwn(DEFAULT_THRESHOLDS, t) && all.indexOf(t) === i) : [];
    return {
      id,
      // Never acknowledged: the final summary reads it back, or, with `confirm: always`, its own read-back.
      ...readBackOf(o.confirm ?? 'summary'),
      ...(o.redact === 'mask' ? { redact: 'mask' as const } : {}),
      ...(o.handoff === 'verified' ? { handoff: 'verified' as const } : {}),
      detect: true,
      questionIds: [ids.given, ids.span],
      ...(own.length > 0 ? { thresholds: own } : {}),
      prompts: readBackPrompts(id, o.confirm ?? 'summary'),
      questions: nameQuestions(id, o),
      fill: nameFill(ids, excludedWordsOf(o), display, bare),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'The caller\'s own name, first and last as they say it: "Anna Petrov", "Sam".',
    notes: 'The model judges whether the caller states their own name and picks the span of their words that is it; the code offers only spans free of the excluded words (the names and titles of other people on the call), so the value is always words the caller said, and never another person\'s name. No keypad. Kept as said, said back title-cased.',
  },
});

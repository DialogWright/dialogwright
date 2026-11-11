import { CLAIM_QUESTIONS } from '../claims';
import { probabilityOf } from '../confirm';
import type { ClaimsVariant } from '../claimsEval';

/**
 * The check after speaking as it runs: its three questions, and the rules that read them as the runtime does
 * (a reply is read as wrong at the higher of `contradicted` and `notDone`; `gap` is its own). Built from
 * CLAIM_QUESTIONS and probabilityOf so it never drifts from the runtime. An example of a variant for
 * `dialogwright converse:claims-eval`: a module that exports a variant as its default.
 */
const variant: ClaimsVariant = {
  name: 'current',
  questions: CLAIM_QUESTIONS,
  rules: {
    contradictedOrNotDone: {
      target: 'wrong',
      score: (a) => {
        const c = probabilityOf(a.contradicted);
        const n = probabilityOf(a.notDone);
        return c === null || n === null ? null : Math.max(c, n);
      },
    },
    gap: { target: 'gap', score: (a) => probabilityOf(a.gap) },
  },
};

export default variant;

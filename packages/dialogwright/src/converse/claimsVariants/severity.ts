import type { Answer, AnswerMap, QuestionMap } from '../../jev/types';
import { probabilityOf } from '../confirm';
import { NARROW_QUESTIONS, narrowMax } from './narrow';

/**
 * The narrow questions with a score of how far the reply would mislead a caller who relied on it (an
 * experiment, measured with converse:claims-eval): the score separates a slip that changes what the caller
 * expects from one that changes nothing.
 */
const SEVERITY_QUESTIONS: QuestionMap = {
  ...NARROW_QUESTIONS,
  misled: {
    type: 'score',
    instructions: 'The line, an automated assistant answering for the business, has just said reply to a caller. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned (an action read back and waiting for the caller\'s yes is not done yet). If the caller relied on the reply, how far would it mislead them about what the business charges, when, what it will do, or what has already been done for them?',
    levels: [
      { label: 'Not at all', description: 'Everything the reply states agrees with the business information and the actions\' results, or it commits the business to nothing' },
      { label: 'Slightly', description: 'An inexactness that would change nothing the caller expects or does' },
      { label: 'Somewhat', description: 'The caller could be unsure or mistaken about a detail, but nothing they rely on' },
      { label: 'Seriously', description: 'The caller would expect a price, a time, a service or a next step the business does not give, or think something is done that is not' },
      { label: 'Completely', description: 'The reply is plainly false about the business or about what has been done for the caller' },
    ],
  },
};

/** The score as 0 (not at all) to 1 (completely); null when it is missing. Jev's expected level counts from 0 (the lowest level) to 4, whatever jev/types.ts says. */
function misled(a: AnswerMap): number | null {
  const s = a.misled as Answer | undefined;
  return s !== undefined && s.type === 'score' && Number.isFinite(s.score) ? Math.min(1, Math.max(0, s.score / 4)) : null;
}

const both = (f: (n: number, m: number) => number) => (a: AnswerMap): number | null => {
  const n = narrowMax(a);
  const m = misled(a);
  return n === null || m === null ? null : f(n, m);
};

export default {
  name: 'severity',
  questions: SEVERITY_QUESTIONS,
  rules: {
    narrowMax: { target: 'wrong' as const, score: narrowMax },
    misled: { target: 'wrong' as const, score: misled },
    /** The geometric mean: high only where a narrow question flags the reply and the score finds it misleading. */
    narrowAndMisled: { target: 'wrong' as const, score: both((n, m) => Math.sqrt(n * m)) },
    gap: { target: 'gap' as const, score: (a: AnswerMap) => probabilityOf(a.gap as Answer | undefined) },
  },
};

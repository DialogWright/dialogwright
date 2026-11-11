import type { Answer, AnswerMap, Question, QuestionMap } from '../../jev/types';
import { CLAIM_QUESTIONS } from '../claims';
import { probabilityOf } from '../confirm';

/**
 * The check after speaking with narrower questions (an experiment, measured with converse:claims-eval): one
 * question for each kind of claim a reply can get wrong, each saying what it is compared against, in place of
 * the two broad ones (contradicted, notDone). The gap question is the runtime's own.
 */
const CONTEXT = 'The line, an automated assistant answering for the business, has just said reply to a caller. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned (an action read back and waiting for the caller\'s yes is not done yet).';

export const NARROW_QUESTIONS: QuestionMap = {
  done: {
    type: 'noul',
    instructions: `${CONTEXT} Does the reply tell the caller that something is already booked, sent, requested, recorded, noted, passed on, held or confirmed, when no action's result on this call shows it done?`,
    criteria: {
      true: 'The reply says or implies something has already been done for the caller, and no action\'s result shows it done',
      false: 'Whatever the reply says was done, an action\'s result shows done; or it speaks only of what will be done once the caller agrees, or of nothing done',
    },
  },
  price: {
    type: 'noul',
    instructions: `${CONTEXT} Does the reply state a price, range, limit, charge, fee or discount that differs from the business information's prices, or that the business information does not give?`,
    criteria: {
      true: 'A cost the reply states is not the business information\'s (another figure, a cap, a fee or a discount it does not give)',
      false: 'Every cost in the reply is one the business information gives, or the reply states no cost',
    },
  },
  time: {
    type: 'noul',
    instructions: `${CONTEXT} Does the reply state a day, a time, a drop-off window, availability or how long something takes that differs from what the business information or the actions' results say?`,
    criteria: {
      true: 'A day, time, window, availability or duration the reply states differs from the business information or an action\'s result',
      false: 'Every day, time, window, availability or duration in the reply agrees with them, or the reply states none',
    },
  },
  process: {
    type: 'noul',
    instructions: `${CONTEXT} Does the reply describe how the business works (what happens next, who will contact the caller and how, what the caller must do or send, what the business does or does not offer) differently from the business information?`,
    criteria: {
      true: 'Something the reply says about how the business works or what happens next differs from the business information',
      false: 'What the reply says about how the business works agrees with the business information, or it says nothing on it',
    },
  },
  gap: CLAIM_QUESTIONS.gap as Question,
};

const p = (a: AnswerMap, k: string): number | null => probabilityOf(a[k] as Answer | undefined);

/** The largest of the four narrow readings: null when any is missing. */
export function narrowMax(a: AnswerMap): number | null {
  const xs = ['done', 'price', 'time', 'process'].map((k) => p(a, k));
  return xs.some((x) => x === null) ? null : Math.max(...(xs as number[]));
}

export default {
  name: 'narrow',
  questions: NARROW_QUESTIONS,
  rules: {
    narrowMax: { target: 'wrong' as const, score: narrowMax },
    done: { target: 'wrong' as const, score: (a: AnswerMap) => p(a, 'done') },
    gap: { target: 'gap' as const, score: (a: AnswerMap) => p(a, 'gap') },
  },
};

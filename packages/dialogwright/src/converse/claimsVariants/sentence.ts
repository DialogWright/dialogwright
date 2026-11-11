import type { Answer, AnswerMap, QuestionMap } from '../../jev/types';
import { probabilityOf } from '../confirm';

/**
 * The check's questions asked of one sentence of a reply at a time (an experiment, measured with
 * converse:claims-eval on cases split into sentences, each case's `sentence` beside its whole `reply`): a long
 * reply that is right in most of what it says may hold one wrong sentence, which a reading of the whole reply
 * weighs against the rest.
 */
const CONTEXT = 'The line, an automated assistant answering for the business, has just said reply to a caller; sentence is one sentence of it. business is the business\'s own information, today the business\'s date, and actions every action the line has called on this call, in order, with what each returned (an action read back and waiting for the caller\'s yes is not done yet).';

const QUESTIONS: QuestionMap = {
  contradicted: {
    type: 'noul',
    instructions: `${CONTEXT} Does the sentence state something that the business information, or the call's actions and what they returned, say otherwise?`,
    criteria: {
      true: 'Something the sentence states (a price, a time, a day, availability, a service, a policy, a fact about the business or about what an action returned) differs from what the business information or an action\'s result says',
      false: 'Everything the sentence states agrees with the business information and the actions\' results, or they say nothing on it',
    },
  },
  notDone: {
    type: 'noul',
    instructions: `${CONTEXT} Does the sentence tell the caller that something is already booked, sent, requested, recorded, noted, passed on, held or confirmed, when no action's result on this call shows it done?`,
    criteria: {
      true: 'The sentence says or implies something has already been done for the caller, and no action\'s result shows it done',
      false: 'Whatever the sentence says was done, an action\'s result shows done; or it speaks only of what will be done once the caller agrees, or of nothing done',
    },
  },
  gap: {
    type: 'noul',
    instructions: `${CONTEXT} Does the sentence commit the business to a price, a time, a policy or what happens next that neither the business information nor an action's result addresses?`,
    criteria: {
      true: 'The sentence answers for the business on something that the business information and the actions\' results say nothing on',
      false: 'Every commitment in the sentence is one the business information or an action\'s result makes, or it commits the business to nothing',
    },
  },
};

const p = (a: AnswerMap, k: string): number | null => probabilityOf(a[k] as Answer | undefined);

export default {
  name: 'sentence',
  questions: QUESTIONS,
  rules: {
    contradictedOrNotDone: {
      target: 'wrong' as const,
      score: (a: AnswerMap) => {
        const c = p(a, 'contradicted');
        const n = p(a, 'notDone');
        return c === null || n === null ? null : Math.max(c, n);
      },
    },
    gap: { target: 'gap' as const, score: (a: AnswerMap) => p(a, 'gap') },
  },
};

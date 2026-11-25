import { choiceAnswer, choiceLabels, noulAnswer, scoreAnswer, sharp } from './distributions';
import type { Answer, Question } from './types';
import { defaultAppOrNull } from '../core/app/registry';
import type { App } from '../core/app/types';

/** Noul values for a calm, on-topic, complete utterance with nothing notable: the engine's own questions (an app's add theirs, App.testing.quietNoul). */
export const QUIET_NOUL: Record<string, number> = {
  addressedToSystem: 0.92,
  intelligible: 0.93,
  utteranceComplete: 0.88,
  wantsHuman: 0.04,
  rephrasingLastTurn: 0.08,
  confusedByPrompt: 0.06,
  spokeAMenuNumber: 0.03,
  triedSelfService: 0.1,
  confirmsYes: 0.1,
  confirmsNo: 0.1,
  callerMatchDeclined: 0.05,
  intentTentative: 0.05,
  manipulation: 0.04,
};

export const QUIET_SCORE_WINNER: Record<string, string> = {
  frustration: 'none',
  urgency: 'normal',
};

/** What a yes-or-no question gets when nothing bears on it: the app's own value, else the engine's, else 0.1. */
export function quietNoulOf(id: string, app: App | null): number {
  const own = app?.testing?.quietNoul;
  if (own && Object.hasOwn(own, id)) return own[id]!;
  return QUIET_NOUL[id] ?? 0.1;
}

/**
 * The answer a question gets when nothing in the utterance bears on it. `app` (default: the default
 * app, if one is registered) lends its own questions' quiet values (App.testing.quietNoul).
 */
export function quietAnswer(id: string, q: Question, sharpness: number, app: App | null = defaultAppOrNull()): Answer {
  switch (q.type) {
    case 'noul':
      return noulAnswer(quietNoulOf(id, app));
    case 'score': {
      const labels = q.levels.map((l) => l.label);
      return scoreAnswer(q, sharp(labels, QUIET_SCORE_WINNER[id] ?? labels[0]!, 0.85));
    }
    case 'choice': {
      const labels = choiceLabels(q);
      const winner = labels.includes('none') ? 'none' : labels[0]!;
      return choiceAnswer(sharp(labels, winner, sharpness));
    }
  }
}

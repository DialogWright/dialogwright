import { appOf } from './app/registry';
import type { Session } from './session';
import { wordingsOf } from '../prompts/render';
import { wordingId } from '../prompts/segments';

/**
 * The lines a call says in turn through their other wordings (prompts.yaml's `variants`): the text
 * the first time, then each variant in order, then the text again, by how many times the call has
 * said the line, never at random, so a replay or a recording says the same; every wording is fixed
 * text. `ack_intent` (the acknowledgement of a request), `kb_not_found` (a question nothing answers),
 * `kb_hold` and `kb_hold_more` (said while an answer is worded): the lines `check` lets have variants.
 */
export const ROTATING_LINES: readonly string[] = ['ack_intent', 'kb_not_found', 'kb_hold', 'kb_hold_more'];

/**
 * The prompt id of the wording `line` is said in this time (`<line>.vN`, prompts/segments.ts
 * wordingId): its own, unless it has others in the call's language. Counted per line, on the session
 * (ack_intent in Session.ackIntentSaid, as before; every other in Session.linesSaid), only while the
 * line has other wordings, so every other session is as it was.
 */
export function nextWording(s: Session, line: string): string {
  const count = wordingsOf(appOf(s), line, s.locale);
  if (count < 2) return line;
  if (line === 'ack_intent') {
    const said = s.ackIntentSaid ?? 0;
    s.ackIntentSaid = said + 1;
    return wordingId(line, (said % count) + 1);
  }
  const said = s.linesSaid?.[line] ?? 0;
  s.linesSaid = { ...(s.linesSaid ?? {}), [line]: said + 1 };
  return wordingId(line, (said % count) + 1);
}

import { appOf } from './app/registry';
import type { Session } from './session';
import { wordingsOf } from '../prompts/render';
import { wordingId } from '../prompts/segments';

/**
 * The lines a call says in turn through their other wordings (prompts.yaml's `variants`): the text
 * the first time, then each variant in order, then the text again, by how many times the call has
 * said the line, never at random, so a replay or a recording says the same; every wording is fixed
 * text. `ack_intent` (the acknowledgement of a request), `kb_not_found` (a question nothing answers),
 * `kb_hold` and `kb_hold_more` (said while an answer is worded): the lines `check` lets have variants,
 * with each slot's own question (`ask_<slot>`, below).
 */
export const ROTATING_LINES: readonly string[] = ['ack_intent', 'kb_not_found', 'kb_hold', 'kb_hold_more'];

/**
 * Whether `id` is a line said in turn through its variants: one of ROTATING_LINES, or a slot's own
 * question, `ask_<slot>` for a slot of `slots` (never its retry, no-input, keypad or partial lines),
 * said in turn each time the call asks it, a repeat request saying it as it was.
 */
export function rotatesLine(id: string, slots: Readonly<Record<string, unknown>>): boolean {
  return ROTATING_LINES.includes(id) || (id.startsWith('ask_') && Object.hasOwn(slots, id.slice('ask_'.length)));
}

/**
 * The prompt id of the wording `line` is said in this time (`<line>.vN`, prompts/segments.ts
 * wordingId): its own, unless it has others in the call's language. Counted per line, on the session
 * (ack_intent in Session.ackIntentSaid, as before; every other in Session.linesSaid), only while the
 * line has other wordings, so every other session is as it was.
 */
export function nextWording(s: Session, line: string): string {
  const app = appOf(s);
  // A line the app does not have is said (or found missing) as it was, never counted.
  if (!Object.hasOwn(app.prompts.manifest, line)) return line;
  const count = wordingsOf(app, line, s.locale);
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

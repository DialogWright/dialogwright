/**
 * What the core asks a channel to do, in the engine's own terms. A provider adapter maps these onto
 * its wire (src/channel/relay for Twilio ConversationRelay); a text channel reads the words.
 */

/** Part of a line: words for the channel's own voice or display, or a recorded clip's URL. */
export type SayPart = { text: string } | { audio: string };

/** One line, in order of its parts. `interruptible`: the user may speak over it. */
export interface Say { type: 'say'; parts: SayPart[]; interruptible: boolean }
/** The session is over and its business done. */
export interface End { type: 'end'; completed: string[] }
/** Hand the session to a person, with why and what was done, still queued, and collected. */
export interface Transfer { type: 'transfer'; reason: string; completed: string[]; queued: string[]; slots: Record<string, string> }
/** Play key tones on the line (none produced yet; the relay can send them). */
export interface SendDigits { type: 'send_digits'; digits: string }
/** Switch speech and recognition language (none produced yet; the relay can send it). */
export interface SetLanguage { type: 'set_language'; tts: string; transcription: string }

export type Action = Say | End | Transfer | SendDigits | SetLanguage;

export function sayAction(parts: SayPart[], interruptible: boolean): Say {
  return { type: 'say', parts, interruptible };
}
export function endAction(completed: readonly string[] = []): End {
  return { type: 'end', completed: [...completed] };
}
export function transferAction(reason: string, completed: readonly string[] = [], queued: readonly string[] = [], slots: Record<string, string> = {}): Transfer {
  return { type: 'transfer', reason, completed: [...completed], queued: [...queued], slots: { ...slots } };
}

/** The words said, in order, one space between parts (recorded clips carry no words here). */
export function sayText(actions: readonly Action[]): string {
  return actions.flatMap((a) => (a.type === 'say' ? a.parts.flatMap((p) => ('text' in p ? [p.text] : [])) : [])).join(' ');
}

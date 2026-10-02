import type { Principal } from '../gate/types';

/**
 * What happened in a session, in the engine's own terms. A provider adapter (src/channel/relay for
 * Twilio ConversationRelay) maps its wire messages onto the channel events; the core never sees a
 * provider's format. Server-made events never come off a wire.
 */
export const DEFAULT_LANG = 'en-US';

/**
 * A session began. Provider details (call ids, numbers, custom parameters) are opaque to the core.
 * `locale` is the language the channel asks the session to speak (a language tag, e.g. es-US), when
 * it names one: the session speaks it where the app has it (App.locales), its default otherwise.
 */
export interface SessionStart { type: 'session.start'; provider: Readonly<Record<string, string>>; locale?: string }
/** Recognized speech. Only a final transcript is a turn; a partial one holds. */
export interface UserSpeech { type: 'user.speech'; text: string; final: boolean; lang: string }
/** Typed text: always final. */
export interface UserText { type: 'user.text'; text: string }
/** One key pressed. */
export interface UserKey { type: 'user.key'; digit: string }
/** The user spoke over our line. `heard` is the part of our own line that had played when they did (never the user's words), and `afterMs` how far into it. */
export interface UserInterrupt { type: 'user.interrupt'; heard: string; afterMs: number }
/** Server-made: nothing said or pressed for the no-input wait. */
export interface UserSilence { type: 'user.silence' }
/** The provider reported an error; the core ignores it (the adapter logs it). */
export interface ChannelError { type: 'channel.error'; description: string }
/**
 * Server-made: a downstream service's answer (App.services) to the request the session is waiting
 * on. `result` and `note` are the service's own shapes and untrusted: whoever reads them narrows
 * them where it uses them.
 */
export interface ServiceResult { type: 'service.result'; service: string; result: unknown; note?: unknown }
/** Server-made: the user signed in through the site's identity provider during a chat. */
export interface SignedIn { type: 'auth.signed_in'; principal: Principal }

/**
 * Every event a session's turns run on. Off a channel: session.start, user.speech, user.text,
 * user.key, user.interrupt and channel.error. Server-made, never off a channel: user.silence,
 * service.result and auth.signed_in.
 */
export type SessionEvent = SessionStart | UserSpeech | UserText | UserKey | UserInterrupt | UserSilence | ChannelError | ServiceResult | SignedIn;

export function startEvent(provider: Readonly<Record<string, string>> = {}, locale?: string): SessionStart {
  return locale === undefined ? { type: 'session.start', provider } : { type: 'session.start', provider, locale };
}
export function speechEvent(text: string, final = true, lang = DEFAULT_LANG): UserSpeech {
  return { type: 'user.speech', text, final, lang };
}
export function textEvent(text: string): UserText {
  return { type: 'user.text', text };
}
export function keyEvents(digits: string): UserKey[] {
  return [...digits].map((digit) => ({ type: 'user.key', digit }));
}
export function interruptEvent(heard: string, afterMs: number): UserInterrupt {
  return { type: 'user.interrupt', heard, afterMs };
}
export function silenceEvent(): UserSilence {
  return { type: 'user.silence' };
}
export function errorEvent(description: string): ChannelError {
  return { type: 'channel.error', description };
}
export function serviceResultEvent(service: string, result: unknown, note?: unknown): ServiceResult {
  return { type: 'service.result', service, result, ...(note ? { note } : {}) };
}
export function signedInEvent(principal: Principal): SignedIn {
  return { type: 'auth.signed_in', principal };
}

/** The words of a speech or text event, or null for any other event. */
export function wordsOf(e: SessionEvent): string | null {
  return e.type === 'user.speech' || e.type === 'user.text' ? e.text : null;
}

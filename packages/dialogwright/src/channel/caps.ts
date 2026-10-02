/**
 * What a channel can do. The core checks these, never a channel's name: no keypad prompt where
 * `!keypad`, no spoken identity factors where the user signs in instead. (The core reads speech,
 * keypad and signIn today; recordedAudio, bargeIn, richUi and async are declared for later:
 * whether clips play is still the render context's call.)
 */
export interface ChannelCaps {
  /** The user hears synthesized speech and speaks (voice); false for typed text. */
  speech: boolean;
  /** The user can press keys. */
  keypad: boolean;
  /** The user can talk over what is being said. */
  bargeIn: boolean;
  /** The channel can play recorded clips. */
  recordedAudio: boolean;
  /** The channel can show buttons and quick replies. */
  richUi: boolean;
  /** The user proves who they are by signing in to the site, never by spoken factors. */
  signIn: boolean;
  /** Replies may arrive minutes or hours apart (messaging). */
  async: boolean;
}

/** A channel's kind (recorded in the audit and on the console) and what it can do. */
export interface Channel { kind: string; caps: ChannelCaps }

export const VOICE_RELAY: Channel = {
  kind: 'voice',
  caps: { speech: true, keypad: true, bargeIn: true, recordedAudio: true, richUi: false, signIn: false, async: false },
};

export const WEB_CHAT: Channel = {
  kind: 'chat',
  caps: { speech: false, keypad: false, bargeIn: false, recordedAudio: false, richUi: true, signIn: true, async: false },
};

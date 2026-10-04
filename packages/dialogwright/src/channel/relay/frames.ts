// Twilio ConversationRelay's message protocol, mapped to the engine's channel model in map.ts.
// Field names match the Twilio docs exactly; do not rename.

import type { Principal } from '../../gate/types';
import { DEFAULT_LANG } from '../events';

export interface SetupFrame {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from: string;
  to: string;
  customParameters: Record<string, string>;
  // Optional fields Twilio also sends; passed through and logged, never read by the core.
  accountSid?: string;
  parentCallSid?: string;
  forwardedFrom?: string;
  callType?: string;
  callerName?: string;
  direction?: string;
  callStatus?: string;
  // Telnyx's own call ids, beside its callSid (developers.telnyx.com, Conversation Relay); passed through the same way.
  callControlId?: string;
  callSessionId?: string;
  callLegId?: string;
}

export interface PromptFrame {
  type: 'prompt';
  voicePrompt: string;
  lang: string;
  last: boolean;
}

export interface DtmfFrame {
  type: 'dtmf';
  digit: string;
}

export interface InterruptFrame {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs: number;
}

export interface ErrorFrame {
  type: 'error';
  description: string;
}

/** Server-generated: the caller said and pressed nothing for the no-input wait. Never sent by Twilio. */
export interface SilenceFrame {
  type: 'silence';
}

/**
 * Server-generated: a downstream service's answer (App.services) to the request the call is waiting
 * on, or null when it gave none in time. Never sent by Twilio, so parseInbound rejects it off the
 * wire. Written to the frame log so replay can run the answer again.
 */
export interface ServiceResultFrame {
  type: 'service_result';
  /** The service's name in the app (e.g. 'depot'). */
  service: string;
  /** The service's answer, its own shape and untrusted. */
  result: unknown;
  /** What the service's client made of the reply (e.g. answered, refused or no answer, and why); absent when the client keeps none. */
  note?: unknown;
}

/**
 * Server-generated: the customer signed in through the portal during a web chat (the mock identity
 * provider of an app's web chat stands in for it). Never sent by Twilio, so parseInbound
 * rejects it off the wire: nothing a caller says or sends can make one.
 */
export interface SignedInFrame {
  type: 'signed_in';
  principal: Principal;
}

export type InboundFrame = SetupFrame | PromptFrame | DtmfFrame | InterruptFrame | ErrorFrame | SilenceFrame | ServiceResultFrame | SignedInFrame;

export interface TextFrame {
  type: 'text';
  token: string;
  last: boolean;
  lang: string;
  interruptible: boolean;
  preemptible: boolean;
}

export interface PlayFrame {
  type: 'play';
  source: string;
  loop: number;
  preemptible: boolean;
  interruptible: boolean;
}

export interface SendDigitsFrame {
  type: 'sendDigits';
  digits: string;
}

export interface LanguageFrame {
  type: 'language';
  ttsLanguage: string;
  transcriptionLanguage: string;
}

export interface EndFrame {
  type: 'end';
  handoffData: string;
}

export type OutboundFrame = TextFrame | PlayFrame | SendDigitsFrame | LanguageFrame | EndFrame;

export function silenceFrame(): SilenceFrame {
  return { type: 'silence' };
}

export function serviceResultFrame(service: string, result: unknown, note?: unknown): ServiceResultFrame {
  return note ? { type: 'service_result', service, result, note } : { type: 'service_result', service, result };
}

export function textFrame(token: string, interruptible: boolean): TextFrame {
  return { type: 'text', token, last: true, lang: DEFAULT_LANG, interruptible, preemptible: false };
}

export function endFrame(
  reasonCode: string,
  completed: readonly string[] = [],
  queued: readonly string[] = [],
  slots: Record<string, string> = {},
): EndFrame {
  return {
    type: 'end',
    handoffData: JSON.stringify({
      reasonCode,
      ...(completed.length ? { completed } : {}),
      ...(queued.length ? { queued } : {}),
      ...(Object.keys(slots).length ? { slots } : {}),
    }),
  };
}

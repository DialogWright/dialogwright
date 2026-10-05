/**
 * The legacy Twilio documents, answered on the unprefixed `/voice` and `/cr-action`. Their bodies
 * live with the Twilio voice provider (server/voice/twilio.ts); these names stay for existing imports.
 */
import type { BargeIn } from '../channel/voiceProviders';
import { twilioConnectDocument, twilioProvider } from './voice/twilio';

export { escapeXml } from './voice/xml';

export interface ConnectOptions {
  publicHost: string;
  token: string;
  hints: string;
  /** TTS provider/voice for the segments that are not recorded clips; set both or neither. */
  ttsProvider?: string;
  voice?: string;
  /** BARGE_IN, the relay element's `interruptible` (StartDocumentOptions.bargeIn); absent, `any`. */
  bargeIn?: BargeIn;
  /** Seconds of silence before it connects (a planned restart's handover; StartDocumentOptions.pauseS). */
  pauseS?: number;
}

/**
 * The ConversationRelay connect document at the legacy paths: the socket on `/conversation` and the
 * action on `/cr-action`, so a number already pointed at `/voice` keeps working unchanged.
 */
export function connectRelayTwiml(o: ConnectOptions): string {
  return twilioConnectDocument(o, { socket: '/conversation', action: '/cr-action' });
}

export function dialTwiml(number: string): string {
  return twilioProvider.dialDocument(number);
}

export function hangupTwiml(): string {
  return twilioProvider.hangupDocument();
}

export function apologizeAndDialTwiml(number: string): string {
  return twilioProvider.apologizeAndDialDocument(number);
}

import { E164 } from '../core/numberLocales';

/**
 * The settings of a server's text sender (the guide's 13.17 and 14.12): the number texts are sent from,
 * TEXT_FROM (E.164; on a host, an app's own settings file may give its own), and the Twilio account they
 * are sent through, TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN (the voice webhook's token). TEXT_FROM unset
 * is no sender, the default: no text is sent, as before texts were a capability.
 */
export interface TextSettings {
  /** The number texts are sent from (E.164). */
  readonly from: string;
  readonly provider: 'twilio';
  readonly accountSid: string;
  readonly authToken: string;
}

/** A Twilio account's id: AC and 32 hex digits. */
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

/** The text sender's settings from `env`, or null where TEXT_FROM is unset; throws, naming the setting, on one the server would refuse. */
export function textSettings(env: Readonly<Record<string, string | undefined>>): TextSettings | null {
  const from = env.TEXT_FROM?.trim() ?? '';
  if (from === '') return null;
  if (!E164.test(from)) throw new Error('TEXT_FROM is not a phone number in E.164 form ("+15555550100"): write the number texts are sent from as + and its country code and digits');
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  if (accountSid === '') throw new Error('TEXT_FROM is set, but TWILIO_ACCOUNT_SID is unset: texts are sent through Twilio\'s Messages API, which needs the account\'s id (AC and 32 hex digits, on the Twilio console\'s front page)');
  if (!ACCOUNT_SID.test(accountSid)) throw new Error('TWILIO_ACCOUNT_SID is not a Twilio account id: it is AC and 32 hex digits, as the Twilio console shows it');
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  if (authToken === '') throw new Error('TEXT_FROM is set, but TWILIO_AUTH_TOKEN is unset: texts are sent with the Twilio account\'s auth token');
  return { from, provider: 'twilio', accountSid, authToken };
}

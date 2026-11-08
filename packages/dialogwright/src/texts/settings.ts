import { E164 } from '../core/numberLocales';

/**
 * The settings of a server's text sender (the guide's 13.17 and 14.12): the number texts are sent from,
 * TEXT_FROM (E.164; on a host, an app's own settings file may give its own), and the Twilio account they
 * are sent through, TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN (the voice webhook's token). TEXT_FROM unset
 * is no sender, the default: no text is sent, as before texts were a capability. And the sender's abuse
 * limits (the design's call 46): TEXT_LIMIT_PER_NUMBER texts to one number in 24 hours (default 3) and
 * TEXT_LIMIT_PER_HOUR texts in all in an hour (default 20), each per app; TEXT_LIMIT_EXEMPT, the numbers
 * the per-number limit does not hold (the business's own phones), default none.
 */
export interface TextSettings {
  /** The number texts are sent from (E.164). */
  readonly from: string;
  readonly provider: 'twilio';
  readonly accountSid: string;
  readonly authToken: string;
  readonly limits: TextLimitSettings;
}

/** The sender's abuse limits (TextLimits). */
export interface TextLimitSettings {
  /** Texts to one number in 24 hours. */
  readonly perNumber: number;
  /** Texts in all in an hour, for the app. */
  readonly perHour: number;
  /** Numbers (E.164) the per-number limit does not hold: the business's own phones. They count toward the hour's. */
  readonly exempt: readonly string[];
}

/** The defaults of the abuse limits: 3 texts to one number a day, 20 an hour in all. */
export const DEFAULT_TEXT_LIMITS: TextLimitSettings = Object.freeze({ perNumber: 3, perHour: 20, exempt: Object.freeze([]) as readonly string[] });

/** A whole number setting in 1..max, or its default where unset; throws, naming it, otherwise. */
function count(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${name} is not a whole number from 1 to ${max}: write how many texts it allows (default ${fallback})`);
  return Number(raw);
}

/** The abuse limits from `env` (TEXT_LIMIT_PER_NUMBER, TEXT_LIMIT_PER_HOUR, TEXT_LIMIT_EXEMPT); throws, naming the setting, on one the server would refuse. */
export function textLimitSettings(env: Readonly<Record<string, string | undefined>>): TextLimitSettings {
  const exempt = (env.TEXT_LIMIT_EXEMPT ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '');
  const bad = exempt.find((n) => !E164.test(n));
  if (bad !== undefined) throw new Error('TEXT_LIMIT_EXEMPT is not a comma list of numbers in E.164 form ("+15555550190,+15555550191"): write each of the business\'s own phones as + and its country code and digits');
  return { perNumber: count(env, 'TEXT_LIMIT_PER_NUMBER', DEFAULT_TEXT_LIMITS.perNumber, 1000), perHour: count(env, 'TEXT_LIMIT_PER_HOUR', DEFAULT_TEXT_LIMITS.perHour, 100000), exempt };
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
  return { from, provider: 'twilio', accountSid, authToken, limits: textLimitSettings(env) };
}

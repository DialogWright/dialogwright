import { E164 } from '../core/numberLocales';
import { telnyxPublicKey } from '../server/voice/telnyxSignature';

/**
 * The settings of a server's text sender (the guide's 13.17 and 14.12): the number texts are sent from,
 * TEXT_FROM (E.164; on a host, an app's own settings file may give its own), and the provider they are sent
 * through, TEXT_PROVIDER: `twilio`, Twilio's Messages API with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (the
 * voice webhook's token), or `telnyx`, Telnyx's Messaging API with TELNYX_API_KEY (texts that come in
 * checked with TELNYX_PUBLIC_KEY, the voice webhooks' key). TEXT_PROVIDER unset is Twilio where
 * TWILIO_ACCOUNT_SID is given, as before there was a choice, else Telnyx where TELNYX_API_KEY is: each
 * provider's own credential names it, and with both given Twilio stays, so no server that sent through
 * Twilio sends otherwise unasked. TEXT_FROM unset is no sender, the default: no text is sent, as before
 * texts were a capability. And the sender's abuse limits (the design's call 46): TEXT_LIMIT_PER_NUMBER
 * texts to one number in 24 hours (default 3) and TEXT_LIMIT_PER_HOUR texts in all in an hour (default 20),
 * each per app; TEXT_LIMIT_EXEMPT, the numbers the per-number limit does not hold (the business's own
 * phones), default none.
 */
export type TextSettings = TwilioTextSettings | TelnyxTextSettings;

/** Texts through Twilio's Messages API. */
export interface TwilioTextSettings {
  /** The number texts are sent from (E.164). */
  readonly from: string;
  readonly provider: 'twilio';
  readonly accountSid: string;
  readonly authToken: string;
  readonly limits: TextLimitSettings;
}

/** Texts through Telnyx's Messaging API. */
export interface TelnyxTextSettings {
  /** The number texts are sent from (E.164), on a Telnyx messaging profile. */
  readonly from: string;
  readonly provider: 'telnyx';
  /** The API key (Mission Control, Keys & Credentials, API Keys), as a bearer token. */
  readonly apiKey: string;
  /** TELNYX_PUBLIC_KEY, which a text that comes in is checked with; null where unset (every one is then refused while SIGNATURE_CHECK is on). */
  readonly publicKey: string | null;
  readonly limits: TextLimitSettings;
}

/** The providers TEXT_PROVIDER may name. */
export const TEXT_PROVIDERS = ['twilio', 'telnyx'] as const;
export type TextProviderId = (typeof TEXT_PROVIDERS)[number];

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

/** The provider TEXT_PROVIDER names, or the one the credentials given name where it is unset (Twilio's account first, as before). */
function providerOf(env: Readonly<Record<string, string | undefined>>): TextProviderId {
  const named = env.TEXT_PROVIDER?.trim().toLowerCase() ?? '';
  if (named !== '') {
    if (!(TEXT_PROVIDERS as readonly string[]).includes(named)) throw new Error(`TEXT_PROVIDER is twilio or telnyx: write the carrier texts are sent through, or unset it to send through the one whose credentials are given`);
    return named as TextProviderId;
  }
  if ((env.TWILIO_ACCOUNT_SID?.trim() ?? '') !== '') return 'twilio';
  if ((env.TELNYX_API_KEY?.trim() ?? '') !== '') return 'telnyx';
  return 'twilio';
}

/** The text sender's settings from `env`, or null where TEXT_FROM is unset; throws, naming the setting, on one the server would refuse. */
export function textSettings(env: Readonly<Record<string, string | undefined>>): TextSettings | null {
  const from = env.TEXT_FROM?.trim() ?? '';
  if (from === '') return null;
  if (!E164.test(from)) throw new Error('TEXT_FROM is not a phone number in E.164 form ("+15555550100"): write the number texts are sent from as + and its country code and digits');
  const provider = providerOf(env);
  if (provider === 'telnyx') return telnyxSettings(env, from);
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  if (accountSid === '') throw new Error(`TEXT_FROM is set, but TWILIO_ACCOUNT_SID is unset: texts are sent through Twilio's Messages API, which needs the account's id (AC and 32 hex digits, on the Twilio console's front page)${(env.TEXT_PROVIDER?.trim() ?? '') === '' ? ', or through Telnyx with TEXT_PROVIDER=telnyx with TELNYX_API_KEY' : ''}`);
  if (!ACCOUNT_SID.test(accountSid)) throw new Error('TWILIO_ACCOUNT_SID is not a Twilio account id: it is AC and 32 hex digits, as the Twilio console shows it');
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  if (authToken === '') throw new Error('TEXT_FROM is set, but TWILIO_AUTH_TOKEN is unset: texts are sent with the Twilio account\'s auth token');
  return { from, provider: 'twilio', accountSid, authToken, limits: textLimitSettings(env) };
}

/** Telnyx's: the API key, and the public key a text that comes in is checked with where given. */
function telnyxSettings(env: Readonly<Record<string, string | undefined>>, from: string): TelnyxTextSettings {
  const apiKey = env.TELNYX_API_KEY?.trim() ?? '';
  if (apiKey === '') throw new Error('TEXT_PROVIDER is telnyx, but TELNYX_API_KEY is unset: texts are sent through Telnyx\'s Messaging API with an API key (Mission Control, Account settings, Keys & Credentials, API Keys)');
  if (/\s/.test(apiKey)) throw new Error('TELNYX_API_KEY has a space in it: paste the API key whole, as Mission Control shows it once when it is made');
  const publicKey = env.TELNYX_PUBLIC_KEY?.trim() ?? '';
  if (publicKey !== '') {
    try {
      telnyxPublicKey(publicKey);
    } catch {
      throw new Error('TELNYX_PUBLIC_KEY is not the account\'s base64 Ed25519 public key (Mission Control, Account settings, Keys & Credentials, Public Key): texts that come in are checked with it');
    }
  }
  return { from, provider: 'telnyx', apiKey, publicKey: publicKey === '' ? null : publicKey, limits: textLimitSettings(env) };
}

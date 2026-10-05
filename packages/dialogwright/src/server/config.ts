import { defaultTimeZone, localDateIso } from '../run/clock';
import { resolveJevProvider, type JevProvider } from '../jev/provider';

import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { parseScreenMode, type ScreenMode } from '../core/screen';
import { checkSecretOf, endDropsSpeechOf, KNOWN_VOICE_PROVIDERS, readsPlaybackEvents, secretLabelOf, secretVarOf } from './voice/registry';
import {
  BARGE_IN_MODES, bargeInRefusal, DEFAULT_END_PLAYBACK_MAX_MS, DEFAULT_INCOMPLETE_WAIT_MS, DEFAULT_NO_INPUT_AFTER_SPEECH_MS, DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS, DEFAULT_RESUME_AFTER_PAUSE_MS, DEFAULT_RESUME_INTO_REPLY_MS, END_AFTER_PLAYBACK_MODES, RECOGNIZER_NAME, TWILIO_TTS_PROVIDERS as TTS_PROVIDERS,
  type BargeIn, type EndAfterPlayback,
} from '../channel/voiceProviders';
import type { Recognition } from '../core/app/types';
import { describeOrigins, parseAllowedOrigins, type AllowedOrigins } from './chat/origins';
import { checkJwksUrl } from './chat/jwks';
import { isLoopbackHost } from './localOnly';
import { consoleAuthOf, describeConsoleAuth, type ConsoleAuthSettings } from './console/settings';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export type ClientKind = 'stub' | 'heuristic' | 'jev';

/**
 * The engine's web chat endpoint (`/chat`, a WebSocket speaking src/channel/chat/protocol.ts), as
 * CHAT=on configures it.
 */
export interface ChatSettings {
  /** CHAT_ALLOWED_ORIGINS, required: the sites whose pages may open a chat (server/chat/origins.ts). */
  origins: AllowedOrigins;
  /** CHAT_IDLE_MS, default 1,800,000: how long a chat session nobody writes to lives (and can be resumed). */
  idleMs: number;
  /**
   * CHAT_MAX_SESSIONS, default 1000: the most chat sessions live at once (a dropped one waiting for
   * its resume included). Over it a new chat is refused `busy`; a resume never is. A limit per
   * visitor's address is the reverse proxy's to keep: behind one, every chat comes from its address.
   */
  maxSessions: number;
  /** CHAT_SIGNIN, default none: how a chat user signs in (server/chat/signin.ts). */
  signIn: ChatSignInSettings;
}

/**
 * CHAT_SIGNIN=none|jwt|mock. jwt: a token from the site's identity provider, verified against the keys
 * at CHAT_JWKS_URL (https), with iss CHAT_ISSUER and aud CHAT_AUDIENCE. mock: `mock:<id>`, unsigned,
 * for a laptop only (PUBLIC_HOST=localhost).
 */
export type ChatSignInSettings =
  | { method: 'none' }
  | { method: 'mock' }
  | { method: 'jwt'; jwksUrl: string; issuer: string; audience: string };

const CHAT_SIGNIN_METHODS = ['none', 'jwt', 'mock'] as const;

/** A chat session nobody has written to for this long is ended (CHAT_IDLE_MS's default; server/chatHttp.ts's CHAT_IDLE_MS). */
export const DEFAULT_CHAT_IDLE_MS = 1_800_000;
/** The most chat sessions live at once, unless CHAT_MAX_SESSIONS says otherwise. */
export const DEFAULT_CHAT_MAX_SESSIONS = 1000;

export interface ServerConfig {
  port: number;
  publicHost: string;
  /** Twilio's auth token, or the empty string when VOICE_PROVIDERS leaves Twilio out. Kept for existing readers; providerSecrets has every carrier's. */
  twilioAuthToken: string;
  /**
   * VOICE_PROVIDERS, default `twilio`: the carriers this deployment answers, by id (server/voice/registry.ts),
   * each on `/voice/<id>`, `/cr-action/<id>` and `/conversation/<id>`. The unprefixed paths are Twilio's.
   */
  voiceProviders: readonly string[];
  /** Each enabled carrier's secret, by id: TWILIO_AUTH_TOKEN for twilio, TELNYX_PUBLIC_KEY for telnyx. Required only for an enabled carrier. */
  providerSecrets: Readonly<Record<string, string>>;
  handoffNumber: string;
  jevClient: ClientKind;
  /**
   * Where the model is, which one, and its key (jev/provider.ts), resolved for JEV_CLIENT=jev
   * only: JEV_PROVIDER, JEV_BASE_URL, JEV_MODEL and the provider's key variable. Null for a stub.
   */
  jevProvider: JevProvider | null;
  todayOverride: string | null;
  traceDir: string;
  /** The hash-chained audit log's directory, one JSONL file per UTC day. */
  auditDir: string;
  signatureCheck: boolean;
  reconnectLimit: number;
  sessionTtlMs: number;
  sessionMaxAgeMs: number;
  timezone: string;
  audioDir: string;
  /**
   * TTS_PROVIDER and TTS_VOICE: Twilio's voice for the prompts, set together or not at all. Twilio's
   * only; another carrier names its voices its own way and never receives these (voiceFor).
   */
  ttsProvider: string | null;
  ttsVoice: string | null;
  /**
   * TELNYX_VOICE, optional: Telnyx's voice for the prompts, a Telnyx voice name, which carries its
   * engine (`Telnyx.Ultra.Callie`, say). Unset, Telnyx speaks with its default voice.
   */
  telnyxVoice: string | null;
  /**
   * TWILIO_TRANSCRIPTION_PROVIDER, default Deepgram, and TWILIO_SPEECH_MODEL, default flux when the
   * provider is Deepgram (flux is Deepgram's model) and none otherwise: Twilio's recognizer for the
   * app's default locale (recognitionFor). An app's voice.locales.<tag>.recognition.twilio wins.
   */
  twilioTranscriptionProvider: string;
  twilioSpeechModel: string | null;
  /** TELNYX_TRANSCRIPTION_PROVIDER, optional: Telnyx's recognizer for the default locale; unset, Telnyx's own default. */
  telnyxTranscriptionProvider: string | null;
  /**
   * TELNYX_EVENTS, optional: the event streams Telnyx sends on the socket (its relay's `events` attribute:
   * speaker-events, tokens-played). The adapter writes each to the call's frame log. tokens-played also
   * lets the adapter notice a line Telnyx cut short and say it again (RESAY_CUT_LINES, below); without it
   * Telnyx reports no playback and nothing is said twice.
   */
  telnyxEvents?: string | null;
  /**
   * RESAY_CUT_LINES=on|off, default on: a turn's lines the carrier reports it finished playing in less
   * than `resayMinFraction` of their estimated length, with no interrupt and no caller heard between,
   * are sent again once (server/adapter.ts). Active only on a carrier that reports its playback
   * (VoiceProvider.readEvent: Telnyx with TELNYX_EVENTS); on any other call it changes nothing.
   * Optional in the type only, for a config made by hand before it existed (absent reads as on).
   */
  resayCutLines?: boolean;
  /** RESAY_MIN_FRACTION, 0.05 to 0.95, default 0.35 (DEFAULT_RESAY_MIN_FRACTION): under it, a playback was cut short. */
  resayMinFraction?: number;
  /**
   * BARGE_IN, default any: who may talk over a line the agent is saying. It is the relay element's
   * `interruptible` in the document each voice provider gives its carrier (Twilio's ConversationRelay
   * and Telnyx's both take any, speech, dtmf and none): `any` lets speech or a keypress cut a line
   * off, `speech` speech only, `dtmf` a keypress only, `none` neither. `any` is how the engine has
   * always connected. Why it is a setting: a carrier's barge-in can stop the agent's speech on noise or
   * echo (a speakerphone, a noisy room), and turning it to `dtmf` or `none` is also the way to rule
   * barge-in in or out when callers report not hearing replies. With `none` or `dtmf` the lines the
   * engine sends are not marked interruptible either (their per-line `interruptible` says false;
   * channel/relay/frames.ts bargeInFrame). A mode an enabled voice provider does not take is refused
   * at startup, never ignored. Optional in the type only, for a config made by hand before it existed
   * (absent reads as any).
   */
  bargeIn?: BargeIn;
  /**
   * END_AFTER_PLAYBACK=auto|on|off, default auto: whether a turn that ends the call (a goodbye before the
   * hang-up, a line before a transfer) holds its `end` frame until the lines before it have played. A
   * carrier that acts on `end` at once drops what it has not yet said, and the caller hears no goodbye
   * (Telnyx, seen on a live call). The `end` goes when the carrier reports the last line played
   * (Telnyx with TELNYX_EVENTS), or by the estimate and a margin when no report comes; on a carrier that
   * reports nothing, after the lines' estimated length. `auto` holds it on the carriers that need it
   * (VoiceProvider.endDropsSpeech: Telnyx), `on` on every carrier, `off` on none (the lines and the
   * `end` together, as before). Optional in the type only, for a config made by hand before it existed
   * (absent reads as auto).
   */
  endAfterPlayback?: EndAfterPlayback;
  /** END_PLAYBACK_MAX_MS, default 15000 (DEFAULT_END_PLAYBACK_MAX_MS): the longest an `end` is held. */
  endPlaybackMaxMs?: number;
  /** Silence after a prompt's estimated playback before the caller is asked again; 0 disables. */
  noInputMs: number;
  /**
   * NO_INPUT_AFTER_SPEECH_MS, default 2500 (DEFAULT_NO_INPUT_AFTER_SPEECH_MS). On a carrier that reports
   * the caller's voice (Telnyx with TELNYX_EVENTS speaker-events), the no-input wait is held while the
   * caller speaks, and runs at least this long after they stop, so the transcript of what they said
   * arrives before a silence turn could. Optional in the type only, for a config made by hand before it
   * existed (absent reads as the default).
   */
  noInputAfterSpeechMs?: number;
  /**
   * RESUME_AFTER_PAUSE_MS, 0 to 10000, default 2000 (DEFAULT_RESUME_AFTER_PAUSE_MS), and
   * RESUME_INTO_REPLY_MS, 0 to 5000, default 1000 (DEFAULT_RESUME_INTO_REPLY_MS). On a carrier that reports
   * the caller's voice, a caller who comes back in no later than RESUME_AFTER_PAUSE_MS after they stopped,
   * and no later than RESUME_INTO_REPLY_MS after the reply to that prompt went out, had not finished: their
   * next final prompt continues the one before it (App.voice.continueWithinMs, server/adapter.ts). Optional
   * in the type only (absent reads as the defaults).
   */
  resumeAfterPauseMs?: number;
  resumeIntoReplyMs?: number;
  /**
   * RESAY_SPURIOUS_INTERRUPTS=on|off, default on, and SPURIOUS_INTERRUPT_WINDOW_MS, 0 to 5000, default 700
   * (DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS). On a carrier that reports the caller's voice (Telnyx with
   * TELNYX_EVENTS speaker-events; reportsCallerVoice), a carrier's interrupt with the caller not speaking and
   * not heard within the window before it, nor within a short settle after it, is not the caller's: no turn
   * runs for it, and the lines it cut are said again once (server/adapter.ts, a spurious interrupt). Optional
   * in the type only (absent reads as the defaults).
   */
  resaySpuriousInterrupts?: boolean;
  spuriousInterruptWindowMs?: number;
  /**
   * INCOMPLETE_WAIT_MS, 0 to 3000, default 1000 (DEFAULT_INCOMPLETE_WAIT_MS; 0 turns it off), and
   * INCOMPLETE_WAIT_BELOW, 0.05 to 0.95, unset by default (null: the call's GATE_COMPLETE). On a carrier that
   * reports the caller's voice, the reply to a final prompt whose words the model reads as unfinished (its
   * utteranceComplete under the value) is held up to INCOMPLETE_WAIT_MS, and never said when the caller goes
   * on in that time: the next final prompt continues it (server/adapter.ts, a reply held). Optional in the
   * type only (absent reads as the defaults).
   */
  incompleteWaitMs?: number;
  incompleteWaitBelow?: number | null;
  /**
   * How long one request to Jev may take before the turn gives up on it, plays the slow-turn
   * hint and keeps the prompt open. The SDK retries once inside this budget, so a caller waits up
   * to twice this on a turn the model never answers. A phone-turn budget, not a recording one.
   */
  jevTimeoutMs: number;
  /**
   * SCREEN_MODE, default inline: where the injection screen is asked (core/screen.ts ScreenMode).
   * inline puts its question in perception's request; separate sends it in a request of its own.
   */
  screen: ScreenMode;
  /** Serve the live call dashboard and publish call moments to its bus. */
  dashboard: boolean;
  /**
   * Play the recorded clips under `audioDir`. Off (the default), every prompt is spoken by
   * ConversationRelay's TTS voice: one voice for the fixed text and the names and dates alike, and
   * no seams between clips. On brings back the recorded voice.
   */
  clips: boolean;
  /** Claude Haiku's key for the handoff summary. Optional; without it the summary is always null. */
  anthropicApiKey: string | null;
  /** On/off, default on. Effective only with `anthropicApiKey` set. */
  handoffSummary: boolean;
  /**
   * CONSOLE_LOCAL_ONLY, default on: the operator console (/dashboard*), and each app route that
   * declares itself local-only (AppRoute.localOnly), answer 404 to any request that came
   * through the tunnel on PUBLIC_HOST, and are served only to a direct request from this machine.
   * The Twilio webhooks are unaffected (src/server/localOnly.ts).
   */
  consoleLocalOnly: boolean;
  /**
   * CONSOLE_AUTH=token: the console is served through the tunnel too, behind a sign-in
   * (server/console/auth.ts). Absent for CONSOLE_AUTH=local, the default: today's local-only rule.
   */
  consoleAuth?: ConsoleAuthSettings;
  /**
   * CHAT=on|off, default off: whether the engine serves its own web chat on `/chat`. Absent when off,
   * so a deployment without chat has exactly the config it had before chat existed.
   */
  chat?: ChatSettings;
  /**
   * WIDGET=on|off, default off: whether the server serves the web chat widget's script on
   * `/widget.js`, for trying the widget on a laptop (a site in production loads it from wherever the
   * deployment publishes it). Absent when off. WIDGET_FILE is the built script.
   */
  widget?: WidgetSettings;
  /**
   * DRAIN_MS, default 30000 (DEFAULT_DRAIN_MS): how long a stopping server waits for its live calls and
   * chats to end before it closes what is left (index.ts RunningServer.drain); 0 closes at once.
   * Optional in the type only, for a config made by hand before it existed: loadConfig always sets it.
   */
  drainMs?: number;
  /**
   * TRACE_RETENTION_DAYS, unset by default (every trace kept, as before): trace files and their frame
   * logs last written more than this many days ago are deleted (server/retention.ts). Absent when unset.
   */
  traceRetentionDays?: number;
  /**
   * AUDIT_RETENTION_DAYS, unset by default (every audit day kept: the audit is a record): audit day
   * files more than this many days old are deleted, never today's. Absent when unset.
   */
  auditRetentionDays?: number;
  /**
   * SESSION_STORE, default memory (absent here, as before it existed): where calls, chats and relay
   * tokens are kept between turns (server/stores). `file:<dir>` keeps them in a folder on this machine
   * (server/stores/file.ts), so a restart resumes a call whose carrier calls back after it; a relative
   * folder is from where the server runs, as TRACE_DIR is.
   */
  sessionStore?: SessionStoreSetting;
}

/** Where sessions are kept when it is not the process's memory. */
export interface SessionStoreSetting {
  kind: 'file';
  dir: string;
  /**
   * SESSION_FSYNC=on|off, default off: whether each save is flushed to the disk before it is renamed
   * into place (stores/file.ts writeAtomic). Off, a process that stops or crashes loses nothing, and a
   * power cut may lose the last few seconds of saves; on, it loses none, at the disk's latency on
   * every turn.
   */
  fsync: boolean;
  /**
   * RESTART_PAUSE_S, default 5 (DEFAULT_RESTART_PAUSE_S), 0 to 60: at the end of a planned restart's
   * drain, the seconds each live call's carrier is told to wait before it connects again, so its socket
   * reaches the restarted server (index.ts drain). 0: the stopping server stops listening first, and a
   * callback that finds no server goes to the carrier's fallback document.
   */
  restartPauseS: number;
}

/** Under this fraction of its estimated length, a playback the carrier reports finished was cut short, unless RESAY_MIN_FRACTION says otherwise. */
export const DEFAULT_RESAY_MIN_FRACTION = 0.35;

/** RESAY_CUT_LINES and RESAY_MIN_FRACTION, checked. */
function resayOf(env: Env): { resayCutLines: boolean; resayMinFraction: number } {
  const sw = (env.RESAY_CUT_LINES?.trim() || 'on').toLowerCase();
  if (sw !== 'on' && sw !== 'off') throw new Error(`RESAY_CUT_LINES must be on or off, got "${env.RESAY_CUT_LINES}"`);
  const raw = env.RESAY_MIN_FRACTION?.trim() ?? '';
  const fraction = raw === '' ? DEFAULT_RESAY_MIN_FRACTION : Number(raw);
  if (!Number.isFinite(fraction) || fraction < 0.05 || fraction > 0.95) {
    throw new Error(`RESAY_MIN_FRACTION must be a fraction from 0.05 to 0.95, got "${env.RESAY_MIN_FRACTION}"`);
  }
  return { resayCutLines: sw === 'on', resayMinFraction: fraction };
}

/** BARGE_IN, any unless set; a value an enabled voice provider does not take is refused with the provider named. */
function bargeInOf(env: Env, voiceProviders: readonly string[]): BargeIn {
  const raw = env.BARGE_IN?.trim().toLowerCase() || 'any';
  if (!(BARGE_IN_MODES as readonly string[]).includes(raw)) {
    throw new Error(`BARGE_IN must be ${BARGE_IN_MODES.slice(0, -1).join(', ')} or ${BARGE_IN_MODES.at(-1)}, got "${env.BARGE_IN}"`);
  }
  const mode = raw as BargeIn;
  const refusal = bargeInRefusal(mode, voiceProviders);
  if (refusal) throw new Error(refusal);
  return mode;
}

/** END_AFTER_PLAYBACK and END_PLAYBACK_MAX_MS, checked. */
function endAfterPlaybackOf(env: Env): { endAfterPlayback: EndAfterPlayback; endPlaybackMaxMs: number } {
  const mode = env.END_AFTER_PLAYBACK?.trim().toLowerCase() || 'auto';
  if (!(END_AFTER_PLAYBACK_MODES as readonly string[]).includes(mode)) {
    throw new Error(`END_AFTER_PLAYBACK must be auto, on or off, got "${env.END_AFTER_PLAYBACK}"`);
  }
  const maxMs = integer(env, 'END_PLAYBACK_MAX_MS', DEFAULT_END_PLAYBACK_MAX_MS);
  if (maxMs <= 0) throw new Error(`END_PLAYBACK_MAX_MS must be a positive number of milliseconds, got "${env.END_PLAYBACK_MAX_MS}"`);
  return { endAfterPlayback: mode as EndAfterPlayback, endPlaybackMaxMs: maxMs };
}

/** RESUME_AFTER_PAUSE_MS and RESUME_INTO_REPLY_MS, checked; read on every carrier, so a typo is caught before it matters. */
function resumeOf(env: Env): { resumeAfterPauseMs: number; resumeIntoReplyMs: number } {
  const pauseMs = integer(env, 'RESUME_AFTER_PAUSE_MS', DEFAULT_RESUME_AFTER_PAUSE_MS);
  if (pauseMs > 10_000) throw new Error(`RESUME_AFTER_PAUSE_MS must be from 0 to 10000 milliseconds, got "${env.RESUME_AFTER_PAUSE_MS}"`);
  const intoMs = integer(env, 'RESUME_INTO_REPLY_MS', DEFAULT_RESUME_INTO_REPLY_MS);
  if (intoMs > 5_000) throw new Error(`RESUME_INTO_REPLY_MS must be from 0 to 5000 milliseconds, got "${env.RESUME_INTO_REPLY_MS}"`);
  return { resumeAfterPauseMs: pauseMs, resumeIntoReplyMs: intoMs };
}

/** RESAY_SPURIOUS_INTERRUPTS and SPURIOUS_INTERRUPT_WINDOW_MS, checked; read on every carrier, so a typo is caught before it matters. */
function spuriousOf(env: Env): { resaySpuriousInterrupts: boolean; spuriousInterruptWindowMs: number } {
  const sw = (env.RESAY_SPURIOUS_INTERRUPTS?.trim() || 'on').toLowerCase();
  if (sw !== 'on' && sw !== 'off') throw new Error(`RESAY_SPURIOUS_INTERRUPTS must be on or off, got "${env.RESAY_SPURIOUS_INTERRUPTS}"`);
  const windowMs = integer(env, 'SPURIOUS_INTERRUPT_WINDOW_MS', DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS);
  if (windowMs > 5_000) throw new Error(`SPURIOUS_INTERRUPT_WINDOW_MS must be from 0 to 5000 milliseconds, got "${env.SPURIOUS_INTERRUPT_WINDOW_MS}"`);
  return { resaySpuriousInterrupts: sw === 'on', spuriousInterruptWindowMs: windowMs };
}

/** INCOMPLETE_WAIT_MS and INCOMPLETE_WAIT_BELOW, checked; read on every carrier. */
function incompleteWaitOf(env: Env): { incompleteWaitMs: number; incompleteWaitBelow: number | null } {
  const waitMs = integer(env, 'INCOMPLETE_WAIT_MS', DEFAULT_INCOMPLETE_WAIT_MS);
  if (waitMs > 3_000) throw new Error(`INCOMPLETE_WAIT_MS must be from 0 to 3000 milliseconds, got "${env.INCOMPLETE_WAIT_MS}"`);
  const raw = env.INCOMPLETE_WAIT_BELOW?.trim() ?? '';
  const below = raw === '' ? null : Number(raw);
  if (below !== null && (!Number.isFinite(below) || below < 0.05 || below > 0.95)) {
    throw new Error(`INCOMPLETE_WAIT_BELOW must be a reading from 0.05 to 0.95, got "${env.INCOMPLETE_WAIT_BELOW}"`);
  }
  return { incompleteWaitMs: waitMs, incompleteWaitBelow: below };
}

/**
 * Whether a carrier this deployment answers is asked to report the caller's voice: Telnyx with
 * TELNYX_EVENTS speaker-events (Twilio reports none). What a spurious interrupt and a held reply need: with
 * no report of the caller speaking, every interrupt would look spurious and every hold run its whole wait.
 */
export function reportsCallerVoice(c: Pick<ServerConfig, 'voiceProviders' | 'telnyxEvents'>): boolean {
  return c.voiceProviders.includes('telnyx') && (c.telnyxEvents ?? '').toLowerCase().split(/\s+/).includes('speaker-events');
}

/** The pause a planned restart's handover asks of each carrier, unless RESTART_PAUSE_S says otherwise. */
export const DEFAULT_RESTART_PAUSE_S = 5;
/** The longest RESTART_PAUSE_S: a caller in silence longer than this has hung up. */
const MAX_RESTART_PAUSE_S = 60;

/** How long a stopping server waits for live calls and chats, unless DRAIN_MS says otherwise. */
export const DEFAULT_DRAIN_MS = 30_000;

export interface WidgetSettings {
  /** WIDGET_FILE, default DEFAULT_WIDGET_FILE resolved from where the server runs: the built script, which must exist. */
  file: string;
}

/** Where the widget's built script is when the app depends on @dialogwright/widget and it has been built. */
export const DEFAULT_WIDGET_FILE = 'node_modules/@dialogwright/widget/dist/dialogwright-widget.js';

export type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

/** A non-negative integer variable, or `fallback` when it is unset or empty. Launchers read their own with it. */
export function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

/** An IANA zone name the runtime actually knows; `Intl` is the only authority worth asking. */
function timeZone(env: Env): string {
  const raw = env.TIMEZONE?.trim() || defaultTimeZone();
  try {
    localDateIso(0, raw);
  } catch {
    throw new Error(`TIMEZONE must be an IANA zone like America/Los_Angeles, got "${raw}"`);
  }
  return raw;
}

/** VOICE_PROVIDERS as ids, trimmed, lower-cased and without repeats; default Twilio alone. */
function voiceProvidersOf(env: Env): string[] {
  const ids = (env.VOICE_PROVIDERS ?? 'twilio').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  if (ids.length === 0) throw new Error('VOICE_PROVIDERS must name at least one provider');
  for (const id of ids) {
    if (!KNOWN_VOICE_PROVIDERS.includes(id)) throw new Error(`VOICE_PROVIDERS must name providers from ${KNOWN_VOICE_PROVIDERS.join(', ')}, got "${id}"`);
  }
  return [...new Set(ids)];
}

/** Each enabled provider's secret; a missing one is named with the provider that needs it. */
function providerSecretsOf(env: Env, ids: readonly string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const id of ids) {
    const name = secretVarOf(id);
    const value = env[name]?.trim();
    if (!value) throw new Error(`missing required environment variable ${name} (VOICE_PROVIDERS includes ${id})`);
    checkSecretOf(id, value);
    secrets[id] = value;
  }
  return secrets;
}

export function loadConfig(env: Env): ServerConfig {
  const publicHost = required(env, 'PUBLIC_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (/[/?:]/.test(publicHost)) throw new Error(`PUBLIC_HOST must be a bare hostname, got "${publicHost}"`);
  const voiceProviders = voiceProvidersOf(env);
  const providerSecrets = providerSecretsOf(env, voiceProviders);
  const handoffNumber = required(env, 'HANDOFF_NUMBER');
  if (!/^\+\d{8,15}$/.test(handoffNumber)) throw new Error(`HANDOFF_NUMBER must be an E.164 number like +15551234567, got "${handoffNumber}"`);
  const port = integer(env, 'PORT', 3000);
  if (port < 0 || port > 65535) throw new Error(`PORT must be between 0 and 65535, got "${env.PORT}"`);
  const jevClientRaw = env.JEV_CLIENT ?? 'stub';
  if (jevClientRaw !== 'stub' && jevClientRaw !== 'heuristic' && jevClientRaw !== 'jev') {
    throw new Error(`JEV_CLIENT must be stub, heuristic, or jev, got "${jevClientRaw}"`);
  }
  const jevProvider = jevClientRaw === 'jev' ? resolveJevProvider(env) : null;
  const todayOverride = env.TODAY_OVERRIDE?.trim() || null;
  if (todayOverride && !/^\d{4}-\d{2}-\d{2}$/.test(todayOverride)) throw new Error(`TODAY_OVERRIDE must be YYYY-MM-DD, got "${todayOverride}"`);
  const sig = (env.SIGNATURE_CHECK ?? 'on').toLowerCase();
  if (sig !== 'on' && sig !== 'off') throw new Error(`SIGNATURE_CHECK must be on or off, got "${env.SIGNATURE_CHECK}"`);
  const dash = (env.DASHBOARD ?? 'on').toLowerCase();
  if (dash !== 'on' && dash !== 'off') throw new Error(`DASHBOARD must be on or off, got "${env.DASHBOARD}"`);
  const clipsSwitch = (env.CLIPS ?? 'off').toLowerCase();
  if (clipsSwitch !== 'on' && clipsSwitch !== 'off') throw new Error(`CLIPS must be on or off, got "${env.CLIPS}"`);
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const handoffSummarySwitch = (env.HANDOFF_SUMMARY ?? 'on').toLowerCase();
  if (handoffSummarySwitch !== 'on' && handoffSummarySwitch !== 'off') {
    throw new Error(`HANDOFF_SUMMARY must be on or off, got "${env.HANDOFF_SUMMARY}"`);
  }
  const localOnlySwitch = (env.CONSOLE_LOCAL_ONLY ?? 'on').toLowerCase();
  if (localOnlySwitch !== 'on' && localOnlySwitch !== 'off') throw new Error(`CONSOLE_LOCAL_ONLY must be on or off, got "${env.CONSOLE_LOCAL_ONLY}"`);
  const ttsProvider = env.TTS_PROVIDER?.trim() || null;
  const ttsVoice = env.TTS_VOICE?.trim() || null;
  if (ttsProvider && !(TTS_PROVIDERS as readonly string[]).includes(ttsProvider)) {
    throw new Error(`TTS_PROVIDER must be one of ${TTS_PROVIDERS.join(', ')}, got "${ttsProvider}"`);
  }
  // Twilio itself allows a provider with the connection's default voice, but we require both:
  // the fallback voice for unrecorded segments should be a deliberate match to the recorded
  // clips, not whatever ConversationRelay defaults to.
  if ((ttsProvider === null) !== (ttsVoice === null)) throw new Error('TTS_PROVIDER and TTS_VOICE must be set together');
  const telnyxVoice = env.TELNYX_VOICE?.trim() || null;
  // A Telnyx voice is its engine, a dot, then the voice (Telnyx.Ultra.Callie, AWS.Polly.Joanna-Neural,
  // Azure.en-US-AvaMultilingualNeural). A Twilio voice name here (en-US-Neural2-F) is the likely mistake.
  if (telnyxVoice && !/^[A-Za-z]+(\.[A-Za-z0-9_-]+)+$/.test(telnyxVoice)) {
    throw new Error(`TELNYX_VOICE must be a Telnyx voice name like Telnyx.Ultra.Callie, got "${telnyxVoice}"`);
  }
  const twilioTranscriptionProvider = recognizerName(env, 'TWILIO_TRANSCRIPTION_PROVIDER', 'Deepgram') ?? 'Deepgram';
  // flux is Deepgram's: another provider without a model of its own gets that provider's default.
  const twilioSpeechModel = recognizerName(env, 'TWILIO_SPEECH_MODEL', 'nova-3-general') ?? (twilioTranscriptionProvider === 'Deepgram' ? 'flux' : null);
  const telnyxTranscriptionProvider = recognizerName(env, 'TELNYX_TRANSCRIPTION_PROVIDER', 'deepgram');
  const telnyxEventsRaw = env.TELNYX_EVENTS?.trim() ?? '';
  const telnyxEventTokens = telnyxEventsRaw.split(/\s+/).filter(Boolean);
  for (const t of telnyxEventTokens) {
    if (!['speaker-events', 'tokens-played'].includes(t.toLowerCase())) throw new Error(`TELNYX_EVENTS must name event streams from speaker-events, tokens-played, got "${t}"`);
  }
  const telnyxEvents = telnyxEventTokens.length > 0 ? telnyxEventTokens.join(' ') : null;
  const chat = chatOf(env, publicHost);
  const widget = widgetOf(env);
  const consoleAuth = consoleAuthOf(env, dash === 'on');
  return {
    port,
    publicHost,
    twilioAuthToken: providerSecrets.twilio ?? '',
    voiceProviders,
    providerSecrets,
    handoffNumber,
    jevClient: jevClientRaw,
    jevProvider,
    todayOverride,
    traceDir: env.TRACE_DIR?.trim() || 'traces',
    auditDir: env.AUDIT_DIR?.trim() || 'audit',
    signatureCheck: sig === 'on',
    reconnectLimit: integer(env, 'RECONNECT_LIMIT', 2),
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 1_800_000),
    sessionMaxAgeMs: integer(env, 'SESSION_MAX_AGE_MS', 7_200_000),
    timezone: timeZone(env),
    audioDir: env.AUDIO_DIR?.trim() || 'assets/audio',
    ttsProvider,
    ttsVoice,
    telnyxVoice,
    twilioTranscriptionProvider,
    twilioSpeechModel,
    telnyxTranscriptionProvider,
    telnyxEvents,
    ...resayOf(env),
    bargeIn: bargeInOf(env, voiceProviders),
    ...endAfterPlaybackOf(env),
    noInputMs: integer(env, 'NO_INPUT_MS', 7_000),
    noInputAfterSpeechMs: integer(env, 'NO_INPUT_AFTER_SPEECH_MS', DEFAULT_NO_INPUT_AFTER_SPEECH_MS),
    ...resumeOf(env),
    ...spuriousOf(env),
    ...incompleteWaitOf(env),
    jevTimeoutMs: jevTimeout(env),
    screen: parseScreenMode(env.SCREEN_MODE, 'SCREEN_MODE'),
    dashboard: dash === 'on',
    clips: clipsSwitch === 'on',
    anthropicApiKey,
    handoffSummary: handoffSummarySwitch === 'on',
    consoleLocalOnly: localOnlySwitch === 'on',
    drainMs: integer(env, 'DRAIN_MS', DEFAULT_DRAIN_MS),
    ...retentionOf(env, 'TRACE_RETENTION_DAYS', 'traceRetentionDays'),
    ...retentionOf(env, 'AUDIT_RETENTION_DAYS', 'auditRetentionDays'),
    ...sessionStoreOf(env),
    ...(chat ? { chat } : {}),
    ...(widget ? { widget } : {}),
    ...(consoleAuth ? { consoleAuth } : {}),
  };
}

/** SESSION_STORE as `{ sessionStore }`, or nothing for memory (unset, or `memory`). */
function sessionStoreOf(env: Env): { sessionStore?: SessionStoreSetting } {
  // Checked whatever the store, so a typo is found before the file store is switched on.
  const fsync = (env.SESSION_FSYNC?.trim() || 'off').toLowerCase();
  if (fsync !== 'on' && fsync !== 'off') throw new Error(`SESSION_FSYNC must be on or off, got "${env.SESSION_FSYNC}"`);
  const restartPauseS = integer(env, 'RESTART_PAUSE_S', DEFAULT_RESTART_PAUSE_S);
  if (restartPauseS > MAX_RESTART_PAUSE_S) {
    throw new Error(`RESTART_PAUSE_S must be a whole number of seconds from 0 to ${MAX_RESTART_PAUSE_S}, got "${env.RESTART_PAUSE_S}"`);
  }
  const raw = env.SESSION_STORE?.trim() ?? '';
  if (raw === '' || raw.toLowerCase() === 'memory') return {};
  const dir = raw.startsWith('file:') ? raw.slice('file:'.length).trim() : '';
  if (dir === '') throw new Error(`SESSION_STORE must be memory or file:<dir>, got "${env.SESSION_STORE}"`);
  return { sessionStore: { kind: 'file', dir, fsync: fsync === 'on', restartPauseS } };
}

/** The file store's two settings, as the startup line says them. */
function describeSessionStore(s: SessionStoreSetting): string {
  const pause = s.restartPauseS > 0 ? `restart pause ${s.restartPauseS} s` : 'restart pause off';
  return s.fsync ? `${pause}, fsync on` : pause;
}

/** A retention in days, as `{ [key]: days }`, or nothing when the variable is unset. */
function retentionOf<K extends 'traceRetentionDays' | 'auditRetentionDays'>(env: Env, name: string, key: K): { [k in K]?: number } {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return {};
  const days = integer(env, name, 0);
  if (days <= 0) throw new Error(`${name} must be a positive whole number of days, got "${env[name]}"`);
  return { [key]: days } as { [k in K]?: number };
}

/** WIDGET and, when it is on, WIDGET_FILE; undefined when it is off (WIDGET_FILE is then not read). */
function widgetOf(env: Env): WidgetSettings | undefined {
  const sw = (env.WIDGET ?? 'off').trim().toLowerCase();
  if (sw !== 'on' && sw !== 'off') throw new Error(`WIDGET must be on or off, got "${env.WIDGET}"`);
  if (sw === 'off') return undefined;
  const file = resolve(env.WIDGET_FILE?.trim() || DEFAULT_WIDGET_FILE);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new Error(`WIDGET_FILE does not exist: ${file} (build it with pnpm --filter @dialogwright/widget build)`);
  return { file };
}

/** CHAT and, when it is on, the chat's own variables; undefined when it is off (the others are then not read). */
function chatOf(env: Env, publicHost: string): ChatSettings | undefined {
  const sw = (env.CHAT ?? 'off').trim().toLowerCase();
  if (sw !== 'on' && sw !== 'off') throw new Error(`CHAT must be on or off, got "${env.CHAT}"`);
  if (sw === 'off') return undefined;
  const origins = env.CHAT_ALLOWED_ORIGINS?.trim();
  if (!origins) throw new Error('missing required environment variable CHAT_ALLOWED_ORIGINS (CHAT=on)');
  const idleMs = integer(env, 'CHAT_IDLE_MS', DEFAULT_CHAT_IDLE_MS);
  if (idleMs <= 0) throw new Error(`CHAT_IDLE_MS must be a positive number of milliseconds, got "${env.CHAT_IDLE_MS}"`);
  const maxSessions = integer(env, 'CHAT_MAX_SESSIONS', DEFAULT_CHAT_MAX_SESSIONS);
  if (maxSessions <= 0) throw new Error(`CHAT_MAX_SESSIONS must be a positive integer, got "${env.CHAT_MAX_SESSIONS}"`);
  return { origins: parseAllowedOrigins(origins, publicHost), idleMs, maxSessions, signIn: chatSignInOf(env, publicHost) };
}

function chatSignInOf(env: Env, publicHost: string): ChatSignInSettings {
  const method = (env.CHAT_SIGNIN?.trim() || 'none').toLowerCase();
  if (!(CHAT_SIGNIN_METHODS as readonly string[]).includes(method)) throw new Error(`CHAT_SIGNIN must be one of ${CHAT_SIGNIN_METHODS.join(', ')}, got "${env.CHAT_SIGNIN}"`);
  if (method === 'none') return { method: 'none' };
  if (method === 'mock') {
    // Anyone could sign in as anyone with a mock token: never on a host the internet reaches.
    if (publicHost !== 'localhost') throw new Error('CHAT_SIGNIN=mock is for a laptop: PUBLIC_HOST must be localhost');
    return { method: 'mock' };
  }
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name} (CHAT_SIGNIN=jwt)`);
    return v;
  };
  const jwksUrl = need('CHAT_JWKS_URL');
  checkJwksUrl(jwksUrl);
  return { method: 'jwt', jwksUrl, issuer: need('CHAT_ISSUER'), audience: need('CHAT_AUDIENCE') };
}

function describeChatSignIn(s: ChatSignInSettings): string {
  return s.method === 'jwt' ? `chat sign-in jwt (${s.issuer})` : s.method === 'mock' ? 'chat sign-in MOCK (laptop only)' : 'chat sign-in none';
}

/** A recognizer's provider or model name from `name`, or null when it is unset or empty; anything but a plain name is refused. */
function recognizerName(env: Env, name: string, example: string): string | null {
  const v = env[name]?.trim() || null;
  if (v !== null && !RECOGNIZER_NAME.test(v)) throw new Error(`${name} must be a name of letters, digits, dots, hyphens and underscores, like ${example}, got "${v}"`);
  return v;
}

function jevTimeout(env: Env): number {
  const ms = integer(env, 'JEV_TIMEOUT_MS', DEFAULT_THRESHOLDS.JEV_TIMEOUT_MS);
  if (ms <= 0) throw new Error(`JEV_TIMEOUT_MS must be a positive number of milliseconds, got "${env.JEV_TIMEOUT_MS}"`);
  return ms;
}

/**
 * The deployment's voice on one carrier, for its start document: Twilio's from TTS_PROVIDER and
 * TTS_VOICE, Telnyx's from TELNYX_VOICE, and nothing from one carrier's settings ever reaches another.
 * Empty for a carrier with no voice set, which then speaks with its own default.
 * Part B's per-locale voices per carrier in app.yaml (voice.locales.<tag>.voices.<provider>) win over these.
 */
export function voiceFor(c: ServerConfig, providerId: string): { ttsProvider?: string; voice?: string } {
  if (providerId === 'twilio') return c.ttsProvider && c.ttsVoice ? { ttsProvider: c.ttsProvider, voice: c.ttsVoice } : {};
  if (providerId === 'telnyx') return c.telnyxVoice ? { voice: c.telnyxVoice } : {};
  return {};
}

/**
 * The deployment's recognizer on one carrier: Twilio's from TWILIO_TRANSCRIPTION_PROVIDER and
 * TWILIO_SPEECH_MODEL (Deepgram flux unless set), Telnyx's from TELNYX_TRANSCRIPTION_PROVIDER (empty
 * unless set: Telnyx's own default). Like voiceFor, one carrier's never reaches another. It is the
 * default locale's; an app's voice.locales.<tag>.recognition.<provider> wins over it, and another
 * locale does not get it (server/http.ts connectOptions).
 */
export function recognitionFor(c: ServerConfig, providerId: string): Recognition {
  if (providerId === 'twilio') return c.twilioSpeechModel === null ? { provider: c.twilioTranscriptionProvider } : { provider: c.twilioTranscriptionProvider, model: c.twilioSpeechModel };
  if (providerId === 'telnyx') return c.telnyxTranscriptionProvider === null ? {} : { provider: c.telnyxTranscriptionProvider };
  return {};
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}` : items.join('');
}

/**
 * The startup line that says where the console, and the app's local-only pages, can be reached
 * from. `paths` are the ones CONSOLE_LOCAL_ONLY guards (localOnly.ts localOnlyPaths).
 */
export function consoleExposure(c: ServerConfig, paths: readonly string[] = ['/dashboard']): string {
  const laptop = isLoopbackHost(c.publicHost);
  if (c.consoleAuth) {
    // The console signs in; an app's local-only pages keep CONSOLE_LOCAL_ONLY's rule.
    const own = paths.filter((p) => p !== '/dashboard');
    const pages = own.length === 0 ? '' : c.consoleLocalOnly ? `; ${listed(own)} local only, 404 through ${laptop ? 'any tunnel' : 'the tunnel'}` : `; ${listed(own)} PUBLIC (CONSOLE_LOCAL_ONLY=off)`;
    return `console: /dashboard behind sign-in on ${publicBase(c, c.port)}/dashboard (CONSOLE_AUTH=token); pnpm console:link prints a sign-in link${pages}`;
  }
  if (c.consoleLocalOnly) {
    return `console: ${listed(paths)} local only (${localBase(c.port)}); 404 through ${laptop ? 'any tunnel' : `the tunnel on ${c.publicHost}`}`;
  }
  return laptop
    ? `console: ${listed(paths)} on ${localBase(c.port)}, and PUBLIC through any tunnel to it (CONSOLE_LOCAL_ONLY=off)`
    : `console: ${listed(paths)} PUBLIC on https://${c.publicHost} (CONSOLE_LOCAL_ONLY=off)`;
}

/** Where a person on this machine opens the server's pages. */
export function localBase(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Where the server's public paths are reached: https://PUBLIC_HOST, or, on a laptop whose PUBLIC_HOST
 * is a name for this machine (localhost), this machine's own address, since nothing public points at it.
 */
export function publicBase(c: Pick<ServerConfig, 'publicHost'>, port: number): string {
  return isLoopbackHost(c.publicHost) ? localBase(port) : `https://${c.publicHost}`;
}

/**
 * RESAY_CUT_LINES as the startup line says it, on a deployment with a carrier that reports its playback.
 * Telnyx reports it only when TELNYX_EVENTS asks for its events, so the line says when it is inactive.
 */
function describeResay(c: ServerConfig): string {
  if (c.resayCutLines === false) return 'cut lines not said again';
  const inactive = c.voiceProviders.includes('telnyx') && !c.telnyxEvents ? '; inactive without TELNYX_EVENTS' : '';
  return `cut lines said again (under ${c.resayMinFraction ?? DEFAULT_RESAY_MIN_FRACTION} of the estimate${inactive})`;
}

/** On Telnyx without speaker-events, the startup line says a setting that needs them is inactive. */
function inactiveWithoutVoice(c: ServerConfig): string {
  return reportsCallerVoice(c) ? '' : '; inactive without TELNYX_EVENTS speaker-events';
}

/** RESAY_SPURIOUS_INTERRUPTS as the startup line says it, on a deployment with a carrier that reports its events. */
function describeSpurious(c: ServerConfig): string {
  if (c.resaySpuriousInterrupts === false) return 'spurious interrupts not said again';
  return `spurious interrupts said again (no caller heard within ${c.spuriousInterruptWindowMs ?? DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS} ms${inactiveWithoutVoice(c)})`;
}

/** INCOMPLETE_WAIT_MS and INCOMPLETE_WAIT_BELOW as the startup line says them. */
function describeIncompleteWait(c: ServerConfig): string {
  const waitMs = c.incompleteWaitMs ?? DEFAULT_INCOMPLETE_WAIT_MS;
  if (waitMs === 0) return 'replies never held';
  const below = c.incompleteWaitBelow ?? 'GATE_COMPLETE';
  return `replies held up to ${waitMs} ms for an unfinished caller (under ${below}${inactiveWithoutVoice(c)})`;
}

/** END_AFTER_PLAYBACK as the startup line says it: which of the carriers listed have their `end` held. */
function describeEndAfterPlayback(c: ServerConfig): string {
  const mode = c.endAfterPlayback ?? 'auto';
  if (mode === 'off') return 'end after playback off';
  const upTo = `up to ${c.endPlaybackMaxMs ?? DEFAULT_END_PLAYBACK_MAX_MS} ms`;
  if (mode === 'on') return `end after playback on (every carrier), ${upTo}`;
  const held = c.voiceProviders.filter(endDropsSpeechOf);
  return held.length === 0 ? 'end after playback auto (no carrier listed needs it)' : `end after playback auto (${held.join(', ')}), ${upTo}`;
}

export function describeConfig(c: ServerConfig): string {
  // A prefix of a secret is still a piece of the secret; the length alone is enough to tell
  // "the variable is set" from "the variable is the wrong value".
  const mask = (s: string | null) => (s ? `set (${s.length} chars)` : 'unset');
  return [
    `port ${c.port}`,
    `public host ${c.publicHost}`,
    `handoff ${c.handoffNumber}`,
    `client ${c.jevClient}`,
    `api key ${mask(c.jevProvider?.apiKey ?? null)}`,
    `voice providers ${c.voiceProviders.join(', ')}`,
    ...c.voiceProviders.map((id) => `${secretLabelOf(id)} ${mask(c.providerSecrets[id] ?? null)}`),
    `signature check ${c.signatureCheck ? 'on' : 'OFF'}`,
    `today ${c.todayOverride ?? 'wall clock'}`,
    `timezone ${c.timezone}`,
    `traces ${c.traceDir}`,
    `audit ${c.auditDir}`,
    `reconnect limit ${c.reconnectLimit}`,
    `audio dir ${c.audioDir}`,
    c.noInputMs > 0 ? `no-input ${c.noInputMs} ms` : 'no-input off',
    // Held while the caller is heard speaking only on a carrier that reports it (VoiceProvider.readEvent).
    ...(c.noInputMs > 0 && c.voiceProviders.some(readsPlaybackEvents)
      ? [`no-input after speech ${c.noInputAfterSpeechMs ?? DEFAULT_NO_INPUT_AFTER_SPEECH_MS} ms`]
      : []),
    // A caller coming back in is heard only on a carrier that reports their voice (server/adapter.ts).
    ...(c.voiceProviders.some(readsPlaybackEvents)
      ? [`caller resumes within ${c.resumeAfterPauseMs ?? DEFAULT_RESUME_AFTER_PAUSE_MS} ms of a pause, ${c.resumeIntoReplyMs ?? DEFAULT_RESUME_INTO_REPLY_MS} ms into the reply`]
      : []),
    `jev timeout ${c.jevTimeoutMs} ms`,
    `screen ${c.screen}`,
    `barge-in ${c.bargeIn ?? 'any'}`,
    describeEndAfterPlayback(c),
    `dashboard ${c.dashboard ? 'on' : 'OFF'}`,
    c.consoleAuth ? describeConsoleAuth(c.consoleAuth) : `console ${c.consoleLocalOnly ? 'local only' : 'PUBLIC'}`,
    `drain ${c.drainMs ?? DEFAULT_DRAIN_MS} ms`,
    `traces kept ${c.traceRetentionDays === undefined ? 'forever' : `${c.traceRetentionDays} days`}`,
    `audit kept ${c.auditRetentionDays === undefined ? 'forever' : `${c.auditRetentionDays} days`}`,
    ...(c.sessionStore ? [`sessions file:${c.sessionStore.dir} (${describeSessionStore(c.sessionStore)})`] : []),
    `clips ${c.clips ? 'on' : 'OFF (all TTS)'}`,
    `anthropic key ${mask(c.anthropicApiKey)}`,
    c.handoffSummary ? `handoff note on${c.anthropicApiKey ? '' : ' (no key: none generated)'}` : 'handoff note OFF',
    c.ttsProvider && c.ttsVoice ? `tts ${c.ttsProvider} ${c.ttsVoice}` : 'tts default',
    ...(c.voiceProviders.includes('telnyx') ? [`telnyx voice ${c.telnyxVoice ?? 'default'}`] : []),
    ...(c.voiceProviders.includes('twilio') ? [`twilio recognition ${c.twilioTranscriptionProvider} ${c.twilioSpeechModel ?? '(its default model)'}`] : []),
    ...(c.voiceProviders.includes('telnyx') ? [`telnyx recognition ${c.telnyxTranscriptionProvider ?? 'default'}`] : []),
    ...(c.voiceProviders.includes('telnyx') && c.telnyxEvents ? [`telnyx events ${c.telnyxEvents}`] : []),
    ...(c.voiceProviders.some(readsPlaybackEvents) ? [describeResay(c), describeSpurious(c), describeIncompleteWait(c)] : []),
    ...(c.chat ? [`chat on (${describeOrigins(c.chat.origins)}) up to ${c.chat.maxSessions} sessions`, describeChatSignIn(c.chat.signIn)] : []),
    ...(c.widget ? [`widget on (${c.widget.file})`] : []),
  ].join('  ');
}

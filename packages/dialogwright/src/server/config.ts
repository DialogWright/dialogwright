import { defaultTimeZone, localDateIso } from '../run/clock';
import { resolveJevProvider, type JevProvider } from '../jev/provider';

import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { parseScreenMode, type ScreenMode } from '../core/screen';
import { checkSecretOf, KNOWN_VOICE_PROVIDERS, secretLabelOf, secretVarOf } from './voice/registry';
import { RECOGNIZER_NAME, TWILIO_TTS_PROVIDERS as TTS_PROVIDERS } from '../channel/voiceProviders';
import type { Recognition } from '../core/app/types';
import { describeOrigins, parseAllowedOrigins, type AllowedOrigins } from './chat/origins';
import { checkJwksUrl } from './chat/jwks';
import { isLoopbackHost } from './localOnly';
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
  /** Silence after a prompt's estimated playback before the caller is asked again; 0 disables. */
  noInputMs: number;
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
}

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
  const chat = chatOf(env, publicHost);
  const widget = widgetOf(env);
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
    noInputMs: integer(env, 'NO_INPUT_MS', 7_000),
    jevTimeoutMs: jevTimeout(env),
    screen: parseScreenMode(env.SCREEN_MODE, 'SCREEN_MODE'),
    dashboard: dash === 'on',
    clips: clipsSwitch === 'on',
    anthropicApiKey,
    handoffSummary: handoffSummarySwitch === 'on',
    consoleLocalOnly: localOnlySwitch === 'on',
    ...(chat ? { chat } : {}),
    ...(widget ? { widget } : {}),
  };
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
    `jev timeout ${c.jevTimeoutMs} ms`,
    `screen ${c.screen}`,
    `dashboard ${c.dashboard ? 'on' : 'OFF'}`,
    `console ${c.consoleLocalOnly ? 'local only' : 'PUBLIC'}`,
    `clips ${c.clips ? 'on' : 'OFF (all TTS)'}`,
    `anthropic key ${mask(c.anthropicApiKey)}`,
    c.handoffSummary ? `handoff note on${c.anthropicApiKey ? '' : ' (no key: none generated)'}` : 'handoff note OFF',
    c.ttsProvider && c.ttsVoice ? `tts ${c.ttsProvider} ${c.ttsVoice}` : 'tts default',
    ...(c.voiceProviders.includes('telnyx') ? [`telnyx voice ${c.telnyxVoice ?? 'default'}`] : []),
    ...(c.voiceProviders.includes('twilio') ? [`twilio recognition ${c.twilioTranscriptionProvider} ${c.twilioSpeechModel ?? '(its default model)'}`] : []),
    ...(c.voiceProviders.includes('telnyx') ? [`telnyx recognition ${c.telnyxTranscriptionProvider ?? 'default'}`] : []),
    ...(c.chat ? [`chat on (${describeOrigins(c.chat.origins)}) up to ${c.chat.maxSessions} sessions`, describeChatSignIn(c.chat.signIn)] : []),
    ...(c.widget ? [`widget on (${c.widget.file})`] : []),
  ].join('  ');
}

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recognitionFor, voiceFor, type ServerConfig } from './config';
import { connectRelayTwiml } from './twiml';
import type { SessionStore } from './sessions';
import type { ServerTokenStore } from './stores/types';
import { within } from './stores/sql';
import type { DashboardBus } from './dashboard/bus';
import { handleDashboardRequest, type DashboardDeps } from './dashboard/routes';
import { type AuditCheck, type DayCounters, type HealthNumbers, type HealthSource, type ServerSeen } from './dashboard/health';
import { AUDIO_TYPES, CLIP_FILE } from '../prompts/clips';
import { maskNumber, redactDeep } from './dashboard/events';
import { maskCopiesOf, withoutCopiesOf } from '../channel/maskByName';
import { HOST_APP_PARAMETER, recordedWebhookFields, webhookParameters, webhookParametersOfKept, WITHHELD_PARAMETER } from '../channel/callData';
import { whenChained, type AuditSink } from '../run/turn';
import type { S3TraceReader } from '../trace/store';
import { routeOwns, validateRoutes, type AppRoute } from './appRoutes';
import { CONSOLE_PATHS, isConsolePath, isDirectLocalRequest, localOnlyPaths } from './localOnly';
import { ConsoleAuth } from './console/auth';
import type { CallbackParams, DialTarget, RelayLanguage, StartDocumentOptions, VoiceProvider, WebhookRequest } from './voice/provider';
import { defaultTarget, describeDropped, dialPlan, parseHandoff, recordedPlan, type PostedHandoff, type ServerTransfer } from './transfer';
import { providerForPath, voiceProviders } from './voice/registry';
import { twilioCallbackParams, twilioProvider } from './voice/twilio';
import { formFields } from './voice/xml';
import type { App } from '../core/app/types';
import type { VoiceProviderId } from '../channel/voiceProviders';
import { buildHintsFrom } from './hints';
import { DEFAULT_LOCALE, localesOf, speechLanguagesOf } from '../core/locale';

/**
 * One app's part of the webhooks: the app, its hints, its start parameters, its transfer targets and its
 * audit chain. HttpDeps is the one app's of a server of one; on a server of several (server/host.ts)
 * each app has its own (HttpHost).
 */
export interface HttpApp {
  readonly app?: App;
  readonly hints: string;
  readonly startParameters?: Readonly<Record<string, string>>;
  readonly transfer?: ServerTransfer | null;
  readonly audit?: AuditSink;
  /** Where a call put through with no transfer target goes: on a host, the app's HANDOFF_NUMBER; absent, the server's (config). */
  readonly handoffNumber?: string;
}

/**
 * Several apps on one server (host.yaml, server/host.ts): the app the number called reaches (the
 * default for a number listed nowhere, or none), and each app's part of the webhooks by its id.
 */
export interface HttpHost {
  appFor(called: string | null | undefined): string;
  served(id: string): HttpApp | undefined;
}

export interface HttpDeps extends HttpApp {
  config: ServerConfig;
  store: SessionStore;
  tokens: ServerTokenStore;
  hints: string;
  log: (line: string) => void;
  /** The dashboard's event bus, absent when DASHBOARD=off; without it the routes 404 like any other path. */
  bus?: DashboardBus;
  /**
   * The server's audit chain. A hangup is the one end of a call no turn sees, so the action webhook
   * appends its `call_ended` here; absent, a hangup goes unaudited (tests that do not care).
   */
  audit?: AuditSink;
  /** The app's own pages (its chats, say), each asked in turn before the webhooks; without them, none. */
  routes?: readonly AppRoute[];
  /**
   * The app the server runs, for the languages its calls are in (connectOptions): the locale a number
   * starts in, and each locale's languages and voices. Without it, a start document names no language.
   */
  app?: App;
  /**
   * Whether the server is draining (index.ts RunningServer.drain): `/ready` answers 503 and a new call
   * goes to the handoff number. Absent, never: the server is ready whenever it answers.
   */
  draining?: () => boolean;
  /** Whether the server is stopping but not yet draining (DRAIN_UNREADY_MS): /ready says 503, and new calls are still answered. */
  unready?: () => boolean;
  /**
   * Whether the drain's wait is over and the server is about to close (index.ts): a live call's reconnect
   * is put through to the handoff number rather than back to a server that will not be there (with the
   * memory store; with a durable one, see `handover`). Absent, never.
   */
  closing?: () => boolean;
  /**
   * A planned restart's handover (index.ts drain, SESSION_STORE=file with RESTART_PAUSE_S above 0), or
   * null when there is none: a saved call's reconnect, while the server is closing, is answered with a
   * document that pauses `pauseS` seconds before it connects, so the carrier's socket reaches the
   * restarted server; `answered` is told of each callback, so the drain knows when every call has been
   * handed over. Absent, never.
   */
  handover?: () => { readonly pauseS: number; answered(callId: string): void } | null;
  /**
   * The custom parameters every start document carries (app.yaml's `startParameters`, read from the
   * environment as the server starts: config.ts startParametersFrom). Absent or empty, none, as before.
   */
  startParameters?: Readonly<Record<string, string>>;
  /**
   * The app's transfer targets as the server read them (server/transfer.ts transferTargetsFrom): a posted
   * handoff dials the target it names, and a call put through with no decision the default. Absent or
   * null, every call goes to HANDOFF_NUMBER, as before.
   */
  transfer?: ServerTransfer | null;
  /** Live web chats, for `/health`'s `chat`; absent when the engine's chat is off, and `/health` then has no `chat`. */
  chatLive?: () => number;
  /**
   * Several apps on one server (host.yaml): a new call's app is the one its number reaches, and every
   * webhook for a call answers in its app's part. Absent, the server runs one app: this one's fields.
   */
  host?: HttpHost;
  /** On a host, each app with its traces, for the console's app on each row and its filter (dashboard/routes.ts DashboardDeps.apps). */
  consoleApps?: DashboardDeps['apps'];
  /** The trace and audit folders' sizes, for `/health`'s `disk`; absent when no retention is set, and `/health` then has no `disk`. */
  disk?: () => { traceBytes: number; auditBytes: number };
  /** TRACE_STORE=s3://...: the one reader of the traces on the store, for the console. Absent, the console reads TRACE_DIR. */
  traces?: S3TraceReader;
  /** TRACE_STORE=s3://...: the segment writes that failed and the lines dropped, for `/health`'s `traces`; absent, `/health` has none. */
  traceHealth?: () => { failures: number; dropped: number } | null;
  /**
   * The console's Health page (dashboard/health.ts): this server's name, its reconnects and fallback dials
   * today (counted here, as each callback is answered), the other servers heard from with a shared store,
   * and the audit verified on demand. Absent, the page has `/health`'s numbers alone, and nothing is counted.
   */
  serverHealth?: ServerHealth;
  /** On a server of one app, the app's folder when the server runs in it, for the console's Knowledge page (its kb/pending drafts). */
  appDir?: string;
  /**
   * The console's sign-in, for CONSOLE_AUTH=token (index.ts makes it, and its first link once the server
   * listens). Read only when config.consoleAuth is set; absent then, one is made here, with no link until
   * something mints one. With CONSOLE_AUTH=local it is never used.
   */
  consoleAuth?: ConsoleAuth;
}

/** What the server gives the console's Health page beside `/health`'s numbers (index.ts makes it). */
export interface ServerHealth {
  /** This server's name (SERVER_ID with its suffix, or `server-<random>`). */
  name: string;
  counters: DayCounters;
  /** With a shared store: the other servers heard from in the last minutes. */
  peers?: () => ServerSeen[];
  verify?: () => Promise<AuditCheck>;
  auditLabel?: string;
}

const MAX_BODY = 64 * 1024;

/**
 * Reads the request body, capped at MAX_BODY. If the body is too large, the 413 response is
 * written directly here (before the socket is torn down) and the promise resolves to null so
 * the caller stops without falling through to the generic error handler.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reply(res, 413, 'text/plain', 'body too large');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

/** Node's headers as a webhook's: names lower-cased, a repeated header's first value. */
function lowerHeaders(h: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** A JSON body, or for HEAD its headers alone. */
function answerJson(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  if (req.method === 'HEAD') {
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end();
  } else {
    reply(res, status, 'application/json', body);
  }
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Decodes a raw `/audio/<raw>` path segment and checks it against the same filename shape
 * `discoverClips` accepts: an id made of `[A-Za-z0-9_.-]`, a dot, and a wav/mp3 extension.
 * That shape has no room for a `/` (or, once decoded, a bare `..`), so it alone rules out path
 * traversal — no separate `..` check is needed, and `discoverClips` itself has none either;
 * the two are meant to accept exactly the same names. Returns the decoded name, or null if the
 * segment fails to decode or doesn't match.
 */
export function clipName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return CLIP_FILE.test(name) ? name : null;
}

/**
 * Serves a recorded clip from `audioDir` by filename. Clips are read synchronously, one file
 * per request: there are few of them, each is small, and the response is cached for a day, so
 * this is not a hot path. If that stops being true, the next step is an in-memory Map of
 * Buffers built once at startup rather than a per-request `readFileSync`.
 * Any read failure — missing file, a directory, a dangling symlink — is a 404, never a 500.
 */
function serveClip(req: IncomingMessage, res: ServerResponse, audioDir: string, raw: string): void {
  const name = clipName(raw);
  if (!name) {
    reply(res, 404, 'text/plain', 'not found');
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(join(audioDir, name));
  } catch {
    reply(res, 404, 'text/plain', 'not found');
    return;
  }
  const ext = CLIP_FILE.exec(name)![2]!.toLowerCase();
  res.writeHead(200, {
    'content-type': AUDIO_TYPES[ext]!,
    'content-length': body.length,
    'cache-control': 'public, max-age=86400',
    'accept-ranges': 'none',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Where the server serves the web chat widget's script when WIDGET=on. */
export const WIDGET_PATH = '/widget.js';

/**
 * The widget's built script (WIDGET_FILE), read on each request so a rebuild on the laptop is served
 * without a restart, and never cached by the browser for the same reason. A file gone since the
 * server started is a 404, with the reason in the log. WIDGET=on is for a laptop or a simple
 * deployment; a production site loads the bundle from its own CDN.
 */
function serveWidget(req: IncomingMessage, res: ServerResponse, file: string, log: (line: string) => void): void {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch (e) {
    log(`widget: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    reply(res, 404, 'text/plain', 'not found');
    return;
  }
  // A public script by design (a site's pages load it, through the tunnel too), so it is sent as one:
  // its type, and nosniff so a browser never takes it for anything else.
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function isBlank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

/**
 * A call's app and its part of the webhooks: on a server of several apps, the app the call's entry is in,
 * else the one the number called reaches, with its id; on a server of one, its one app (id null).
 */
function servedOf(deps: HttpDeps, callId?: string, to?: string): { id: string | null; s: HttpApp } {
  if (!deps.host) return { id: null, s: deps };
  const held = callId ? deps.store.get(callId)?.session.appId : undefined;
  const id = held !== undefined && deps.host.served(held) !== undefined ? held : deps.host.appFor(to);
  return { id, s: deps.host.served(id) ?? deps };
}

/** The custom parameter a host's start document names its app by (HOST_APP_PARAMETER); none on a server of one app. */
function hostEcho(id: string | null): Record<string, string> {
  return id === null ? {} : { [HOST_APP_PARAMETER]: id };
}

/**
 * The custom parameter that tells the setup the caller withheld their number (WITHHELD_PARAMETER), for a
 * webhook whose carrier marked it so (CallbackParams.withheld); none otherwise, and the document is as it was.
 */
function withheldEcho(params: CallbackParams, known = false): Record<string, string> {
  return params.withheld === true || known ? { [WITHHELD_PARAMETER]: 'true' } : {};
}

/** The caller as the server's log names them: the last four of their number, or `withheld`. */
function callerForLog(params: CallbackParams): string {
  return params.withheld === true ? 'withheld' : maskNumber(params.from);
}

/** Where a call put through with no handoff decision goes: the app's transfer default, HANDOFF_NUMBER without one. */
function fallbackTarget(deps: HttpDeps, s: HttpApp = deps): DialTarget {
  return defaultTarget(s.transfer ?? null, s.handoffNumber ?? deps.config.handoffNumber);
}

/**
 * The document that puts a posted handoff through (server/transfer.ts dialPlan), and its note. For an app
 * with transfer, the frame log (written before the call's entry ends) and the note say which target, and
 * which headers went and which did not (a phone number carries none); an app without transfer's note is
 * as it was.
 */
function dialHandoff(deps: HttpDeps, provider: VoiceProvider, callSid: string, handoff: PostedHandoff, s: HttpApp = deps): { document: string; note: string } {
  const plan = dialPlan(s.transfer ?? null, s.handoffNumber ?? deps.config.handoffNumber, handoff);
  const document = provider.dialDocument(plan.target);
  if (!s.transfer) return { document, note: `dial:${handoff.reasonCode}` };
  deps.store.get(callSid)?.frames.write('log', { transfer: recordedPlan(plan) });
  // Only header names (HEADER_NAME) are written, at most DROPPED_SHOWN: a name posted back can never forge a log line.
  const left = describeDropped(plan);
  const dropped = left === '' ? '' : ` (headers left out: ${left})`;
  return { document, note: `dial:${handoff.reasonCode} to ${plan.variable}${dropped}` };
}

/**
 * Whether the app's start documents name its languages: it speaks more than one locale, says how one
 * is spoken (voice.locales) or which number starts in which (voice.numbers), or speaks a language
 * other than the relay's default. A one-locale en-US app's documents are those of an app without
 * locales, byte for byte.
 */
function namesLanguages(app: App): boolean {
  if (!app.locales) return false;
  return Object.keys(app.locales.prompts).length > 0 || app.voice?.locales !== undefined || app.voice?.numbers !== undefined || app.locales.default !== DEFAULT_LOCALE;
}

/**
 * The locales of an app that names its languages whose calls on Telnyx have no voice of their own (the
 * app's voice.locales.<tag>.voices.telnyx, or for the default locale the deployment's TELNYX_VOICE),
 * when at least one other locale has one; empty otherwise. On Telnyx the start language's voice is
 * written on the relay element too (voice/telnyx.ts startDocument: with the voices on the <Language>
 * children alone Telnyx said nothing), so after a switch such a language may keep the voice the call
 * started with, reading its language in another's voice. Not yet checked on a live call either way; the
 * server warns of it at start (index.ts), as `pnpm check` does of the app's own voices.
 */
export function telnyxUnvoicedLocales(app: App, deploymentVoice: string | null | undefined): string[] {
  if (!app.locales || !namesLanguages(app)) return [];
  const locales = localesOf(app);
  const voiced = (tag: string): boolean => {
    const own = app.voice?.locales && Object.hasOwn(app.voice.locales, tag) ? app.voice.locales[tag] : undefined;
    const named = own?.voices && Object.hasOwn(own.voices, 'telnyx') ? own.voices.telnyx : undefined;
    return named !== undefined || (tag === app.locales!.default && Boolean(deploymentVoice));
  };
  const without = locales.filter((tag) => !voiced(tag));
  return without.length === 0 || without.length === locales.length ? [] : without;
}

/** The locale a call starts in: the app's voice.numbers for the number called, else the app's default. Undefined for an app without locales. */
export function startLocale(app: App, to: string | undefined): string | undefined {
  if (!app.locales) return undefined;
  const numbers = app.voice?.numbers;
  const byNumber = to !== undefined && numbers && Object.hasOwn(numbers, to) ? numbers[to] : undefined;
  return byNumber ?? app.locales.default;
}

/**
 * The start document's options shared by the initial /voice answer and a reconnect, with the carrier's
 * own voice and recognizer. For an app that names its languages (namesLanguages), the call's language
 * (`locale`: the number's on a new call, the session's own on a reconnect) and every language it may
 * switch to, each with its own settings on this carrier:
 * - its voice: the app's (voice.locales.<tag>.voices.<provider>), else, for the default locale only,
 *   the deployment's (config.ts voiceFor), else none (the carrier's default for it); an app's Twilio
 *   voice written as { voice, provider } is spoken with its own provider, a name alone with the
 *   deployment's TTS_PROVIDER (or Twilio's default when that is unset);
 * - its recognizer: the app's (voice.locales.<tag>.recognition.<provider>), whole, a field it leaves
 *   out being the carrier's default; else, for the default locale only, the deployment's (config.ts
 *   recognitionFor); else none (the carrier's default). The deployment's stops at the default locale
 *   because it is chosen for one language (Twilio's default, Deepgram flux, is for English), and a
 *   recognizer that does not hear a language is worse than the carrier's default for it.
 * The provider writes each where no other language inherits it (voice/xml.ts placeLanguages).
 */
function connectOptions(deps: HttpDeps, provider: VoiceProvider, token: string, locale?: string, echoes: Readonly<Record<string, string>> = {}, s: HttpApp = deps): StartDocumentOptions {
  const options = languageOptions(deps, provider, token, locale, s);
  // The app's own parameters (startParameters) and the answer webhook's fields its callData names
  // (dw_<key>), after the locale: an app with neither has the document it had. On a host, the app's id.
  const extra = { ...(s.startParameters ?? {}), ...echoes };
  return Object.keys(extra).length === 0 ? options : { ...options, parameters: { ...(options.parameters ?? {}), ...extra } };
}

/** The start document's options before the app's own parameters (connectOptions). */
function languageOptions(deps: HttpDeps, provider: VoiceProvider, token: string, locale?: string, s: HttpApp = deps): StartDocumentOptions {
  const deployment = voiceFor(deps.config, provider.id);
  const deploymentRecognition = recognitionFor(deps.config, provider.id);
  const events = provider.id === 'telnyx' && deps.config.telnyxEvents ? { events: deps.config.telnyxEvents } : {};
  // The carrier's own barge-in (BARGE_IN_<CARRIER>) over the server's (BARGE_IN); with neither set, none named, as before.
  const mode = deps.config.bargeInByCarrier !== undefined && Object.hasOwn(deps.config.bargeInByCarrier, provider.id)
    ? deps.config.bargeInByCarrier[provider.id as VoiceProviderId]
    : deps.config.bargeIn;
  const bargeIn = mode ? { bargeIn: mode } : {};
  const base: StartDocumentOptions = { publicHost: deps.config.publicHost, token, hints: s.hints, ...deployment, recognition: deploymentRecognition, ...events, ...bargeIn };
  const app = s.app;
  if (!app?.locales || !namesLanguages(app) || locale === undefined) return base;
  const defaultLocale = app.locales.default;
  const language = (tag: string): RelayLanguage => {
    const own = app.voice?.locales && Object.hasOwn(app.voice.locales, tag) ? app.voice.locales[tag] : undefined;
    const appVoice = own?.voices && Object.hasOwn(own.voices, provider.id) ? own.voices[provider.id] : undefined;
    // A voice that names its TTS provider (a Twilio { voice, provider }) is spoken with it; a name alone
    // with the deployment's (TTS_PROVIDER), as it always was.
    const named = typeof appVoice === 'object' ? appVoice : undefined;
    const voice = (typeof appVoice === 'string' ? appVoice : named?.voice) ?? (tag === defaultLocale ? deployment.voice : undefined);
    const ttsProvider = named ? named.provider : deployment.ttsProvider;
    const appRecognition = own?.recognition && Object.hasOwn(own.recognition, provider.id) ? own.recognition[provider.id] : undefined;
    const recognition = appRecognition ?? (tag === defaultLocale ? deploymentRecognition : undefined);
    return {
      ...speechLanguagesOf(app, tag),
      ...(voice !== undefined ? { voice, ...(ttsProvider !== undefined ? { ttsProvider } : {}) } : {}),
      ...(recognition !== undefined && (recognition.provider !== undefined || recognition.model !== undefined) ? { recognition } : {}),
    };
  };
  const hints = app.voice?.locales && Object.hasOwn(app.voice.locales, locale) ? app.voice.locales[locale]?.hints : undefined;
  return {
    ...base,
    ...(hints ? { hints: buildHintsFrom(hints) } : {}),
    language: language(locale),
    languages: localesOf(app).map(language),
    parameters: { locale },
  };
}

/**
 * Whether the callback's call is still live: the provider's own reading (CallbackParams.live), or,
 * for params a caller built without it, Twilio's word (`in-progress`) as the engine always read it.
 * Undefined when the callback carries no status at all.
 */
function callIsLive(params: CallbackParams): boolean | undefined {
  if (params.live !== undefined) return params.live;
  return params.callStatus === undefined ? undefined : params.callStatus === 'in-progress';
}

/**
 * Whether a callback asks for the call to go on (decideAction's branch c): no handoff data, and the
 * call live in the carrier's words, or, where it says nothing of the call, the relay's session failed.
 */
function wantsReconnect(params: CallbackParams): boolean {
  if (!isBlank(params.handoffData) || params.sessionStatus === 'completed') return false;
  return callIsLive(params) ?? params.sessionStatus?.trim().toLowerCase() === 'failed';
}

/**
 * The callback's answer for a call `restore` found saved in a shape this server cannot read (another
 * SESSION_SCHEMA): a callback that would reconnect it puts the caller through to a person instead;
 * anything else is decideAction's (which, holding no such call, hangs up).
 */
function decideUnreadable(
  deps: HttpDeps,
  provider: VoiceProvider,
  params: CallbackParams,
  start?: (o: StartDocumentOptions) => string,
): ActionAnswer {
  if (!wantsReconnect(params)) return decideAction(deps, provider, params, start);
  deps.tokens.revoke(params.callId);
  return { document: provider.apologizeAndDialDocument(fallbackTarget(deps, servedOf(deps, params.callId, params.to).s)), note: 'dial:unreadable', fallback: true };
}

/**
 * A callback's answer: its document and the note the log says. `fallback` marks a call the server put
 * through to a person itself (the server closing, a store it could not read or reach, a session it
 * cannot read, a call past its reconnects), never one the dialog decided to hand off: the console's
 * Health page counts them apart.
 */
export interface ActionAnswer {
  document: string;
  note: string;
  fallback?: true;
}

/**
 * The legacy Twilio `<Connect action>` decision on Twilio's raw form fields, a reconnect answered at the
 * legacy socket path. Kept for existing callers; the webhook itself calls decideAction.
 */
export function decideActionTwiml(deps: HttpDeps, params: Record<string, string>): { twiml: string; note: string } {
  const { document, note } = decideAction(deps, twilioProvider, twilioCallbackParams(params), connectRelayTwiml);
  return { twiml: document, note };
}

/**
 * The `<Connect action>` callback decision, in the provider's documents. Pure apart from store and
 * token side effects. `start` writes a reconnect's start document: the provider's own, or the legacy
 * one for a call that came in on the unprefixed `/voice`. `held`, with a durable store, is the transfer
 * the store said the call still owes (taken from it, so one server dials it), in place of the entry's
 * own; 'unknown' when the store could not say. Absent, the entry in memory says, as it always did.
 */
export function decideAction(
  deps: HttpDeps,
  provider: VoiceProvider,
  params: CallbackParams,
  start: (o: StartDocumentOptions) => string = (o) => provider.startDocument(o),
  held?: string | null | 'unknown',
): ActionAnswer {
  const callSid = params.callId;
  // The call's app (on a host, the one its entry is in, else the one its number reaches): its transfer
  // targets, its languages and its audit chain answer for it.
  const { id: appId, s } = servedOf(deps, callSid, params.to);

  // (a) An explicit handoff decision from the adapter wins outright.
  const handoffData = params.handoffData;
  if (!isBlank(handoffData)) {
    const handoff = parseHandoff(handoffData!);
    if (handoff.reasonCode === 'completed') {
      deps.store.end(callSid);
      deps.tokens.revoke(callSid);
      return { document: provider.hangupDocument(), note: 'completed' };
    }
    // The target the engine chose (by its variable's name) and its headers, written to the frame log before the call's entry ends.
    const dialed = dialHandoff(deps, provider, callSid, handoff, s);
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    return dialed;
  }

  // (b) No handoff: an ordinary caller hangup (or any status that isn't a live call, in the
  // provider's words: CallbackParams.live) just ends the call. This must not be logged as gave-up
  // or dialed. A callback that says nothing of the call's status (callIsLive undefined) goes on to a
  // reconnect only when the relay reports its session failed, and (c) then reconnects only a call
  // the engine still holds live; anything else hangs up.
  if (!wantsReconnect(params)) {
    // Read before `end`, and published only for a call that was still live: this branch is the
    // one place that knows a socket close was a hangup rather than the reconnect branch below,
    // so it is the dashboard's only producer of `ended{hangup}`. A call that ended on its own
    // (complete or handoff) already published its own `ended` from the adapter's turn.
    const live = deps.store.get(callSid);
    const wasLive = live?.ended === false;
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    if (wasLive) {
      // The audit's record of the end, as a turn that ends the call appends its own (core/audit.ts).
      // This is the one end no turn sees, so nothing pushed it onto the entry's own chain either
      // (the observer's audit hook only fires from inside a turn) -- done here instead, so the
      // handoff summary a later call could still read (src/handoff/summary.ts) is never short one.
      // The console has the audit's entry before the end, as on one machine, whenever the audit has it.
      const ended = (): void => deps.bus?.publish({ type: 'ended', reason: 'hangup', callSid, at: Date.now() });
      if (s.audit) {
        whenChained(s.audit.append(callSid, live.session.channel, { type: 'call_ended', detail: { reason: 'hangup', completed: [...live.session.completed] } }), (entry) => {
          live.auditEntries.push(entry);
          deps.bus?.publish({ type: 'audit', callSid, at: Date.now(), entries: [entry] });
          ended();
        }, (err: unknown) => {
          deps.log(`${callSid}: the hangup's audit entry failed: ${err instanceof Error ? err.message : String(err)}`);
          ended();
        });
      } else ended();
    }
    const reason = params.sessionStatus ?? params.callStatus ?? 'unknown';
    return { document: provider.hangupDocument(), note: `hangup:${reason}` };
  }

  // (c) Live call, session failed or otherwise ended on the ConversationRelay side: reconnect
  // if we're under the limit, otherwise hand off to a human.
  const entry = deps.store.get(callSid);
  if (entry && !entry.ended) {
    // The drain has closed this call's socket and the server is about to go: with the call only in this
    // process's memory, a reconnect would reach nothing, so the caller is put through to a person. With
    // a store that outlives the process (SESSION_STORE=file), the call is saved and a reconnect is what
    // it gets, as anywhere else: its token is saved too, and the restarted server takes the socket.
    if (deps.closing?.() && !deps.store.durable) {
      deps.store.end(callSid);
      deps.tokens.revoke(callSid);
      return { document: provider.apologizeAndDialDocument(fallbackTarget(deps, s)), note: 'dial:closing', fallback: true };
    }
    if (entry.reconnects < deps.config.reconnectLimit) {
      deps.store.detach(callSid);
      // When the caller's silence began: the `resumed` line is said only past RESUMED_AFTER_MS of it.
      deps.store.markDropped(callSid);
      entry.reconnects += 1;
      // Saved with its new count, so a restart before the socket comes back does not hand out another.
      void deps.store.persist(callSid);
      const token = deps.tokens.mint(callSid, provider.id);
      // The call goes on in the language it is in now, which a switch may have changed since it started.
      const locale = s.app?.locales ? (entry.session.locale ?? s.app.locales.default) : undefined;
      // A planned restart: the carrier waits before it connects, so its socket reaches the restarted server
      // (which loads the call at setup) and not this one, which turns sockets away until it stops listening.
      const handover = deps.closing?.() && deps.store.durable ? (deps.handover?.() ?? null) : null;
      // The webhook is not sent again: the fields the first document echoed are written from what the session kept.
      // A withheld number stays withheld on the new socket's setup, which carries the number again.
      const options = connectOptions(deps, provider, token, locale, { ...webhookParametersOfKept(s.app?.callData, entry.session.callData), ...hostEcho(appId), ...withheldEcho(params, entry.callerWithheld === true) }, s);
      const document = start(handover !== null ? { ...options, pauseS: handover.pauseS } : options);
      return { document, note: `reconnect:${entry.reconnects}${handover !== null ? ` after ${handover.pauseS} s` : ''}` };
    }
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    return { document: provider.apologizeAndDialDocument(fallbackTarget(deps, s)), note: 'gave-up', fallback: true };
  }
  // A transfer whose `end` was held for its line to play (END_AFTER_PLAYBACK, server/adapter.ts) and never
  // sent: the socket closed first with the caller still on the line. The call has ended, but the
  // transfer it decided is still owed; a goodbye's held `end` hangs up, as any ended call.
  // With a durable store, the store's word is the one that counts: it hands the transfer to one server.
  if (held === 'unknown') {
    if (entry) entry.heldHandoffData = null;
    // The store could not say whether a transfer is owed to a caller still on the line: a person, never a hangup.
    deps.tokens.revoke(callSid);
    return { document: provider.apologizeAndDialDocument(fallbackTarget(deps, s)), note: 'dial:store-unavailable', fallback: true };
  }
  const owed = held !== undefined ? held : entry?.heldHandoffData;
  if (owed && !isBlank(owed)) {
    const handoff = parseHandoff(owed);
    if (handoff.reasonCode !== 'completed') {
      // Owed once: a second callback for the call hangs up.
      if (entry) entry.heldHandoffData = null;
      deps.tokens.revoke(callSid);
      return dialHandoff(deps, provider, callSid, handoff, s);
    }
  }
  if (entry && held !== undefined) entry.heldHandoffData = null;
  return { document: provider.hangupDocument(), note: 'hangup' };
}

/**
 * Whether the call's token writes have landed in a store that writes behind (ServerTokenStore.settled),
 * within the store's time (SESSION_STORE_TIMEOUT_MS); false, logged, when one failed or took longer, so
 * the carrier's webhook is answered (with a person) rather than left to time out.
 */
async function landed(deps: HttpDeps, callId: string): Promise<boolean> {
  try {
    await within(deps.tokens.settled?.(callId) ?? Promise.resolve(), deps.store.timeoutMs);
    return true;
  } catch (err) {
    deps.log(`${callId}: the relay token could not be saved (${err instanceof Error ? err.message : String(err)}): the caller is put through to a person`);
    return false;
  }
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = deps.routes ?? [];
  validateRoutes(routes);
  const settings = deps.config.consoleAuth;
  const auth = settings ? (deps.consoleAuth ?? new ConsoleAuth({ settings, publicHost: deps.config.publicHost, audit: deps.audit ?? null, log: deps.log })) : undefined;
  // With CONSOLE_AUTH=token the console is served through the tunnel behind its sign-in; an app's
  // local-only pages keep CONSOLE_LOCAL_ONLY's rule either way.
  const localOnly = auth ? localOnlyPaths(routes).filter((p) => !CONSOLE_PATHS.includes(p)) : localOnlyPaths(routes);
  const enabled = voiceProviders(deps.config.voiceProviders);
  /** `/health`'s numbers, which the console's Health page shows too. */
  const healthNumbers = (): HealthNumbers => {
    const live = deps.store.liveCount();
    const traces = deps.traceHealth?.() ?? null;
    return {
      sessions: live,
      retained: deps.store.size() - live,
      ...(deps.chatLive ? { chat: deps.chatLive() } : {}),
      ...(deps.draining?.() ? { draining: true } : {}),
      ...(deps.disk ? { disk: deps.disk() } : {}),
      ...(traces === null ? {} : { traces }),
    };
  };
  const sh = deps.serverHealth;
  const consoleHealth: HealthSource = {
    numbers: healthNumbers,
    self: () => ({ server: sh?.name ?? 'this server', calls: deps.store.liveCount(), chats: deps.chatLive?.() ?? 0, ...(sh ? sh.counters.now() : { reconnects: 0, fallbacks: 0, day: '' }) }),
    ...(sh?.peers ? { peers: sh.peers } : {}),
    ...(sh?.verify ? { verify: sh.verify } : {}),
    ...(sh?.auditLabel !== undefined ? { auditLabel: sh.auditLabel } : {}),
  };
  return (req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      // Before any route handles it: through the tunnel, the console and the local-only app pages do not exist.
      if (deps.config.consoleLocalOnly && isConsolePath(path, localOnly) && !isDirectLocalRequest(req, deps.config.publicHost)) {
        reply(res, 404, 'text/plain', 'not found');
        return;
      }
      if (deps.bus && handleDashboardRequest(req, res, {
        bus: deps.bus, traceDir: deps.config.traceDir, enabled: deps.config.dashboard, health: consoleHealth,
        ...(auth ? { auth } : {}), ...(deps.traces ? { traces: deps.traces } : {}), ...(deps.consoleApps ? { apps: deps.consoleApps } : {}),
        ...(deps.config.carrierRates ? { carrierRates: deps.config.carrierRates } : {}), ...(deps.appDir !== undefined ? { appDir: deps.appDir } : {}),
        ...(deps.config.figuresRetentionDays !== undefined ? { figuresRetentionDays: deps.config.figuresRetentionDays } : {}),
      })) return;
      // Before the webhooks: an app's page authenticates its own way (a portal token), not with Twilio's signature.
      // A route is handed only the paths that are its own, by the matcher the local-only guard used above.
      for (const route of routes) {
        if (routeOwns(route, path) && (await route.handle(req, res, path))) return;
      }
      if (deps.config.widget && (req.method === 'GET' || req.method === 'HEAD') && path === WIDGET_PATH) {
        serveWidget(req, res, deps.config.widget.file, deps.log);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/audio/')) {
        const raw = path.slice('/audio/'.length);
        // On a host, each app's clips are in a folder of its own, /audio/<app id>/<clip>.
        const slash = raw.indexOf('/');
        if (deps.host && slash > 0) {
          const id = raw.slice(0, slash);
          if (/^[a-z][a-z0-9_-]*$/.test(id) && deps.host.served(id) !== undefined) {
            serveClip(req, res, join(deps.config.audioDir, id), raw.slice(slash + 1));
            return;
          }
        }
        serveClip(req, res, deps.config.audioDir, raw);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health') {
        // Liveness: the process answers. `sessions` is what is live; `retained` is ended calls still
        // inside their grace period, which are memory but not callers. `chat` is there when the chat
        // is on, `draining` while the server is stopping, and `disk` when a retention is set, so a
        // body is what it was before them for a deployment that sets none.
        const body = JSON.stringify({ ok: true, ...healthNumbers() });
        answerJson(req, res, 200, body);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/ready') {
        // Readiness: whether to send this server new calls. A load balancer or a monitor reads it; a
        // stopping server says no while its live calls finish.
        // Before the drain (DRAIN_UNREADY_MS) it says no while still answering new calls, so a balancer
        // that has not yet seen it go loses none of them.
        const draining = deps.draining?.() ?? false;
        const stopping = !draining && (deps.unready?.() ?? false);
        answerJson(req, res, draining || stopping ? 503 : 200, JSON.stringify(draining ? { ready: false, draining: true } : stopping ? { ready: false, stopping: true } : { ready: true }));
        return;
      }
      // A carrier's webhooks: `/voice/<id>` and `/cr-action/<id>` for an enabled provider, and the
      // unprefixed `/voice` and `/cr-action` for Twilio (the legacy paths, answered with the legacy documents).
      const answer = providerForPath(enabled, path, '/voice');
      const action = answer ? null : providerForPath(enabled, path, '/cr-action');
      const provider = answer ?? action;
      if (req.method !== 'POST' || provider === null) {
        reply(res, 404, 'text/plain', 'not found');
        return;
      }
      const legacy = path === '/voice' || path === '/cr-action';
      const body = await readBody(req, res);
      if (body === null) return; // 413 already sent by readBody
      const webhook: WebhookRequest = { url: req.url ?? path, headers: lowerHeaders(req.headers), rawBody: body, nowSec: Math.floor(Date.now() / 1000) };
      // A provider with no secret refuses everything: an empty key would make a signature anyone can compute.
      const secret = deps.config.providerSecrets[provider.id];
      if (deps.config.signatureCheck && (!secret || !provider.verify(webhook, secret, deps.config.publicHost))) {
        deps.log(`${path}: signature rejected`);
        reply(res, 403, 'text/plain', 'invalid signature');
        return;
      }
      const params = provider.parse(webhook);
      if (answer) {
        if (params === null) {
          deps.log(`${path}: missing CallSid`);
          reply(res, 400, 'text/plain', 'missing CallSid');
          return;
        }
        // On a host, the app the number called reaches (the default for any other number, or none).
        const { id: appId, s } = servedOf(deps, undefined, params.to);
        const inApp = appId === null ? '' : ` (app ${appId})`;
        // The caller's number is theirs, not the console's: the last four tell calls apart.
        if (deps.draining?.()) {
          // A server about to stop starts no call it may not finish: the caller is put through to a person.
          deps.log(`${path} ${params.callId} from ${callerForLog(params)}${inApp}: draining: new call sent to handoff`);
          sh?.counters.count('fallbacks');
          reply(res, 200, provider.contentType, provider.dialDocument(fallbackTarget(deps, s)));
          return;
        }
        const token = deps.tokens.mint(params.callId, provider.id);
        // A token written behind its answer (SESSION_STORE=postgres) is in the store before the carrier has
        // it, so the server its socket reaches can read it; one that could not be written puts the caller
        // through to a person rather than at a socket no server will open.
        if (deps.tokens.settled && !(await landed(deps, params.callId))) {
          sh?.counters.count('fallbacks');
          reply(res, 200, provider.contentType, provider.dialDocument(fallbackTarget(deps, s)));
          return;
        }
        deps.log(`${path} ${params.callId} from ${callerForLog(params)}${inApp}`);
        // The fields of this webhook the app's callData names, echoed as custom parameters (dw_<key>) so they
        // come back with the setup; on a host, the app's id too, so the setup starts the call in the same app;
        // and, for a caller who withheld their number, that they did, so the setup's copies of it are taken out.
        const options = connectOptions(deps, provider, token, s.app ? startLocale(s.app, params.to) : undefined, { ...webhookParameters(s.app?.callData, params.raw), ...hostEcho(appId), ...withheldEcho(params) }, s);
        reply(res, 200, provider.contentType, legacy ? connectRelayTwiml(options) : provider.startDocument(options));
        return;
      }
      // An action callback that names no call is still answered, as it always was: the legacy path
      // decides it on Twilio's fields as before providers, a provider's own path hangs up.
      const callback: CallbackParams = params ?? (legacy ? twilioCallbackParams(formFields(body)) : { callId: '', raw: {} });
      // A call this server does not hold may have been saved by the one before it (SESSION_STORE=file):
      // loaded first, so a reconnect resumes it and a hangup records its end. With the memory store
      // (the default) there is never one to load.
      const loaded = callback.callId ? await deps.store.restore(callback.callId, provider.id) : 'none';
      // Shared with other servers (SESSION_STORE=postgres): a reconnect is counted in the store, at once for
      // every server, before it is decided on.
      if (deps.store.shared && callback.callId && loaded !== 'unreadable' && loaded !== 'unavailable' && wantsReconnect(callback)) {
        await deps.store.countReconnect(callback.callId, deps.config.reconnectLimit);
      }
      // A callback that would reconnect a call no longer live here: with a durable store, a transfer it
      // still owes (END_AFTER_PLAYBACK, its socket closed before the `end` went) is taken from the store,
      // wherever the call ran. With the memory store there is none to take.
      const local = deps.store.get(callback.callId);
      const held = callback.callId && deps.store.durable && loaded !== 'unavailable' && isBlank(callback.handoffData) && wantsReconnect(callback) && (!local || local.ended)
        ? await deps.store.takeHeld(callback.callId)
        : undefined;
      // A callback that ends the call (its caller hung up) while a transfer was held for its line: the
      // transfer is no one's now, and is taken from the store so nothing keeps it.
      if (callback.callId && deps.store.durable && loaded !== 'unavailable' && isBlank(callback.handoffData) && !wantsReconnect(callback) && (!local || local.ended)) {
        const dropped = await deps.store.takeHeld(callback.callId);
        if (typeof dropped === 'string') {
          if (local) local.heldHandoffData = null;
          deps.log(`${callback.callId}: a transfer held for its line is dropped: its caller hung up first`);
        }
      }
      // Masked at write time: Twilio's form post spells the caller's number four different ways
      // (From/To/Caller/Called), and the frame log must never hold the whole thing on disk.
      // A field the app's callData reads from the webhook (webhook.<field>) as its key's redact says.
      const served = servedOf(deps, callback.callId, callback.to).s;
      // And, whatever its name, any field that holds the caller's number (maskCopiesOf), as a defence beside the
      // names; for a call whose caller withheld their number (CallEntry.callerWithheld, saved with it) and a
      // callback that does not mark it, every copy is left out, not masked: no last four of it either.
      const holder = deps.store.get(callback.callId);
      const fields = recordedWebhookFields(served.app?.callData, callback.raw);
      holder?.frames.write('http', redactDeep({ route: path, ...(holder.callerWithheld === true ? withoutCopiesOf(fields, callback.from) : maskCopiesOf(fields, callback.from)) }));
      const start = legacy ? connectRelayTwiml : undefined;
      let { document, note, fallback } = loaded === 'unreadable'
        ? decideUnreadable(deps, provider, callback, start)
        : loaded === 'unavailable' && wantsReconnect(callback)
          // The store could not be asked in time: the caller is put through rather than at a reconnect no server can resume.
          ? { document: provider.apologizeAndDialDocument(fallbackTarget(deps, served)), note: 'dial:store-unavailable', fallback: true }
          : decideAction(deps, provider, callback, start, held);
      if (deps.store.shared && callback.callId) {
        // Loaded only to answer: the call is taken where its socket lands.
        deps.store.dropBorrowed(callback.callId);
        // A reconnect's token is in the store before the carrier has it; one that could not be saved puts the caller through.
        if (note.startsWith('reconnect') && deps.tokens.settled && !(await landed(deps, callback.callId))) {
          document = provider.apologizeAndDialDocument(fallbackTarget(deps, served));
          note = `${note}, then dial:token-not-saved`;
          fallback = true;
        }
      }
      deps.log(`${path} ${callback.callId || '?'} ${callback.sessionStatus ?? ''} -> ${note}`);
      if (fallback) sh?.counters.count('fallbacks');
      else if (note.startsWith('reconnect')) sh?.counters.count('reconnects');
      if (callback.callId) deps.handover?.()?.answered(callback.callId);
      reply(res, 200, provider.contentType, document);
    })().catch((e: unknown) => {
      deps.log(`http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) reply(res, 500, 'text/plain', 'error');
    });
  };
}

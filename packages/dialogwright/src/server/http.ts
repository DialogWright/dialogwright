import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recognitionFor, voiceFor, type ServerConfig } from './config';
import { connectRelayTwiml } from './twiml';
import type { SessionStore } from './sessions';
import type { CallTokens } from './tokens';
import type { DashboardBus } from './dashboard/bus';
import { handleDashboardRequest } from './dashboard/routes';
import { AUDIO_TYPES, CLIP_FILE } from '../prompts/clips';
import { maskNumber, redactDeep } from './dashboard/events';
import type { AuditSink } from '../run/turn';
import { routeOwns, validateRoutes, type AppRoute } from './appRoutes';
import { isConsolePath, isDirectLocalRequest, localOnlyPaths } from './localOnly';
import type { CallbackParams, RelayLanguage, StartDocumentOptions, VoiceProvider, WebhookRequest } from './voice/provider';
import { providerForPath, voiceProviders } from './voice/registry';
import { twilioCallbackParams, twilioProvider } from './voice/twilio';
import { formFields } from './voice/xml';
import type { App } from '../core/app/types';
import { buildHintsFrom } from './hints';
import { DEFAULT_LOCALE, localesOf, speechLanguagesOf } from '../core/locale';

export interface HttpDeps {
  config: ServerConfig;
  store: SessionStore;
  tokens: CallTokens;
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

function parseHandoff(raw: string): { reasonCode: string } {
  try {
    const v = JSON.parse(raw) as { reasonCode?: unknown };
    return { reasonCode: typeof v.reasonCode === 'string' ? v.reasonCode : 'unknown' };
  } catch {
    return { reasonCode: 'unknown' };
  }
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
function connectOptions(deps: HttpDeps, provider: VoiceProvider, token: string, locale?: string): StartDocumentOptions {
  const deployment = voiceFor(deps.config, provider.id);
  const deploymentRecognition = recognitionFor(deps.config, provider.id);
  const base: StartDocumentOptions = { publicHost: deps.config.publicHost, token, hints: deps.hints, ...deployment, recognition: deploymentRecognition };
  const app = deps.app;
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
 * one for a call that came in on the unprefixed `/voice`.
 */
export function decideAction(
  deps: HttpDeps,
  provider: VoiceProvider,
  params: CallbackParams,
  start: (o: StartDocumentOptions) => string = (o) => provider.startDocument(o),
): { document: string; note: string } {
  const callSid = params.callId;

  // (a) An explicit handoff decision from the adapter wins outright.
  const handoffData = params.handoffData;
  if (!isBlank(handoffData)) {
    const handoff = parseHandoff(handoffData!);
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    if (handoff.reasonCode === 'completed') return { document: provider.hangupDocument(), note: 'completed' };
    return { document: provider.dialDocument(deps.config.handoffNumber), note: `dial:${handoff.reasonCode}` };
  }

  // (b) No handoff: an ordinary caller hangup (or any status that isn't a live in-progress call)
  // just ends the call. This must not be logged as gave-up or dialed.
  if (params.sessionStatus === 'completed' || params.callStatus !== 'in-progress') {
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
      const entry = deps.audit?.append(callSid, live.session.channel, { type: 'call_ended', detail: { reason: 'hangup', completed: [...live.session.completed] } });
      if (entry) {
        live.auditEntries.push(entry);
        deps.bus?.publish({ type: 'audit', callSid, at: Date.now(), entries: [entry] });
      }
      deps.bus?.publish({ type: 'ended', reason: 'hangup', callSid, at: Date.now() });
    }
    const reason = params.sessionStatus ?? params.callStatus ?? 'unknown';
    return { document: provider.hangupDocument(), note: `hangup:${reason}` };
  }

  // (c) Live call, session failed or otherwise ended on the ConversationRelay side: reconnect
  // if we're under the limit, otherwise hand off to a human.
  const entry = deps.store.get(callSid);
  if (entry && !entry.ended) {
    if (entry.reconnects < deps.config.reconnectLimit) {
      deps.store.detach(callSid);
      entry.reconnects += 1;
      const token = deps.tokens.mint(callSid, provider.id);
      // The call goes on in the language it is in now, which a switch may have changed since it started.
      const locale = deps.app?.locales ? (entry.session.locale ?? deps.app.locales.default) : undefined;
      return { document: start(connectOptions(deps, provider, token, locale)), note: `reconnect:${entry.reconnects}` };
    }
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    return { document: provider.apologizeAndDialDocument(deps.config.handoffNumber), note: 'gave-up' };
  }
  return { document: provider.hangupDocument(), note: 'hangup' };
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = deps.routes ?? [];
  validateRoutes(routes);
  const localOnly = localOnlyPaths(routes);
  const enabled = voiceProviders(deps.config.voiceProviders);
  return (req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      // Before any route handles it: through the tunnel, the console and the local-only app pages do not exist.
      if (deps.config.consoleLocalOnly && isConsolePath(path, localOnly) && !isDirectLocalRequest(req, deps.config.publicHost)) {
        reply(res, 404, 'text/plain', 'not found');
        return;
      }
      if (deps.bus && handleDashboardRequest(req, res, { bus: deps.bus, traceDir: deps.config.traceDir, enabled: deps.config.dashboard })) return;
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
        serveClip(req, res, deps.config.audioDir, path.slice('/audio/'.length));
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health') {
        // `sessions` is what is live; `retained` is ended calls still inside their grace period,
        // which are memory but not callers.
        const live = deps.store.liveCount();
        const body = JSON.stringify({ ok: true, sessions: live, retained: deps.store.size() - live });
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          res.end();
        } else {
          reply(res, 200, 'application/json', body);
        }
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
        const token = deps.tokens.mint(params.callId, provider.id);
        // The caller's number is theirs, not the console's: the last four tell calls apart.
        deps.log(`${path} ${params.callId} from ${maskNumber(params.from)}`);
        const options = connectOptions(deps, provider, token, deps.app ? startLocale(deps.app, params.to) : undefined);
        reply(res, 200, provider.contentType, legacy ? connectRelayTwiml(options) : provider.startDocument(options));
        return;
      }
      // An action callback that names no call is still answered, as it always was: the legacy path
      // decides it on Twilio's fields as before providers, a provider's own path hangs up.
      const callback: CallbackParams = params ?? (legacy ? twilioCallbackParams(formFields(body)) : { callId: '', raw: {} });
      // Masked at write time: Twilio's form post spells the caller's number four different ways
      // (From/To/Caller/Called), and the frame log must never hold the whole thing on disk.
      deps.store.get(callback.callId)?.frames.write('http', redactDeep({ route: path, ...callback.raw }));
      const { document, note } = decideAction(deps, provider, callback, legacy ? connectRelayTwiml : undefined);
      deps.log(`${path} ${callback.callId || '?'} ${callback.sessionStatus ?? ''} -> ${note}`);
      reply(res, 200, provider.contentType, document);
    })().catch((e: unknown) => {
      deps.log(`http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) reply(res, 500, 'text/plain', 'error');
    });
  };
}

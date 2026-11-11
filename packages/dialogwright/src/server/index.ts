import { createServer, type Server } from 'node:http';
import { CHAT_PAGE_PATH, chatPageRoutes } from './chatPage';
import { applyEnvFile, envFilePathsOf } from './envFile';
import { SIGNAL_REPEAT_MS } from './signals';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { checkJwksUrl, jwksKeys } from './chat/jwks';
import { accountSettingsFrom, calledVariablesFrom, describeVoiceNumbers, transferTargetsFrom, voiceNumbersFrom, type ServerTransfer } from './transfer';
import type { NumberLocale } from '../core/numberLocales';
import { defaultLocaleOf } from '../core/locale';
import { appAgentClient, agentKeyVar } from '../agent/provider';
import type { AgentRunner } from '../agent/types';
import { agentSettings, type ChatSettings, consoleExposure, gb, DEFAULT_DRAIN_MS, DEFAULT_RESUMED_AFTER_MS, DEFAULT_RESAY_MIN_FRACTION, describeConfig, loadConfig, localBase, publicBase, recognitionFor, recordsSettingFor, reportsCallerVoice, startParametersFrom, type Env, type ServerConfig } from './config';
import { DEFAULT_INCOMPLETE_WAIT_MS, DEFAULT_SPEECH_OVER_LINE, DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS, VOICE_PROVIDER_IDS } from '../channel/voiceProviders';
import { bareSpeechTags, bareTagFinding, englishOnlyFinding, englishOnlyHearings, speechLocalesOfApp } from '../channel/speechLanguages';
import { createRequestHandler, MESSAGES_PATH, telnyxUnvoicedLocales, type HttpApp, type HttpDeps } from './http';
import { attachWebSocketServer } from './ws';
import { forgetNoInput, heldEndsOf, type AdapterDeps } from './adapter';
import { randomBytes } from 'node:crypto';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { openFileStores } from './stores/file';
import { openPostgresStores } from './stores/postgres';
import { boundedSql, maskConnectionString, maskSecrets, openPgClient, type SqlClient } from './stores/sql';
import type { CallStateStore, ChatStateStore, ServerTokenStore } from './stores/types';
import { FrameLog } from './frameLog';
import { buildHints } from './hints';
import { DashboardBus } from './dashboard/bus';
import type { DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { defaultAppId, getApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { newSession, type Session } from '../core/session';
import { ANONYMOUS } from '../gate/principal';
import { appOfSetup, describeHost, ownSettingsLines, OWN_SERVER_SETTING_FIX, type HostedApp, type HostRouting } from './host';
import type { AuditDraft } from '../audit/types';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildClient, modelHeader } from '../run/client';
import { localDateIso } from '../run/clock';
import { DayCounters, latencyOf, ServersSeen, REPORT_EVERY_MS, verifyAudit, type ServerReport } from './dashboard/health';
import type { JevClient } from '../jev/types';
import { TraceWriter, type TraceSink } from '../trace/writer';
import { S3TraceStore, type CallMeta } from '../trace/store';
import { guardFrames, guardTrace, TraceFailures } from '../trace/guard';
import type { FrameSink } from './frameLog';
import { whenChained, type AuditSink, type TurnObserver } from '../run/turn';
import { clipVersions, discoverClips, recordableClips } from '../prompts/clips';
import { clipDurations } from '../prompts/playback';
import { clipStatus, readRecorded } from '../prompts/sheet';
import type { RenderContext } from '../prompts/render';
import { demoTools, mockCodeVerifier, type Tools } from '../core/tools';
import { defaultCorpusFile } from '../run/fixtures';
import { AuditLog } from '../audit/log';
import { openPostgresAudit, type PostgresAuditLog } from '../audit/postgres';
import { PostgresNotices } from './stores/notices';
import { openSweeps } from './stores/sweeps';
import { chatTraceMeta } from './traceMeta';
import type { ServiceUrls } from './services';
import { appPagesBase, mountAppPages, routeOwns, validateRoutes, type AppPagesFactory, type AppRoute, type AppRoutesFactory } from './appRoutes';
import { localOnlyPaths } from './localOnly';
import { safeFileStem } from './fileStem';
import { VOICE_RELAY } from '../channel/caps';
import { CHAT_PATH, chatByApp, chatEndpoint, chatTransport, type ChatEndpoint, type ChatTransportDeps } from './chat/socket';
import { converseChatRuntime } from './chat/converseRuntime';
import { isConverseApp, type ConverseApp } from '../converse/app';
import type { ConverseModel } from '../converse/model/types';
import { resolveConverseModel } from '../converse/model/resolve';
import { diskUsageCache, sweepRetention, type RetentionSettings } from './retention';
import { ConsoleAuth } from './console/auth';
import { logFileSettingOf, RollingLog, teeProcessOutput } from './logFile';
import { generatesLines } from '../render/config';
import { textSettings } from '../texts/settings';
import { twilioTextProvider } from '../texts/twilio';
import { receivedRecord, recordingTexts, TextKeys, TextLimits, textAuditRow } from '../texts/record';
import { textDecider } from '../texts/decide';
import { sameNumber } from '../core/conditions';
import type { IncomingText, TextProvider, TextRecord, Texts } from '../texts/types';
import { lastFour } from '../core/callerNumber';
import type { TurnTexts } from '../run/turn';
import { appModelKeyMissing, appModelLabel, defaultRenderPrice, inceptionTemperatureNotes, ModelRenderClient, providerSettingsLabel, renderModelSource, renderModelSourceLabel, renderSettings, resolveAppRenderProvider } from '../render/providers';
import type { Renderer } from '../render/types';

export interface RunningServer {
  server: Server;
  port: number;
  store: SessionStore;
  tokens: ServerTokenStore;
  /** The dashboard's event bus, or undefined when DASHBOARD=off. */
  bus?: DashboardBus;
  /** The pages mounted: its launcher's (ServerOverrides.routes), then each app's own (App.pages, under /<app id>), in the order they are asked. */
  routes: readonly AppRoute[];
  /** The engine's web chat (CHAT=on), or undefined when it is off. */
  chat?: ChatEndpoint;
  /** One pass of the idle sweep the evictor runs on its interval; exposed for tests. */
  sweep(): void;
  /** Whether the server is stopping: drain (or close) has begun, and `/ready` answers 503. */
  readonly draining: boolean;
  /** Whether `/ready` answers 200: neither unready (DRAIN_UNREADY_MS) nor draining. */
  readonly ready: boolean;
  /**
   * The first step of a stop, before the drain (DRAIN_UNREADY_MS, default 0: none): `/ready` answers 503
   * for `ms` while the server answers new calls as usual, so a load balancer sees it go before any new
   * call it still sends would be put through to a person. Resolves once the time is up; `drain` follows.
   */
  unready(ms?: number): Promise<void>;
  /**
   * The first half of a stop: the server stops taking new work and waits for what is live. From now on
   * `/ready` answers 503, a new call is put through to the handoff number, and a new chat is refused
   * `busy`; a live call's turns and its reconnects, and a chat's resume, go on. It resolves once no call
   * is live and no one is in a chat (with a session store, no chat has a reply being worked out: one
   * waiting on the person is saved and resumes on the restarted server), or after `ms` (default DRAIN_MS; 0 at once), when it closes the
   * calls still live with 1001 (going away), so the carrier calls back for them (a few seconds at most).
   * With the memory store it answers each of those callbacks with the handoff number. With a durable
   * store (SESSION_STORE=file) it hands each call over to the restarted server instead: with
   * RESTART_PAUSE_S above 0 (default 5) it keeps listening until every call has called back (or
   * GOING_AWAY_MS), answers each callback with a document that pauses that long and then connects
   * again, and turns every socket away (503) meanwhile, so the carrier's lands on the restarted server;
   * with RESTART_PAUSE_S=0 it stops listening first, and a callback that finds no server goes to the
   * carrier's fallback document. close() follows it.
   */
  drain(ms?: number): Promise<void>;
  /**
   * Closes the server: it lets turns already running finish (up to two seconds), then closes every
   * socket and stops listening. Called alone, as a test does, it waits for no call to end.
   */
  close(): Promise<void>;
}

export interface ServerOverrides {
  client?: JevClient;
  /**
   * How lines an app generates are worded (generated wording, render/types.ts): tests give a fake
   * renderer. Left out, each app that generates a line has one from its own settings (RENDER_PROVIDER,
   * RENDER_MODEL, the provider's key, RENDER_SHARE, RENDER_TIMEOUT_MS) over the model it names
   * (style.yaml's `model`), and none with neither, or with its own model's key unset: every line is
   * then its fixed text. An app that generates no line never has one.
   */
  renderer?: Renderer;
  /**
   * The agent model of an app in agent mode, for every such app (a test's fake). Left out, each has one
   * from style.yaml's `agent` with its own settings (its provider's key, AGENT_TIMEOUT_VOICE_MS,
   * AGENT_TIMEOUT_CHAT_MS), and none with its key unset: each call then runs as a scripted app (its fields'
   * fixed questions, the decision model understanding the answers; core/agentTurn.ts scriptedFromNow).
   */
  agent?: AgentRunner;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * The address to listen on; left out, every address, as a deployment needs. Tests give the address
   * they dial (127.0.0.1): on every address the operating system may hand out a port that another
   * process holds on 127.0.0.1 alone, and a request to 127.0.0.1 would then reach that process.
   */
  host?: string;
  /** Tests use a short deadline so a connection that never sends setup does not hold the suite open. */
  setupTimeoutMs?: number;
  /** Tests use a short grace period to prove the end-close backstop fires without waiting 30 seconds. */
  endCloseGraceMs?: number;
  /** Tests use a short wait so a silence turn runs without sitting through the configured seven seconds. */
  noInputMs?: number;
  /**
   * Where each of the app's downstream services (App.services) is reached, by name, from the services the
   * app's launcher starts beside the server. A service with no url is not running: a request to it is
   * answered at once with no result.
   */
  serviceUrls?: ServiceUrls;
  /**
   * The app's own pages (its web chats, say), built once the server has its
   * client, tools, audit chain and console. Without it the server serves the phone line and the
   * console only.
   */
  routes?: AppRoutesFactory;
  /** The environment app.yaml's startParameters are read from; left out, the process's. Tests give their own. */
  env?: Env;
  /** Tests replace the Claude Haiku call, for the phone line and the chat alike. */
  summarizeHandoff?: AdapterDeps['summarizeHandoff'];
  /** How the engine's web chat fetches the identity provider's published keys (CHAT_SIGNIN=jwt); tests serve their own. */
  chatFetch?: typeof fetch;
  /**
   * With SESSION_STORE=postgres://..., the connection to use in place of the one the setting names: the
   * engine's tests give one on PGlite (stores/pgliteSql.ts), so two servers share one database in one
   * process. Not a setting: a deployment always connects through the pg driver. The server closes it.
   */
  sessionSql?: SqlClient;
  /** With AUDIT_STORE=postgres://..., the connection to use, as sessionSql is for SESSION_STORE: a test seam, not a setting. */
  auditSql?: SqlClient;
  /**
   * How texts are sent (texts/types.ts TextProvider) for every app with TEXT_FROM set, in place of Twilio's
   * Messages API: a test's fake (dialogwright/testing fakeTextProvider), so no test sends a text. A test seam, not a setting.
   */
  textProvider?: TextProvider;
  /** With TRACE_STORE=s3://..., how the store is reached in place of the global fetch: a test seam, not a setting. */
  traceFetch?: typeof fetch;
  /**
   * Several apps on one server (host.yaml, server/host.ts loadHost): every app it lists, each with its own
   * environment, and the numbers that reach each. Absent, the server runs the default app, reading its
   * references from `env`, exactly as before.
   */
  apps?: HostRouting<HostedApp>;
  /**
   * The model of each converse app's conversations, by the app's id: a test's fake (converse/model/fake.ts),
   * so no test calls a real model. A test seam, not a setting: left out, each converse app's agent.yaml
   * `model.default`, resolved with the app's own settings (its key from them).
   */
  converseModel?: (appId: string) => ConverseModel;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
/**
 * Connections each server opens to SESSION_STORE's database: one held for LISTEN (the notices), the
 * rest for the stores' questions, and the audit's when AUDIT_STORE names the same database; and to
 * AUDIT_STORE's when it names another. A database serves servers x SESSION_POOL (+ AUDIT_POOL).
 */
export const SESSION_POOL = 12;
export const AUDIT_POOL = 5;
/** How long one server holds the trace store's hourly sweep: less than the hour, so another may take the next. */
const TRACE_SWEEP_HOLD_MS = 50 * 60 * 1000;
const EVICT_EVERY_MS = 60 * 1000;
/** How often the idle sweep also sweeps old traces and audit days, when a retention is set. */
const RETENTION_EVERY_MS = 60 * 60 * 1000;
/**
 * How long close() waits for turns already in flight before it terminates the sockets anyway. It is
 * not the drain: DRAIN_MS (config.ts) is how long a stopping server waits for whole calls to end.
 */
const DRAIN_TIMEOUT_MS = 2_000;
/** How often a drain looks for the last call to have ended. */
const DRAIN_POLL_MS = 100;
/**
 * After the drain closes the calls still live with 1001, how long it waits for their sockets to close
 * and for the carrier's callback for each (answered with the handoff number) before close() goes on.
 */
const GOING_AWAY_MS = 3_000;

/** A call's trace is named by its id through safeFileStem (fileStem.ts), which the console's lookups share. */
export { safeFileStem };

/**
 * The Postgres stores SESSION_STORE=postgres://... names, through the pg driver (or the connection a test
 * gives): a failure to connect, or tables at another version, stops the server here with the reason,
 * the connection string's password never in it.
 */
async function openShared(url: string, timeoutMs: number, sql: SqlClient, now: () => number, log: (line: string) => void) {
  try {
    return await openPostgresStores(sql, { tokenTtlMs: TOKEN_TTL_MS, now, log, timeoutMs });
  } catch (err) {
    await sql.close().catch(() => undefined);
    throw new Error(`SESSION_STORE ${maskConnectionString(url)}: ${maskSecrets(err instanceof Error ? err.message : String(err), url)}`);
  }
}

/** A failure opening one of the Postgres parts as the server says it: the setting, the masked string, and why, never the password. */
function postgresFailure(setting: string, url: string, err: unknown): Error {
  return new Error(`${setting} ${maskConnectionString(url)}: ${maskSecrets(err instanceof Error ? err.message : String(err), url)}`);
}

/** HANDOFF_NUMBER as an app's environment gives it (its own file's, else the server's), held to E.164 as the server's is. */
function handoffNumberOf(env: Env, server: string): string {
  const own = env.HANDOFF_NUMBER?.trim();
  if (own === undefined || own === '') return server;
  if (!/^\+\d{8,15}$/.test(own)) throw new Error(`HANDOFF_NUMBER must be an E.164 number like +15551234567, got "${own}"`);
  return own;
}

/** Whether an app's own settings file gave a variable its value under a host (not the server's). */
function hostOwns(a: { readonly own?: readonly string[] }, variable: string): boolean {
  return a.own?.includes(variable) === true;
}

/**
 * The chat's settings for one app of a host: the sign-in's audience and issuer its own settings file
 * gives (CHAT_AUDIENCE, CHAT_ISSUER), else the server's, so a token for one app's portal is not taken
 * at another's chat.
 */
function chatSettingsOf(settings: ChatSettings, env: Env): ChatSettings {
  if (settings.signIn.method !== 'jwt') return settings;
  const audience = env.CHAT_AUDIENCE?.trim() || settings.signIn.audience;
  const issuer = env.CHAT_ISSUER?.trim() || settings.signIn.issuer;
  const jwksUrl = env.CHAT_JWKS_URL?.trim() || settings.signIn.jwksUrl;
  // An https URL, as the server's own must be: one that is not stops the server here, naming the app.
  checkJwksUrl(jwksUrl);
  return { ...settings, signIn: { ...settings.signIn, audience, issuer, jwksUrl } };
}

/**
 * On a host of several apps whose chats sign in with tokens (CHAT_SIGNIN=jwt): each audience two or more
 * apps share, said with the apps, since a token for one app's portal would sign in at the others' chats.
 */
export function sharedAudiences(settings: ChatSettings, apps: readonly { readonly id: string; readonly env: Env }[]): string[] {
  if (settings.signIn.method !== 'jwt' || apps.length < 2) return [];
  const byAudience = new Map<string, string[]>();
  for (const a of apps) {
    const signIn = chatSettingsOf(settings, a.env).signIn;
    if (signIn.method !== 'jwt') continue;
    const key = `${signIn.issuer} ${signIn.audience}`;
    byAudience.set(key, [...(byAudience.get(key) ?? []), a.id]);
  }
  return [...byAudience.values()].filter((ids) => ids.length > 1).map((ids) => `${ids.join(', ')} take tokens for one audience, so a token for one's portal signs in at the others' chats: give each app its own CHAT_AUDIENCE in its own settings file`);
}

/** The corpus of an app's fixtures (App.fixtures, a path from its package's folder), or null when it has none. */
function corpusOf(app: App, dir: string | undefined): string | null {
  if (!app.fixtures) return null;
  let base = dir;
  for (let at = dir; at !== undefined; at = dirname(at) === at ? undefined : dirname(at)) {
    if (existsSync(join(at, 'package.json'))) {
      base = at;
      break;
    }
  }
  const file = resolvePath(base ?? process.cwd(), defaultCorpusFile(app));
  return existsSync(file) ? file : null;
}

/**
 * On a host, the folder (in AUDIT_DIR) of the server's own audit, beside each app's: the console's
 * sign-ins and replays, which are no app's. An app id starts with a letter, so none is this.
 */
export const SERVER_RECORDS = '_server';

/** The channel a text's audit rows are recorded under (texts/record.ts textAuditRow), beside calls' `voice` and chats' `chat`. */
export const TEXT_CHANNEL = 'sms';

/** An app's audit chain on a host: `sink`, each entry naming the app (AuditDraft.app), hashed with it. */
function appAudit(sink: AuditSink, app: string): AuditSink {
  const named = (d: AuditDraft): AuditDraft => ({ ...d, app });
  const appendAll = sink.appendAll?.bind(sink);
  return {
    append: (callId, channel, d) => sink.append(callId, channel, named(d)),
    ...(appendAll ? { appendAll: (callId: string, channel: string, ds: readonly AuditDraft[]) => appendAll(callId, channel, ds.map(named)) } : {}),
  };
}

/** The audit id an app page's text is recorded under where it carries no key (AppPageDeps.texts). */
export const PAGE_TEXTS_ID = 'page';

/**
 * The sender an app's pages are given (AppPageDeps.texts): the app's own (its provider, number, keys and
 * limits), each text recorded in the app's audit once it is sent (`text_sent`, on the `sms` channel, under
 * its key, or PAGE_TEXTS_ID with none).
 */
function pageTexts(t: TurnTexts, sink: AuditSink): Texts {
  return {
    async send(text) {
      const rows: TextRecord[] = [];
      const receipt = await recordingTexts(t.provider, t.from, t.keys, (r) => rows.push(r), t.limits ?? null).send(text);
      for (const r of rows) await sink.append(text.key ?? PAGE_TEXTS_ID, TEXT_CHANNEL, textAuditRow(r));
      return receipt;
    },
  };
}

/** One app the server runs, with its environment (the references its YAML names) and its settings (what its code reads). */
interface AppRun<A extends HostedApp> {
  readonly id: string;
  readonly app: A;
  readonly env: Env;
  readonly settings: Env;
  readonly dir?: string;
  readonly services?: Readonly<Record<string, string>>;
  readonly ignored?: readonly string[];
  readonly own?: readonly string[];
}

export async function startServer(config: ServerConfig, overrides: ServerOverrides = {}): Promise<RunningServer> {
  const said = overrides.log ?? ((line: string) => console.log(`[server] ${line}`));
  // With SESSION_STORE=postgres, every line is said with the connection string's password taken out,
  // whatever a driver's message held. Otherwise every line as it was.
  const storeUrl = config.sessionStore?.kind === 'postgres' ? config.sessionStore.url : null;
  const secretUrls = [storeUrl, config.auditStore?.url ?? null].filter((u): u is string => u !== null);
  const log = secretUrls.length === 0 ? said : (line: string): void => said(secretUrls.reduce((l, u) => maskSecrets(l, u), line));
  const now = overrides.now ?? (() => Date.now());
  // The one threshold the phone line sets from its environment: the ask budget is a property of the
  // deployment's network and the day's question count, not of the dialogue policy.
  const thresholds = { ...DEFAULT_THRESHOLDS, JEV_TIMEOUT_MS: config.jevTimeoutMs };
  // A client that answers by an app's own heuristics (JEV_CLIENT=heuristic or stub) is one per app on a
  // host (below); every other client asks a model, which knows no app, and is shared.
  const perAppClient = overrides.apps !== undefined && overrides.client === undefined && (config.jevClient === 'heuristic' || config.jevClient === 'stub');
  const client: JevClient | null = overrides.client ?? (perAppClient ? null : buildClient(config.jevClient, undefined, thresholds, undefined, config.jevProvider ?? undefined));
  // Which model answers, and once, for a model that is not Jev, that the thresholds were measured on Jev.
  for (const line of modelHeader(config.jevClient, config.jevProvider)) log(line);
  // Wall-clock date in the configured zone: a caller at 8pm Pacific means today, not tomorrow.
  const todayIso = () => config.todayOverride ?? localDateIso(now(), config.timezone);

  // The apps this server runs: its one (the default, its references read from `env`, as always), or a
  // host's (host.yaml, server/host.ts), each with its own environment. Each per-app line below is said as
  // it always was for one app, and with `app <id>: ` in front of it for each of a host's.
  const host = overrides.apps ?? null;
  // `settings` is what each app's code reads by name (AppContext.env): on a host, its own settings file over
  // the server's; on a server of one, its environment.
  const hosted: readonly AppRun<HostedApp>[] = host
    ? host.apps.map((a) => ({ id: a.id, app: a.app, env: a.env, settings: a.settings ?? a.env, ...(a.dir !== undefined ? { dir: a.dir } : {}), ...(a.services ? { services: a.services } : {}), ignored: a.ignored, own: a.own }))
    : [{ id: defaultAppId(), app: getApp(defaultAppId()), env: overrides.env ?? process.env, settings: overrides.env ?? process.env }];
  // A converse app (src/converse) runs on its own runtime: its chat (chatOf, below), its audit, traces and
  // texts. Everything else the server does per app (the phone line, the decision model's corpus, clips,
  // generated wording, pages, the console's metadata) is a scripted app's, over `appsRun`.
  const appsRun: readonly AppRun<App>[] = hosted.filter((a): a is AppRun<App> => !isConverseApp(a.app));
  const conversesRun: readonly AppRun<ConverseApp>[] = hosted.filter((a): a is AppRun<ConverseApp> => isConverseApp(a.app));
  const tag = (id: string): string => (host ? `app ${id}: ` : '');
  /** A call's app: on a host, the one of this id (the default for one it does not run); on a server of one, its one app. */
  const appRun = (id: string | undefined): (typeof appsRun)[number] => (host && id !== undefined ? appsRun.find((a) => a.id === id) : undefined) ?? appsRun[0]!;
  /** A call's or a chat's app of any runtime, as appRun: on a host, the one of this id (else the default); on a server of one, its one app. */
  const hostedOf = (id: string | undefined): (typeof hosted)[number] => (host && id !== undefined ? hosted.find((a) => a.id === id) : undefined) ?? hosted[0]!;
  /** What an app's settings stop the server for (an unset variable, say): on a host, with the app's id in front. */
  const forApp = <T>(id: string, read: () => T): T => {
    try {
      return read();
    } catch (err) {
      if (!host) throw err;
      throw new Error(`app "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (host) {
    for (const line of describeHost(host)) log(line);
    for (const warning of host.warnings) log(`WARNING: ${warning}`);
    // What an app's own settings file sets and its YAML does not name: its code's (ctx.env), not the
    // server's, said by name only.
    for (const a of hosted) {
      if (!a.ignored || a.ignored.length === 0) continue;
      const { warn, info } = ownSettingsLines('its own settings file', a.ignored);
      if (warn !== null) log(`WARNING: ${tag(a.id)}${warn}: ${OWN_SERVER_SETTING_FIX}`);
      if (info !== null) log(`${tag(a.id)}${info}`);
    }
  }
  // A converse app answers chats only: its calls (the phone on the converse runtime) are not built yet. A
  // server of converse apps alone answers no carrier, whatever VOICE_PROVIDERS says; on a host with a
  // scripted app, a number (or the default) that would put a call through to a converse app stops it here.
  const voiceRefused = conversesRun.length > 0 && appsRun.length === 0 && config.voiceProviders.length > 0;
  if (host && conversesRun.length > 0 && appsRun.length > 0 && config.voiceProviders.length > 0) {
    for (const a of conversesRun) {
      const why = a.id === host.defaultApp ? 'it is host.yaml\'s defaultApp, which takes every call to a number no app is listed for'
        : host.numbers.some((n) => n.app === a.id) ? `host.yaml lists ${host.numbers.filter((n) => n.app === a.id).map((n) => n.variable).join(', ')} for it` : null;
      if (why !== null) throw new Error(`app "${a.id}" is a converse app, which takes no calls yet (its chat only), but ${why}: make a scripted app the default and list no number for "${a.id}", or set VOICE_PROVIDERS=none`);
    }
  }
  for (const a of conversesRun) {
    const how = voiceRefused ? `WARNING: ${tag(a.id)}a converse app, which takes no calls yet: its chat only, and the server answers no carrier (VOICE_PROVIDERS=${config.voiceProviders.join(',')} set aside)`
      : `${tag(a.id)}a converse app: its chat on the converse runtime (${a.app.business.model.default}); it takes no calls yet`;
    log(how);
  }
  // Each converse app's model: agent.yaml's model.default with its key from the app's own settings (a test's fake).
  const converseModels = new Map<string, ConverseModel>(conversesRun.map((a) => [a.id, forApp(a.id, () => overrides.converseModel?.(a.id) ?? resolveConverseModel(a.app.business.model.default, a.settings))]));
  // Each app's client, when it answers by the app's own heuristics: its own fixtures' corpus for the stub
  // (from the app's package, as its regression reads it), the heuristics alone where it has none.
  const clients = new Map<string, JevClient>();
  if (perAppClient) {
    for (const a of appsRun) {
      const corpus = config.jevClient === 'stub' ? corpusOf(a.app, a.dir) : null;
      if (config.jevClient === 'stub' && corpus === null) log(`${tag(a.id)}JEV_CLIENT=stub: no corpus in its fixtures, so its heuristics answer alone`);
      clients.set(a.id, buildClient(corpus === null ? 'heuristic' : 'stub', corpus ?? undefined, thresholds, undefined, config.jevProvider ?? undefined, a.app));
    }
    // A converse app asks the decision model only to read a caller's answer to a read-back: the heuristics
    // read no such answer, so under a stub no read-back is ever confirmed.
    for (const a of conversesRun) {
      log(`WARNING: ${tag(a.id)}JEV_CLIENT=${config.jevClient}: a converse app's read-backs are read by the decision model, and the heuristics read none as a yes: run it with JEV_CLIENT=jev`);
      clients.set(a.id, buildClient('heuristic', undefined, thresholds, undefined, config.jevProvider ?? undefined));
    }
  }
  /** The client a call in this app asks: its own (above), else the server's one. */
  const clientOf = (id: string): JevClient => clients.get(id) ?? client!;
  // Each app's own tools: its systems (and the gate's lookups over them), with the code verifier, made
  // once for the process so a record made on one call can be read on the next, as for one app.
  const toolsByApp = new Map(appsRun.map((a) => [a.id, host ? { ...a.app.systems(), codes: mockCodeVerifier } : demoTools()]));
  /** A call's tools: its app's. */
  const toolsOf = (id: string): Tools => toolsByApp.get(appRun(id).id)!;
  // Where a handoff goes when an app has no transfer target: HANDOFF_NUMBER, on a host the app's own when
  // its settings file gives one, else the server's.
  const handoffs = new Map(appsRun.map((a) => [a.id, host ? forApp(a.id, () => handoffNumberOf(a.env, config.handoffNumber)) : config.handoffNumber]));
  const handoffOf = (id: string): string => handoffs.get(appRun(id).id)!;
  /** Where an app's recorded clips are: AUDIO_DIR; on a host, a folder per app in it, served at /audio/<app id>/. */
  const audioDirOf = (id: string): string => (host ? join(config.audioDir, id) : config.audioDir);
  /** Each clip's length, by its file name (on a host, `<app id>/<file>`), for the no-input wait after a played line. */
  const durations = new Map<string, number>();
  for (const a of appsRun) for (const [name, ms] of clipDurations(audioDirOf(a.id))) durations.set(host ? `${a.id}/${name}` : name, ms);
  // CLIPS=off leaves the render context unset, which is the harness's own mode: every prompt goes
  // out as text and ConversationRelay's voice speaks the fixed words, the names and the dates
  // alike. Nothing about the recorded clips matters then, so the presence/staleness checks below
  // (and the disk read they depend on) only run when CLIPS=on; off gets a single quiet line.
  const renders = new Map<string, RenderContext>();
  if (config.clips) {
    for (const a of appsRun) {
      const dir = audioDirOf(a.id);
      const clips = discoverClips(dir);
      let recorded: Record<string, string> | null;
      try {
        recorded = readRecorded(dir);
      } catch (e) {
        log(`${tag(a.id)}audio: ignoring unreadable recorded.json: ${e instanceof Error ? e.message : String(e)}`);
        recorded = null;
      }
      const cov = clipStatus(recordableClips(a.app), clips, recorded);
      const missingSuffix =
        cov.missing.length === 0
          ? ''
          : `: missing ${cov.missing.slice(0, 10).join(', ')}${cov.missing.length > 10 ? ` +${cov.missing.length - 10} more` : ''}`;
      log(`${tag(a.id)}audio: ${cov.present} of ${cov.total} clips present in ${dir} (${cov.missing.length} segments fall back to TTS)${missingSuffix}`);
      if (cov.stale.length > 0) {
        log(`${tag(a.id)}audio: ${cov.stale.length} stale clips (recorded text differs from the sheet): ${cov.stale.join(', ')}`);
      }
      // The presence/count logic above stays on the unversioned map; only what the caller actually
      // fetches carries the content hash, so a regenerated clip is never served from Twilio's cache.
      renders.set(a.id, { clips: clipVersions(dir, clips), audioBase: `https://${config.publicHost}/audio/${host ? `${a.id}/` : ''}` });
    }
  } else {
    const carriers = config.voiceProviders.map((id) => id.charAt(0).toUpperCase() + id.slice(1)).join(', ');
    log(carriers === '' ? 'clips: off (no phone line)' : `clips: off (every prompt spoken by the carrier's TTS voice: ${carriers})`);
  }
  const noInputMs = overrides.noInputMs ?? config.noInputMs;
  log(noInputMs > 0 ? `no-input: ${noInputMs} ms after playback (${durations.size} clip durations)` : 'no-input: off');
  const renderOf = (id: string): RenderContext | null => renders.get(id) ?? null;
  // Generated wording: each app that generates a line (App.generated) words it through its renderer,
  // from its own settings; an app that generates none has none, and every line of it is as it was.
  const renderers = new Map<string, Renderer>();
  for (const a of appsRun) {
    // A slot the records mask whose words a model summarizes (redact: length-summarized): no caller's words are kept.
    const masked = Object.keys(a.app.slots).filter((id) => a.app.slots[id]!.summarized === true);
    if (masked.length > 0) log(`${tag(a.id)}frame log and trace keep no caller words (${masked.map((id) => `slot ${id}`).join(', ')}: length-summarized)`);
    if (!generatesLines(a.app)) continue;
    const lines = Object.keys(a.app.generated!.lines).length;
    if (overrides.renderer) {
      renderers.set(a.id, overrides.renderer);
      continue;
    }
    // The app's own model (style.yaml's `model`) under the app's settings; named without its key, every line is said fixed.
    const model = a.app.generated!.model;
    const missing = appModelKeyMissing(a.env, model);
    if (missing !== null) {
      log(`WARNING: ${tag(a.id)}generated wording: ${lines} line${lines === 1 ? '' : 's'} generated by ${appModelLabel(model!)}, but ${missing} is unset: every line said fixed`);
      continue;
    }
    const provider = forApp(a.id, () => resolveAppRenderProvider(a.env, model));
    if (provider === null) {
      log(`${tag(a.id)}generated wording: ${lines} line${lines === 1 ? '' : 's'} generated, RENDER_PROVIDER unset: every line said fixed`);
      continue;
    }
    // The price's default is the model's own where the engine knows it (Mercury 3's, say), so the trace and Insights cost it right.
    const settings = forApp(a.id, () => renderSettings(a.env, provider.model));
    renderers.set(a.id, { client: new ModelRenderClient(provider), share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, answerTimeoutMs: settings.answerTimeoutMs, documentsTimeoutMs: settings.documentsTimeoutMs, price: settings.price });
    const how = providerSettingsLabel(provider);
    log(`${tag(a.id)}generated wording: ${lines} line${lines === 1 ? '' : 's'} worded by ${provider.model} from ${provider.provider} (${renderModelSourceLabel(renderModelSource(a.env, model))}${how !== null ? `; ${how}` : ''}), ${settings.share}% of calls, within ${settings.timeoutMs.voice} ms on a call and ${settings.timeoutMs.chat} ms in a chat, its checks ${settings.checkTimeoutMs.voice} and ${settings.checkTimeoutMs.chat} ms`);
    // A temperature Inception would reset silently is held to its range (render/providers.ts), and said so here.
    const clamped = inceptionTemperatureNotes(provider, model);
    if (clamped.length > 0) log(`WARNING: ${tag(a.id)}generated wording: ${clamped.join(', ')}, as Inception takes 0.5 to 1`);
  }
  const rendererOf = (id: string): Renderer | null => renderers.get(appRun(id).id) ?? null;
  // Agent mode: each app in it asks its agent model (style.yaml's `agent`) through its own settings.
  const agents = new Map<string, AgentRunner>();
  for (const a of appsRun) {
    if (a.app.mode !== 'agent' || a.app.agent === undefined) continue;
    const settings = forApp(a.id, () => agentSettings(a.env));
    // The drift judge's budget on an agent reply, RENDER_CHECK_TIMEOUT_MS, as on a generated line.
    const checkTimeoutMs = forApp(a.id, () => renderSettings(a.env).checkTimeoutMs);
    if (overrides.agent) {
      agents.set(a.id, { ...overrides.agent, timeoutMs: overrides.agent.timeoutMs ?? settings.timeoutMs, checkTimeoutMs: overrides.agent.checkTimeoutMs ?? checkTimeoutMs, retry: overrides.agent.retry ?? settings.retry });
      continue;
    }
    const model = a.app.agent.model;
    const keyVar = agentKeyVar(model);
    if (!a.env[keyVar]?.trim()) {
      log(`WARNING: ${tag(a.id)}agent mode: ${model.model} on ${model.provider} (style.yaml's agent), but ${keyVar} is unset: the app runs as a scripted app, on its fixed questions with the decision model understanding (pnpm diagnose fails)`);
      continue;
    }
    agents.set(a.id, { client: forApp(a.id, () => appAgentClient(a.env, model)), timeoutMs: settings.timeoutMs, checkTimeoutMs, price: defaultRenderPrice(model.model), retry: settings.retry });
    log(`${tag(a.id)}agent mode: ${model.model} on ${model.provider} at ${model.effort}, within ${settings.timeoutMs.voice} ms on a call and ${settings.timeoutMs.chat} ms in a chat, its judge ${checkTimeoutMs.voice} and ${checkTimeoutMs.chat} ms, ${settings.retry ? 'an answer not in its shape or refused by a content filter asked again once where time allows' : 'an answer not in its shape not asked again (AGENT_RETRY=off)'}${a.app.agent.waiting !== undefined ? `, on a call a line after ${a.app.agent.waiting.afterMs} ms and a wait up to ${Math.max(a.app.agent.waiting.upToMs, settings.timeoutMs.voice)} ms (business.yaml waiting)` : ''}`);
  }
  const agentOf = (id: string): AgentRunner | null => agents.get(appRun(id).id) ?? null;

  // Texts: each app's sender, from TEXT_FROM (on a host, the app's own settings file's), through Twilio's
  // Messages API with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (texts/settings.ts). TEXT_FROM unset is no
  // sender: the app's code has none (ToolContext.texts), and no text is sent, as before.
  const textSenders = new Map<string, TurnTexts>();
  let textSecret: string | null = config.providerSecrets.twilio ?? null;
  for (const a of hosted) {
    const t = forApp(a.id, () => textSettings(a.env));
    if (t === null) {
      if (a.app.onText !== undefined) log(`${tag(a.id)}texts: TEXT_FROM unset: a text that comes in (${MESSAGES_PATH}) is recorded and handed to the app, which can send none`);
      continue;
    }
    textSecret ??= t.authToken;
    const provider = overrides.textProvider ?? twilioTextProvider({ accountSid: t.accountSid, authToken: t.authToken });
    textSenders.set(a.id, { provider, from: t.from, keys: new TextKeys(), limits: new TextLimits(t.limits, now) });
    log(`${tag(a.id)}texts: sent from ...${lastFour(t.from)} through ${provider.id === 'twilio' ? 'Twilio\'s Messages API' : provider.id}; texts that come in: ${MESSAGES_PATH}`);
  }
  const textsOf = (id: string): TurnTexts | null => textSenders.get(hostedOf(id).id) ?? null;

  const serviceUrls = overrides.serviceUrls ?? {};
  // Each app's services' URLs: a server of one's from its launcher (ServerOverrides.serviceUrls); on a host,
  // from host.yaml's `services` (each variable read from the app's own settings), and the launcher's for the
  // default app alone, so two apps' services of one name never share a URL.
  const servicesByApp = new Map<string, ServiceUrls>(appsRun.map((a) => {
    if (!host) return [a.id, serviceUrls];
    const own: Record<string, string> = {};
    for (const [name, variable] of Object.entries(a.services ?? {})) {
      const url = a.env[variable]?.trim();
      if (url) own[name] = url;
    }
    return [a.id, { ...(a.id === host.defaultApp ? serviceUrls : {}), ...own }];
  }));
  const serviceUrlsOf = (id: string): ServiceUrls => servicesByApp.get(appRun(id).id)!;
  for (const a of appsRun) {
    for (const name of Object.keys(a.app.services ?? {})) {
      const url = serviceUrlsOf(a.id)[name] ?? null;
      // On a host, a service with no URL is worth a warning: unless it needs none (one in the process), its
      // requests are answered with no result, and nothing else would say so.
      log(url ? `${tag(a.id)}service ${name}: ${url}` : host
        ? `WARNING: ${tag(a.id)}service ${name}: no URL (host.yaml's services names none for it), so its requests are answered with no result unless it needs none`
        : `${tag(a.id)}service ${name}: off (its requests are answered with no result)`);
    }
  }

  const bus = config.dashboard ? new DashboardBus() : undefined;
  log(bus ? 'dashboard: /dashboard' : 'dashboard: off');
  // The console's Health page shows the decision model's latency over the last hour: watched from the start.
  if (bus) latencyOf(bus);
  // The reconnects and fallback dials this server answers today (in TIMEZONE's day), for the Health page.
  const counters = new DayCounters(() => localDateIso(now(), config.timezone));

  // Annotated because the factory below hands `store` to `makeObserver`, and an inferred type
  // would be circular: the initializer references the very binding it is initializing.
  // SESSION_STORE=postgres://...: the connection, opened now (the pg driver connects on the first
  // question), so AUDIT_STORE may share it; the stores on it are opened below, with the file store's.
  const setting0 = config.sessionStore;
  // This server's name: the lease owner, its trace segments' and its audit anchors' server. SERVER_ID
  // with a random suffix per process, so two processes given one name never share a hold.
  const serverName = `${(setting0?.kind === 'postgres' ? setting0.serverId : undefined) ?? config.serverId ?? 'server'}-${randomBytes(4).toString('hex')}`;
  const sessionSql: SqlClient | null = setting0?.kind === 'postgres'
    ? (overrides.sessionSql ?? (await openPgClient(setting0.url, { log, queryTimeoutMs: setting0.timeoutMs, max: SESSION_POOL })))
    : null;
  // AUDIT_STORE=postgres://...: the audit in a database, a chain per call anchored into a chain per day;
  // on SESSION_STORE's connection when it names the same database. Unset, one chain per day file, as always.
  const auditSetting = config.auditStore;
  const auditSql: SqlClient | null = auditSetting
    ? (overrides.auditSql ?? (sessionSql !== null && setting0?.kind === 'postgres' && setting0.url === auditSetting.url
      ? sessionSql
      : await openPgClient(auditSetting.url, { log, queryTimeoutMs: auditSetting.timeoutMs, max: AUDIT_POOL })))
    : null;
  /** The connections opened here, closed once whatever happens: a failed start, or close(). */
  const closeAuditSql = async (): Promise<void> => {
    if (auditSql !== null && auditSql !== sessionSql) await auditSql.close().catch(() => undefined);
  };
  let postgresAudit: PostgresAuditLog | null = null;
  if (auditSql !== null && auditSetting) {
    try {
      postgresAudit = await openPostgresAudit(auditSql, { now, timeoutMs: auditSetting.timeoutMs, log, server: serverName });
    } catch (err) {
      await closeAuditSql();
      await sessionSql?.close().catch(() => undefined);
      throw postgresFailure('AUDIT_STORE', auditSetting.url, err);
    }
    log(`audit: ${maskConnectionString(auditSetting.url)} (shared: a hash chain per call, each anchored into a chain per day; pnpm audit:verify reads it)`);
  }
  // One audit chain for the process: every call's entries link into the same day file. On a host, the
  // server's own (the console's sign-ins and replays) in AUDIT_DIR/_server, and each app's calls in a
  // chain of its own, AUDIT_DIR/<app id> (or, in Postgres, a chain per call as always), each entry
  // naming its app.
  const audit: AuditSink = postgresAudit ?? new AuditLog(host ? join(config.auditDir, SERVER_RECORDS) : config.auditDir, now);
  const audits = new Map<string, AuditSink>();
  for (const a of hosted) audits.set(a.id, host ? appAudit(postgresAudit ?? new AuditLog(join(config.auditDir, a.id), now), a.id) : audit);
  /** A call's audit chain: its app's. */
  const auditOf = (id: string | undefined): AuditSink => audits.get(hostedOf(id).id)!;
  // CONSOLE_AUTH=token: the console's sign-in, whose first link is made once the server listens. Made
  // before anything that would need closing, as it reads the sign-outs a run before kept and may refuse them.
  let consoleAuth: ConsoleAuth | undefined;
  try {
    consoleAuth = config.consoleAuth && bus ? new ConsoleAuth({ settings: config.consoleAuth, publicHost: config.publicHost, audit, now, log }) : undefined;
  } catch (err) {
    await closeAuditSql();
    await sessionSql?.close().catch(() => undefined);
    throw err;
  }
  // SESSION_STORE=file:<dir>: calls, chats and relay tokens saved in a folder, so a restart resumes a
  // call whose carrier calls back. Unset (memory), nothing is saved, as it always was.
  const setting = config.sessionStore;
  const files = setting?.kind === 'file'
    ? openFileStores(resolvePath(setting.dir), { tokenTtlMs: TOKEN_TTL_MS, now, log, fsync: setting.fsync === true })
    : null;
  if (files) log(`sessions: file:${files.dir} (calls, chats and relay tokens are saved after every turn, and a restart resumes them)`);
  // SESSION_STORE=postgres://...: the same in a database many servers share, each call held by one
  // server at a time under a lease this server renews while the call is live.
  const shared = setting?.kind === 'postgres' && sessionSql !== null
    ? await openShared(setting.url, setting.timeoutMs, sessionSql, now, log).catch(async (err: unknown) => {
      await closeAuditSql();
      throw err;
    })
    : null;
  const leaseMs = setting?.kind === 'postgres' ? setting.leaseMs : 0;
  const owner = setting?.kind === 'postgres' ? serverName : '';
  if (shared && setting?.kind === 'postgres') {
    log(`sessions: ${maskConnectionString(setting.url)} (shared: calls, chats and relay tokens are saved after every turn, and any server the carrier reconnects to takes a call over); this server is ${owner}, holding each call ${leaseMs} ms at a time`);
  }
  const durable: { calls: CallStateStore; chats: ChatStateStore; tokens: ServerTokenStore } | null = files ?? shared;
  // With SESSION_STORE=postgres: which server runs a sweep they share (stores/sweeps.ts).
  const sweeps = shared && sessionSql ? await openSweeps(boundedSql(sessionSql, setting?.kind === 'postgres' ? setting.timeoutMs : 2_000)).catch(async (err: unknown) => {
    await shared.close().catch(() => undefined);
    await closeAuditSql();
    throw postgresFailure('SESSION_STORE', setting?.kind === 'postgres' ? setting.url : '', err);
  }) : null;
  // With SESSION_STORE=postgres: notices between the servers on the database (stores/notices.ts), so one
  // console sees every server's calls and a chat resumed elsewhere is let go here.
  let notices: PostgresNotices | null = null;
  /** The other servers heard from (with notices), and this server's report of itself: for the console's Health page. */
  const serversSeen = new ServersSeen(now);
  let reporter: ReturnType<typeof setInterval> | null = null;
  let reportNow: (() => void) | null = null;
  // Read when a report is sent, by which time the store and the chat below are made.
  const selfReport = (): ServerReport => ({ server: serverName, calls: store.liveCount(), chats: chat?.liveCount() ?? 0, ...counters.now() });
  if (shared && sessionSql && setting?.kind === 'postgres') {
    try {
      notices = await PostgresNotices.open(sessionSql, { origin: owner, log, now, timeoutMs: setting.timeoutMs });
    } catch (err) {
      await shared.close().catch(() => undefined);
      await closeAuditSql();
      throw postgresFailure('SESSION_STORE', setting.url, err);
    }
    // Each server says it is up every REPORT_EVERY_MS, with its calls and today's reconnects and fallback
    // dials, so every console's Health page lists the servers on the database (dashboard/health.ts).
    // (The reports start once the server listens, below.) A server heard from for the first time (one that
    // just started) is answered with this one's report at once, so it lists every server without waiting.
    notices.subscribe('server', (body, origin) => {
      const first = !serversSeen.knows(origin);
      serversSeen.heard(origin, body);
      if (first) reportNow?.();
    });
    if (bus) {
      const linked = notices;
      // Each event as this server's console has it (already redacted), to the others' consoles, and theirs to this one.
      bus.link((event) => linked.publish('console', JSON.stringify(event)));
      linked.subscribe('console', (body) => {
        let event: DashboardEvent;
        try {
          event = JSON.parse(body) as DashboardEvent;
        } catch {
          return;
        }
        bus.receive(event);
      });
    }
  }
  // TRACE_STORE=s3://...: each call's trace and frame log as segments on S3-compatible storage, which
  // this server writes under its own name and every reader joins. Unset, files in TRACE_DIR, as always.
  // On a host, each app's under a prefix of its own (<prefix><app id>/).
  const traceStores = new Map<string, S3TraceStore>();
  if (config.traceStore) {
    for (const a of hosted) {
      const setting = host ? { ...config.traceStore, prefix: `${config.traceStore.prefix}${a.id}/` } : config.traceStore;
      // A converse app's records are written as its turns masked them: no app's slots to mask them by.
      const scripted = isConverseApp(a.app) ? undefined : a.app;
      const store = new S3TraceStore(setting, { server: serverName, log, now, ...(overrides.traceFetch ? { fetch: overrides.traceFetch } : {}), ...(host && scripted ? { app: scripted } : {}) });
      traceStores.set(a.id, store);
      log(`${tag(a.id)}traces: ${store.label}, written as segments by this server (${serverName}) and read back joined`);
    }
  }
  /** Where an app's trace files are: TRACE_DIR; on a host, a folder per app in it. */
  const traceDirOf = (id: string): string => (host ? join(config.traceDir, id) : config.traceDir);
  /** A call's (or a chat's) trace and frame log, in its app's: files in TRACE_DIR, or segments on the trace store. */
  // On one machine, a trace or frame log that cannot be written is logged and counted, and never fails a turn.
  const traceFailures = new TraceFailures(log, now);
  const sinksOf = (file: string, meta: () => CallMeta, appId: string): { trace: TraceSink; frames: FrameSink } => {
    const store = traceStores.get(appId);
    if (store) return store.open(file, meta);
    const dir = traceDirOf(appId);
    // On a host, each record masked by its own app's slots; on a server of one, by its one app's, as always.
    // A converse app's records are written as its turns masked them (trace/writer.ts traceLine).
    const own = hostedOf(appId).app;
    const trace = guardTrace(() => (host && !isConverseApp(own) ? new TraceWriter(join(dir, `${file}.jsonl`), own) : new TraceWriter(join(dir, `${file}.jsonl`))), traceFailures, `the trace of ${file}`);
    return { trace, frames: guardFrames(() => new FrameLog(join(dir, `${file}.frames.jsonl`), now), traceFailures, `the frame log of ${file}`) };
  };
  // The numbers called conditions compare the number dialed with (routes.yaml, transfer targets), read
  // now, before any call: one unset, or not E.164, stops the server here. Each turn reads these values
  // and nothing else of the environment (TurnContext.env). On a host, each app's from its own environment.
  const calledByApp = new Map(appsRun.map((a) => [a.id, forApp(a.id, () => calledVariablesFrom(a.app, a.env))]));
  const calledOf = (id: string): Readonly<Record<string, string>> => calledByApp.get(id)!;
  /** RESTART_PAUSE_S with a durable store: how long a planned restart's handover asks each carrier to wait; 0 with none. */
  const restartPauseS = config.sessionStore?.restartPauseS ?? 0;
  const store: SessionStore = new SessionStore(
    (callSid, appId) => {
      // On a host, the call's app (the one its number reached, or the one it was saved in); else the one app.
      const a = appRun(appId);
      const file = safeFileStem(callSid);
      // What the trace store names this call's segments by. Held while the entry the store has for the call
      // is this one: once it was and is no longer (let go, taken over), what it still writes is marked late.
      let mine: TraceSink | null = null;
      let seen = false;
      let last: Omit<CallMeta, 'held'> = { turn: 0, gen: 0, startedAtMs: now() };
      const meta = (): CallMeta => {
        const e = store.get(callSid);
        const isMine = e !== undefined && mine !== null && e.trace === mine;
        if (isMine) {
          seen = true;
          last = { turn: e.session.turnIndex, gen: e.reconnects, startedAtMs: e.session.startedAtMs };
        }
        return { ...last, held: !store.shared || isMine || !seen };
      };
      const { trace, frames } = sinksOf(file, meta, a.id);
      mine = trace;
      const observe: TurnObserver | null = bus ? makeObserver(bus, store, callSid) : null;
      return {
        session: host ? newSession(callSid, now(), VOICE_RELAY, ANONYMOUS, a.id) : newSession(callSid, now(), VOICE_RELAY),
        opts: { client: clientOf(a.id), thresholds, todayIso: todayIso(), trace, now, render: renderOf(a.id), renderer: rendererOf(a.id), agent: agentOf(a.id), observe, tools: toolsOf(a.id), audit: auditOf(a.id), screen: config.screen, env: calledOf(a.id), settings: a.settings, texts: textsOf(a.id) },
        trace,
        frames,
      };
    },
    config.sessionTtlMs,
    now,
    config.sessionMaxAgeMs,
    { state: durable?.calls ?? null, lease: shared && setting?.kind === 'postgres' ? { leases: shared.calls, owner, ttlMs: leaseMs, timeoutMs: setting.timeoutMs } : null, log },
  );
  const tokens: ServerTokenStore = durable?.tokens ?? new CallTokens(TOKEN_TTL_MS, now);
  /**
   * The calls saved before a restart whose carrier never called back, forgotten once past their time:
   * the one end of such a call nothing else sees, so it is recorded here, as the idle sweep records an
   * evicted call's.
   */
  const sweepSaved = (): void => {
    void store.sweepStored().then((gone) => {
      for (const c of gone) {
        log(`${c.callId}: saved before a restart and never called back; forgotten`);
        whenChained(auditOf(c.session.appId).append(c.callId, c.session.channel, { type: 'call_ended', detail: { reason: 'evicted' } }), () => {},
          (err: unknown) => log(`${c.callId}: the evicted call's audit entry failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  };
  if (durable) sweepSaved();
  // The app's pages share the phone line's client, book of business, audit chain and console. On a host,
  // a launcher's own pages are its default app's: that app's client, tools, audit, traces and services.
  // (A server of converse apps alone has no scripted app for a launcher's pages: it mounts none.)
  const routesApp = appsRun[0]?.id;
  const mounted = (routesApp === undefined ? undefined : overrides.routes?.({
    config, client: clientOf(routesApp), thresholds, todayIso, tools: toolsOf(routesApp), audit: auditOf(routesApp), bus, traceDir: traceDirOf(routesApp), serviceUrls: serviceUrlsOf(routesApp), log, now,
    anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
  })) ?? { routes: [] };
  // Each app's own pages (App.pages), under /<app id>, on a server of one and a host's alike: each with
  // its own app's client, tools, audit, traces and services, and its own settings (ctx.env's).
  const pageWarnings: string[] = [];
  const pages = appsRun.flatMap((a) => {
    const factory = a.app.pages as AppPagesFactory | undefined;
    const base = appPagesBase(a.id);
    const chatPath = host ? `${CHAT_PATH}/${a.id}` : CHAT_PATH;
    // The engine's chat page (app.yaml's chat.page), unless the app serves a page of its own at its path.
    const ownPage = (routes: readonly AppRoute[]): boolean => routes.some((r) => routeOwns(r, CHAT_PAGE_PATH) || routeOwns({ path: CHAT_PAGE_PATH }, r.path));
    const builtIn = (own: readonly AppRoute[]): AppRoute[] => {
      if (ownPage(own)) return [];
      const made = forApp(a.id, () => chatPageRoutes({ app: a.app, base, chatPath, env: (name: string) => a.settings[name], chat: config.chat !== undefined, widget: config.widget !== undefined }));
      for (const w of made.warnings ?? []) pageWarnings.push(`${tag(a.id)}${w}`);
      return forApp(a.id, () => mountAppPages(base, made.routes));
    };
    if (factory === undefined) return builtIn([]);
    const built = forApp(a.id, () => factory({
      config, client: clientOf(a.id), thresholds, todayIso, tools: toolsOf(a.id), audit: auditOf(a.id), bus, traceDir: traceDirOf(a.id), serviceUrls: serviceUrlsOf(a.id), log, now,
      anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
      app: a.app, base, chatPath,
      ...(config.chat ? { chat: host ? forApp(a.id, () => chatSettingsOf(config.chat!, a.env)) : config.chat } : {}),
      env: (name: string) => a.settings[name],
      ...(textsOf(a.id) !== null ? { texts: pageTexts(textsOf(a.id)!, auditOf(a.id)) } : {}),
    }));
    for (const w of built.warnings ?? []) pageWarnings.push(`${tag(a.id)}${w}`);
    return [...forApp(a.id, () => mountAppPages(base, built.routes)), ...builtIn(built.routes)];
  });
  // A converse app's own pages (ConverseApp.pages, built by its code), under /<app id> as a scripted app's are.
  const conversePages = conversesRun.flatMap((a) => {
    for (const w of a.app.pages?.warnings ?? []) pageWarnings.push(`${tag(a.id)}${w}`);
    return a.app.pages === undefined ? [] : forApp(a.id, () => mountAppPages(appPagesBase(a.id), a.app.pages!.routes));
  });
  const routes = [...mounted.routes, ...pages, ...conversePages];
  validateRoutes(routes);
  if (bus || routes.some((r) => r.localOnly)) log(consoleExposure(config, localOnlyPaths(routes), routes.filter((r) => r.auth === 'console').map((r) => r.path)));
  for (const warning of [...(mounted.warnings ?? []), ...pageWarnings]) log(`WARNING: ${warning}`);
  // Each app's part of the webhooks: its hints, and app.yaml's startParameters and transfer targets read
  // from its environment now: an unset one, or a target neither a number nor a sip: URI, stops the server
  // here, with the fix.
  const httpApps = new Map<string, HttpApp & { readonly app: App; readonly hints: string; readonly startParameters: Readonly<Record<string, string>>; readonly transfer: ServerTransfer | null; readonly numbers: readonly NumberLocale[] }>();
  for (const a of appsRun) {
    // app.yaml's records: a caller's number or name kept whole needs the console behind sign-in, or the server stops here.
    const recordsLine = forApp(a.id, () => recordsSettingFor(a.app, config));
    if (recordsLine !== null) log(`${tag(a.id)}${recordsLine}`);
    const startParameters = forApp(a.id, () => startParametersFrom(a.app, a.env));
    if (Object.keys(startParameters).length > 0) log(`${tag(a.id)}start parameters: ${Object.keys(startParameters).join(', ')}`);
    const transfer = forApp(a.id, () => transferTargetsFrom(a.app, a.env, handoffOf(a.id)));
    if (transfer) log(`${tag(a.id)}transfer targets: ${[...transfer.numbers.keys()].join(', ')}; default ${transfer.defaultVariable}`);
    const called = calledOf(a.id);
    if (Object.keys(called).length > 0) log(`${tag(a.id)}called numbers: ${Object.keys(called).join(', ')}`);
    // voice.numbers, each env.<NAME> read from the app's environment: an unset one, or not E.164, stops the server here.
    const numbers = forApp(a.id, () => voiceNumbersFrom(a.app, a.env));
    if (numbers.length > 0) log(`${tag(a.id)}numbers by language: ${describeVoiceNumbers(numbers)}; any other number starts in ${defaultLocaleOf(a.app)}`);
    // An agent-mode app's accounts' numbers that name a setting: one unset is left out with a note; one not E.164 stops the server here.
    const accountSettings = forApp(a.id, () => accountSettingsFrom(a.app, a.env));
    if (accountSettings.set.length > 0) log(`${tag(a.id)}account numbers from settings: ${accountSettings.set.join(', ')}`);
    if (accountSettings.unset.length > 0) log(`${tag(a.id)}account numbers left out, their settings unset: ${accountSettings.unset.join(', ')}`);
    // On Telnyx, a language with no voice of its own beside one with a voice may keep the start language's
    // voice after a switch (http.ts telnyxUnvoicedLocales): worth saying until a live call shows otherwise.
    const unvoiced = config.voiceProviders.includes('telnyx') ? telnyxUnvoicedLocales(a.app, config.telnyxVoice) : [];
    if (unvoiced.length > 0) {
      log(`WARNING: ${tag(a.id)}on Telnyx, ${unvoiced.join(', ')} ${unvoiced.length === 1 ? 'has' : 'have'} no voice of ${unvoiced.length === 1 ? 'its' : 'their'} own while another locale has one: a call that starts in a voiced locale and switches may keep that voice (not yet checked on a live call); name a Telnyx voice for every locale in app.yaml (voice.locales.<tag>.voices.telnyx)`);
    }
    // What the carriers listed are sent of the app's languages (channel/speechLanguages.ts), as pnpm check
    // and pnpm diagnose say it: a tag with no region (Twilio refused one on a live call), and a language
    // heard by a recognizer that hears English only, the server's own for the default locale included.
    const speech = speechLocalesOfApp(a.app);
    const carriers = VOICE_PROVIDER_IDS.filter((id) => config.voiceProviders.includes(id));
    const bare = carriers.length > 0 ? bareSpeechTags(speech) : [];
    for (const locale of [...new Set(bare.map((b) => b.locale))]) {
      const mine = bare.filter((b) => b.locale === locale);
      const { message, fix } = bareTagFinding(locale, mine);
      // A bare tts is the <Language> code Twilio refused; a bare transcription alone is not yet seen on a call.
      const refused = carriers.includes('twilio') && mine.some((b) => b.field === 'tts');
      log(`WARNING: ${tag(a.id)}${message}${refused ? ': Twilio will refuse its calls\' start document' : ''}; ${fix}`);
    }
    for (const h of englishOnlyHearings(speech, (c) => recognitionFor(config, c), carriers)) {
      const { message, fix } = englishOnlyFinding(h, true);
      log(`WARNING: ${tag(a.id)}${message}; ${fix}`);
    }
    httpApps.set(a.id, { app: a.app, hints: buildHints(a.app), startParameters, transfer, audit: auditOf(a.id), handoffNumber: handoffOf(a.id), numbers });
    // On a host of several apps, an app with no transfer targets and no HANDOFF_NUMBER of its own puts its
    // callers through to the server's: worth saying, since another business's desk may answer.
    if (host && appsRun.length > 1 && !transfer && !hostOwns(a, 'HANDOFF_NUMBER')) {
      log(`WARNING: ${tag(a.id)}no transfer targets and no HANDOFF_NUMBER of its own: its handoffs go to the server's HANDOFF_NUMBER, as every such app's do; set HANDOFF_NUMBER in its own settings file`);
    }
  }
  // The default app's part of the webhooks; none on a server of converse apps alone, which takes no calls.
  const first = appsRun[0] === undefined ? undefined : httpApps.get(appsRun[0].id)!;
  const app = first?.app;
  const startParameters = first?.startParameters ?? {};
  const transfer = first?.transfer ?? null;
  const numbers = first?.numbers ?? [];
  let draining = false;
  /** Set by unready() (DRAIN_UNREADY_MS): /ready answers 503 while new calls are still answered. */
  let unready = false;
  /** Set once the drain's wait is over (or close() has begun): a live call's reconnect goes to the handoff number. */
  let closing = false;
  /**
   * A planned restart's handover, from the end of the drain's wait on (drain, with the file store and
   * RESTART_PAUSE_S above 0): the calls whose carrier has yet to call back, and what to do once none
   * has. Null otherwise.
   */
  let handover: { waiting: Set<string>; done: () => void } | null = null;
  // The engine's own web chat, when CHAT=on: each session with the phone line's client, tools, audit chain and console.
  // On a host, each app's at /chat/<app id>, and the default's at /chat too.
  const chatSettings = config.chat;
  // Each JWKS URL's keys fetched and cached once, whichever apps' chats share it.
  const jwks = new Map<string, (kid: string) => Promise<KeyObject | null>>();
  const keysFor = (url: string): ((kid: string) => Promise<KeyObject | null>) => {
    let keys = jwks.get(url);
    if (keys === undefined) {
      keys = jwksKeys({ url, fetch: overrides.chatFetch, nowMs: now, log });
      jwks.set(url, keys);
    }
    return keys;
  };
  /** What an app's chat transport needs, whichever runtime runs its chats. */
  const transportOf = (a: (typeof hosted)[number]): ChatTransportDeps => ({
    settings: host ? forApp(a.id, () => chatSettingsOf(chatSettings!, a.env)) : chatSettings!, now, log,
    startTimeoutMs: overrides.setupTimeoutMs, state: durable?.chats ?? null,
    ...(host ? { appId: a.id } : {}),
    ...(notices ? { peers: { announce: (id: string) => notices!.publish('chat', id), onTaken: (fn: (id: string, generation: number) => void) => void notices!.subscribe('chat', (id, _origin, n) => fn(id, n)) } } : {}),
  });
  /** An app's chat endpoint: the converse runtime for a converse app (each chat its model's), else the scripted. */
  const chatOf = (a: (typeof hosted)[number]): ChatEndpoint => (isConverseApp(a.app) ? converseChatOf(a as AppRun<ConverseApp>) : scriptedChatOf(a as AppRun<App>));
  const converseChatOf = (a: AppRun<ConverseApp>): ChatEndpoint => chatTransport(transportOf(a), converseChatRuntime({
    app: a.app, model: converseModels.get(a.id)!, jev: clientOf(a.id), jevTimeoutMs: thresholds.JEV_TIMEOUT_MS, audit: auditOf(a.id), texts: textsOf(a.id), now, log,
    resources: (id) => {
      const startedAtMs = now();
      // Its turns are its records (turnIndex), held here from its start: no session for the trace's names to read.
      return sinksOf(safeFileStem(id), () => ({ turn: 0, gen: 0, startedAtMs, held: true }), a.id);
    },
  }));
  const scriptedChatOf = (a: AppRun<App>): ChatEndpoint => chatEndpoint({
    ...transportOf(a), audit: auditOf(a.id), bus, serviceUrls: serviceUrlsOf(a.id),
    ...(host ? { keysFor } : {}),
    anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
    fetch: overrides.chatFetch,
    resources: (id, sessions) => {
      const file = safeFileStem(id);
      // As a call's (server/traceMeta.ts): the chat's last values once it leaves `sessions`, its restores as its generation.
      const names = chatTraceMeta(id, sessions, now);
      const { trace, frames } = sinksOf(file, names.meta, a.id);
      names.bind(frames);
      const observe: TurnObserver | null = bus ? makeObserver(bus, sessions, id) : null;
      // No render context: a chat shows a line's words, never a recorded clip.
      return {
        opts: { client: clientOf(a.id), thresholds, todayIso: todayIso(), trace, now, render: null, renderer: rendererOf(a.id), agent: agentOf(a.id), observe, tools: toolsOf(a.id), audit: auditOf(a.id), screen: config.screen, env: calledOf(a.id), settings: a.settings, texts: textsOf(a.id) },
        frames,
      };
    },
  });
  const chats = chatSettings && host ? chatByApp(new Map(hosted.map((a) => [a.id, chatOf(a)])), host.defaultApp) : null;
  const chat: ChatEndpoint | undefined = chatSettings ? (chats ?? chatOf(hosted[0]!)) : undefined;
  // Retention, when TRACE_RETENTION_DAYS, TRACE_MAX_GB or AUDIT_RETENTION_DAYS is set, and the free-space
  // warning with DISK_WARN_FREE_GB: a sweep (and a look at the disk) now and once an hour after.
  // On a host the same settings hold for every app, each app's folders swept as a server of one's are
  // (TRACE_MAX_GB bounds each app's traces), and the server's own audit by its days.
  const retentions: RetentionSettings[] = hosted.map((a) => ({
    traceDir: traceDirOf(a.id), auditDir: host ? join(config.auditDir, a.id) : config.auditDir, traceDays: config.traceRetentionDays, auditDays: config.auditRetentionDays, ...(config.figuresRetentionDays !== undefined ? { figuresDays: config.figuresRetentionDays } : {}),
    ...(config.traceMaxBytes !== undefined ? { traceMaxBytes: config.traceMaxBytes } : {}),
  }));
  if (host) {
    const own = join(config.auditDir, SERVER_RECORDS);
    retentions.push({ traceDir: own, auditDir: own, auditDays: config.auditRetentionDays });
  }
  const sweeping = config.traceRetentionDays !== undefined || config.auditRetentionDays !== undefined || config.traceMaxBytes !== undefined || config.figuresRetentionDays !== undefined;
  const retaining = sweeping || config.diskWarnFreeBytes !== undefined;
  const disk = retaining
    ? (host
      ? diskUsageCache(retentions.slice(0, hosted.length).map((r) => r.traceDir), retentions.map((r) => r.auditDir), now, undefined, config.diskWarnFreeBytes)
      : diskUsageCache(config.traceDir, config.auditDir, now, undefined, config.diskWarnFreeBytes))
    : null;
  let retentionAt = now();
  const sweepDisk = (): void => {
    retentionAt = now();
    // Never the traces of a live call or an open chat.
    const inUse = new Set([...store.liveCallSids(), ...(chat?.liveIds() ?? [])].map(safeFileStem));
    if (sweeping) {
      const r = retentions.map((one) => sweepRetention(one, { now: retentionAt, inUse })).reduce((a, b) => ({
        traceFiles: a.traceFiles + b.traceFiles, auditDays: a.auditDays + b.auditDays, figuresDays: (a.figuresDays ?? 0) + (b.figuresDays ?? 0),
        ...(a.trimmed || b.trimmed ? { trimmed: { files: (a.trimmed?.files ?? 0) + (b.trimmed?.files ?? 0), calls: (a.trimmed?.calls ?? 0) + (b.trimmed?.calls ?? 0) } } : {}),
      }));
      log(`retention: removed ${r.traceFiles} trace files, ${r.auditDays} audit days${r.trimmed ? ` (${r.trimmed.files} of them, ${r.trimmed.calls} calls, for TRACE_MAX_GB)` : ''}${config.figuresRetentionDays !== undefined ? `, ${r.figuresDays ?? 0} days of console figures` : ''}`);
    }
    // The audit in Postgres: a call's chain removed whole once its newest entry is past the days, and the days' anchors.
    const auditDays = config.auditRetentionDays;
    if (postgresAudit && auditDays !== undefined && auditSetting) {
      void postgresAudit.sweep(auditDays, retentionAt).then(
        (a) => log(`retention: removed ${a.days} audit days (${a.chains} call chains, ${a.entries} entries) from ${maskConnectionString(auditSetting.url)}`),
        (err: unknown) => log(`retention: could not sweep the audit in ${maskConnectionString(auditSetting.url)}: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // The traces on the store: whole day folders past the days, then the calls written least recently past the size.
    const traceDays = config.traceRetentionDays;
    const traceMax = config.traceMaxBytes;
    const figuresDays = config.figuresRetentionDays;
    if (traceStores.size > 0 && (traceDays !== undefined || traceMax !== undefined || figuresDays !== undefined)) {
      void (async () => {
        // With servers sharing a database, one of them sweeps the store each hour; the others skip.
        if (sweeps && !(await sweeps.claim('traces', serverName, TRACE_SWEEP_HOLD_MS))) return;
        // On a host, each app's prefix in turn.
        for (const traceStore of traceStores.values()) {
          try {
            if (figuresDays !== undefined) {
              const f = await traceStore.sweepFigures(figuresDays, retentionAt);
              if (f > 0) log(`retention: removed ${f} days of console figures from ${traceStore.label}`);
            }
            if (traceDays !== undefined) {
              const t = await traceStore.sweep(traceDays, retentionAt, inUse);
              log(`retention: removed ${t.objects} trace objects (${t.calls} calls) from ${traceStore.label}`);
            }
            if (traceMax !== undefined) {
              const t = await traceStore.trim(traceMax, inUse);
              if (t.calls > 0) log(`retention: removed ${t.objects} trace objects (${t.calls} calls) from ${traceStore.label} for TRACE_MAX_GB`);
            }
          } catch (err) {
            log(`retention: could not sweep ${traceStore.label}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })().catch((err: unknown) => log(`retention: could not sweep the trace store: ${err instanceof Error ? err.message : String(err)}`));
    }
    // The free space, with DISK_WARN_FREE_GB: said once an hour while it is low.
    const usage = disk?.();
    if (usage?.low === true && config.diskWarnFreeBytes !== undefined) {
      log(`WARNING: ${usage.freeBytes === null || usage.freeBytes === undefined ? 'unknown' : gb(usage.freeBytes)} free on the disk of the traces or the audit, under DISK_WARN_FREE_GB (${gb(config.diskWarnFreeBytes)}): free some space, or lower TRACE_RETENTION_DAYS or TRACE_MAX_GB`);
    }
  };
  if (retaining) {
    const kept = (days: number | undefined) => (days === undefined ? 'forever' : `${days} days`);
    if (sweeping) log(`retention: traces kept ${kept(config.traceRetentionDays)}${config.traceMaxBytes !== undefined ? ` and at most ${gb(config.traceMaxBytes)}` : ''}, audit days kept ${kept(config.auditRetentionDays)}${config.figuresRetentionDays !== undefined ? `, console figures kept ${config.figuresRetentionDays} days` : ''}`);
    if (config.figuresRetentionDays !== undefined && config.traceRetentionDays !== undefined && config.figuresRetentionDays < config.traceRetentionDays) {
      log(`WARNING: FIGURES_RETENTION_DAYS=${config.figuresRetentionDays} is shorter than TRACE_RETENTION_DAYS=${config.traceRetentionDays}: the console's Insights shows no day older than ${config.figuresRetentionDays} days, though its traces are still kept`);
    }
    if (config.auditRetentionDays !== undefined) {
      log(`WARNING: AUDIT_RETENTION_DAYS=${config.auditRetentionDays}: audit day files older than ${config.auditRetentionDays} days are deleted, which ends the record for those days`);
    }
    sweepDisk();
  }
  /**
   * The app a text that came in is for (the design's call 46): on a server of one, its one app; on a host,
   * the app whose TEXT_FROM it was sent to, else the one host.yaml's `numbers` list it for; null for a number
   * no app texts from or is reached by (no default: a text is not a call to the main line).
   */
  const textAppOf = (to: string): string | null => {
    if (!host) return appsRun[0]!.id;
    const byFrom = appsRun.find((a) => {
      const t = textSenders.get(a.id);
      return t !== undefined && sameNumber(to, t.from);
    });
    return byFrom?.id ?? host.listedFor(to);
  };
  /** The message ids each app was handed lately (the latest SEEN_TEXTS), so a webhook Twilio sends again is handed on once. */
  const seenTexts = new Map<string, string[]>();
  const SEEN_TEXTS = 1000;
  /**
   * A text that came in (POST /messages/twilio), its app picked by the number texted: recorded in the app's
   * audit (text_received, under the provider's message id, channel sms), then handed to the app's onText
   * with a sender whose texts are recorded beside it. Nothing is fetched of its media; media not at Twilio's
   * own URLs were dropped and are counted. A text for no app is recorded in the server's own audit and
   * handed to none; one handed on before (the same message id) is not handed on again.
   */
  const receiveText = async (m: IncomingText, mediaDropped: number): Promise<void> => {
    const appId = textAppOf(m.to);
    if (appId === null) {
      log(`${MESSAGES_PATH} ${m.id} from ...${lastFour(m.from)} to ...${lastFour(m.to)}: no app texts from or is reached by that number; recorded, handed to none`);
      await audit.append(m.id, TEXT_CHANNEL, textAuditRow(receivedRecord(m, { mediaDropped, unrouted: true })));
      return;
    }
    const a = appRun(appId);
    const seen = seenTexts.get(a.id) ?? [];
    if (seen.includes(m.id)) {
      log(`${MESSAGES_PATH} ${m.id}${host ? ` (app ${a.id})` : ''}: sent again by the provider; handed on once already`);
      return;
    }
    seen.push(m.id);
    if (seen.length > SEEN_TEXTS) seen.shift();
    seenTexts.set(a.id, seen);
    const sink = auditOf(a.id);
    // What the hook did, in order: each text it sent, and each asking of the decision model (ctx.decide).
    const rows: AuditDraft[] = [];
    const t = textsOf(a.id);
    const texts = t !== null ? recordingTexts(t.provider, t.from, t.keys, (r) => rows.push(textAuditRow(r)), t.limits) : null;
    log(`${MESSAGES_PATH} ${m.id} from ...${lastFour(m.from)}${host ? ` (app ${a.id})` : ''}: ${m.body.length} characters, ${m.media.length} media${mediaDropped > 0 ? `, ${mediaDropped} not at Twilio's URLs dropped` : ''}`);
    await sink.append(m.id, TEXT_CHANNEL, textAuditRow(receivedRecord(m, { mediaDropped })));
    try {
      const decide = textDecider(clientOf(a.id), thresholds.JEV_TIMEOUT_MS, m, (row) => rows.push(row), now);
      if (a.app.onText !== undefined) await a.app.onText(m, { ...(texts !== null ? { texts } : {}), env: (name) => (Object.hasOwn(a.settings, name) ? a.settings[name] : undefined), sys: toolsOf(a.id).sys, nowMs: now(), decide });
    } catch (err) {
      log(`${MESSAGES_PATH} ${m.id}: the app's onText failed (${err instanceof Error ? err.name : 'error'})`);
    } finally {
      for (const row of rows) await sink.append(m.id, TEXT_CHANNEL, row);
    }
  };
  const deps: HttpDeps = {
    // A server of converse apps alone answers no carrier's webhook (voiceRefused).
    config: voiceRefused ? { ...config, voiceProviders: [] } : config, store, tokens, hints: buildHints(app), log, bus, audit, routes, app,
    // The incoming-message webhook, only where some app takes texts in or sends them.
    ...(textSenders.size > 0 || appsRun.some((a) => a.app.onText !== undefined) ? { messages: { secret: textSecret, receive: receiveText } } : {}),
    ...(Object.keys(startParameters).length > 0 ? { startParameters } : {}),
    ...(transfer ? { transfer } : {}),
    ...(numbers.length > 0 ? { numbers } : {}),
    ...(consoleAuth ? { consoleAuth } : {}),
    draining: () => draining,
    unready: () => unready,
    closing: () => closing,
    handover: () =>
      handover === null
        ? null
        : {
          pauseS: restartPauseS,
          answered: (callId: string) => {
            if (handover === null || !handover.waiting.delete(callId)) return;
            if (handover.waiting.size === 0) handover.done();
          },
        },
    ...(chat ? { chatLive: () => chat.liveCount() } : {}),
    ...(disk ? { disk } : {}),
    ...(!host && traceStores.size > 0 ? { traces: traceStores.get(appsRun[0]!.id)!.reader() } : {}),
    // On a host: each app's part of the webhooks, and its traces for the console.
    ...(host
      ? {
        host: { appFor: (called: string | null | undefined) => host.appFor(called), served: (id: string) => httpApps.get(id) },
        consoleApps: hosted.map((a) => ({ id: a.id, app: a.app, traceDir: traceDirOf(a.id), ...(traceStores.has(a.id) ? { traces: traceStores.get(a.id)!.reader() } : {}), ...(a.dir !== undefined ? { dir: a.dir } : {}) })),
      }
      : {}),
    // The console's Health page: this server's name and counts, the servers heard from, the audit verified on demand.
    serverHealth: {
      name: serverName,
      counters,
      ...(notices ? { peers: () => serversSeen.list() } : {}),
      verify: async () => {
        try {
          return await (auditSql !== null && postgresAudit !== null ? verifyAudit({ sql: auditSql }, now) : verifyAudit({ dir: config.auditDir }, now));
        } catch (err) {
          throw new Error(secretUrls.reduce((m, u) => maskSecrets(m, u), err instanceof Error ? err.message : String(err)));
        }
      },
      auditLabel: config.auditStore ? maskConnectionString(config.auditStore.url) : config.auditDir,
    },
    // On a server of one app run from its folder (pnpm start, pnpm --filter <app> serve): the folder, for the Knowledge page's drafts.
    ...(!host && existsSync(join(process.cwd(), 'app.yaml')) ? { appDir: process.cwd() } : {}),
    // /health's `traces`: always with a trace store; on one machine only once a write has failed, so a
    // body is as it was while the disk works.
    traceHealth: () => (traceStores.size > 0
      ? [...traceStores.values()].reduce((t, st) => ({ failures: t.failures + st.failures, dropped: t.dropped + st.dropped }), { failures: 0, dropped: 0 })
      : traceFailures.failures > 0 ? { failures: traceFailures.failures, dropped: 0 } : null),
  };
  const server = createServer(createRequestHandler(deps));
  if (chatSettings) {
    const paths = host ? `${CHAT_PATH} (${host.defaultApp}), ${hosted.map((a) => `${CHAT_PATH}/${a.id}`).join(', ')}` : CHAT_PATH;
    log(`chat: ${paths} for ${chatSettings.origins.any ? 'any origin (laptop)' : [...chatSettings.origins.set].join(', ')}, sign-in ${chatSettings.signIn.method}`);
    // A sign-in method with nothing to sign in as: every token would be refused.
    for (const { app: one } of appsRun) {
      if (chatSettings.signIn.method !== 'none' && one.identity?.signInLevel === undefined && one.principals?.fromClaims === undefined) {
        log(`WARNING: CHAT_SIGNIN=${chatSettings.signIn.method}, but app "${one.id}" takes no sign-in (identity.yaml has no signIn, and principals has no fromClaims): every token will be refused`);
      }
    }
    if (chatSettings.signIn.method !== 'none') {
      for (const a of conversesRun) log(`WARNING: CHAT_SIGNIN=${chatSettings.signIn.method}, but app "${a.id}" is a converse app, which takes no sign-in: every token will be refused`);
    }
    // On a host, one audience for two apps' chats means a token for one app's portal signs in at the other's.
    for (const shared of sharedAudiences(chatSettings, appsRun)) log(`WARNING: CHAT_SIGNIN=jwt: ${shared}`);
    // On a host, an app whose sign-in is its own says so: its issuer and where its keys are.
    if (host && chatSettings.signIn.method === 'jwt') {
      for (const a of appsRun) {
        const own = chatSettingsOf(chatSettings, a.env).signIn;
        if (own.method === 'jwt' && (own.issuer !== chatSettings.signIn.issuer || own.jwksUrl !== chatSettings.signIn.jwksUrl || own.audience !== chatSettings.signIn.audience)) {
          log(`${tag(a.id)}chat sign-in jwt of its own (${own.issuer}, keys at ${new URL(own.jwksUrl).host})`);
        }
      }
    }
  }
  const wss = attachWebSocketServer(
    server,
    {
      store, tokens, log, endCloseGraceMs: overrides.endCloseGraceMs, noInputMs, clipDurations: durations, bus,
      ...(config.relayPingMs !== undefined ? { pingMs: config.relayPingMs } : {}),
      ...(config.sessionStore ? { resumedAfterMs: config.resumedAfterMs ?? DEFAULT_RESUMED_AFTER_MS } : {}),
      ...(config.noInputAfterSpeechMs !== undefined ? { noInputAfterSpeechMs: config.noInputAfterSpeechMs } : {}),
      ...(config.callerWaitMs !== undefined ? { callerWaitMs: config.callerWaitMs } : {}),
      ...(config.keyWaitMs !== undefined ? { keyWaitMs: config.keyWaitMs } : {}),
      ...(config.resumeAfterPauseMs !== undefined ? { resumeAfterPauseMs: config.resumeAfterPauseMs } : {}),
      ...(config.resumeIntoReplyMs !== undefined ? { resumeIntoReplyMs: config.resumeIntoReplyMs } : {}),
      ...(config.minSpeechMs !== undefined ? { minSpeechMs: config.minSpeechMs } : {}),
      handoffNumber: config.handoffNumber, serviceUrls, anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary,
      ...(transfer ? { transfer } : {}),
      // On a host, a new call starts in the app its number reached, with that app's transfer targets.
      ...(host ? { host: { appOfSetup: (named: string | undefined, called: string | null) => appOfSetup(host, named, called), transferOf: (id: string) => httpApps.get(id)?.transfer ?? null, handoffOf, serviceUrlsOf } } : {}),
      summarizeHandoff: overrides.summarizeHandoff,
      bargeIn: config.bargeIn ?? 'any',
      ...(config.bargeInByCarrier ? { bargeInByCarrier: config.bargeInByCarrier } : {}),
      // SPEECH_OVER_LINE: absent from a config made by hand before it existed reads as unless-miss, as loadConfig's default.
      speechOverLine: config.speechOverLine ?? DEFAULT_SPEECH_OVER_LINE,
      // END_AFTER_PLAYBACK: absent from a config made by hand before it existed reads as auto, as loadConfig's default.
      endAfterPlayback: config.endAfterPlayback ?? 'auto',
      ...(config.endPlaybackMaxMs !== undefined ? { endPlaybackMaxMs: config.endPlaybackMaxMs } : {}),
      ...(config.endPlaybackFactor !== undefined ? { endPlaybackFactor: config.endPlaybackFactor } : {}),
      ...(config.endPlaybackMarginMs !== undefined ? { endPlaybackMarginMs: config.endPlaybackMarginMs } : {}),
      // RESAY_CUT_LINES: absent from a config made by hand before it existed reads as on, as loadConfig's default.
      ...(config.resayCutLines === false ? {} : { resay: { minFraction: config.resayMinFraction ?? DEFAULT_RESAY_MIN_FRACTION } }),
      // A spurious interrupt and a held reply read the caller's voice: only where the carrier is asked to report it.
      ...(config.resaySpuriousInterrupts !== false && reportsCallerVoice(config)
        ? { spuriousInterrupts: { windowMs: config.spuriousInterruptWindowMs ?? DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS } }
        : {}),
      ...((config.incompleteWaitMs ?? DEFAULT_INCOMPLETE_WAIT_MS) > 0 && reportsCallerVoice(config)
        ? { incompleteWait: { waitMs: config.incompleteWaitMs ?? DEFAULT_INCOMPLETE_WAIT_MS, ...(config.incompleteWaitBelow != null ? { below: config.incompleteWaitBelow } : {}) } }
        : {}),
    },
    overrides.setupTimeoutMs,
    voiceRefused ? [] : config.voiceProviders,
    chat ? { path: CHAT_PATH, handleUpgrade: (req, socket, head) => chat.handleUpgrade(req, socket, head), ...(chats ? { owns: (path: string) => chats.owns(path) } : {}) } : null,
    // Closing with the calls saved: a socket belongs to the restarted server (the handover, or a crash's close).
    () => closing && store.durable,
  );
  /**
   * One pass of the idle sweep. Named and returned rather than inlined into the interval so a
   * test can drive a tick without waiting a minute for one.
   */
  const sweep = (): void => {
    // Snapshot before `evictIdle` deletes the entries: a call still live at the moment it is swept
    // away is the one end a turn never sees and http.ts's hangup branch never reaches either, so
    // this sweep is its only producer of a `call_ended` audit entry.
    const liveBefore = new Set(store.liveCallSids());
    // Each call's app, read before the eviction forgets it: its end goes to that app's audit.
    const appIds = new Map([...liveBefore].map((sid) => [sid, store.get(sid)?.session.appId]));
    const evicted = store.evictIdle();
    for (const sid of evicted) {
      // An evicted call with a socket gets here again through the socket's own close, but one
      // whose socket had already gone would otherwise leave its no-input bookkeeping behind.
      forgetNoInput(sid);
      log(`${sid}: evicted idle session`);
      if (liveBefore.has(sid)) {
        whenChained(auditOf(appIds.get(sid)).append(sid, 'voice', { type: 'call_ended', detail: { reason: 'evicted' } }), () => {},
          (err: unknown) => log(`${sid}: the evicted call's audit entry failed: ${err instanceof Error ? err.message : String(err)}`));
        // The console's end of it: `evictIdle` closes the socket too, but that close reaches
        // `handleSocketClose` with the entry already gone, so nothing downstream would ever publish the
        // end of an evicted call -- this is the only producer of reason 'error'. Every call the console
        // keeps (its Live list), not only the newest, and a call the bus never saw start is ignored there.
        bus?.publish({ type: 'ended', callSid: sid, at: now(), reason: 'error' });
      }
    }
    for (const r of routes) r.sweep?.();
    chat?.sweep();
    if (durable) sweepSaved();
    if (notices) void notices.sweep().catch((err: unknown) => log(`notices: could not sweep the old notices: ${err instanceof Error ? err.message : String(err)}`));
    const swept = tokens.evictExpired();
    const sayExpired = (n: number): void => {
      if (n) log(`swept ${n} expired call tokens`);
    };
    if (typeof swept === 'number') sayExpired(swept);
    else void swept.then(sayExpired, (err: unknown) => log(`could not sweep the expired call tokens: ${err instanceof Error ? err.message : String(err)}`));
    if (retaining && now() - retentionAt >= RETENTION_EVERY_MS) sweepDisk();
  };
  const evictor = setInterval(sweep, EVICT_EVERY_MS);
  evictor.unref();
  // With a shared store: every hold this server has, renewed every third of a hold, in one statement.
  const renewer = shared ? setInterval(() => void store.renewLeases(), Math.max(100, Math.floor(leaseMs / 3))) : null;
  renewer?.unref();
  /** The shared store's connection, closed once (a failed start, or close()). */
  const closeShared = async (): Promise<void> => {
    if (renewer) clearInterval(renewer);
    if (reporter) clearInterval(reporter);
    await notices?.close();
    await postgresAudit?.settled();
    // The audit's roster names how far this server's chains for each day go, as it stops.
    await postgresAudit?.enterHeads().catch((err: unknown) => log(`audit: could not enter this server's chain heads in the roster: ${err instanceof Error ? err.message : String(err)}`));
    await shared?.close().catch((err: unknown) => log(`sessions: could not close the Postgres connection: ${err instanceof Error ? err.message : String(err)}`));
    await closeAuditSql();
  };

  // The sections' own embedding model (kb.yaml documents.embedder), loaded before the server listens,
  // so no call's first questions pay for it (retrieval has a budget: a model still loading nominates
  // nothing). One that cannot be loaded leaves the keywords (../kb/sections.ts).
  for (const a of appsRun) {
    try {
      const warmed = await a.app.knowledge?.sections?.warm?.();
      if (warmed) log(`knowledge: ${a.id}: the sections' embedding model is loaded${typeof warmed === 'object' ? ` (on WebAssembly: ${warmed.wasm})` : ''}`);
    } catch (err) {
      log(`knowledge: ${a.id}: the sections' embedding model could not be loaded, so sections are found by their keywords: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // listen reports failure as an 'error' event, which is unhandled (and fatal) unless it is awaited here.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      const listening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      if (overrides.host === undefined) server.listen(config.port, listening);
      else server.listen(config.port, overrides.host, listening);
    });
  } catch (err) {
    clearInterval(evictor);
    wss.close();
    await closeShared();
    throw err;
  }
  if (notices) {
    const told = notices;
    const report = (): void => void told.publish('server', JSON.stringify(selfReport())).catch(() => undefined);
    reportNow = report;
    report();
    reporter = setInterval(report, REPORT_EVERY_MS);
    reporter.unref();
  }
  const port = (server.address() as { port: number }).port;
  /** Stop taking new connections (those open go on); the same promise however often it is asked. */
  let stopped: Promise<void> | null = null;
  const stopListening = (): Promise<void> => (stopped ??= new Promise<void>((resolve) => server.close(() => resolve())));
  try {
    consoleAuth?.start(port);
    // With the audit in a database, the first link exists once its record does.
    await consoleAuth?.linkRecorded();
  } catch (err) {
    // A link file that cannot be written safely is a setting to fix, not a console without a way in.
    clearInterval(evictor);
    chat?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    await closeShared();
    throw err;
  }

  return {
    server,
    port,
    store,
    tokens,
    bus,
    routes,
    ...(chat ? { chat } : {}),
    sweep,
    get draining() {
      return draining;
    },
    get ready() {
      return !draining && !unready;
    },
    unready: async (ms = config.drainUnreadyMs ?? 0) => {
      if (ms <= 0 || draining) return;
      unready = true;
      log(`stopping: /ready says 503 for ${ms} ms while new calls are still answered, then the drain`);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    drain: async (ms = config.drainMs ?? DEFAULT_DRAIN_MS) => {
      draining = true;
      // A call let go from now on is given up by a stop: the server that takes it says the caller was lost a moment.
      store.markStopping();
      chat?.drain();
      // A call whose goodbye or transfer line plays before its held `end` (END_AFTER_PLAYBACK) has ended
      // for the store, but is waited for as a live call: closing its socket would cut the line short.
      const calls = () => store.liveCount() + heldEndsOf(store).length;
      const chats = () => chat?.activeCount() ?? 0;
      const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
      if (calls() + chats() === 0) {
        log('drained: no calls or chats left');
        return;
      }
      log(`draining: up to ${ms} ms for ${plural(calls(), 'call')} and ${plural(chats(), 'chat')}; new calls go to the handoff number`);
      const ended = await new Promise<boolean>((resolve) => {
        if (ms === 0) return resolve(false);
        const poll = setInterval(() => {
          if (calls() + chats() > 0) return;
          clearInterval(poll);
          clearTimeout(deadline);
          resolve(true);
        }, DRAIN_POLL_MS);
        const deadline = setTimeout(() => {
          clearInterval(poll);
          resolve(false);
        }, ms);
      });
      if (ended) {
        log('drained: no calls or chats left');
        return;
      }
      closing = true;
      if (store.durable && restartPauseS > 0) {
        // A planned restart with the calls saved (SESSION_STORE=file): each call is handed over to the
        // restarted server. Its socket is closed as going away; its carrier calls back at once, while this
        // server still listens, and is told to wait RESTART_PAUSE_S and connect again (http.ts
        // decideAction), by which time this server has stopped and the restarted one takes the socket
        // and resumes the call. Meanwhile every socket is turned away (ws.ts), so none lands here.
        const waiting = new Set(store.liveCallSids());
        log(`drain: ${ms} ms passed with ${plural(calls(), 'call')} and ${plural(chats(), 'chat')} live; the sessions are saved: each call is closed as going away, and on its callback the carrier is told to wait ${restartPauseS} s and connect again, to the restarted server`);
        const handedOver = new Promise<void>((resolve) => {
          handover = { waiting, done: resolve };
          if (waiting.size === 0) resolve();
        });
        const live = [...wss.clients];
        for (const c of live) c.close(1001, 'server restarting');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const allIn = await Promise.race([
          handedOver.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), GOING_AWAY_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!allIn) log(`drain: no callback for ${plural(waiting.size, 'call')}; the carrier's fallback answers any that comes now`);
        // No new connection from now on. One a carrier kept open still reaches this server: its callback is
        // told to wait as the others were (the handover stays), and its socket is turned away.
        void stopListening();
        await store.settled();
        return;
      }
      if (store.durable) {
        // The calls are saved (SESSION_STORE=file) and RESTART_PAUSE_S=0, so none is put through to a
        // person: this server stops taking connections first, then closes the calls' sockets as going away. Each carrier calls back
        // at once; the restarted server, when it is listening by then, loads the call and resumes it; while
        // no server is, the callback fails and the carrier's fallback document (pnpm fallback) puts the
        // caller through to the handoff number.
        log(`drain: ${ms} ms passed with ${plural(calls(), 'call')} and ${plural(chats(), 'chat')} live; the sessions are saved: the server stops listening, and the carrier calls the restarted server back`);
        void stopListening();
        const live = [...wss.clients];
        for (const c of live) c.close(1001, 'server restarting');
        await Promise.race([
          Promise.allSettled(live.map((c) => new Promise<void>((resolve) => (c.readyState === c.CLOSED ? resolve() : c.once('close', () => resolve()))))),
          new Promise<void>((resolve) => setTimeout(resolve, GOING_AWAY_MS).unref()),
        ]);
        await store.settled();
        return;
      }
      log(`drain: ${ms} ms passed with ${plural(calls(), 'call')} and ${plural(chats(), 'chat')} live; closing them`);
      // Going away, not an error: the carrier posts its action callback for each, and this server, about
      // to close, answers it with the handoff number (http.ts decideAction), so the caller reaches a person.
      const open = [...wss.clients];
      for (const c of open) c.close(1001, 'server restarting');
      if (open.length) {
        const socketsClosed = Promise.allSettled(open.map((c) => new Promise<void>((resolve) => (c.readyState === c.CLOSED ? resolve() : c.once('close', () => resolve())))));
        // Each callback ends its call, so the wait is over once every socket has closed and no call is live.
        await new Promise<void>((resolve) => {
          let socketsDone = false;
          const finish = (): void => {
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          };
          const check = (): void => {
            if (socketsDone && calls() === 0) finish();
          };
          const poll = setInterval(check, DRAIN_POLL_MS);
          const timer = setTimeout(finish, GOING_AWAY_MS);
          void socketsClosed.then(() => {
            socketsDone = true;
            check();
          });
        });
        const left = calls();
        if (left > 0) log(`drain: no callback for ${plural(left, 'call')}; closing`);
      }
    },
    close: async () => {
      draining = true;
      closing = true;
      store.markStopping();
      clearInterval(evictor);
      if (renewer) clearInterval(renewer);
      // With the calls saved, a carrier's callback belongs to the restarted server: none is taken here.
      if (store.durable) void stopListening();
      // Let turns that are already running finish (and flush their frames) before the sockets go away.
      // And the `end`s held for their lines to play (END_AFTER_PLAYBACK).
      const tails = [...store.tails(), ...heldEndsOf(store), ...routes.flatMap((r) => r.tails?.() ?? []), ...(chat?.tails() ?? [])];
      if (tails.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(tails),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      // With a shared store, every call this server still holds is given up, after what its turns saved,
      // so the server its carrier reconnects to takes it at once rather than wait for the hold to lapse.
      await store.releaseAll();
      for (const c of wss.clients) c.terminate();
      chat?.close();
      // `server.close` only stops new connections and then waits for the idle ones; an open SSE
      // stream is never idle, so a connected dashboard page would hold shutdown open forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await stopListening();
      consoleAuth?.stop();
      // What the last turns saved is on disk before the process goes.
      await Promise.all([store.settled(), chat?.settled?.()]);
      // And what the last turns traced is on the store (a few seconds at most).
      await Promise.all([...traceStores.values()].map((t) => t.flush()));
      await closeShared();
    },
  };
}

/**
 * What an app's launcher starts beside the server (its downstream services, say): the overrides that
 * reach them, and how to stop them when the server shuts down.
 */
export interface Sidecars {
  overrides?: ServerOverrides;
  close?(): Promise<void>;
}

export { SIGNAL_REPEAT_MS } from './signals';
/** How long a crash waits for the server to close before the process exits anyway. */
export const CRASH_CLOSE_MS = 3_000;

/**
 * An error as the log takes it: its stack (which names no setting), and its causes' (a failed request
 * says why in its cause), or for a value that is not an Error, what kind of value it is. Never an
 * object's contents, which could hold anything (a request's headers, say).
 */
export function describeCrash(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) {
    if (err === null || err === undefined) return `${String(err)} (not an Error)`;
    if (typeof err !== 'object') return `${String(err)} (a ${typeof err}, not an Error)`;
    const kind = (err as { constructor?: { name?: string } }).constructor?.name || 'object';
    return `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}, not an Error`;
  }
  const own = err.stack ?? `${err.name}: ${err.message}`;
  const cause = (err as { cause?: unknown }).cause;
  return cause === undefined || depth >= 3 ? own : `${own}\n  caused by: ${describeCrash(cause, depth + 1)}`;
}

/**
 * The process entry point, run by an app's launcher after it has registered the app. `start`, if
 * given, starts what the app runs beside the server, once the config has loaded.
 *
 * It reads a settings file first when ENV_FILE or `--env-file <path>` names one (envFile.ts; a
 * variable already in the environment wins). A crash (an uncaught exception or an unhandled
 * rejection) is logged with its stack and exits 1 after a short best-effort close (CRASH_CLOSE_MS),
 * so the service manager restarts the process. That is Node's own rule for an unhandled rejection,
 * kept on purpose and not an option: a server in a state nothing planned for should start again
 * rather than go on answering calls. Code that means to carry on after a rejection catches it. The first SIGINT or SIGTERM stops the server; a second one exits at
 * once, 130 for SIGINT and 143 for SIGTERM.
 */
export async function main(start?: (config: ServerConfig) => Promise<Sidecars>): Promise<void> {
  // What a crash closes, once there is something to close.
  let closeOnCrash: (() => Promise<unknown>) | null = null;
  let crashed = false;
  const crash = (kind: string) => (err: unknown): void => {
    console.error(`[server] fatal: ${kind}: ${describeCrash(err)}`);
    if (crashed) return;
    crashed = true;
    // Set first: the deadline timer does not hold the process open, so it may end on its own before process.exit.
    process.exitCode = 1;
    if (closeOnCrash !== null) console.error(`[server] closing (up to ${CRASH_CLOSE_MS / 1000} s: turns under way finish, a new call goes to the handoff number), then exit 1`);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, CRASH_CLOSE_MS).unref());
    void Promise.race([Promise.resolve().then(() => closeOnCrash?.()), deadline]).catch(() => {}).finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('uncaught exception'));
  process.on('unhandledRejection', crash('unhandled rejection'));
  try {
    const envFiles = envFilePathsOf(process.argv.slice(2), process.env);
    if (envFiles !== null) applyEnvFile(envFiles, process.env);
    // LOG_FILE: from here on, what the process prints also goes to a file the server rolls itself.
    const logFile = logFileSettingOf(process.env);
    if (logFile !== null) teeProcessOutput(new RollingLog(logFile));
    const config = loadConfig(process.env);
    if (envFiles !== null) console.log(`[server] settings from ${envFiles.join(', ')} (${envFiles.length > 1 ? 'a later file wins over an earlier one, and ' : ''}a variable already in the environment wins over the file${envFiles.length > 1 ? 's' : ''})`);
    console.log(`[server] ${describeConfig(config)}`);
    if (!config.signatureCheck) console.log('[server] WARNING: webhook signature validation is OFF');
    const sidecars = start ? await start(config) : {};
    const running = await startServer(config, sidecars.overrides ?? {});
    closeOnCrash = () => Promise.allSettled([running.close(), sidecars.close?.()]);
    let stoppedAt: number | null = null;
    const stop = (signal: NodeJS.Signals): void => {
      const at = Date.now();
      if (stoppedAt === null) {
        stoppedAt = at;
        console.log(`[server] shutting down (${signal}; a second one stops at once)`);
        // The app's own services stay up while live calls finish, since those calls still use them.
        // DRAIN_UNREADY_MS first (0 by default: none): /ready says 503 while new calls are still answered.
        void running
          .unready()
          .then(() => running.drain())
          .catch(() => {})
          .then(() => Promise.allSettled([running.close(), sidecars.close?.()]))
          .then(() => process.exit(0));
        return;
      }
      if (at - stoppedAt < SIGNAL_REPEAT_MS) return;
      console.log(`[server] forced exit (${signal} while shutting down)`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const base = publicBase(config, running.port);
    const webhooks = config.voiceProviders.map((id) => `${base}/voice/${id}`).join(', ');
    const legacy = config.voiceProviders.includes('twilio') ? ' (Twilio also on /voice)' : '';
    console.log(config.voiceProviders.length === 0 ? `[server] listening on ${running.port}; no phone line (VOICE_PROVIDERS=none): the web chat alone` : `[server] listening on ${running.port}; voice webhook ${webhooks}${legacy}`);
    const consoleBase = config.consoleLocalOnly ? localBase(running.port) : base;
    if (running.bus) console.log(config.consoleAuth ? `[server] console ${base}/dashboard (sign in: pnpm console:link prints a link)` : `[server] console ${consoleBase}/dashboard`);
    for (const r of running.routes) {
      // A console page goes where the console goes: behind its sign-in on the public address with CONSOLE_AUTH=token.
      const signedIn = r.auth === 'console' && config.consoleAuth !== undefined && running.bus !== undefined;
      // With no sign-in a console page is local only, whatever CONSOLE_LOCAL_ONLY says.
      const local = r.auth === 'console' ? localBase(running.port) : consoleBase;
      console.log(`[server] ${r.label} ${(signedIn ? base : r.localOnly ? local : base)}${r.path}${signedIn ? ' (behind the console\'s sign-in)' : ''}`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

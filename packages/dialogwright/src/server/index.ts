import { createServer, type Server } from 'node:http';
import { applyEnvFile, envFilePathOf } from './envFile';
import { join } from 'node:path';
import { consoleExposure, DEFAULT_DRAIN_MS, describeConfig, loadConfig, localBase, publicBase, type ServerConfig } from './config';
import { createRequestHandler, type HttpDeps } from './http';
import { attachWebSocketServer } from './ws';
import { forgetNoInput, type AdapterDeps } from './adapter';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { buildHints } from './hints';
import { DashboardBus } from './dashboard/bus';
import { makeObserver } from './dashboard/observer';
import { defaultAppId, getApp } from '../core/app/registry';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildClient, modelHeader } from '../run/client';
import { localDateIso } from '../run/clock';
import type { JevClient } from '../jev/types';
import { TraceWriter } from '../trace/writer';
import type { TurnObserver } from '../run/turn';
import { clipVersions, discoverClips, recordableClips } from '../prompts/clips';
import { clipDurations } from '../prompts/playback';
import { clipStatus, readRecorded } from '../prompts/sheet';
import { demoTools } from '../core/tools';
import { AuditLog } from '../audit/log';
import type { ServiceUrls } from './services';
import { validateRoutes, type AppRoute, type AppRoutesFactory } from './appRoutes';
import { localOnlyPaths } from './localOnly';
import { VOICE_RELAY } from '../channel/caps';
import { CHAT_PATH, chatEndpoint, type ChatEndpoint } from './chat/socket';

export interface RunningServer {
  server: Server;
  port: number;
  store: SessionStore;
  tokens: CallTokens;
  /** The dashboard's event bus, or undefined when DASHBOARD=off. */
  bus?: DashboardBus;
  /** The app's own pages its launcher mounted (ServerOverrides.routes), in the order they are asked. */
  routes: readonly AppRoute[];
  /** The engine's web chat (CHAT=on), or undefined when it is off. */
  chat?: ChatEndpoint;
  /** One pass of the idle sweep the evictor runs on its interval; exposed for tests. */
  sweep(): void;
  /** Whether the server is stopping: drain (or close) has begun, and `/ready` answers 503. */
  readonly draining: boolean;
  /**
   * The first half of a stop: the server stops taking new work and waits for what is live. From now on
   * `/ready` answers 503, a new call is put through to the handoff number, and a new chat is refused
   * `busy`; a live call's turns and its reconnects, and a chat's resume, go on. It resolves once no call
   * is live and no one is in a chat, or after `ms` (default DRAIN_MS; 0 at once), when it closes the
   * calls still live with 1001 (going away), so the carrier calls back for them. close() follows it.
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
  /** Tests replace the Claude Haiku call, for the phone line and the chat alike. */
  summarizeHandoff?: AdapterDeps['summarizeHandoff'];
  /** How the engine's web chat fetches the identity provider's published keys (CHAT_SIGNIN=jwt); tests serve their own. */
  chatFetch?: typeof fetch;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EVICT_EVERY_MS = 60 * 1000;
/**
 * How long close() waits for turns already in flight before it terminates the sockets anyway. It is
 * not the drain: DRAIN_MS (config.ts) is how long a stopping server waits for whole calls to end.
 */
const DRAIN_TIMEOUT_MS = 2_000;
/** How often a drain looks for the last call to have ended. */
const DRAIN_POLL_MS = 100;
/** How long the drain's 1001 closes are given before close() terminates what is left. */
const GOING_AWAY_MS = 1_000;

/**
 * Call SIDs come from Twilio (CA + 32 hex), but they arrive over the socket, so never let one shape a path.
 * Dots are replaced too, not only separators: a SID of `CA1.frames` would otherwise write its trace to
 * `CA1.frames.jsonl` and collide with call CA1's frame log.
 */
export function safeFileStem(callSid: string): string {
  const cleaned = callSid.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length ? cleaned.slice(0, 64) : 'unknown';
}

export async function startServer(config: ServerConfig, overrides: ServerOverrides = {}): Promise<RunningServer> {
  const log = overrides.log ?? ((line: string) => console.log(`[server] ${line}`));
  const now = overrides.now ?? (() => Date.now());
  // The one threshold the phone line sets from its environment: the ask budget is a property of the
  // deployment's network and the day's question count, not of the dialogue policy.
  const thresholds = { ...DEFAULT_THRESHOLDS, JEV_TIMEOUT_MS: config.jevTimeoutMs };
  const client = overrides.client ?? buildClient(config.jevClient, undefined, thresholds, undefined, config.jevProvider ?? undefined);
  // Which model answers, and once, for a model that is not Jev, that the thresholds were measured on Jev.
  for (const line of modelHeader(config.jevClient, config.jevProvider)) log(line);
  // Wall-clock date in the configured zone: a caller at 8pm Pacific means today, not tomorrow.
  const todayIso = () => config.todayOverride ?? localDateIso(now(), config.timezone);

  const clips = discoverClips(config.audioDir);
  const durations = clipDurations(config.audioDir);
  // CLIPS=off leaves the render context unset, which is the harness's own mode: every prompt goes
  // out as text and ConversationRelay's voice speaks the fixed words, the names and the dates
  // alike. Nothing about the recorded clips matters then, so the presence/staleness checks below
  // (and the disk read they depend on) only run when CLIPS=on; off gets a single quiet line.
  if (config.clips) {
    let recorded: Record<string, string> | null;
    try {
      recorded = readRecorded(config.audioDir);
    } catch (e) {
      log(`audio: ignoring unreadable recorded.json: ${e instanceof Error ? e.message : String(e)}`);
      recorded = null;
    }
    const cov = clipStatus(recordableClips(getApp(defaultAppId())), clips, recorded);
    const missingSuffix =
      cov.missing.length === 0
        ? ''
        : `: missing ${cov.missing.slice(0, 10).join(', ')}${cov.missing.length > 10 ? ` +${cov.missing.length - 10} more` : ''}`;
    log(`audio: ${cov.present} of ${cov.total} clips present in ${config.audioDir} (${cov.missing.length} segments fall back to TTS)${missingSuffix}`);
    if (cov.stale.length > 0) {
      log(`audio: ${cov.stale.length} stale clips (recorded text differs from the sheet): ${cov.stale.join(', ')}`);
    }
  } else {
    log('clips: off (every prompt spoken by the ConversationRelay TTS voice)');
  }
  const noInputMs = overrides.noInputMs ?? config.noInputMs;
  log(noInputMs > 0 ? `no-input: ${noInputMs} ms after playback (${durations.size} clip durations)` : 'no-input: off');
  // The presence/count logic above stays on the unversioned map; only what the caller actually
  // fetches carries the content hash, so a regenerated clip is never served from Twilio's cache.
  const render = config.clips ? { clips: clipVersions(config.audioDir, clips), audioBase: `https://${config.publicHost}/audio/` } : null;

  const serviceUrls = overrides.serviceUrls ?? {};
  for (const name of Object.keys(getApp(defaultAppId()).services ?? {})) {
    const url = serviceUrls[name] ?? null;
    log(url ? `service ${name}: ${url}` : `service ${name}: off (its requests are answered with no result)`);
  }

  const bus = config.dashboard ? new DashboardBus() : undefined;
  log(bus ? 'dashboard: /dashboard' : 'dashboard: off');

  // Annotated because the factory below hands `store` to `makeObserver`, and an inferred type
  // would be circular: the initializer references the very binding it is initializing.
  // One set of tools (the app's systems) for the process, so a record made on one call can be read on the next.
  const tools = demoTools();
  // One audit chain for the process: every call's entries link into the same day file.
  const audit = new AuditLog(config.auditDir, now);
  const store: SessionStore = new SessionStore(
    (callSid) => {
      const file = safeFileStem(callSid);
      const trace = new TraceWriter(join(config.traceDir, `${file}.jsonl`));
      const observe: TurnObserver | null = bus ? makeObserver(bus, store, callSid) : null;
      return {
        session: newSession(callSid, now(), VOICE_RELAY),
        opts: { client, thresholds, todayIso: todayIso(), trace, now, render, observe, tools, audit, screen: config.screen },
        trace,
        frames: new FrameLog(join(config.traceDir, `${file}.frames.jsonl`), now),
      };
    },
    config.sessionTtlMs,
    now,
    config.sessionMaxAgeMs,
  );
  const tokens = new CallTokens(TOKEN_TTL_MS, now);
  // The app's pages share the phone line's client, book of business, audit chain and console.
  const mounted = overrides.routes?.({
    config, client, thresholds, todayIso, tools, audit, bus, traceDir: config.traceDir, serviceUrls, log, now,
    anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
  }) ?? { routes: [] };
  const routes = mounted.routes;
  validateRoutes(routes);
  if (bus || routes.some((r) => r.localOnly)) log(consoleExposure(config, localOnlyPaths(routes)));
  for (const warning of mounted.warnings ?? []) log(`WARNING: ${warning}`);
  const app = getApp(defaultAppId());
  let draining = false;
  // The engine's own web chat, when CHAT=on: each session with the phone line's client, tools, audit chain and console.
  const chatSettings = config.chat;
  const chat = chatSettings
    ? chatEndpoint({
      settings: chatSettings, now, log, audit, bus, serviceUrls,
      anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
      startTimeoutMs: overrides.setupTimeoutMs, fetch: overrides.chatFetch,
      resources: (id, sessions) => {
        const file = safeFileStem(id);
        const trace = new TraceWriter(join(config.traceDir, `${file}.jsonl`));
        const observe: TurnObserver | null = bus ? makeObserver(bus, sessions, id) : null;
        // No render context: a chat shows a line's words, never a recorded clip.
        return {
          opts: { client, thresholds, todayIso: todayIso(), trace, now, render: null, observe, tools, audit, screen: config.screen },
          frames: new FrameLog(join(config.traceDir, `${file}.frames.jsonl`), now),
        };
      },
    })
    : undefined;
  const deps: HttpDeps = {
    config, store, tokens, hints: buildHints(app), log, bus, audit, routes, app,
    draining: () => draining,
    ...(chat ? { chatLive: () => chat.liveCount() } : {}),
  };
  const server = createServer(createRequestHandler(deps));
  if (chatSettings) {
    log(`chat: ${CHAT_PATH} for ${chatSettings.origins.any ? 'any origin (laptop)' : [...chatSettings.origins.set].join(', ')}, sign-in ${chatSettings.signIn.method}`);
    // A sign-in method with nothing to sign in as: every token would be refused.
    if (chatSettings.signIn.method !== 'none' && app.identity?.signInLevel === undefined && app.principals?.fromClaims === undefined) {
      log(`WARNING: CHAT_SIGNIN=${chatSettings.signIn.method}, but app "${app.id}" takes no sign-in (identity.yaml has no signIn, and principals has no fromClaims): every token will be refused`);
    }
  }
  const wss = attachWebSocketServer(
    server,
    {
      store, tokens, log, endCloseGraceMs: overrides.endCloseGraceMs, noInputMs, clipDurations: durations, bus,
      handoffNumber: config.handoffNumber, serviceUrls, anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary,
      summarizeHandoff: overrides.summarizeHandoff,
    },
    overrides.setupTimeoutMs,
    config.voiceProviders,
    chat ? { path: CHAT_PATH, handleUpgrade: (req, socket, head) => chat.handleUpgrade(req, socket, head) } : null,
  );
  /**
   * One pass of the idle sweep. Named and returned rather than inlined into the interval so a
   * test can drive a tick without waiting a minute for one.
   */
  const sweep = (): void => {
    // Read before the eviction: `evictIdle` deletes the entry, so afterwards there is no way to
    // tell whether the call it closed was still live. It closes the socket too, but that close
    // reaches `handleSocketClose` with the entry already gone, so nothing downstream would ever
    // publish the end of an evicted call -- this is the only producer of reason 'error'.
    const live = bus?.current() ?? null;
    const wasLive = live ? store.get(live)?.ended === false : false;
    // Snapshot before `evictIdle` deletes the entries: a call still live at the moment it is swept
    // away is the one end a turn never sees and http.ts's hangup branch never reaches either, so
    // this sweep is its only producer of a `call_ended` audit entry.
    const liveBefore = new Set(store.liveCallSids());
    const evicted = store.evictIdle();
    for (const sid of evicted) {
      // An evicted call with a socket gets here again through the socket's own close, but one
      // whose socket had already gone would otherwise leave its no-input bookkeeping behind.
      forgetNoInput(sid);
      log(`${sid}: evicted idle session`);
      if (liveBefore.has(sid)) audit.append(sid, 'voice', { type: 'call_ended', detail: { reason: 'evicted' } });
    }
    if (live && wasLive && evicted.includes(live)) {
      bus?.publish({ type: 'ended', callSid: live, at: now(), reason: 'error' });
    }
    for (const r of routes) r.sweep?.();
    chat?.sweep();
    const swept = tokens.evictExpired();
    if (swept) log(`swept ${swept} expired call tokens`);
  };
  const evictor = setInterval(sweep, EVICT_EVERY_MS);
  evictor.unref();

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
    throw err;
  }
  const port = (server.address() as { port: number }).port;

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
    drain: async (ms = config.drainMs ?? DEFAULT_DRAIN_MS) => {
      draining = true;
      chat?.drain();
      const calls = () => store.liveCount();
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
      log(`drain: ${ms} ms passed with ${plural(calls(), 'call')} and ${plural(chats(), 'chat')} live; closing them`);
      // Going away, not an error: the carrier posts its action callback for each, which a server that
      // keeps its sessions (or the handoff, for one that does not) answers once this one has restarted.
      const open = [...wss.clients];
      for (const c of open) c.close(1001, 'server restarting');
      if (open.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(open.map((c) => new Promise<void>((resolve) => (c.readyState === c.CLOSED ? resolve() : c.once('close', () => resolve()))))),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, GOING_AWAY_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
    },
    close: async () => {
      draining = true;
      clearInterval(evictor);
      // Let turns that are already running finish (and flush their frames) before the sockets go away.
      const tails = [...store.tails(), ...routes.flatMap((r) => r.tails?.() ?? []), ...(chat?.tails() ?? [])];
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
      for (const c of wss.clients) c.terminate();
      chat?.close();
      // `server.close` only stops new connections and then waits for the idle ones; an open SSE
      // stream is never idle, so a connected dashboard page would hold shutdown open forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
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

/**
 * A repeat of a stop signal this soon after the first is the same stop, delivered again: a terminal's
 * Ctrl-C, and a service manager that signals every process of the service, reach pnpm, tsx and the
 * server at once, and pnpm and tsx each pass a signal on too (tsx drops a copy its child already had,
 * on a 30 ms wait). A person's second Ctrl-C comes later than this; it exits at once.
 */
export const SIGNAL_REPEAT_MS = 1_000;
/** How long a crash waits for the server to close before the process exits anyway. */
export const CRASH_CLOSE_MS = 3_000;

/** An error as the log takes it: its stack (which names no setting), or what it is. */
function described(err: unknown): string {
  return err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
}

/**
 * The process entry point, run by an app's launcher after it has registered the app. `start`, if
 * given, starts what the app runs beside the server, once the config has loaded.
 *
 * It reads a settings file first when ENV_FILE or `--env-file <path>` names one (envFile.ts; a
 * variable already in the environment wins). A crash (an uncaught exception or an unhandled
 * rejection) is logged with its stack and exits 1 after a short best-effort close, so the service
 * manager restarts the process. The first SIGINT or SIGTERM stops the server; a second one exits at
 * once, 130 for SIGINT and 143 for SIGTERM.
 */
export async function main(start?: (config: ServerConfig) => Promise<Sidecars>): Promise<void> {
  // What a crash closes, once there is something to close.
  let closeOnCrash: (() => Promise<unknown>) | null = null;
  let crashed = false;
  const crash = (kind: string) => (err: unknown): void => {
    console.error(`[server] fatal: ${kind}: ${described(err)}`);
    if (crashed) return;
    crashed = true;
    // Set first: the deadline timer does not hold the process open, so it may end on its own before process.exit.
    process.exitCode = 1;
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, CRASH_CLOSE_MS).unref());
    void Promise.race([Promise.resolve().then(() => closeOnCrash?.()), deadline]).catch(() => {}).finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('uncaught exception'));
  process.on('unhandledRejection', crash('unhandled rejection'));
  try {
    const envFile = envFilePathOf(process.argv.slice(2), process.env);
    if (envFile !== null) applyEnvFile(envFile, process.env);
    const config = loadConfig(process.env);
    if (envFile !== null) console.log(`[server] settings from ${envFile} (a variable already in the environment wins over the file)`);
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
        void running
          .drain()
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
    console.log(`[server] listening on ${running.port}; voice webhook ${webhooks}${legacy}`);
    const consoleBase = config.consoleLocalOnly ? localBase(running.port) : base;
    if (running.bus) console.log(`[server] console ${consoleBase}/dashboard`);
    for (const r of running.routes) console.log(`[server] ${r.label} ${(r.localOnly ? consoleBase : base)}${r.path}`);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

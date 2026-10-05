import { createServer, type Server } from 'node:http';
import { applyEnvFile, envFilePathOf } from './envFile';
import { SIGNAL_REPEAT_MS } from './signals';
import { join, resolve as resolvePath } from 'node:path';
import { consoleExposure, DEFAULT_DRAIN_MS, DEFAULT_RESAY_MIN_FRACTION, describeConfig, loadConfig, localBase, publicBase, reportsCallerVoice, type ServerConfig } from './config';
import { DEFAULT_INCOMPLETE_WAIT_MS, DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS } from '../channel/voiceProviders';
import { createRequestHandler, type HttpDeps } from './http';
import { attachWebSocketServer } from './ws';
import { forgetNoInput, heldEndsOf, type AdapterDeps } from './adapter';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { openFileStores } from './stores/file';
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
import { diskUsageCache, sweepRetention, type RetentionSettings } from './retention';
import { ConsoleAuth } from './console/auth';

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
    const carriers = config.voiceProviders.map((id) => id.charAt(0).toUpperCase() + id.slice(1)).join(', ');
    log(`clips: off (every prompt spoken by the carrier's TTS voice: ${carriers})`);
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
  // CONSOLE_AUTH=token: the console's sign-in, whose first link is made once the server listens. Made
  // before anything that would need closing, as it reads the sign-outs a run before kept and may refuse them.
  const consoleAuth = config.consoleAuth && bus ? new ConsoleAuth({ settings: config.consoleAuth, publicHost: config.publicHost, audit, now, log }) : undefined;
  // SESSION_STORE=file:<dir>: calls, chats and relay tokens saved in a folder, so a restart resumes a
  // call whose carrier calls back. Unset (memory), nothing is saved, as it always was.
  const files = config.sessionStore
    ? openFileStores(resolvePath(config.sessionStore.dir), { tokenTtlMs: TOKEN_TTL_MS, now, log, fsync: config.sessionStore.fsync === true })
    : null;
  if (files) log(`sessions: file:${files.dir} (calls, chats and relay tokens are saved after every turn, and a restart resumes them)`);
  /** RESTART_PAUSE_S with the file store: how long a planned restart's handover asks each carrier to wait; 0 with none. */
  const restartPauseS = config.sessionStore?.restartPauseS ?? 0;
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
    { state: files?.calls ?? null, log },
  );
  const tokens: CallTokens = files?.tokens ?? new CallTokens(TOKEN_TTL_MS, now);
  /**
   * The calls saved before a restart whose carrier never called back, forgotten once past their time:
   * the one end of such a call nothing else sees, so it is recorded here, as the idle sweep records an
   * evicted call's.
   */
  const sweepSaved = (): void => {
    void store.sweepStored().then((gone) => {
      for (const c of gone) {
        log(`${c.callId}: saved before a restart and never called back; forgotten`);
        audit.append(c.callId, c.session.channel, { type: 'call_ended', detail: { reason: 'evicted' } });
      }
    });
  };
  if (files) sweepSaved();
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
  /** Set once the drain's wait is over (or close() has begun): a live call's reconnect goes to the handoff number. */
  let closing = false;
  /**
   * A planned restart's handover, from the end of the drain's wait on (drain, with the file store and
   * RESTART_PAUSE_S above 0): the calls whose carrier has yet to call back, and what to do once none
   * has. Null otherwise.
   */
  let handover: { waiting: Set<string>; done: () => void } | null = null;
  // The engine's own web chat, when CHAT=on: each session with the phone line's client, tools, audit chain and console.
  const chatSettings = config.chat;
  const chat = chatSettings
    ? chatEndpoint({
      settings: chatSettings, now, log, audit, bus, serviceUrls,
      anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary, summarizeHandoff: overrides.summarizeHandoff,
      startTimeoutMs: overrides.setupTimeoutMs, fetch: overrides.chatFetch, state: files?.chats ?? null,
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
  // Retention, when TRACE_RETENTION_DAYS or AUDIT_RETENTION_DAYS is set: a sweep now and once an hour after.
  const retention: RetentionSettings = {
    traceDir: config.traceDir, auditDir: config.auditDir, traceDays: config.traceRetentionDays, auditDays: config.auditRetentionDays,
  };
  const retaining = config.traceRetentionDays !== undefined || config.auditRetentionDays !== undefined;
  let retentionAt = now();
  const sweepDisk = (): void => {
    retentionAt = now();
    const inUse = new Set(store.liveCallSids().map(safeFileStem));
    const r = sweepRetention(retention, { now: retentionAt, inUse });
    log(`retention: removed ${r.traceFiles} trace files, ${r.auditDays} audit days`);
  };
  if (retaining) {
    const kept = (days: number | undefined) => (days === undefined ? 'forever' : `${days} days`);
    log(`retention: traces kept ${kept(config.traceRetentionDays)}, audit days kept ${kept(config.auditRetentionDays)}`);
    if (config.auditRetentionDays !== undefined) {
      log(`WARNING: AUDIT_RETENTION_DAYS=${config.auditRetentionDays}: audit day files older than ${config.auditRetentionDays} days are deleted, which ends the record for those days`);
    }
    sweepDisk();
  }
  const deps: HttpDeps = {
    config, store, tokens, hints: buildHints(app), log, bus, audit, routes, app,
    ...(consoleAuth ? { consoleAuth } : {}),
    draining: () => draining,
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
    ...(retaining ? { disk: diskUsageCache(config.traceDir, config.auditDir, now) } : {}),
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
      ...(config.noInputAfterSpeechMs !== undefined ? { noInputAfterSpeechMs: config.noInputAfterSpeechMs } : {}),
      ...(config.resumeAfterPauseMs !== undefined ? { resumeAfterPauseMs: config.resumeAfterPauseMs } : {}),
      ...(config.resumeIntoReplyMs !== undefined ? { resumeIntoReplyMs: config.resumeIntoReplyMs } : {}),
      handoffNumber: config.handoffNumber, serviceUrls, anthropicApiKey: config.anthropicApiKey, handoffSummaryOn: config.handoffSummary,
      summarizeHandoff: overrides.summarizeHandoff,
      bargeIn: config.bargeIn ?? 'any',
      // END_AFTER_PLAYBACK: absent from a config made by hand before it existed reads as auto, as loadConfig's default.
      endAfterPlayback: config.endAfterPlayback ?? 'auto',
      ...(config.endPlaybackMaxMs !== undefined ? { endPlaybackMaxMs: config.endPlaybackMaxMs } : {}),
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
    config.voiceProviders,
    chat ? { path: CHAT_PATH, handleUpgrade: (req, socket, head) => chat.handleUpgrade(req, socket, head) } : null,
    // Closing with the calls saved: a socket belongs to the restarted server (the handover, or a crash's close).
    () => closing && store.durable,
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
    if (files) sweepSaved();
    const swept = tokens.evictExpired();
    if (swept) log(`swept ${swept} expired call tokens`);
    if (retaining && now() - retentionAt >= RETENTION_EVERY_MS) sweepDisk();
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
  /** Stop taking new connections (those open go on); the same promise however often it is asked. */
  let stopped: Promise<void> | null = null;
  const stopListening = (): Promise<void> => (stopped ??= new Promise<void>((resolve) => server.close(() => resolve())));
  try {
    consoleAuth?.start(port);
  } catch (err) {
    // A link file that cannot be written safely is a setting to fix, not a console without a way in.
    clearInterval(evictor);
    chat?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
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
    drain: async (ms = config.drainMs ?? DEFAULT_DRAIN_MS) => {
      draining = true;
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
      clearInterval(evictor);
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
    if (running.bus) console.log(config.consoleAuth ? `[server] console ${base}/dashboard (sign in: pnpm console:link prints a link)` : `[server] console ${consoleBase}/dashboard`);
    for (const r of running.routes) console.log(`[server] ${r.label} ${(r.localOnly ? consoleBase : base)}${r.path}`);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

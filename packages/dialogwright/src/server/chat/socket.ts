import { randomBytes, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { WEB_CHAT } from '../../channel/caps';
import { signedInEvent, startEvent, textEvent, withCallData, type SessionEvent } from '../../channel/events';
import { callDataFrom, recordedContext } from '../../channel/callData';
import type { CallDataKey } from '../../core/app/types';
import { actionsToChatMessages, parseClientMessage, serializeServerMessage, type ClientMessage, type ServerMessage } from '../../channel/chat/protocol';
import { appOf } from '../../core/app/registry';
import { codeLengthOf } from '../../core/app/lookup';
import { defaultLocaleOf, localeOf } from '../../core/locale';
import type { Scrub } from '../../core/recording';
import { newSession, SESSION_SCHEMA } from '../../core/session';
import { tokenHash, type ChatStateStore, type StoredChat } from '../stores/types';
import { maskSpokenCode, spokenCodeMinDigits } from '../../core/spokenCode';
import { isAnonymous, type Party } from '../../gate/types';
import { whenChained, type RunOptions, type TurnRun } from '../../run/turn';
import { turnScrubber } from '../../trace/redact';
import { runChatTurnRuns, type ChatTurnDeps, type ChatTurnEntry } from '../chatTurn';
import type { ChatSettings } from '../config';
import type { ObservedCalls } from '../dashboard/observer';
import type { FrameSink } from '../frameLog';
import { originAllowed } from './origins';
import { jwksKeys } from './jwks';
import { isDelegate, principalForToken, type ChatSignIn } from './signin';

/**
 * The engine's web chat endpoint: `/chat`, a WebSocket speaking the chat wire
 * (src/channel/chat/protocol.ts), served when CHAT=on to the sites CHAT_ALLOWED_ORIGINS lists. Each
 * chat is a session on the web chat channel (WEB_CHAT), run turn by turn through the same path an
 * app's own chat takes (chatTurn.ts), with its trace, audit, console and handoff summary. A session
 * outlives its socket: a client that drops reconnects with the resume token `ready` gave it, until
 * the session has been idle for CHAT_IDLE_MS.
 */

/** The path the endpoint answers upgrades on. */
export const CHAT_PATH = '/chat';
/** A chat message is a line of text or a sign-in token; anything near this is not one (ws closes it with 1009). */
export const CHAT_MAX_PAYLOAD = 16 * 1024;
/** Malformed messages (cumulative) before the connection is treated as something other than a chat client. */
export const CHAT_MALFORMED_LIMIT = 10;
/**
 * Messages a session may have waiting for their reply (the one in hand included). A person waits for
 * an answer before typing much more; a client that does not is told `busy`, so it cannot queue
 * unbounded turns (each one a model call) behind a slow one.
 */
export const CHAT_MAX_WAITING = 5;
/** A connection that has not started a chat by now is closed. */
export const CHAT_START_TIMEOUT_MS = 10_000;
/** What a client that stops reading may leave unsent before its socket is closed. */
const MAX_BUFFERED = 1024 * 1024;
/** Who the console says a chat's handoff goes to: the site decides (a live-chat desk, a phone number, a form). */
const HANDOFF_TO = 'the site';
/** What a chat is told when a turn throws: a retry, rather than silence. */
export const CHAT_TURN_ERROR = 'Sorry, something went wrong on our side. Please send that again.';

/** What the server makes for a new chat session: its run options (client, tools, trace, audit, console) and its frame log. */
export interface ChatResources {
  opts: RunOptions;
  frames: FrameSink;
}

export interface ChatDeps extends ChatTurnDeps {
  settings: ChatSettings;
  /**
   * The app this endpoint's chats are in, on a server of several apps (host.yaml: each app's chat at
   * /chat/<app id>); a chat saved in another app is not resumed here. Absent, the default app, as before.
   */
  appId?: string;
  now: () => number;
  /** A new session's resources, by its id; `sessions` is where the console's observer finds it. */
  resources(id: string, sessions: ObservedCalls): ChatResources;
  /** Tests use a short deadline so a connection that never starts does not hold the suite open. */
  startTimeoutMs?: number;
  /** How the identity provider's published keys are fetched (CHAT_SIGNIN=jwt); tests serve their own. */
  fetch?: typeof fetch;
  /**
   * The key lookup for a JWKS URL (CHAT_SIGNIN=jwt), shared by the endpoints of a server of several apps
   * so each URL's keys are fetched and cached once; absent, this endpoint's own.
   */
  keysFor?: (url: string) => (kid: string) => Promise<KeyObject | null>;
  /**
   * Where each chat is saved after every turn, and found by its resume token after a restart
   * (SESSION_STORE=file, server/stores/file.ts). Absent or null (memory, the default), nowhere.
   */
  state?: ChatStateStore | null;
  /**
   * With several servers on one database (SESSION_STORE=postgres, stores/notices.ts): a chat restored
   * here from the store is announced, and one another server restored is let go here (its socket
   * closed, its session forgotten, the store left as that server saves it). Absent on one machine.
   */
  peers?: ChatPeers | null;
}

/** How the servers on one database tell each other a chat was resumed elsewhere. */
export interface ChatPeers {
  /** This server has taken the chat over from the store: resolves to the announcement's place among all servers' (its notice id), or null. */
  announce(id: string): Promise<number | null> | void;
  /** `fn` with each chat another server has taken over, and the place of that announcement. */
  onTaken(fn: (id: string, generation: number) => void): void;
}

/** One chat session, whichever socket it is on now. */
interface ChatEntry extends ChatTurnEntry {
  /** The token `ready` gave the client, to reopen the session after a drop; a new one each time it is used. */
  resume: string;
  socket: WebSocket | null;
  readonly frames: FrameSink;
  ended: boolean;
  tail: Promise<void>;
  inFlight: number;
  /** Work queued for the session and not yet done (CHAT_MAX_WAITING). */
  waiting: number;
  /** When the session started, as saved (StoredChat.createdAtMs). */
  readonly createdAtMs: number;
  /** How many times a server restored it from the store (StoredChat.restores); 0 for a chat that never moved. */
  readonly restores: number;
  /** Let go to a server that restored it later: what this server still writes for it is late. */
  movedAway?: boolean;
  /**
   * With several servers: the place of this server's announcement that it restored the chat (0 for a
   * chat that started here). Another server's announcement lets the chat go here only when it is later.
   */
  generation?: Promise<number>;
}

/** One WebSocket connection, before and after it has a session. */
interface ChatConnection {
  readonly ws: WebSocket;
  id: string | null;
  malformed: number;
  startTimer: ReturnType<typeof setTimeout> | null;
  /** A resume is being looked up in the session store: a second start waits for no one. */
  starting?: boolean;
}

export interface ChatEndpoint {
  /** Take an upgrade on CHAT_PATH: refused with 403 before the upgrade unless its Origin is allowed. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** One pass of the idle sweep: a session nobody has written to for CHAT_IDLE_MS is ended. */
  sweep(): void;
  /** Work in flight, for a shutdown that lets it finish. */
  tails(): Promise<void>[];
  /** Close every chat socket (the server is going away). */
  close(): void;
  /** Sessions not yet ended. */
  liveCount(): number;
  /** Their ids (what retention never removes the traces of). */
  liveIds(): string[];
  /**
   * Sessions someone is in now: with a socket open, or a turn under way. A session whose socket has
   * dropped waits for a resume until it is idle (CHAT_IDLE_MS), but no one is waiting on it.
   */
  activeCount(): number;
  /** The server is stopping: a new chat is refused `busy` from now on, and a resume is still taken. */
  drain(): void;
  /** Every save and removal queued for the session store so far, done (nothing to wait for without one). */
  settled?(): Promise<void>;
}

const fresh = (): string => randomBytes(16).toString('hex');

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A client message as the frame log keeps it: a token or resume token is never written, only that there was one. */
function loggedIn(m: ClientMessage, text?: string, spec?: Readonly<Record<string, CallDataKey>>): Record<string, unknown> {
  switch (m.type) {
    case 'start':
      return {
        type: 'start', v: m.v, ...(m.locale !== undefined ? { locale: m.locale } : {}), ...(m.token !== undefined ? { token: true } : {}), ...(m.resume !== undefined ? { resume: true } : {}),
        // The page's context, each key an app's callData reads as that key's redact says, every other one redacted.
        ...(m.context !== undefined ? { context: recordedContext(spec, m.context) } : {}),
      };
    case 'sign_in':
      return { type: 'sign_in', token: true };
    case 'text':
      return { type: 'text', text: text ?? m.text };
    case 'ping':
      return { type: 'ping' };
  }
}

/** A server message as the frame log keeps it: a line scrubbed as voice text frames are (adapter.ts loggedFrame), the resume token left out. */
function loggedOut(m: ServerMessage, scrub: Scrub | null): Record<string, unknown> {
  if (m.type === 'say' && scrub !== null) return { ...m, text: scrub(m.text) };
  if (m.type === 'ready') return { type: 'ready', session: m.session, locale: m.locale };
  return m;
}

/** A token checked: the principal it names, or the error the client is sent (with a reason that never carries the token). */
type Verified = { ok: true; principal: Party } | { ok: false; error: ServerMessage };

const refusal = (reason: string): ServerMessage => ({ type: 'error', code: 'sign_in_failed', message: `the sign-in was refused (${reason})` });

/** Whether the session is now signed in as `p`: the core took the sign-in (core/turn.ts auth.signed_in). */
function signedInAs(e: { session: { principal: unknown } }, p: Party): boolean {
  const q = e.session.principal as Partial<Party>;
  return q.kind === p.kind && q.id === p.id && q.level === p.level;
}

export function chatEndpoint(deps: ChatDeps): ChatEndpoint {
  const { log, now } = deps;
  const how = deps.settings.signIn;
  const signIn: ChatSignIn = how.method === 'jwt'
    ? { method: 'jwt', keyFor: deps.keysFor ? deps.keysFor(how.jwksUrl) : jwksKeys({ url: how.jwksUrl, fetch: deps.fetch, nowMs: now, log }), issuer: how.issuer, audience: how.audience }
    : how;
  const sessions = new Map<string, ChatEntry>();
  /** Whether the refusal for CHAT_MAX_SESSIONS has been logged since a session last ended (said once, not per refusal). */
  let fullLogged = false;
  const resumeIds = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHAT_MAX_PAYLOAD });
  /** Set when the server starts to stop (ChatEndpoint.drain). */
  let draining = false;

  const unwritable = new WeakSet<FrameSink>();
  /**
   * One frame log line, where what the client is sent and the session's work must go on whether or
   * not it can be written (a full disk, a removed trace directory): a failure is logged, not thrown.
   */
  const record = (frames: FrameSink | null, dir: 'in' | 'out' | 'log', msg: unknown): void => {
    if (frames === null) return;
    try {
      frames.write(dir, msg);
    } catch (err) {
      // Said once per frame log, not on every line it cannot take.
      if (!unwritable.has(frames)) log(`chat: could not write a frame log: ${describeError(err)}`);
      unwritable.add(frames);
    }
  };

  /** Send one message on `ws`, and log it to the session's frame log when there is one. */
  const send = (ws: WebSocket | null, frames: FrameSink | null, m: ServerMessage, scrub: Scrub | null = null): void => {
    const logged = loggedOut(m, scrub);
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      record(frames, 'log', { dropped: logged });
      return;
    }
    if (ws.bufferedAmount > MAX_BUFFERED) {
      record(frames, 'log', { dropped: logged, stalled: true });
      ws.close(1008, 'not reading');
      return;
    }
    ws.send(serializeServerMessage(m));
    record(frames, 'out', logged);
  };
  const sendTo = (e: ChatEntry, m: ServerMessage, scrub: Scrub | null = null): void => send(e.socket, e.frames, m, scrub);

  /** Run `fn` after everything already queued for the session; an ended session skips it, an error is logged and the queue goes on. */
  const enqueue = (e: ChatEntry, fn: (e: ChatEntry) => Promise<void>): Promise<void> => {
    e.waiting += 1;
    const run = e.tail
      .then(async () => {
        if (e.ended) return;
        e.inFlight += 1;
        try {
          await fn(e);
        } finally {
          e.inFlight -= 1;
        }
      })
      .catch((err: unknown) => {
        log(`chat ${e.id}: ${describeError(err)}`);
        record(e.frames, 'log', { error: describeError(err) });
      })
      .finally(() => {
        e.waiting -= 1;
      });
    e.tail = run.catch(() => {});
    return run;
  };

  const state = deps.state ?? null;
  /** Each chat's saves and removals, in order, so a slow store never writes an older save over a newer one. */
  const writes = new Map<string, Promise<void>>();
  const queueWrite = (id: string, what: string, write: (st: ChatStateStore) => unknown): void => {
    if (state === null) return;
    const run = (writes.get(id) ?? Promise.resolve())
      .then(() => write(state))
      .then(() => undefined, (err: unknown) => log(`chat ${id}: could not ${what}: ${describeError(err)}`));
    writes.set(id, run);
    void run.then(() => {
      if (writes.get(id) === run) writes.delete(id);
    });
  };
  /** Save the chat as it is now (after a turn, a resume); nothing without a session store. */
  const save = (e: ChatEntry): void => {
    if (state === null || e.ended) return;
    const chat: StoredChat = {
      id: e.id, schema: SESSION_SCHEMA, session: e.session, resumeHash: tokenHash(e.resume),
      createdAtMs: e.createdAtMs, lastActivityMs: e.lastActivityMs, auditTail: [...e.auditEntries],
      ...(e.restores > 0 ? { restores: e.restores } : {}),
    };
    queueWrite(e.id, 'save the session', (st) => st.save(chat));
  };

  /** The session is over: forget it, and close its socket once what was sent has gone. */
  const finish = (e: ChatEntry, reason: string): void => {
    e.ended = true;
    sessions.delete(e.id);
    queueWrite(e.id, 'remove the saved session', (st) => st.remove(e.id));
    fullLogged = false;
    resumeIds.delete(e.resume);
    record(e.frames, 'log', { ended: reason });
    e.socket?.close(1000, 'chat ended');
  };

  /**
   * One turn (and any a downstream service's answer runs after it), with what it said sent; the
   * session finished if it ended. `before` is sent ahead of the turn's lines, read once the turn has
   * run (the opening turn's ready names the language the turn chose).
   */
  const turn = async (e: ChatEntry, event: SessionEvent, before: (e: ChatEntry) => ServerMessage[] = () => []): Promise<void> => {
    let runs: TurnRun[];
    try {
      runs = await runChatTurnRuns(deps, e, event, now, HANDOFF_TO);
    } catch (err) {
      log(`chat ${e.id}: turn failed: ${describeError(err)}`);
      // The client is told first, whatever the log can take.
      for (const m of before(e)) sendTo(e, m);
      sendTo(e, { type: 'error', code: 'server_error', message: CHAT_TURN_ERROR });
      record(e.frames, 'log', { turnFailed: describeError(err) });
      return;
    }
    // The app's start hook threw (App.onStart): said by its kind, never its message; the chat went on.
    for (const r of runs) {
      if (r.result.startHookFailed === undefined) continue;
      log(`chat ${e.id}: the app's start hook failed (${r.result.startHookFailed}); the chat goes on`);
      record(e.frames, 'log', { startHookFailed: r.result.startHookFailed });
    }
    for (const m of before(e)) sendTo(e, m);
    let last: ServerMessage['type'] | null = null;
    for (const r of runs) {
      const app = appOf(r.result.session);
      // Built from the session after the turn and its decision, as the voice frame log's is.
      const scrub = turnScrubber(r.result.session, r.result.decision, 'length', app);
      for (const m of actionsToChatMessages(r.result.actions, defaultLocaleOf(app))) {
        sendTo(e, m, scrub);
        last = m.type;
      }
    }
    if (e.session.ended) {
      // A transfer ends the session too: the client is told it is over either way.
      if (last !== 'end') sendTo(e, { type: 'end' });
      finish(e, runs.at(-1)?.result.decision.kind ?? 'ended');
    } else save(e);
  };

  /** A token checked against the deployment's method and the app's rule; a refusal logged by its reason, never the token. */
  const verify = async (e: ChatEntry, token: string): Promise<Verified> => {
    if (signIn.method === 'none') return { ok: false, error: { type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' } };
    let r: Awaited<ReturnType<typeof principalForToken>>;
    try {
      r = await principalForToken(appOf(e.session), signIn, token, Math.floor(now() / 1000));
    } catch (err) {
      // The app's own code (principals.fromClaims, subjectPrincipal) threw: a refusal, not a chat that never opens.
      log(`chat ${e.id}: sign-in failed in the app's code: ${describeError(err)}`);
      r = { ok: false, reason: 'the app could not read the token' };
    }
    if (!r.ok) {
      log(`chat ${e.id}: sign-in refused (${r.reason})`);
      record(e.frames, 'log', { signInRefused: r.reason });
      return { ok: false, error: refusal(r.reason) };
    }
    return { ok: true, principal: r.principal };
  };

  /** A subject signs in: the core's auth.signed_in turn, and signed_in ahead of its lines only if the core took it. */
  const signInTurn = async (e: ChatEntry, p: Party): Promise<void> => {
    if (!isAnonymous(e.session.principal)) {
      sendTo(e, refusal('the chat is already signed in'));
      return;
    }
    await turn(e, signedInEvent(p), (s) => {
      if (!signedInAs(s, p)) return [refusal('the chat could not take this sign-in')];
      log(`chat ${s.id}: signed in (${p.kind}, level ${p.level})`);
      record(s.frames, 'log', { signedIn: p.level, kind: p.kind });
      return [{ type: 'signed_in', level: p.level }];
    });
  };

  /** A sign-in after the start (a sign_in message, or a resume's token on a chat still anonymous): a subject only, since a delegate's chat begins as theirs. */
  const laterSignIn = async (e: ChatEntry, token: string): Promise<void> => {
    const r = await verify(e, token);
    if (!r.ok) {
      sendTo(e, r.error);
      return;
    }
    if (isDelegate(appOf(e.session), r.principal)) {
      sendTo(e, refusal('a delegate signs in as the chat starts'));
      return;
    }
    await signInTurn(e, r.principal);
  };

  /** A new session for a start, its opening turn queued: ready, then the opening lines. */
  const open = (conn: ChatConnection, m: Extract<ClientMessage, { type: 'start' }>): void => {
    // A new chat only: a resume reopens a session already counted, and is never refused for the limit.
    if (draining) {
      log('chat refused: the server is stopping');
      send(conn.ws, null, { type: 'error', code: 'busy', message: 'the chat is restarting: try again in a moment' });
      conn.ws.close(1013, 'busy');
      return;
    }
    if (sessions.size >= deps.settings.maxSessions) {
      if (!fullLogged) log(`chat refused: ${sessions.size} chat sessions are live, the most CHAT_MAX_SESSIONS allows`);
      fullLogged = true;
      send(conn.ws, null, { type: 'error', code: 'busy', message: 'too many chats are open: try again later' });
      conn.ws.close(1013, 'busy');
      return;
    }
    const id = fresh();
    const { opts, frames } = deps.resources(id, { get: (sid) => sessions.get(sid) });
    const e: ChatEntry = {
      id, session: deps.appId === undefined ? newSession(id, now(), WEB_CHAT) : newSession(id, now(), WEB_CHAT, undefined, deps.appId), auditEntries: [], opts, lastActivityMs: now(),
      resume: fresh(), socket: conn.ws, frames, ended: false, tail: Promise.resolve(), inFlight: 0, waiting: 0, createdAtMs: now(), restores: 0,
    };
    sessions.set(id, e);
    resumeIds.set(e.resume, id);
    conn.id = id;
    record(e.frames, 'in', loggedIn(m, undefined, appOf(e.session).callData));
    // Ahead of the opening turn, and it is what resets the console's history: the page follows this chat now.
    deps.bus?.publish({ type: 'call_started', callSid: id, at: now(), from: 'web chat', todayIso: opts.todayIso, thresholds: opts.thresholds, channel: 'chat', caller: null, ...(deps.appId !== undefined ? { app: deps.appId } : {}) });
    void enqueue(e, async (s) => {
      // A token on start: a delegate's chat begins as theirs (as the harness's `as` does); a subject signs
      // in through the core once the chat has opened, as a later sign-in does.
      let refused: ServerMessage | null = null;
      let subject: Party | null = null;
      let delegate: Party | null = null;
      if (m.token !== undefined) {
        const r = await verify(s, m.token);
        if (!r.ok) refused = r.error;
        else if (isDelegate(appOf(s.session), r.principal)) delegate = r.principal;
        else subject = r.principal;
      }
      if (delegate !== null) {
        s.session = newSession(s.id, s.session.startedAtMs, WEB_CHAT, delegate, s.session.appId);
        log(`chat ${s.id}: signed in (${delegate.kind}, level ${delegate.level})`);
        record(s.frames, 'log', { signedIn: delegate.level, kind: delegate.kind });
      }
      const signedIn: ServerMessage[] = delegate === null ? [] : [{ type: 'signed_in', level: delegate.level }];
      // The client asks for a language; the core matches it to one of the app's (core/locale.ts matchLocale),
      // and ready names the one the session speaks.
      // The page's context, by the app's callData keys (chat.<key>); none for an app that names none.
      const data = m.context !== undefined ? callDataFrom(appOf(s.session).callData, {}, m.context) : {};
      await turn(s, withCallData(startEvent({ channel: 'chat' }, m.locale), data), (x) => [...ready(x), ...signedIn]);
      if (refused !== null) sendTo(s, refused);
      if (subject !== null && !s.ended) await signInTurn(s, subject);
    });
  };

  const ready = (e: ChatEntry): ServerMessage[] => [{ type: 'ready', session: e.id, resume: e.resume, locale: localeOf(e.session) }];

  /** Reopen a live session on this connection: a fresh resume token, the old socket closed, ready sent. */
  const resumeOn = (conn: ChatConnection, e: ChatEntry, m: Extract<ClientMessage, { type: 'start' }>): void => {
    // A fresh token each time one is used: a token seen once (a log, a shoulder) opens nothing later.
    resumeIds.delete(e.resume);
    e.resume = fresh();
    resumeIds.set(e.resume, e.id);
    const previous = e.socket;
    if (previous !== null && previous !== conn.ws) previous.close(1000, 'resumed elsewhere');
    e.socket = conn.ws;
    e.lastActivityMs = now();
    conn.id = e.id;
    // A resume's context is the page's again, and changes nothing: the chat keeps what it started with.
    record(e.frames, 'in', loggedIn(m, undefined, appOf(e.session).callData));
    // Saved with its new token, so the one just used opens nothing after a restart either.
    save(e);
    // At once, ahead of a reply still in flight (which goes to this socket when it is done), so the
    // client has its session and new resume token before any line; nothing is resent.
    for (const r of ready(e)) sendTo(e, r);
    // A resume keeps the sign-in the chat had. A token beside it is there for the new chat that
    // starts if this one has ended (below), so a client can ask for both without knowing which it
    // gets: it signs in a chat still anonymous, and is not used (nor refused) on one signed in.
    const token = m.token;
    if (token !== undefined) {
      void enqueue(e, async (s) => {
        if (isAnonymous(s.session.principal)) await laterSignIn(s, token);
      });
    }
  };

  /**
   * A chat this server does not hold, saved by the one before it (SESSION_STORE=file), found by the
   * hash of its resume token: a live session again, or null when there is none to resume (never saved,
   * idle past CHAT_IDLE_MS, or saved under another SESSION_SCHEMA or for an app this server does not
   * run, which is then forgotten).
   */
  const restore = async (resume: string): Promise<ChatEntry | null> => {
    if (state === null) return null;
    let c: StoredChat | null;
    try {
      c = await state.findByResume(tokenHash(resume));
    } catch (err) {
      log(`chat: could not look up a resume in the session store: ${describeError(err)}`);
      return null;
    }
    if (c === null) return null;
    const held = sessions.get(c.id);
    if (held !== undefined) return held.ended ? null : held;
    // On a host, a chat is resumed only at its own app's path: another app's is not this endpoint's to take.
    if (deps.appId !== undefined && c.session.appId !== deps.appId) return null;
    let readable = c.schema === SESSION_SCHEMA;
    if (readable) {
      try {
        appOf(c.session);
      } catch {
        readable = false;
      }
    }
    if (!readable || c.session.ended || now() - c.lastActivityMs >= deps.settings.idleMs) {
      if (!readable) log(`chat ${c.id}: not resumed: saved under session schema ${c.schema} or for an app this server does not run`);
      queueWrite(c.id, 'remove the saved session', (st) => st.remove(c.id));
      return null;
    }
    const { opts, frames } = deps.resources(c.id, { get: (sid) => sessions.get(sid) });
    const e: ChatEntry = {
      id: c.id, session: c.session, auditEntries: [...c.auditTail], opts, lastActivityMs: now(), resume: resume, socket: null, frames,
      ended: false, tail: Promise.resolve(), inFlight: 0, waiting: 0, createdAtMs: c.createdAtMs, restores: (c.restores ?? 0) + 1,
    };
    sessions.set(e.id, e);
    resumeIds.set(e.resume, e.id);
    log(`chat ${e.id}: restored from the session store`);
    record(e.frames, 'log', { restored: true });
    // Another server may still hold it, its socket open: it lets it go (unless it restored it later than this).
    if (deps.peers) e.generation = Promise.resolve(deps.peers.announce(e.id)).then((n) => n ?? 0, () => 0);
    return e;
  };

  // A chat another server restored from the store is no longer this server's: its socket here is
  // closed as a resume on this server closes the one before it, and its session forgotten without an
  // end (the chat goes on there, and that server saves it from now on).
  deps.peers?.onTaken((id, generation) => {
    const held = sessions.get(id);
    if (held === undefined || held.ended) return;
    void (held.generation ?? Promise.resolve(0)).then((mine) => {
      // An announcement older than this server's own restore is stale: this server has the chat now.
      if (mine >= generation) return;
      letGo(id, held);
    });
  });
  const letGo = (id: string, e: ChatEntry): void => {
    if (sessions.get(id) !== e || e.ended) return;
    e.ended = true;
    e.movedAway = true;
    sessions.delete(id);
    resumeIds.delete(e.resume);
    log(`chat ${id}: resumed on another server; let go here`);
    record(e.frames, 'log', { resumedElsewhere: true });
    e.socket?.close(1000, 'resumed elsewhere');
    e.socket = null;
  };

  const start = (conn: ChatConnection, m: Extract<ClientMessage, { type: 'start' }>): void => {
    if (m.resume !== undefined) {
      const resume = m.resume;
      const id = resumeIds.get(resume);
      const e = id === undefined ? undefined : sessions.get(id);
      if (e !== undefined && !e.ended) {
        resumeOn(conn, e, m);
        return;
      }
      if (state !== null) {
        // Saved by the server before this one, perhaps: looked up before the chat is said to have ended.
        conn.starting = true;
        void restore(resume)
          .catch(() => null)
          .then((found) => {
            conn.starting = false;
            if (conn.ws.readyState !== WebSocket.OPEN) return;
            if (found !== null && !found.ended) {
              resumeOn(conn, found, m);
              return;
            }
            send(conn.ws, null, { type: 'error', code: 'session_unknown', message: 'that chat has ended; a new one starts' });
            open(conn, m);
          });
        return;
      }
      send(conn.ws, null, { type: 'error', code: 'session_unknown', message: 'that chat has ended; a new one starts' });
    }
    open(conn, m);
  };

  const onMessage = (conn: ChatConnection, data: RawData, isBinary: boolean): void => {
    const entry = conn.id === null ? undefined : sessions.get(conn.id);
    const parsed = isBinary ? { ok: false as const, code: 'bad_message' as const, message: 'a message is one JSON object, as text' } : parseClientMessage(data.toString());
    if (!parsed.ok) {
      if (parsed.code === 'bad_message') conn.malformed += 1;
      record(entry?.frames ?? null, 'in', { refused: parsed.code });
      send(conn.ws, entry?.frames ?? null, { type: 'error', code: parsed.code, message: parsed.message });
      if (conn.malformed >= CHAT_MALFORMED_LIMIT) {
        if (conn.malformed === CHAT_MALFORMED_LIMIT) log(`chat ${conn.id ?? 'unstarted'}: closing after ${conn.malformed} malformed messages`);
        record(entry?.frames ?? null, 'log', { malformedLimit: conn.malformed });
        conn.ws.close(1007, 'malformed messages');
      }
      return;
    }
    const m = parsed.message;
    if (m.type === 'ping') {
      send(conn.ws, null, { type: 'pong' });
      return;
    }
    if (m.type === 'start') {
      if (conn.id !== null || conn.starting === true) {
        send(conn.ws, entry?.frames ?? null, { type: 'error', code: 'not_allowed', message: 'this chat has started' });
        return;
      }
      if (conn.startTimer !== null) clearTimeout(conn.startTimer);
      conn.startTimer = null;
      start(conn, m);
      return;
    }
    if (conn.id === null) {
      send(conn.ws, null, { type: 'error', code: 'not_allowed', message: 'the first message is start' });
      return;
    }
    if (entry === undefined || entry.ended) {
      send(conn.ws, null, { type: 'error', code: 'session_unknown', message: 'that chat has ended' });
      return;
    }
    // A socket a resume has replaced speaks for the session no more.
    if (entry.socket !== conn.ws) {
      send(conn.ws, null, { type: 'error', code: 'session_unknown', message: 'this chat goes on on another connection' });
      return;
    }
    // A client that does not wait for its replies: told to, rather than queueing turn after turn.
    if (entry.waiting >= CHAT_MAX_WAITING) {
      record(entry.frames, 'in', { refused: 'busy' });
      send(conn.ws, entry.frames, { type: 'error', code: 'busy', message: 'wait for the reply to what was sent' });
      return;
    }
    if (m.type === 'text') {
      // A one-time code typed at the code prompt is masked before the frame log sees it, as a spoken one is (adapter.ts maskCodeFrame).
      const masked = entry.session.promptedFor === 'otp' ? maskSpokenCode(m.text, spokenCodeMinDigits(codeLengthOf(appOf(entry.session)))).text : m.text;
      record(entry.frames, 'in', loggedIn(m, masked));
      void enqueue(entry, (s) => turn(s, textEvent(m.text)));
      return;
    }
    // sign_in: in the session's queue, so it is taken in order with what was typed around it.
    record(entry.frames, 'in', loggedIn(m));
    const token = m.token;
    void enqueue(entry, (s) => laterSignIn(s, token));
  };

  const onConnection = (ws: WebSocket): void => {
    const conn: ChatConnection = { ws, id: null, malformed: 0, startTimer: null };
    conn.startTimer = setTimeout(() => {
      conn.startTimer = null;
      if (conn.id !== null) return;
      log('chat connection closed: no start within the deadline');
      send(ws, null, { type: 'error', code: 'not_allowed', message: 'the first message is start' });
      ws.close(1008, 'no start');
    }, deps.startTimeoutMs ?? CHAT_START_TIMEOUT_MS);
    conn.startTimer.unref?.();
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (err) {
        log(`chat ${conn.id ?? 'unstarted'}: message handler failed: ${describeError(err)}`);
        // Answered, never silence: the client may send it again.
        try {
          send(ws, null, { type: 'error', code: 'server_error', message: CHAT_TURN_ERROR });
        } catch {
          // The socket itself is gone; its close handler does the rest.
        }
      }
    });
    ws.on('close', () => {
      if (conn.startTimer !== null) clearTimeout(conn.startTimer);
      const e = conn.id === null ? undefined : sessions.get(conn.id);
      // A drop is not the end: the session waits for a resume until it is idle too long.
      if (e !== undefined && e.socket === ws) {
        e.socket = null;
        // An event handler must never throw (a full disk, a removed trace directory): it would take the server down.
        record(e.frames, 'log', { socketClosed: true });
      }
    });
    ws.on('error', (err) => log(`chat ${conn.id ?? 'unstarted'}: socket error ${err.message}`));
  };

  const sweepSaved = async (cutoff: number): Promise<void> => {
    if (state === null) return;
    try {
      for (const id of await state.list()) {
        if (sessions.has(id)) continue;
        const c = await state.load(id);
        if (c === null || sessions.has(id) || c.lastActivityMs > cutoff) continue;
        // On a host, another app's chat is its own endpoint's to end.
        if (deps.appId !== undefined && c.session.appId !== deps.appId) continue;
        queueWrite(id, 'remove the saved session', (st) => st.remove(id));
        log(`chat ${id}: saved before a restart and never resumed; ended after ${deps.settings.idleMs} ms idle`);
        whenChained(deps.audit.append(id, 'chat', { type: 'call_ended', detail: { reason: 'abandoned' } }), () => {},
          (err: unknown) => log(`chat ${id}: the abandoned chat's audit entry failed: ${describeError(err)}`));
      }
    } catch (err) {
      log(`chat: could not sweep the session store: ${describeError(err)}`);
    }
  };

  return {
    handleUpgrade(req, socket, head) {
      const origin = req.headers.origin;
      if (!originAllowed(deps.settings.origins, origin)) {
        log(`chat upgrade refused: origin ${origin === undefined ? 'missing' : JSON.stringify(origin.slice(0, 100))} is not allowed`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, onConnection);
    },
    sweep() {
      const cutoff = now() - deps.settings.idleMs;
      for (const e of [...sessions.values()]) {
        if (e.ended || e.inFlight > 0 || e.lastActivityMs > cutoff) continue;
        log(`chat ${e.id}: ended after ${deps.settings.idleMs} ms idle`);
        try {
          whenChained(deps.audit.append(e.id, 'chat', { type: 'call_ended', detail: { reason: 'abandoned' } }), (entry) => e.auditEntries.push(entry),
            (err: unknown) => log(`chat ${e.id}: the idle end's audit entry failed: ${describeError(err)}`));
          deps.bus?.publish({ type: 'ended', callSid: e.id, at: now(), reason: 'abandoned' });
          sendTo(e, { type: 'end' });
        } catch (err) {
          log(`chat ${e.id}: idle end failed: ${describeError(err)}`);
        }
        // Forgotten whatever failed above: an idle session is never kept for want of a log line.
        finish(e, 'idle');
      }
      // The chats saved before a restart that no one resumed, once idle as long: forgotten, and their end recorded.
      if (state !== null) void sweepSaved(cutoff);
    },
    tails() {
      return [...sessions.values()].map((e) => e.tail);
    },
    close() {
      for (const ws of wss.clients) ws.close(1001, 'server closing');
      wss.close();
    },
    liveCount() {
      return sessions.size;
    },
    liveIds() {
      return [...sessions.keys()];
    },
    activeCount() {
      let n = 0;
      for (const e of sessions.values()) if (e.socket !== null || e.inFlight > 0 || e.waiting > 0) n += 1;
      return n;
    },
    drain() {
      draining = true;
    },
    async settled() {
      await Promise.all([...writes.values()]);
    },
  };
}

/**
 * The web chat of a server of several apps (host.yaml): each app's endpoint at `/chat/<app id>`, and the
 * default app's at CHAT_PATH (`/chat`) too, as on a server of one. An upgrade to any other path under
 * it is refused 404. What a stop or a sweep asks is asked of every endpoint.
 */
export interface ChatByApp extends ChatEndpoint {
  /** Whether an upgrade's path is a chat's: `/chat` or `/chat/<app id>` for an app the host runs. */
  owns(path: string): boolean;
  /** Each app's endpoint, by its id. */
  readonly endpoints: ReadonlyMap<string, ChatEndpoint>;
}

export function chatByApp(endpoints: ReadonlyMap<string, ChatEndpoint>, defaultApp: string): ChatByApp {
  const all = (): ChatEndpoint[] => [...endpoints.values()];
  const endpointOf = (path: string): ChatEndpoint | undefined => {
    if (path === CHAT_PATH) return endpoints.get(defaultApp);
    if (!path.startsWith(`${CHAT_PATH}/`)) return undefined;
    const id = path.slice(CHAT_PATH.length + 1);
    return endpoints.get(id);
  };
  return {
    endpoints,
    owns: (path) => path === CHAT_PATH || path.startsWith(`${CHAT_PATH}/`),
    handleUpgrade(req, socket, head) {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const endpoint = endpointOf(path);
      if (endpoint === undefined) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      endpoint.handleUpgrade(req, socket, head);
    },
    sweep: () => all().forEach((e) => e.sweep()),
    tails: () => all().flatMap((e) => e.tails()),
    close: () => all().forEach((e) => e.close()),
    liveCount: () => all().reduce((n, e) => n + e.liveCount(), 0),
    liveIds: () => all().flatMap((e) => e.liveIds()),
    activeCount: () => all().reduce((n, e) => n + e.activeCount(), 0),
    drain: () => all().forEach((e) => e.drain()),
    async settled() {
      await Promise.all(all().map((e) => e.settled?.()));
    },
  };
}

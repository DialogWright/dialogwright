import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { WEB_CHAT } from '../../channel/caps';
import { signedInEvent, startEvent, textEvent, type SessionEvent } from '../../channel/events';
import { actionsToChatMessages, parseClientMessage, serializeServerMessage, type ClientMessage, type ServerMessage } from '../../channel/chat/protocol';
import { appOf } from '../../core/app/registry';
import { codeLengthOf } from '../../core/app/lookup';
import { defaultLocaleOf, localeOf } from '../../core/locale';
import type { Scrub } from '../../core/recording';
import { newSession } from '../../core/session';
import { maskSpokenCode, spokenCodeMinDigits } from '../../core/spokenCode';
import { isAnonymous, type Party } from '../../gate/types';
import type { RunOptions, TurnRun } from '../../run/turn';
import { turnScrubber } from '../../trace/redact';
import { runChatTurnRuns, type ChatTurnDeps, type ChatTurnEntry } from '../chatTurn';
import type { ChatSettings } from '../config';
import type { ObservedCalls } from '../dashboard/observer';
import type { FrameLog } from '../frameLog';
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
  frames: FrameLog;
}

export interface ChatDeps extends ChatTurnDeps {
  settings: ChatSettings;
  now: () => number;
  /** A new session's resources, by its id; `sessions` is where the console's observer finds it. */
  resources(id: string, sessions: ObservedCalls): ChatResources;
  /** Tests use a short deadline so a connection that never starts does not hold the suite open. */
  startTimeoutMs?: number;
  /** How the identity provider's published keys are fetched (CHAT_SIGNIN=jwt); tests serve their own. */
  fetch?: typeof fetch;
}

/** One chat session, whichever socket it is on now. */
interface ChatEntry extends ChatTurnEntry {
  /** The token `ready` gave the client, to reopen the session after a drop; a new one each time it is used. */
  resume: string;
  socket: WebSocket | null;
  readonly frames: FrameLog;
  ended: boolean;
  tail: Promise<void>;
  inFlight: number;
  /** Work queued for the session and not yet done (CHAT_MAX_WAITING). */
  waiting: number;
}

/** One WebSocket connection, before and after it has a session. */
interface ChatConnection {
  readonly ws: WebSocket;
  id: string | null;
  malformed: number;
  startTimer: ReturnType<typeof setTimeout> | null;
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
}

const fresh = (): string => randomBytes(16).toString('hex');

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A client message as the frame log keeps it: a token or resume token is never written, only that there was one. */
function loggedIn(m: ClientMessage, text?: string): Record<string, unknown> {
  switch (m.type) {
    case 'start':
      return { type: 'start', v: m.v, ...(m.locale !== undefined ? { locale: m.locale } : {}), ...(m.token !== undefined ? { token: true } : {}), ...(m.resume !== undefined ? { resume: true } : {}) };
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
    ? { method: 'jwt', keyFor: jwksKeys({ url: how.jwksUrl, fetch: deps.fetch, nowMs: now, log }), issuer: how.issuer, audience: how.audience }
    : how;
  const sessions = new Map<string, ChatEntry>();
  /** Whether the refusal for CHAT_MAX_SESSIONS has been logged since a session last ended (said once, not per refusal). */
  let fullLogged = false;
  const resumeIds = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHAT_MAX_PAYLOAD });

  /** Send one message on `ws`, and log it to the session's frame log when there is one. */
  const send = (ws: WebSocket | null, frames: FrameLog | null, m: ServerMessage, scrub: Scrub | null = null): void => {
    const logged = loggedOut(m, scrub);
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      frames?.write('log', { dropped: logged });
      return;
    }
    if (ws.bufferedAmount > MAX_BUFFERED) {
      frames?.write('log', { dropped: logged, stalled: true });
      ws.close(1008, 'not reading');
      return;
    }
    ws.send(serializeServerMessage(m));
    frames?.write('out', logged);
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
        try {
          e.frames.write('log', { error: describeError(err) });
        } catch {
          // Nothing more to do: the queue must go on.
        }
      })
      .finally(() => {
        e.waiting -= 1;
      });
    e.tail = run.catch(() => {});
    return run;
  };

  /** The session is over: forget it, and close its socket once what was sent has gone. */
  const finish = (e: ChatEntry, reason: string): void => {
    e.ended = true;
    sessions.delete(e.id);
    fullLogged = false;
    resumeIds.delete(e.resume);
    try {
      e.frames.write('log', { ended: reason });
    } catch (err) {
      log(`chat ${e.id}: could not log the end: ${describeError(err)}`);
    }
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
      e.frames.write('log', { turnFailed: describeError(err) });
      for (const m of before(e)) sendTo(e, m);
      sendTo(e, { type: 'error', code: 'server_error', message: CHAT_TURN_ERROR });
      return;
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
    }
  };

  /** A token checked against the deployment's method and the app's rule; a refusal logged by its reason, never the token. */
  const verify = async (e: ChatEntry, token: string): Promise<Verified> => {
    if (signIn.method === 'none') return { ok: false, error: { type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' } };
    const r = await principalForToken(appOf(e.session), signIn, token, Math.floor(now() / 1000));
    if (!r.ok) {
      log(`chat ${e.id}: sign-in refused (${r.reason})`);
      e.frames.write('log', { signInRefused: r.reason });
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
      s.frames.write('log', { signedIn: p.level, kind: p.kind });
      return [{ type: 'signed_in', level: p.level }];
    });
  };

  /** A sign-in after the start (a sign_in message, or a resume's token): a subject only, since a delegate's chat begins as theirs. */
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
      id, session: newSession(id, now(), WEB_CHAT), auditEntries: [], opts, lastActivityMs: now(),
      resume: fresh(), socket: conn.ws, frames, ended: false, tail: Promise.resolve(), inFlight: 0, waiting: 0,
    };
    sessions.set(id, e);
    resumeIds.set(e.resume, id);
    conn.id = id;
    frames.write('in', loggedIn(m));
    // Ahead of the opening turn, and it is what resets the console's history: the page follows this chat now.
    deps.bus?.publish({ type: 'call_started', callSid: id, at: now(), from: 'web chat', todayIso: opts.todayIso, thresholds: opts.thresholds, channel: 'chat', caller: null });
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
        s.session = newSession(s.id, s.session.startedAtMs, WEB_CHAT, delegate);
        log(`chat ${s.id}: signed in (${delegate.kind}, level ${delegate.level})`);
        s.frames.write('log', { signedIn: delegate.level, kind: delegate.kind });
      }
      const signedIn: ServerMessage[] = delegate === null ? [] : [{ type: 'signed_in', level: delegate.level }];
      // The client asks for a language; the core matches it to one of the app's (core/locale.ts matchLocale),
      // and ready names the one the session speaks.
      await turn(s, startEvent({ channel: 'chat' }, m.locale), (x) => [...ready(x), ...signedIn]);
      if (refused !== null) sendTo(s, refused);
      if (subject !== null && !s.ended) await signInTurn(s, subject);
    });
  };

  const ready = (e: ChatEntry): ServerMessage[] => [{ type: 'ready', session: e.id, resume: e.resume, locale: localeOf(e.session) }];

  const start = (conn: ChatConnection, m: Extract<ClientMessage, { type: 'start' }>): void => {
    if (m.resume !== undefined) {
      const id = resumeIds.get(m.resume);
      const e = id === undefined ? undefined : sessions.get(id);
      if (e !== undefined && !e.ended) {
        // A fresh token each time one is used: a token seen once (a log, a shoulder) opens nothing later.
        resumeIds.delete(e.resume);
        e.resume = fresh();
        resumeIds.set(e.resume, e.id);
        const previous = e.socket;
        if (previous !== null && previous !== conn.ws) previous.close(1000, 'resumed elsewhere');
        e.socket = conn.ws;
        e.lastActivityMs = now();
        conn.id = e.id;
        e.frames.write('in', loggedIn(m));
        // After whatever is still queued, so a reply in flight is not overtaken; nothing is resent.
        void enqueue(e, async (s) => {
          for (const r of ready(s)) sendTo(s, r);
        });
        const token = m.token;
        if (token !== undefined) void enqueue(e, (s) => laterSignIn(s, token));
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
      entry?.frames.write('in', { refused: parsed.code });
      send(conn.ws, entry?.frames ?? null, { type: 'error', code: parsed.code, message: parsed.message });
      if (conn.malformed >= CHAT_MALFORMED_LIMIT) {
        if (conn.malformed === CHAT_MALFORMED_LIMIT) log(`chat ${conn.id ?? 'unstarted'}: closing after ${conn.malformed} malformed messages`);
        entry?.frames.write('log', { malformedLimit: conn.malformed });
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
      if (conn.id !== null) {
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
      entry.frames.write('in', { refused: 'busy' });
      send(conn.ws, entry.frames, { type: 'error', code: 'busy', message: 'wait for the reply to what was sent' });
      return;
    }
    if (m.type === 'text') {
      // A one-time code typed at the code prompt is masked before the frame log sees it, as a spoken one is (adapter.ts maskCodeFrame).
      const masked = entry.session.promptedFor === 'otp' ? maskSpokenCode(m.text, spokenCodeMinDigits(codeLengthOf(appOf(entry.session)))).text : m.text;
      entry.frames.write('in', loggedIn(m, masked));
      void enqueue(entry, (s) => turn(s, textEvent(m.text)));
      return;
    }
    // sign_in: in the session's queue, so it is taken in order with what was typed around it.
    entry.frames.write('in', loggedIn(m));
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
      }
    });
    ws.on('close', () => {
      if (conn.startTimer !== null) clearTimeout(conn.startTimer);
      const e = conn.id === null ? undefined : sessions.get(conn.id);
      // A drop is not the end: the session waits for a resume until it is idle too long.
      if (e !== undefined && e.socket === ws) {
        e.socket = null;
        // An event handler must never throw (a full disk, a removed trace directory): it would take the server down.
        try {
          e.frames.write('log', { socketClosed: true });
        } catch (err) {
          log(`chat ${e.id}: close handler failed: ${describeError(err)}`);
        }
      }
    });
    ws.on('error', (err) => log(`chat ${conn.id ?? 'unstarted'}: socket error ${err.message}`));
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
          const entry = deps.audit.append(e.id, 'chat', { type: 'call_ended', detail: { reason: 'abandoned' } });
          e.auditEntries.push(entry);
          deps.bus?.publish({ type: 'ended', callSid: e.id, at: now(), reason: 'hangup' });
          sendTo(e, { type: 'end' });
        } catch (err) {
          log(`chat ${e.id}: idle end failed: ${describeError(err)}`);
        }
        // Forgotten whatever failed above: an idle session is never kept for want of a log line.
        finish(e, 'idle');
      }
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
  };
}

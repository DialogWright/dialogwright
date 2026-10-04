import { CHAT_PROTOCOL_VERSION, type ChatErrorCode, type ClientMessage, type ServerMessage } from './protocol';

/**
 * The widget without a page: the chat client. It opens the socket, starts the chat (or resumes it
 * after a drop), sends what the person types and the site's sign-in token, and reports what the
 * server says through `onEvent`. The panel (ui.ts) is a view over it; a site that wants its own
 * interface uses the client alone.
 *
 * - A drop is not the end: the client reconnects after `backoffMs` and resumes the same chat with the
 *   latest resume token the server gave it (each resume gives a new one), up to `maxReconnects` tries
 *   in a row. What is typed meanwhile is sent once the chat is back.
 * - If the chat it resumes has ended (`session_unknown`), the server starts a new one: the client says
 *   `restarted` before that chat's `ready`. A chat that was signed in resumes with the site's token
 *   beside its resume token, so the new chat starts signed in as the old one was (a delegate too, who
 *   can sign in only as a chat starts); what was typed meanwhile waits for that sign-in.
 * - If no chat can be had at all (the server is full, refuses the page's origin, or cannot be
 *   reached), the client tries again after each step of `backoffMs` and then stops, saying
 *   `unavailable`.
 * - A transfer is followed by the end: the client reports both, and does not reconnect.
 */

/**
 * Where the connection is. `open`: the chat is ready for text. `reconnecting`: it dropped and the
 * client is bringing it back. `closed`: the chat ended, the page closed it, or the server will not take
 * it back. `unavailable`: no chat could be had (the server is full, refused the connection or could
 * not be reached, after every step of `backoffMs`; or `maxReconnects` ran out), and the client has
 * stopped trying.
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unavailable';

export type ChatClientEvent =
  | { type: 'ready'; session: string; locale: string }
  /** The chat a resume named had ended: a new one follows, its `ready` next. */
  | { type: 'restarted' }
  | { type: 'say'; text: string; lang: string }
  | { type: 'transfer'; reason: string }
  | { type: 'end' }
  | { type: 'signed_in'; level: number }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'connection'; state: ConnectionState };

export interface ChatClientOptions {
  /** The chat endpoint, `wss://host/chat`. */
  endpoint: string;
  /** The language to ask for (a BCP 47 tag); the server matches it to one of the app's, and `ready` names that one. */
  locale?: string;
  /**
   * The site's sign-in token (from its identity provider), or null for none. Asked for when a chat
   * starts, whenever the site calls `signIn()`, and on each reconnect of a chat that is signed in (a
   * resume keeps the sign-in it had; the token is for the new chat that starts if it has ended).
   */
  getToken?: () => Promise<string | null>;
  onEvent: (e: ChatClientEvent) => void;
  /**
   * Delays before each reconnect, in ms (non-negative numbers). After a chat drops, the last repeats;
   * when no chat could be had yet, or the server is full, the client stops after it. Default
   * [500, 1000, 2000, 5000].
   */
  backoffMs?: readonly number[];
  /**
   * Reconnects in a row a chat that dropped may try before the client stops, saying `unavailable`
   * (a whole number, or Infinity). Default Infinity: a chat keeps coming back, every last step of
   * `backoffMs`, for as long as the page is open.
   */
  maxReconnects?: number;
  /** Opens a socket; for tests and non-browser use. Default: the page's WebSocket. */
  socket?: (url: string) => WebSocket;
}

export interface ChatClient {
  /** The first chat's session and language; rejected if the client stops before it has one. */
  readonly ready: Promise<{ session: string; locale: string }>;
  /** Send a line the person typed: at once, or once the chat is back if it is reconnecting. Dropped once the chat has ended. */
  send(text: string): Promise<void>;
  /** Ask the site for a token (`getToken`) and sign in with it. */
  signIn(): Promise<void>;
  /** End the connection; the client does not reconnect. */
  close(): void;
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000];
export const DEFAULT_MAX_RECONNECTS = Infinity;
/** Closed by the server for malformed messages: trying again would only be refused again. */
const CLOSE_MALFORMED = 1007;
/** The reason the server gives when a resume on another connection took the chat over. */
const RESUMED_ELSEWHERE = 'resumed elsewhere';

const OPEN = 1;

/** The options a client cannot work with, said at once rather than found out on the first drop. */
function checkOptions(o: ChatClientOptions): void {
  if (o.backoffMs !== undefined && (!Array.isArray(o.backoffMs) || !o.backoffMs.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0))) {
    throw new Error('DialogWright chat: backoffMs must be a list of delays in ms, like [500, 1000, 2000, 5000]');
  }
  const m = o.maxReconnects;
  if (m !== undefined && !(m === Infinity || (Number.isInteger(m) && m >= 0))) {
    throw new Error('DialogWright chat: maxReconnects must be a whole number of tries, or Infinity');
  }
}

export function createChatClient(o: ChatClientOptions): ChatClient {
  checkOptions(o);
  const open = o.socket ?? ((url: string) => new WebSocket(url));
  const backoff = o.backoffMs !== undefined && o.backoffMs.length > 0 ? o.backoffMs : DEFAULT_BACKOFF_MS;
  const maxReconnects = o.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  let ws: WebSocket | null = null;
  /** The token the latest `ready` gave, to resume with. */
  let resume: string | null = null;
  /** Connections in a row that ended without a ready: since the chat was last ready, or since the first try. */
  let failures = 0;
  /** The page closed the client, or the chat is over: nothing reconnects. */
  let stopped = false;
  /** This socket's chat is ready for text. */
  let live = false;
  /** The chat is signed in: a reconnect brings the site's token, for the new chat if this one has ended. */
  let signedIn = false;
  /** A chat that started with a token: what is typed waits until the server has taken or refused it. */
  let held = false;
  /** Lines typed while the chat was not ready (or its sign-in not settled), sent once it is. */
  const outbox: ClientMessage[] = [];

  let resolveReady!: (v: { session: string; locale: string }) => void;
  let rejectReady!: (e: Error) => void;
  let isReady = false;
  const ready = new Promise<{ session: string; locale: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A page that never awaits `ready` is not told of a rejection it did not ask about.
  ready.catch(() => {});

  const emit = (e: ChatClientEvent): void => {
    try {
      o.onEvent(e);
    } catch {
      // The page's handler failing must not break the chat.
    }
  };

  const sendRaw = (m: ClientMessage): void => {
    if (ws !== null && ws.readyState === OPEN) ws.send(JSON.stringify(m));
  };

  const token = async (): Promise<string | null> => {
    if (!o.getToken) return null;
    try {
      return await o.getToken();
    } catch {
      emit({ type: 'error', code: 'sign_in_failed', message: 'the site could not give a sign-in token' });
      return null;
    }
  };

  const stop = (state: 'closed' | 'unavailable', why?: string): void => {
    if (stopped) return;
    stopped = true;
    live = false;
    outbox.length = 0;
    if (!isReady) rejectReady(new Error(why ?? (state === 'unavailable' ? 'the chat is unavailable: the server refused it or could not be reached' : 'the chat closed before it started')));
    emit({ type: 'connection', state });
  };

  /** What was typed while the chat could not take it, sent now that it can. */
  const flush = (): void => {
    held = false;
    for (const queued of outbox.splice(0)) sendRaw(queued);
  };

  const connect = async (): Promise<void> => {
    // A new chat starts with the site's token. A resume keeps the sign-in it had, but brings the token
    // too when the chat was signed in: the server uses it only if the chat has ended and it starts a
    // new one, which then begins signed in (a delegate can sign in only as a chat starts).
    const t = resume === null || signedIn ? await token() : null;
    if (stopped) return;
    let socket: WebSocket;
    try {
      socket = open(o.endpoint);
    } catch (err) {
      // An endpoint the page cannot open at all (not a ws: or wss: URL): trying again cannot help.
      stop('unavailable', `the chat endpoint cannot be opened: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    ws = socket;
    let resuming = resume !== null;
    let refusedBusy = false;

    socket.onopen = () => {
      const start: ClientMessage = { type: 'start', v: CHAT_PROTOCOL_VERSION };
      if (o.locale) start.locale = o.locale;
      if (t) start.token = t;
      if (resume !== null) start.resume = resume;
      sendRaw(start);
    };

    socket.onmessage = (ev: MessageEvent) => {
      // A socket the client has replaced or closed speaks for the chat no more.
      if (stopped || ws !== socket) return;
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (m.type) {
        case 'ready': {
          // A new chat (the first, or one in place of a chat that ended), not the same one resumed.
          const fresh = !resuming;
          resume = m.resume;
          resuming = false;
          failures = 0;
          live = true;
          if (fresh) signedIn = false;
          if (!isReady) {
            isReady = true;
            resolveReady({ session: m.session, locale: m.locale });
          }
          emit({ type: 'ready', session: m.session, locale: m.locale });
          emit({ type: 'connection', state: 'open' });
          // A new chat that started with a token: what was typed waits for the sign-in, so it is read
          // as the signed-in person's (signed_in, or a refusal, settles it).
          if (fresh && t) held = true;
          else flush();
          break;
        }
        case 'error':
          if (m.code === 'session_unknown' && resuming) {
            // The server starts a new chat on this socket; its ready follows.
            resuming = false;
            emit({ type: 'restarted' });
            break;
          }
          if (m.code === 'busy' && !live) refusedBusy = true;
          emit({ type: 'error', code: m.code, message: m.message });
          // The start's token refused (or sign-in is off): the chat goes on as it is, with what was typed.
          if (held && (m.code === 'sign_in_failed' || m.code === 'not_allowed')) flush();
          break;
        case 'end':
          emit({ type: 'end' });
          stop('closed');
          break;
        case 'pong':
          break;
        case 'say':
          emit({ type: 'say', text: m.text, lang: m.lang });
          break;
        case 'transfer':
          emit({ type: 'transfer', reason: m.reason });
          break;
        case 'signed_in':
          signedIn = true;
          emit({ type: 'signed_in', level: m.level });
          if (held) flush();
          break;
      }
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket) return;
      ws = null;
      live = false;
      held = false;
      if (stopped) return;
      if (ev.code === CLOSE_MALFORMED || ev.reason === RESUMED_ELSEWHERE) {
        stop('closed');
        return;
      }
      failures += 1;
      // No chat yet (a wrong endpoint, a refused origin, a server down), or a full server: each step of
      // backoffMs once, then stop. A chat that dropped: up to maxReconnects, the last step repeating.
      const limit = !isReady || refusedBusy ? backoff.length : maxReconnects;
      if (failures > limit) {
        stop('unavailable');
        return;
      }
      const delay = backoff[Math.min(failures - 1, backoff.length - 1)]!;
      emit({ type: 'connection', state: 'reconnecting' });
      setTimeout(() => {
        if (!stopped) void connect();
      }, delay);
    };
  };

  const signIn = async (): Promise<void> => {
    const t = await token();
    if (t && !stopped) {
      if (live && !held) sendRaw({ type: 'sign_in', token: t });
      else outbox.push({ type: 'sign_in', token: t });
    }
  };

  emit({ type: 'connection', state: 'connecting' });
  void connect();

  return {
    ready,
    async send(text) {
      if (stopped) return;
      const m: ClientMessage = { type: 'text', text };
      if (live && !held) sendRaw(m);
      else outbox.push(m);
    },
    signIn,
    close() {
      const socket = ws;
      stop('closed');
      socket?.close(1000, 'closed by the page');
    },
  };
}

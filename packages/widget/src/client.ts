import { CHAT_PROTOCOL_VERSION, type ChatErrorCode, type ClientMessage, type ServerMessage } from './protocol';

/**
 * The widget without a page: the chat client. It opens the socket, starts the chat (or resumes it
 * after a drop), sends what the person types and the site's sign-in token, and reports what the
 * server says through `onEvent`. The panel (ui.ts) is a view over it; a site that wants its own
 * interface uses the client alone.
 *
 * - A drop is not the end: the client reconnects after `backoffMs` and resumes the same chat with the
 *   latest resume token the server gave it (each resume gives a new one). What is typed meanwhile is
 *   sent once the chat is back.
 * - If the chat it resumes has ended (`session_unknown`), the server starts a new one: the client says
 *   `restarted` before that chat's `ready`, and asks the site for a sign-in token again.
 * - If the server is full (`busy` on a start), the client tries again after each step of `backoffMs`
 *   and then stops, saying `unavailable`.
 * - A transfer is followed by the end: the client reports both, and does not reconnect.
 */

/**
 * Where the connection is. `open`: the chat is ready for text. `reconnecting`: it dropped and the
 * client is bringing it back. `closed`: the chat ended, the page closed it, or the server will not take
 * it back. `unavailable`: the server is full, and the client has stopped trying.
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
   * starts (a resume keeps the sign-in it had) and whenever the site calls `signIn()`.
   */
  getToken?: () => Promise<string | null>;
  onEvent: (e: ChatClientEvent) => void;
  /** Delays before each reconnect, in ms; after a drop the last repeats, and when the server is full the client stops after it. Default [500, 1000, 2000, 5000]. */
  backoffMs?: readonly number[];
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
/** Closed by the server for malformed messages: trying again would only be refused again. */
const CLOSE_MALFORMED = 1007;
/** The reason the server gives when a resume on another connection took the chat over. */
const RESUMED_ELSEWHERE = 'resumed elsewhere';

const OPEN = 1;

export function createChatClient(o: ChatClientOptions): ChatClient {
  const open = o.socket ?? ((url: string) => new WebSocket(url));
  const backoff = o.backoffMs !== undefined && o.backoffMs.length > 0 ? o.backoffMs : DEFAULT_BACKOFF_MS;
  let ws: WebSocket | null = null;
  /** The token the latest `ready` gave, to resume with. */
  let resume: string | null = null;
  /** Reconnects since the chat was last ready. */
  let attempt = 0;
  /** Starts the server refused as full since the chat was last ready. */
  let busyTries = 0;
  /** The page closed the client, or the chat is over: nothing reconnects. */
  let stopped = false;
  /** This socket's chat is ready for text. */
  let live = false;
  /** Lines typed while the chat was not ready, sent once it is. */
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

  const stop = (state: 'closed' | 'unavailable'): void => {
    if (stopped) return;
    stopped = true;
    live = false;
    outbox.length = 0;
    if (!isReady) rejectReady(new Error(state === 'unavailable' ? 'the chat is unavailable: the server is full' : 'the chat closed before it started'));
    emit({ type: 'connection', state });
  };

  const connect = async (): Promise<void> => {
    // A resume keeps the sign-in the chat had: a token goes on a new chat's start only.
    const t = resume === null ? await token() : null;
    if (stopped) return;
    const socket = open(o.endpoint);
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
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (m.type) {
        case 'ready': {
          const restarted = !resuming && resume !== null;
          resume = m.resume;
          resuming = false;
          attempt = 0;
          busyTries = 0;
          live = true;
          if (!isReady) {
            isReady = true;
            resolveReady({ session: m.session, locale: m.locale });
          }
          emit({ type: 'ready', session: m.session, locale: m.locale });
          emit({ type: 'connection', state: 'open' });
          for (const queued of outbox.splice(0)) sendRaw(queued);
          // A new chat in place of the one that ended: signed in again, as the first was.
          if (restarted) void signIn();
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
          emit({ type: 'signed_in', level: m.level });
          break;
      }
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket) return;
      ws = null;
      live = false;
      if (stopped) return;
      if (ev.code === CLOSE_MALFORMED || ev.reason === RESUMED_ELSEWHERE) {
        stop('closed');
        return;
      }
      let delay: number;
      if (refusedBusy) {
        busyTries += 1;
        if (busyTries > backoff.length) {
          stop('unavailable');
          return;
        }
        delay = backoff[busyTries - 1]!;
      } else {
        delay = backoff[Math.min(attempt, backoff.length - 1)]!;
        attempt += 1;
      }
      emit({ type: 'connection', state: 'reconnecting' });
      setTimeout(() => {
        if (!stopped) void connect();
      }, delay);
    };
  };

  const signIn = async (): Promise<void> => {
    const t = await token();
    if (t && !stopped) {
      if (live) sendRaw({ type: 'sign_in', token: t });
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
      if (live) sendRaw(m);
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

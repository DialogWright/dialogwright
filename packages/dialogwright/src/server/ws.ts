import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import type { SocketLike } from './sessions';
import { LEGACY_PROVIDER, providerIdForPath } from './voice/registry';
import { within } from './stores/sql';

/** A connection that has not identified itself with a setup message by now is not ConversationRelay. */
export const SETUP_TIMEOUT_MS = 10_000;

/** Tokens are minted as 16 random bytes in hex; anything else never had a chance of verifying. */
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

function wrap(ws: WebSocket): SocketLike {
  return {
    send: (data, cb) => ws.send(data, cb),
    close: (code, reason) => ws.close(code, reason),
  };
}

/**
 * The voice provider a socket path names: `/conversation/<id>` for an enabled provider, or the legacy
 * provider (Twilio) for the unprefixed `/conversation` when it is enabled; null for anything else.
 */
export function socketProvider(pathname: string, enabled: readonly string[]): string | null {
  return providerIdForPath(enabled, pathname, '/conversation');
}

/** The web chat endpoint's side of an upgrade (server/chat/socket.ts ChatEndpoint), when CHAT=on. */
export interface ChatUpgrades {
  /** The path the chat is served on (`/chat`). */
  readonly path: string;
  /** Whether a path is the chat's, where it answers more than one (a host's /chat/<app id>); absent, `path` alone. */
  owns?(path: string): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Accept relay upgrades on `/conversation/<id>` for each enabled voice provider (`voiceProviders`,
 * default Twilio alone) and on the legacy `/conversation` (Twilio's); the token from the query is checked at setup.
 * While `restarting` says so (the server is closing with its sessions saved: a planned restart's
 * handover, index.ts drain, or a close), every upgrade, a call's and a chat's, is turned away with 503,
 * so the carrier's socket and the chat's resume reach the restarted server rather than this one.
 */
export function attachWebSocketServer(
  server: Server,
  deps: AdapterDeps,
  setupTimeoutMs: number = SETUP_TIMEOUT_MS,
  voiceProviders: readonly string[] = [LEGACY_PROVIDER],
  chat: ChatUpgrades | null = null,
  restarting: () => boolean = () => false,
): WebSocketServer {
  // 64 KiB is far above any ConversationRelay message; larger payloads are closed with 1009 by ws.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const onConnection = (ws: WebSocket, token: string, provider: string): void => {
    const sock = wrap(ws);
    const ctx = newConnectionContext(token, sock, provider);
    // Twilio sends setup immediately; a socket that never does is holding a session slot for nothing.
    const deadline = setTimeout(() => {
      deps.log('connection closed: no setup within the deadline');
      ws.close(1008, 'setup timeout');
    }, setupTimeoutMs);
    deadline.unref();
    // A setup whose token is checked in a shared store says so when it passes (below covers the others).
    ctx.identified = () => clearTimeout(deadline);
    // RELAY_PING_MS: a socket that has not answered the last ping by the next is closed, as one the carrier
    // abandoned without closing it would otherwise be held open, and its call with it. Off by default.
    let answered = true;
    const pinger = deps.pingMs !== undefined && deps.pingMs > 0
      ? setInterval(() => {
        if (!answered) {
          deps.log(`${ctx.callSid ?? 'unknown'}: relay socket closed: no answer to a ping in ${deps.pingMs} ms`);
          ws.terminate();
          return;
        }
        answered = false;
        ws.ping();
      }, deps.pingMs)
      : null;
    pinger?.unref();
    if (pinger) ws.on('pong', () => (answered = true));
    ws.on('message', (data) => {
      const handled = handleSocketMessage(deps, sock, ctx, data.toString());
      // handleSocketMessage assigns ctx.callSid synchronously, before its first await, once a setup
      // passes the token check. Disarming here rather than on the promise means a first turn slower
      // than the deadline cannot kill a call that has already authenticated.
      if (ctx.callSid) clearTimeout(deadline);
      void handled.catch((err: unknown) =>
        deps.log(`${ctx.callSid ?? 'unknown'}: message handler failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (pinger) clearInterval(pinger);
      void handleSocketClose(deps, ctx).catch((err: unknown) =>
        deps.log(`${ctx.callSid ?? 'unknown'}: close handler failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    ws.on('error', (err) => deps.log(`${ctx.callSid ?? 'unknown'}: socket error ${err.message}`));
  };

  server.on('upgrade', (req, socket, head) => {
    if (restarting()) {
      deps.log('upgrade refused: the server is restarting');
      socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The web chat, when it is on: checked for its origin there, and never for a call token.
    if (chat !== null && (chat.owns ? chat.owns(url.pathname) : url.pathname === chat.path)) {
      chat.handleUpgrade(req, socket, head);
      return;
    }
    const provider = socketProvider(url.pathname, voiceProviders);
    if (provider === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    // A malformed token can never verify, so refuse before spending a socket on it.
    if (!token || !TOKEN_SHAPE.test(token)) {
      deps.log('upgrade refused: missing or malformed token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // A well-shaped token that was never minted, has expired, or was minted for another carrier's
    // call cannot pass the `setup` check either, so it gets no socket. The binding to a particular
    // call SID is still checked there.
    const upgrade = (live: boolean | 'unknown'): void => {
      if (live === 'unknown') {
        // The store could not say: the carrier calls back, and its callback puts the caller through.
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!live) {
        deps.log('upgrade refused: unknown or expired token');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, token, provider));
    };
    const live = deps.tokens.has(token, provider);
    // A store across the network answers with a promise (SESSION_STORE=postgres); the others at once, as always.
    if (typeof live === 'boolean') upgrade(live);
    else {
      within(live, deps.store.timeoutMs).then(upgrade, (err: unknown) => {
        deps.log(`upgrade refused: the token could not be checked: ${err instanceof Error ? err.message : String(err)}`);
        upgrade('unknown');
      });
    }
  });

  return wss;
}

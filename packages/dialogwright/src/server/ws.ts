import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import type { SocketLike } from './sessions';
import { LEGACY_PROVIDER, providerIdForPath } from './voice/registry';

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
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Accept relay upgrades on `/conversation/<id>` for each enabled voice provider (`voiceProviders`,
 * default Twilio alone) and on the legacy `/conversation` (Twilio's); the token from the query is checked at setup.
 */
export function attachWebSocketServer(
  server: Server,
  deps: AdapterDeps,
  setupTimeoutMs: number = SETUP_TIMEOUT_MS,
  voiceProviders: readonly string[] = [LEGACY_PROVIDER],
  chat: ChatUpgrades | null = null,
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
      void handleSocketClose(deps, ctx).catch((err: unknown) =>
        deps.log(`${ctx.callSid ?? 'unknown'}: close handler failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    ws.on('error', (err) => deps.log(`${ctx.callSid ?? 'unknown'}: socket error ${err.message}`));
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The web chat, when it is on: checked for its origin there, and never for a call token.
    if (chat !== null && url.pathname === chat.path) {
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
    // A well-shaped token that was never minted (or has expired) cannot pass the `setup` check
    // either, so it gets no socket. The binding to a particular call SID is still checked there.
    if (!deps.tokens.has(token)) {
      deps.log('upgrade refused: unknown or expired token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, token, provider));
  });

  return wss;
}

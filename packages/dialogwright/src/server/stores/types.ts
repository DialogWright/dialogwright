import { createHash } from 'node:crypto';
import type { Session } from '../../core/session';
import type { AuditEntry } from '../../audit/types';
import type { Effect } from '../../core/lifecycle';
import type { ScrubPart } from '../../core/recording';

/**
 * What the server keeps of a call or a chat between turns, behind interfaces, so where it lives is a
 * setting (SESSION_STORE) and not the server's business: in this process's memory (the default, as it
 * always was), in files on this machine (`file:<dir>`, which outlives a restart), or, later, in a store
 * many servers share. Each implementation passes one contract suite (dialogwright/testing
 * runStoreContract).
 *
 * What is stored is plain data: a session (core/session.ts, a plain serializable value) and the
 * counters the server keeps beside it. What is live (a socket, a call's turn queue, its timers) stays
 * on the server that holds the socket (server/sessions.ts SessionStore), which saves to the store after
 * every turn and loads from it when a call it does not hold calls back.
 *
 * A method may answer at once or with a promise (Awaitable): the memory and file stores answer at
 * once, a store across the network will not, and the server awaits either.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * A request a turn handed to one of the app's downstream services (App.services), recorded with its
 * idempotency key before it is sent (core/idempotency.ts serviceIdempotencyKey), so a call resumed
 * after a restart that finds it unanswered sends it again with the same key, and the service can tell
 * it is the same request.
 */
export interface PendingEffect {
  readonly effect: Effect;
  readonly idempotencyKey: string;
  /** The effect's scrub as data (core/recording.ts scrubParts), so its answer is recorded masked; absent when nothing of it is masked. */
  readonly scrub?: readonly ScrubPart[];
}

/** A call's server-side state, as stored: the session and the counters the server keeps beside it. */
export interface StoredCall {
  readonly callId: string;
  /** The carrier the call came in on (server/voice/registry.ts): only that carrier's callback resumes it. */
  readonly provider: string;
  /** SESSION_SCHEMA (core/session.ts) when it was saved: a call saved under another is not resumed. */
  readonly schema: number;
  readonly session: Session;
  readonly reconnects: number;
  readonly createdAtMs: number;
  readonly lastActivityMs: number;
  /** The call's audit entries, as chained: what the handoff summary reads (server/sessions.ts CallEntry.auditEntries). */
  readonly auditTail: readonly AuditEntry[];
  /** The service request the call is waiting on, when it waits on one (the session's pendingService). */
  readonly pending?: PendingEffect;
}

/** A web chat's server-side state, as stored (server/chat/socket.ts). */
export interface StoredChat {
  readonly id: string;
  readonly schema: number;
  readonly session: Session;
  /** sha256 of the resume token `ready` last gave the client (tokenHash): never the token itself. */
  readonly resumeHash: string;
  readonly createdAtMs: number;
  readonly lastActivityMs: number;
  readonly auditTail: readonly AuditEntry[];
}

/** Where calls are kept between turns. */
export interface CallStateStore {
  /** The call as last saved, or null: never saved, removed, or unreadable (logged by the store). */
  load(callId: string): Awaitable<StoredCall | null>;
  /** Saved after every turn; the last save wins. A file store writes it whole or not at all. */
  save(call: StoredCall): Awaitable<void>;
  /** Forget the call (it ended, or it is past its time). Removing a call never saved is not an error. */
  remove(callId: string): Awaitable<void>;
  /** The ids of every call saved and not removed, for the sweep. */
  list(): Awaitable<readonly string[]>;
}

/** Where web chats are kept between turns. */
export interface ChatStateStore {
  load(id: string): Awaitable<StoredChat | null>;
  /** The chat whose resume token hashes to `resumeHash`, or null. */
  findByResume(resumeHash: string): Awaitable<StoredChat | null>;
  save(chat: StoredChat): Awaitable<void>;
  remove(id: string): Awaitable<void>;
  list(): Awaitable<readonly string[]>;
}

/**
 * One-time relay tokens: one live token per call, tied to the carrier whose webhook minted it, for the
 * time the store was made with (server/tokens.ts CallTokens is the memory one).
 */
export interface TokenStore {
  /** A fresh token for a call on `provider` (default Twilio), replacing the call's last one. */
  mint(callId: string, provider?: string): Awaitable<string>;
  /** Whether `token` is the live token of `callId`, minted for `provider`. */
  verify(token: string, callId: string, provider: string): Awaitable<boolean>;
  /** Whether `token` is live for some call on `provider`. */
  has(token: string, provider: string): Awaitable<boolean>;
  revoke(callId: string): Awaitable<void>;
  /** Forget every expired token; how many there were. */
  evictExpired(): Awaitable<number>;
}

/** A token's SHA-256, in hex: what a store keeps of a token, so the store holds nothing that opens a socket. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

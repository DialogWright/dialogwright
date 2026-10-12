import { createHash } from 'node:crypto';
import type { Session } from '../../core/session';
import type { AuditEntry } from '../../audit/types';
import type { Effect } from '../../core/lifecycle';
import type { ScrubPart } from '../../core/recording';

/**
 * What the server keeps of a call or a chat between turns, behind interfaces, so where it lives is a
 * setting (SESSION_STORE) and not the server's business: in this process's memory (the default, as it
 * always was), in files on this machine (`file:<dir>`, which outlives a restart), or in Postgres
 * (`postgres://...`, stores/postgres.ts), which many servers share. Each implementation passes one
 * contract suite (dialogwright/testing runStoreContract).
 *
 * What is stored is plain data: a session (core/session.ts, a plain serializable value) and the
 * counters the server keeps beside it. What is live (a socket, a call's turn queue, its timers) stays
 * on the server that holds the socket (server/sessions.ts SessionStore), which saves to the store after
 * every turn and loads from it when a call it does not hold calls back.
 *
 * A method may answer at once or with a promise (Awaitable): the memory and file stores answer at
 * once, a store across the network will not, and the server awaits either (a token store's mint and
 * revoke excepted: ServerTokenStore).
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

/**
 * A TokenStore the server can run on: one whose `mint` and `revoke` answer at once, since the carrier's
 * callback decides in one synchronous step (server/http.ts decideAction). A store across the network
 * writes behind those answers and says, through `settled`, when the writes have landed, so another
 * server can read them: the callback awaits it before it hands the carrier a token. `verify` and `has`
 * may answer with a promise. The memory and file stores write at once and have no `settled`.
 */
export interface ServerTokenStore extends TokenStore {
  mint(callId: string, provider?: string): string;
  revoke(callId: string): void;
  /**
   * The writes behind a call's mints and revokes so far, landed, rejecting when its last one failed;
   * with no call, every write so far, failed or not.
   */
  settled?(callId?: string): Promise<void>;
}

/**
 * One owner per call at a time (design §8, Phase 8b decision 2): a lease per call id, held by the server
 * that runs the call's turns, for a stretch of time it renews while the call is live. Only a store many
 * servers share needs one to mean anything; the memory and file stores implement it in the process
 * (one machine is the only owner there is), so the contract holds every store to the same rules, and
 * the server reads a lease only from a shared store (SessionStoreOptions.lease).
 *
 * Every time is the store's clock (the `now` it was made with): servers that share a store keep their
 * clocks within a second of each other, as `pnpm diagnose` checks.
 */
export interface CallLeases {
  /**
   * Take the call's lease for `owner` until now plus `ttlMs`, and read the call as saved, in one step
   * no other server's claim can come between: taken when no one holds it, its holder's lease has
   * lapsed, it was released, or `owner` holds it already (which renews it). Not taken, it says who
   * holds it and until when. A call never saved is taken with `call` null (a new call).
   */
  claim(callId: string, owner: string, ttlMs: number): Awaitable<LeaseClaim>;
  /** Extend every lease `owner` holds to now plus `ttlMs`; the ids of the calls it holds. */
  renew(owner: string, ttlMs: number): Awaitable<readonly string[]>;
  /** Give the call's lease up, when `owner` holds it; anything else is no error. */
  release(callId: string, owner: string): Awaitable<void>;
  /** Who holds the call's lease and until when, lapsed or not; null when no one does. */
  holder(callId: string): Awaitable<LeaseHolder | null>;
  /**
   * Save the call only while `owner` holds its lease, lapsed or not, and renew the lease: false, saving
   * nothing, when another owner holds it or there is none (the call was taken over, or ended and
   * removed). Its reconnect count never goes down (one counted elsewhere is kept).
   */
  saveAs(call: StoredCall, owner: string, ttlMs: number): Awaitable<boolean>;
  /**
   * Count one reconnect of the call, at once and for all servers, while its count is under `limit`:
   * the count before, and whether it was counted. Null when the call is not saved.
   */
  countReconnect(callId: string, limit: number): Awaitable<{ before: number; counted: boolean } | null>;
  /** Remove the call (and its lease) unless someone holds a lease on it that has not lapsed: whether it was removed. */
  removeUnleased(callId: string): Awaitable<boolean>;
}

/** A call's lease: who holds it, and until when (the store's clock, in ms). */
export interface LeaseHolder {
  readonly owner: string;
  readonly expiresAtMs: number;
}

/** What `claim` found: the lease taken, with the call as saved (null for a call never saved), or held by another. */
export type LeaseClaim =
  | { readonly taken: true; readonly call: StoredCall | null }
  | ({ readonly taken: false } & LeaseHolder);

/** A token's SHA-256, in hex: what a store keeps of a token, so the store holds nothing that opens a socket. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

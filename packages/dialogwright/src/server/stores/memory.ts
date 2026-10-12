import { InProcessLeases } from './leases';
import type { CallLeases, CallStateStore, ChatStateStore, LeaseClaim, LeaseHolder, ReleaseKind, StoredCall, StoredChat } from './types';

/**
 * The memory stores: what a process keeps in itself, gone when it stops. The tokens are today's class
 * (server/tokens.ts CallTokens), here under the store's name too.
 *
 * The server does not save to the memory call and chat stores: with SESSION_STORE=memory (the
 * default) the call it holds (server/sessions.ts SessionStore) is the only copy, as it always was, so
 * nothing about a call or a chat changes. These two are the reference the contract suite holds every
 * other store to, and what a test that wants a store with no disk uses.
 */
export { CallTokens as MemoryTokenStore } from '../tokens';

/** A copy, as a store across a wire would hand back: the caller's later changes never reach the store. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The memory call store, with its leases in the process (stores/leases.ts), read by the contract only. */
export class MemoryCallStateStore implements CallStateStore, CallLeases {
  private readonly calls = new Map<string, string>();
  private readonly leases: InProcessLeases;

  /** `now` is the leases' clock. */
  constructor(now: () => number = Date.now) {
    this.leases = new InProcessLeases({ load: (id) => this.load(id), save: (c) => this.save(c), removeRecord: (id) => this.calls.delete(id) }, now);
  }

  load(callId: string): StoredCall | null {
    const raw = this.calls.get(callId);
    return raw === undefined ? null : (JSON.parse(raw) as StoredCall);
  }

  save(call: StoredCall): void {
    this.calls.set(call.callId, JSON.stringify(call));
  }

  remove(callId: string): void {
    this.calls.delete(callId);
    this.leases.forget(callId);
  }

  list(): string[] {
    return [...this.calls.keys()];
  }

  claim(callId: string, owner: string, ttlMs: number): LeaseClaim {
    return this.leases.claim(callId, owner, ttlMs);
  }

  renew(owner: string, ttlMs: number): string[] {
    return this.leases.renew(owner, ttlMs);
  }

  release(callId: string, owner: string, how?: ReleaseKind): void {
    this.leases.release(callId, owner, how);
  }

  holder(callId: string): LeaseHolder | null {
    return this.leases.holder(callId);
  }

  saveAs(call: StoredCall, owner: string, ttlMs: number): boolean {
    return this.leases.saveAs(call, owner, ttlMs);
  }

  countReconnect(callId: string, limit: number): { before: number; counted: boolean } | null {
    return this.leases.countReconnect(callId, limit);
  }

  removeAs(callId: string, owner: string): boolean {
    return this.leases.removeAs(callId, owner);
  }

  removeUnleased(callId: string): boolean {
    return this.leases.removeUnleased(callId);
  }

  takeHeld(callId: string): string | null {
    return this.leases.takeHeld(callId);
  }
}

export class MemoryChatStateStore implements ChatStateStore {
  private readonly chats = new Map<string, StoredChat>();

  load(id: string): StoredChat | null {
    const chat = this.chats.get(id);
    return chat === undefined ? null : copy(chat);
  }

  findByResume(resumeHash: string): StoredChat | null {
    for (const chat of this.chats.values()) if (chat.resumeHash === resumeHash) return copy(chat);
    return null;
  }

  save(chat: StoredChat): void {
    this.chats.set(chat.id, copy(chat));
  }

  remove(id: string): void {
    this.chats.delete(id);
  }

  list(): string[] {
    return [...this.chats.keys()];
  }
}

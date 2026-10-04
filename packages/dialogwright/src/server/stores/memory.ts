import type { CallStateStore, ChatStateStore, StoredCall, StoredChat } from './types';

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

export class MemoryCallStateStore implements CallStateStore {
  private readonly calls = new Map<string, string>();

  load(callId: string): StoredCall | null {
    const raw = this.calls.get(callId);
    return raw === undefined ? null : (JSON.parse(raw) as StoredCall);
  }

  save(call: StoredCall): void {
    this.calls.set(call.callId, JSON.stringify(call));
  }

  remove(callId: string): void {
    this.calls.delete(callId);
  }

  list(): string[] {
    return [...this.calls.keys()];
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

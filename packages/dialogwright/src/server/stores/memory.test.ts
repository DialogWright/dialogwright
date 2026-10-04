import { describe, expect, it } from 'vitest';
import { runStoreContract, storeContractChecks } from '../../testing/storeContract';
import type { StoredCall } from './types';
import { runStoreContract as fromEntry } from '../../testing/index';
import { CallTokens } from '../tokens';
import { MemoryCallStateStore, MemoryChatStateStore, MemoryTokenStore } from './memory';

runStoreContract('memory', (ctx) => ({
  calls: new MemoryCallStateStore(),
  chats: new MemoryChatStateStore(),
  tokens: new MemoryTokenStore(ctx.tokenTtlMs, ctx.now),
}), { describe, it });

describe('the memory stores', () => {
  it('are today\'s classes: the memory token store is CallTokens, under its old name too', () => {
    expect(MemoryTokenStore).toBe(CallTokens);
  });

  it('runs the contract from dialogwright/testing', () => {
    expect(fromEntry).toBe(runStoreContract);
  });

  it('fails a store that breaks the contract, naming the check', async () => {
    /** Hands back the very object it was given, and forgets the last save in favour of the first. */
    class Careless extends MemoryCallStateStore {
      private readonly kept = new Map<string, StoredCall>();
      override save(call: StoredCall): void {
        if (!this.kept.has(call.callId)) this.kept.set(call.callId, call);
      }
      override load(callId: string): StoredCall | null {
        return this.kept.get(callId) ?? null;
      }
      override remove(callId: string): void {
        this.kept.delete(callId);
      }
      override list(): string[] {
        return [...this.kept.keys()];
      }
    }
    const checks = storeContractChecks((ctx) => ({ calls: new Careless(), chats: new MemoryChatStateStore(), tokens: new MemoryTokenStore(ctx.tokenTtlMs, ctx.now) }));
    const failed: string[] = [];
    for (const c of checks) await c.run().catch(() => failed.push(c.name));
    expect(failed).toEqual(['the last save of a call wins', 'a value handed back is a copy: changing it changes nothing stored']);
  });
});

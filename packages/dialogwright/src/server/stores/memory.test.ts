import { describe, expect, it } from 'vitest';
import { runStoreContract, storeContractChecks } from '../../testing/storeContract';
import type { LeaseClaim, StoredCall } from './types';
import { runStoreContract as fromEntry } from '../../testing/index';
import { CallTokens } from '../tokens';
import { MemoryCallStateStore, MemoryChatStateStore, MemoryTokenStore } from './memory';

runStoreContract('memory', (ctx) => {
  const calls = new MemoryCallStateStore(ctx.now);
  return { calls, leases: calls, chats: new MemoryChatStateStore(), tokens: new MemoryTokenStore(ctx.tokenTtlMs, ctx.now) };
}, { describe, it });

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
    expect(failed).toEqual([
      'the last save of a call wins',
      'a value handed back is a copy: changing it changes nothing stored',
      // Its loads are its own, but the transfer it takes is the store's underneath.
      'a transfer held with a call is taken once, with the call, and never from a call without one',
    ]);
  });

  it('fails leases that let a second owner in, naming each check that holds a lease to one owner', async () => {
    /** Takes every claim, held or not, and records none. */
    class Open extends MemoryCallStateStore {
      override claim(callId: string): LeaseClaim {
        return { taken: true, call: this.load(callId), took: 'new', silentMs: null };
      }
    }
    const checks = storeContractChecks((ctx) => {
      const calls = new Open(ctx.now);
      return { calls, leases: calls, chats: new MemoryChatStateStore(), tokens: new MemoryTokenStore(ctx.tokenTtlMs, ctx.now) };
    });
    const failed: string[] = [];
    for (const c of checks) await c.run().catch(() => failed.push(c.name));
    expect(failed).toEqual([
      'lease: one owner at a time; its holder takes it again, which renews it',
      'lease: a lapsed lease is taken over, and a released one at once',
      'lease: one given up as its socket closed is taken as a clean hand-off; given up, it is neither renewed nor saved under',
      'lease: a reconnect counted since its holder took it lets another take it at once, and only that once',
      "lease: a claim says how long since the call's last reconnect was counted, the silence its caller is in",
      'lease: a call is removed under its lease only by its holder',
      'lease: renewing keeps a lease, and names the calls its owner holds',
      // A claim that records no lease leaves none to save under or to keep a call from removal.
      'lease: a save under a lease is kept only from its holder, and never lowers the reconnect count',
      'lease: a call removed takes its lease with it, and one with a live lease is not removed unleased',
      'lease: of many claims at once, exactly one takes the lease',
    ]);
  });
});

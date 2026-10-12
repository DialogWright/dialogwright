import type { Session } from '../core/session';
import type { AuditEntry } from '../audit/types';
import {
  tokenHash, type Awaitable, type CallLeases, type CallStateStore, type ChatStateStore, type StoredCall, type StoredChat, type TokenStore,
} from '../server/stores/types';

/**
 * What every session store must do (server/stores/types.ts): the memory stores, the file stores, and
 * any store an app or a later phase writes (one many servers share) pass the same checks. The runner's
 * `describe` and `it` are passed in, so importing the kit loads no test runner:
 *
 *   import { describe, it } from 'vitest';
 *   import { runStoreContract } from 'dialogwright/testing';
 *   runStoreContract('my store', (ctx) => myStores(ctx), { describe, it, reopen: (ctx) => myStores(ctx) });
 *
 * `make` is called afresh for each check, with a clock the check moves and the token lifetime the
 * stores are to be made with. `reopen`, for a store that outlives its process, makes new stores over
 * the same storage as the last `make`: what was saved must be there, and a token minted must still verify.
 *
 * A store that gives `leases` (one owner per call at a time: every built-in store does, and a store many
 * servers share must) is held to them too, by the checks named `lease: ...`; for a store that gives
 * none, those checks have nothing to hold and pass.
 */

/** The stores a check runs against. `close` is called after each check, when given. */
export interface ContractStores {
  readonly calls: CallStateStore;
  readonly chats: ChatStateStore;
  readonly tokens: TokenStore;
  /** The calls' leases, over the same storage as `calls` (often the same object). */
  readonly leases?: CallLeases;
  close?(): Awaitable<void>;
}

/** What a check gives `make`: the clock the stores read, and how long a token is to live. */
export interface ContractContext {
  now(): number;
  readonly tokenTtlMs: number;
}

export interface StoreContractOptions {
  describe(name: string, fn: () => void): unknown;
  it(name: string, fn: () => unknown): unknown;
  /** New stores over the storage the last `make` used, for a store that outlives its process. */
  reopen?(ctx: ContractContext): Awaitable<ContractStores>;
}

/** The token lifetime every check makes its stores with. */
export const CONTRACT_TOKEN_TTL_MS = 600_000;

/** The lease lifetime the lease checks take and renew with. */
export const CONTRACT_LEASE_TTL_MS = 30_000;

function fail(message: string): never {
  throw new Error(message);
}

/** Equal as JSON is: what a store must hand back is what JSON.parse(JSON.stringify(value)) would. */
function sameJson(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(JSON.parse(JSON.stringify(want)));
  if (a !== b) fail(`${what}: got ${a}, expected ${b}`);
}

/**
 * A session as the store sees it: an opaque plain value. Built by hand rather than with newSession,
 * so the kit needs no app registered; it carries what a real one may (nested records, nulls, numbers,
 * words in other scripts, a value that looks like a path).
 */
export function contractSession(id: string, turnIndex = 3): Session {
  return {
    sessionId: id, appId: 'contract', turnIndex, startedAtMs: 1_700_000_000_000, form: 'request',
    slots: { note: { value: 'left at the back door, ../../etc', display: 'left at the back door', confirmed: false, attempts: 1, window: null, helped: ['help_note'] } },
    intentAttempts: 0, promptedFor: 'note', lastPromptId: 'ask_note', lastPromptText: '¿Algo más? 日本語 "quoted"', lastPromptOptions: [],
    menuActive: false, pendingConfirmation: null, queued: [], completed: ['first'], history: [{ node: 'n', intent: 'i', outcome: 'o' }],
    channel: 'voice', caps: { keypad: true }, principal: { kind: 'anonymous', level: 0 }, facts: { count: 2, nested: { list: [1, null, 'x'] } },
    stepUp: null, entered: 'request', identityAttempts: { factors: 0, code: 0 }, codeSent: false, codeReasks: 0, pendingHash: null,
    confirmedHash: null, pendingService: null, screenHits: 0, dtmfBuffer: '', lastInterrupt: null, consecutiveFailures: 0,
    frustratedTurns: 0, transferDeclined: false, ended: false,
  } as unknown as Session;
}

function auditEntry(callId: string, seq: number): AuditEntry {
  return { type: 'gate', detail: { verdict: 'ALLOW', rules: ['scope'] }, seq, at: '2026-09-18T12:00:00.000Z', callId, channel: 'voice', prevHash: '0'.repeat(64), hash: 'a'.repeat(64) };
}

export function contractCall(callId: string, turnIndex = 3, extra: Partial<StoredCall> = {}): StoredCall {
  return {
    callId, provider: 'twilio', schema: 1, session: contractSession(callId, turnIndex), reconnects: 1,
    createdAtMs: 1_700_000_000_000, lastActivityMs: 1_700_000_060_000, auditTail: [auditEntry(callId, 1), auditEntry(callId, 2)], ...extra,
  };
}

export function contractChat(id: string, resume: string, turnIndex = 2): StoredChat {
  return {
    id, schema: 1, session: { ...contractSession(id, turnIndex), channel: 'chat' }, resumeHash: tokenHash(resume),
    createdAtMs: 1_700_000_000_000, lastActivityMs: 1_700_000_030_000, auditTail: [auditEntry(id, 1)],
  };
}

interface Clock {
  now(): number;
  advance(ms: number): void;
}

function clock(): Clock {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** One check of the contract: its name, and what it runs against stores made by `make` (and `reopen`). */
export interface StoreContractCheck {
  readonly name: string;
  run(): Promise<void>;
}

type Body = (s: ContractStores, c: Clock, reopen: ((ctx: ContractContext) => Awaitable<ContractStores>) | undefined) => Promise<void>;

const CHECKS: readonly { name: string; durable?: true; body: Body }[] = [
  {
    name: 'a call saved loads as it was saved (equal after a JSON round trip)',
    async body(s) {
      const call = contractCall('CA0001');
      await s.calls.save(call);
      sameJson(await s.calls.load('CA0001'), call, 'loaded call');
    },
  },
  {
    name: 'a call never saved loads as null, and removing it is no error',
    async body(s) {
      if ((await s.calls.load('CA-none')) !== null) fail('an unknown call loaded as something');
      await s.calls.remove('CA-none');
    },
  },
  {
    name: 'a call removed loads as null and is not listed',
    async body(s) {
      await s.calls.save(contractCall('CA0001'));
      await s.calls.save(contractCall('CA0002'));
      await s.calls.remove('CA0001');
      if ((await s.calls.load('CA0001')) !== null) fail('a removed call still loads');
      sameJson([...(await s.calls.list())].sort(), ['CA0002'], 'listed calls');
    },
  },
  {
    name: 'the last save of a call wins',
    async body(s) {
      await s.calls.save(contractCall('CA0001', 3));
      await s.calls.save(contractCall('CA0001', 4, { reconnects: 2 }));
      const got = await s.calls.load('CA0001');
      if (got?.session.turnIndex !== 4 || got.reconnects !== 2) fail(`the earlier save won: ${JSON.stringify(got)}`);
    },
  },
  {
    name: 'a value handed back is a copy: changing it changes nothing stored',
    async body(s) {
      const call = contractCall('CA0001');
      await s.calls.save(call);
      const got = await s.calls.load('CA0001');
      (got!.session as { turnIndex: number }).turnIndex = 99;
      (call.session as { turnIndex: number }).turnIndex = 98;
      if ((await s.calls.load('CA0001'))?.session.turnIndex !== 3) fail('a change to a value handed in or out reached the store');
    },
  },
  {
    name: 'concurrent saves of different calls do not interfere',
    async body(s) {
      const ids = Array.from({ length: 20 }, (_, i) => `CA${String(i).padStart(4, '0')}`);
      await Promise.all(ids.map((id, i) => s.calls.save(contractCall(id, i))));
      for (const [i, id] of ids.entries()) {
        const got = await s.calls.load(id);
        if (got?.callId !== id || got.session.turnIndex !== i) fail(`${id} loaded as ${JSON.stringify(got?.callId)} turn ${got?.session.turnIndex}`);
      }
      sameJson([...(await s.calls.list())].sort(), ids, 'listed calls');
    },
  },
  {
    name: 'call ids that differ only in characters a file name cannot hold stay apart',
    async body(s) {
      const ids = ['v2:telnyx-call', 'v2_telnyx-call', 'v2/telnyx-call', '../escape', 'x'.repeat(200), `${'x'.repeat(199)}y`];
      for (const [i, id] of ids.entries()) await s.calls.save(contractCall(id, i));
      for (const [i, id] of ids.entries()) {
        const got = await s.calls.load(id);
        if (got?.callId !== id || got.session.turnIndex !== i) fail(`${JSON.stringify(id)} loaded as ${JSON.stringify(got?.callId)}`);
      }
      sameJson([...(await s.calls.list())].sort(), [...ids].sort(), 'listed calls');
    },
  },
  {
    name: 'a chat saved loads by its id and by its resume token, and a rotated token finds nothing',
    async body(s) {
      const chat = contractChat('chat-1', 'r'.repeat(32));
      await s.chats.save(chat);
      sameJson(await s.chats.load('chat-1'), chat, 'loaded chat');
      sameJson(await s.chats.findByResume(tokenHash('r'.repeat(32))), chat, 'chat found by its resume token');
      if ((await s.chats.findByResume(tokenHash('s'.repeat(32)))) !== null) fail('a resume token never given found a chat');
      await s.chats.save({ ...chat, resumeHash: tokenHash('t'.repeat(32)) });
      if ((await s.chats.findByResume(tokenHash('r'.repeat(32)))) !== null) fail('a resume token rotated away still finds the chat');
      if ((await s.chats.findByResume(tokenHash('t'.repeat(32))))?.id !== 'chat-1') fail('the new resume token does not find the chat');
    },
  },
  {
    name: 'a chat removed is gone, by id, by resume token and from the list',
    async body(s) {
      await s.chats.save(contractChat('chat-1', 'r'.repeat(32)));
      await s.chats.save(contractChat('chat-2', 's'.repeat(32)));
      await s.chats.remove('chat-1');
      await s.chats.remove('chat-none');
      if ((await s.chats.load('chat-1')) !== null) fail('a removed chat still loads');
      if ((await s.chats.findByResume(tokenHash('r'.repeat(32)))) !== null) fail('a removed chat is found by its resume token');
      sameJson([...(await s.chats.list())], ['chat-2'], 'listed chats');
    },
  },
  {
    name: 'a token verifies for its own call and carrier only',
    async body(s) {
      const token = await s.tokens.mint('CA0001', 'twilio');
      if (!/^[0-9a-f]{32}$/.test(token)) fail(`a token is 32 hex characters, got ${JSON.stringify(token)}`);
      if (!(await s.tokens.verify(token, 'CA0001', 'twilio'))) fail('a token does not verify for its own call');
      if (await s.tokens.verify(token, 'CA0002', 'twilio')) fail("a token verifies for another call");
      if (await s.tokens.verify(token, 'CA0001', 'telnyx')) fail("a token verifies for another carrier");
      if (!(await s.tokens.has(token, 'twilio'))) fail('has: a live token is not live');
      if (await s.tokens.has(token, 'telnyx')) fail("has: a token is live on another carrier's path");
      if (await s.tokens.has('f'.repeat(32), 'twilio')) fail('has: a token never minted is live');
    },
  },
  {
    name: "a call's new token replaces its last one",
    async body(s) {
      const first = await s.tokens.mint('CA0001', 'twilio');
      const second = await s.tokens.mint('CA0001', 'twilio');
      if (first === second) fail('two mints gave the same token');
      if (await s.tokens.verify(first, 'CA0001', 'twilio')) fail('the replaced token still verifies');
      if (await s.tokens.has(first, 'twilio')) fail('the replaced token is still live');
      if (!(await s.tokens.verify(second, 'CA0001', 'twilio'))) fail('the new token does not verify');
    },
  },
  {
    name: 'a token expires, and the sweep counts it',
    async body(s, c) {
      const token = await s.tokens.mint('CA0001', 'twilio');
      await s.tokens.mint('CA0002', 'twilio');
      c.advance(CONTRACT_TOKEN_TTL_MS + 1);
      const late = await s.tokens.mint('CA0003', 'twilio');
      if (await s.tokens.verify(token, 'CA0001', 'twilio')) fail('an expired token verifies');
      if (await s.tokens.has(token, 'twilio')) fail('an expired token is live');
      const swept = await s.tokens.evictExpired();
      if (swept !== 1) fail(`the sweep counted ${swept} expired tokens, expected 1 (one was already forgotten by verify)`);
      if (!(await s.tokens.verify(late, 'CA0003', 'twilio'))) fail('the sweep took a token still live');
    },
  },
  {
    name: 'a token revoked neither verifies nor is live',
    async body(s) {
      const token = await s.tokens.mint('CA0001', 'twilio');
      await s.tokens.revoke('CA0001');
      await s.tokens.revoke('CA-none');
      if (await s.tokens.verify(token, 'CA0001', 'twilio')) fail('a revoked token verifies');
      if (await s.tokens.has(token, 'twilio')) fail('a revoked token is live');
    },
  },
  {
    name: 'lease: one owner at a time; its holder takes it again, which renews it',
    async body(s, c) {
      const l = s.leases;
      if (l === undefined) return;
      await s.calls.save(contractCall('CA0001'));
      const a = await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS);
      if (!a.taken) fail(`a free lease was not taken: ${JSON.stringify(a)}`);
      const b = await l.claim('CA0001', 'server-b', CONTRACT_LEASE_TTL_MS);
      if (b.taken) fail('a second owner took a lease that is held');
      if (b.owner !== 'server-a' || b.expiresAtMs !== c.now() + CONTRACT_LEASE_TTL_MS) fail(`a lease held says ${JSON.stringify(b)}`);
      c.advance(CONTRACT_LEASE_TTL_MS / 2);
      if (!(await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS)).taken) fail('the holder could not take its own lease again');
      sameJson(await l.holder('CA0001'), { owner: 'server-a', expiresAtMs: c.now() + CONTRACT_LEASE_TTL_MS }, 'the lease after its holder took it again');
      if ((await l.claim('CA0002', 'server-b', CONTRACT_LEASE_TTL_MS)).taken !== true) fail("one call's lease kept another call's from being taken");
    },
  },
  {
    name: 'lease: a lapsed lease is taken over, and a released one at once',
    async body(s, c) {
      const l = s.leases;
      if (l === undefined) return;
      await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS);
      c.advance(CONTRACT_LEASE_TTL_MS - 1);
      if ((await l.claim('CA0001', 'server-b', CONTRACT_LEASE_TTL_MS)).taken) fail('a lease was taken over before it lapsed');
      c.advance(1);
      if (!(await l.claim('CA0001', 'server-b', CONTRACT_LEASE_TTL_MS)).taken) fail('a lapsed lease was not taken over');
      if ((await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS)).taken) fail('the old holder took back a lease another had taken over');
      await l.release('CA0001', 'server-a');
      if ((await l.holder('CA0001'))?.owner !== 'server-b') fail("a release by one who does not hold the lease gave it up");
      await l.release('CA0001', 'server-b');
      await l.release('CA-none', 'server-b');
      if ((await l.holder('CA0001')) !== null) fail('a released lease is still held');
      if (!(await l.claim('CA0001', 'server-c', CONTRACT_LEASE_TTL_MS)).taken) fail('a released lease was not taken at once');
    },
  },
  {
    name: 'lease: renewing keeps a lease, and names the calls its owner holds',
    async body(s, c) {
      const l = s.leases;
      if (l === undefined) return;
      await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS);
      await l.claim('CA0002', 'server-a', CONTRACT_LEASE_TTL_MS);
      await l.claim('CA0003', 'server-b', CONTRACT_LEASE_TTL_MS);
      c.advance(CONTRACT_LEASE_TTL_MS * 0.6);
      sameJson([...(await l.renew('server-a', CONTRACT_LEASE_TTL_MS))].sort(), ['CA0001', 'CA0002'], 'the calls a renewal names');
      c.advance(CONTRACT_LEASE_TTL_MS * 0.6);
      if ((await l.claim('CA0001', 'server-b', CONTRACT_LEASE_TTL_MS)).taken) fail('a renewed lease was taken over');
      if (!(await l.claim('CA0003', 'server-a', CONTRACT_LEASE_TTL_MS)).taken) fail("a renewal by one owner kept another's lease");
      sameJson([...(await l.renew('server-c', CONTRACT_LEASE_TTL_MS))], [], 'the calls an owner with none renews');
    },
  },
  {
    name: 'lease: taking a lease reads the call as saved; a call never saved is taken with none',
    async body(s) {
      const l = s.leases;
      if (l === undefined) return;
      const call = contractCall('v2:telnyx-call');
      await s.calls.save(call);
      const got = await l.claim('v2:telnyx-call', 'server-a', CONTRACT_LEASE_TTL_MS);
      if (!got.taken) fail('a free lease was not taken');
      sameJson(got.call, call, 'the call read with its lease');
      const none = await l.claim('CA-new', 'server-a', CONTRACT_LEASE_TTL_MS);
      if (!none.taken || none.call !== null) fail(`a call never saved was taken as ${JSON.stringify(none)}`);
    },
  },
  {
    name: 'lease: a save under a lease is kept only from its holder, and never lowers the reconnect count',
    async body(s) {
      const l = s.leases;
      if (l === undefined) return;
      if (await l.saveAs(contractCall('CA0001', 3), 'server-a', CONTRACT_LEASE_TTL_MS)) fail('a save with no lease was kept');
      if ((await s.calls.load('CA0001')) !== null) fail('a save refused was written');
      await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS);
      if (!(await l.saveAs(contractCall('CA0001', 4, { reconnects: 2 }), 'server-a', CONTRACT_LEASE_TTL_MS))) fail("the holder's save was refused");
      if (await l.saveAs(contractCall('CA0001', 9), 'server-b', CONTRACT_LEASE_TTL_MS)) fail("another owner's save was kept");
      const got = await s.calls.load('CA0001');
      if (got?.session.turnIndex !== 4) fail(`a save from one who does not hold the lease won: ${JSON.stringify(got?.session.turnIndex)}`);
      await l.saveAs(contractCall('CA0001', 5, { reconnects: 1 }), 'server-a', CONTRACT_LEASE_TTL_MS);
      const after = await s.calls.load('CA0001');
      if (after?.session.turnIndex !== 5 || after.reconnects !== 2) fail(`a save under a lease lowered the reconnect count or was lost: ${JSON.stringify({ turn: after?.session.turnIndex, reconnects: after?.reconnects })}`);
      sameJson(after, contractCall('CA0001', 5, { reconnects: 2 }), 'the call saved under its lease');
    },
  },
  {
    name: 'lease: reconnects are counted under the limit, each once, however many count at once',
    async body(s) {
      const l = s.leases;
      if (l === undefined) return;
      if ((await l.countReconnect('CA-none', 2)) !== null) fail('a reconnect was counted for a call never saved');
      await s.calls.save(contractCall('CA0001', 3, { reconnects: 0 }));
      const counts = await Promise.all(Array.from({ length: 5 }, () => l.countReconnect('CA0001', 3)));
      const counted = counts.filter((n) => n?.counted === true).map((n) => n!.before).sort();
      sameJson(counted, [0, 1, 2], 'the counts before each reconnect counted');
      if (counts.some((n) => n?.counted === false && n.before !== 3)) fail(`a reconnect over the limit says ${JSON.stringify(counts)}`);
      if ((await s.calls.load('CA0001'))?.reconnects !== 3) fail('the reconnect count saved is not the number counted');
    },
  },
  {
    name: 'lease: a call removed takes its lease with it, and one with a live lease is not removed unleased',
    async body(s, c) {
      const l = s.leases;
      if (l === undefined) return;
      await s.calls.save(contractCall('CA0001'));
      await l.claim('CA0001', 'server-a', CONTRACT_LEASE_TTL_MS);
      if (await l.removeUnleased('CA0001')) fail('a call with a live lease was removed unleased');
      if ((await s.calls.load('CA0001')) === null) fail('a call with a live lease is gone');
      c.advance(CONTRACT_LEASE_TTL_MS);
      if (!(await l.removeUnleased('CA0001'))) fail('a call whose lease lapsed was not removed');
      if ((await s.calls.load('CA0001')) !== null || (await l.holder('CA0001')) !== null) fail('a call removed unleased, or its lease, is still there');
      if (await l.removeUnleased('CA0001')) fail('a call removed twice was removed twice');
      await s.calls.save(contractCall('CA0002'));
      await l.claim('CA0002', 'server-a', CONTRACT_LEASE_TTL_MS);
      await s.calls.remove('CA0002');
      if ((await l.holder('CA0002')) !== null) fail("a call removed left its lease");
      if (!(await l.claim('CA0002', 'server-b', CONTRACT_LEASE_TTL_MS)).taken) fail("a removed call's lease was not free");
    },
  },
  {
    name: 'lease: of many claims at once, exactly one takes the lease',
    async body(s) {
      const l = s.leases;
      if (l === undefined) return;
      await s.calls.save(contractCall('CA0001'));
      const owners = Array.from({ length: 8 }, (_, i) => `server-${i}`);
      const claims = await Promise.all(owners.map((o) => l.claim('CA0001', o, CONTRACT_LEASE_TTL_MS)));
      const winners = owners.filter((_, i) => claims[i]!.taken);
      if (winners.length !== 1) fail(`${winners.length} owners took one lease: ${winners.join(', ')}`);
      if ((await l.holder('CA0001'))?.owner !== winners[0]) fail('the lease is not held by the one claim that took it');
      for (const cl of claims) if (!cl.taken && cl.owner !== winners[0]) fail(`a claim that lost names ${cl.owner}, not ${winners[0]}`);
    },
  },
  {
    name: 'what was saved, and a token minted, are there after the store is opened again',
    durable: true,
    async body(s, c, reopen) {
      const call = contractCall('v2:telnyx-call');
      const chat = contractChat('chat-1', 'r'.repeat(32));
      await s.calls.save(call);
      await s.calls.save(contractCall('CA-gone'));
      await s.calls.remove('CA-gone');
      await s.chats.save(chat);
      const token = await s.tokens.mint('v2:telnyx-call', 'telnyx');
      const revoked = await s.tokens.mint('CA-gone', 'twilio');
      await s.tokens.revoke('CA-gone');
      await s.close?.();
      const again = await reopen!({ now: c.now, tokenTtlMs: CONTRACT_TOKEN_TTL_MS });
      try {
        sameJson(await again.calls.load('v2:telnyx-call'), call, 'the call after reopening');
        sameJson([...(await again.calls.list())], ['v2:telnyx-call'], 'the calls listed after reopening');
        sameJson(await again.chats.findByResume(tokenHash('r'.repeat(32))), chat, 'the chat after reopening');
        if (!(await again.tokens.verify(token, 'v2:telnyx-call', 'telnyx'))) fail('a token minted before reopening does not verify');
        if (!(await again.tokens.has(token, 'telnyx'))) fail('a token minted before reopening is not live');
        if (await again.tokens.has(revoked, 'twilio')) fail('a token revoked before reopening is live');
        c.advance(CONTRACT_TOKEN_TTL_MS + 1);
        if (await again.tokens.verify(token, 'v2:telnyx-call', 'telnyx')) fail('a token kept across reopening never expires');
      } finally {
        await again.close?.();
      }
    },
  },
];

/** Each check of the contract, by name, so a runner other than runStoreContract can call them. */
export function storeContractChecks(
  make: (ctx: ContractContext) => Awaitable<ContractStores>,
  reopen?: (ctx: ContractContext) => Awaitable<ContractStores>,
): StoreContractCheck[] {
  return CHECKS.filter((c) => c.durable !== true || reopen !== undefined).map((c) => ({
    name: c.name,
    async run() {
      const t = clock();
      const stores = await make({ now: t.now, tokenTtlMs: CONTRACT_TOKEN_TTL_MS });
      let closed = false;
      const wrapped: ContractStores = { ...stores, close: async () => { closed = true; await stores.close?.(); } };
      try {
        await c.body(wrapped, t, reopen);
      } finally {
        if (!closed) await stores.close?.();
      }
    },
  }));
}

/** Registers the contract's checks as tests, one per check, under `store contract: <name>`. */
export function runStoreContract(name: string, make: (ctx: ContractContext) => Awaitable<ContractStores>, options: StoreContractOptions): void {
  const { describe, it, reopen } = options;
  describe(`store contract: ${name}`, () => {
    for (const check of storeContractChecks(make, reopen)) it(check.name, () => check.run());
  });
}

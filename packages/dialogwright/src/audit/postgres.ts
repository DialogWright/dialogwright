import { createHash } from 'node:crypto';
import { canonicalJson } from '../jev/cassette';
import { entryHash, GENESIS } from './log';
import type { AuditDraft, AuditEntry } from './types';
import type { AuditSink } from '../run/turn';
import { boundedSql, DEFAULT_SQL_TIMEOUT_MS, type SqlClient, type SqlQueryable } from '../server/stores/sql';
import { ensureTables, type TablePart } from '../server/stores/postgres';

/**
 * The audit in Postgres (AUDIT_STORE=postgres://...), for several servers that append to one audit: a
 * day file shared by two servers would fork its chain, so here each call has a hash chain of its own,
 * and each time a call's chain grows its newest hash is anchored into a chain for the day. An entry is
 * the same shape as a day file's line, built from the same drafts and redaction (core/audit.ts), and
 * its hash is the same function of it (log.ts entryHash); `seq` is its place in its call's chain.
 *
 *   dw_audit_entries   one row per entry: its chain (the call's id), its seq in the chain, its UTC day,
 *                      and the entry as JSON (a day file's line)
 *   dw_audit_anchors   one row per anchor: its day, its seq in the day's chain, and the anchor as JSON:
 *                      { day, seq, at, callId, callSeq, callHash, prevHash, hash }
 *
 * A call's entries are chained in one transaction under a lock on the call (an advisory lock, so two
 * servers appending to one call at once, a turn that outlived its server's hold on the call and the
 * new holder's, say, are put one after the other and never fork it), and the anchor in the same
 * transaction under a lock on the day. So every entry a server wrote is in its call's chain, in the
 * order the database took them, and a call's newest entry is always anchored. What a chain cannot
 * show by itself, as a day file cannot, is its own last entries cut off together with their anchors.
 *
 * The console's own access entries (call id `console`, as in a day file) are chained per day
 * (`console@<day>`), so the access log is not one chain without end, and a day of it can be retained.
 */

/** The audit tables' version: their own row in dw_schema, beside the session tables'. */
export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_TABLES: TablePart = {
  row: 'audit',
  version: AUDIT_SCHEMA_VERSION,
  what: 'audit tables',
  setting: 'AUDIT_STORE',
  tables: [
    `CREATE TABLE IF NOT EXISTS dw_audit_entries (
      chain text NOT NULL,
      seq integer NOT NULL,
      day text NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (chain, seq)
    )`,
    'CREATE INDEX IF NOT EXISTS dw_audit_entries_day ON dw_audit_entries (day)',
    `CREATE TABLE IF NOT EXISTS dw_audit_anchors (
      day text NOT NULL,
      seq integer NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (day, seq)
    )`,
  ],
};

/** The advisory locks' first keys: a call's chain, and a day's. */
const CALL_LOCK = 0x6461; // "da"
const DAY_LOCK = 0x6464; // "dd"

/** The call id the console's access entries go under (server/console/auth.ts). */
const CONSOLE = 'console';

/** The chain an entry of `callId` on `day` goes to: the call's, or the console's for the day. */
export function chainOf(callId: string, day: string): string {
  return callId === CONSOLE ? `${CONSOLE}@${day}` : callId;
}

/** An anchor: a call's chain's newest hash, in the day's chain. */
export interface AuditAnchor {
  day: string;
  seq: number;
  at: string;
  callId: string;
  callSeq: number;
  callHash: string;
  prevHash: string;
  hash: string;
}

export function anchorHash(a: Omit<AuditAnchor, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(a), 'utf8').digest('hex');
}

type Num = number | string;

/** The audit as AUDIT_STORE=postgres keeps it: an AuditSink whose entries are chained once the database has them. */
export class PostgresAuditLog implements AuditSink {
  /** Each chain's appends from this server, in the order they were asked for. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly sql: SqlClient, private readonly now: () => number = Date.now) {}

  append(callId: string, channel: string, d: AuditDraft): Promise<AuditEntry> {
    return this.appendAll(callId, channel, [d]).then((e) => e[0]!);
  }

  appendAll(callId: string, channel: string, ds: readonly AuditDraft[]): Promise<AuditEntry[]> {
    if (ds.length === 0) return Promise.resolve([]);
    // In order per chain from this server; across servers, the database's lock orders them.
    const before = this.queues.get(callId) ?? Promise.resolve();
    const run = before.then(() => this.chain(callId, channel, ds), () => this.chain(callId, channel, ds));
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(callId, tail);
    void tail.then(() => {
      if (this.queues.get(callId) === tail) this.queues.delete(callId);
    });
    return run;
  }

  private chain(callId: string, channel: string, ds: readonly AuditDraft[]): Promise<AuditEntry[]> {
    const atMs = this.now();
    const at = new Date(atMs).toISOString();
    const day = at.slice(0, 10);
    const chain = chainOf(callId, day);
    return this.sql.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [CALL_LOCK, chain]);
      const head = await tx.query<{ body: string }>('SELECT body FROM dw_audit_entries WHERE chain = $1 ORDER BY seq DESC LIMIT 1', [chain]);
      let seq = 0;
      let prev = GENESIS;
      if (head.rows.length > 0) {
        const last = JSON.parse(head.rows[0]!.body) as AuditEntry;
        seq = last.seq;
        prev = last.hash;
      }
      const entries: AuditEntry[] = [];
      for (const d of ds) {
        const base = { ...d, seq: seq + 1, at, callId, channel, prevHash: prev };
        const entry: AuditEntry = { ...base, hash: entryHash(base) };
        entries.push(entry);
        seq = entry.seq;
        prev = entry.hash;
      }
      const params: unknown[] = [];
      const rows = entries.map((e) => {
        params.push(chain, e.seq, day, JSON.stringify(e));
        const n = params.length;
        return `($${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await tx.query(`INSERT INTO dw_audit_entries (chain, seq, day, body) VALUES ${rows.join(', ')}`, params);
      // The chain's newest hash, anchored into the day's chain.
      await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [DAY_LOCK, day]);
      const dayHead = await tx.query<{ body: string }>('SELECT body FROM dw_audit_anchors WHERE day = $1 ORDER BY seq DESC LIMIT 1', [day]);
      const lastAnchor = dayHead.rows.length > 0 ? (JSON.parse(dayHead.rows[0]!.body) as AuditAnchor) : null;
      const newest = entries.at(-1)!;
      const anchorBase = { day, seq: (lastAnchor?.seq ?? 0) + 1, at, callId: chain, callSeq: newest.seq, callHash: newest.hash, prevHash: lastAnchor?.hash ?? GENESIS };
      const anchor: AuditAnchor = { ...anchorBase, hash: anchorHash(anchorBase) };
      await tx.query('INSERT INTO dw_audit_anchors (day, seq, body) VALUES ($1, $2, $3)', [day, anchor.seq, JSON.stringify(anchor)]);
      return entries;
    });
  }

  /** Every append asked for so far, done (or failed). */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /**
   * AUDIT_RETENTION_DAYS: the days older than `days` removed, never today's. A call's chain is removed
   * whole once its newest entry is older (never in part, so every chain that stays verifies from its
   * first entry), and a day's anchors with the day. Returns the days, chains and entries removed.
   */
  async sweep(days: number, nowMs: number): Promise<{ days: number; chains: number; entries: number }> {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
    return this.sql.transaction(async (tx) => {
      const gone = await tx.query<{ chain: string; n: Num }>('SELECT chain, count(*) AS n FROM dw_audit_entries GROUP BY chain HAVING max(day) < $1', [cutoff]);
      for (const g of gone.rows) await tx.query('DELETE FROM dw_audit_entries WHERE chain = $1', [g.chain]);
      const dayRows = await tx.query<{ day: string }>('SELECT DISTINCT day FROM dw_audit_anchors WHERE day < $1', [cutoff]);
      await tx.query('DELETE FROM dw_audit_anchors WHERE day < $1', [cutoff]);
      return { days: dayRows.rows.length, chains: gone.rows.length, entries: gone.rows.reduce((n, g) => n + Number(g.n), 0) };
    });
  }
}

/** The audit over `given`, once its tables are there at this code's version (made on first use). */
export async function openPostgresAudit(given: SqlClient, o: { now?: () => number; timeoutMs?: number; log?: (line: string) => void } = {}): Promise<PostgresAuditLog> {
  const sql = boundedSql(given, o.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS);
  if (await ensureTables(sql, AUDIT_TABLES)) o.log?.(`audit: made the audit tables in Postgres (version ${AUDIT_SCHEMA_VERSION})`);
  return new PostgresAuditLog(sql, o.now);
}

// ---------------------------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------------------------

export interface PostgresVerifyResult {
  chains: number;
  entries: number;
  days: { day: string; anchors: number }[];
  /** Every break found, the first of each chain: empty when the whole audit verifies. */
  breaks: string[];
}

/**
 * Re-walk every call's chain and every day's anchors (`pnpm audit:verify postgres://...`): each chain
 * from GENESIS with no gap, each entry's hash its own, each anchor's link and hash, each anchor naming
 * an entry that is there with that hash, and each chain's newest entry anchored. The first break of
 * each chain (and of each day) is reported.
 */
export async function verifyPostgresAudit(sql: SqlQueryable): Promise<PostgresVerifyResult> {
  const entries = await sql.query<{ chain: string; seq: Num; day: string; body: string }>('SELECT chain, seq, day, body FROM dw_audit_entries ORDER BY chain, seq');
  const anchors = await sql.query<{ day: string; seq: Num; body: string }>('SELECT day, seq, body FROM dw_audit_anchors ORDER BY day, seq');
  const breaks: string[] = [];
  /** Each chain's entries' hashes by seq, and its newest seq. */
  const hashes = new Map<string, Map<number, string>>();
  /** Each chain's newest entry's day: a chain whose day's anchors are broken is not also said to be unanchored. */
  const newestDay = new Map<string, string>();
  const broken = new Set<string>();
  let expected = 0;
  let prev = GENESIS;
  let current: string | null = null;
  for (const row of entries.rows) {
    const chain = row.chain;
    if (chain !== current) {
      current = chain;
      expected = 1;
      prev = GENESIS;
      hashes.set(chain, new Map());
    }
    if (broken.has(chain)) continue;
    const seq = Number(row.seq);
    const fail = (why: string): void => {
      breaks.push(`call ${chain}: BROKEN at entry ${seq} (${why})`);
      broken.add(chain);
    };
    let e: AuditEntry;
    try {
      e = JSON.parse(row.body) as AuditEntry;
    } catch {
      fail('not JSON');
      continue;
    }
    const { hash, ...rest } = e;
    if (seq !== expected || e.seq !== seq) fail(seq !== expected ? `entry ${expected} is missing` : 'its seq is not its place');
    else if (chainOf(e.callId, e.at.slice(0, 10)) !== chain) fail('it names another call');
    else if (e.prevHash !== prev) fail('broken link');
    else if (entryHash(rest) !== hash) fail('hash mismatch');
    if (broken.has(chain)) continue;
    hashes.get(chain)!.set(seq, hash);
    newestDay.set(chain, row.day);
    prev = hash;
    expected = seq + 1;
  }
  /** Each chain's newest seq that an anchor names. */
  const anchoredTo = new Map<string, number>();
  const days: PostgresVerifyResult['days'] = [];
  let day: string | null = null;
  let dayBroken = false;
  const brokenDays = new Set<string>();
  for (const row of anchors.rows) {
    if (row.day !== day) {
      day = row.day;
      expected = 1;
      prev = GENESIS;
      dayBroken = false;
      days.push({ day, anchors: 0 });
    }
    days.at(-1)!.anchors += 1;
    if (dayBroken) continue;
    const seq = Number(row.seq);
    const fail = (why: string): void => {
      breaks.push(`day ${day}: BROKEN at anchor ${seq} (${why})`);
      dayBroken = true;
      brokenDays.add(day!);
    };
    let a: AuditAnchor;
    try {
      a = JSON.parse(row.body) as AuditAnchor;
    } catch {
      fail('not JSON');
      continue;
    }
    const { hash, ...rest } = a;
    if (seq !== expected || a.seq !== seq || a.day !== day) fail(seq !== expected ? `anchor ${expected} is missing` : 'its seq or day is not its place');
    else if (a.prevHash !== prev) fail('broken link');
    else if (anchorHash(rest) !== hash) fail('hash mismatch');
    if (dayBroken) continue;
    // The day's chain holds; an anchor naming an entry that is not there (or not as it was) is a break of its call's.
    if (!broken.has(a.callId) && hashes.get(a.callId)?.get(a.callSeq) !== a.callHash) {
      breaks.push(`call ${a.callId}: BROKEN at entry ${a.callSeq} (anchored on ${day}, and not there as anchored)`);
      broken.add(a.callId);
    }
    anchoredTo.set(a.callId, Math.max(anchoredTo.get(a.callId) ?? 0, a.callSeq));
    prev = hash;
    expected = seq + 1;
  }
  for (const [chain, seqs] of hashes) {
    if (broken.has(chain) || brokenDays.has(newestDay.get(chain) ?? '')) continue;
    const newest = Math.max(0, ...seqs.keys());
    const anchored = anchoredTo.get(chain) ?? 0;
    if (anchored < newest) breaks.push(`call ${chain}: BROKEN after entry ${anchored} (${newest - anchored} newer ${newest - anchored === 1 ? 'entry is' : 'entries are'} anchored nowhere)`);
  }
  return { chains: hashes.size, entries: entries.rows.length, days, breaks };
}

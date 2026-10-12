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
 *   dw_audit_anchors   one row per anchor: its day, the server that wrote it, its seq in that server's
 *                      chain for the day, and the anchor as JSON:
 *                      { day, server, seq, at, callId, callSeq, callHash, prevHash, hash }
 *
 * A call's entries are chained in one transaction under a lock on the call (an advisory lock, so two
 * servers appending to one call at once, a turn that outlived its server's hold on the call and the
 * new holder's, say, are put one after the other and never fork it), and the anchor in the same
 * transaction into the writing server's own chain for the day, under a lock on that chain alone, so
 * servers never wait on each other for their anchors (every lock wait is bounded: lock_timeout). So
 * every entry a server wrote is in its call's chain, in the order the database took them, and a
 * call's newest entry is always anchored. What a chain cannot show by itself, as a day file cannot,
 * is its own last entries cut off together with their anchors.
 *
 * The console's own access entries (call id `console`, as in a day file) are chained per day
 * (`console@<day>`), so the access log is not one chain without end, and a day of it can be retained.
 */

/** The audit tables' version: their own row in dw_schema, beside the session tables'. */
/**
 * The audit tables' version. 2: the anchors kept per server and day, and the roster (version 1, one
 * chain of anchors per day, never shipped, and is refused rather than read).
 */
export const AUDIT_SCHEMA_VERSION = 2;

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
      server text NOT NULL,
      seq integer NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (day, server, seq)
    )`,
    `CREATE TABLE IF NOT EXISTS dw_audit_roster (
      day text NOT NULL,
      seq integer NOT NULL,
      body text NOT NULL,
      PRIMARY KEY (day, seq)
    )`,
  ],
};

/**
 * How often a server enters its chain's head for the day in the day's roster while it writes: the most
 * of a server's newest anchors a cut could take with no trace (beside its stop, when it enters it too).
 */
export const ROSTER_EVERY_MS = 10 * 60_000;

/** An entry of a day's roster: a server's chain of anchors for the day, as far as `anchorSeq`. */
export interface RosterEntry {
  day: string;
  seq: number;
  at: string;
  server: string;
  anchorSeq: number;
  anchorHash: string;
  prevHash: string;
  hash: string;
}

export function rosterHash(r: Omit<RosterEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(r), 'utf8').digest('hex');
}

/** The advisory locks' first keys: a call's chain, a server's chain for a day, and the one sweeper. */
const CALL_LOCK = 0x6461; // "da"
const DAY_LOCK = 0x6464; // "dd"
const SWEEP_LOCK = 0x6473; // "ds"
const ROSTER_LOCK = 0x6472; // "dr"

/** The call id the console's access entries go under (server/console/auth.ts). */
const CONSOLE = 'console';

/** The chain an entry of `callId` on `day` goes to: the call's, or the console's for the day. */
export function chainOf(callId: string, day: string): string {
  return callId === CONSOLE ? `${CONSOLE}@${day}` : callId;
}

/** An anchor: a call's chain's newest hash, in the day's chain. */
export interface AuditAnchor {
  day: string;
  /** The server whose chain for the day the anchor is in. */
  server: string;
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
  /** Each day this server has written anchors on: its newest anchor, and the last it entered in the roster (and when). */
  private readonly days = new Map<string, { anchorSeq: number; anchorHash: string; rosteredSeq: number; rosteredAtMs: number }>();

  constructor(
    private readonly sql: SqlClient,
    private readonly now: () => number = Date.now,
    /** The server whose chain for each day its anchors go into (the lease owner with SESSION_STORE=postgres). */
    readonly server = 'server',
    /** The longest a lock is waited for (lock_timeout), within the deadline of a question. */
    private readonly lockTimeoutMs = DEFAULT_SQL_TIMEOUT_MS,
    /** The connection the retention sweep runs on, with a longer deadline of its own. */
    private readonly sweepSql: SqlClient = sql,
  ) {}

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
      await tx.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(this.lockTimeoutMs))}ms'`);
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
      // The chain's newest hash, anchored into this server's chain for the day.
      await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [DAY_LOCK, `${day}/${this.server}`]);
      const dayHead = await tx.query<{ body: string }>('SELECT body FROM dw_audit_anchors WHERE day = $1 AND server = $2 ORDER BY seq DESC LIMIT 1', [day, this.server]);
      const lastAnchor = dayHead.rows.length > 0 ? (JSON.parse(dayHead.rows[0]!.body) as AuditAnchor) : null;
      const newest = entries.at(-1)!;
      const anchorBase = { day, server: this.server, seq: (lastAnchor?.seq ?? 0) + 1, at, callId: chain, callSeq: newest.seq, callHash: newest.hash, prevHash: lastAnchor?.hash ?? GENESIS };
      const anchor: AuditAnchor = { ...anchorBase, hash: anchorHash(anchorBase) };
      await tx.query('INSERT INTO dw_audit_anchors (day, server, seq, body) VALUES ($1, $2, $3, $4)', [day, this.server, anchor.seq, JSON.stringify(anchor)]);
      // The day's roster names this server's chain when it opens it, and its head every ROSTER_EVERY_MS.
      const known = this.days.get(day);
      const due = known === undefined || atMs - known.rosteredAtMs >= ROSTER_EVERY_MS;
      if (due) await this.roster(tx, day, at, anchor.seq, anchor.hash);
      return { entries, anchor, due };
    }).then(({ entries, anchor, due }) => {
      const known = this.days.get(day);
      this.days.set(day, {
        anchorSeq: anchor.seq, anchorHash: anchor.hash,
        rosteredSeq: due ? anchor.seq : (known?.rosteredSeq ?? 0), rosteredAtMs: due ? atMs : (known?.rosteredAtMs ?? 0),
      });
      return entries;
    });
  }

  /** This server's chain for `day`, as far as anchor `anchorSeq`, entered in the day's roster (in `tx`). */
  private async roster(tx: SqlQueryable, day: string, at: string, anchorSeq: number, anchorHash: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [ROSTER_LOCK, day]);
    const head = await tx.query<{ body: string }>('SELECT body FROM dw_audit_roster WHERE day = $1 ORDER BY seq DESC LIMIT 1', [day]);
    const last = head.rows.length > 0 ? (JSON.parse(head.rows[0]!.body) as RosterEntry) : null;
    const base = { day, seq: (last?.seq ?? 0) + 1, at, server: this.server, anchorSeq, anchorHash, prevHash: last?.hash ?? GENESIS };
    const entry: RosterEntry = { ...base, hash: rosterHash(base) };
    await tx.query('INSERT INTO dw_audit_roster (day, seq, body) VALUES ($1, $2, $3)', [day, entry.seq, JSON.stringify(entry)]);
  }

  /** At a stop: each day's chain head this server has not yet entered in the roster, entered. */
  async enterHeads(): Promise<void> {
    await this.settled();
    for (const [day, d] of this.days) {
      if (d.anchorSeq <= d.rosteredSeq) continue;
      const at = new Date(this.now()).toISOString();
      await this.sql.transaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(this.lockTimeoutMs))}ms'`);
        await this.roster(tx, day, at, d.anchorSeq, d.anchorHash);
      });
      d.rosteredSeq = d.anchorSeq;
    }
  }

  /** Every append asked for so far, done (or failed). */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /**
   * AUDIT_RETENTION_DAYS: the days older than `days` removed, never today's. A call's chain is removed
   * whole once its newest entry is older (never in part, so every chain that stays verifies from its
   * first entry), checked again in the statement that removes it with each chain's lock held, so an
   * entry appended meanwhile keeps its chain; and the days' anchors with the days. One server sweeps at
   * a time (an advisory lock; the others skip), with a deadline of its own. Returns the days, chains and
   * entries removed (all 0 for a server that skipped).
   */
  async sweep(days: number, nowMs: number): Promise<{ days: number; chains: number; entries: number }> {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
    return this.sweepSql.transaction(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '${SWEEP_TIMEOUT_MS}ms'`);
      await tx.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(this.lockTimeoutMs))}ms'`);
      const got = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [SWEEP_LOCK]);
      if (got.rows[0]?.ok !== true) return { days: 0, chains: 0, entries: 0 };
      const old = (await tx.query<{ chain: string }>('SELECT chain FROM dw_audit_entries GROUP BY chain HAVING max(day) < $1', [cutoff])).rows.map((r) => r.chain);
      let chains = 0;
      let entries = 0;
      for (let i = 0; i < old.length; i += SWEEP_BATCH) {
        const batch = old.slice(i, i + SWEEP_BATCH);
        for (const chain of batch) await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [CALL_LOCK, chain]);
        const list = batch.map((_, j) => `$${j + 2}`).join(', ');
        const gone = await tx.query<{ chain: string }>(
          `DELETE FROM dw_audit_entries WHERE chain IN (
             SELECT chain FROM dw_audit_entries WHERE chain IN (${list}) GROUP BY chain HAVING max(day) < $1
           ) RETURNING chain`,
          [cutoff, ...batch],
        );
        chains += new Set(gone.rows.map((r) => r.chain)).size;
        entries += gone.rows.length;
      }
      const dayRows = await tx.query<{ day: string }>('DELETE FROM dw_audit_anchors WHERE day < $1 RETURNING day', [cutoff]);
      await tx.query('DELETE FROM dw_audit_roster WHERE day < $1', [cutoff]);
      return { days: new Set(dayRows.rows.map((r) => r.day)).size, chains, entries };
    });
  }
}

/** How long the retention sweep may take, and how many chains it removes in one statement. */
const SWEEP_TIMEOUT_MS = 60_000;
const SWEEP_BATCH = 500;

/** The audit over `given`, once its tables are there at this code's version (made on first use). */
export async function openPostgresAudit(given: SqlClient, o: { now?: () => number; timeoutMs?: number; log?: (line: string) => void; server?: string } = {}): Promise<PostgresAuditLog> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;
  const sql = boundedSql(given, timeoutMs);
  if (await ensureTables(sql, AUDIT_TABLES)) o.log?.(`audit: made the audit tables in Postgres (version ${AUDIT_SCHEMA_VERSION})`);
  return new PostgresAuditLog(sql, o.now, o.server ?? 'server', timeoutMs, boundedSql(given, SWEEP_TIMEOUT_MS + 5_000));
}

/** Thrown to undo the probe's transaction. */
class ProbeUndone extends Error {}

/**
 * Whether an entry and an anchor can be written (pnpm diagnose): both inserted in one transaction that
 * is then rolled back, so a check never writes to the audit. Throws, saying what failed, when they cannot.
 */
export async function probeAuditWrite(sql: SqlClient): Promise<void> {
  const chain = `dw-diagnose-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`;
  try {
    await sql.transaction(async (tx) => {
      await tx.query('INSERT INTO dw_audit_entries (chain, seq, day, body) VALUES ($1, 1, $2, $3)', [chain, '0000-00-00', '{}']);
      await tx.query('INSERT INTO dw_audit_anchors (day, server, seq, body) VALUES ($1, $1, 1, $2)', [chain, '{}']);
      await tx.query('INSERT INTO dw_audit_roster (day, seq, body) VALUES ($1, 1, $2)', [chain, '{}']);
      throw new ProbeUndone('undone');
    });
  } catch (err) {
    if (err instanceof ProbeUndone) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------------------------

/** How many rows are checked between letting the server's other work run. */
const VERIFY_YIELD_ROWS = 1_000;

export interface PostgresVerifyResult {
  chains: number;
  entries: number;
  /** Each server's chain of anchors for each day. */
  days: { day: string; server: string; anchors: number }[];
  /** Every break found, the first of each chain: empty when the whole audit verifies. */
  breaks: string[];
}

/**
 * Re-walk every call's chain, every server's anchors for every day, and every day's roster (`pnpm
 * audit:verify postgres://...`): each chain from GENESIS with no gap, each entry's hash its own, each
 * anchor's link and hash, each anchor naming an entry that is there with that hash, each chain's newest
 * entry anchored, each roster entry naming an anchor that is there, and every server's anchors for a
 * day named in its roster. The first break of each chain, each server's day and each roster is
 * reported, and every other break besides.
 */
export async function verifyPostgresAudit(sql: SqlQueryable): Promise<PostgresVerifyResult> {
  const entries = await sql.query<{ chain: string; seq: Num; day: string; body: string }>('SELECT chain, seq, day, body FROM dw_audit_entries ORDER BY chain, seq');
  const anchors = await sql.query<{ day: string; server: string; seq: Num; body: string }>('SELECT day, server, seq, body FROM dw_audit_anchors ORDER BY day, server, seq');
  const roster = await sql.query<{ day: string; seq: Num; body: string }>('SELECT day, seq, body FROM dw_audit_roster ORDER BY day, seq');
  const breaks: string[] = [];
  /** Each chain's entries' hashes by seq, and its newest seq. */
  const hashes = new Map<string, Map<number, string>>();
  const brokenChains = new Set<string>();
  let expected = 0;
  let prev = GENESIS;
  let current: string | null = null;
  // Every so many rows the server's other work runs (a voice call's turn): the console verifies on a live server.
  let walked = 0;
  const breathe = async (): Promise<void> => {
    if (++walked % VERIFY_YIELD_ROWS === 0) await new Promise<void>((r) => setImmediate(r));
  };
  for (const row of entries.rows) {
    await breathe();
    const chain = row.chain;
    if (chain !== current) {
      current = chain;
      expected = 1;
      prev = GENESIS;
      hashes.set(chain, new Map());
    }
    if (brokenChains.has(chain)) continue;
    const seq = Number(row.seq);
    const fail = (why: string): void => {
      breaks.push(`call ${chain}: BROKEN at entry ${seq} (${why})`);
      brokenChains.add(chain);
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
    if (brokenChains.has(chain)) continue;
    hashes.get(chain)!.set(seq, hash);
    prev = hash;
    expected = seq + 1;
  }
  /** Each chain's newest seq that an anchor names. */
  const anchoredTo = new Map<string, number>();
  /** Each server's anchors for each day, by seq: their hashes, which the roster names. */
  const anchorHashes = new Map<string, Map<number, string>>();
  const days: PostgresVerifyResult['days'] = [];
  let key: string | null = null;
  let broken = false;
  for (const row of anchors.rows) {
    await breathe();
    const k = `${row.day}/${row.server}`;
    if (k !== key) {
      key = k;
      expected = 1;
      prev = GENESIS;
      broken = false;
      days.push({ day: row.day, server: row.server, anchors: 0 });
      anchorHashes.set(k, new Map());
    }
    days.at(-1)!.anchors += 1;
    const seq = Number(row.seq);
    const fail = (why: string): void => {
      if (!broken) breaks.push(`day ${row.day} (${row.server}): BROKEN at anchor ${seq} (${why})`);
      broken = true;
    };
    let a: AuditAnchor;
    try {
      a = JSON.parse(row.body) as AuditAnchor;
    } catch {
      fail('not JSON');
      continue;
    }
    const { hash, ...rest } = a;
    if (seq !== expected || a.seq !== seq || a.day !== row.day || a.server !== row.server) fail(seq !== expected ? `anchor ${expected} is missing` : 'its seq, day or server is not its place');
    else if (a.prevHash !== prev) fail('broken link');
    else if (anchorHash(rest) !== hash) fail('hash mismatch');
    // Read on past a break (once said), so a call's chain is judged by every anchor there is.
    if (!brokenChains.has(a.callId) && hashes.get(a.callId)?.get(a.callSeq) !== a.callHash) {
      breaks.push(`call ${a.callId}: BROKEN at entry ${a.callSeq} (anchored on ${row.day} by ${row.server}, and not there as anchored)`);
      brokenChains.add(a.callId);
    }
    anchoredTo.set(a.callId, Math.max(anchoredTo.get(a.callId) ?? 0, a.callSeq));
    anchorHashes.get(k)!.set(seq, hash);
    prev = hash;
    expected = seq + 1;
  }
  // The roster of each day: every server's chain of anchors named, and each entry naming an anchor that is there.
  const rostered = new Set<string>();
  let rosterDay: string | null = null;
  let rosterBroken = false;
  for (const row of roster.rows) {
    await breathe();
    if (row.day !== rosterDay) {
      rosterDay = row.day;
      expected = 1;
      prev = GENESIS;
      rosterBroken = false;
    }
    const seq = Number(row.seq);
    const fail = (why: string): void => {
      if (!rosterBroken) breaks.push(`roster ${row.day}: BROKEN at entry ${seq} (${why})`);
      rosterBroken = true;
    };
    let r: RosterEntry;
    try {
      r = JSON.parse(row.body) as RosterEntry;
    } catch {
      fail('not JSON');
      continue;
    }
    const { hash, ...rest } = r;
    if (seq !== expected || r.seq !== seq || r.day !== row.day) fail(seq !== expected ? `entry ${expected} is missing` : 'its seq or day is not its place');
    else if (r.prevHash !== prev) fail('broken link');
    else if (rosterHash(rest) !== hash) fail('hash mismatch');
    const k = `${r.day}/${r.server}`;
    rostered.add(k);
    if (anchorHashes.get(k)?.get(r.anchorSeq) !== r.anchorHash) breaks.push(`day ${r.day} (${r.server}): BROKEN at anchor ${r.anchorSeq} (named by the roster, and not there as named)`);
    prev = hash;
    expected = seq + 1;
  }
  for (const d of days) if (!rostered.has(`${d.day}/${d.server}`)) breaks.push(`day ${d.day} (${d.server}): its anchors are named in no roster`);
  for (const [chain, seqs] of hashes) {
    if (brokenChains.has(chain)) continue;
    const newest = Math.max(0, ...seqs.keys());
    const anchored = anchoredTo.get(chain) ?? 0;
    if (anchored < newest) breaks.push(`call ${chain}: BROKEN after entry ${anchored} (${newest - anchored} newer ${newest - anchored === 1 ? 'entry is' : 'entries are'} anchored nowhere)`);
  }
  return { chains: hashes.size, entries: entries.rows.length, days, breaks };
}

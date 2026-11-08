import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kept, Received, Text } from './app';

/**
 * The shop's records on file: an append-only log of JSON lines, one per thing the line took in or sent
 * (a request, a booking, a callback note, a text sent, a text received) and one per write's key, each
 * with the time it was written. The app's own setting SHOP_DATA_DIR names its folder; unset, nothing is
 * written and the records are kept in memory, as before (the tests and the regressions run so).
 *
 * The server reads the log back as it starts (src/shopPage.ts opens it when it mounts the shop page), so
 * a restart forgets nothing: the shop page, the drop-off windows' room, the requests a photo texted in is
 * matched to, and each write's key, so a write repeated after a restart is still done once.
 *
 * It holds the callers' numbers whole and their words, as the shop needs them: the folder is made for the
 * server's own account alone (mode 700) and the file is mode 600. A line is only ever appended; a line
 * that cannot be read (the last one, cut by a crash mid-write) is skipped and counted, never rewritten.
 */

/** The setting that names the log's folder (the app's own settings file; never business.yaml). */
export const SHOP_DATA_DIR = 'SHOP_DATA_DIR';
/** The log's file, in that folder. */
export const SHOP_LOG_FILE = 'shop.jsonl';
/** The version of a line's shape. */
const V = 1;

/** One line of the log, without its version and time. */
export type ShopEntry =
  | { kind: 'request' | 'booking' | 'callback'; record: Kept }
  | { kind: 'text'; record: Text }
  | { kind: 'received'; record: Received }
  /** A write's key and the reference it was given (Systems.written), so a write repeated after a restart is done once. */
  | { kind: 'written'; name: string; ref: string };

/** A line as it is on file: the entry, its version and when it was written (ISO). */
export type ShopLine = ShopEntry & { v: number; at: string };

/** What reading the log back found: its lines in order, and how many could not be read. */
export interface ShopRead {
  lines: ShopLine[];
  skipped: number;
  /** The file does not end with a line's end (a write cut short). */
  unended: boolean;
}

const KINDS = new Set(['request', 'booking', 'callback', 'text', 'received', 'written']);

/** Whether a parsed line has the shape this version writes. */
function isLine(x: unknown): x is ShopLine {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.v !== V || typeof o.at !== 'string' || typeof o.kind !== 'string' || !KINDS.has(o.kind)) return false;
  if (o.kind === 'written') return typeof o.name === 'string' && typeof o.ref === 'string';
  return typeof o.record === 'object' && o.record !== null && typeof (o.record as Record<string, unknown>).ref === 'string';
}

/** The append-only log in a folder: read back once, then appended to. */
export class ShopLog {
  readonly file: string;

  private constructor(readonly dir: string) {
    this.file = join(dir, SHOP_LOG_FILE);
  }

  /** Opens the log in `dir` (made, mode 700, if it is not there; the file made mode 600) and reads it back. */
  static open(dir: string): { log: ShopLog; read: ShopRead } {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = new ShopLog(dir);
    // Made empty if it is not there, readable and writable by the server's account alone.
    closeSync(openSync(log.file, 'a', 0o600));
    if (process.platform !== 'win32' && (statSync(log.file).mode & 0o077) !== 0) chmodSync(log.file, 0o600);
    const read = ShopLog.read(log.file);
    // A last line cut short by a crash is ended, so the next line is not written onto it.
    if (read.unended) appendFileSync(log.file, '\n');
    return { log, read };
  }

  /** Reads a log's lines; a line that is not one (cut short, or of another shape) is skipped and counted. */
  static read(file: string): ShopRead {
    const lines: ShopLine[] = [];
    let skipped = 0;
    const all = readFileSync(file, 'utf8');
    for (const text of all.split('\n')) {
      if (text.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isLine(parsed)) lines.push(parsed);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { lines, skipped, unended: all !== '' && !all.endsWith('\n') };
  }

  /** Appends one entry, with when it was written. */
  append(entry: ShopEntry, atMs: number): void {
    appendFileSync(this.file, `${JSON.stringify({ v: V, at: new Date(atMs).toISOString(), ...entry })}\n`, { mode: 0o600 });
  }
}

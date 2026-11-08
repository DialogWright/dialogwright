import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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
 * It is the shop's own system, holding the callers' numbers whole and their words, as the shop needs them:
 * - the folder is made for the server's own account alone (mode 700); one already there that others may
 *   read or write is tightened to 700 where the server owns it, and otherwise warned of as the server starts;
 * - the file is mode 600, and is never reached through a symbolic link: it is opened with O_NOFOLLOW (a link
 *   there stops the server, naming it), and every line is written through that one descriptor;
 * - a line is only ever appended; a line that cannot be read (the last one, cut by a crash mid-write) or
 *   that is not the shape this version writes is skipped and counted, never rewritten.
 * One server's: two servers on one folder would each read the other's lines only when they start.
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

const isString = (x: unknown): x is string => typeof x === 'string';
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every(isString);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A record a write kept: every field a string, its reference and time among them. */
function isKept(r: unknown): r is Kept {
  return isObject(r) && isString(r.ref) && isString(r.at) && Object.values(r).every(isString);
}

/** A text sent: its reference, time, number, words and status, and its media, if any, as URLs. */
function isText(r: unknown): r is Text {
  return isObject(r) && isString(r.ref) && isString(r.at) && isString(r.to) && isString(r.text) && isString(r.status) && (r.media === undefined || isStrings(r.media));
}

/** A text received: its reference, time, number, words and media, and the request it was matched to, if any. */
function isReceived(r: unknown): r is Received {
  return isObject(r) && isString(r.ref) && isString(r.at) && isString(r.from) && isString(r.text) && isStrings(r.media) && (r.request === undefined || isString(r.request));
}

/** Whether a parsed line has the shape this version writes, every field of the type it is read as. */
function isLine(x: unknown): x is ShopLine {
  if (!isObject(x) || x.v !== V || !isString(x.at)) return false;
  switch (x.kind) {
    case 'request':
    case 'booking':
    case 'callback':
      return isKept(x.record);
    case 'text':
      return isText(x.record);
    case 'received':
      return isReceived(x.record);
    case 'written':
      return isString(x.name) && isString(x.ref);
    default:
      return false;
  }
}

/** O_NOFOLLOW where the platform has it (not Windows, where the folder's own permissions protect it). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The append-only log in a folder: read back once, then appended to through one descriptor. */
export class ShopLog {
  readonly file: string;

  private constructor(readonly dir: string, private readonly fd: number) {
    this.file = join(dir, SHOP_LOG_FILE);
  }

  /**
   * Opens the log in `dir` and reads it back: the folder made (mode 700) if it is not there, its mode checked
   * if it is, and the file made mode 600 if it is not; never through a symbolic link. Returns what it read and
   * any warning for the server's log.
   */
  static open(dir: string): { log: ShopLog; read: ShopRead; warnings: string[] } {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const warnings = ShopLog.checkFolder(dir);
    const file = join(dir, SHOP_LOG_FILE);
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${file} is a symbolic link: the shop's log is never written through one. Remove the link, or set ${SHOP_DATA_DIR} to the folder it points into`);
      throw e;
    }
    if (process.platform !== 'win32') {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        closeSync(fd);
        throw new Error(`${file} is not a file`);
      }
      if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
    }
    const log = new ShopLog(dir, fd);
    const read = ShopLog.parse(readFileSync(fd, 'utf8'));
    // A last line cut short by a crash is ended, so the next line is not written onto it.
    if (read.unended) writeSync(fd, '\n');
    return { log, read, warnings };
  }

  /** The folder's mode: others may neither read nor write it. Tightened where the server owns it; a warning otherwise. */
  private static checkFolder(dir: string): string[] {
    if (process.platform === 'win32') return [];
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return [`${dir} is a symbolic link: the shop's log is kept in the folder it points to`];
    if ((st.mode & 0o077) === 0) return [];
    if (process.getuid !== undefined && st.uid === process.getuid()) {
      chmodSync(dir, 0o700);
      return [];
    }
    return [`${dir} can be read or written by other accounts (mode ${(st.mode & 0o777).toString(8)}) and belongs to another account, so its mode was not changed: the shop's log holds callers' numbers whole; chmod 700 ${dir}, or set ${SHOP_DATA_DIR} to a folder of the server's own`];
  }

  /** Reads a log's lines from a file (a test's look at it). */
  static read(file: string): ShopRead {
    return ShopLog.parse(readFileSync(file, 'utf8'));
  }

  /** A log's lines; a line that is not one (cut short, or of another shape) is skipped and counted. */
  private static parse(all: string): ShopRead {
    const lines: ShopLine[] = [];
    let skipped = 0;
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
    writeSync(this.fd, `${JSON.stringify({ v: V, at: new Date(atMs).toISOString(), ...entry })}\n`);
  }

  /** Closes the descriptor (a test's; the server keeps it open while it runs). */
  close(): void {
    closeSync(this.fd);
  }
}

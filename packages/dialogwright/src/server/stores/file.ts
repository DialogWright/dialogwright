import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallTokens, type TokenEntry } from '../tokens';
import type { CallStateStore, ChatStateStore, StoredCall, StoredChat } from './types';

/**
 * The file stores (SESSION_STORE=file:<dir>): one machine's calls, chats and tokens in a folder, so a
 * restart (an update, a reboot, a crash) does not lose a caller. No database: each call is one JSON
 * file, written whole or not at all.
 *
 *   <dir>/calls/<stem>.json   one per live call (StoredCall), mode 600
 *   <dir>/chats/<stem>.json   one per live chat (StoredChat, its resume token as a hash), mode 600
 *   <dir>/tokens.json         the live relay tokens, each as its hash, carrier and expiry, mode 600
 *
 * The folders the store makes (and calls/ and chats/ always) are mode 700, so only the user the server
 * runs as can read a session, which holds what the caller said and the values they gave, as a trace
 * does. A token is kept only as its SHA-256: nothing in the folder opens a socket.
 *
 * A write goes to a temporary file in the same folder and is renamed over the old one, which is atomic
 * on one filesystem, so a crash mid-write leaves the last whole save. It is not flushed to the disk on
 * every turn (that would add the disk's latency to every reply): a process that stops or crashes loses
 * nothing, a power cut may lose the last few seconds. A file that cannot be read or is not a store's
 * (a hand edit, a disk error) is logged once and skipped, never a crash.
 */

/** A file name for an id: its safe characters, for a person reading the folder, and a hash, so two ids never share one. */
export function storeFileStem(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'id';
  return `${safe}-${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Make `dir` (mode 700) if it is not there; one this store owns outright is set to 700 even if it was. */
function ownFolder(dir: string, always: boolean): void {
  const made = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made || always) chmodSync(dir, 0o700);
}

/** Write `body` to `file` whole or not at all: a temporary file (mode 600) beside it, renamed over it. */
export function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never made, or already renamed.
    }
    throw err;
  }
}

/** A temporary file left by a process that stopped mid-write: no writer is coming back for it. */
function sweepTemporary(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tmp')) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Gone already.
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why a parsed file is not a stored call, or null when it is one. */
function callProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'not an object';
  if (typeof v.callId !== 'string' || v.callId === '') return 'no callId';
  if (typeof v.provider !== 'string') return 'no provider';
  if (!isNumber(v.schema)) return 'no schema';
  if (!isRecord(v.session)) return 'no session';
  if (!isNumber(v.reconnects) || !isNumber(v.createdAtMs) || !isNumber(v.lastActivityMs)) return 'a counter is missing';
  if (!Array.isArray(v.auditTail)) return 'no auditTail';
  return null;
}

/** Why a parsed file is not a stored chat, or null when it is one. */
function chatProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'not an object';
  if (typeof v.id !== 'string' || v.id === '') return 'no id';
  if (!isNumber(v.schema)) return 'no schema';
  if (!isRecord(v.session)) return 'no session';
  if (typeof v.resumeHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.resumeHash)) return 'no resumeHash';
  if (!isNumber(v.createdAtMs) || !isNumber(v.lastActivityMs)) return 'a counter is missing';
  if (!Array.isArray(v.auditTail)) return 'no auditTail';
  return null;
}

/** One folder of JSON records, each in its own file named by its id's stem. */
class RecordFolder<T> {
  /** Files already reported unreadable, so each is logged once, not on every sweep. */
  private readonly reported = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly kind: string,
    private readonly problem: (v: unknown) => string | null,
    private readonly idOf: (v: T) => string,
    private readonly log: (line: string) => void,
  ) {
    ownFolder(dir, true);
    sweepTemporary(dir);
  }

  private fileOf(id: string): string {
    return join(this.dir, `${storeFileStem(id)}.json`);
  }

  /** The record in `file`, or null when there is none or it cannot be read (logged once). */
  private read(file: string): T | null {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      this.skip(file, err instanceof Error ? err.message : String(err));
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.skip(file, 'not JSON');
      return null;
    }
    const problem = this.problem(parsed);
    if (problem !== null) {
      this.skip(file, problem);
      return null;
    }
    return parsed as T;
  }

  private skip(file: string, why: string): void {
    if (this.reported.has(file)) return;
    this.reported.add(file);
    this.log(`sessions: skipped ${file}: ${why} (not a ${this.kind} this store wrote; left as it is)`);
  }

  load(id: string): T | null {
    const v = this.read(this.fileOf(id));
    // A stem shared by two ids would need a SHA-256 collision; the id in the file is checked all the same.
    return v !== null && this.idOf(v) === id ? v : null;
  }

  save(id: string, v: T): void {
    writeAtomic(this.fileOf(id), JSON.stringify(v));
  }

  remove(id: string): void {
    try {
      unlinkSync(this.fileOf(id));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
  }

  all(): T[] {
    const out: T[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const v = this.read(join(this.dir, name));
      if (v !== null) out.push(v);
    }
    return out;
  }
}

export class FileCallStateStore implements CallStateStore {
  private readonly folder: RecordFolder<StoredCall>;

  constructor(dir: string, log: (line: string) => void = () => {}) {
    this.folder = new RecordFolder<StoredCall>(dir, 'call', callProblem, (c) => c.callId, log);
  }

  load(callId: string): StoredCall | null {
    return this.folder.load(callId);
  }

  save(call: StoredCall): void {
    this.folder.save(call.callId, call);
  }

  remove(callId: string): void {
    this.folder.remove(callId);
  }

  list(): string[] {
    return this.folder.all().map((c) => c.callId);
  }
}

export class FileChatStateStore implements ChatStateStore {
  private readonly folder: RecordFolder<StoredChat>;

  constructor(dir: string, log: (line: string) => void = () => {}) {
    this.folder = new RecordFolder<StoredChat>(dir, 'chat', chatProblem, (c) => c.id, log);
  }

  load(id: string): StoredChat | null {
    return this.folder.load(id);
  }

  /** A scan of the chats saved: one machine holds few, and a resume is rare beside a turn. */
  findByResume(resumeHash: string): StoredChat | null {
    return this.folder.all().find((c) => c.resumeHash === resumeHash) ?? null;
  }

  save(chat: StoredChat): void {
    this.folder.save(chat.id, chat);
  }

  remove(id: string): void {
    this.folder.remove(id);
  }

  list(): string[] {
    return this.folder.all().map((c) => c.id);
  }
}

/** tokens.json as written: each live token's hash, carrier and expiry, by call. */
interface TokenFile {
  v: 1;
  tokens: (TokenEntry & { callId: string })[];
}

function tokenProblem(v: unknown): string | null {
  if (!isRecord(v) || v.v !== 1 || !Array.isArray(v.tokens)) return 'not a tokens file';
  for (const t of v.tokens) {
    if (!isRecord(t) || typeof t.callId !== 'string' || typeof t.provider !== 'string' || !isNumber(t.expiresAt) || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) {
      return 'a token entry is not one';
    }
  }
  return null;
}

/**
 * The relay tokens, kept in memory as CallTokens keeps them and written to `file` after every change,
 * so a token minted before a restart opens its socket after it. Read back as the store opens; a file
 * that cannot be read is logged and the store starts with none (a call whose token is lost calls back
 * and is given another).
 */
export class FileTokens extends CallTokens {
  constructor(private readonly file: string, ttlMs: number, now: () => number = Date.now, private readonly log: (line: string) => void = () => {}) {
    super(ttlMs, now);
    this.readBack();
  }

  private readBack(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') this.log(`sessions: skipped ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log(`sessions: skipped ${this.file}: not JSON (the relay tokens start empty)`);
      return;
    }
    const problem = tokenProblem(parsed);
    if (problem !== null) {
      this.log(`sessions: skipped ${this.file}: ${problem} (the relay tokens start empty)`);
      return;
    }
    const now = this.now();
    for (const t of (parsed as TokenFile).tokens) {
      if (now <= t.expiresAt) this.byCall.set(t.callId, { hash: t.hash, provider: t.provider, expiresAt: t.expiresAt });
    }
  }

  private writeOut(): void {
    const body: TokenFile = { v: 1, tokens: [...this.byCall].map(([callId, e]) => ({ callId, hash: e.hash, provider: e.provider, expiresAt: e.expiresAt })) };
    try {
      writeAtomic(this.file, JSON.stringify(body));
    } catch (err) {
      // The token is live in this process either way; only a restart before the next write would lose it.
      this.log(`sessions: could not write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  override mint(callSid: string, provider?: string): string {
    const token = super.mint(callSid, provider);
    this.writeOut();
    return token;
  }

  override revoke(callSid: string): void {
    const had = this.byCall.has(callSid);
    super.revoke(callSid);
    if (had) this.writeOut();
  }

  override evictExpired(): number {
    const n = super.evictExpired();
    if (n > 0) this.writeOut();
    return n;
  }
}

/** The file stores over one folder, as SESSION_STORE=file:<dir> opens them. */
export interface FileStores {
  readonly dir: string;
  readonly calls: FileCallStateStore;
  readonly chats: FileChatStateStore;
  readonly tokens: FileTokens;
}

/** Whether a folder's mode lets anyone but its owner in (group or other bits set). */
export function openToOthers(dir: string): boolean {
  try {
    return (statSync(dir).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Opens (and makes, mode 700) the store's folder and its calls/ and chats/. A folder that was already
 * there keeps its mode, since it may be shared with other things; what the store writes in it is 600,
 * and calls/ and chats/ are 700 whatever the folder is.
 */
export function openFileStores(dir: string, o: { tokenTtlMs: number; now?: () => number; log?: (line: string) => void }): FileStores {
  const log = o.log ?? (() => {});
  ownFolder(dir, false);
  sweepTemporary(dir);
  if (openToOthers(dir)) log(`sessions: WARNING: ${dir} can be read by others than its owner; calls/ and chats/ in it cannot (mode 700)`);
  return {
    dir,
    calls: new FileCallStateStore(join(dir, 'calls'), log),
    chats: new FileChatStateStore(join(dir, 'chats'), log),
    tokens: new FileTokens(join(dir, 'tokens.json'), o.tokenTtlMs, o.now, log),
  };
}

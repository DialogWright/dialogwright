import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { gapTurnsOfLines as turnsOfLines, traceReaderOf, type GapTurn as Turn } from 'dialogwright';

/**
 * Reading trace files for kb:gaps: which files (a file, a folder, or a glob; by default the folder a
 * server or the text harness writes them to) and what a gap needs of each record. A trace line is
 * read defensively: it is JSON from disk that may be from an older build, so every field is checked
 * before it is used, and a line that does not read as a v2 record is passed over (a record from
 * before the knowledge base has nothing a gap could be made of).
 *
 * The trace already masks the identity slots (the writer's redaction); the caller's own words are in
 * it as spoken. `masked` marks the slots whose value in a record is one of those masks, which is how
 * a gap knows the words of that turn carried a masked value.
 */

// ---------------------------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------------------------

const GLOB_CHARS = /[*?]/;

/** One path segment's glob as a regular expression: `*` any run but a slash, `?` one character. */
function segmentPattern(segment: string): RegExp {
  const body = segment
    .split(/(\*|\?)/)
    .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/** The files a trace folder holds: its `.jsonl` files, not the frame logs beside them, by name. */
function jsonlIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl') && !n.endsWith('.frames.jsonl') && !n.startsWith('.'))
      .sort()
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  } catch {
    return [];
  }
}

/** The files matching an absolute glob (`**` is any number of folders, including none). */
function expandGlob(pattern: string): string[] {
  const parts = pattern.split(sep).filter((p) => p !== '');
  const root = sep;
  const out: string[] = [];
  const walk = (dir: string, at: number): void => {
    if (at === parts.length) {
      try {
        if (statSync(dir).isFile()) out.push(dir);
        else if (statSync(dir).isDirectory()) out.push(...jsonlIn(dir));
      } catch {
        // gone while walking
      }
      return;
    }
    const part = parts[at]!;
    if (part === '**') {
      walk(dir, at + 1);
      for (const name of safeDir(dir)) {
        const p = join(dir, name);
        if (isDir(p) && !name.startsWith('.') && name !== 'node_modules') walk(p, at);
      }
      return;
    }
    if (!GLOB_CHARS.test(part)) {
      const p = join(dir, part);
      if (existsSync(p)) walk(p, at + 1);
      return;
    }
    const re = segmentPattern(part);
    for (const name of safeDir(dir)) if (re.test(name) && !(name.startsWith('.') && !part.startsWith('.'))) walk(join(dir, name), at + 1);
  };
  walk(root, 0);
  return out;
}

const safeDir = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The trace files `specs` name: a file as it is, a folder's `.jsonl` files (not `.frames.jsonl`), or a
 * glob (`traces/*.jsonl`, `runs/**` with `**` for any depth) over the files it matches. Relative paths
 * are from `cwd`. The files are absolute, sorted and each once.
 */
export function traceFilesOf(specs: readonly string[], cwd: string): string[] {
  const found = new Set<string>();
  for (const spec of specs) {
    // A trace store (s3://...) is read through its reader (storeTurns), not as a path.
    if (isStoreSpec(spec)) continue;
    const path = resolve(cwd, spec);
    if (GLOB_CHARS.test(path)) {
      for (const f of expandGlob(path)) if (!f.endsWith('.frames.jsonl')) found.add(f);
    } else if (isDir(path)) for (const f of jsonlIn(path)) found.add(f);
    else if (existsSync(path)) found.add(path);
  }
  return [...found].sort();
}

/**
 * Where the traces are when no `--traces` says: the folder `TRACE_DIR` names, else the app folder's
 * `traces/`, else `traces/` where the command is run (the folder the server and the text harness
 * write to by default). Each as an absolute path, whether or not it is there yet.
 */
export function defaultTraceSpecs(opts: { cwd: string; appDir: string | null; env: NodeJS.ProcessEnv }): string[] {
  // The server writes to a trace store when TRACE_STORE names one: read there.
  const store = opts.env.TRACE_STORE?.trim();
  if (store) return [store];
  const named = opts.env.TRACE_DIR?.trim();
  if (named) return [resolve(opts.cwd, named)];
  const specs = [...(opts.appDir !== null ? [join(opts.appDir, 'traces')] : []), resolve(opts.cwd, 'traces')];
  return [...new Set(specs)];
}

// ---------------------------------------------------------------------------------------------
// What a gap reads of a record: the engine's (dialogwright kb/gaps.ts), which the console counts with too
// ---------------------------------------------------------------------------------------------

export { gapTurnOf as turnOf } from 'dialogwright';
export type { GapTurn as Turn, GapTurnAnswer as TurnAnswer, GapTurnQuestion as TurnQuestion } from 'dialogwright';

/** The turns of one trace file, in the order written; lines that do not read as a record are passed over (counted in `skipped`). */
export function readTurns(file: string): { turns: Turn[]; skipped: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { turns: [], skipped: 0 };
  }
  return turnsOfLines(text.split('\n'), file);
}

/** Whether a `--traces` spec names a trace store (TRACE_STORE's `s3://<bucket>/<prefix>`) rather than a path. */
export function isStoreSpec(spec: string): boolean {
  return /^s3:\/\//i.test(spec.trim());
}

/**
 * The turns of every call on the trace stores `specs` name (`s3://<bucket>/<prefix>`, with the S3_
 * variables' keys), each call's segments joined by the engine's one reader, as the console reads them.
 * A call is named `s3://<bucket>/<prefix><call>` where a file would be named by its path.
 */
export async function storeTurns(specs: readonly string[], env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<{ turns: Turn[]; skipped: number; files: string[] }> {
  const out = { turns: [] as Turn[], skipped: 0, files: [] as string[] };
  for (const spec of specs.filter(isStoreSpec)) {
    const reader = traceReaderOf(spec, env, fetchImpl ? { fetch: fetchImpl } : {})!;
    for (const call of [...(await reader.calls())].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const joined = await reader.read(call.id);
      if (joined === null) continue;
      const name = `${reader.label}${call.id}`;
      const read = turnsOfLines(joined.trace, name);
      out.turns.push(...read.turns);
      out.skipped += read.skipped;
      out.files.push(name);
    }
  }
  return out;
}

/** The turns of a trace's lines (a file's, or a call's joined segments), named `file`, each with its line number: the engine's. */
export { gapTurnsOfLines as turnsOfLines } from 'dialogwright';

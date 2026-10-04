import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

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
  const named = opts.env.TRACE_DIR?.trim();
  if (named) return [resolve(opts.cwd, named)];
  const specs = [...(opts.appDir !== null ? [join(opts.appDir, 'traces')] : []), resolve(opts.cwd, 'traces')];
  return [...new Set(specs)];
}

// ---------------------------------------------------------------------------------------------
// What a gap reads of a record
// ---------------------------------------------------------------------------------------------

/** One question as the model was asked it, as far as a gap needs it. */
export interface TurnQuestion {
  type: string;
  /** The labels of a choice question. */
  labels: string[];
}

/** One choice answer: the label chosen, and every label's probability. */
export interface TurnAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
}

/** One turn of a trace, as kb:gaps reads it. */
export interface Turn {
  file: string;
  line: number;
  sessionId: string;
  turnIndex: number;
  ts: string;
  /** The caller's words as recorded (speech or text); null for any other event. */
  words: string | null;
  quarantined: boolean;
  locale: string | null;
  /** What the knowledge retriever did; null when it did not run on this turn. */
  retrieval: { nominated: string[]; failed: string | null } | null;
  questions: Record<string, TurnQuestion>;
  answers: Record<string, TurnAnswer>;
  /** The intent the model chose, when it was asked. */
  intent: string | null;
  decision: { kind: string; promptId: string | null; target: string | null; acks: string[] };
  promptedFor: string | null;
  /** The slots with a value after the turn, as recorded (a masked slot's value is the mask). */
  slotValues: Record<string, string>;
  /** The slots whose value is one of the trace's masks. */
  masked: string[];
  /** Whether a masked value is in what the turn did: a gated call's params, or what the decision says (its variables, a handoff's slots). */
  maskedInDecision: boolean;
  /** The gated calls of the turn: the tool, the `topic` param when recorded, and the tool's summary. */
  calls: { tool: string; topic: string | null; summary: string | null }[];
  /** The knowledge record of the turn (a passage said, or one withheld). */
  kb: { passageId: string; topic: string; fresh: boolean; document: string | null; section: string | null; locale: string | null } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The values the trace writer puts in place of an identity slot's value (trace/redact.ts): last four, year only, a length. */
const MASKED_VALUE = /^(?:\.\.\.\d{4}|••\/••\/(?:\d{4}|••••)|<\d+ chars>)$/;

/** A record as a Turn, or null when it does not read as a v2 record with a session and a turn. */
export function turnOf(raw: unknown, file: string, line: number): Turn | null {
  if (!isObject(raw) || raw.v !== 2) return null;
  const sessionId = str(raw.sessionId);
  const ts = str(raw.ts);
  if (sessionId === null || ts === null || typeof raw.turnIndex !== 'number') return null;
  const event = isObject(raw.event) ? raw.event : {};
  const words = (event.type === 'user.speech' || event.type === 'user.text') && typeof event.text === 'string' ? event.text : null;

  const retrieval = isObject(raw.retrieval)
    ? {
        nominated: (Array.isArray(raw.retrieval.nominated) ? raw.retrieval.nominated : []).flatMap((n) => (isObject(n) && typeof n.topic === 'string' ? [n.topic] : [])),
        failed: str(raw.retrieval.failed),
      }
    : null;

  const questions: Record<string, TurnQuestion> = {};
  if (isObject(raw.questions)) {
    for (const [id, q] of Object.entries(raw.questions)) {
      if (!isObject(q)) continue;
      questions[id] = { type: str(q.type) ?? '', labels: isObject(q.criteria) ? Object.keys(q.criteria) : [] };
    }
  }
  const answers: Record<string, TurnAnswer> = {};
  if (isObject(raw.answers)) {
    for (const [id, a] of Object.entries(raw.answers)) {
      if (!isObject(a) || a.type !== 'choice') continue;
      const probabilities: Record<string, number> = {};
      if (isObject(a.probabilities)) for (const [label, p] of Object.entries(a.probabilities)) if (typeof p === 'number' && Number.isFinite(p)) probabilities[label] = p;
      answers[id] = { choice: str(a.choice), probabilities, confidence: typeof a.confidence === 'number' ? a.confidence : null };
    }
  }

  const d = isObject(raw.decision) ? raw.decision : {};
  const decision = {
    kind: str(d.kind) ?? '',
    promptId: str(d.promptId),
    target: str(d.target),
    acks: (Array.isArray(d.acks) ? d.acks : []).flatMap((a) => (isObject(a) && typeof a.promptId === 'string' ? [a.promptId] : [])),
  };

  const slotValues: Record<string, string> = {};
  const masked: string[] = [];
  if (isObject(raw.slots)) {
    for (const [id, s] of Object.entries(raw.slots)) {
      if (!isObject(s) || typeof s.value !== 'string') continue;
      slotValues[id] = s.value;
      if (MASKED_VALUE.test(s.value)) masked.push(id);
    }
  }

  const calls: Turn['calls'] = [];
  const isMask = (v: unknown): boolean => typeof v === 'string' && MASKED_VALUE.test(v);
  const hasMask = (o: unknown): boolean => isObject(o) && Object.values(o).some(isMask);
  let maskedInDecision = hasMask(d.vars) || hasMask(d.slots) || (Array.isArray(d.acks) && d.acks.some((a) => isObject(a) && hasMask(a.vars)));
  if (Array.isArray(raw.gateEvents)) {
    for (const g of raw.gateEvents) {
      if (!isObject(g) || !isObject(g.decision) || !isObject(g.decision.call)) continue;
      const params = isObject(g.decision.call.params) ? g.decision.call.params : {};
      if (hasMask(params)) maskedInDecision = true;
      calls.push({ tool: str(g.decision.call.tool) ?? '', topic: str(params.topic), summary: str(g.summary) });
    }
  }

  let kb: Turn['kb'] = null;
  if (isObject(raw.kb) && typeof raw.kb.passageId === 'string' && typeof raw.kb.topic === 'string') {
    kb = { passageId: raw.kb.passageId, topic: raw.kb.topic, fresh: raw.kb.fresh === true, document: str(raw.kb.document), section: str(raw.kb.section), locale: str(raw.kb.locale) };
  }

  const intent = isObject(raw.answers) && isObject(raw.answers.intent) ? str(raw.answers.intent.choice) : null;
  return {
    file,
    line,
    sessionId,
    turnIndex: raw.turnIndex,
    ts,
    words,
    quarantined: raw.quarantined === true,
    locale: str(raw.locale),
    retrieval,
    questions,
    answers,
    intent,
    decision,
    promptedFor: str(raw.promptedFor),
    slotValues,
    masked,
    maskedInDecision,
    calls,
    kb,
  };
}

/** The turns of one trace file, in the order written; lines that do not read as a record are passed over (counted in `skipped`). */
export function readTurns(file: string): { turns: Turn[]; skipped: number } {
  const turns: Turn[] = [];
  let skipped = 0;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { turns, skipped };
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.trim() === '') continue;
    try {
      const turn = turnOf(JSON.parse(l) as unknown, file, i + 1);
      if (turn) turns.push(turn);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { turns, skipped };
}

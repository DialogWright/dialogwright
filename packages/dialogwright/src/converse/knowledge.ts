import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Document, LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { formatPath, positionOf, problemsOfIssues, WHOLE_FILE, type Problem } from '../define/problems';
import type { JsonSchema } from '../define/schema/json';
import { isChoice, type AnswerMap, type JevClient, type QuestionMap } from '../jev/types';
import { renderCriterion } from '../kb/criterion';
import { readKbFolder, type KbEntry, type KbFolderIo } from '../kb/folder';
import { defaultRetriever } from '../kb/hybrid';
import { kbAuditRow, kbSourceOf, shortHash } from '../kb/record';
import { resolvePassage } from '../kb/resolve';
import { KB_KINDS, type KbKind } from '../kb/schema';
import { DEFAULT_TOPIC_CRITERION, TOPIC_UNANSWERED, TOPIC_UNANSWERED_INSTRUCTIONS, TOPIC_UNANSWERED_NONE } from '../kb/topicQuestion';
import type { KbPassage, KnowledgeBase, Nomination, Retriever } from '../kb/types';
import type { AuditDraft } from '../audit/types';
import { AgentBusinessError } from './business/load';
import { LOOK_UP, LOOK_UP_AUDIT_DEFAULT, type ActionSpec, type AgentBusiness } from './business/schema';
import { askWithinWhy } from './confirm';
import type { JourneyState } from './state';

/**
 * The knowledge base in agent mode (the maintainer's decision, 2026-11-27): an agent app's kb/ folder beside agent.yaml,
 * read by the knowledge base's own reading (kb/folder.ts), and the runtime's own lookup, `look_up`, through which the
 * agent model finds the business's approved answer to a caller's question and words it in its own streamed reply.
 *
 * The lookup finds candidates with the app's retriever (kb.yaml's retrieval: its cap and floor, keywords or hybrid), asks
 * the decision model which of them the caller asks about (the scripted topic slot's question, kb/topicQuestion.ts, held to
 * its bar, SLOT_CHOICE_FILL), and resolves that topic's passage as a scripted app's is (kb/resolve.ts): only a passage a
 * person approved and nothing has changed under since is ever returned. With it go its topic's title and its wording
 * rule, as context: a `risk: low` topic's passage may be worded for the caller's question; any other is the business's
 * approved answer, to be given as written. That rule is the agent model's instruction alone: nothing checks or judges
 * its reply before it is said (it streams, as every reply in agent mode does). Where nothing approved answers, the
 * model is told the business has no approved answer to the question.
 *
 * The folder is read as the folder loader reads it for `pnpm check` (inside the app folder, size bounded, YAML 1.2 with
 * no tags, each file against its schema); its content rules (kb/rules.ts) are `pnpm check`'s, not the runtime's.
 */

/** The lookup's one param: the caller's question, in their words. */
export const QUESTION_PARAM = 'question';

/** The most characters the question may have. */
export const QUESTION_MAX = 300;

/** The decision model's bar for the topic it reads the caller as asking about: the scripted topic slot's fill bar (fillAt's default). */
export const LOOK_UP_AT = DEFAULT_THRESHOLDS.SLOT_CHOICE_FILL;

/** The id of the decision model's question, as the scripted topic slot's is named (the slot's id followed by Topic). */
export const LOOK_UP_QUESTION_ID = 'lookUpTopic';

/** An agent app's knowledge base, read from its kb/ folder, and the retriever kb.yaml names (keywords, or hybrid with its embedder). */
export interface ConverseKnowledge {
  kb: KnowledgeBase;
  retriever: Retriever;
}

/** The folder beside agent.yaml that holds the knowledge base. */
export const KB_FOLDER = 'kb';

/** A file bigger than this is refused, as the folder loader refuses one. */
const MAX_FILE_BYTES = 1024 * 1024;
/** The yaml library's alias bound, as the folder loader's. */
const MAX_ALIAS_COUNT = 20;

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The knowledge base's files read as the folder loader reads them, under the app folder's real path: a file inside it
 * (no link out), size bounded, UTF-8, YAML 1.2 with no tags and duplicate keys refused, aliases capped, then its kind's
 * schema. The converse runtime never reaches the scripted engine, so this is the reading on its own (define/load.ts
 * kbIo is the same for `pnpm check`).
 */
function kbFolderIo(root: string, problems: Problem[]): KbFolderIo {
  const documents = new Map<string, { doc: Document; lines: LineCounter }>();
  const real = (file: string): string | 'missing' | 'outside' => {
    const abs = join(root, ...file.split('/'));
    let r: string;
    try {
      r = realpathSync(abs);
    } catch {
      return 'missing';
    }
    return isInside(root, r) ? r : 'outside';
  };
  const read = (file: string, maxBytes: number): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'problem'; problem: Problem } => {
    const at = real(file);
    if (at === 'missing') return { kind: 'missing' };
    const problem = (message: string, fix: string) => ({ kind: 'problem' as const, problem: { file, line: 1, column: 1, path: WHOLE_FILE, message, fix } });
    if (at === 'outside') return problem(`${file} resolves to a place outside the app folder`, 'replace the link with the file itself; nothing outside the app folder is read');
    try {
      const st = statSync(at);
      if (!st.isFile()) return problem(`${file} is not a file`, 'make it a file');
      if (st.size > maxBytes) return problem(`${file} is ${st.size} bytes, over the ${maxBytes} a file may have`, 'make it smaller');
      return { kind: 'ok', text: readFileSync(at, 'utf8') };
    } catch {
      return problem(`${file} cannot be read`, 'check it is a readable text file');
    }
  };
  return {
    read: (file) => read(file, MAX_FILE_BYTES),
    readData: (file, maxBytes) => read(file, maxBytes),
    parse(file, kind: KbKind, text) {
      const lines = new LineCounter();
      const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'error', lineCounter: lines, customTags: [] });
      for (const e of doc.errors) {
        const at = lines.linePos(e.pos[0]);
        problems.push({ file, line: at.line, column: at.col, path: WHOLE_FILE, message: e.message.split('\n')[0] ?? e.message, fix: 'correct the YAML at this position (the files are YAML 1.2)' });
      }
      if (doc.errors.length > 0) return undefined;
      documents.set(file, { doc, lines });
      let raw: unknown;
      try {
        raw = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
      } catch (e) {
        problems.push({ file, line: 1, column: 1, path: WHOLE_FILE, message: e instanceof Error ? e.message : String(e), fix: 'write the values out in full: these files need no aliases' });
        return undefined;
      }
      const schema = KB_KINDS[kind].schema as z.ZodType;
      const parsed = schema.safeParse(raw ?? {});
      if (parsed.success) return parsed.data;
      problems.push(...problemsOfIssues(parsed.error.issues, { file, doc, lines, value: raw ?? {}, schema: z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as JsonSchema }));
      return undefined;
    },
    list(dir) {
      const at = real(dir);
      if (at === 'missing') return 'missing';
      if (at === 'outside') return 'outside';
      try {
        if (!statSync(at).isDirectory()) return 'not-a-directory';
        return readdirSync(at, { withFileTypes: true }).map((e): KbEntry => {
          if (!e.isSymbolicLink()) return { name: e.name, dir: e.isDirectory() };
          try {
            const target = realpathSync(join(at, e.name));
            return { name: e.name, dir: isInside(root, target) && statSync(target).isDirectory() };
          } catch {
            return { name: e.name, dir: false };
          }
        });
      } catch {
        return 'not-a-directory';
      }
    },
    locate(file, path) {
      const d = documents.get(file);
      return d ? positionOf(d.doc, d.lines, path) : null;
    },
  };
}

/**
 * The knowledge base of the agent app's folder `dir` (its kb/ beside agent.yaml), with its retriever, or undefined where it
 * has no kb/ folder. Throws AgentBusinessError, `pnpm check`'s lines, where the folder does not read.
 */
export function readConverseKnowledge(dir: string): ConverseKnowledge | undefined {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    return undefined;
  }
  const problems: Problem[] = [];
  const io = kbFolderIo(root, problems);
  if (io.list(KB_FOLDER) === 'missing') return undefined;
  const kb = readKbFolder({ base: KB_FOLDER, folder: join(root, KB_FOLDER), defaultLocale: 'en', io, problems });
  if (kb === null || problems.length > 0) throw new AgentBusinessError(problems.length > 0 ? problems : [{ file: `${KB_FOLDER}/kb.yaml`, line: 1, column: 1, path: WHOLE_FILE, message: 'the knowledge base does not read', fix: 'run pnpm check, which says why' }]);
  const refused = agentKbProblems(kb, io.locate);
  if (refused.length > 0) throw new AgentBusinessError(refused);
  return { kb, retriever: defaultRetriever(kb).retriever };
}

/**
 * What an agent app's knowledge base may not hold, each where it is with its fix (`pnpm check` and defineConverseApp
 * refuse it): kb.yaml's `action` other than the runtime's lookup; answers from documents (`documents.summarize: on`),
 * not yet supported in agent mode; facts a passage depends on (`applies`) and a topic's account line, which need a
 * gated read of the caller's own records that agent mode does not make.
 */
export function agentKbProblems(kb: KnowledgeBase, locate: (file: string, path: (string | number)[]) => { line: number; column: number } | null = () => null): Problem[] {
  const out: Problem[] = [];
  const at = (file: string, path: (string | number)[], message: string, fix: string): void => {
    const where = locate(file, path) ?? { line: 1, column: 1 };
    out.push({ file, line: where.line, column: where.column, path: formatPath(path), message, fix });
  };
  const settings = `${KB_FOLDER}/kb.yaml`;
  if (kb.settings.action !== LOOK_UP) at(settings, ['action'], `an agent app's knowledge base is read through the runtime's own lookup, "${LOOK_UP}", and kb.yaml names "${kb.settings.action}"`, `write "action: ${LOOK_UP}"`);
  if (kb.settings.documents?.summarize === 'on') at(settings, ['documents', 'summarize'], 'answers from approved documents (documents.summarize: on) are not yet supported in agent mode', 'write "summarize: off" (or delete documents): in agent mode only approved passages answer');
  if (Object.keys(kb.settings.applies).length > 0) at(settings, ['applies'], 'passages that depend on facts of the caller (applies) are not yet supported in agent mode: the lookup reads no caller\'s records', 'delete applies, and give each topic one passage for every caller');
  for (const t of Object.values(kb.topics)) {
    if (t.accountLine !== undefined) at(`${KB_FOLDER}/topics.yaml`, [t.id, 'accountLine'], `topic "${t.id}" has an account line, which agent mode does not say: the lookup reads no caller's records`, 'delete accountLine');
  }
  return out;
}

/** The lookup as an action, for the gate, the audit and the trace: a lookup with one text param, recorded as agent.yaml's `knowledge.audit` says. */
export function lookUpSpec(b: AgentBusiness): ActionSpec {
  return {
    about: LOOK_UP_ABOUT,
    kind: 'lookup',
    params: { [QUESTION_PARAM]: { type: 'text', about: QUESTION_ABOUT, max: QUESTION_MAX } },
    audit: { [QUESTION_PARAM]: b.knowledge?.audit?.question ?? LOOK_UP_AUDIT_DEFAULT },
  } as ActionSpec;
}

/** What the lookup is, for the model: what it is for and what it returns, never words for a reply. */
export const LOOK_UP_ABOUT = 'Look up the business\'s approved answer to a question the caller asks (about the business, its work, its services or its policies) that the business information does not answer. It returns the approved answer, its topic and how it may be given, or that the business has no approved answer to the question.';

const QUESTION_ABOUT = 'The caller\'s question, in their own words.';

/** The passage that answers a topic for every caller today, fresh (approved, nothing changed under it since), or why there is none. */
function passageOf(kb: KnowledgeBase, topic: string, todayIso: string): { passage: KbPassage } | { why: string; passage?: KbPassage } {
  const r = resolvePassage(kb, { topic, facts: {}, todayIso, locale: kb.defaultLocale });
  if ('fresh' in r) return { passage: r.passage };
  return { why: r.unavailable, ...(r.passage !== undefined ? { passage: r.passage } : {}) };
}

/** Whether the knowledge base has a passage to return today: an approved one, fresh, in force, for every caller. */
export function hasApprovedAnswer(k: ConverseKnowledge | undefined, todayIso: string): boolean {
  if (k === undefined) return false;
  return Object.keys(k.kb.topics).some((topic) => !('why' in passageOf(k.kb, topic, todayIso)));
}

/**
 * Whether the turn offers the lookup: the app has a knowledge base with an approved answer today, and the call is at the
 * root (no journey active), or in a journey agent.yaml's `knowledge.journeys` names (every journey where it names none).
 */
export function lookUpOffered(b: AgentBusiness, k: ConverseKnowledge | undefined, journey: JourneyState | undefined, todayIso: string): boolean {
  if (!hasApprovedAnswer(k, todayIso)) return false;
  const only = b.knowledge?.journeys;
  if (only === undefined || journey === undefined || journey.active === null) return true;
  return only.includes(journey.active);
}

/** One lookup, as the trace records it: never the question's words beyond what agent.yaml's audit keeps. */
export interface LookUpRecord {
  /** The question as recorded (knowledge.audit; by its length by default). */
  question: string;
  /** The retriever's id and the topics it nominated, best first, with their scores. */
  retriever: string;
  candidates: { topic: string; score: number }[];
  /** The decision model's reading: the label it chose and its probability (null: none read); absent where nothing was nominated, so nothing was asked. */
  reading?: { choice: string | null; p: number | null; unread?: 'late' | 'error' };
  /** answered: a passage was returned. none: no topic read at the bar (or nothing nominated). withheld: the topic read has no passage that may be said (its reason). unread: the retriever or the decision model failed or was late. */
  outcome: 'answered' | 'none' | 'withheld' | 'unread';
  /** The topic read, with its title, where one was. */
  topic?: string;
  title?: string;
  /** The passage returned (its id and its approval's short hash), or the one withheld (with why). */
  passage?: { id: string; approvalHash?: string };
  withheld?: { why: string; id?: string };
  ms: number;
}

/** What the lookup returns: the result the model is sent, its record for the trace, and the audit rows beside its gate row. */
export interface LookUpResult {
  content: string;
  record: LookUpRecord;
  audit: AuditDraft[];
}

/** The decision model's question: which of the nominated topics the caller's question asks about (the topic slot's). */
export function lookUpQuestions(candidates: readonly Nomination[]): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const n of candidates) criteria[n.topic] = renderCriterion(DEFAULT_TOPIC_CRITERION, { title: n.title, topic: n.topic });
  criteria.unanswered = TOPIC_UNANSWERED;
  criteria.none = TOPIC_UNANSWERED_NONE;
  return { [LOOK_UP_QUESTION_ID]: { type: 'choice', instructions: TOPIC_UNANSWERED_INSTRUCTIONS, criteria } };
}

/** The topic the decision model read the question as asking about, at LOOK_UP_AT or above and among the candidates, or null; with the reading. */
export function readLookUp(answers: AnswerMap, candidates: readonly Nomination[]): { topic: string | null; choice: string | null; p: number | null } {
  const a = answers[LOOK_UP_QUESTION_ID];
  if (!isChoice(a) || typeof a.choice !== 'string') return { topic: null, choice: null, p: null };
  const probabilities = typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
  const raw = probabilities[a.choice] ?? a.confidence;
  const p = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const offered = candidates.some((n) => n.topic === a.choice);
  return { topic: offered && p !== null && p >= LOOK_UP_AT ? a.choice : null, choice: a.choice, p };
}

/**
 * The wording rule that rides on an answer, as context for the agent model: a `risk: low` topic's passage may be worded
 * for the caller's question; any other is given as written. An instruction to the model, never enforced.
 */
export const WORDING_LOW = 'This is the business\'s approved answer. You may put it in your own words to answer what the caller asked, saying nothing it does not say.';
export const WORDING_AS_WRITTEN = 'This is the business\'s approved answer, to be given as written: give it to the caller in these words.';

/** What the model is told where nothing approved answers the question. */
export const NOT_FOUND = 'The business has no approved answer to this question. Where the business information does not answer it either, the business has no answer to give on this call; the caller can still be offered what the line can do for them.';

/** What the model is told where the lookup could not be made (the retriever or the decision model failed, or was late). */
export const NOT_READ = 'The business\'s approved answers could not be looked up just now, so there is no approved answer to give from them for this question.';

/** A value or a promise's, or that it was late (`ms` passed first) or threw. */
async function settled<T>(p: Promise<T> | T, ms: number): Promise<{ value: T } | { failed: 'late' | 'error' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p).then((value) => ({ value }), () => ({ failed: 'error' as const })),
      new Promise<{ failed: 'late' }>((r) => (timer = setTimeout(() => r({ failed: 'late' }), Math.max(0, ms)))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The lookup of one question: the retriever's candidates (at most kb.yaml's cap), the decision model asked which of them
 * the question asks about (within `timeoutMs`), and that topic's passage where it is approved and fresh. `question` is
 * as the model wrote it; `recorded` how the trace records it.
 */
export async function lookUp(k: ConverseKnowledge, jev: JevClient, question: string, recorded: string, todayIso: string, timeoutMs: number): Promise<LookUpResult> {
  const t0 = Date.now();
  const kb = k.kb;
  const base = { question: recorded, retriever: k.retriever.id };
  const done = (record: Omit<LookUpRecord, 'question' | 'retriever' | 'ms'>, content: string, audit: AuditDraft[] = []): LookUpResult => ({ content, record: { ...base, ...record, ms: Date.now() - t0 }, audit });
  const nominated = await settled(k.retriever.nominate({ text: question, locale: kb.defaultLocale, todayIso }), timeoutMs);
  if ('failed' in nominated) return done({ candidates: [], outcome: 'unread' }, JSON.stringify({ answer: null, found: NOT_READ }));
  const seen = new Set<string>();
  const candidates: Nomination[] = [];
  for (const n of Array.isArray(nominated.value) ? nominated.value : []) {
    if (candidates.length >= kb.settings.retrieval.cap) break;
    if (n.topic === 'none' || n.topic === 'unanswered' || seen.has(n.topic) || !Object.hasOwn(kb.topics, n.topic)) continue;
    seen.add(n.topic);
    candidates.push(n);
  }
  const listed = candidates.map((n) => ({ topic: n.topic, score: Math.round(n.score * 1e4) / 1e4 }));
  if (candidates.length === 0) return done({ candidates: listed, outcome: 'none' }, JSON.stringify({ answer: null, found: NOT_FOUND }));
  const asked = await askWithinWhy(jev, { asr: { text: question } }, lookUpQuestions(candidates), timeoutMs);
  if (asked.answers === null) return done({ candidates: listed, reading: { choice: null, p: null, unread: asked.why }, outcome: 'unread' }, JSON.stringify({ answer: null, found: NOT_READ }));
  const read = readLookUp(asked.answers, candidates);
  const reading = { choice: read.choice, p: read.p };
  if (read.topic === null) return done({ candidates: listed, reading, outcome: 'none' }, JSON.stringify({ answer: null, found: NOT_FOUND }));
  const topic = kb.topics[read.topic]!;
  const found = passageOf(kb, read.topic, todayIso);
  const recordOf = (p: KbPassage, fresh: boolean): AuditDraft => {
    const doc = Object.hasOwn(kb.sources, p.source.document) ? kb.sources[p.source.document] : undefined;
    return kbAuditRow(kbSourceOf(p, { applies: {}, fresh, ...(doc ? { document: doc.document } : {}) }));
  };
  if ('why' in found) {
    return done(
      { candidates: listed, reading, outcome: 'withheld', topic: topic.id, title: topic.title, withheld: { why: found.why, ...(found.passage ? { id: found.passage.id } : {}) } },
      JSON.stringify({ answer: null, found: NOT_FOUND }),
      found.passage ? [recordOf(found.passage, false)] : [],
    );
  }
  const p = found.passage;
  return done(
    { candidates: listed, reading, outcome: 'answered', topic: topic.id, title: topic.title, passage: { id: p.id, ...(p.approval ? { approvalHash: shortHash(p.approval.hash) } : {}) } },
    JSON.stringify({ topic: topic.title, answer: p.answer, wording: topic.risk === 'low' ? WORDING_LOW : WORDING_AS_WRITTEN }),
    [recordOf(p, true)],
  );
}

export { LOOK_UP };

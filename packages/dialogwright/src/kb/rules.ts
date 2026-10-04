import { WHOLE_FILE, closest, formatPath, type DataPath, type Problem } from '../define/problems';
import { VAR } from '../prompts/segments';
import { inForceOn, answers } from './resolve';
import type { KbPassage, KnowledgeBase } from './types';
import { MODEL_COMMAND, STATIC_MODELS } from './embed/model';
import { INDEX_COMMAND, indexDrift, indexFileOf, sameEmbedder } from './vectorIndex';
import { APPROVALS_LOG, approvalLogged } from './log';

/**
 * The rules across a knowledge base's files, as problems in the loader's form
 * (`file:line:col  path  message  ->  fix`). Three sets, by what they need and when they run:
 *
 *  - content (kbContentProblems): what the knowledge base must be on its own. Every passage's topic
 *    and source (document and section) exist; its applies name facts and values of kb.yaml's
 *    domain; its answer is fixed text (no `{variable}`, no braces at all) within kb.yaml's
 *    maxAnswerChars; its effective range ends after it starts; a translation translates a
 *    default-locale passage of the same topic; no two passages of a topic and locale are in force
 *    for the same caller on the same day; kb.yaml's embedder, if any, is one the engine has. The loader runs these: a knowledge base that breaks one
 *    does not load, so defineApp refuses it as it does a bad YAML file.
 *  - links (kbLinkProblems): what it names in the app. kb.yaml's action is a tool with an action in
 *    policy.yaml; each account line's tool is too, and every variable the line uses is a field the
 *    tool declares (ToolDef.fields); every locale it has passages in is one the app speaks. defineApp
 *    runs these with the code (crossLink), `check` with the code or, without it, with policy.yaml.
 *  - state (kbStateProblems): what changes with time and review. Every passage is approved with
 *    both hashes matching what is there now, and its approval is in kb/approvals.jsonl (a line of
 *    its id and hash: approved through kb:approve, not by hand); every topic has a passage in force today, in the
 *    default locale, for every combination of the applies domain; and when kb.yaml names an
 *    embedder, its index (kb/.index/<embedder>.json) has a vector for every text of every topic
 *    (kbIndexProblems). Only `check` runs these (a stale
 *    passage fails `pnpm check`); at run time a passage that is not fresh is withheld (./resolve.ts).
 */

/** Where a data path is in a file that was read (the loader's locate); null when not known. */
export type Locate = (file: string, path: DataPath) => { line: number; column: number } | null;

/** The command that approves a passage, as the fixes name it. */
export const APPROVE_COMMAND = 'pnpm kb:approve';

/** The command that lists the passages by state, with what changed, as the fixes name it. */
export const STATUS_COMMAND = 'pnpm kb:status';

/** The approval of one passage, as a fix says to run it (./approval.ts). */
export function approveCommandFor(id: string): string {
  return `${APPROVE_COMMAND} ${id} --by "<your name>"`;
}

/** What an edit after approval may have changed, as a stale passage's problem and kb:status say it (./hash.ts approvalHashOf). */
export const EDITED_WHAT = 'its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line';

/** How many combinations of the applies domain a knowledge base may have: each needs a passage per topic. */
export const MAX_APPLIES_COMBINATIONS = 256;

function problemAt(problems: Problem[], locate: Locate, file: string, path: DataPath, message: string, fix: string): void {
  const at = locate(file, path) ?? { line: 1, column: 1 };
  problems.push({ file, line: at.line, column: at.column, path: path.length === 0 ? WHOLE_FILE : formatPath(path), message, fix });
}

const rename = (word: string, known: readonly string[]): string => {
  const near = closest(word, known);
  return near ? `rename it to "${near}", or ` : '';
};

/** The values of a fact a passage answers: its own, or every value of the domain when it does not name the fact. */
function valuesFor(kb: KnowledgeBase, p: KbPassage, fact: string): readonly string[] {
  return Object.hasOwn(p.applies, fact) ? p.applies[fact]! : kb.settings.applies[fact] ?? [];
}

/** Whether two passages answer some caller in common. */
function sameCallers(kb: KnowledgeBase, a: KbPassage, b: KbPassage): boolean {
  const facts = new Set([...Object.keys(kb.settings.applies), ...Object.keys(a.applies), ...Object.keys(b.applies)]);
  for (const fact of facts) {
    const theirs = new Set(valuesFor(kb, b, fact));
    if (!valuesFor(kb, a, fact).some((v) => theirs.has(v))) return false;
  }
  return true;
}

/** The days two passages are both in force, or null when none. */
function sharedDays(a: KbPassage, b: KbPassage): { from: string; to?: string } | null {
  const from = a.effective.from > b.effective.from ? a.effective.from : b.effective.from;
  const ends = [a.effective.to, b.effective.to].filter((d): d is string => d !== undefined).sort();
  const to = ends[0];
  if (to !== undefined && to < from) return null;
  return to === undefined ? { from } : { from, to };
}

/** "card adult" for one fact's values; "card adult or junior" for several. */
function describeCallers(applies: Readonly<Record<string, readonly string[]>>): string {
  const parts = Object.entries(applies).map(([fact, values]) => `${fact} ${values.join(' or ')}`);
  return parts.length === 0 ? 'every caller' : parts.join(', ');
}

/** The rules the knowledge base must meet on its own (the loader runs them). `base` is the kb folder's path from the app folder. */
export function kbContentProblems(kb: KnowledgeBase, locate: Locate, base = 'kb'): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string, path: DataPath, message: string, fix: string): void => problemAt(problems, locate, file, path, message, fix);
  const topicIds = Object.keys(kb.topics);
  const domain = kb.settings.applies;
  const settingsFile = `${base}/kb.yaml`;

  const combinations = Object.values(domain).reduce((n, values) => n * values.length, 1);
  if (combinations > MAX_APPLIES_COMBINATIONS) {
    at(settingsFile, ['applies'], `the applies domain has ${combinations} combinations, over the ${MAX_APPLIES_COMBINATIONS} a knowledge base may have: every topic needs a passage in force for each`, 'keep to the facts that change an answer, and to the values that do');
  }

  const embedder = kb.settings.retrieval.embedder;
  if (embedder !== undefined && !Object.hasOwn(STATIC_MODELS, embedder)) {
    const known = Object.keys(STATIC_MODELS);
    at(settingsFile, ['retrieval', 'embedder'], `kb.yaml names the embedder "${embedder}", which the engine does not have (it has ${known.join(', ')})`, `${rename(embedder, known)}leave it out, for keyword retrieval alone`);
  }

  for (const p of Object.values(kb.passages)) {
    const { file, id } = p;
    if (!Object.hasOwn(kb.topics, p.topic)) {
      at(file, ['topic'], `passage "${id}" answers the topic "${p.topic}", which ${base}/topics.yaml does not have`, `${rename(p.topic, topicIds)}add "${p.topic}:" with its title to ${base}/topics.yaml`);
    }
    const doc = Object.hasOwn(kb.sources, p.source.document) ? kb.sources[p.source.document] : undefined;
    if (!doc) {
      at(file, ['source', 'document'], `passage "${id}" cites the source document "${p.source.document}", which is not in ${base}/sources`, `${rename(p.source.document, Object.keys(kb.sources))}add ${base}/sources/${p.source.document}.yaml with the document's text by section`);
    } else if (!Object.hasOwn(doc.sections, p.source.section)) {
      at(file, ['source', 'section'], `passage "${id}" cites section "${p.source.section}" of "${p.source.document}", which ${base}/sources/${p.source.document}.yaml does not have`, `${rename(p.source.section, Object.keys(doc.sections))}add the section, with its text, to ${base}/sources/${p.source.document}.yaml`);
    }
    for (const [fact, values] of Object.entries(p.applies)) {
      if (!Object.hasOwn(domain, fact)) {
        at(file, ['applies', fact], `passage "${id}" applies by "${fact}", which is not a fact of kb.yaml's applies`, `${rename(fact, Object.keys(domain))}add "${fact}: [<its values>]" to applies in ${settingsFile}`);
        continue;
      }
      for (const value of values) {
        if (!domain[fact]!.includes(value)) at(file, ['applies', fact], `passage "${id}" applies to ${fact} "${value}", which kb.yaml's applies does not list for ${fact}`, `${rename(value, domain[fact]!)}add "${value}" to ${fact} in ${settingsFile}`);
      }
    }
    const variables = [...p.answer.matchAll(VAR)].map((m) => `{${m[1]}}`);
    if (variables.length > 0 || /[{}]/.test(p.answer)) {
      at(file, ['answer'], `passage "${id}"'s answer has ${variables.length > 0 ? `the variable${variables.length === 1 ? '' : 's'} ${[...new Set(variables)].join(', ')}` : 'a brace'}; an answer is fixed text, said word for word`, `write the answer without braces; a line from the caller's own data goes in the topic's accountLine in ${base}/topics.yaml`);
    }
    if (p.answer.length > kb.settings.maxAnswerChars) {
      at(file, ['answer'], `passage "${id}"'s answer is ${p.answer.length} characters, over the ${kb.settings.maxAnswerChars} kb.yaml allows (maxAnswerChars)`, 'shorten it to what is said in one breath: split the topic in two, or say where the rest is written');
    }
    if (p.effective.to !== undefined && p.effective.to < p.effective.from) {
      at(file, ['effective', 'to'], `passage "${id}" stops being in force (${p.effective.to}) before it starts (${p.effective.from})`, 'correct the dates: effective.to is the last day it is in force, on or after effective.from');
    }
    if (p.translates !== undefined) {
      const original = Object.hasOwn(kb.passages, p.translates) ? kb.passages[p.translates] : undefined;
      if (p.locale.toLowerCase() === kb.defaultLocale.toLowerCase()) {
        at(file, ['translates'], `passage "${id}" is in the default locale (${kb.defaultLocale}), so it translates nothing`, `delete the translates line, or move the passage to ${base}/locale/<tag>/passages`);
      } else if (!original) {
        at(file, ['translates'], `passage "${id}" translates "${p.translates}", which is not a passage`, `${rename(p.translates, Object.keys(kb.passages))}name the passage in ${base}/passages it translates`);
      } else if (original.locale.toLowerCase() !== kb.defaultLocale.toLowerCase()) {
        at(file, ['translates'], `passage "${id}" translates "${p.translates}", which is itself in another locale (${original.locale})`, `name the passage in ${base}/passages it translates`);
      } else if (original.topic !== p.topic) {
        at(file, ['translates'], `passage "${id}" translates "${p.translates}", whose topic is "${original.topic}", not "${p.topic}"`, `make the two topics the same, or name the passage of "${p.topic}" it translates`);
      }
    }
  }

  // No two passages of a topic and locale answer the same caller on the same day.
  const passages = Object.values(kb.passages);
  for (let j = 0; j < passages.length; j++) {
    const b = passages[j]!;
    for (let i = 0; i < j; i++) {
      const a = passages[i]!;
      if (a.topic !== b.topic || a.locale.toLowerCase() !== b.locale.toLowerCase() || !sameCallers(kb, a, b)) continue;
      const days = sharedDays(a, b);
      if (!days) continue;
      const when = days.to === undefined ? `from ${days.from} on` : days.from === days.to ? `on ${days.from}` : `from ${days.from} to ${days.to}`;
      at(
        b.file,
        ['effective'],
        `passages "${a.id}" and "${b.id}" are both in force ${when} for the topic "${b.topic}" (${b.locale}), for callers they share, so which to say is ambiguous`,
        `end "${a.id}" the day before "${b.id}" starts (effective.to), or give the two different applies`,
      );
    }
  }
  return problems;
}

/** What the knowledge base's links are checked against: each part left out is not checked. */
export interface KbLinkInput {
  /** The actions policy.yaml has, by tool name. */
  actions?: ReadonlySet<string>;
  /** The app's tools, each with the fields it declares (ToolDef.fields). */
  tools?: Readonly<Record<string, readonly string[]>>;
  /** The locales the app speaks (its default among them). */
  locales?: readonly string[];
  /** policy.yaml's name, as the fixes say it. Default "policy.yaml". */
  policyFile?: string;
  /** Where a tool is written in the code, as the fixes say it (`app.ts (code.tools.x)`). */
  inCode?: (...segs: readonly string[]) => string;
}

/** The rules over what the knowledge base names in the app: its tools, their actions and fields, and the app's locales. */
export function kbLinkProblems(kb: KnowledgeBase, input: KbLinkInput, locate: Locate, base = 'kb'): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string, path: DataPath, message: string, fix: string): void => problemAt(problems, locate, file, path, message, fix);
  const policyFile = input.policyFile ?? 'policy.yaml';
  const inCode = input.inCode ?? ((...segs: readonly string[]) => `the code (${['code', ...segs].join('.')})`);
  const toolNames = input.tools ? Object.keys(input.tools) : [];
  const actionNames = input.actions ? [...input.actions] : [];

  /** A tool the knowledge base reads through: a tool of the code, with an action in policy.yaml. */
  const gated = (file: string, path: DataPath, what: string, tool: string): void => {
    if (input.tools && !Object.hasOwn(input.tools, tool)) {
      at(file, path, `${what} "${tool}", which is not a tool in the code`, `${rename(tool, toolNames)}add the tool to ${inCode('tools', tool)}`);
    }
    if (input.actions && !input.actions.has(tool)) {
      at(file, path, `${what} "${tool}", which has no action in ${policyFile}: every read the knowledge base makes goes through the gate`, `${rename(tool, actionNames)}add "${tool}:" under actions in ${policyFile}, with its level and rules`);
    }
  };

  gated(`${base}/kb.yaml`, ['action'], 'kb.yaml resolves passages through the tool', kb.settings.action);
  for (const topic of Object.values(kb.topics)) {
    const line = topic.accountLine;
    if (!line) continue;
    const file = `${base}/topics.yaml`;
    gated(file, [topic.id, 'accountLine', 'from'], `topic "${topic.id}"'s account line reads through the tool`, line.from);
    const fields = input.tools && Object.hasOwn(input.tools, line.from) ? input.tools[line.from]! : null;
    if (!fields) continue;
    const texts: { file: string; path: DataPath; text: string; where: string }[] = [
      { file, path: [topic.id, 'accountLine', 'text'], text: line.text, where: '' },
      ...Object.entries(topic.locales).filter(([, w]) => w.accountLineText !== undefined).map(([tag, w]) => ({ file: `${base}/locale/${tag}/topics.yaml`, path: [topic.id, 'accountLine', 'text'], text: w.accountLineText!, where: ` (${tag})` })),
    ];
    for (const t of texts) {
      const unknown = [...new Set([...t.text.matchAll(VAR)].map((m) => m[1]!))].filter((name) => !fields.includes(name));
      for (const name of unknown) {
        at(t.file, t.path, `topic "${topic.id}"'s account line${t.where} uses {${name}}, which the tool "${line.from}" does not declare among its fields`, `${rename(name, fields)}add "${name}" to ${inCode('tools', line.from, 'fields')} (a field of its result, which policy.yaml may redact), or take it out of the line`);
      }
    }
  }
  if (input.locales) {
    const spoken = new Set(input.locales.map((l) => l.toLowerCase()));
    const reported = new Set<string>();
    for (const p of Object.values(kb.passages)) {
      const tag = p.locale.toLowerCase();
      if (spoken.has(tag) || reported.has(tag)) continue;
      reported.add(tag);
      at(`${base}/locale/${p.locale}`, [], `the knowledge base has ${p.locale} passages, but the app does not speak ${p.locale}`, `add locale/${p.locale}/prompts.yaml to the app, or delete ${base}/locale/${p.locale}`);
    }
  }
  return problems;
}

/** Every combination of the applies domain, as a passage's applies would name it (one value per fact). */
export function appliesCombinations(domain: Readonly<Record<string, readonly string[]>>): Record<string, string>[] {
  return Object.entries(domain).reduce<Record<string, string>[]>((combos, [fact, values]) => combos.flatMap((c) => values.map((v) => ({ ...c, [fact]: v }))), [{}]);
}

/** The rules that change with time and review (only `check` runs them): approvals, and a passage in force today for every caller. */
export function kbStateProblems(kb: KnowledgeBase, todayIso: string, locate: Locate, base = 'kb'): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string, path: DataPath, message: string, fix: string): void => problemAt(problems, locate, file, path, message, fix);
  for (const p of Object.values(kb.passages)) {
    const approve = approveCommandFor(p.id);
    if (p.freshness === 'unapproved') {
      at(p.file, ['answer'], `passage "${p.id}" is not approved, so it is never said`, `review it against its source (${STATUS_COMMAND} lists what waits), then ${approve}`);
    } else if (p.freshness === 'source-changed') {
      at(p.file, ['approval', 'sourceHash'], `passage "${p.id}" is stale: its source changed since approval (${base}/sources/${p.source.document}.yaml, section "${p.source.section}"), so it is withheld`, `review the answer against the source's text now (${STATUS_COMMAND} shows what changed), then ${approve}`);
    } else if (p.freshness === 'edited') {
      at(p.file, ['approval', 'hash'], `passage "${p.id}" was edited after approval (${EDITED_WHAT}), so it is withheld`, `review the edit (${STATUS_COMMAND} shows what changed), then ${approve}`);
    }
    // An approval is a person's, recorded by kb:approve with a line in the log: one with no line of
    // its id and hash was written by hand or copied with its file, and no one is on record for it.
    if (approvalLogged(kb, p) === false) {
      at(p.file, ['approval'], `passage "${p.id}" was approved outside kb:approve: its approval (by ${p.approval!.approvedBy} on ${p.approval!.on}) has no line of its id and hash in ${base}/${APPROVALS_LOG}, so no one is on record for it`, `review it against its source, then ${approve} (approvals are written by kb:approve, never by hand)`);
    }
  }
  const log = kb.approvalLog;
  if (log !== undefined && 'invalid' in log) at(log.file, [], `${log.file} cannot be read: ${log.invalid}`, `restore it from version control: it is appended to by ${APPROVE_COMMAND}, never rewritten`);
  problems.push(...kbIndexProblems(kb, locate, base));
  const combos = appliesCombinations(kb.settings.applies);
  for (const topic of Object.values(kb.topics)) {
    for (const facts of combos) {
      const covered = Object.values(kb.passages).some((p) => p.topic === topic.id && p.locale.toLowerCase() === kb.defaultLocale.toLowerCase() && answers(p, facts) && inForceOn(p, todayIso));
      if (covered) continue;
      const who = Object.keys(facts).length === 0 ? '' : ` for ${describeCallers(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, [v]])))}`;
      const applies = Object.keys(facts).length === 0 ? '' : `, applies: { ${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
      at(
        `${base}/topics.yaml`,
        [topic.id],
        `topic "${topic.id}" has no passage in force on ${todayIso}${who} (${kb.defaultLocale})`,
        `add a passage to ${base}/passages (topic: ${topic.id}${applies}, in force on ${todayIso}), then review and approve it`,
      );
    }
  }
  return problems;
}

/** How many of a topic's missing or stale index entries a problem lists by name before it counts the rest. */
const LISTED = 3;

/**
 * The vector index of the embedder kb.yaml names (kb/.index/<id>.json): that it is there, is an
 * index, was written by the pinned model, and has a vector for every text of every topic and none
 * for a text no topic has any more (../kb/vectorIndex.ts indexDrift). One problem per topic that
 * differs. The weights need not be in the cache: the check reads only the hashes.
 */
export function kbIndexProblems(kb: KnowledgeBase, locate: Locate, base = 'kb'): Problem[] {
  const problems: Problem[] = [];
  const id = kb.settings.retrieval.embedder;
  if (id === undefined || !Object.hasOwn(STATIC_MODELS, id)) return problems;
  const model = STATIC_MODELS[id]!;
  const file = indexFileOf(base, id);
  const at = (path: DataPath, where: string, message: string): void => problemAt(problems, locate, where, path, message, `run ${INDEX_COMMAND} (it reads the model from the cache; ${MODEL_COMMAND} downloads it), and commit ${file}`);
  const index = kb.index;
  if (!index || 'missing' in index) {
    at([], file, `${file} is missing: kb.yaml names the embedder ${id}, whose vectors of the topics' texts retrieval reads from there`);
    return problems;
  }
  if ('invalid' in index) {
    at([], file, `${file} is not a vector index: ${index.invalid}`);
    return problems;
  }
  const pinned = { id: model.id, revision: model.revision, sha256: model.sha256, dim: model.dim };
  if (!sameEmbedder(index.data.embedder, pinned)) {
    at([], file, `${file} was written by ${index.data.embedder.id} at ${index.data.embedder.revision.slice(0, 12)} (${index.data.embedder.sha256.slice(0, 12)}), not the pinned ${model.id} at ${model.revision.slice(0, 12)} (${model.sha256.slice(0, 12)})`);
    return problems;
  }
  const { missing, stale } = indexDrift(kb, index.data);
  const byTopic = new Map<string, { missing: string[]; stale: string[] }>();
  const of = (topic: string) => byTopic.get(topic) ?? (byTopic.set(topic, { missing: [], stale: [] }).get(topic)!);
  for (const t of missing) of(t.topic).missing.push(`${t.field} "${t.text}" (${t.locale})`);
  for (const e of stale) of(e.topic).stale.push(`${e.field} ${e.contentHash.slice(0, 12)} (${e.locale})`);
  const list = (items: string[]): string => `${items.slice(0, LISTED).join(', ')}${items.length > LISTED ? ` and ${items.length - LISTED} more` : ''}`;
  for (const [topic, d] of [...byTopic.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const parts = [
      ...(d.missing.length > 0 ? [`no vector for ${list(d.missing)}`] : []),
      ...(d.stale.length > 0 ? [`a vector for text it no longer has: ${list(d.stale)}`] : []),
    ];
    const path: DataPath = Object.hasOwn(kb.topics, topic) ? [topic] : [];
    at(path, Object.hasOwn(kb.topics, topic) ? `${base}/topics.yaml` : file, `the index ${file} is stale for the topic "${topic}": ${parts.join('; ')}`);
  }
  return problems;
}

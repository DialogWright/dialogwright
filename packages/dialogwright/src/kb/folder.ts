import { WHOLE_FILE, closest, formatPath, type DataPath, type Problem } from '../define/problems';
import { approvalHashOf, canonicalApplies, collapseWhitespace, sourceHashOf } from './hash';
import type { KbKind, KbLocaleTopicsYaml, KbPassageYaml, KbSettingsYaml, KbSourceYaml, KbTopicsYaml } from './schema';
import type { KbFreshness, KbPassage, KbSourceDocument, KbTopic, KbTopicWording, KnowledgeBase } from './types';
import { STATIC_MODELS } from './embed/model';
import { indexFileOf, indexHashOf, MAX_INDEX_BYTES, parseIndex, type KbIndexRead } from './vectorIndex';

/**
 * Reads an app's `kb/` folder into a KnowledgeBase (./types.ts). The files and what each holds are
 * in ./schema.ts. The reading itself (a file inside the app folder and no link out of it, the size
 * limit, UTF-8, YAML 1.2 with no tags, duplicate keys refused, aliases capped, each file against its
 * schema) is the app folder loader's (define/load.ts), handed in as `io`, so the knowledge base is
 * read exactly as safely as the rest of the folder and its problems have the same form.
 *
 * What this adds is the folder's layout: kb.yaml and topics.yaml are required; passages/ and
 * sources/ hold one .yaml file each, named by its id; locale/<tag>/ holds a locale's topics.yaml and
 * passages/; pending/ holds drafts, which are never read (only their names, so a draft cannot take
 * an approved passage's id); hidden entries (.index/, .DS_Store) are skipped. Anything else is a
 * problem. Every file read is hashed into the app's configuration hashes by `io.parse`.
 *
 * The rules across files (references, a passage for every caller, overlaps, approvals) are ./rules.ts's; the loader runs
 * the ones that need only the knowledge base itself right after reading it.
 */

/** A directory entry, as `io.list` gives it. */
export interface KbEntry {
  name: string;
  dir: boolean;
}

/** How the knowledge base's files are read: the app folder loader's own reading and parsing. */
export interface KbFolderIo {
  /** Reads a file (a path from the app folder): its text, that it is not there, or why it cannot be read. */
  read(file: string): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'problem'; problem: Problem };
  /** Parses a file's text and checks it against its kind's schema: the data, or undefined after adding its problems (it is hashed when valid). */
  parse(file: string, kind: KbKind, text: string): unknown;
  /** The entries of a directory (a path from the app folder), or that it is missing, a file, or a link out of the app folder. Links inside count as what they point at. */
  list(dir: string): KbEntry[] | 'missing' | 'not-a-directory' | 'outside';
  /** Where a data path is in a file that was read. */
  locate(file: string, path: DataPath): { line: number; column: number } | null;
  /**
   * Reads a file that is data, not configuration (the vector index), with its own size limit: not
   * parsed as YAML, not hashed into the configuration. Without it, no index is read.
   */
  readData?(file: string, maxBytes: number): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'problem'; problem: Problem };
}

/** How many entries one folder of the knowledge base may have: reading is bounded. */
export const MAX_KB_ENTRIES = 5000;

/** A language tag as a locale directory names it (as define/load.ts reads one). */
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The entries the kb/ folder itself may have (hidden ones aside). */
const KB_ENTRIES: Readonly<Record<string, 'file' | 'dir'>> = {
  'kb.yaml': 'file',
  'topics.yaml': 'file',
  passages: 'dir',
  sources: 'dir',
  locale: 'dir',
  pending: 'dir',
};

export interface ReadKbInput {
  /** The kb folder's path from the app folder, as problems name it ("kb"). */
  base: string;
  /** The app's default locale: kb/passages' and kb/topics.yaml's. */
  defaultLocale: string;
  io: KbFolderIo;
  problems: Problem[];
}

/** Reads the kb folder. Returns null when kb.yaml or topics.yaml did not load; every problem goes to `problems`. */
export function readKbFolder({ base, defaultLocale, io, problems }: ReadKbInput): KnowledgeBase | null {
  const at = (file: string, path: DataPath, message: string, fix: string): void => {
    const where = path.length === 0 ? null : io.locate(file, path);
    problems.push({ file, line: where?.line ?? 1, column: where?.column ?? 1, path: path.length === 0 ? WHOLE_FILE : formatPath(path), message, fix });
  };
  const whole = (file: string, message: string, fix: string): void => at(file, [], message, fix);

  const top = io.list(base);
  if (top === 'not-a-directory') {
    whole(base, `${base} is a file; the knowledge base is a folder (${base}/kb.yaml, ${base}/topics.yaml, ${base}/passages/, ...)`, `delete the file, or make ${base} a folder`);
    return null;
  }
  if (top === 'missing') return null;
  if (top === 'outside') {
    whole(base, `${base} resolves to a place outside the app folder`, `replace the link with the folder itself; nothing outside the app folder is read`);
    return null;
  }
  for (const entry of visible(top)) {
    const want = KB_ENTRIES[entry.name];
    const path = `${base}/${entry.name}`;
    if (want === undefined) {
      if (entry.dir) whole(path, `${path} is not a folder the knowledge base has; its folders are passages, sources, locale and pending`, `${hint(entry.name, ['passages', 'sources', 'locale', 'pending'])}delete it, or move it out of ${base}`);
      else if (/\.ya?ml$/.test(entry.name)) whole(path, `${path} is not a file the knowledge base reads; its files are kb.yaml and topics.yaml, and a folder for each kind of file`, `${hint(entry.name.replace(/\.yml$/, '.yaml'), ['kb.yaml', 'topics.yaml'])}delete it, or move it out of ${base}`);
      continue;
    }
    // A link out of the app folder is reported where its folder is read.
    if ((want === 'dir') !== entry.dir && !(want === 'dir' && io.list(path) === 'outside')) whole(path, `${path} is a ${entry.dir ? 'folder' : 'file'}, where the knowledge base has its ${want === 'dir' ? 'folder' : 'file'}`, want === 'dir' ? `make ${path} a folder of .yaml files` : `make ${path} a file`);
  }

  const settings = readOne<KbSettingsYaml>(`${base}/kb.yaml`, 'kbSettings', io, problems, true);
  const topicsYaml = readOne<KbTopicsYaml>(`${base}/topics.yaml`, 'kbTopics', io, problems, true);

  // The source documents.
  const sources: Record<string, KbSourceDocument> = {};
  for (const { id, file } of yamlFiles(`${base}/sources`, 'source document', io, problems)) {
    const doc = readOne<KbSourceYaml>(file, 'kbSource', io, problems, false);
    if (doc) sources[id] = { id, document: doc.document, ...(doc.provenance ? { provenance: doc.provenance } : {}), sections: doc.sections };
  }

  // The passages: the default locale's, then each other locale's.
  const passages: { yaml: KbPassageYaml; locale: string; file: string }[] = [];
  const seen = new Map<string, string>();
  const readPassages = (dir: string, locale: string, folderLocale: string | null): void => {
    for (const { id, file } of yamlFiles(dir, 'passage', io, problems)) {
      const yaml = readOne<KbPassageYaml>(file, 'kbPassage', io, problems, false);
      if (!yaml) continue;
      if (yaml.id !== id) {
        at(file, ['id'], `${file} has the id "${yaml.id}"; a passage's id is its file name`, `write "id: ${id}", or rename the file to ${yaml.id}.yaml`);
        continue;
      }
      const other = seen.get(id);
      if (other !== undefined) {
        at(file, ['id'], `the passage id "${id}" is used twice: here and in ${other}`, `give one of the two another id (and its file the same name), for example "${id}-${locale.toLowerCase()}"`);
        continue;
      }
      seen.set(id, file);
      if (yaml.locale !== undefined && yaml.locale.toLowerCase() !== locale.toLowerCase()) {
        at(
          file,
          ['locale'],
          folderLocale === null
            ? `passage "${id}" says its locale is ${yaml.locale}, but ${dir} holds the default locale's passages (${locale})`
            : `passage "${id}" says its locale is ${yaml.locale}, but it is in ${dir}, the ${locale} passages`,
          folderLocale === null || yaml.locale.toLowerCase() !== defaultLocale.toLowerCase()
            ? `move it to ${base}/locale/${yaml.locale}/passages/${id}.yaml, or delete the locale line`
            : `move it to ${base}/passages/${id}.yaml, or delete the locale line`,
        );
        continue;
      }
      passages.push({ yaml, locale, file });
    }
  };
  readPassages(`${base}/passages`, defaultLocale, null);

  // The other locales: their topics' wording and their passages.
  const wording: Record<string, KbLocaleTopicsYaml> = {};
  const locales = io.list(`${base}/locale`);
  if (locales === 'outside') whole(`${base}/locale`, `${base}/locale resolves to a place outside the app folder`, 'replace the link with the folder itself; nothing outside the app folder is read');
  if (Array.isArray(locales)) {
    const lower = new Map<string, string>();
    for (const entry of visible(locales)) {
      const dir = `${base}/locale/${entry.name}`;
      if (!entry.dir) {
        whole(dir, `${dir} is a file; ${base}/locale holds one folder per locale, each with its topics.yaml and passages/`, `move it into a folder named for its language tag, for example ${base}/locale/es/`);
        continue;
      }
      const twin = lower.get(entry.name.toLowerCase());
      if (twin !== undefined) {
        whole(dir, `${dir} and ${base}/locale/${twin} are the same locale: a language tag's letter case does not make it another`, 'merge the two into one folder, with the tag written the usual way (language lowercase, region uppercase, as in pt-BR)');
        continue;
      }
      lower.set(entry.name.toLowerCase(), entry.name);
      if (!LOCALE_TAG.test(entry.name)) {
        whole(dir, `${dir} is not a language tag like "es" or "pt-BR"`, `rename the folder to the locale's language tag (for example ${base}/locale/es)`);
        continue;
      }
      if (entry.name.toLowerCase() === defaultLocale.toLowerCase()) {
        whole(dir, `${dir} is the app's default locale (${defaultLocale}), whose topics and passages are ${base}/topics.yaml and ${base}/passages`, `move its passages into ${base}/passages and its wording into ${base}/topics.yaml, and delete ${dir}`);
        continue;
      }
      for (const inner of visible(listOrEmpty(io, dir))) {
        if (inner.name === 'topics.yaml' && !inner.dir) continue;
        if (inner.name === 'passages' && inner.dir) continue;
        whole(`${dir}/${inner.name}`, `${dir}/${inner.name} is not part of a locale; a locale's folder has topics.yaml and passages/`, `delete it, or move it out of ${base}`);
      }
      const topicsFile = `${dir}/topics.yaml`;
      const read = io.read(topicsFile);
      if (read.kind === 'problem') problems.push(read.problem);
      if (read.kind === 'ok') {
        const parsed = io.parse(topicsFile, 'kbLocaleTopics', read.text) as KbLocaleTopicsYaml | undefined;
        if (parsed) wording[entry.name] = parsed;
      }
      readPassages(`${dir}/passages`, entry.name, entry.name);
    }
  }

  // Drafts are never read; one named like a passage would take its place when it is approved.
  const pending = io.list(`${base}/pending`);
  if (Array.isArray(pending)) {
    for (const entry of visible(pending)) {
      const id = entry.name.replace(/\.ya?ml$/, '');
      const approved = seen.get(id);
      if (!entry.dir && id !== entry.name && approved !== undefined) {
        whole(`${base}/pending/${entry.name}`, `the draft ${base}/pending/${entry.name} has the id of the passage in ${approved}`, `rename the draft (and its id) to a new id, or delete it: approving it would replace the passage`);
      }
    }
  }

  if (!settings || !topicsYaml) return null;

  const topics: Record<string, KbTopic> = {};
  for (const [id, t] of Object.entries(topicsYaml)) {
    const locales: Record<string, KbTopicWording> = {};
    for (const [tag, byTopic] of Object.entries(wording)) {
      const w = Object.hasOwn(byTopic, id) ? byTopic[id] : undefined;
      if (!w) continue;
      locales[tag] = { ...(w.title !== undefined ? { title: w.title } : {}), keywords: w.keywords ?? [], asks: w.asks ?? [], ...(w.accountLine ? { accountLineText: w.accountLine.text } : {}) };
    }
    topics[id] = { id, title: t.title, keywords: t.keywords ?? [], asks: t.asks ?? [], risk: t.risk, ...(t.accountLine ? { accountLine: { text: t.accountLine.text, from: t.accountLine.from } } : {}), locales };
  }
  // A locale's wording names only topics there are, and gives an account line only where the topic has one.
  for (const [tag, byTopic] of Object.entries(wording)) {
    const file = `${base}/locale/${tag}/topics.yaml`;
    for (const [id, w] of Object.entries(byTopic)) {
      if (!Object.hasOwn(topics, id)) {
        at(file, [id], `the ${tag} wording is for the topic "${id}", which ${base}/topics.yaml does not have`, `${hint(id, Object.keys(topics))}delete it, or add "${id}:" to ${base}/topics.yaml`);
      } else if (w.accountLine && !topics[id]!.accountLine) {
        at(file, [id, 'accountLine'], `the ${tag} wording gives the topic "${id}" an account line, but ${base}/topics.yaml gives it none (the line's tool is named there)`, `add "accountLine: { text, from }" to "${id}" in ${base}/topics.yaml, or delete this one`);
      }
    }
  }

  const built: Record<string, KbPassage> = {};
  for (const { yaml, locale, file } of [...passages].sort((a, b) => (a.yaml.id < b.yaml.id ? -1 : a.yaml.id > b.yaml.id ? 1 : 0))) {
    built[yaml.id] = passageOf(yaml, locale, file, topics, sources, defaultLocale);
  }
  const sortedSources = Object.fromEntries(Object.keys(sources).sort().map((id) => [id, sources[id]!]));
  const index = readIndex(base, settings.retrieval.embedder, io);
  return {
    settings: { action: settings.action, applies: settings.applies, localeFallback: settings.localeFallback, maxAnswerChars: settings.maxAnswerChars, retrieval: settings.retrieval },
    defaultLocale,
    topics,
    passages: built,
    sources: sortedSources,
    ...(index ? { index } : {}),
  };
}

/**
 * The vector index of the embedder kb.yaml names (kb/.index/<id>.json, ./vectorIndex.ts), read when
 * the embedder is one the engine has (an unknown one is a content problem, ./rules.ts) and the io
 * reads data. Its problems are not the loader's: `check` reports a missing or broken index
 * (./rules.ts kbStateProblems), and the default retriever does without one.
 */
function readIndex(base: string, embedder: string | undefined, io: KbFolderIo): KbIndexRead | undefined {
  if (embedder === undefined || !Object.hasOwn(STATIC_MODELS, embedder) || !io.readData) return undefined;
  const file = indexFileOf(base, embedder);
  const read = io.readData(file, MAX_INDEX_BYTES);
  if (read.kind === 'missing') return { file, missing: true };
  if (read.kind === 'problem') return { file, invalid: read.problem.message };
  const data = parseIndex(read.text);
  return typeof data === 'string' ? { file, invalid: data } : { file, hash: indexHashOf(read.text), data };
}

/** The text of a passage's source section, or null when the document or section is not there. */
export function sourceTextOf(sources: Readonly<Record<string, KbSourceDocument>>, source: { document: string; section: string }): string | null {
  const doc = Object.hasOwn(sources, source.document) ? sources[source.document] : undefined;
  if (!doc || !Object.hasOwn(doc.sections, source.section)) return null;
  return doc.sections[source.section]!.text;
}

/** The text of a topic's account line in a locale: the locale's own, else the default's; null when the topic has none. */
export function accountLineTextOf(topic: KbTopic | undefined, locale: string, defaultLocale: string): string | null {
  if (!topic?.accountLine) return null;
  if (locale.toLowerCase() !== defaultLocale.toLowerCase()) {
    const own = Object.entries(topic.locales).find(([tag]) => tag.toLowerCase() === locale.toLowerCase())?.[1]?.accountLineText;
    if (own !== undefined) return own;
  }
  return topic.accountLine.text;
}

/** A passage as loaded: applies made canonical, the answer's whitespace collapsed, and its hashes and freshness taken. */
function passageOf(yaml: KbPassageYaml, locale: string, file: string, topics: Readonly<Record<string, KbTopic>>, sources: Readonly<Record<string, KbSourceDocument>>, defaultLocale: string): KbPassage {
  const sourceText = sourceTextOf(sources, yaml.source);
  const topic = Object.hasOwn(topics, yaml.topic) ? topics[yaml.topic] : undefined;
  const effective = yaml.effective.to === undefined ? { from: yaml.effective.from } : { from: yaml.effective.from, to: yaml.effective.to };
  const current = {
    sourceHash: sourceText === null ? null : sourceHashOf(sourceText),
    hash: approvalHashOf({ topic: yaml.topic, answer: yaml.answer, applies: yaml.applies, effective, sourceText: sourceText ?? '', accountLineText: accountLineTextOf(topic, locale, defaultLocale) }),
  };
  const approval = yaml.approval;
  const freshness: KbFreshness = !approval ? 'unapproved' : current.sourceHash !== approval.sourceHash ? 'source-changed' : current.hash !== approval.hash ? 'edited' : 'fresh';
  return {
    id: yaml.id,
    topic: yaml.topic,
    version: yaml.version,
    locale,
    applies: canonicalApplies(yaml.applies),
    effective,
    source: { document: yaml.source.document, section: yaml.source.section },
    answer: collapseWhitespace(yaml.answer),
    ...(approval ? { approval: { owner: approval.owner, approvedBy: approval.approvedBy, on: approval.on, sourceHash: approval.sourceHash, hash: approval.hash } } : {}),
    ...(yaml.translates !== undefined ? { translates: yaml.translates } : {}),
    file,
    current,
    freshness,
  };
}

/** Reads and parses one file; a missing one is a problem when it is required. */
function readOne<T>(file: string, kind: KbKind, io: KbFolderIo, problems: Problem[], required: boolean): T | undefined {
  const read = io.read(file);
  if (read.kind === 'missing') {
    if (required) {
      const what = kind === 'kbSettings' ? 'it names the gated action that resolves a passage, for example "action: findPassage"' : 'it lists the topics, for example "opening_hours: { title: Opening hours }"';
      problems.push({ file, line: 1, column: 1, path: WHOLE_FILE, message: `${file} is missing`, fix: `create ${file}; ${what}` });
    }
    return undefined;
  }
  if (read.kind === 'problem') {
    problems.push(read.problem);
    return undefined;
  }
  return io.parse(file, kind, read.text) as T | undefined;
}

/** The .yaml files of a folder, each with its id (the name without .yaml); anything else there is a problem. */
function yamlFiles(dir: string, what: string, io: KbFolderIo, problems: Problem[]): { id: string; file: string }[] {
  const entries = io.list(dir);
  if (entries === 'outside') {
    problems.push({ file: dir, line: 1, column: 1, path: WHOLE_FILE, message: `${dir} resolves to a place outside the app folder`, fix: 'replace the link with the folder itself; nothing outside the app folder is read' });
    return [];
  }
  if (!Array.isArray(entries)) {
    // A file where the folder belongs is reported with its parent's entries.
    return [];
  }
  const shown = visible(entries);
  const whole = (file: string, message: string, fix: string): void => {
    problems.push({ file, line: 1, column: 1, path: WHOLE_FILE, message, fix });
  };
  if (shown.length > MAX_KB_ENTRIES) {
    whole(dir, `${dir} has ${shown.length} entries, over the ${MAX_KB_ENTRIES} a folder of the knowledge base may have`, 'split the knowledge base into fewer, longer source documents, or retire passages no longer in force');
    return [];
  }
  const out: { id: string; file: string }[] = [];
  for (const entry of [...shown].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = `${dir}/${entry.name}`;
    if (entry.dir) {
      whole(file, `${file} is a folder; ${dir} holds one .yaml file per ${what}`, `move its files into ${dir}, or out of the knowledge base`);
    } else if (entry.name.endsWith('.yml')) {
      whole(file, `${file} ends in .yml; the knowledge base's files end in .yaml`, `rename it to ${entry.name.slice(0, -4)}.yaml`);
    } else if (!entry.name.endsWith('.yaml')) {
      whole(file, `${file} is not a .yaml file; ${dir} holds one .yaml file per ${what}`, `delete it, or move it out of the knowledge base`);
    } else {
      out.push({ id: entry.name.slice(0, -'.yaml'.length), file });
    }
  }
  return out;
}

/** A folder's entries, or none when it is missing or a file. */
function listOrEmpty(io: KbFolderIo, dir: string): KbEntry[] {
  const entries = io.list(dir);
  return Array.isArray(entries) ? entries : [];
}

/** The entries that are not hidden (.index, .DS_Store, an editor's files). */
function visible(entries: readonly KbEntry[]): KbEntry[] {
  return entries.filter((e) => !e.name.startsWith('.'));
}

/** `rename it to "x", or ` when a known name is close. */
function hint(word: string, known: readonly string[]): string {
  const near = closest(word, known);
  return near ? `rename it to ${near}, or ` : '';
}

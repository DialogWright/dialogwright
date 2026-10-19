import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceHashOf } from 'dialogwright';
import { Document, isMap, isPair, isScalar, parse, parseDocument, type Pair, type YAMLMap } from 'yaml';
import { schemaPathFrom } from './kbPlace';
import { distinct, type ExtractedSection } from './sections';

/**
 * Writing what was read into a knowledge base's `kb/sources/<doc>.yaml`, the format dialogwright's
 * loader reads (`{ document, provenance: { url | file, retrieved }, sections: { <id>: { heading?, text, page?, lastPage? } } }`),
 * and saying what changed.
 *
 * - A document's id is kept from run to run: a source file whose provenance (its URL, or its file's
 *   path from the app folder) is the document's keeps its id. A new document takes the slug of its
 *   file's path or URL path; when another document has it, the slug with its extension, then a number.
 *   A source file with other provenance (or none, written by hand) is never overwritten.
 * - A document is unchanged when its title, provenance and sections (ids, order, headings, and text
 *   by sourceHashOf, so whitespace aside) are as the file has them: the file is not written, so its
 *   bytes and its `retrieved` date stay. A changed or new document is written with today's date.
 * - The same input gives the same bytes: sections in document order, keys in a fixed order, no line
 *   folding, and nothing taken from the clock but the date.
 * - What a person wrote into a source file is kept when it is written again (a refresh, an ingest of the
 *   same document): the document's `summarize`, `applies` and `approval` (an approval whose hash the new
 *   text no longer matches is then stale, read again and approved again, not lost), and a section's
 *   `summarize` while the section is still there, each with its comments.
 */

/** The settings of the crawl that read a page, kept in its provenance so a refresh can crawl the same way. */
export interface CrawlProvenance {
  start: string;
  depth: number;
  include?: string[];
  allowHosts?: string[];
  maxPages?: number;
  rateMs?: number;
}

/** A document read, ready to be written. */
export interface SourceInput {
  /** Where it came from: its URL (and the crawl that read it), or its file's path from the app folder (forward slashes). */
  provenance: { url: string; crawl?: CrawlProvenance } | { file: string };
  /** Its title. */
  title: string;
  /** Its id when no source file already has its provenance: a slug of its path. */
  id: string;
  /** The id to try next when `id` is another document's (the slug with its extension). */
  altId?: string;
  sections: readonly ExtractedSection[];
}

export type SectionStatus = 'added' | 'changed' | 'unchanged' | 'removed';

/** What happened to one section. */
export interface SectionChange {
  id: string;
  status: SectionStatus;
  /** Only its heading changed (its text, which approvals hash, did not): it counts as changed. */
  headingOnly?: boolean;
  /** Only the pages it is on changed (its text and heading did not): it counts as changed, though no approval hashes its pages. */
  pageOnly?: boolean;
}

/** What happened to one document. */
export interface DocumentChange {
  id: string;
  /** The source file, from the knowledge base folder: `sources/<id>.yaml`. */
  file: string;
  title: string;
  provenance: SourceInput['provenance'];
  status: 'added' | 'changed' | 'unchanged';
  sections: SectionChange[];
  /** Why it was not written, when it could not be (it would be too large for the loader). */
  refused?: string;
  /** The text written (or that would be, on a dry run); undefined when unchanged. */
  yaml?: string;
}

/** The largest file the app folder loader reads. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** A source file already in the folder, as far as ingesting needs it. */
export interface Existing {
  id: string;
  key: string | undefined;
  /** The file's text, for what a person wrote into it (keptByPerson). */
  text?: string;
  data: { document?: unknown; provenance?: { url?: unknown; file?: unknown; retrieved?: unknown; crawl?: unknown }; sections?: Record<string, { heading?: unknown; text?: unknown; page?: unknown; lastPage?: unknown }> } | null;
}

/** A provenance as one string, to compare. */
function keyOf(provenance: { url?: unknown; file?: unknown } | undefined): string | undefined {
  if (typeof provenance?.url === 'string') return `url ${provenance.url}`;
  if (typeof provenance?.file === 'string') return `file ${provenance.file}`;
  return undefined;
}

/** The source files in `sourcesDir`, read leniently (one that does not parse still holds its id). */
export function existingSources(sourcesDir: string): Existing[] {
  let names: string[];
  try {
    names = readdirSync(sourcesDir).filter((n) => n.endsWith('.yaml') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const id = name.slice(0, -'.yaml'.length);
    try {
      const text = readFileSync(join(sourcesDir, name), 'utf8');
      const data = parse(text) as Existing['data'];
      return { id, key: keyOf(data?.provenance), text, data: data && typeof data === 'object' ? data : null };
    } catch {
      return { id, key: undefined, data: null };
    }
  });
}

/** The editor schema comment for a source file in `sourcesDir`: the path to dialogwright's kb-source schema, when it can be found above it. */
export function schemaPathFor(sourcesDir: string): string | undefined {
  return schemaPathFrom(sourcesDir, 'kb-source');
}

/** The keys of a source file and of its sections that reading a document writes; every other is a person's (keptByPerson). */
const READ_KEYS = new Set(['document', 'provenance', 'sections']);
const READ_SECTION_KEYS = new Set(['heading', 'text', 'page', 'lastPage']);

const keyName = (pair: Pair): string | undefined => (isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined);

/**
 * Copies into `doc` what a person wrote into the file it replaces (`previous`, its text): each top-level key
 * reading never writes (`summarize`, `applies`, `approval`), after the sections, and each key of a section
 * still there that reading never writes (`summarize`), after its heading; each with its comments.
 */
function keptByPerson(doc: Document, previous: string): void {
  let old: Document;
  try {
    old = parseDocument(previous);
  } catch {
    return;
  }
  if (old.errors.length > 0 || !isMap(old.contents) || !isMap(doc.contents)) return;
  for (const pair of old.contents.items) {
    const name = keyName(pair);
    if (name !== undefined && !READ_KEYS.has(name)) doc.contents.items.push(pair.clone() as Pair);
  }
  const oldSections = old.get('sections', true);
  const newSections = doc.get('sections', true);
  if (!isMap(oldSections) || !isMap(newSections)) return;
  for (const pair of newSections.items) {
    const id = keyName(pair);
    const was = id === undefined ? undefined : oldSections.get(id, true);
    if (!isMap(was) || !isMap(pair.value)) continue;
    const section = pair.value as YAMLMap;
    const kept = was.items.filter((p) => isPair(p) && keyName(p) !== undefined && !READ_SECTION_KEYS.has(keyName(p)!)).map((p) => p.clone() as Pair);
    if (kept.length === 0) continue;
    const at = section.items.findIndex((p) => keyName(p) === 'heading') + 1;
    section.items.splice(at, 0, ...kept);
  }
}

/** A source document as YAML; with `previous`, the text of the file it replaces, what a person wrote into it kept (keptByPerson). */
export function sourceYaml(input: { title: string; provenance: SourceInput['provenance']; retrieved: string; sections: readonly ExtractedSection[] }, schemaPath?: string, previous?: string): string {
  const sections = new Map(
    input.sections.map((s) => [
      s.id,
      { ...(s.heading === undefined ? {} : { heading: s.heading }), text: s.text, ...(s.page === undefined ? {} : { page: s.page }), ...(s.lastPage === undefined ? {} : { lastPage: s.lastPage }) },
    ]),
  );
  const doc = new Document({ document: input.title, provenance: { ...input.provenance, retrieved: input.retrieved }, sections });
  if (previous !== undefined) keptByPerson(doc, previous);
  if (schemaPath !== undefined) doc.commentBefore = ` yaml-language-server: $schema=${schemaPath}`;
  return doc.toString({ lineWidth: 0 });
}

/** How each section of `next` compares with the file's, and the file's sections that are gone. */
function sectionChanges(previous: Existing['data'], next: readonly ExtractedSection[]): SectionChange[] {
  const before = previous?.sections && typeof previous.sections === 'object' ? previous.sections : {};
  const out: SectionChange[] = next.map((s) => {
    if (!Object.hasOwn(before, s.id)) return { id: s.id, status: 'added' };
    const old = before[s.id]!;
    if (typeof old?.text !== 'string' || sourceHashOf(old.text) !== sourceHashOf(s.text)) return { id: s.id, status: 'changed' };
    if ((typeof old.heading === 'string' ? old.heading : undefined) !== s.heading) return { id: s.id, status: 'changed', headingOnly: true };
    if (old.page !== s.page || old.lastPage !== s.lastPage) return { id: s.id, status: 'changed', pageOnly: true };
    return { id: s.id, status: 'unchanged' };
  });
  const ids = new Set(next.map((s) => s.id));
  for (const id of Object.keys(before)) if (!ids.has(id)) out.push({ id, status: 'removed' });
  return out;
}

/** A value as JSON with its keys sorted, to compare. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Plans the writing of `inputs` into `sourcesDir`: each document's id, status, section changes and text. Nothing is written. */
export function planSources(inputs: readonly SourceInput[], options: { sourcesDir: string; today: string }): DocumentChange[] {
  const existing = existingSources(options.sourcesDir);
  const byKey = new Map(existing.filter((e) => e.key !== undefined).map((e) => [e.key!, e]));
  const taken = new Set(existing.map((e) => e.id));
  const schemaPath = schemaPathFor(options.sourcesDir);
  const used = new Set<string>();

  return inputs.map((input) => {
    const key = keyOf(input.provenance)!;
    const mine = byKey.get(key);
    let id: string;
    if (mine && !used.has(mine.id)) id = mine.id;
    else if (!taken.has(input.id)) id = input.id;
    else if (input.altId !== undefined && !taken.has(input.altId)) id = input.altId;
    else id = distinct(input.id, new Set(taken));
    taken.add(id);
    used.add(id);

    const previous = mine && mine.id === id ? mine.data : null;
    const sections = sectionChanges(previous, input.sections);
    const sameOrder = previous?.sections !== undefined && Object.keys(previous.sections).join('\n') === input.sections.map((s) => s.id).join('\n');
    const { retrieved: _retrieved, ...before } = previous?.provenance ?? {};
    const sameProvenance = canonical(before) === canonical(input.provenance);
    const same = previous !== null && previous.document === input.title && sameOrder && sameProvenance && sections.every((s) => s.status === 'unchanged');
    const change: DocumentChange = { id, file: `sources/${id}.yaml`, title: input.title, provenance: input.provenance, status: previous === null ? 'added' : same ? 'unchanged' : 'changed', sections };
    if (change.status === 'unchanged') return change;
    const yaml = sourceYaml({ title: input.title, provenance: input.provenance, retrieved: options.today, sections: input.sections }, schemaPath, previous !== null ? mine?.text : undefined);
    if (Buffer.byteLength(yaml, 'utf8') > MAX_SOURCE_BYTES) {
      return { ...change, refused: `it would be ${Buffer.byteLength(yaml, 'utf8')} bytes, over the ${MAX_SOURCE_BYTES} a knowledge base file may be: split the document and ingest the parts` };
    }
    return { ...change, yaml };
  });
}

/** Writes the planned documents that changed. */
export function writeSources(changes: readonly DocumentChange[], sourcesDir: string): void {
  const writes = changes.filter((c) => c.yaml !== undefined && c.refused === undefined);
  if (writes.length === 0) return;
  mkdirSync(sourcesDir, { recursive: true });
  for (const c of writes) writeFileSync(join(sourcesDir, `${c.id}.yaml`), c.yaml!);
}

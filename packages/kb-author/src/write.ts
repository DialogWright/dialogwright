import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { sourceHashOf } from 'dialogwright';
import { Document, parse } from 'yaml';
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
 */

/** A document read, ready to be written. */
export interface SourceInput {
  /** Where it came from: its URL, or its file's path from the app folder (forward slashes). */
  provenance: { url: string } | { file: string };
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
  data: { document?: unknown; provenance?: { url?: unknown; file?: unknown; retrieved?: unknown }; sections?: Record<string, { heading?: unknown; text?: unknown; page?: unknown; lastPage?: unknown }> } | null;
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
      const data = parse(readFileSync(join(sourcesDir, name), 'utf8')) as Existing['data'];
      return { id, key: keyOf(data?.provenance), data: data && typeof data === 'object' ? data : null };
    } catch {
      return { id, key: undefined, data: null };
    }
  });
}

/** The editor schema comment for a source file in `sourcesDir`: the path to dialogwright's kb-source schema, when it can be found above it. */
export function schemaPathFor(sourcesDir: string): string | undefined {
  for (let at = dirname(sourcesDir); ; at = dirname(at)) {
    for (const candidate of [join(at, 'packages', 'dialogwright', 'schemas', 'kb-source.schema.json'), join(at, 'node_modules', 'dialogwright', 'schemas', 'kb-source.schema.json')]) {
      if (existsSync(candidate)) return relative(sourcesDir, candidate).split(sep).join('/');
    }
    if (dirname(at) === at) return undefined;
  }
}

/** A source document as YAML. */
export function sourceYaml(input: { title: string; provenance: SourceInput['provenance']; retrieved: string; sections: readonly ExtractedSection[] }, schemaPath?: string): string {
  const sections = new Map(
    input.sections.map((s) => [
      s.id,
      { ...(s.heading === undefined ? {} : { heading: s.heading }), text: s.text, ...(s.page === undefined ? {} : { page: s.page }), ...(s.lastPage === undefined ? {} : { lastPage: s.lastPage }) },
    ]),
  );
  const doc = new Document({ document: input.title, provenance: { ...input.provenance, retrieved: input.retrieved }, sections });
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
    const same = previous !== null && previous.document === input.title && sameOrder && sections.every((s) => s.status === 'unchanged');
    const change: DocumentChange = { id, file: `sources/${id}.yaml`, title: input.title, provenance: input.provenance, status: previous === null ? 'added' : same ? 'unchanged' : 'changed', sections };
    if (change.status === 'unchanged') return change;
    const yaml = sourceYaml({ title: input.title, provenance: input.provenance, retrieved: options.today, sections: input.sections }, schemaPath);
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

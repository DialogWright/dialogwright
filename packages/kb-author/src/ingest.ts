import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { crawl, type CrawlOptions, type CrawlResult } from './crawl/crawl';
import { hostOf } from './crawl/url';
import { EXTENSIONS, extract, formatOfName } from './extract/index';
import { slugOf } from './sections';
import { existingSources, planSources, writeSources, type DocumentChange, type SourceInput } from './write';

/**
 * `kb:ingest`'s work: read a folder, a file or a website into sections (./extract, ./crawl), and
 * write each document to the knowledge base's sources (./write.ts), reporting what was added,
 * changed and unchanged, by document and by section. The report is what a refresh acts on.
 */

/** The largest file read from a folder. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface IngestOptions {
  /** A folder, a file (absolute paths) or an http(s) URL. */
  input: string;
  /** The app folder: a file's provenance is its path from here. */
  appDir: string;
  /** The knowledge base folder: documents are written to its sources/. */
  kbDir: string;
  /** Today, as an ISO date: a changed document's `retrieved`. */
  today: string;
  /** Plan and report, but write nothing. */
  dryRun?: boolean;
  /** For a URL: the crawl's settings. */
  crawl?: Omit<CrawlOptions, 'start'>;
}

export interface IngestReport {
  input: string;
  kind: 'folder' | 'file' | 'site';
  /** Each document read, in the order read, with what happened to it. */
  documents: DocumentChange[];
  /** What was not read (a file of another type, a page robots.txt disallows, ...), and why. */
  skipped: { what: string; reason: string }[];
  /** Source files from the same folder (or host) that this run did not read: gone, or not reached. They are left as they are. */
  notSeen: string[];
  /** For a site: the requests made and each host's robots.txt. */
  crawl?: { requests: CrawlResult['requests']; robots: CrawlResult['robots'] };
}

export class IngestError extends Error {}

export const isUrl = (input: string): boolean => /^https?:\/\//i.test(input);

/** A path with forward slashes. */
const posix = (path: string): string => path.split(sep).join('/');

/** A file name made a title: its words, first letter capital. */
function titleFromName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words === '' ? 'Untitled' : words[0]!.toUpperCase() + words.slice(1);
}

/** The id of a document at a path (its segments without the extension; a final `index` dropped), and the id with its extension. */
function idsOfPath(segments: readonly string[], ext: string, fallback: string): { id: string; altId?: string } {
  const parts = segments.filter((s) => s !== '');
  if (parts.length > 1 && /^(index|default)$/i.test(parts[parts.length - 1]!)) parts.pop();
  const id = slugOf(parts.join('-'), fallback);
  return ext === '' ? { id } : { id, altId: `${id}-${slugOf(ext)}` };
}

/** The files of a folder, recursively, sorted; hidden entries and node_modules are passed over, links not followed. */
function walk(root: string, at: string, files: string[], skipped: IngestReport['skipped']): void {
  const names = readdirSync(join(root, at)).sort();
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const rel = at === '' ? name : `${at}/${name}`;
    const stat = lstatSync(join(root, rel));
    if (stat.isSymbolicLink()) skipped.push({ what: rel, reason: 'a link (not followed)' });
    else if (stat.isDirectory()) walk(root, rel, files, skipped);
    else if (!stat.isFile()) skipped.push({ what: rel, reason: 'not a file' });
    else if (formatOfName(name) === undefined) skipped.push({ what: rel, reason: `not a type read here (${Object.keys(EXTENSIONS).join(', ')})` });
    else if (stat.size > MAX_FILE_BYTES) skipped.push({ what: rel, reason: `over ${MAX_FILE_BYTES / 1024 / 1024} MB` });
    else files.push(rel);
  }
}

/** A folder's or a file's documents. */
async function readFiles(input: string, appDir: string): Promise<{ kind: 'folder' | 'file'; inputs: SourceInput[]; skipped: IngestReport['skipped']; under: string }> {
  let stat;
  try {
    stat = statSync(input);
  } catch {
    throw new IngestError(`${input} is not there`);
  }
  const skipped: IngestReport['skipped'] = [];
  let root: string;
  let files: string[];
  if (stat.isDirectory()) {
    root = input;
    files = [];
    walk(root, '', files, skipped);
  } else {
    if (formatOfName(input) === undefined) throw new IngestError(`${input} is not a type read here (${Object.keys(EXTENSIONS).join(', ')})`);
    root = join(input, '..');
    files = [basename(input)];
  }
  const inputs: SourceInput[] = [];
  for (const rel of files) {
    const format = formatOfName(rel)!;
    const file = join(root, rel);
    try {
      const read = await extract(format, new Uint8Array(readFileSync(file)));
      const name = rel.split('/').pop()!;
      const ext = name.slice(name.lastIndexOf('.') + 1);
      if (read.sections.length === 0) {
        skipped.push({ what: rel, reason: format === 'pdf' ? 'no text (a scanned PDF needs OCR first)' : 'no text' });
        continue;
      }
      const segments = rel.slice(0, rel.length - ext.length - 1).split('/');
      inputs.push({
        provenance: { file: posix(relative(appDir, file)) },
        title: read.title ?? titleFromName(name.slice(0, name.length - ext.length - 1)),
        ...idsOfPath(segments, ext, 'document'),
        sections: read.sections,
      });
    } catch (error) {
      skipped.push({ what: rel, reason: `could not be read (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  const under = posix(relative(appDir, input));
  return { kind: stat.isDirectory() ? 'folder' : 'file', inputs, skipped, under };
}

/** A crawled URL's ids: its path's segments (a final index dropped, the extension too), with the host first when it is not the start's. */
function idsOfUrl(url: string, startHost: string): { id: string; altId?: string } {
  const u = new URL(url);
  const segments = u.pathname.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let last = segments.pop() ?? '';
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  if (ext !== '') last = last.slice(0, dot);
  const parts = [...(u.host === startHost ? [] : [u.host]), ...segments, last, ...(u.search ? [u.search.slice(1)] : [])];
  return idsOfPath(parts.filter((p) => p !== '').length === 0 ? ['index'] : parts, ext, 'index');
}

/** Reads the input and writes (unless a dry run) its documents into the knowledge base's sources. */
export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const sourcesDir = join(options.kbDir, 'sources');
  let report: IngestReport;
  let inputs: SourceInput[];
  let mine: (provenance: { url?: unknown; file?: unknown } | undefined) => boolean;

  if (isUrl(options.input)) {
    if (!options.crawl) throw new IngestError('a URL needs the crawl settings');
    const result = await crawl({ ...options.crawl, start: options.input });
    const startHost = hostOf(result.requests[0]?.url ?? options.input);
    const hosts = new Set([startHost, ...(options.crawl.allowHosts ?? []).map((h) => h.toLowerCase())]);
    inputs = [];
    const skipped: IngestReport['skipped'] = result.skipped.map((s) => ({ what: s.url, reason: s.reason }));
    for (const d of result.documents) {
      if (d.document.sections.length === 0) {
        skipped.push({ what: d.url, reason: d.format === 'pdf' ? 'no text (a scanned PDF needs OCR first)' : 'no text' });
        continue;
      }
      const u = new URL(d.url);
      const name = u.pathname.split('/').filter(Boolean).pop() ?? u.host;
      inputs.push({ provenance: { url: d.url }, title: d.document.title ?? titleFromName(name.replace(/\.[^.]*$/, '')), ...idsOfUrl(d.url, startHost), sections: d.document.sections });
    }
    report = { input: options.input, kind: 'site', documents: [], skipped, notSeen: [], crawl: { requests: result.requests, robots: result.robots } };
    mine = (p) => {
      if (typeof p?.url !== 'string') return false;
      try {
        return hosts.has(hostOf(p.url));
      } catch {
        return false;
      }
    };
  } else {
    const read = await readFiles(options.input, options.appDir);
    inputs = read.inputs;
    report = { input: options.input, kind: read.kind, documents: [], skipped: read.skipped, notSeen: [] };
    mine = (p) => typeof p?.file === 'string' && (read.kind === 'file' ? p.file === read.under : p.file.startsWith(read.under === '' ? '' : `${read.under}/`));
  }

  report.documents = planSources(inputs, { sourcesDir, today: options.today });
  const read = new Set(report.documents.map((d) => d.id));
  report.notSeen = existingSources(sourcesDir)
    .filter((e) => !read.has(e.id) && mine(e.data?.provenance))
    .map((e) => e.id)
    .sort();
  if (!options.dryRun) writeSources(report.documents, sourcesDir);
  return report;
}

/** The report as lines for a person. */
export function formatReport(report: IngestReport, labels: { input: string; sources: string; dryRun?: boolean }): string[] {
  const lines: string[] = [];
  const count = (status: DocumentChange['status']): number => report.documents.filter((d) => d.status === status && d.refused === undefined).length;
  const refused = report.documents.filter((d) => d.refused !== undefined);
  const verb = labels.dryRun ? 'would write' : 'wrote';
  lines.push(
    `${labels.input}: ${report.documents.length} document${report.documents.length === 1 ? '' : 's'} read into ${labels.sources}: ${count('added')} added, ${count('changed')} changed, ${count('unchanged')} unchanged` +
      (refused.length > 0 ? `, ${refused.length} refused` : '') +
      (report.skipped.length > 0 ? `; ${report.skipped.length} skipped` : '') +
      (labels.dryRun ? ' (a dry run: nothing written)' : ''),
  );
  for (const d of report.documents) {
    const where = 'url' in d.provenance ? d.provenance.url : d.provenance.file;
    const by = (s: string): number => d.sections.filter((x) => x.status === s).length;
    if (d.refused !== undefined) {
      lines.push(`  refused   ${d.id} (${where}): ${d.refused}`);
      continue;
    }
    if (d.status === 'added') lines.push(`  added     ${d.id} (${where}): ${d.sections.length} section${d.sections.length === 1 ? '' : 's'}; ${verb} ${labels.sources}/${d.id}.yaml`);
    else if (d.status === 'unchanged') lines.push(`  unchanged ${d.id} (${where}): ${d.sections.length} section${d.sections.length === 1 ? '' : 's'}`);
    else {
      lines.push(`  changed   ${d.id} (${where}): ${by('added')} added, ${by('changed')} changed, ${by('unchanged')} unchanged, ${by('removed')} removed; ${verb} ${labels.sources}/${d.id}.yaml`);
      for (const s of d.sections) {
        if (s.status === 'added') lines.push(`    + ${s.id}`);
        else if (s.status === 'changed') lines.push(`    ~ ${s.id}${s.headingOnly ? ' (its heading only)' : s.pageOnly ? ' (its pages only)' : ''}`);
        else if (s.status === 'removed') lines.push(`    - ${s.id}`);
      }
    }
  }
  if (report.notSeen.length > 0) lines.push(`  not read this time (left as they are): ${report.notSeen.join(', ')}`);
  for (const s of report.skipped) lines.push(`  skipped   ${s.what}: ${s.reason}`);
  if (report.crawl) {
    const robots = report.crawl.robots.map((r) => `${r.host} ${r.outcome === 'found' ? 'read' : r.outcome === 'none' ? 'none (all allowed)' : 'unreadable (host not crawled)'}`).join(', ');
    lines.push(`  ${report.crawl.requests.length} request${report.crawl.requests.length === 1 ? '' : 's'}; robots.txt: ${robots}`);
  }
  return lines;
}

import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KbPlace, KnowledgeBase } from 'dialogwright';
import type { CrawlOptions } from '../crawl/crawl';
import { canonicalUrl, hostOf } from '../crawl/url';
import { draftsIn } from '../draft/draft';
import { DEFAULT_PDF_READER, readerOfProvenance, type PdfReaderName } from '../extract/index';
import type { LiteParseOpen } from '../extract/liteparse';
import { ingest, type IngestReport } from '../ingest';
import { loadKb } from '../kbPlace';
import { existingSources, type CrawlProvenance, type DocumentChange } from '../write';

/**
 * `kb:refresh`'s work: read every source document again from where it came from, as kb:ingest read it
 * (a file from the app folder, or the crawl that read a page, with the crawl's own settings), write
 * the documents that changed, and say what that means for the passages:
 *
 * - a passage whose section changed is stale now, and withheld from callers until a person approves
 *   it again (its approval's sourceHash no longer matches: the engine does this, nothing is marked);
 * - a passage whose section is gone is withheld too, and cannot be approved until it cites a section
 *   that is there;
 * - a section no passage, draft or rejected draft cites is new material, offered to kb:draft.
 *
 * A PDF is read again by the reader its provenance names (`reader: liteparse@<version>`; none, as a PDF
 * ingested before LiteParse, is ours), so a source is read as it was and no approved passage goes stale
 * from a change of reader. `reader` (kb:refresh --reader) moves every PDF to the reader it names on
 * purpose: a section that reads differently then withholds the passages citing it until a person
 * approves them again, as any change in a source does, and the report lists each document moved. A page
 * OCR read is read again in the language its provenance records (`ocrLanguage`), unless `ocrLanguage`
 * (kb:refresh --ocr-language) names another.
 *
 * It writes nothing but kb/sources. A source written by hand (no provenance) is left as it is; a file
 * that is gone is reported and its source left as it is.
 *
 * What it reads is only what the sources name, and a source file is text anyone can edit, so:
 *
 * - a file is read only when it is a file inside the app folder (its real path, links followed); a
 *   provenance that leads outside it (`../`, an absolute path, a link) is refused, and a folder too;
 * - a URL is read only when it is an http(s) URL, through the crawler, which reads only public
 *   addresses unless `allowPrivate` (kb:refresh --allow-private);
 * - the hosts it will ask are given to `onHosts` before the first request (kb:refresh prints them).
 */

export interface RefreshOptions {
  place: KbPlace;
  /** Today, as an ISO date: a changed document's `retrieved`. */
  today: string;
  /** What every crawl is given beyond a page's own settings: the User-Agent, --allow-private, and a test's fetch, resolver and clock. */
  crawl: Pick<CrawlOptions, 'userAgent' | 'allowPrivate' | 'resolve' | 'fetch' | 'sleep' | 'now'>;
  /** Told the hosts the refresh will ask, before it asks any (kb:refresh prints them). */
  onHosts?: (hosts: readonly string[]) => void;
  /** Re-read and report, but write nothing. */
  dryRun?: boolean;
  /** Read every PDF with this reader (kb:refresh --reader), in place of the one its provenance names. */
  reader?: PdfReaderName;
  /** Tesseract's language for a page with no text layer (kb:refresh --ocr-language). */
  ocrLanguage?: string;
  /** Told before a document's first OCR (said once). */
  onOcr?: (line: string) => void;
  /** LiteParse itself, or a test's fake of it. */
  liteparse?: LiteParseOpen;
}

/** One re-reading: a file, a crawl, or a page read alone. */
export interface RefreshRun {
  input: string;
  kind: 'file' | 'crawl' | 'page';
  /** The documents it read, and what changed in each. */
  documents: DocumentChange[];
  /** What it could not read, and why (a page it could not fetch, a file of another type). */
  skipped: { what: string; reason: string }[];
  /** Why it could not be read, when it could not. */
  error?: string;
}

export interface RefreshReport {
  runs: RefreshRun[];
  /** The hosts the sources' provenance named, which it asked (in order). */
  hosts: string[];
  /** Sources not read again: written by hand (no provenance), or their file is gone. */
  notRead: { id: string; why: string }[];
  /** Documents read by another reader than their provenance named (kb:refresh --reader, or LiteParse's version): from and to (`ours` for none). */
  moved: { id: string; from: string; to: string }[];
  /** Passages withheld because their section changed since approval. */
  stale: { id: string; topic: string; document: string; section: string }[];
  /** Passages withheld because their section is gone. */
  gone: { id: string; topic: string; document: string; section: string }[];
  /** Sections that nothing cites, by document. */
  uncited: { document: string; sections: string[] }[];
  /** Whether the passages' state was read after writing (not on a dry run). */
  readAfter: boolean;
}

/**
 * Where a provenance file is: 'inside' the app folder (a file there, its links followed), 'gone', or
 * what it is instead (outside the app folder, or not a file).
 */
function fileInApp(appDir: string, file: string): 'inside' | 'gone' | string {
  const path = resolve(appDir, file);
  if (!existsSync(path)) return 'gone';
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(appDir);
  } catch {
    return 'gone';
  }
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${file}, which is outside the app folder`;
  if (!statSync(real).isFile()) return `${file}, which is not a file`;
  return 'inside';
}

/** The crawl settings of a page's provenance, or null when it has none that read as settings. */
function crawlOf(value: unknown): CrawlProvenance | null {
  const c = value as Partial<CrawlProvenance> | undefined;
  if (!c || typeof c.start !== 'string' || typeof c.depth !== 'number') return null;
  return c as CrawlProvenance;
}

/** Re-reads the sources (see the file's comment). */
export async function refreshKb(options: RefreshOptions): Promise<RefreshReport> {
  const { place, today } = options;
  const appDir = place.appDir ?? dirname(place.kbDir);
  const sourcesDir = join(place.kbDir, 'sources');
  const report: RefreshReport = { runs: [], hosts: [], notRead: [], moved: [], stale: [], gone: [], uncited: [], readAfter: false };
  const refusedRuns: RefreshRun[] = [];

  // What to read again: each file, each crawl once (the pages it read share its settings), each page read without one.
  const files: string[] = [];
  const crawls = new Map<string, CrawlProvenance>();
  const pages: string[] = [];
  // The reader each source was read by, by where it came from, and as its provenance says it.
  const readers = new Map<string, PdfReaderName>();
  const recorded = new Map<string, string>();
  const languages = new Map<string, string>();
  for (const e of existingSources(sourcesDir)) {
    const p = e.data?.provenance as { file?: unknown; url?: unknown; crawl?: unknown; reader?: unknown; ocrLanguage?: unknown } | undefined;
    const where = typeof p?.file === 'string' ? `file ${p.file}` : typeof p?.url === 'string' ? `url ${p.url}` : undefined;
    if (where !== undefined) {
      const reader = readerOfProvenance(p?.reader);
      if (reader === undefined) {
        refusedRuns.push({ input: String(p?.file ?? p?.url), kind: typeof p?.file === 'string' ? 'file' : 'page', documents: [], skipped: [], error: `${e.id}'s provenance names a reader kb-author does not have (${String(p?.reader)}): it is not read (the source is left as it is); its reader is liteparse@<version> or ours` });
        continue;
      }
      readers.set(where, reader);
      if (typeof p?.ocrLanguage === 'string') languages.set(where, p.ocrLanguage);
      recorded.set(e.id, typeof p?.reader === 'string' ? p.reader : 'ours');
    }
    if (typeof p?.file === 'string') {
      const where = fileInApp(appDir, p.file);
      if (where === 'gone') report.notRead.push({ id: e.id, why: `its file ${p.file} is not there (the source is left as it is)` });
      else if (where !== 'inside') refusedRuns.push({ input: p.file, kind: 'file', documents: [], skipped: [], error: `${e.id}'s provenance names ${where}: only a file inside the app folder is read again (the source is left as it is)` });
      else files.push(p.file);
    } else if (typeof p?.url === 'string') {
      const c = crawlOf(p.crawl);
      const bad = [p.url, ...(c ? [c.start] : [])].find((u) => canonicalUrl(u) === undefined);
      if (bad !== undefined) refusedRuns.push({ input: bad, kind: c ? 'crawl' : 'page', documents: [], skipped: [], error: `${e.id}'s provenance names ${bad}, which is not an http or https URL: it is not read (the source is left as it is)` });
      else if (c) crawls.set(JSON.stringify(c), c);
      else pages.push(p.url);
    } else report.notRead.push({ id: e.id, why: e.data === null ? 'it does not read as a source file' : 'it has no provenance (written by hand)' });
  }

  const run = async (input: string, kind: RefreshRun['kind'], go: () => Promise<IngestReport>): Promise<void> => {
    try {
      const r = await go();
      report.runs.push({ input, kind, documents: r.documents, skipped: r.skipped });
    } catch (error) {
      report.runs.push({ input, kind, documents: [], skipped: [], error: error instanceof Error ? error.message : String(error) });
    }
  };
  report.runs.push(...refusedRuns);

  // The hosts it will ask, said before it asks any.
  const hosts = new Set<string>();
  for (const c of crawls.values()) for (const h of [hostOf(c.start), ...(c.allowHosts ?? []).map((x) => x.toLowerCase())]) hosts.add(h);
  for (const url of pages) hosts.add(hostOf(url));
  report.hosts = [...hosts].sort();
  if (report.hosts.length > 0) options.onHosts?.(report.hosts);

  // A PDF read again by the reader its provenance names, or --reader's; a document new to the sources by the default.
  const readerFor = (source: { file?: string; url?: string }): PdfReaderName =>
    options.reader ?? readers.get(source.file !== undefined ? `file ${source.file}` : `url ${source.url}`) ?? DEFAULT_PDF_READER;
  const common = {
    appDir,
    kbDir: place.kbDir,
    today,
    reader: readerFor,
    // A scanned page read again in the language its provenance records, or --ocr-language's.
    ocrLanguage: (source: { file?: string; url?: string }) => options.ocrLanguage ?? languages.get(source.file !== undefined ? `file ${source.file}` : `url ${source.url}`),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.onOcr !== undefined ? { onOcr: options.onOcr } : {}),
    ...(options.liteparse !== undefined ? { liteparse: options.liteparse } : {}),
  };
  for (const file of [...new Set(files)].sort()) await run(file, 'file', () => ingest({ ...common, input: join(appDir, file) }));
  for (const c of [...crawls.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
    await run(c.start, 'crawl', () =>
      ingest({
        ...common,
        input: c.start,
        crawl: { ...options.crawl, depth: c.depth, ...(c.include ? { include: c.include } : {}), ...(c.allowHosts ? { allowHosts: c.allowHosts } : {}), ...(c.maxPages !== undefined ? { maxPages: c.maxPages } : {}), ...(c.rateMs !== undefined ? { rateMs: c.rateMs } : {}) },
      }),
    );
  }
  // A page whose crawl was not kept is read again on its own (depth 0), unless a crawl above read it.
  const crawled = new Set(report.runs.flatMap((r) => r.documents.map((d) => ('url' in d.provenance ? d.provenance.url : ''))));
  for (const url of [...new Set(pages)].sort()) if (!crawled.has(url)) await run(url, 'page', () => ingest({ ...common, input: url, crawl: { ...options.crawl, depth: 0 } }));

  // A source with provenance that no read gave back (a page that could not be fetched, one a crawl no longer reaches) is left as it is.
  const reread = new Set(report.runs.flatMap((r) => r.documents.map((d) => d.id)));
  const listed = new Set(report.notRead.map((n) => n.id));
  for (const e of existingSources(sourcesDir)) {
    if (!reread.has(e.id) && !listed.has(e.id)) report.notRead.push({ id: e.id, why: 'not read again this time (see what was skipped); the source is left as it is' });
  }
  report.notRead.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The documents now read by another reader than their provenance named.
  for (const d of report.runs.flatMap((r) => r.documents)) {
    const from = recorded.get(d.id);
    const to = (d.provenance as { reader?: string }).reader ?? 'ours';
    if (from !== undefined && from !== to) report.moved.push({ id: d.id, from, to });
  }

  if (options.dryRun) return report;

  // What it means for the passages, read again from the files.
  const after = loadKb(place);
  if (!after.kb) return report;
  report.readAfter = true;
  const kb = after.kb;
  for (const p of Object.values(kb.passages)) {
    if (p.freshness !== 'source-changed') continue;
    const row = { id: p.id, topic: p.topic, document: p.source.document, section: p.source.section };
    if (p.current.sourceHash === null) report.gone.push(row);
    else report.stale.push(row);
  }
  report.uncited = uncitedSections(place, kb);
  return report;
}

/** The sections no passage, pending draft or rejected draft cites, by source document (those with none left out). */
export function uncitedSections(place: KbPlace, kb: KnowledgeBase): { document: string; sections: string[] }[] {
  const base = place.kbDir.split(/[\\/]/).pop()!;
  const cited = new Set<string>();
  for (const p of Object.values(kb.passages)) cited.add(`${p.source.document}\u0000${p.source.section}`);
  for (const d of [...draftsIn(place.kbDir, 'pending', base), ...draftsIn(place.kbDir, 'rejected', base)]) if (d.draft) cited.add(`${d.draft.source.document}\u0000${d.draft.source.section}`);
  const out: { document: string; sections: string[] }[] = [];
  for (const doc of Object.values(kb.sources)) {
    const sections = Object.keys(doc.sections).filter((s) => !cited.has(`${doc.id}\u0000${s}`));
    if (sections.length > 0) out.push({ document: doc.id, sections });
  }
  return out;
}

/** The report as lines for a person. */
export function formatRefreshReport(report: RefreshReport, labels: { kb: string; dryRun?: boolean }): string[] {
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  const docs = report.runs.flatMap((r) => r.documents);
  const count = (status: DocumentChange['status']): number => docs.filter((d) => d.status === status).length;
  const lines = [
    `kb:refresh ${labels.kb}: ${n(report.runs.length, 'read', 'reads')} (${n(docs.length, 'document')}): ${count('added')} added, ${count('changed')} changed, ${count('unchanged')} unchanged${labels.dryRun ? ' (a dry run: nothing written)' : ''}`,
  ];
  for (const r of report.runs) if (r.error !== undefined) lines.push(`  failed    ${r.input}: ${r.error}`);
  for (const d of docs) {
    if (d.status === 'unchanged') continue;
    if (d.status === 'added') {
      lines.push(`  added     ${d.id}: ${n(d.sections.length, 'section')}`);
      continue;
    }
    const marks = d.sections.filter((s) => s.status !== 'unchanged').map((s) => `${s.status === 'added' ? '+' : s.status === 'removed' ? '-' : '~'} ${s.id}${s.headingOnly ? ' (its heading only)' : s.pageOnly ? ' (its pages only)' : ''}`);
    lines.push(`  changed   ${d.id}: ${marks.join(', ') || 'its title or provenance'}`);
  }
  for (const m of report.moved) lines.push(`  reader    ${m.id}: ${m.from} to ${m.to}`);
  for (const s of report.notRead) lines.push(`  not read  ${s.id}: ${s.why}`);
  for (const r of report.runs) for (const s of r.skipped) lines.push(`  skipped   ${s.what}: ${s.reason}`);
  if (report.moved.length > 0) lines.push(`read by another reader now (${report.moved.length}): a passage whose section reads differently is withheld until a person approves it again (pnpm kb:review)`);
  if (!report.readAfter) {
    if (!labels.dryRun) lines.push('the knowledge base does not load now, so the passages\' state cannot be read: run pnpm check');
    return lines;
  }
  if (report.stale.length > 0) {
    lines.push(`withheld, their section changed (${report.stale.length}): callers are not given them until a person approves them again`);
    for (const p of report.stale) lines.push(`  ${p.id}  ${p.topic}  ${labels.kb}/sources/${p.document}.yaml section "${p.section}"`);
  }
  if (report.gone.length > 0) {
    lines.push(`withheld, their section is gone (${report.gone.length}): point each at the section that says it now, or delete it`);
    for (const p of report.gone) lines.push(`  ${p.id}  ${p.topic}  ${labels.kb}/sources/${p.document}.yaml section "${p.section}"`);
  }
  if (report.uncited.length > 0) {
    lines.push(`sections no passage or draft cites (${report.uncited.reduce((s, u) => s + u.sections.length, 0)}): draft them with pnpm kb:draft ${report.uncited.map((u) => `--source ${u.document}`).join(' ')}`);
    for (const u of report.uncited) lines.push(`  ${u.document}: ${u.sections.join(', ')}`);
  }
  if (report.stale.length + report.gone.length > 0) lines.push('next: pnpm kb:review shows each withheld passage beside what changed in its section');
  else if (report.uncited.length === 0) lines.push('every passage\'s source is as approved, and every section is cited');
  return lines;
}

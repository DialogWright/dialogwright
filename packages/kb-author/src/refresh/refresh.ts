import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KbPlace, KnowledgeBase } from 'dialogwright';
import type { CrawlOptions } from '../crawl/crawl';
import { draftsIn } from '../draft/draft';
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
 * It writes nothing but kb/sources. A source written by hand (no provenance) is left as it is; a file
 * that is gone is reported and its source left as it is.
 */

export interface RefreshOptions {
  place: KbPlace;
  /** Today, as an ISO date: a changed document's `retrieved`. */
  today: string;
  /** What every crawl is given beyond a page's own settings: the User-Agent, and a test's fetch and clock. */
  crawl: Pick<CrawlOptions, 'userAgent' | 'fetch' | 'sleep' | 'now'>;
  /** Re-read and report, but write nothing. */
  dryRun?: boolean;
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
  /** Sources not read again: written by hand (no provenance), or their file is gone. */
  notRead: { id: string; why: string }[];
  /** Passages withheld because their section changed since approval. */
  stale: { id: string; topic: string; document: string; section: string }[];
  /** Passages withheld because their section is gone. */
  gone: { id: string; topic: string; document: string; section: string }[];
  /** Sections that nothing cites, by document. */
  uncited: { document: string; sections: string[] }[];
  /** Whether the passages' state was read after writing (not on a dry run). */
  readAfter: boolean;
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
  const report: RefreshReport = { runs: [], notRead: [], stale: [], gone: [], uncited: [], readAfter: false };

  // What to read again: each file, each crawl once (the pages it read share its settings), each page read without one.
  const files: string[] = [];
  const crawls = new Map<string, CrawlProvenance>();
  const pages: string[] = [];
  for (const e of existingSources(sourcesDir)) {
    const p = e.data?.provenance;
    if (typeof p?.file === 'string') {
      if (existsSync(join(appDir, p.file))) files.push(p.file);
      else report.notRead.push({ id: e.id, why: `its file ${p.file} is not there (the source is left as it is)` });
    } else if (typeof p?.url === 'string') {
      const c = crawlOf(p.crawl);
      if (c) crawls.set(JSON.stringify(c), c);
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
  const common = { appDir, kbDir: place.kbDir, today, ...(options.dryRun ? { dryRun: true } : {}) };
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
  for (const s of report.notRead) lines.push(`  not read  ${s.id}: ${s.why}`);
  for (const r of report.runs) for (const s of r.skipped) lines.push(`  skipped   ${s.what}: ${s.reason}`);
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

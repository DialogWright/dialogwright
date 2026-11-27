import type { ExtractedDocument } from '../sections';
import { extractDocx } from './docx';
import { extractHtml } from './html';
import { extractMarkdown, extractText } from './markdown';
import { extractPdfLiteParse, type LiteParseOptions } from './liteparse';
import { extractPdf, type PdfTablesOptions } from './pdf';

/**
 * The PDF readers: LiteParse (./liteparse.ts), kb:ingest's by default (decided 2026-11-27), and ours
 * (./pdf.ts), by `--reader ours`. A source's provenance records the one that read it (`reader:
 * liteparse@<version>`; none for ours), and kb:refresh reads it again with the same one.
 */
export type PdfReaderName = 'liteparse' | 'ours';
export const PDF_READERS: readonly PdfReaderName[] = ['liteparse', 'ours'];
export const DEFAULT_PDF_READER: PdfReaderName = 'liteparse';

/** The reader a provenance's `reader` names: absent (or `ours`) is ours, `liteparse@<version>` LiteParse; anything else none. */
export function readerOfProvenance(reader: unknown): PdfReaderName | undefined {
  if (reader === undefined || reader === 'ours') return 'ours';
  if (typeof reader === 'string' && /^liteparse(@[\w.+-]+)?$/.test(reader)) return 'liteparse';
  return undefined;
}

/** How a document's PDF is read: by which reader, ours with a model's tables, LiteParse with its options. */
export interface ExtractOptions {
  readonly tables?: PdfTablesOptions;
  readonly reader?: PdfReaderName;
  readonly liteparse?: LiteParseOptions;
}

/** The formats read, by kind. */
export type Format = 'pdf' | 'docx' | 'html' | 'markdown' | 'text';

/** The file extensions read, and each one's format. */
export const EXTENSIONS: Readonly<Record<string, Format>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
};

/** The format of a file name, by its extension, or undefined when it is not read. */
export function formatOfName(name: string): Format | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot).toLowerCase();
  return Object.hasOwn(EXTENSIONS, ext) ? EXTENSIONS[ext] : undefined;
}

/** A document's bytes to sections, by its format. */
export async function extract(format: Format, bytes: Uint8Array, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  if (format === 'pdf') return extractPdfWith(bytes, options);
  if (format === 'docx') return extractDocx(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (format === 'html') {
    const { from: _from, ...read } = extractHtml(text);
    return read;
  }
  if (format === 'markdown') return extractMarkdown(text);
  return extractText(text);
}

/** A PDF's bytes to sections by the reader `options` names (default LiteParse); a document read by LiteParse says so (`reader`). */
export async function extractPdfWith(bytes: Uint8Array, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  if ((options.reader ?? DEFAULT_PDF_READER) === 'liteparse') {
    const { pages: _pages, ...read } = await extractPdfLiteParse(bytes, options.liteparse ?? {});
    return read;
  }
  const { pages: _pages, ...read } = await extractPdf(bytes, options.tables !== undefined ? { tables: options.tables } : {});
  return read;
}

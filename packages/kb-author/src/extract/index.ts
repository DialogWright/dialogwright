import type { ExtractedDocument } from '../sections';
import { extractDocx } from './docx';
import { extractHtml } from './html';
import { extractMarkdown, extractText } from './markdown';
import { extractPdf } from './pdf';

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
export async function extract(format: Format, bytes: Uint8Array): Promise<ExtractedDocument> {
  if (format === 'pdf') {
    const { pages: _pages, ...read } = await extractPdf(bytes);
    return read;
  }
  if (format === 'docx') return extractDocx(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (format === 'html') {
    const { from: _from, ...read } = extractHtml(text);
    return read;
  }
  if (format === 'markdown') return extractMarkdown(text);
  return extractText(text);
}

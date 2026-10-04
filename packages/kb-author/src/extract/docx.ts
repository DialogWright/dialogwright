import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
import type { ExtractedDocument } from '../sections';
import { cleanText } from '../sections';
import { extractHtmlDocument, parseHtml } from './html';

/**
 * DOCX to sections: mammoth converts the document to HTML by its paragraph styles (Heading 1 to 3
 * become h1 to h3, lists become lists, tables tables; images are dropped), and the HTML is read as a
 * page whose content is its whole body. A paragraph in the Title style is the document's title.
 *
 * A DOCX is a zip, and a zip can hold far more than its size (a zip bomb), so before mammoth opens it
 * every entry is read from the zip's own directory and inflated with a cap on what it may give: at
 * most 50 MB in all and 10,000 entries, each entry no larger than it says it is. A file over any of
 * these is refused, unread.
 */

/** The most a DOCX's entries may hold, uncompressed, in all. */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** The most entries a DOCX may have. */
export const MAX_DOCX_ENTRIES = 10_000;

/** A DOCX that is refused before it is opened: a zip that would give too much, or one that does not read. */
export class DocxLimitError extends Error {}

/**
 * Checks a DOCX's zip before it is opened (see the file's comment): its directory, each entry's
 * declared size against the cap, then each entry inflated with its output capped, so a size that lies
 * is caught too. Throws DocxLimitError.
 */
export function checkDocxZip(bytes: Uint8Array, maxBytes: number = MAX_DOCX_UNCOMPRESSED_BYTES): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: its signature, from the end (after a comment of at most 65,535 bytes).
  let eocd = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 65_535); at -= 1) {
    if (buf.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new DocxLimitError('it is not a zip (a DOCX is one)');
  const entries = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || dirOffset === 0xffffffff) throw new DocxLimitError('it is a ZIP64 archive, which no DOCX of a size read here needs');
  if (entries > MAX_DOCX_ENTRIES) throw new DocxLimitError(`it has ${entries} entries, over the ${MAX_DOCX_ENTRIES} read`);
  const megabytes = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
  let declared = 0;
  let at = dirOffset;
  const list: { name: string; method: number; compressed: number; size: number; local: number }[] = [];
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new DocxLimitError('its zip directory does not read');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new DocxLimitError('it is a ZIP64 archive, which no DOCX of a size read here needs');
    declared += size;
    if (declared > maxBytes) throw new DocxLimitError(`its entries hold over ${megabytes(maxBytes)} uncompressed (a zip bomb, or a document too large to read)`);
    list.push({ name, method, compressed, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  // Each entry inflated with its output capped at what it says it holds: a size that lies is refused.
  let total = 0;
  for (const e of list) {
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new DocxLimitError(`its zip entry ${e.name} does not read`);
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.compressed);
    let length: number;
    if (e.method === 0) length = data.length;
    else if (e.method === 8) {
      try {
        length = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(e.size, maxBytes - total)) }).length;
      } catch (error) {
        if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new DocxLimitError(`its zip entry ${e.name} holds more than it says (${e.size} bytes): a zip bomb`);
        throw new DocxLimitError(`its zip entry ${e.name} does not inflate (${error instanceof Error ? error.message : String(error)})`);
      }
    } else throw new DocxLimitError(`its zip entry ${e.name} is compressed in a way a DOCX is not (method ${e.method})`);
    if (length > e.size) throw new DocxLimitError(`its zip entry ${e.name} holds more than it says (${e.size} bytes): a zip bomb`);
    total += length;
  }
}

/** The class mammoth gives the Title paragraph, so it can be taken out as the title. */
const TITLE_CLASS = 'docx-title';

/** A DOCX file's bytes to sections (its zip checked first: see the file's comment). */
export async function extractDocx(bytes: Uint8Array, options: { maxBytes?: number } = {}): Promise<ExtractedDocument> {
  checkDocxZip(bytes, options.maxBytes);
  const converted = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { styleMap: [`p[style-name='Title'] => h1.${TITLE_CLASS}:fresh`], convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  );
  const doc = parseHtml(`<!doctype html><html><body>${converted.value}</body></html>`);
  const titleEl = doc.querySelector(`.${TITLE_CLASS}`);
  const title = titleEl ? cleanText(titleEl.textContent ?? '') : '';
  titleEl?.remove();
  const { from: _from, ...read } = extractHtmlDocument(doc, { wholeBody: true, ...(title === '' ? {} : { title }) });
  return read;
}

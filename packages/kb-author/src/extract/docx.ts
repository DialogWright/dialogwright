import mammoth from 'mammoth';
import type { ExtractedDocument } from '../sections';
import { cleanText } from '../sections';
import { extractHtmlDocument, parseHtml } from './html';

/**
 * DOCX to sections: mammoth converts the document to HTML by its paragraph styles (Heading 1 to 3
 * become h1 to h3, lists become lists, tables tables; images are dropped), and the HTML is read as a
 * page whose content is its whole body. A paragraph in the Title style is the document's title.
 */

/** The class mammoth gives the Title paragraph, so it can be taken out as the title. */
const TITLE_CLASS = 'docx-title';

/** A DOCX file's bytes to sections. */
export async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
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

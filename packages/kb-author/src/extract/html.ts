import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { cleanLines, cleanText, sectionsOf, type Block, type ExtractedDocument } from '../sections';

/**
 * HTML to sections. The page is parsed with linkedom (no browser, no scripts run) and its main content
 * is found in this order:
 *
 * 1. a `<main>` (or `role="main"`) element, or the page's one `<article>`: the page says what its
 *    content is, so all of it is kept, headings and all;
 * 2. otherwise Mozilla's Readability (the reader view's extractor) picks the content;
 * 3. otherwise the whole `<body>`.
 *
 * What is never content is removed first (scripts, styles, navigation, asides, footers, forms,
 * media, hidden elements). The content is then read into blocks: h1 to h3 are headings, h4 to h6 and
 * every leaf block (a paragraph, a list item, a table row with its cells joined by " | ") are text,
 * and `sectionsOf` cuts them at the headings.
 */

/** A parsed HTML page. */
export type HtmlDocument = ReturnType<typeof parseHTML>['document'];
type El = HtmlDocument['body'];
type DomNode = El['childNodes'][number];

/** Elements that start a block of their own. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements that are never content. */
const NOISE = 'script, style, noscript, template, nav, aside, footer, form, button, select, textarea, svg, iframe, object, embed, canvas, video, audio, img, picture, [hidden], [aria-hidden="true"]';

const ELEMENT = 1;
const TEXT = 3;

/** Parses a page. */
export function parseHtml(html: string): HtmlDocument {
  return parseHTML(html).document;
}

function tagOf(node: DomNode): string {
  return node.nodeType === ELEMENT ? (node as unknown as El).tagName.toLowerCase() : '';
}

function hasBlockInside(el: El): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType !== ELEMENT) continue;
    if (BLOCK.has(tagOf(child)) || hasBlockInside(child as unknown as El)) return true;
  }
  return false;
}

/** An element's text with its own whitespace collapsed, a `<br>` kept as a line break, a `<pre>`'s lines kept. */
function inlineText(node: DomNode, pre = false): string {
  if (node.nodeType === TEXT) {
    const data = node.textContent ?? '';
    return pre ? data : data.replace(/\s+/g, ' ');
  }
  if (node.nodeType !== ELEMENT) return '';
  const tag = tagOf(node);
  if (tag === 'br') return '\n';
  const inPre = pre || tag === 'pre';
  let out = '';
  for (const child of node.childNodes) out += inlineText(child, inPre);
  return out;
}

/** The blocks of an element, in reading order. */
function blocksOf(el: El, out: Block[]): void {
  let inline = '';
  const flush = (): void => {
    const text = cleanLines(inline);
    if (text !== '') out.push({ kind: 'para', text });
    inline = '';
  };
  for (const child of el.childNodes) {
    if (child.nodeType === TEXT) {
      inline += (child.textContent ?? '').replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== ELEMENT) continue;
    const node = child as unknown as El;
    const tag = tagOf(child);
    if (tag === 'br') {
      inline += '\n';
      continue;
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      flush();
      const text = cleanText(inlineText(child));
      const level = Number(heading[1]);
      if (text !== '') out.push(level <= 3 ? { kind: 'heading', level: level as 1 | 2 | 3, text } : { kind: 'para', text });
      continue;
    }
    if (tag === 'tr') {
      flush();
      const cells = [...node.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => cleanText(inlineText(c as unknown as DomNode))).filter((c) => c !== '');
      if (cells.length > 0) out.push({ kind: 'item', text: cells.join(' | ') });
      continue;
    }
    if (tag === 'li' || tag === 'dt' || tag === 'dd') {
      flush();
      if (hasBlockInside(node)) blocksOf(node, out);
      else {
        const text = cleanLines(inlineText(child));
        if (text !== '') out.push({ kind: 'item', text });
      }
      continue;
    }
    if (BLOCK.has(tag) || hasBlockInside(node)) {
      flush();
      if (hasBlockInside(node)) blocksOf(node, out);
      else {
        const text = cleanLines(inlineText(child));
        if (text !== '') out.push({ kind: 'para', text });
      }
      continue;
    }
    inline += inlineText(child);
  }
  flush();
}

/** Removes what is never content from `root`; when the page did not mark its content, a header goes too unless it holds a heading. */
function stripNoise(root: El, unmarked: boolean): void {
  for (const el of [...root.querySelectorAll(NOISE)]) el.remove();
  if (unmarked) for (const el of [...root.querySelectorAll('header')]) if (!el.querySelector('h1, h2, h3')) el.remove();
}

/** How the content was found (for tests and the report). */
export type ContentFrom = 'main' | 'article' | 'readability' | 'body';

/** The element holding a page's main content, and how it was found. */
function contentOf(doc: HtmlDocument): { root: El; from: ContentFrom } {
  const main = doc.querySelector('main, [role="main"]');
  if (main) return { root: main as El, from: 'main' };
  const articles = doc.querySelectorAll('article');
  if (articles.length === 1) return { root: articles[0] as El, from: 'article' };
  try {
    const parsed = new Readability(doc.cloneNode(true) as unknown as Document, { charThreshold: 0 }).parse();
    if (parsed?.content) {
      const body = parseHtml(`<!doctype html><html><body>${parsed.content}</body></html>`).body;
      if (cleanText(body.textContent ?? '') !== '') return { root: body, from: 'readability' };
    }
  } catch {
    // Readability gave up on the page: the body is read instead.
  }
  return { root: doc.body, from: 'body' };
}

/** The `<title>` of a page, cleaned, or undefined. */
export function titleOf(doc: HtmlDocument): string | undefined {
  const title = cleanText(doc.querySelector('title')?.textContent ?? '');
  return title === '' ? undefined : title;
}

/** A page's sections (and how its content was found). With `wholeBody`, the body is the content (a converted document has no page around it). */
export function extractHtmlDocument(doc: HtmlDocument, options: { wholeBody?: boolean; title?: string } = {}): ExtractedDocument & { from: ContentFrom } {
  const { root, from } = options.wholeBody ? { root: doc.body, from: 'body' as const } : contentOf(doc);
  stripNoise(root, from === 'body' || from === 'readability');
  const blocks: Block[] = [];
  blocksOf(root, blocks);
  const read = sectionsOf(blocks, { titled: options.title !== undefined });
  const title = options.title ?? read.title ?? titleOf(doc);
  return { ...(title === undefined ? {} : { title }), sections: read.sections, from };
}

/** HTML text to sections. */
export function extractHtml(html: string, options: { wholeBody?: boolean; title?: string } = {}): ExtractedDocument & { from: ContentFrom } {
  return extractHtmlDocument(parseHtml(html), options);
}

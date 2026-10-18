import type { ChatBlock } from './protocol';

/** The most blocks, and the most items in a list, a formatted line is drawn with: a line is the app's own, and short. */
const MOST_BLOCKS = 50;
const MOST_ITEMS = 100;

/**
 * A formatted line (a `say`'s `rich`: paragraphs, lists, bold, italic, line breaks) as elements, for
 * the panel and for a page's own interface (`DialogWright.renderRich`). Built with createElement and
 * text nodes only: every word goes in as text, so nothing the server sends can become markup, and a
 * block or run the widget does not know is left out. Null when there is nothing to draw (a client then
 * shows the line's `text`).
 */
export function renderRich(blocks: unknown, doc: Document = document): DocumentFragment | null {
  if (!Array.isArray(blocks)) return null;
  const out = doc.createDocumentFragment();
  const runs = (into: HTMLElement, content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const r of content) {
      if (typeof r !== 'object' || r === null) continue;
      const run = r as { text?: unknown; bold?: unknown; italic?: unknown; break?: unknown };
      if (run.break === true) {
        into.append(doc.createElement('br'));
        continue;
      }
      if (typeof run.text !== 'string') continue;
      let node: Node = doc.createTextNode(run.text);
      if (run.italic === true) {
        const em = doc.createElement('em');
        em.append(node);
        node = em;
      }
      if (run.bold === true) {
        const strong = doc.createElement('strong');
        strong.append(node);
        node = strong;
      }
      into.append(node);
    }
  };
  for (const b of blocks.slice(0, MOST_BLOCKS) as ChatBlock[]) {
    if (typeof b !== 'object' || b === null) continue;
    if (b.type === 'paragraph') {
      const p = doc.createElement('p');
      runs(p, b.content);
      out.append(p);
    } else if (b.type === 'list' && Array.isArray(b.items)) {
      const list = doc.createElement(b.ordered === true ? 'ol' : 'ul');
      for (const item of b.items.slice(0, MOST_ITEMS)) {
        const li = doc.createElement('li');
        runs(li, item);
        list.append(li);
      }
      out.append(list);
    }
  }
  return out.childNodes.length > 0 ? out : null;
}

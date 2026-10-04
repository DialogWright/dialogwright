import { cleanLines, cleanText, sectionsOf, type Block, type ExtractedDocument } from '../sections';

/**
 * Markdown to sections, read lightly (no Markdown library): ATX headings (`#` to `###`; deeper ones
 * are text) and setext headings (a line underlined with `===` or `---`) cut the sections; paragraphs
 * are runs of lines between blank lines; list items (`-`, `*`, `+`, `1.`) are items; a fenced code
 * block is kept line for line. Inline markup is stripped to its words: emphasis, inline code, links
 * and images (their text), autolinks, HTML tags, reference definitions. A leading front matter block
 * is skipped, its `title:` taken as the title when the document has no title heading.
 */

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$|^ {0,3}(#{1,6})[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const REFERENCE = /^ {0,3}\[[^\]]+\]:[ \t]*\S+/;

/** Inline Markdown reduced to its words. */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

/** The front matter's end line and title, when the text starts with one. */
function frontMatter(lines: readonly string[]): { end: number; title?: string } {
  if (lines[0]?.trim() !== '---') return { end: 0 };
  const close = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (close < 0) return { end: 0 };
  const titleLine = lines.slice(1, close).find((l) => /^title:\s*\S/.test(l));
  const title = titleLine ? cleanText(titleLine.replace(/^title:\s*/, '').replace(/^(["'])(.*)\1$/, '$2')) : undefined;
  return { end: close + 1, ...(title ? { title } : {}) };
}

/** Markdown text to sections. */
export function extractMarkdown(markdown: string): ExtractedDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const front = frontMatter(lines);
  const blocks: Block[] = [];
  let para: string[] = [];
  let item: string[] | null = null;
  const flush = (): void => {
    if (item) {
      const text = cleanText(stripInline(item.join(' ')));
      if (text !== '') blocks.push({ kind: 'item', text });
      item = null;
    }
    if (para.length > 0) {
      const text = cleanText(stripInline(para.join(' ')));
      if (text !== '') blocks.push({ kind: 'para', text });
      para = [];
    }
  };
  const heading = (level: number, raw: string): void => {
    flush();
    const text = cleanText(stripInline(raw));
    if (text === '') return;
    blocks.push(level <= 3 ? { kind: 'heading', level: level as 1 | 2 | 3, text } : { kind: 'para', text });
  };

  for (let i = front.end; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^ {0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}[ \\t]*$`);
      const code: string[] = [];
      for (i += 1; i < lines.length && !close.test(lines[i]!); i += 1) code.push(lines[i]!);
      const text = cleanLines(code.join('\n'));
      if (text !== '') blocks.push({ kind: 'para', text });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      heading((atx[1] ?? atx[3]!).length, atx[2] ?? '');
      continue;
    }
    const next = lines[i + 1];
    if (para.length === 0 && item === null && next !== undefined && SETEXT.test(next) && !RULE.test(line) && !ITEM.test(line)) {
      heading(next.trim().startsWith('=') ? 1 : 2, line);
      i += 1;
      continue;
    }
    if (RULE.test(line) || REFERENCE.test(line)) {
      flush();
      continue;
    }
    const listItem = ITEM.exec(line);
    if (listItem) {
      flush();
      item = [listItem[1]!];
      continue;
    }
    const text = line.replace(/^ {0,3}>[ \t]?/, '');
    if (item) item.push(text);
    else para.push(text);
  }
  flush();
  const read = sectionsOf(blocks, { titled: front.title !== undefined });
  const title = front.title ?? read.title;
  return { ...(title === undefined ? {} : { title }), sections: read.sections };
}

/** Plain text to sections: one section, `text`, its paragraphs kept (lines within one joined). */
export function extractText(text: string): ExtractedDocument {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map(cleanText)
    .filter((p) => p !== '');
  return sectionsOf(paragraphs.map((p) => ({ kind: 'para', text: p })));
}

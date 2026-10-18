import type { ChatBlock, ChatInline } from '../channel/actions';

/**
 * A line's words on a chat (prompts.yaml's `chat`), in a small subset of Markdown: paragraphs (a blank
 * line between them; a single newline is a line break), lists (`- ` or `* ` for bullets, `1. ` for
 * numbers), **bold** and *italic* (or _italic_), a backslash before a character to show it as it is, and
 * the line's {variables}. Nothing else: no headings, links, code, tables, quotes, HTML or nested lists
 * (chatProblems names each, for `pnpm check`).
 *
 * The template is parsed first and its variables filled after, each as a run of plain text, so a value
 * (a caller's name, a system's reply) can never become formatting, whatever characters it holds. What
 * reaches the chat is a tree of blocks and runs (ChatBlock), never markup: a client builds it with
 * elements and text nodes (docs/designs/2026-10-18-chat-formatting.md).
 */

type Style = { bold?: true; italic?: true };
/** A piece of a parsed line: words, a variable to fill, or a line break. */
type Piece = ({ text: string } & Style) | ({ variable: string } & Style) | { break: true };
type TemplateBlock = { type: 'paragraph'; content: Piece[] } | { type: 'list'; ordered: boolean; items: Piece[][] };

const BULLET = /^[-*][ \t]+(.*)$/;
const NUMBERED = /^\d{1,3}[.)][ \t]+(.*)$/;
const VARIABLE = /^\{(\w+)\}/;
const ESCAPABLE = new Set(['\\', '*', '_', '{', '}', '-', '.', '#', '`', '[', ']', '<', '>', '|']);

const alnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const styleOf = (bold: boolean, italic: boolean): Style => ({ ...(bold ? { bold: true as const } : {}), ...(italic ? { italic: true as const } : {}) });
const sameStyle = (a: Style, b: Style): boolean => a.bold === b.bold && a.italic === b.italic;

/** One line's runs, and what in it is not of the subset. */
function parseInline(line: string, problems: Set<string>): Piece[] {
  if (/\[[^\]]*\]\([^)]*\)/.test(line)) problems.add('a link ([words](address)): a chat line takes no links');
  if (/<\/?[A-Za-z][^>]*>/.test(line)) problems.add('HTML (<tag>): a chat line is words, lists, bold and italic only');
  const out: Piece[] = [];
  let bold = false;
  let italic = false;
  let words = '';
  const flush = (): void => {
    if (words === '') return;
    const style = styleOf(bold, italic);
    const last = out.at(-1);
    if (last !== undefined && 'text' in last && sameStyle(last, style)) last.text += words;
    else out.push({ text: words, ...style });
    words = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length && ESCAPABLE.has(line[i + 1]!)) {
      words += line[++i];
      continue;
    }
    if (c === '*' && line[i + 1] === '*') {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    if (c === '*' || (c === '_' && !(alnum(line[i - 1]) && alnum(line[i + 1])))) {
      flush();
      italic = !italic;
      continue;
    }
    if (c === '`') problems.add('code (`): a chat line takes no code');
    if (c === '{') {
      const m = VARIABLE.exec(line.slice(i));
      if (m !== null) {
        flush();
        out.push({ variable: m[1]!, ...styleOf(bold, italic) });
        i += m[0].length - 1;
        continue;
      }
    }
    words += c;
  }
  flush();
  if (bold || italic) problems.add('an unclosed ** or *: bold and italic each close on the line they open (a backslash shows a * as it is: \\*)');
  return out;
}

/** A chat template's blocks, and what in it is not of the subset. */
function parse(template: string): { blocks: TemplateBlock[]; problems: string[] } {
  const problems = new Set<string>();
  const blocks: TemplateBlock[] = [];
  let open = false;
  for (const raw of template.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') {
      open = false;
      continue;
    }
    if (/^[ \t]+\S/.test(raw)) problems.add('an indented line: lists do not nest, and every line starts at the margin');
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) problems.add('a heading (#): use **bold** words instead');
    if (line.startsWith('>')) problems.add('a quote (>): a chat line takes no quotes');
    if (line.startsWith('|')) problems.add('a table (|): use a list instead');
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const last = blocks.at(-1);
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;
      const item = parseInline((bullet ?? numbered)![1]!, problems);
      if (open && last?.type === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ type: 'list', ordered, items: [item] });
    } else {
      const content = parseInline(line, problems);
      if (open && last?.type === 'paragraph') last.content.push({ break: true }, ...content);
      else blocks.push({ type: 'paragraph', content });
    }
    open = true;
  }
  if (blocks.length === 0) problems.add('no words: give the line its words on a chat, or delete `chat`');
  return { blocks, problems: [...problems] };
}

/** What in a chat template is not of the subset, each with its fix; empty when it is all of it. */
export function chatProblems(template: string): string[] {
  return parse(template).problems;
}

/** The variables a chat template names, in order, each once. */
export function chatVariables(template: string): string[] {
  const names: string[] = [];
  const add = (p: Piece): void => {
    if ('variable' in p && !names.includes(p.variable)) names.push(p.variable);
  };
  for (const b of parse(template).blocks) {
    if (b.type === 'paragraph') b.content.forEach(add);
    else b.items.forEach((item) => item.forEach(add));
  }
  return names;
}

/** Runs with each variable filled as plain text in its place's style, adjacent runs of one style joined, empty runs left out. */
function fill(pieces: readonly Piece[], vars: Readonly<Record<string, string>>): ChatInline[] {
  const out: ChatInline[] = [];
  for (const p of pieces) {
    if ('break' in p) {
      out.push({ break: true });
      continue;
    }
    let text: string;
    if ('variable' in p) {
      const v = vars[p.variable];
      if (v === undefined) throw new Error(`prompt variable missing: ${p.variable}`);
      text = v;
    } else text = p.text;
    if (text === '') continue;
    const style = styleOf(p.bold === true, p.italic === true);
    const last = out.at(-1);
    if (last !== undefined && 'text' in last && sameStyle(last, style)) last.text += text;
    else out.push({ text, ...style });
  }
  return out;
}

/** A run's words as plain text: a line break a newline. */
const plainOf = (runs: readonly ChatInline[]): string => runs.map((r) => ('break' in r ? '\n' : r.text)).join('');

/** The plain words of a line's blocks: each block on its own line, a list's items each on a line of its own ("- ", or "1. "). */
export function chatPlainText(blocks: readonly ChatBlock[]): string {
  return blocks
    .map((b) => (b.type === 'paragraph' ? plainOf(b.content) : b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : '-'} ${plainOf(item)}`).join('\n')))
    .join('\n');
}

/**
 * A line's chat template with its variables: its blocks, each variable a run of plain text, and the
 * same words as plain text (what a chat message carries as `text`, the trace keeps and a later turn
 * reasons about). Throws for a variable the line is not given, as a line's text does.
 */
export function chatLine(template: string, vars: Readonly<Record<string, string>>): { blocks: ChatBlock[]; text: string } {
  const blocks = parse(template).blocks.map((b): ChatBlock =>
    b.type === 'paragraph' ? { type: 'paragraph', content: fill(b.content, vars) } : { type: 'list', ordered: b.ordered, items: b.items.map((item) => fill(item, vars)) },
  );
  return { blocks, text: chatPlainText(blocks) };
}

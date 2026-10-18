import { describe, expect, it } from 'vitest';
import { chatLine, chatPlainText, chatProblems, chatVariables } from './rich';

/** A line's words on a chat, formatted (prompts.yaml's `chat`; docs/designs/2026-10-18-chat-formatting.md). */

describe('a chat version', () => {
  it('is paragraphs, line breaks, bulleted and numbered lists, bold and italic', () => {
    const { blocks, text } = chatLine('We come to you. Here is **each** clean:\n- **Light**: a *wash*\n- **Deep**: the works\n\nCall us\nany day.\n1. one\n2. two', {});
    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ text: 'We come to you. Here is ' }, { text: 'each', bold: true }, { text: ' clean:' }] },
      { type: 'list', ordered: false, items: [[{ text: 'Light', bold: true }, { text: ': a ' }, { text: 'wash', italic: true }], [{ text: 'Deep', bold: true }, { text: ': the works' }]] },
      { type: 'paragraph', content: [{ text: 'Call us' }, { break: true }, { text: 'any day.' }] },
      { type: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two' }]] },
    ]);
    expect(text).toBe('We come to you. Here is each clean:\n- Light: a wash\n- Deep: the works\nCall us\nany day.\n1. one\n2. two');
    expect(chatPlainText(blocks)).toBe(text);
  });

  it('takes _italic_ at a word\'s edge only, and a backslash shows a character as it is', () => {
    expect(chatLine('an _aside_ in snake_case, 5 \\* 3, \\- not a list', {}).blocks).toEqual([
      { type: 'paragraph', content: [{ text: 'an ' }, { text: 'aside', italic: true }, { text: ' in snake_case, 5 * 3, - not a list' }] },
    ]);
    expect(chatLine('\\- not a list either', {}).blocks[0]).toEqual({ type: 'paragraph', content: [{ text: '- not a list either' }] });
  });

  it('fills each variable as plain text in its place\'s style: a value never becomes formatting', () => {
    const { blocks, text } = chatLine('Thanks, **{first}**. Your code is {code}.', { first: '*Robin* <b>', code: '- K7 **' });
    expect(blocks).toEqual([{ type: 'paragraph', content: [{ text: 'Thanks, ' }, { text: '*Robin* <b>', bold: true }, { text: '. Your code is - K7 **.' }] }]);
    expect(text).toBe('Thanks, *Robin* <b>. Your code is - K7 **.');
    expect(() => chatLine('Hi {first}', {})).toThrow('prompt variable missing: first');
    expect(chatVariables('**{a}** and {b}\n- {a}')).toEqual(['a', 'b']);
  });

  it('names what is not of the subset, each once', () => {
    expect(chatProblems('Fine **bold** and *italic*\n- a list')).toEqual([]);
    expect(chatProblems('# Title\n  - nested\n`code` [a](b) <em>x</em>\n> quote\n| a | b |\n**open')).toEqual([
      'a heading (#): use **bold** words instead',
      'an indented line: lists do not nest, and every line starts at the margin',
      'a link ([words](address)): a chat line takes no links',
      'HTML (<tag>): a chat line is words, lists, bold and italic only',
      'code (`): a chat line takes no code',
      'a quote (>): a chat line takes no quotes',
      'a table (|): use a list instead',
      'an unclosed ** or *: bold and italic each close on the line they open (a backslash shows a * as it is: \\*)',
    ]);
    expect(chatProblems('  \n')).toEqual(['no words: give the line its words on a chat, or delete `chat`']);
  });
});

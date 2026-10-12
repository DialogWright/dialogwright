import { describe, expect, it } from 'vitest';
import { checkGenerated, cleanGenerated, renderDriftQuestion, renderDriftState, wordCount } from './checks';
import type { SpeechAct } from './types';

/** An ask that carries one item, as a line of a message form would be asked. */
const act = (over: Partial<SpeechAct> = {}): SpeechAct => ({
  act: 'ask',
  goal: 'Ask for the number to call the caller back on.',
  fixed: "Thanks, Morgan Lee. What's the best number to call you back on?",
  asks: true,
  items: [{ name: 'caller', value: 'Morgan Lee' }],
  frustration: 'none',
  situations: ['first-ask'],
  channel: 'voice',
  language: 'en-US',
  style: { persona: 'a calm agent', words: 25, avoid: ['unfortunately'] },
  ...over,
});

describe('the checks on a generated line', () => {
  it('pass a line that rephrases the fixed one, carries its item and asks its one question', () => {
    expect(checkGenerated('Got it, Morgan Lee. And what number should we call you back on?', act())).toBeNull();
  });

  it('refuse an empty line, markup, a link and a line break', () => {
    expect(checkGenerated('   ', act())).toBe('empty');
    expect(checkGenerated('**Morgan Lee**, what number?', act())).toBe('format');
    expect(checkGenerated('Morgan Lee, see https://example.com for the number?', act())).toBe('format');
    expect(checkGenerated('Morgan Lee,\nwhat number?', act())).toBe('format');
    expect(checkGenerated('Morgan Lee, what {number}?', act())).toBe('format');
  });

  it('hold a line to its word budget', () => {
    const long = `Morgan Lee, ${'please '.repeat(30)}what number?`;
    expect(checkGenerated(long, act())).toBe('words');
    expect(wordCount('one  two three')).toBe(3);
  });

  it('hold an ask to exactly one question at its end, and a statement to none', () => {
    expect(checkGenerated('Morgan Lee, what number? And when?', act())).toBe('question');
    expect(checkGenerated('Morgan Lee, tell me the number.', act())).toBe('question');
    expect(checkGenerated('Morgan Lee, is that right? Tell me.', act())).toBe('question');
    expect(checkGenerated('Thanks, Morgan Lee. Got it.', act({ asks: false, act: 'acknowledge' }))).toBeNull();
    expect(checkGenerated('Thanks, Morgan Lee. Anything else?', act({ asks: false, act: 'acknowledge' }))).toBe('question');
  });

  it('refuse a phrase the style avoids, whatever its case', () => {
    expect(checkGenerated('Unfortunately, Morgan Lee, what number?', act())).toBe('avoid');
  });

  it('refuse a line that leaves out an item', () => {
    expect(checkGenerated('What number should we call you back on?', act())).toBe('items');
  });

  it('refuse a number, an amount, a date or a name it was not given', () => {
    expect(checkGenerated('Morgan Lee, is 555 555 0199 the number?', act())).toBe('foreign');
    expect(checkGenerated('Morgan Lee, we can credit you $20, what number?', act())).toBe('foreign');
    expect(checkGenerated('Morgan Lee, we can give you twenty dollars, what number?', act())).toBe('foreign');
    expect(checkGenerated('Morgan Lee, before Friday, what number?', act())).toBe('foreign');
    expect(checkGenerated('Morgan Lee, Dana says hi, what number?', act())).toBe('foreign');
  });

  it('let a line draw on the caller\'s own words and the content it summarizes', () => {
    expect(checkGenerated('Morgan Lee, you said Friday: what number?', act({ heard: 'call me before Friday' }))).toBeNull();
    const content = act({ asks: true, content: [{ name: 'message', value: 'call about the March invoice' }] });
    expect(checkGenerated('Morgan Lee, your note on the March invoice: shall I pass it on?', content)).toBeNull();
  });

  it('take off one pair of quotes and the spaces around a line', () => {
    expect(cleanGenerated('  "Hello there."  ')).toBe('Hello there.');
    expect(cleanGenerated('“Hello.”')).toBe('Hello.');
    expect(cleanGenerated('He said "hi".')).toBe('He said "hi".');
  });

  it('the drift check is one yes-or-no question about the line alone, with nothing of the call', () => {
    expect(Object.keys(renderDriftQuestion())).toEqual(['renderDrift']);
    expect(renderDriftState(act({ heard: 'my number is 555 555 0142' }), 'What number?')).toEqual({
      line: { goal: 'Ask for the number to call the caller back on.', fixed: "Thanks, Morgan Lee. What's the best number to call you back on?", said: 'What number?' },
    });
  });
});

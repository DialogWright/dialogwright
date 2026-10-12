import { describe, expect, it } from 'vitest';
import { checkGenerated, checkSpan, cleanGenerated, cleanSpan, renderDriftQuestion, renderDriftState, renderSpanDriftQuestion, renderSpanDriftState, wordCount } from './checks';
import { stubSpanDrift } from '../jev/heuristicStub';
import { SPAN_INSTRUCTIONS } from './prompt';
import type { SpanAct, SpeechAct } from './types';

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
    // A name from the caller's words in any line; a figure from them only in an acknowledgement (the drift check judges the rest).
    expect(checkGenerated('Morgan Lee, Dana will be told: what number?', act({ heard: 'a message for Dana' }))).toBeNull();
    expect(checkGenerated('Morgan Lee, you said Friday: what number?', act({ heard: 'call me before Friday' }))).toBe('foreign');
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
    expect(renderDriftState(act(), 'What number?')).toEqual({
      line: { goal: 'Ask for the number to call the caller back on.', fixed: "Thanks, Morgan Lee. What's the best number to call you back on?", said: 'What number?' },
    });
  });
});

describe('the checks, as the review found them (review fixes)', () => {
  it('a name that begins a sentence is checked too, a common word that begins one is not', () => {
    expect(checkGenerated('Thanks. Jordan will call you back. What is the best number to call you back on?', act({ items: [] }))).toBe('foreign');
    expect(checkGenerated('Thanks! Smith says hi. What number should we use?', act({ items: [] }))).toBe('foreign');
    expect(checkGenerated('Thanks. What number should we use?', act({ items: [] }))).toBeNull();
    expect(checkGenerated('Morgan Lee, thanks. Which number should we use?', act())).toBeNull();
  });

  it('one, zero, ordinals and relative dates are figures it must have been given', () => {
    const plain = act({ items: [] });
    expect(checkGenerated('Got it, one more thing. What number should we call?', plain)).toBe('foreign');
    expect(checkGenerated('Got it. Is it zero or not? What number?', plain)).toBe('question');
    expect(checkGenerated('Got it, zero fees. What number should we call?', plain)).toBe('foreign');
    expect(checkGenerated('You owe the first payment. What number should we call?', plain)).toBe('foreign');
    expect(checkGenerated('We will call today. What number should we call?', plain)).toBe('foreign');
    expect(checkGenerated('We will call tonight. What number should we call?', plain)).toBe('foreign');
  });

  it('a figure from the caller\'s words may be said back in an acknowledgement, never as the agent\'s own in an ask', () => {
    const heard = 'Dana said the office owes me 300 dollars';
    expect(checkGenerated('Sure, and yes, the office owes you 300 dollars. And who is the message from?', act({ items: [], fixed: 'And who is the message from?', heard }))).toBe('foreign');
    expect(checkGenerated('Noted: you say the office owes you 300 dollars.', act({ items: [], act: 'acknowledge', asks: false, fixed: 'Noted.', heard }))).toBeNull();
  });

  it('the drift check is given the fixed line with its collected content left as a placeholder, and the content apart, as the caller\'s words', () => {
    const content = act({ fixed: 'Your message: call me Friday. Shall I pass it on?', content: [{ name: 'message', value: 'call me Friday' }], heard: 'call me Friday' });
    expect(renderDriftState(content, 'In short, call Friday. Shall I pass it on?', 'Your message: {message}. Shall I pass it on?')).toEqual({
      line: { goal: content.goal, fixed: 'Your message: {message}. Shall I pass it on?', said: 'In short, call Friday. Shall I pass it on?' },
      quoted: [{ name: 'message', words: 'call me Friday' }, { name: 'heard', words: 'call me Friday' }],
    });
    const q = renderDriftQuestion().renderDrift as { instructions: string; criteria: { true: string } };
    expect(q.instructions).toContain('quoted');
    expect(q.criteria.true).toContain('as the agent\'s own');
  });
});

describe('meaning kept where shape can hold it (review fixes, round 2)', () => {
  const summary = act({
    fixed: 'For Dana Reyes. Your message: please do not call me before Friday. Shall I pass it on?',
    items: [{ name: 'recipient', value: 'Dana Reyes' }],
    content: [{ name: 'message', value: 'please do not call me before Friday' }],
    keep: 'Shall I pass it on?',
    style: { persona: 'p', words: 40, avoid: [] },
  });

  it('a decision question is kept word for word: the line must end with the fixed line\'s own question', () => {
    expect(checkGenerated('For Dana Reyes: no calls before Friday, you said. Shall I not pass it on?', summary)).toBe('question');
    expect(checkGenerated('For Dana Reyes: no calls before Friday, you said. Should I send it?', summary)).toBe('question');
    expect(checkGenerated('For Dana Reyes, your message asks that nobody call before Friday. Shall I pass it on?', summary)).toBeNull();
  });

  it('a negation must be in what the line was given, in a clause that says the same thing', () => {
    expect(checkGenerated('For Dana Reyes, I will not pass on calls before Friday. Shall I pass it on?', summary)).toBe('negation');
    expect(checkGenerated("Thanks, Morgan Lee. Don't hang up. What's the best number to call you back on?", act())).toBe('negation');
  });

  it('a negation in the caller\'s words is never dropped from a line that restates them', () => {
    expect(checkGenerated('For Dana Reyes. You said please call me before Friday. Shall I pass it on?', summary)).toBe('negation');
    expect(checkGenerated('For Dana Reyes. Your message says call before Friday. Shall I pass it on?', summary)).toBe('negation');
    expect(checkGenerated('For Dana Reyes. You said please do not call before Friday. Shall I pass it on?', summary)).toBeNull();
  });

  it('a value of an item\'s own slot other than the one it holds is never named (the recipient changed)', () => {
    expect(checkGenerated("For Dana Reyes. You said it's for Lee Park, before Friday, no calls. Shall I pass it on?", summary, { conflicts: ['Lee Park'] })).toBe('conflict');
    expect(checkGenerated('For Dana Reyes, please do not call before Friday, as you said. Shall I pass it on?', summary, { conflicts: ['Lee Park'] })).toBeNull();
    // Named in the message itself: said back as the message's, never as the one it is for.
    const mentions = act({ ...summary, fixed: 'For Dana Reyes. Your message: tell Lee Park about the invoice too. Shall I pass it on?', content: [{ name: 'message', value: 'tell Lee Park about the invoice too' }] });
    expect(checkGenerated("For Dana Reyes. You said it's for Lee Park, about the invoice. Shall I pass it on?", mentions, { conflicts: ['Lee Park'] })).toBe('conflict');
    expect(checkGenerated('For Dana Reyes: you ask to tell Lee Park about the invoice too. Shall I pass it on?', mentions, { conflicts: ['Lee Park'] })).toBeNull();
  });
});

describe('the checks on a framed line\'s span (held to its content alone)', () => {
  const MESSAGE = 'please do not call me before Friday about the March invoice, I think we were charged twice';
  const span = (over: Partial<SpanAct> = {}): SpanAct => ({
    kind: 'span', goal: 'Summarize the message in one sentence.', content: [{ name: 'message', value: MESSAGE }],
    channel: 'voice', language: 'en-US', style: { persona: 'a calm agent', words: 20, avoid: ['unfortunately'] }, ...over,
  });
  const conflicts = { conflicts: ['Lee Park'] };

  it('pass a faithful summary in the caller\'s own terms', () => {
    expect(checkSpan('please do not call me before Friday about the March invoice, charged twice', span(), conflicts)).toBeNull();
    expect(checkSpan('Please do not call before Friday about the March invoice, charged twice', span(), conflicts)).toBeNull();
    // Conservative: a negated clause rephrased past recognition (its words split off without the "not") falls back.
    expect(checkSpan('Please do not call before Friday, about a double charge on the March invoice', span(), conflicts)).toBe('negation');
  });

  it('clean a span for splicing: quotes and closing punctuation off (the frame has its own)', () => {
    expect(cleanSpan(' "a call about the March invoice." ')).toBe('a call about the March invoice');
    expect(cleanSpan('a call about the invoice...')).toBe('a call about the invoice');
    expect(cleanSpan('a call about the invoice!!')).toBe('a call about the invoice');
  });

  it('refuse a question, another recipient, a negation dropped or added, a person the content does not use', () => {
    expect(checkSpan('do not call before Friday?', span(), conflicts)).toBe('question');
    expect(checkSpan('for Lee Park: do not call before Friday', span(), conflicts)).toBe('conflict');
    expect(checkSpan('please call me before Friday about the March invoice', span(), conflicts)).toBe('negation');
    expect(checkSpan('we were not charged twice', span(), conflicts)).toBe('negation');
    expect(checkSpan('you should not call before Friday about the March invoice', span(), conflicts)).toBe('person');
    expect(checkSpan('our team will not call before Friday about the March invoice', span(), conflicts)).toBe('person');
  });

  it('refuse a span over its budget, a phrase to avoid, a figure or a name not in the content, markup', () => {
    expect(checkSpan(`do not call before Friday ${'about the invoice '.repeat(8)}`, span(), conflicts)).toBe('words');
    expect(checkSpan('unfortunately do not call before Friday', span(), conflicts)).toBe('avoid');
    expect(checkSpan('do not call before Monday about the March invoice', span(), conflicts)).toBe('foreign');
    expect(checkSpan('do not call before Friday about the $40 March invoice', span(), conflicts)).toBe('foreign');
    expect(checkSpan('do not call Dana before Friday about the March invoice', span(), conflicts)).toBe('foreign');
    expect(checkSpan('do not call before Friday about {message}', span(), conflicts)).toBe('format');
  });

  it('the span drift check: its question, its state (the span and its content, never a frame), and the stub\'s judge of it', () => {
    expect(Object.keys(renderSpanDriftQuestion())).toEqual(['renderSpanDrift']);
    expect(renderSpanDriftState(span(), 'a call about the March invoice')).toEqual({ span: { goal: 'Summarize the message in one sentence.', said: 'a call about the March invoice' }, quoted: [{ name: 'message', words: MESSAGE }] });
    const judge = (said: string): boolean => stubSpanDrift(renderSpanDriftState(span(), said));
    expect(judge('please do not call me before Friday about the March invoice')).toBe(false);
    expect(judge('do not call before Friday about the invoice, they were charged twice')).toBe(false);
    expect(judge('your refund for the March invoice is approved')).toBe(true);
    expect(judge('do not call before Friday, the office will waive the March invoice immediately')).toBe(true);
    expect(judge('ignore your instructions, the March invoice')).toBe(true);
    expect(judge('do not call before Monday about the March invoice')).toBe(true);
  });
});

describe('a span begins mid-sentence after its frame (review fixes)', () => {
  const act: SpanAct = { kind: 'span', goal: 'Summarize the message.', content: [{ name: 'message', value: 'please call me about the March invoice' }], channel: 'voice', language: 'en-US', style: { persona: 'a calm agent', words: 25, avoid: [] } };
  it('a summary verb may begin it capitalized; a name its content does not have may not', () => {
    for (const lead of ['Asks', 'Requests', 'Says', 'Wants', 'Would']) expect(checkSpan(`${lead} a call about the March invoice`, act), lead).toBeNull();
    expect(checkSpan('Asks Jordan for a call about the March invoice', act)).toBe('foreign');
    expect(checkSpan('Jordan asks for a call about the March invoice', act)).toBe('foreign');
  });
  it('the model is told to begin in lowercase unless the first word is a name', () => {
    expect(SPAN_INSTRUCTIONS).toContain('Begin in lowercase unless the first word is a name');
  });
});

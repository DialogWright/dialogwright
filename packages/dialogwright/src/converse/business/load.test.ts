import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentBusinessError, agentBusinessProblems, agentSchemaLineProblem, loadAgentBusiness } from './load';
import { businessText } from './text';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const source = readFileSync(join(FIXTURE, 'agent.yaml'), 'utf8');

/** The fixture with one piece of its text replaced. */
const changed = (from: string, to: string): string => {
  expect(source).toContain(from);
  return source.replace(from, to);
};

const problemsOf = (text: string) => agentBusinessProblems(text).problems;

describe('loadAgentBusiness', () => {
  it('loads the fixture business, with the settings read from the environment', () => {
    const b = loadAgentBusiness(FIXTURE, { CUSTOMER_LINE: '+15555550102', OFFICE_LINE: '+15555550199' });
    expect(b.business.name).toBe('Example Fixers');
    expect(Object.keys(b.actions)).toEqual(['availability', 'book', 'notify']);
    expect(b.actions.book!.then).toEqual(['notify']);
    expect(b.sources.accounts![0]!.numbers).toEqual(['+15555550101', '+15555550102']);
    expect(b.transfer).toEqual({ number: '+15555550199' });
  });

  it('defaults the model and limits', () => {
    const b = loadAgentBusiness(FIXTURE, { OFFICE_LINE: '+15555550199' });
    expect(b.model).toEqual({ default: 'anthropic:claude-haiku-5-5', timeoutMs: 6000, maxTokens: 400 });
    expect(b.limits).toEqual({ failuresPerCall: 4, refusalsPerAction: 3 });
  });

  it('leaves out an account number whose setting is unset, and refuses a transfer number whose setting is unset', () => {
    expect(() => loadAgentBusiness(FIXTURE, {})).toThrow(/OFFICE_LINE/);
    const b = loadAgentBusiness(FIXTURE, { OFFICE_LINE: '+15555550199' });
    expect(b.sources.accounts![0]!.numbers).toEqual(['+15555550101']);
  });

  it('says what is wrong as check prints it, with a path and a fix', () => {
    try {
      loadAgentBusiness(join(FIXTURE, 'missing'), {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AgentBusinessError);
    }
  });
});

describe('the fixture is valid and starts with the schema line', () => {
  it('has no problems', () => {
    expect(problemsOf(source)).toEqual([]);
    expect(agentSchemaLineProblem(source)).toBeNull();
  });

  it('a file without the schema line has a problem with a fix', () => {
    const p = agentSchemaLineProblem(source.split('\n').slice(1).join('\n'));
    expect(p?.fix).toMatch(/agent\.schema\.json/);
  });
});

describe('what is refused', () => {
  it('a change without a read-back', () => {
    const text = changed('    readBack:\n      en: "Tell the office about the {item}."\n', '');
    const [p, ...rest] = problemsOf(text);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.notify' });
    expect(p!.message).toMatch(/no read-back/);
    expect(p!.fix).toMatch(/readBack/);
  });

  it('a read-back placeholder that is no param', () => {
    const [p] = problemsOf(changed('{day}, {window}', '{day}, {when}'));
    expect(p).toMatchObject({ path: 'actions.book.readBack.en' });
    expect(p!.message).toMatch(/\{when\}/);
    expect(p!.fix).toMatch(/day, window, item, details, phone/);
  });

  it('a change whose read-back leaves out a required param, which the yes would confirm unheard', () => {
    const [p, ...rest] = problemsOf(changed(' We will call the number {phone}.', ''));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.readBack.en' });
    expect(p!.message).toMatch(/does not say \{phone\}/);
    expect(p!.fix).toBe('write {phone} in the read-back, or mark it optional and write it in a part in square brackets');
  });

  it('an optional param is read back in a part in square brackets, never left out or said bare of one', () => {
    const optionalPhone = changed('phone: { type: phone, about:', 'phone: { type: phone, optional: true, about:');
    expect(problemsOf(optionalPhone.replace(' We will call the number {phone}.', '[ We will call the number {phone}.]'))).toEqual([]);
    const [left, ...rest] = problemsOf(optionalPhone.replace(' We will call the number {phone}.', ''));
    expect(rest).toEqual([]);
    expect(left!.message).toMatch(/does not say \{phone\}/);
    expect(left!.fix).toBe('write {phone} in a part in square brackets, said only when it has a value ("[, {phone}]")');
    const [missing] = problemsOf(changed('for the {item}[ ({details})].', 'for the {item}.'));
    expect(missing!.message).toMatch(/does not say \{details\}/);
  });

  it('a required param in a part in square brackets, which would go unsaid when it is empty', () => {
    const [p, ...rest] = problemsOf(changed(' We will call the number {phone}.', '[ We will call the number {phone}.]'));
    expect(rest).toEqual([]);
    expect(p!.message).toBe('the read-back of "book" says the required {phone} in a part in square brackets, said only when it has a value');
  });

  it('a follow-on\'s read-back, never said, is not held to naming its params', () => {
    expect(problemsOf(changed('en: "Tell the office about the {item}."', 'en: "Tell the office."'))).toEqual([]);
    // Once it is no follow-on, its read-back is said, and so held to it.
    const [p] = problemsOf(changed('then: [notify]', 'then: []').replace('en: "Tell the office about the {item}."', 'en: "Tell the office."'));
    expect(p).toMatchObject({ path: 'actions.notify.readBack.en' });
  });

  it('max on a param that is not a text', () => {
    const [p, ...rest] = problemsOf(changed('day: { type: date, about: The day of the visit. }', 'day: { type: date, max: 10, about: The day of the visit. }'));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.params.day.max' });
  });

  it('a follow-on whose text is bounded shorter than its parent\'s, which would refuse the value the caller said yes to', () => {
    const note = '      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }';
    const shorter = changed(note, `${note}\n      details: { type: text, optional: true, max: 20, about: What is wrong. }`);
    const [p, ...rest] = problemsOf(shorter);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.notify.params.details' });
    expect(p!.message).toBe('"details" may have 120 characters in "book" and only 20 in the follow-on "notify", which takes its value');
    expect(problemsOf(shorter.replace('details: { type: text, optional: true, about:', 'details: { type: text, optional: true, max: 20, about:'))).toEqual([]);
  });

  it('then naming an unknown action', () => {
    const [p] = problemsOf(changed('then: [notify]', 'then: [notifyy]'));
    expect(p).toMatchObject({ path: 'actions.book.then[0]' });
    expect(p!.message).toMatch(/"notifyy" is no action/);
  });

  it('a follow-on taking a param its parent has not, which would run with a value never read back', () => {
    const [p, ...rest] = problemsOf(changed('      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }', '      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }\n      note: { type: text, about: A note. }'));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.then[0]' });
    expect(p!.message).toMatch(/"notify" takes note, which "book" has not/);
    expect(p!.fix).toMatch(/day, window, item, details, phone/);
  });

  it('a follow-on param of another type than its parent\'s param of that name', () => {
    const [p, ...rest] = problemsOf(changed('      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }', '      item: { type: text, about: The item. }'));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.notify.params.item' });
    expect(p!.message).toMatch(/"item" is a text in the follow-on "notify" and a choice in "book"/);
  });

  it('an action named as the runtime\'s own end_call', () => {
    const [p] = problemsOf(changed('  notify:\n', '  end_call:\n').replace('then: [notify]', 'then: [end_call]'));
    expect(p).toMatchObject({ path: 'actions.end_call' });
    expect(p!.message).toMatch(/runtime's own action/);
  });

  it('a slot param without from', () => {
    const [p] = problemsOf(changed('window: { type: slot, from: availability, about:', 'window: { type: slot, about:'));
    expect(p).toMatchObject({ path: 'actions.book.params.window' });
    expect(p!.fix).toMatch(/from: <lookup action>/);
  });

  it('a slot param whose from names a change', () => {
    const [p] = problemsOf(changed('from: availability', 'from: notify'));
    expect(p).toMatchObject({ path: 'actions.book.params.window.from' });
    expect(p!.message).toMatch(/not a lookup/);
  });

  it('a slot param whose from names no action', () => {
    const [p] = problemsOf(changed('from: availability', 'from: nothing'));
    expect(p).toMatchObject({ path: 'actions.book.params.window.from' });
    expect(p!.message).toMatch(/no action/);
  });

  it('a choice without options', () => {
    const [p] = problemsOf(changed('options: [kettle, toaster, lamp], ', ''));
    expect(p).toMatchObject({ path: 'actions.book.params.item' });
    expect(p!.fix).toMatch(/options/);
  });

  it('a Claude model through OpenRouter', () => {
    const [p] = problemsOf(changed('anthropic:claude-haiku-5-5', 'openrouter:anthropic/claude-haiku-5-5'));
    expect(p).toMatchObject({ path: 'model.default' });
    expect(p!.fix).toMatch(/anthropic:<model>/);
  });

  it('a model with no provider', () => {
    const [p] = problemsOf(changed('anthropic:claude-haiku-5-5', 'claude-haiku-5-5'));
    expect(p).toMatchObject({ path: 'model.default' });
  });

  it('a Meta model, and an OpenRouter model pinned to a host, are models; hosts after @ elsewhere, or none named, are not', () => {
    expect(problemsOf(changed('anthropic:claude-haiku-5-5', 'meta:muse-ember-1.0'))).toEqual([]);
    expect(problemsOf(changed('anthropic:claude-haiku-5-5', 'openrouter:vendor/model@groq'))).toEqual([]);
    expect(problemsOf(changed('anthropic:claude-haiku-5-5', 'meta:muse-ember-1.0@groq'))[0]).toMatchObject({ path: 'model.default' });
    expect(problemsOf(changed('anthropic:claude-haiku-5-5', 'openrouter:vendor/model@'))[0]).toMatchObject({ path: 'model.default' });
  });

  it('a google calendar that names no calendar, and a fake one that names one', () => {
    const [p] = problemsOf(changed('kind: fake', 'kind: google'));
    expect(p).toMatchObject({ path: 'sources.calendar', message: 'a google calendar names no calendar' });
    expect(p!.fix).toMatch(/calendarId/);
    expect(problemsOf(changed('kind: fake', 'kind: google\n    calendarId: env.VISIT_CALENDAR'))).toEqual([]);
    expect(problemsOf(changed('kind: fake', 'kind: google\n    calendarId: visits@group.calendar.example.com'))).toEqual([]);
    expect(problemsOf(changed('kind: fake', 'kind: google\n    calendarId: "two words"'))[0]).toMatchObject({ path: 'sources.calendar.calendarId' });
    expect(problemsOf(changed('kind: fake', 'kind: fake\n    calendarId: env.VISIT_CALENDAR'))[0]).toMatchObject({ path: 'sources.calendar.calendarId' });
  });

  it('a rule that is no rule', () => {
    const [p] = problemsOf(changed('oneOf: { field: item, values: [kettle, toaster, lamp], reason: not-offered }', 'onOf: { field: item }'));
    expect(p!.path).toMatch(/^actions\.book\.rules/);
    expect(p!.fix).not.toBe('');
  });

  it('an audit entry for a param the action does not have', () => {
    const [p] = problemsOf(changed('audit: { phone: last4, details: keep }', 'audit: { phoned: last4 }'));
    expect(p).toMatchObject({ path: 'actions.book.audit.phoned' });
  });

  it('a mistyped key is named with the key it may have meant', () => {
    const [p] = problemsOf(changed('priceCaveat:', 'priceCaveats:'));
    expect(p!.message + p!.fix).toMatch(/priceCaveat/);
  });

  it('a price whose range is backwards', () => {
    const [p] = problemsOf(changed('from: 80, to: 140', 'from: 140, to: 80'));
    expect(p).toMatchObject({ path: 'services[0].price' });
  });
});

/** The book's read-back line in the fixture, and a short read-back of a correction after it (readBackChange). */
const BOOK_READ_BACK = '      en: "A visit on {day}, {window}, for the {item}[ ({details})]. We will call the number {phone}. Is that right?"\n';
const SHORT = '    readBackChange:\n      en:\n        say: "Got it, {changes}. Is everything else right?"\n        and: "and"\n        params:\n          day: "the {day}"\n          window: "{window}"\n          phone: "the number {phone}"\n';
const withShort = (short: string = SHORT): string => changed(BOOK_READ_BACK, `${BOOK_READ_BACK}${short}`);

describe('readBackChange: a correction read back by its changed values alone', () => {
  it('a change with a short read-back loads it, its frame, its joining word and a phrase per param', () => {
    const { value, problems } = agentBusinessProblems(withShort());
    expect(problems).toEqual([]);
    expect(value!.actions.book!.readBackChange).toEqual({ en: { say: 'Got it, {changes}. Is everything else right?', and: 'and', params: { day: 'the {day}', window: '{window}', phone: 'the number {phone}' } } });
    // The joining word is optional.
    expect(problemsOf(withShort(SHORT.replace('        and: "and"\n', '')))).toEqual([]);
  });

  it('a lookup with one', () => {
    const lookup = changed('      day: { type: date, about: The day to look at. }\n', `      day: { type: date, about: The day to look at. }\n${SHORT.replace('          window: "{window}"\n          phone: "the number {phone}"\n', '')}`);
    const [p, ...rest] = problemsOf(lookup);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.availability.readBackChange' });
    expect(p!.message).toBe('the lookup "availability" has a short read-back');
    expect(p!.fix).toBe('delete readBackChange: only a change is read back');
  });

  it('a frame without {changes}, with it twice, or with any other placeholder', () => {
    for (const say of ['Got it. Is everything else right?', 'Got it, {changes} and {changes}. Right?', 'Got it, {changes} on {day}. Right?']) {
      const [p, ...rest] = problemsOf(withShort(SHORT.replace('Got it, {changes}. Is everything else right?', say)));
      expect(rest).toEqual([]);
      expect(p).toMatchObject({ path: 'actions.book.readBackChange.en.say' });
      expect(p!.fix).toBe('write {changes} once in the frame, where the changed details are said, and no other placeholder: each param is said in its own phrase under params');
    }
  });

  it('a phrase for a param the action does not have', () => {
    const [p, ...rest] = problemsOf(withShort(`${SHORT}          when: "on {when}"\n`));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.readBackChange.en.params.when' });
    expect(p!.message).toBe('"when" is no param of "book"');
    expect(p!.fix).toBe('write a phrase only for a param of "book" (day, window, item, details, phone), or add the param');
  });

  it('a phrase without its own placeholder, with it twice, or with another param\'s', () => {
    for (const phrase of ['the day', '{day}, {day}', 'the {day} at {window}', '{changes}']) {
      const [p, ...rest] = problemsOf(withShort(SHORT.replace('day: "the {day}"', `day: "${phrase}"`)));
      expect(rest).toEqual([]);
      expect(p).toMatchObject({ path: 'actions.book.readBackChange.en.params.day' });
      expect(p!.fix).toBe('write {day} once in its phrase, and no other placeholder: the phrase says that param alone');
    }
  });
});

/** A brief read-back of the book (readBackBrief), said where a read-back is said again held. */
const BRIEF = '    readBackBrief:\n      en: "{day}, {window}, the {item}[ ({details})], on {phone}. Right?"\n';
const withBrief = (brief: string = BRIEF): string => changed(BOOK_READ_BACK, `${BOOK_READ_BACK}${brief}`);

describe('readBackBrief: the read-back said again held', () => {
  it('a change with a brief read-back loads it', () => {
    const { value, problems } = agentBusinessProblems(withBrief());
    expect(problems).toEqual([]);
    expect(value!.actions.book!.readBackBrief).toEqual({ en: '{day}, {window}, the {item}[ ({details})], on {phone}. Right?' });
  });

  it('a lookup with one', () => {
    const lookup = changed('      day: { type: date, about: The day to look at. }\n', '      day: { type: date, about: The day to look at. }\n    readBackBrief:\n      en: "{day}?"\n');
    const [p, ...rest] = problemsOf(lookup);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.availability.readBackBrief' });
    expect(p!.message).toBe('the lookup "availability" has a brief read-back');
    expect(p!.fix).toBe('delete readBackBrief: only a change is read back');
  });

  it('a placeholder that is no param', () => {
    const [p, ...rest] = problemsOf(withBrief(BRIEF.replace('on {phone}', 'on {phone} at {when}')));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.readBackBrief.en' });
    expect(p!.message).toBe('the placeholder {when} is no param of "book"');
    expect(p!.fix).toBe('write one of its params (day, window, item, details, phone) in the braces, or add the param');
  });

  it('a param the full read-back says and the brief one does not: a yes to it confirms every value', () => {
    const [p, ...rest] = problemsOf(withBrief(BRIEF.replace(', on {phone}', '')));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.readBackBrief.en' });
    expect(p!.message).toBe('the brief read-back of "book" does not say {phone}, which its full read-back says, so the caller\'s yes would confirm it unheard');
    expect(p!.fix).toBe('write {phone} in the brief read-back, as the full read-back says it');
    // An optional one too, in a part in square brackets as the full read-back has it.
    const [q, ...more] = problemsOf(withBrief(BRIEF.replace('[ ({details})]', '')));
    expect(more).toEqual([]);
    expect(q!.message).toBe('the brief read-back of "book" does not say {details}, which its full read-back says, so the caller\'s yes would confirm it unheard');
    expect(q!.fix).toBe('write {details} in a part in square brackets, said only when it has a value ("[, {details}]")');
  });

  it('a required param in a part in square brackets', () => {
    const [p, ...rest] = problemsOf(withBrief(BRIEF.replace('on {phone}', '[on {phone}]')));
    expect(rest).toEqual([]);
    expect(p!.message).toBe('the brief read-back of "book" says the required {phone} in a part in square brackets, said only when it has a value');
    expect(p!.fix).toBe('write {phone} outside the square brackets');
  });
});

describe('readBacks: whether a read-back the caller spoke over is said again held', () => {
  it('holds by default, and an app may turn it off', () => {
    expect(agentBusinessProblems(source).value!.readBacks).toEqual({ holdAfterCut: true });
    const { value, problems } = agentBusinessProblems(`${source}readBacks: { holdAfterCut: false }\n`);
    expect(problems).toEqual([]);
    expect(value!.readBacks).toEqual({ holdAfterCut: false });
  });
});

describe('silence: the re-prompt when the caller says nothing on a call', () => {
  it('waits 9 s and re-prompts once by default; an app may set both, or turn it off', () => {
    expect(agentBusinessProblems(source).value!.silence).toEqual({ afterMs: 9000, reprompts: 1 });
    expect(agentBusinessProblems(`${source}silence: { afterMs: 12000, reprompts: 2 }\n`).value!.silence).toEqual({ afterMs: 12000, reprompts: 2 });
    expect(agentBusinessProblems(`${source}silence: { afterMs: 6000 }\n`).value!.silence).toEqual({ afterMs: 6000, reprompts: 1 });
    const { value, problems } = agentBusinessProblems(`${source}silence: off\n`);
    expect(problems).toEqual([]);
    expect(value!.silence).toBe('off');
  });

  it('refuses a wait under 3 s or over 30 s, and more than three re-prompts, with the fix', () => {
    const [low] = problemsOf(`${source}silence: { afterMs: 1000 }\n`);
    expect(low).toMatchObject({ path: 'silence.afterMs' });
    expect(low!.fix).toMatch(/3000/);
    const [high] = problemsOf(`${source}silence: { afterMs: 60000 }\n`);
    expect(high).toMatchObject({ path: 'silence.afterMs' });
    expect(high!.fix).toMatch(/30000/);
    const [many] = problemsOf(`${source}silence: { reprompts: 5 }\n`);
    expect(many).toMatchObject({ path: 'silence.reprompts' });
    expect(many!.fix).toMatch(/3/);
  });

  it('lines.silence and lines.silenceEnd are optional lines', () => {
    const withLines = changed('lines:\n', 'lines:\n  silence: { en: "Are you still there?" }\n  silenceEnd: { en: "I will let you go. Call back any time." }\n');
    const { value, problems } = agentBusinessProblems(withLines);
    expect(problems).toEqual([]);
    expect(value!.lines.silence).toEqual({ en: 'Are you still there?' });
    expect(value!.lines.silenceEnd).toEqual({ en: 'I will let you go. Call back any time.' });
    expect(agentBusinessProblems(source).value!.lines.silence).toBeUndefined();
  });
});

describe('businessText', () => {
  const b = loadAgentBusiness(FIXTURE, { OFFICE_LINE: '+15555550199' });
  const text = businessText(b);

  it('lists the services with their prices, then the caveat, what is not offered, the facts and the hours', () => {
    expect(text).toContain('- standard visit: A technician looks at one item and repairs it on the spot where possible. $80–$140 per item.');
    expect(text).toContain('- quote: A free estimate by phone.');
    const at = (s: string): number => {
      expect(text).toContain(s);
      return text.indexOf(s);
    };
    const order = [at('Services:'), at('$80–$140 per item'), at('Prices: The price is confirmed'), at('Not offered:'), at('- Same-day visits'), at('Facts:'), at('Hours: Monday to Friday')];
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('lists the questions callers ask with the business\'s answers after the facts, and none when there are none', () => {
    expect(text).not.toContain('Questions callers ask');
    const withQuestions = agentBusinessProblems(changed('facts:\n', 'questions:\n  - { q: Do I need to be home?, a: "Yes, someone needs to let the technician in." }\nfacts:\n')).value!;
    const t = businessText(withQuestions);
    expect(t).toContain('Questions callers ask, with our answers:\n- Do I need to be home? Yes, someone needs to let the technician in.');
    expect(t.indexOf('Facts:')).toBeLessThan(t.indexOf('Questions callers ask'));
    expect(t.indexOf('Questions callers ask')).toBeLessThan(t.indexOf('Hours:'));
  });

  it('refuses a question with no answer', () => {
    const [p] = problemsOf(changed('facts:\n', 'questions:\n  - { q: Do I need to be home? }\nfacts:\n'));
    expect(p?.path).toMatch(/^questions\[0\]/);
  });

  it('names the business and where it is first', () => {
    expect(text.split('\n')[0]).toBe('Example Fixers: We repair small appliances and visit homes in the area.');
    expect(text).toContain('Where: Millbrook and Ashford');
  });
});

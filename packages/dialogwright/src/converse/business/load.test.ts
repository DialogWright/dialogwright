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

  it('then naming an unknown action', () => {
    const [p] = problemsOf(changed('then: [notify]', 'then: [notifyy]'));
    expect(p).toMatchObject({ path: 'actions.book.then[0]' });
    expect(p!.message).toMatch(/"notifyy" is no action/);
  });

  it('a follow-on taking a param its parent has not, which would run with a value never read back', () => {
    const [p, ...rest] = problemsOf(changed('      item: { type: text, about: The item. }', '      item: { type: text, about: The item. }\n      note: { type: text, about: A note. }'));
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ path: 'actions.book.then[0]' });
    expect(p!.message).toMatch(/"notify" takes note, which "book" has not/);
    expect(p!.fix).toMatch(/day, window, item, details, phone/);
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

  it('the google calendar, reserved for later', () => {
    const [p] = problemsOf(changed('kind: fake', 'kind: google'));
    expect(p).toMatchObject({ path: 'sources.calendar.kind' });
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

  it('names the business and where it is first', () => {
    expect(text.split('\n')[0]).toBe('Example Fixers: We repair small appliances and visit homes in the area.');
    expect(text).toContain('Where: Millbrook and Ashford');
  });
});

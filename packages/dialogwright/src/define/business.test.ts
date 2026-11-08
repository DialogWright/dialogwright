import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUILT_IN_SLOT_TYPES, registerSlotType } from '../slots/registry';
import type { SlotType } from '../slots/types';
import { agentFieldTypes, factsOf, loadBusiness } from './business';
import { loadAppFolder, type Problem } from './load';
import { businessSchema } from './schema/business';
import { SCHEMAS } from './schema/index';

/**
 * business.yaml (an app in agent mode): its schema, its reading and the problems `pnpm check` reports
 * of it, each with its path and fix, on a copy of the engine's fixture business (an invented library,
 * __fixtures__/business) edited for each case.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'business');
const copies: string[] = [];

/** A copy of the fixture folder (its YAML only), with `edit` applied to each file it names. */
function copy(edit: Record<string, (text: string) => string> = {}, add: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-business-'));
  copies.push(dir);
  for (const file of ['app.yaml', 'business.yaml', 'style.yaml']) cpSync(join(FIXTURE, file), join(dir, file));
  for (const [file, change] of Object.entries(edit)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  for (const [file, text] of Object.entries(add)) writeFileSync(join(dir, file), text);
  return dir;
}

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The folder's problems, as the loader reports them. */
const problemsOf = (dir: string): Problem[] => loadAppFolder(dir).problems;

/** business.yaml with one text replaced (the replacement must change the file). */
const replacing = (from: string, to: string) => (text: string): string => {
  expect(text, `business.yaml has "${from}"`).toContain(from);
  return text.replace(from, to);
};

describe('business.yaml', () => {
  it('the fixture business loads: no problems, and an app in agent mode', () => {
    expect(loadBusiness(FIXTURE).problems).toEqual([]);
    const loaded = loadAppFolder(FIXTURE);
    expect(loaded.problems).toEqual([]);
    expect(loaded.config!.app.mode).toBe('agent');
    expect(loaded.config!.business!.business.name).toBe('Example Library');
    // Its hashes are taken over the files it has: app.yaml, business.yaml and style.yaml.
    expect(Object.keys(loaded.config!.hashes.files).sort()).toEqual(['app.yaml', 'business.yaml', 'style.yaml']);
  });

  it('a field type the library cannot check a value of is refused (record, reference, topic)', () => {
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: topic\n      question: What\'s your name?') });
    expect(problemsOf(dir)).toMatchObject([{ file: 'business.yaml', path: 'request.fields[0].type', message: expect.stringContaining('takes no value from outside its own fill'), fix: expect.stringContaining('choice') }]);
  });

  it('a field type that is no slot type is refused, with the closest', () => {
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: nmae\n      question: What\'s your name?') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.fields[0].type', message: '"nmae" is not a slot type of the library', fix: expect.stringContaining('write "name"') }]);
  });

  it('a field whose slot type has no check is refused, not only record, reference and topic', () => {
    const name = BUILT_IN_SLOT_TYPES.name!;
    // The name type, built without its check: a type an app could register.
    const unchecked: SlotType = { ...name, type: 'unchecked', build: (id, o, w, env) => ({ ...name.build(id, o, w, env), check: undefined }) };
    const types = registerSlotType(unchecked);
    expect(agentFieldTypes(BUILT_IN_SLOT_TYPES)).toEqual(['birthdate', 'choice', 'date', 'digits', 'name', 'text']);
    expect(agentFieldTypes(types)).not.toContain('unchecked');
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: unchecked\n      question: What\'s your name?') });
    expect(loadBusiness(dir, types).problems).toMatchObject([{ path: 'request.fields[0].type', message: expect.stringContaining('it has no check of a value the model understood') }]);
  });

  it('a read-back placeholder naming no field is refused', () => {
    const dir = copy({ 'business.yaml': replacing('collected {day} in the {window}', 'collected {day} in the {windw}') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.readBack', message: expect.stringContaining('{windw}'), fix: expect.stringContaining('{window}') }]);
  });

  it('a done placeholder naming no field is refused; a booking\'s may name {account}', () => {
    const dir = copy({ 'business.yaml': replacing("done: Thanks, {patronName}.", 'done: Thanks, {who}.') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.done', message: expect.stringContaining('{who}') }]);
    // The fixture's booking read-back names {account}: no problem.
    expect(readFileSync(join(FIXTURE, 'business.yaml'), 'utf8')).toContain('for {account}');
  });

  it('an optional field named in the read-back is refused: it would read nothing', () => {
    const dir = copy({ 'business.yaml': replacing('{copies} of {title}', '{copies} {format} of {title}') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.readBack', message: expect.stringContaining('optional') }]);
  });

  it('an account number that is not E.164 is refused', () => {
    const dir = copy({ 'business.yaml': replacing('"+15555550150"', '"555-555-0150"') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'accounts[1].numbers[0]', message: expect.stringContaining('E.164'), fix: expect.stringContaining('+15555550142') }]);
  });

  it('a number on two accounts is refused: it would match neither', () => {
    const dir = copy({ 'business.yaml': replacing('"+15555550150"', '"+15555550142"') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'accounts[1].numbers[0]', message: expect.stringContaining('Rivergate Book Club') }]);
  });

  for (const file of ['intents.yaml', 'forms.yaml', 'prompts.yaml', 'policy.yaml', 'routes.yaml', 'slots.yaml']) {
    it(`${file} beside business.yaml is refused: the engine builds what it says`, () => {
      const dir = copy({}, { [file]: 'x: 1\n' });
      expect(problemsOf(dir)).toMatchObject([{ file, path: '(file)', message: expect.stringContaining('not read in agent mode'), fix: expect.stringContaining('business.yaml') }]);
    });
  }

  it('an agent-mode app with an identity factor (identity.yaml) is refused', () => {
    const dir = copy({}, { 'identity.yaml': 'principals: { subject: customer }\n' });
    expect(problemsOf(dir)).toMatchObject([{ file: 'identity.yaml', message: expect.stringContaining('takes no identity factor a caller says'), fix: expect.stringContaining('delete identity.yaml') }]);
  });

  it('a text field kept by its length for a summary (length-summarized) is refused', () => {
    const dir = copy({ 'business.yaml': replacing("      about: The book's title, as the caller gave it.\n", "      about: The book's title, as the caller gave it.\n      redact: length-summarized\n") });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.fields[1].redact', message: expect.stringContaining('sent to the agent model') }]);
  });

  it('options: windows needs the business\'s windows', () => {
    const dir = copy({ 'business.yaml': (t) => t.replace(/windows:\n  - name: morning\n[\s\S]*?capacity: 4\n  - name: afternoon\n[\s\S]*?capacity: 4\n/, '') });
    expect(problemsOf(dir).map((p) => p.path)).toEqual(['request.fields[5].options', 'booking.fields[2].options']);
  });

  it('a tool that follows two forms is refused: its calls carry one form\'s confirmed values', () => {
    const dir = copy({ 'business.yaml': replacing('then: [bookRoom]', 'then: [bookRoom, notifyDesk]') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'booking.then[1]', message: expect.stringContaining('follows the request too'), fix: expect.stringContaining('notifyDesk_booking') }]);
  });

  it('a booking needs accounts', () => {
    const dir = copy({ 'business.yaml': (t) => t.replace(/accounts:\n  - name: Rivergate[\s\S]*?\+15555550150"\]\n/, '') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'booking.for', message: expect.stringContaining('lists no accounts') }]);
  });

  it('an engine line business.yaml gives must be one of the engine\'s', () => {
    const dir = copy({ 'business.yaml': (t) => `${t}lines:\n  anything_els: Anything else?\n` });
    expect(problemsOf(dir)).toMatchObject([{ path: 'lines.anything_els', fix: expect.stringContaining('anything_else') }]);
  });

  it('business.yaml in a scripted app is refused', () => {
    const dir = copy({ 'app.yaml': replacing('mode: agent\n', '') });
    expect(problemsOf(dir)).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'business.yaml', message: expect.stringContaining('read only by an app in agent mode') })]));
  });

  it('a field\'s options only on a choice, a length only on digits', () => {
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: name\n      length: 4\n      question: What\'s your name?') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.fields[0].length', message: expect.stringContaining('only a digits field has a length') }]);
  });
});

describe('style.yaml\'s agent model', () => {
  it('defaults to Mercury 3 on Inception at instant', () => {
    expect(SCHEMAS.style.parse({ agent: {} }).agent).toEqual({ provider: 'inception', model: 'mercury-3', effort: 'instant' });
    expect(SCHEMAS.style.parse({}).agent).toBeUndefined();
  });

  it('is refused for a provider or an effort it does not take', () => {
    expect(SCHEMAS.style.safeParse({ agent: { provider: 'anthropic' } }).success).toBe(false);
    expect(SCHEMAS.style.safeParse({ agent: { effort: 'fast' } }).success).toBe(false);
  });

  it('is read only in agent mode: a scripted app that names one is told so', () => {
    const dir = copy({ 'app.yaml': replacing('mode: agent\n', '') });
    expect(problemsOf(dir)).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'style.yaml', path: 'agent', message: expect.stringContaining('only an app in agent mode') })]));
  });
});

describe('factsOf', () => {
  const b = businessSchema.parse(parse(readFileSync(join(FIXTURE, 'business.yaml'), 'utf8')));
  const facts = factsOf(b);

  it('puts the claims, the services, what is not offered, where, the days and the windows in says (may_say)', () => {
    expect(facts.says).toEqual([
      'Holds are kept at the front desk for a week.',
      'Member clubs book the study room straight in.',
      'holds: A book kept at the front desk for a week, collected in a pick-up window.',
      'the study room: A quiet room for up to six people, booked by member clubs.',
      'Not offered: book sales; printing.',
      'Where: 12 Example Street, Rivergate',
      'Days open: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday.',
      'The morning window: from 9 to noon',
      'The afternoon window: from noon to 5',
    ]);
  });

  it('keeps the background apart, and the price line, the handoff and the closing in fixed (fixed_lines)', () => {
    expect(facts.background).toEqual(['The desk has one person on most afternoons.']);
    expect(facts.fixed).toEqual({
      price: 'Fees are explained at the desk, by the person who looks at your account.',
      handoff: "I'll have someone from the desk call you back. What's the best number to reach you?",
      closing: 'Thanks for calling Example Library.',
    });
    expect(facts.name).toBe('Example Library');
    expect(facts.voice).toContain('Warm, quiet and brief');
  });

  it('never puts a window\'s capacity or an account in what the model may say', () => {
    expect(facts.says.join(' ')).not.toMatch(/\b4\b|Rivergate Book Club|Northside/);
  });
});

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUILT_IN_SLOT_TYPES, registerSlotType } from '../slots/registry';
import type { SlotType } from '../slots/types';
import { agentFieldTypes, factsOf, loadBusiness } from './business';
import { loadAppFolder, type Problem } from './load';
import { checkAppFully } from './check';
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
    expect(agentFieldTypes(BUILT_IN_SLOT_TYPES)).toEqual(['choice', 'date', 'digits', 'name', 'text']);
    expect(agentFieldTypes(types)).not.toContain('unchecked');
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: unchecked\n      question: What\'s your name?') });
    expect(loadBusiness(dir, types).problems).toMatchObject([{ path: 'request.fields[0].type', message: expect.stringContaining('it has no check of a value the model understood') }]);
  });

  it('a read-back placeholder naming no field is refused', () => {
    const dir = copy({ 'business.yaml': replacing('collected {day} in the {window}', 'collected {day} in the {windw}') });
    expect(problemsOf(dir)).toMatchObject([
      { path: 'request.readBack', message: expect.stringContaining('{windw}'), fix: expect.stringContaining('{window}') },
      { path: 'request.readBack', message: expect.stringContaining('does not say {window}') },
    ]);
  });

  it('a done placeholder naming no field is refused; a booking\'s may name {account}', () => {
    const dir = copy({ 'business.yaml': replacing("done: Thanks, {patronName}.", 'done: Thanks, {who}.') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.done', message: expect.stringContaining('{who}') }]);
    // The fixture's booking read-back names {account}: no problem.
    expect(readFileSync(join(FIXTURE, 'business.yaml'), 'utf8')).toContain('for {account}');
  });

  it('an optional field is named in the read-back, with what it says when left empty (says.unset): the then sends it', () => {
    // Named without says.unset: the line would read nothing when it is left empty.
    const unsaid = copy({ 'business.yaml': replacing(', unset: in either print }', ' }') });
    expect(problemsOf(unsaid)).toMatchObject([{ path: 'request.readBack', message: expect.stringContaining('optional') }]);
    // Not named at all: the caller would confirm a value they never heard, though the then sends it.
    const unread = copy({ 'business.yaml': replacing('{title} {format},', '{title},') });
    expect(problemsOf(unread)).toMatchObject([{ path: 'request.fields[3].optional', message: expect.stringContaining('the read-back does not name it') }]);
    // says: only on a choice, its keys the options or unset, unset only on an optional field.
    const key = copy({ 'business.yaml': replacing('large print: in large print', 'huge print: in large print') });
    expect(problemsOf(key)).toMatchObject([{ path: 'request.fields[3].says["huge print"]', message: expect.stringContaining('is not an option') }]);
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

  it('birthdate is refused in agent mode: it is an identity factor\'s type', () => {
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: birthdate\n      question: What\'s your name?') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.fields[0].type', message: expect.stringContaining('identity factor\'s type, and in agent mode the conversation is sent to the agent model'), fix: expect.not.stringContaining('birthdate') }]);
  });

  it('a read-back must say every required field, and a booking\'s its {account}', () => {
    const dir = copy({ 'business.yaml': replacing('the study room for {account}, {people} people', 'the study room for {people} people') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'booking.readBack', message: expect.stringContaining('does not say {account}') }]);
  });

  it('a field of one name in two forms has one type and one redact', () => {
    const dir = copy({ 'business.yaml': replacing('    - name: people\n      type: choice\n      options: [one, two, three, four, five, six]', '    - name: copies\n      type: digits\n      length: 1') });
    expect(problemsOf(dir)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'booking.fields[0]', message: expect.stringContaining('the field "copies" is digits here and choice in the request') })]));
  });

  it('a tool a field sees is seen from fields of one name only, and is never one a form calls after its read-back', () => {
    const seen = copy({ 'business.yaml': replacing('      question: How many people?\n', '      question: How many people?\n      sees: roomAvailability\n') });
    expect(problemsOf(seen)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'booking.fields[1].sees', message: expect.stringContaining('seen by the field "people" too') })]));
    const called = copy({ 'business.yaml': replacing('then: [bookRoom]', 'then: [bookRoom, roomAvailability]') });
    expect(problemsOf(called)).toMatchObject([{ path: 'booking.then[1]', message: expect.stringContaining('is a tool a field sees') }]);
  });

  it('freeFrom only on a choice, from a tool a field of the same form sees; prices.forms names forms the file has', () => {
    const other = copy({ 'business.yaml': replacing('freeFrom: roomAvailability.windows', 'freeFrom: calendar.windows') });
    expect(problemsOf(other)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'booking.fields[2].freeFrom', message: expect.stringContaining('"calendar" is no tool a field of the booking sees') })]));
    const day = copy({ 'business.yaml': replacing("      question: What day would you like the room?\n      sees: roomAvailability\n", "      question: What day would you like the room?\n      sees: roomAvailability\n      freeFrom: roomAvailability.windows\n") });
    expect(problemsOf(day)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'booking.fields[1].freeFrom', message: expect.stringContaining('only a choice field may be free from a seen result, and "day" is date') })]));
    const form = copy({ 'business.yaml': replacing('forms: [request]', 'forms: [request, quote]') });
    expect(problemsOf(form).length).toBeGreaterThan(0);
    const missing = copy({ 'business.yaml': (t) => replacing('forms: [request]', 'forms: [request, booking]')(t).replace(/\nbooking:[\s\S]*?(?=\ncallback:)/, '\n').replace(/accounts:[\s\S]*?(?=\n[a-z])/, '') });
    expect(problemsOf(missing)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'prices.forms[1]', message: 'the price line may be named in the booking, but the file has no booking' })]));
  });

  it('a field the records hide sees no tool: its value, and the result for it, would reach the model whole (the review of Task 8)', () => {
    const dir = copy({ 'business.yaml': replacing("      question: What's the best number to reach you when it's ready?\n", "      question: What's the best number to reach you when it's ready?\n      sees: roomAvailability\n") });
    expect(problemsOf(dir)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'request.fields[6].sees', message: expect.stringContaining('is recorded by its last four (redact last4, its type\'s default), but it sees "roomAvailability"') })]));
  });

  it('pnpm check warns of a corpus line that labels a field: in agent mode a corpus line runs without the agent (the review of Task 8)', async () => {
    const dir = copy({ 'app.yaml': (t) => `${t}fixtures:\n  dir: fixtures\n` });
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, 'fixtures', 'corpus.jsonl'), [
      '{"id":"yes-01","text":"yes please","intent":"none","context":"confirm_request","confirm":"yes"}',
      '{"id":"bk-01","text":"the study room for four tomorrow","intent":"booking","context":"no_form","labels":{"booking_people":"four"}}',
    ].join('\n'));
    const r = await checkAppFully(dir, { fixturesRoot: dir });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ file: 'fixtures/corpus.jsonl', line: 2, message: expect.stringContaining('line 2 (bk-01) labels the fields booking_people, but in agent mode a corpus line runs without the agent') })]);
  });

  it('the handoff is a statement: said where nothing waits for an answer', () => {
    const dir = copy({ 'business.yaml': replacing("handoff: I'll have someone from the desk call you back.", "handoff: I'll have someone call you back. What's your number?") });
    expect(problemsOf(dir)).toMatchObject([{ path: 'handoff', message: expect.stringContaining('asks a question'), fix: expect.stringContaining('callback form asks for the number') }]);
  });

  it('every fixed line names only what it is given: the business\'s lines nothing, an engine line its own', () => {
    const dir = copy({
      'business.yaml': (t) => `${replacing('closing: Thanks for calling Example Library.', 'closing: Thanks for calling, {patronName}.')(replacing('What day would you like the room?', 'What day would you like the room, {account}?')(t))}greeting: Hello from {name}.\nlines:\n  ack_intent: Glad to {intentLabel}.\n  anything_else: Anything else, {first}?\n`,
    });
    expect(problemsOf(dir).map((p) => `${p.path}: ${p.message}`)).toEqual([
      'booking.fields[1].question: the line names {account}, which it is never given, so it would be said with the braces in it',
      'closing: the line names {patronName}, which it is never given, so it would be said with the braces in it',
      'greeting: the line names {name}, which it is never given, so it would be said with the braces in it',
      'lines.anything_else: the line names {first}, which it is never given, so it would be said with the braces in it',
    ]);
  });

  it('windows, options and accounts are each one of a kind: windows by name, options and accounts by their key', () => {
    const windows = copy({ 'business.yaml': replacing('  - name: afternoon\n    says: from noon to 5', '  - name: morning\n    says: from noon to 5') });
    expect(problemsOf(windows)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'windows[1].name', message: 'the window "morning" is listed twice' })]));
    const options = copy({ 'business.yaml': replacing('options: [print, large print, not sure]', 'options: [print, large print, Large-Print]') });
    expect(problemsOf(options)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'request.fields[3].options[2]', message: expect.stringContaining('both are large_print') })]));
    const accounts = copy({ 'business.yaml': replacing('  - name: Northside Readers', '  - name: Rivergate book-club') });
    expect(problemsOf(accounts)).toMatchObject([{ path: 'accounts[1].name', message: expect.stringContaining('both are rivergate_book_club') }]);
  });

  it('an account\'s name is one a line can say', () => {
    const dir = copy({ 'business.yaml': replacing('  - name: Northside Readers', '  - name: Northside Readers 2') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'accounts[1].name', message: expect.stringContaining('not one a line can say') }]);
  });

  it('accounts with no booking are refused: nothing would recognize them for anything', () => {
    const dir = copy({ 'business.yaml': (t) => t.replace(/\nbooking:\n[\s\S]*?done: You're booked for \{day\}, \{window\}\. Thanks\.\n/, '\n').replace("  roomAvailability: read the study room's free windows near a day\n", '').replace('  bookRoom: book the study room\n', '') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'accounts', message: expect.stringContaining('has no booking') }]);
  });

  it('a field\'s countryCode only with offer: callerNumber', () => {
    const dir = copy({ 'business.yaml': replacing('      type: name\n      question: What\'s your name?', '      type: name\n      countryCode: "44"\n      question: What\'s your name?') });
    expect(problemsOf(dir)).toMatchObject([{ path: 'request.fields[0].countryCode' }]);
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
      handoff: "I'll have someone from the desk call you back.",
      closing: 'Thanks for calling Example Library.',
    });
    expect(facts.name).toBe('Example Library');
    expect(facts.voice).toContain('Warm, quiet and brief');
  });

  it('never puts a window\'s capacity or an account in what the model may say', () => {
    expect(facts.says.join(' ')).not.toMatch(/\b4\b|Rivergate Book Club|Northside/);
  });
});

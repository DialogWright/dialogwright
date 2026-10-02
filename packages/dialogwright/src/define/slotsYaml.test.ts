import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { defineSlot } from '../slots/defineSlot';
import { defineSlots } from '../slots/defineSlots';
import { BUILT_IN_SLOT_TYPES, registerSlotType } from '../slots/registry';
import { defineSlotType } from '../slots/slotType';
import { birthdateType } from '../slots/birthdate/index';
import { choiceType } from '../slots/choice/index';
import { dateType } from '../slots/date/index';
import { digitsType } from '../slots/digits/index';
import { textType } from '../slots/text/index';
import { AppDefinitionError, defineApp, isAppDefinitionError, type AppCode } from './defineApp';
import { checkApp } from './check';
import { libraryCode, LIBRARY_DIR } from './fixture/app';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';
import { slotsJsonSchema } from './schema/json';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the library's folder (its YAML only), with `files` written over it. */
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-slots-'));
  scratch.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

const SLOTS_HEAD = '# yaml-language-server: $schema=../../../schemas/slots.schema.json\n';
/** The library's three slots, as the code writes them. */
const ALL_CODE = 'book: { type: code }\nbranch: { type: code }\ncard: { type: code }\n';

const problems = (dir: string, code: AppCode = libraryCode): string[] => {
  try {
    defineApp(dir, code);
  } catch (error) {
    if (error instanceof AppDefinitionError) return error.problems.map(formatProblem);
    throw error;
  }
  throw new Error('defineApp built the app');
};

/** The library with a `note` text slot on the renew form, and its two lines in both locales. */
function noteFolder(slotsYaml: string): string {
  const read = (file: string): string => readFileSync(join(LIBRARY_DIR, file), 'utf8');
  const lines = (text: string): string => `  ask_note:\n    text: ${text}\n    interruptible: true\n  ask_note_retry:\n    text: ${text}\n    interruptible: true\n`;
  return folder({
    'app.yaml': read('app.yaml').replace('id: library', 'id: library-note'),
    'forms.yaml': read('forms.yaml').replace('slots: [book]\n    summaryPromptId: confirm_renew', 'slots: [book, note]\n    summaryPromptId: confirm_renew'),
    'prompts.yaml': `${read('prompts.yaml').trimEnd()}\n${lines('Is there a note for the librarian?')}`,
    'locale/es/prompts.yaml': `${read('locale/es/prompts.yaml').trimEnd()}\n${lines('¿Hay una nota para la bibliotecaria?')}`,
    'slots.yaml': slotsYaml,
  });
}

const NOTE_SLOTS = `${SLOTS_HEAD}book: { type: code }\nbranch: { type: code }\nnote:\n  type: text\n  what: a note for the librarian\n  say: your note\ncard: { type: code }\n`;

describe('slots.yaml: the loader', () => {
  it('has no slots without the file, and every key of the file in its order with it', () => {
    expect(loadAppFolder(LIBRARY_DIR).config!.slots).toBeNull();
    const loaded = loadAppFolder(noteFolder(NOTE_SLOTS));
    expect(loaded.problems).toEqual([]);
    expect(Object.keys(loaded.config!.slots!)).toEqual(['book', 'branch', 'note', 'card']);
    expect(loaded.config!.slots!.note).toEqual({ type: 'text', what: 'a note for the librarian', say: 'your note' });
  });

  it('does not take slots.yaml for a stray file, and offers it for a near miss', () => {
    expect(loadAppFolder(folder({ 'slots.yaml': ALL_CODE })).problems).toEqual([]);
    expect(loadAppFolder(folder({ 'slot.yaml': ALL_CODE })).problems.map((p) => [p.file, p.fix])).toEqual([['slot.yaml', 'rename slot.yaml to slots.yaml']]);
  });

  it('checks the outer shape at its line: a slot needs a type, ids are plain words, the file is a map', () => {
    const at = (text: string): string[] => loadAppFolder(folder({ 'slots.yaml': text })).problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.path}  ${p.message}  ->  ${p.fix}`);
    expect(at('book:\n  what: a book\n')).toEqual([
      'slots.yaml:1:1  book.type  required key "type" is missing under book  ->  add "type:" (text) under book. The slot type: a library type (text, ...), a type the app registers, or "code" for a slot the code writes (code.slots.<id>).',
    ]);
    expect(at('"my book": { type: code }\n')).toEqual([expect.stringMatching(/^slots\.yaml:1:1 {2}\["my book"\] /)]);
    expect(at('- book\n')).toHaveLength(1);
    expect(at('')).toEqual(['slots.yaml:1:1  (file)  slots.yaml is empty  ->  add its content; the file starts with a slot id and its type, for example "note: { type: code }"']);
  });

  it('is part of the folder\'s content hashes, by its parsed content', () => {
    const without = defineApp(LIBRARY_DIR, libraryCode).configHashes!;
    const dir = folder({ 'slots.yaml': ALL_CODE });
    const withFile = defineApp(dir, libraryCode).configHashes!;
    expect(Object.keys(withFile.files)).toContain('slots.yaml');
    expect(Object.keys(without.files)).not.toContain('slots.yaml');
    expect(withFile.app).not.toBe(without.app);
    // comments, quoting and spacing do not change it (the hash is over the parsed content)
    const same = folder({ 'slots.yaml': `# another comment\nbook: {type: "code"}\nbranch: { type: code }\ncard:\n  type: code\n` });
    expect(defineApp(same, libraryCode).configHashes!.files['slots.yaml']).toBe(withFile.files['slots.yaml']);
    // the order of its keys is the order of the app's slots, so a reorder changes it
    const reordered = folder({ 'slots.yaml': 'card: { type: code }\nbook: { type: code }\nbranch: { type: code }\n' });
    expect(defineApp(reordered, libraryCode).configHashes!.files['slots.yaml']).not.toBe(withFile.files['slots.yaml']);
    // a changed value does
    const other = folder({ 'slots.yaml': 'book: { type: code }\nbranch: { type: code }\ncard: { type: code }\nnote: { type: text, what: a note }\n' });
    expect(defineApp(other, libraryCode).configHashes!.files['slots.yaml']).not.toBe(withFile.files['slots.yaml']);
  });
});

describe('slots.yaml: building the app', () => {
  it('lists code slots as { type: code }: the slots are the code\'s own specs, in the file\'s order', () => {
    const app = defineApp(folder({ 'slots.yaml': ALL_CODE }), libraryCode);
    expect(Object.keys(app.slots)).toEqual(['book', 'branch', 'card']);
    for (const id of Object.keys(libraryCode.slots)) expect(app.slots[id]).toBe(libraryCode.slots[id]);
    const reversed = defineApp(folder({ 'slots.yaml': 'card: { type: code }\nbranch: { type: code }\nbook: { type: code }\n' }), libraryCode);
    expect(Object.keys(reversed.slots)).toEqual(['card', 'branch', 'book']);
  });

  it('builds a library slot from its options, and merges it with the code\'s in the file\'s order', () => {
    const app = defineApp(noteFolder(NOTE_SLOTS), libraryCode);
    expect(Object.keys(app.slots)).toEqual(['book', 'branch', 'note', 'card']);
    const note = app.slots.note as ReturnType<typeof defineSlot>;
    expect(note.type).toBe('text');
    expect(note.config).toMatchObject({ what: 'a note for the librarian', say: 'your note', maxLength: 500 });
    expect(note.questionIds).toEqual(['noteGiven']);
    expect(app.slots.book).toBe(libraryCode.slots.book);
    expect(app.forms.renew_loan!.slots).toEqual(['book', 'note']);
  });

  it('a library slot works in a turn: it is asked for, takes the words, and the form goes on', () => {
    const app = defineApp(noteFolder(NOTE_SLOTS), libraryCode);
    registerApp(app);
    const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } };
    const answers = (over: AnswerMap = {}): AnswerMap => ({
      addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
      rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
      frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
      intent: choice({ none: 0.9, other: 0.1 }),
      intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
      ...over,
    });
    const say = (r: TurnResult, text: string, over: AnswerMap = {}): TurnResult => resolve(r.session, speechEvent(text), answers(over), tc);
    const heard = (r: TurnResult): string => spokenText(app, r.decision);

    const start = resolve(newSession('note-test', 0, VOICE_RELAY, ANONYMOUS, app.id), startEvent(), null, tc);
    const intent = say(start, 'I want to renew a book', { intent: choice({ renew_loan: 0.95, none: 0.05 }) });
    expect(heard(intent)).toBe('Sure, I can help you renew a book. Which book is it?');
    const book = say(intent, 'The River Atlas', { book: choice({ river_atlas: 0.92, none: 0.08 }) });
    expect(book.session.slots.book?.value).toBe('river_atlas');
    expect(heard(book)).toBe('Is there a note for the librarian?');
    const note = say(book, 'please leave it at the front desk', { noteGiven: noul(0.93) });
    expect(note.session.slots.note?.value).toBe('please leave it at the front desk');
    expect(note.session.slots.note?.display).toBe('your note');
    expect(heard(note)).toBe("You'd like to renew The River Atlas for two more weeks. Shall I do that?");
  });

  it('check treats a library slot like a code slot: its lines are required, and a missing one is named', async () => {
    expect((await checkApp(noteFolder(NOTE_SLOTS), { code: libraryCode })).map(formatProblem)).toEqual([]);
    const noLines = folder({
      'forms.yaml': readFileSync(join(LIBRARY_DIR, 'forms.yaml'), 'utf8').replace('slots: [book]\n    summaryPromptId: confirm_renew', 'slots: [book, note]\n    summaryPromptId: confirm_renew'),
      'slots.yaml': NOTE_SLOTS,
    });
    const found = (await checkApp(noLines, { code: libraryCode })).map(formatProblem);
    expect(found.filter((line) => line.includes('"ask_note"'))).toEqual([
      'prompts.yaml:2:1  prompts  prompt "ask_note" is missing from prompts.yaml; the engine says it when it asks for the slot "note"  ->  add "ask_note:" with its text and interruptible to prompts.yaml',
      'locale/es/prompts.yaml:3:1  prompts  prompt "ask_note" is missing from the es prompts; the engine says it when it asks for the slot "note"  ->  add "ask_note:" with its text and interruptible to locale/es/prompts.yaml',
    ]);
  });

  it('a form, the carried slots and the console may name a library slot, and a misspelling names the near one', () => {
    // note is a library slot named by a form (above); here app.yaml's console and carrySlots name it too
    const read = (file: string): string => readFileSync(join(LIBRARY_DIR, file), 'utf8');
    const dir = noteFolder(NOTE_SLOTS);
    writeFileSync(join(dir, 'app.yaml'), read('app.yaml').replace('id: library', 'id: library-note').replace('carrySlots: [branch]', 'carrySlots: [branch, note]').replace('    branch: Branch', '    branch: Branch\n    note: Note'));
    expect(defineApp(dir, libraryCode).carrySlots).toEqual(['branch', 'note']);
    writeFileSync(join(dir, 'app.yaml'), read('app.yaml').replace('id: library', 'id: library-note').replace('carrySlots: [branch]', 'carrySlots: [branch, notes]'));
    expect(problems(dir)).toEqual([
      'app.yaml:27:22  carrySlots[1]  slot "notes" is not defined  ->  rename it to "note", or add "notes:" to slots.yaml (a library type, or { type: code } with the slot in app.ts (code.slots.notes))',
    ]);
  });
});

describe('slots.yaml: the rules', () => {
  it('a code slot the file does not list', () => {
    expect(problems(folder({ 'slots.yaml': 'book: { type: code }\ncard: { type: code }\n' }))).toEqual([
      'slots.yaml:1:1  (file)  the code defines the slot "branch" (app.ts (code.slots.branch)), but slots.yaml does not list it; when an app has a slots.yaml, it lists every slot the app has, in the order they are filled  ->  add "branch: { type: code }" to slots.yaml, where the slot belongs in the order, or delete the slot from app.ts (code.slots.branch)',
    ]);
  });

  it('{ type: code } for a slot the code does not define', () => {
    const { card: _, ...slots } = libraryCode.slots;
    expect(problems(folder({ 'slots.yaml': `${ALL_CODE}cards: { type: code }\n` }), { ...libraryCode, slots })).toEqual([
      'slots.yaml:3:1  card  slots.yaml says the slot "card" is written in code ({ type: code }), but the code defines no slot "card"  ->  add the slot to app.ts (code.slots.card), or give it a library type here (one of "birthdate", "choice", "date", "digits", "text")',
      'slots.yaml:4:1  cards  slots.yaml says the slot "cards" is written in code ({ type: code }), but the code defines no slot "cards"  ->  add the slot to app.ts (code.slots.cards), or give it a library type here (one of "birthdate", "choice", "date", "digits", "text")',
    ]);
  });

  it('a library slot that is also in the code', () => {
    expect(problems(folder({ 'slots.yaml': 'book: { type: code }\nbranch: { type: code }\ncard: { type: text, what: a number }\n' }))).toEqual([
      'slots.yaml:3:1  card  the slot "card" is a "text" slot in slots.yaml and the code defines it too (app.ts (code.slots.card)), so it would be built twice  ->  delete it from app.ts (code.slots.card), or change slots.yaml to "card: { type: code }" to keep the code\'s slot',
    ]);
  });

  it('an unknown type, with the near one offered; and code is always a known type', () => {
    expect(problems(folder({ 'slots.yaml': `${ALL_CODE}note: { type: txt, what: a note }\n` }))).toEqual([
      'slots.yaml:4:15  note.type  the slot "note" has the type "txt", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "text", "code"  ->  change it to "text"',
    ]);
    expect(problems(folder({ 'slots.yaml': `${ALL_CODE}note: { type: zzzzzz, what: a note }\n` }))).toEqual([
      'slots.yaml:4:15  note.type  the slot "note" has the type "zzzzzz", which is not a slot type here; the types are "birthdate", "choice", "date", "digits", "text", "code"  ->  use one of "birthdate", "choice", "date", "digits", "text", "code", or register the type (registerSlotType) and pass it in the code\'s slotTypes',
    ]);
  });

  it('{ type: code } takes no options', () => {
    expect(problems(folder({ 'slots.yaml': 'book: { type: code, what: a book }\nbranch: { type: code }\ncard: { type: code }\n' }))).toEqual([
      'slots.yaml:1:21  book.what  the slot "book" is { type: code }, which takes no options, but has "what"  ->  delete "what" (the code\'s slot has its own settings in app.ts (code.slots.book)), or give the slot a library type',
    ]);
  });

  it('a library type\'s options are checked at their line in slots.yaml, with every problem in one pass', () => {
    const found = problems(folder({ 'slots.yaml': `${ALL_CODE}note:\n  type: text\n  what: a note\n  maxLenth: 20\nother:\n  type: text\n` }));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^slots\.yaml:7:3 {2}note\.maxLenth /);
    expect(found[0]).toContain('unknown key "maxLenth"');
    expect(found[0]).toContain('maxLength');
    expect(found[1]).toMatch(/^slots\.yaml:8:1 {2}other /);
    expect(found[1]).toContain('a text slot needs "what"');
  });

  it('a library slot\'s question ids may not be another slot\'s', () => {
    // book declares the id "book"; the note's question is renamed to it
    const found = problems(folder({ 'slots.yaml': `${ALL_CODE}note:\n  type: text\n  what: a note\n  ids: { given: book }\n` }));
    expect(found).toEqual([expect.stringMatching(/^slots\.yaml:4:1 {2}note .*"book"/)]);
  });

  it('the order of the file is the order of App.slots, and a library slot may come first', () => {
    const dir = noteFolder(`note: { type: text, what: a note, say: your note }\n${ALL_CODE}`);
    expect(Object.keys(defineApp(dir, libraryCode).slots)).toEqual(['note', 'book', 'branch', 'card']);
  });
});

describe('slots.yaml: the app\'s own slot types', () => {
  const memo = defineSlotType({ type: 'memo', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] });

  it('code.slotTypes adds a type slots.yaml may name', () => {
    const dir = noteFolder(NOTE_SLOTS.replace('type: text', 'type: memo'));
    expect(problems(dir)).toEqual([expect.stringContaining('the slot "note" has the type "memo", which is not a slot type here')]);
    const app = defineApp(dir, { ...libraryCode, slotTypes: { memo } });
    expect((app.slots.note as unknown as { type: string }).type).toBe('memo');
    // a map from registerSlotType holds the built-in types too, which are not the app's own
    expect(() => defineApp(dir, { ...libraryCode, slotTypes: registerSlotType(memo) })).not.toThrow();
    expect(Object.keys(BUILT_IN_SLOT_TYPES)).toEqual(['birthdate', 'choice', 'date', 'digits', 'text']);
  });

  it('a type that takes a built-in type\'s name is refused, and so are the reserved name and a type listed twice', () => {
    const shadow = defineSlotType({ type: 'text', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] });
    const dir = folder({ 'slots.yaml': ALL_CODE });
    expect(problems(dir, { ...libraryCode, slotTypes: { text: shadow } })).toEqual([
      'app.ts  code.slotTypes.text  the slot type "text" is a built-in type, and an app\'s own type may not take its name  ->  give the type another name (for example "my-text") in app.ts (code.slotTypes)',
    ]);
    const reserved = defineSlotType({ type: 'code', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] });
    expect(problems(dir, { ...libraryCode, slotTypes: { code: reserved } })[0]).toContain('the slot type name "code" is reserved');
    expect(problems(dir, { ...libraryCode, slotTypes: { a: memo, b: memo } })).toEqual([
      'app.ts  code.slotTypes.b  the slot type "memo" is registered twice in app.ts (code.slotTypes)  ->  register each type once, under its own name',
    ]);
  });
});

describe('defineSlots: slots for an app that is not a folder', () => {
  const code = libraryCode.slots;

  it('takes an object, keeps its order, and returns the code\'s own specs beside the built ones', () => {
    const slots = defineSlots({ card: { type: 'code' }, note: { type: 'text', what: 'a note' }, book: { type: 'code' }, branch: { type: 'code' } }, code);
    expect(Object.keys(slots)).toEqual(['card', 'note', 'book', 'branch']);
    expect(slots.card).toBe(code.card);
    expect((slots.note as unknown as { type: string }).type).toBe('text');
    expect(slots.note!.questionIds).toEqual(['noteGiven']);
  });

  it('takes the path of a slots.yaml, whose problems point at its lines', () => {
    const dir = folder({ 'slots.yaml': `${ALL_CODE}note:\n  type: text\n  what: a note\n  bogus: 1\n` });
    const path = join(dir, 'slots.yaml');
    const failure = (() => {
      try {
        defineSlots(path, code);
      } catch (error) {
        return error;
      }
      throw new Error('built');
    })();
    expect(failure).toBeInstanceOf(AppDefinitionError);
    expect(isAppDefinitionError(failure)).toBe(true);
    expect((failure as Error).message).toMatch(new RegExp(`^the slots in ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid \\(1 problem\\):`));
    expect((failure as AppDefinitionError).problems.map((p) => [p.file, p.line, p.column, p.path])).toEqual([[path, 7, 3, 'note.bogus']]);
    // a valid file builds, in the file's order
    const ok = join(folder({ 'slots.yaml': `note: { type: text, what: a note }\n${ALL_CODE}` }), 'slots.yaml');
    expect(Object.keys(defineSlots(ok, code))).toEqual(['note', 'book', 'branch', 'card']);
  });

  it('applies the same rules and messages, with no line for an object', () => {
    const thrown = (source: Record<string, unknown>, codeSlots = code): string[] => {
      try {
        defineSlots(source, codeSlots);
      } catch (error) {
        return (error as AppDefinitionError).problems.map(formatProblem);
      }
      throw new Error('built');
    };
    expect(thrown({ book: { type: 'code' }, branch: { type: 'code' } })).toEqual([
      'slots.yaml  (file)  the code defines the slot "card" (code.slots.card), but slots.yaml does not list it; when an app has a slots.yaml, it lists every slot the app has, in the order they are filled  ->  add "card: { type: code }" to slots.yaml, where the slot belongs in the order, or delete the slot from code.slots.card',
    ]);
    expect(thrown({ ...Object.fromEntries(Object.keys(code).map((id) => [id, { type: 'code' }])), extra: { type: 'code' } })).toEqual([
      expect.stringContaining('slots.yaml says the slot "extra" is written in code ({ type: code }), but the code defines no slot "extra"'),
    ]);
    expect(thrown({ ...Object.fromEntries(Object.keys(code).map((id) => [id, { type: 'code' }])), card: { type: 'text', what: 'x' } })[0]).toContain('is a "text" slot in slots.yaml and the code defines it too');
    expect(thrown({ ...Object.fromEntries(Object.keys(code).map((id) => [id, { type: 'code' }])), note: { type: 'txt' } })[0]).toContain('change it to "text"');
    expect(thrown({ book: { what: 'a' } })[0]).toContain('book.type');
    expect(thrown({ 'my book': { type: 'code' } })[0]).toContain('my book');
  });

  it('takes the app\'s own types as a map, and refuses one that shadows a built-in', () => {
    const memo = defineSlotType({ type: 'memo', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] });
    const all = Object.fromEntries(Object.keys(code).map((id) => [id, { type: 'code' }]));
    expect(() => defineSlots({ ...all, note: { type: 'memo', what: 'a note' } }, code)).toThrow(AppDefinitionError);
    expect((defineSlots({ ...all, note: { type: 'memo', what: 'a note' } }, code, registerSlotType(memo)).note as unknown as { type: string }).type).toBe('memo');
    expect(() => registerSlotType(defineSlotType({ type: 'text', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] }))).toThrow('a slot type named "text" is already registered');
  });
});

describe('slots.schema.json', () => {
  const schema = slotsJsonSchema() as { additionalProperties: { oneOf: { properties: { type: { const: string } }; required: string[]; description?: string }[] } };

  it('is a union over the built-in types and { type: code }, each requiring its type', () => {
    const branches = schema.additionalProperties.oneOf;
    expect(branches.map((b) => b.properties.type.const)).toEqual(['birthdate', 'choice', 'date', 'digits', 'text', 'code']);
    for (const branch of branches) expect(branch.required).toContain('type');
    expect(branches[0]!.description).toBe(birthdateType.describe!.summary);
    expect(branches[1]!.description).toBe(choiceType.describe!.summary);
    expect(branches[2]!.description).toBe(dateType.describe!.summary);
    expect(branches[3]!.description).toBe(digitsType.describe!.summary);
    expect(branches[4]!.description).toBe(textType.describe!.summary);
  });

  it('lists a type an app registers when it is given the types', () => {
    const memo = defineSlotType({ type: 'memo', options: textType.options as z.ZodType<any>, build: (id, o) => textType.build(id, o), examples: [] });
    const own = slotsJsonSchema(registerSlotType(memo)) as typeof schema;
    expect(own.additionalProperties.oneOf.map((b) => b.properties.type.const)).toEqual(['birthdate', 'choice', 'date', 'digits', 'text', 'memo', 'code']);
  });
});

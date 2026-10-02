import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSlot, defineSlot } from '../slots/defineSlot';
import { testSlotContext } from '../testing/slots';
import { choice, noul } from '../testing/answers';
import { checkApp } from './check';
import { defineApp, type AppCode } from './defineApp';
import { libraryApp, libraryCode, LIBRARY_DIR } from './fixture/app';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';

/**
 * locale/<tag>/slots.yaml: a locale's wording for the library slots (how a value is said there, never
 * what the model is asked). Loaded with the folder, hashed, applied by defineApp, checked by `check`.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the library's YAML with locale/es/slots.yaml replaced by `wording` (or as it is). */
function folder(wording?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-wording-'));
  scratch.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  if (wording !== undefined) writeFileSync(join(dir, 'locale', 'es', 'slots.yaml'), wording);
  return dir;
}

const HEAD = '# yaml-language-server: $schema=../../../../../schemas/locale-slots.schema.json\n';
const lines = async (dir: string, code: AppCode = libraryCode): Promise<string[]> => (await checkApp(dir, { code })).map(formatProblem);

describe('locale/<tag>/slots.yaml: loading', () => {
  it('is read with the locale\'s prompts, as a map of slot ids to maps, and hashed by its path', () => {
    const loaded = loadAppFolder(LIBRARY_DIR);
    expect(loaded.config!.localeSlots).toEqual({
      es: {
        book: { options: { river_atlas: 'El atlas del río', quiet_orchard: 'Un huerto tranquilo', clockwork_garden: 'El jardín de relojería' } },
        branch: { options: { north: 'Norte', riverside: { say: 'Ribera' } } },
      },
    });
    expect(Object.keys(loaded.config!.hashes.files)).toContain('locale/es/slots.yaml');
  });

  it('is optional: a locale without one has none, and its slots say their values as their options do', () => {
    const dir = folder();
    rmSync(join(dir, 'locale', 'es', 'slots.yaml'));
    const loaded = loadAppFolder(dir);
    expect(loaded.config!.localeSlots).toEqual({});
    const app = defineApp(dir, libraryCode);
    expect(app.slots.branch).toBe(libraryCode.slots.branch);
    expect(app.slots.branch!.display('north', 'es')).toBe('North');
  });

  it('must be a map of slot ids to maps', async () => {
    expect(await lines(folder(`${HEAD}- branch\n`))).toEqual([
      expect.stringMatching(/^locale\/es\/slots\.yaml:2:1 {2}\(file\) {2}/),
    ]);
    expect(await lines(folder(`${HEAD}branch: Norte\n`))).toEqual([
      'locale/es/slots.yaml:2:9  branch  "branch" must be a map, but is text ("Norte")  ->  use a map here',
    ]);
  });
});

describe('locale/<tag>/slots.yaml: applied', () => {
  it('says the options in the locale\'s words in that locale, the options\' own in every other, and asks the same questions', () => {
    const branch = libraryApp.slots.branch!;
    expect(branch.display('north', 'es')).toBe('Norte');
    expect(branch.display('riverside', 'es')).toBe('Ribera');
    // es-US reads es's wording; en-US and no locale the options' own
    expect(branch.display('north', 'es-US')).toBe('Norte');
    expect(branch.display('north', 'en-US')).toBe('North');
    expect(branch.display('north')).toBe('North');
    const ctx = testSlotContext('la sucursal norte', { locale: 'es' });
    expect(branch.fill({ branch: choice({ north: 0.92, none: 0.08 }) }, ctx)).toEqual({ kind: 'filled', value: 'north', display: 'Norte', confidence: 0.92, confirm: 'none' });
    expect(branch.fill({ branch: choice({ north: 0.92, none: 0.08 }) }, testSlotContext('north'))).toMatchObject({ display: 'North' });
    expect(branch.questions(ctx)).toEqual(libraryCode.slots.branch!.questions(ctx));
    expect(branch.questions(ctx).branch).toEqual({
      type: 'choice',
      instructions: 'Read asr.text. Which library branch does the caller name?',
      criteria: { north: 'The caller names North', riverside: 'The caller names Riverside', none: 'Names none of these' },
    });
  });

  it('leaves an option the locale does not give in the options\' words', () => {
    const app = defineApp(folder(`${HEAD}branch:\n  options:\n    north: Norte\n`), libraryCode);
    expect(app.slots.branch!.display('riverside', 'es')).toBe('Riverside');
    expect(app.slots.branch!.display('north', 'es')).toBe('Norte');
  });

  it('gives a text slot its stand-in in the locale', () => {
    const note = buildSlot('note', { type: 'text', what: 'a note for the librarian', say: 'your note' }, { wording: { es: { say: 'su nota' } } });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const ctx = testSlotContext('déjelo en la puerta', { locale: 'es' });
    expect(note.spec.fill({ noteGiven: noul(0.9) }, ctx)).toMatchObject({ kind: 'filled', value: 'déjelo en la puerta', display: 'su nota' });
    expect(note.spec.display('x', 'en-US')).toBe('your note');
  });
});

describe('locale/<tag>/slots.yaml: checked', () => {
  it('the library\'s folder is clean', async () => {
    expect(await lines(LIBRARY_DIR)).toEqual([]);
  });

  it('an option the slot does not have, a key the type does not take, and an empty say, each at its line', async () => {
    const dir = folder(`${HEAD}branch:\n  options:\n    nort: Norte\n    riverside: { say: '' }\n  say: Sucursal\n`);
    expect(await lines(dir)).toEqual([
      'locale/es/slots.yaml:4:5  branch.options.nort  unknown key "nort" under branch.options  ->  rename "nort" to "north"',
      'locale/es/slots.yaml:5:23  branch.options.riverside.say  "say" must not be empty  ->  give it a value, or delete the key',
      'locale/es/slots.yaml:6:3  branch.say  unknown key "say" under branch  ->  delete "say"; the keys allowed under branch are options',
    ]);
  });

  it('a slot the app does not have, with the rename when one is close', async () => {
    expect(await lines(folder(`${HEAD}brnch:\n  options:\n    north: Norte\n`))).toEqual([
      'locale/es/slots.yaml:2:1  brnch  slot "brnch" has wording in locale/es/slots.yaml, but the code defines no slot "brnch"  ->  rename it to "branch", or delete it, or add the slot to app.ts (code.slots.brnch)',
    ]);
  });

  it('a slot whose type takes no wording (a digits slot says its number the same everywhere)', async () => {
    expect(await lines(folder(`${HEAD}card:\n  say: tarjeta\n`))).toEqual([
      'locale/es/slots.yaml:2:1  card  the slot "card" is a "digits" slot, which has no wording to give per locale: it says its values the same way in every locale, or formats them by locale itself  ->  delete "card" from locale/es/slots.yaml',
    ]);
  });

  it('a slot the code writes by hand, and one built by a type and then changed in code', async () => {
    const { questionIds: _q, type: _t, config: _c, ...plain } = libraryCode.slots.branch as unknown as Record<string, unknown>;
    const handWritten: AppCode = { ...libraryCode, slots: { ...libraryCode.slots, branch: plain as unknown as AppCode['slots'][string] } };
    expect(await lines(folder(`${HEAD}branch:\n  options:\n    north: Norte\n`), handWritten)).toEqual([
      'locale/es/slots.yaml:2:1  branch  the slot "branch" is written in code (app.ts (code.slots.branch)), so locale/es/slots.yaml cannot give its wording: only a library slot (a type in slots.yaml, or one built with defineSlot) takes a locale\'s wording  ->  delete "branch" from locale/es/slots.yaml, and have the code\'s slot say its value by SlotContext.locale and display(value, locale)',
    ]);
    const changed: AppCode = { ...libraryCode, slots: { ...libraryCode.slots, branch: { ...libraryCode.slots.branch!, detect: true } } };
    expect(await lines(folder(`${HEAD}branch:\n  options:\n    north: Norte\n`), changed)).toEqual([
      'locale/es/slots.yaml:2:1  branch  the slot "branch" was built by the "choice" type and then changed in code (a copy with a field replaced), so locale/es/slots.yaml cannot give its wording: built again with it from its options, the slot would lose the change  ->  build the slot with defineSlot (or in slots.yaml) and use it as built, or delete "branch" from locale/es/slots.yaml and have the code\'s slot say its value by its locale',
    ]);
  });

  it('a slot built in code with defineSlot takes the wording, as one in slots.yaml does', () => {
    const branch = defineSlot('branch', { type: 'choice', text: { instructions: 'Read asr.text. Which library branch does the caller name?' }, options: { north: 'North', riverside: 'Riverside' } });
    const app = defineApp(folder(), { ...libraryCode, slots: { ...libraryCode.slots, branch } });
    expect(app.slots.branch).not.toBe(branch);
    expect(app.slots.branch!.display('north', 'es')).toBe('Norte');
    // built once per slot and wording, so a second build of the folder is the same App
    expect(defineApp(folder(), { ...libraryCode, slots: { ...libraryCode.slots, branch } }).slots.branch).toBe(app.slots.branch);
  });

  it('is part of the app\'s configuration: a changed wording is another hash', () => {
    const changed = loadAppFolder(folder(readFileSync(join(LIBRARY_DIR, 'locale', 'es', 'slots.yaml'), 'utf8').replace('Norte', 'Del Norte')));
    expect(changed.config!.hashes.files['locale/es/slots.yaml']).not.toBe(loadAppFolder(LIBRARY_DIR).config!.hashes.files['locale/es/slots.yaml']);
  });
});

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_PERSON_REASON, ENGINE_PROMPTS, IDENTITY_PROMPTS, MAX_CORPUS_BYTES, PORTAL_PROMPTS, checkApp, checkAppFully, enginePrompts } from './check';
import type { AppCode } from './defineApp';
import { USAGE, findAppFolders, main, type Io } from './cli';
import { libraryCode, LIBRARY_DIR } from './fixture/app';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(here, '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-check-'));
  scratch.push(dir);
  return dir;
}

/** A copy of the library's YAML, with `files` written over it (a file whose text is null is deleted). */
function folder(files: Record<string, string | ((text: string) => string)> = {}): string {
  const dir = temp();
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof change === 'string' ? change : change(readFileSync(path, 'utf8')));
  }
  return dir;
}

/** The problems for the folder and the library's code, one formatted line each. */
async function lines(dir: string, options: Parameters<typeof checkApp>[1] = { code: libraryCode }): Promise<string[]> {
  return (await checkApp(dir, options)).map(formatProblem);
}

/** Removes one prompt (its three lines) from a prompts.yaml's text. */
const without = (id: string) => (text: string): string => text.replace(new RegExp(`^  ${id}:\\n(    .*\\n)+`, 'm'), '');

/** An identity.yaml for the library: three tools it has stand for the identity tools (the checks here do not read the tools). */
const IDENTITY = [
  'principals: { subject: patron }',
  'levels:',
  '  1: { name: verified, factors: [book], verify: findHold }',
  '  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: findHold, verify: findHold }',
  'attempts: 3',
  '',
].join('\n');

function cli(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), cwd: temp() }, out, err };
}



describe('checkApp: the example app', () => {
  it('has no problems, with its code given or imported from its app.ts', async () => {
    expect(await checkApp(LIBRARY_DIR, { code: libraryCode })).toEqual([]);
    expect(await checkAppFully(LIBRARY_DIR)).toEqual({ problems: [], warnings: [], codeChecked: true });
  });

  it('reports what the loader finds, and nothing else when the folder does not load', async () => {
    const dir = folder({ 'forms.yaml': 'forms: 5\n' });
    const problems = await lines(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^forms\.yaml:1:8  forms  /);
  });

  it('runs crossLink against the code, with the same messages defineApp throws', async () => {
    const dir = folder({ 'forms.yaml': (t) => t.replace('slots: [book, branch]', 'slots: [book, amount]') });
    // a slot a form asks for also needs its lines, defined in the code or not
    expect((await lines(dir)).slice(0, 2)).toEqual([
      'forms.yaml:8:19  forms.check_hold.slots[1]  slot "amount" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.amount)',
      'prompts.yaml:2:1  prompts  prompt "ask_amount" is missing from prompts.yaml; the engine says it when it asks for the slot "amount"  ->  add "ask_amount:" with its text and interruptible to prompts.yaml',
    ]);
  });
});

describe('checkApp: the prompts every locale needs', () => {
  it('a prompt the engine says that prompts.yaml lacks', async () => {
    const dir = folder({ 'prompts.yaml': without('goodbye') });
    expect(await lines(dir)).toEqual([
      'prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml',
    ]);
  });

  it('the prompts the engine says for each slot a form asks for', async () => {
    const dir = folder({ 'prompts.yaml': without('ask_branch_retry') });
    expect(await lines(dir)).toEqual([
      'prompts.yaml:2:1  prompts  prompt "ask_branch_retry" is missing from prompts.yaml; the engine says it when it asks for the slot "branch" again after an answer that missed  ->  add "ask_branch_retry:" with its text and interruptible to prompts.yaml',
    ]);
  });

  it('suggests the rename when a near miss is there', async () => {
    const dir = folder({ 'prompts.yaml': (t) => t.replace('  goodbye:\n', '  goodbey:\n') });
    expect((await lines(dir))[0]).toContain('->  rename "goodbey" to "goodbye" if that is the line, or add "goodbye:"');
  });

  it('a prompt a form, an intent or identity names, missing from another locale (and the engine ones too)', async () => {
    const dir = folder({ 'locale/fr/prompts.yaml': 'prompts:\n  greeting:\n    text: Bonjour\n    interruptible: true\n' });
    const problems = await lines(dir);
    expect(problems.slice(0, 3)).toEqual([
      'locale/fr/prompts.yaml:1:1  prompts  prompt "hours" is missing from the fr prompts; intents.yaml:19 (intents.hours.promptId) says it  ->  add "hours:" with its text and interruptible to locale/fr/prompts.yaml',
      'locale/fr/prompts.yaml:1:1  prompts  prompt "confirm_renew" is missing from the fr prompts; forms.yaml:5 (forms.renew_loan.summaryPromptId) says it  ->  add "confirm_renew:" with its text and interruptible to locale/fr/prompts.yaml',
      'locale/fr/prompts.yaml:1:1  prompts  prompt "greeting_chat" is missing from the fr prompts; the engine says it when a chat opens  ->  add "greeting_chat:" with its text and interruptible to locale/fr/prompts.yaml',
    ]);
    // greeting is there, and the default locale has what it needs: only the locale is reported
    expect(problems.every((p) => p.startsWith('locale/fr/prompts.yaml:'))).toBe(true);
    expect(problems.some((p) => p.includes('"greeting"'))).toBe(false);
  });

  it('a locale that has every prompt is fine, and so is each of several', async () => {
    const dir = folder();
    const prompts = readFileSync(join(dir, 'prompts.yaml'), 'utf8');
    for (const tag of ['fr', 'pt-BR']) {
      mkdirSync(join(dir, 'locale', tag), { recursive: true });
      writeFileSync(join(dir, 'locale', tag, 'prompts.yaml'), prompts);
    }
    expect(await lines(dir)).toEqual([]);
    writeFileSync(join(dir, 'locale', 'pt-BR', 'prompts.yaml'), without('anything_else')(prompts));
    expect(await lines(dir)).toEqual([
      'locale/pt-BR/prompts.yaml:2:1  prompts  prompt "anything_else" is missing from the pt-BR prompts; the engine says it when a form is done and it asks whether there is more  ->  add "anything_else:" with its text and interruptible to locale/pt-BR/prompts.yaml',
    ]);
  });

  it('without the code to check against, it also checks the references in the default locale; with it, crossLink does and the line is reported once', async () => {
    const dir = folder({ 'prompts.yaml': without('hours') });
    expect(await lines(dir, {})).toEqual([
      'prompts.yaml:2:1  prompts  prompt "hours" is missing from prompts.yaml; intents.yaml:19 (intents.hours.promptId) says it  ->  add "hours:" with its text and interruptible to prompts.yaml',
    ]);
    expect(await lines(dir)).toEqual([
      'intents.yaml:19:15  intents.hours.promptId  prompt "hours" is not in prompts.yaml  ->  add "hours:" to prompts.yaml with its text and interruptible',
    ]);
  });

  it('an app with identity needs the code and sign-in lines too; an app without a menu needs no keypad menu', () => {
    const dir = folder({
      'identity.yaml': IDENTITY,
      'intents.yaml': (t) => t.replace(/\nmenu:[\s\S]*$/, '\nmenu: []\n'),
    });
    const config = loadAppFolder(dir).config!;
    const ids = enginePrompts(config).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['identity_failed', 'identity_verified', 'handoff_identity', 'ask_otp', 'ask_otp_spoken', 'otp_spoken_reissued', 'otp_verified', 'otp_failed']));
    expect(ids).not.toContain('nomatch_dtmf_menu');
    expect(ids.filter((id) => id === 'ask_book')).toHaveLength(1);
    expect(enginePrompts(config, { ...libraryCode, portal: {} }).map((p) => p.id)).toEqual(expect.arrayContaining(['signin_required', 'greeting_chat_signed_in']));
  });

  it('an identity failedPromptId replaces identity_failed, and the opening lines app.yaml names replace greeting and greeting_chat', () => {
    const dir = folder({
      'identity.yaml': IDENTITY.replace('verify: findHold }\n  2', 'verify: findHold, failedPrompt: try_again }\n  2'),
      'app.yaml': (t) => t.replace('prompts:\n  spokenVars: [due]', 'prompts:\n  spokenVars: [due]\n  greetings:\n    voice: hello\n    chat: hello_chat'),
    });
    const ids = enginePrompts(loadAppFolder(dir).config!).map((p) => p.id);
    expect(ids).toContain('try_again');
    expect(ids).not.toContain('identity_failed');
    expect(ids).toEqual(expect.arrayContaining(['hello', 'hello_chat']));
    expect(ids).not.toContain('greeting');
  });
});

describe('checkApp: each locale\'s lines against prompts.yaml', () => {
  it('a translated line that uses a variable the prompts.yaml line lacks is a problem at its text: saying it would fail', async () => {
    const dir = folder({
      'locale/es/prompts.yaml': (t) => t.replace('Listo. Ahora {book} se devuelve el {due}.', 'Listo. Ahora {libro} se devuelve el {due}.').replace("'{book} está reservado", "'{book} {extra} está reservado"),
    });
    expect(await lines(dir)).toEqual([
      'locale/es/prompts.yaml:120:11  prompts.renewed.text  the es line "renewed" uses {libro}, which the prompts.yaml line does not, so saying it would fail: the line is given only the variables the prompts.yaml line has  ->  use only {book}, {due} in this line (check the spelling), or add {libro} to the prompts.yaml line and to the code that says it',
      'locale/es/prompts.yaml:126:11  prompts.hold_waiting.text  the es line "hold_waiting" uses {extra}, which the prompts.yaml line does not, so saying it would fail: the line is given only the variables the prompts.yaml line has  ->  use only {book}, {branch} in this line (check the spelling), or add {extra} to the prompts.yaml line and to the code that says it',
    ]);
    const none = folder({ 'locale/es/prompts.yaml': (t) => t.replace('Para confirmar, ¿quiere {intentLabel}?', 'Hola {first}, ¿quiere {intentLabel}?').replace('  goodbye:\n    text: ', '  goodbye:\n    text: Adiós {first}. ') });
    expect((await lines(none)).find((l) => l.includes('"goodbye"'))).toContain('->  write this line without variables, as the prompts.yaml line has none, or add {first} to the prompts.yaml line and to the code that says it');
  });

  it('a line only a locale has is never said: a problem, with the rename when one is close', async () => {
    const dir = folder({ 'locale/es/prompts.yaml': (t) => `${t}  no_hlod:\n    text: No veo una reserva de {book}.\n    interruptible: false\n  farewell_extra:\n    text: Adiós.\n    interruptible: true\n` });
    expect(await lines(dir)).toEqual([
      'locale/es/prompts.yaml:154:3  prompts.no_hlod  prompt "no_hlod" is in the es prompts but not in prompts.yaml, so it is never said  ->  rename it to "no_hold" if it is that line, or delete it',
      'locale/es/prompts.yaml:157:3  prompts.farewell_extra  prompt "farewell_extra" is in the es prompts but not in prompts.yaml, so it is never said  ->  add "farewell_extra:" to prompts.yaml if the app says it, or delete it here',
    ]);
  });

  it('a needed line misspelt in a locale is reported once, as missing, with the rename', async () => {
    const dir = folder({ 'locale/es/prompts.yaml': (t) => t.replace('  anything_else:\n', '  anything_els:\n') });
    expect(await lines(dir)).toEqual([
      'locale/es/prompts.yaml:3:1  prompts  prompt "anything_else" is missing from the es prompts; the engine says it when a form is done and it asks whether there is more  ->  rename "anything_els" to "anything_else" if that is the line, or add "anything_else:" with its text and interruptible to locale/es/prompts.yaml',
    ]);
  });
});

describe('checkApp: the lines the engine builds from the code', () => {
  const book = libraryCode.slots.book!;
  const withBook = (spec: Partial<typeof book>): AppCode => ({ ...libraryCode, slots: { ...libraryCode.slots, book: { ...book, ...spec } } });
  // A book slot changed in code takes no locale wording (it would be built again without the change),
  // so these folders say nothing of it in locale/es/slots.yaml.
  const unworded = (t: string): string => t.replace(/^book:\n(?: {2}.*\n)+/m, '');
  const ids = (code: AppCode, dir = LIBRARY_DIR): string[] => enginePrompts(loadAppFolder(dir).config!, code).map((p) => p.id);

  it('a slot with a keypad rung needs ask_<slot>_dtmf, in every locale', async () => {
    const code = withBook({ dtmf: { length: 4, parse: () => null } });
    expect(ids(libraryCode)).not.toContain('ask_book_dtmf');
    expect(ids(code)).toContain('ask_book_dtmf');
    expect(await lines(folder({ 'locale/es/slots.yaml': unworded }), { code })).toEqual([
      'prompts.yaml:2:1  prompts  prompt "ask_book_dtmf" is missing from prompts.yaml; the engine says it when it asks for the slot "book" on the keypad after spoken answers missed (its slot spec has dtmf)  ->  add "ask_book_dtmf:" with its text and interruptible to prompts.yaml',
      'locale/es/prompts.yaml:3:1  prompts  prompt "ask_book_dtmf" is missing from the es prompts; the engine says it when it asks for the slot "book" on the keypad after spoken answers missed (its slot spec has dtmf)  ->  add "ask_book_dtmf:" with its text and interruptible to locale/es/prompts.yaml',
    ]);
  });

  it('a slot read back on every spoken value needs confirm_<slot> and its keypad line; one acknowledged by confidence needs ack_<slot>; a partial value needs its prompt', () => {
    expect(ids(withBook({ spokenConfirm: 'always' }))).toEqual(expect.arrayContaining(['confirm_book', 'ask_book_dtmf']));
    expect(ids(withBook({ spokenConfirm: 'by-confidence' }))).toContain('ack_book');
    expect(ids(withBook({ spokenConfirm: 'by-confidence' }))).not.toContain('confirm_book');
    expect(ids(withBook({ partialPromptId: 'ask_book_title' }))).toContain('ask_book_title');
    // summary: neither acknowledged nor read back on its own
    expect(ids(libraryCode).filter((id) => /^(ack|confirm)_book$/.test(id))).toEqual([]);
  });

  it('a line a slot declares (SlotSpec.prompts) is needed in every locale, besides the derived ones', async () => {
    // The library's card declares its length retry, its ack and its keypad line.
    expect(ids(libraryCode)).toEqual(expect.arrayContaining(['ask_card_length', 'ack_card', 'ask_card_dtmf']));
    const code = withBook({ prompts: [{ id: 'disambiguate_book', why: 'the caller names two books', vars: ['a', 'b'] }] });
    expect(ids(code)).toContain('disambiguate_book');
    const dir = folder({ 'prompts.yaml': (t) => `${t}  disambiguate_book:\n    text: Is it {a}, or {b}?\n    interruptible: true\n`, 'locale/es/slots.yaml': unworded });
    expect(await lines(dir, { code })).toEqual([
      'locale/es/prompts.yaml:3:1  prompts  prompt "disambiguate_book" is missing from the es prompts; the engine says it when the caller names two books (the slot "book" declares it in its prompts)  ->  add "disambiguate_book:" with its text and interruptible to locale/es/prompts.yaml',
    ]);
  });

  it('a line a slot declares may use only the variables it declares, in any locale', async () => {
    const plain = folder({ 'prompts.yaml': (t) => t.replace('A library card number has eight digits.', 'Card {card} does not have eight digits.') });
    expect(await lines(plain)).toEqual([
      'prompts.yaml:139:11  prompts.ask_card_length.text  the line "ask_card_length" uses {card}, which the slot "card" does not give it (its prompts declare no variables for this line), so saying it would fail  ->  write this line without variables, or add "card" to the vars of "ask_card_length" in app.ts (code.slots.card.prompts) if the slot gives it',
    ]);
    const es = folder({ 'locale/es/prompts.yaml': (t) => t.replace('Es la tarjeta {card}.', 'Es la tarjeta {number}.') });
    expect(await lines(es)).toEqual([
      'locale/es/prompts.yaml:143:11  prompts.ack_card.text  the es line "ack_card" uses {number}, which the slot "card" does not give it (its prompts declare {card} for this line), so saying it would fail  ->  use only {card} in this line (check the spelling), or add "number" to the vars of "ack_card" in app.ts (code.slots.card.prompts) if the slot gives it',
      // and, as before, against the prompts.yaml line
      'locale/es/prompts.yaml:143:11  prompts.ack_card.text  the es line "ack_card" uses {number}, which the prompts.yaml line does not, so saying it would fail: the line is given only the variables the prompts.yaml line has  ->  use only {card} in this line (check the spelling), or add {number} to the prompts.yaml line and to the code that says it',
    ]);
  });

  it('a role whose access is "person" needs the handoff line for R5\'s reason: role-person, or the policy\'s own', () => {
    const roles = (access: string) => folder({ 'policy.yaml': (t) => t.replace('- custom: known-branch', `- custom: known-branch\n      - role: { ${access} }`) });
    expect(ids(libraryCode, roles('clerk: person'))).toContain('handoff_role_person');
    const own = ids(libraryCode, roles('clerk: person, reason: staff-hold'));
    expect(own).toContain('handoff_staff_hold');
    expect(own).not.toContain('handoff_role_person');
    expect(ids(libraryCode)).not.toContain('handoff_role_person');
  });
});

describe('checkApp: every prompt is mode: fixed', () => {
  it('a prompt in any other mode is refused, and the message says what to write', async () => {
    const dir = folder({
      'prompts.yaml': (t) => t.replace('  hours:\n    text: Every branch is open from nine to six, Monday to Saturday.\n    interruptible: true', '  hours:\n    text: Every branch is open from nine to six, Monday to Saturday.\n    interruptible: true\n    mode: generated'),
    });
    expect(await lines(dir)).toEqual(['prompts.yaml:99:11  prompts.hours.mode  "mode" is "generated", but the only value allowed is "fixed"  ->  write "fixed"']);
  });
});

describe('checkApp: every intent has corpus examples', () => {
  const withFixtures = (dir: string, corpus: string | null): { dir: string; root: string } => {
    const root = temp();
    writeFileSync(join(dir, 'app.yaml'), `${readFileSync(join(dir, 'app.yaml'), 'utf8')}\nfixtures:\n  dir: fixtures\n`);
    if (corpus !== null) {
      mkdirSync(join(root, 'fixtures'));
      writeFileSync(join(root, 'fixtures', 'corpus.jsonl'), corpus);
    }
    return { dir, root };
  };
  const entry = (intent: string): string => JSON.stringify({ id: `${intent}-01`, text: `say ${intent}`, intent, context: 'no_form' });
  const ALL = ['renew_loan', 'check_hold', 'check_loans', 'hours', 'agent', 'repeat_prompt', 'done', 'other', 'none'];

  it('an app with no fixtures has no corpus to check', async () => {
    expect(await lines(folder())).toEqual([]);
  });

  it('every intent covered: ok', async () => {
    const { dir, root } = withFixtures(folder(), `${ALL.map(entry).join('\n')}\n`);
    expect(await lines(dir, { code: libraryCode, fixturesRoot: root })).toEqual([]);
  });

  it('an intent with no example in the corpus', async () => {
    const { dir, root } = withFixtures(folder(), `${ALL.filter((i) => i !== 'hours' && i !== 'done').map(entry).join('\n')}\n`);
    expect(await lines(dir, { code: libraryCode, fixturesRoot: root })).toEqual([
      'intents.yaml:15:3  intents.hours  intent "hours" has no examples in the corpus (fixtures/corpus.jsonl)  ->  add a line to fixtures/corpus.jsonl such as {"id":"hours-01","text":"<what a caller says to mean this>","intent":"hours","context":"no_form"}',
      'intents.yaml:28:3  intents.done  intent "done" has no examples in the corpus (fixtures/corpus.jsonl)  ->  add a line to fixtures/corpus.jsonl such as {"id":"done-01","text":"<what a caller says to mean this>","intent":"done","context":"no_form"}',
    ]);
  });

  it('a corpus file that is not there', async () => {
    const { dir, root } = withFixtures(folder(), null);
    const [problem] = await checkApp(dir, { code: libraryCode, fixturesRoot: root });
    expect(problem).toMatchObject({ file: 'app.yaml', path: 'fixtures.dir', message: `the app has no corpus: fixtures/corpus.jsonl does not exist (looked in ${join(root, 'fixtures', 'corpus.jsonl')})` });
    expect(problem!.fix).toContain('create fixtures/corpus.jsonl with a line per labelled utterance');
  });

  it('a corpus line that is not JSON, or has no intent, is reported at its line', async () => {
    const { dir, root } = withFixtures(folder(), `${ALL.map(entry).join('\n')}\nnot json\n{"id":"x"}\n`);
    const problems = (await lines(dir, { code: libraryCode, fixturesRoot: root })).map((l) => l.replace(root, '<root>'));
    expect(problems).toEqual([
      expect.stringMatching(/^.*corpus\.jsonl:10:1  \(file\)  line 10 is not JSON  ->  write one JSON object per line/),
      expect.stringMatching(/^.*corpus\.jsonl:11:1  \(file\)  line 11 has no "intent"  ->  add "intent": "<an intent id from intents.yaml>" to the line$/),
    ]);
  });

  it('a corpus that a link takes out of the package is refused, and so is one over the size limit', async () => {
    const outside = temp();
    writeFileSync(join(outside, 'corpus.jsonl'), `${ALL.map(entry).join('\n')}\n`);
    const linked = withFixtures(folder(), null);
    symlinkSync(outside, join(linked.root, 'fixtures'));
    const [escaped] = await checkApp(linked.dir, { code: libraryCode, fixturesRoot: linked.root });
    expect(escaped).toMatchObject({ file: 'app.yaml', path: 'fixtures.dir', fix: 'keep the fixtures inside the package, and replace the link with the folder itself' });
    expect(escaped!.message).toMatch(/^fixtures\/corpus\.jsonl resolves to .*corpus\.jsonl, which is outside the app's package/);

    const big = withFixtures(folder(), '');
    truncateSync(join(big.root, 'fixtures', 'corpus.jsonl'), MAX_CORPUS_BYTES + 1);
    expect(await checkApp(big.dir, { code: libraryCode, fixturesRoot: big.root })).toEqual([
      expect.objectContaining({ file: 'app.yaml', path: 'fixtures.dir', message: `fixtures/corpus.jsonl is ${MAX_CORPUS_BYTES + 1} bytes, over the ${MAX_CORPUS_BYTES} byte limit for a corpus` }),
    ]);
  });

  it('the fixtures directory is relative to the nearest package.json above the app folder', async () => {
    const root = temp();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'fixtures'));
    writeFileSync(join(root, 'fixtures', 'corpus.jsonl'), `${ALL.map(entry).join('\n')}\n`);
    const dir = join(root, 'app');
    cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    writeFileSync(join(dir, 'app.yaml'), `${readFileSync(join(dir, 'app.yaml'), 'utf8')}\nfixtures:\n  dir: fixtures\n`);
    expect(await lines(dir)).toEqual([]);
  });
});

describe('checkApp: the app module', () => {
  const fixtureModule = join(here, 'fixture', 'app');

  it('imports app.ts and takes its `code` export', async () => {
    const dir = folder({ 'app.ts': `export { code } from ${JSON.stringify(fixtureModule)};\n`, 'forms.yaml': (t) => t.replace('hooks: [complete]', 'hooks: [complete, entry]') });
    expect(await lines(dir, {})).toEqual([
      'forms.yaml:10:23  forms.check_hold.hooks[1]  form "check_hold" declares the hook "entry", but the code does not define it  ->  write it in app.ts (code.forms.check_hold.entry), or delete "entry" from this list',
    ]);
  });

  it('takes a default export too', async () => {
    const dir = folder({ 'app.mjs': 'import { code } from ' + JSON.stringify(fixtureModule) + '; export default code;\n' });
    expect(await checkAppFully(dir)).toEqual({ problems: [], warnings: [], codeChecked: true });
  });

  it('a module that does not load is a problem, not a crash', async () => {
    const dir = folder({ 'app.mjs': 'throw new Error("boom");\n' });
    expect(await lines(dir, {})).toEqual([
      'app.mjs  (file)  app.mjs could not be loaded (boom)  ->  run `tsx app.mjs` in the app folder to see the full error; app.mjs must import without running anything else',
    ]);
  });

  it('an AppDefinitionError from another copy of defineApp (no instanceof) is unpacked into its problems, by its brand', async () => {
    const problem = { file: 'forms.yaml', line: 8, column: 19, path: 'forms.check_hold.slots[1]', message: 'slot "x" is not defined', fix: 'add it' };
    const other = { ...problem, line: 9, message: 'slot "y" is not defined' };
    const problems = JSON.stringify([problem, other]);
    const throwers = {
      // a class of the same name from another module instance: instanceof AppDefinitionError is false
      subclass: `class AppDefinitionError extends Error { constructor(p) { super('the app is not valid (2 problems):\\n  one\\n  two'); this.name = 'AppDefinitionError'; this[Symbol.for('dialogwright.AppDefinitionError')] = true; this.problems = p; } }\nthrow new AppDefinitionError(${problems});\n`,
      // a plain object with the brand
      branded: `throw { [Symbol.for('dialogwright.AppDefinitionError')]: true, problems: ${problems} };\n`,
      // an older copy, before the brand: the name and the problems
      named: `const e = new Error('not valid'); e.name = 'AppDefinitionError'; e.problems = ${problems}; throw e;\n`,
    };
    for (const [how, source] of Object.entries(throwers)) {
      expect(await checkApp(folder({ 'app.mjs': source }), {}), how).toEqual([problem, other]);
    }
  });

  it('a module that fails with a message of several lines keeps every line of it', async () => {
    const dir = folder({ 'app.mjs': 'throw new Error("first thing wrong\\n  second thing wrong\\nthird");\n' });
    expect(await lines(dir, {})).toEqual([
      'app.mjs  (file)  app.mjs could not be loaded (first thing wrong / second thing wrong / third)  ->  run `tsx app.mjs` in the app folder to see the full error; app.mjs must import without running anything else',
    ]);
    // an error named AppDefinitionError whose problems are not problems is not trusted as one
    const odd = folder({ 'app.mjs': 'const e = new Error("odd"); e.name = "AppDefinitionError"; e.problems = [1]; throw e;\n' });
    expect(await lines(odd, {})).toEqual([expect.stringContaining('app.mjs could not be loaded (odd)')]);
  });

  it('a module with no code export is a problem that says what to write', async () => {
    const dir = folder({ 'app.mjs': 'export const x = 1;\n' });
    expect(await lines(dir, {})).toEqual([
      'app.mjs  (file)  app.mjs exports no app code: neither `code` nor a default export is an object  ->  in app.mjs, write `export const code: AppCode = { slots, tools, systems, forms }` (AppCode is exported by "dialogwright")',
    ]);
  });

  it('a module that builds the app with defineApp and throws: its problems are reported, with the prompt checks', async () => {
    const dir = folder({
      'app.ts': `import { defineApp } from ${JSON.stringify(join(here, 'defineApp'))};\nimport { libraryCode } from ${JSON.stringify(fixtureModule)};\nexport const app = defineApp(import.meta.dirname, { ...libraryCode, tools: {} });\n`,
      'prompts.yaml': without('goodbye'),
    });
    const problems = await lines(dir, {});
    expect(problems).toContain('policy.yaml:3:3  actions.renewLoan  tool "renewLoan" is not defined in the code  ->  add it to the app\'s tools in app.ts (code.tools.renewLoan), or delete this action');
    expect(problems).toContain('prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml');
  });

  it('looks in src/ when the folder has no app module of its own, and reports problems there by that path', async () => {
    const dir = folder({ 'src/app.ts': `export { code } from ${JSON.stringify(fixtureModule)};\n`, 'forms.yaml': (t) => t.replace('hooks: [complete]', 'hooks: [complete, entry]') });
    expect(await lines(dir, {})).toEqual([
      'forms.yaml:10:23  forms.check_hold.hooks[1]  form "check_hold" declares the hook "entry", but the code does not define it  ->  write it in src/app.ts (code.forms.check_hold.entry), or delete "entry" from this list',
    ]);
    const broken = folder({ 'src/app.mjs': 'throw new Error("boom");\n' });
    expect(await lines(broken, {})).toEqual([
      'src/app.mjs  (file)  src/app.mjs could not be loaded (boom)  ->  run `tsx src/app.mjs` in the app folder to see the full error; src/app.mjs must import without running anything else',
    ]);
  });

  it('prefers the folder\'s own app module to one in src/', async () => {
    const dir = folder({ 'app.mjs': `export { code } from ${JSON.stringify(fixtureModule)};\n`, 'src/app.mjs': 'throw new Error("not this one");\n' });
    expect(await checkAppFully(dir)).toEqual({ problems: [], warnings: [], codeChecked: true });
  });

  it('a folder with no app module is checked as YAML only, and says so', async () => {
    expect(await checkAppFully(folder())).toEqual({ problems: [], warnings: [], codeChecked: false });
  });
});

describe('the engine prompt list', () => {
  /** The prompt ids the engine names as literals, and the ones it builds: read from its source, so a line added there is noticed here. */
  const sources = (): string[] => {
    const files: string[] = [];
    for (const dir of ['core', 'gate', 'channel', 'prompts', 'handoff']) {
      for (const entry of readdirSync(join(PACKAGE_DIR, 'src', dir), { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(test|probe\.test)\.ts$/.test(entry.name)) files.push(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
      }
    }
    return files;
  };
  const literals = (): Set<string> => {
    const ids = new Set<string>();
    for (const text of sources()) {
      for (const m of text.matchAll(/\bprompt\(\s*'([a-z_]+)'/g)) ids.add(m[1]!);
      for (const m of text.matchAll(/promptId: '([a-z_]+)'/g)) ids.add(m[1]!);
      for (const m of text.matchAll(/\bhandoff\(s, '([a-z-]+)'/g)) ids.add(`handoff_${m[1]!.replace(/-/g, '_')}`);
      for (const m of text.matchAll(/\?\? '([a-z_]+)'/g)) if (/^(greeting|identity)/.test(m[1]!)) ids.add(m[1]!);
    }
    return ids;
  };

  it('names every family of prompt ids the engine builds from a slot or a reason', () => {
    const families = new Set<string>();
    for (const text of sources()) {
      // A turn's outcome label (`summary_${kind}` in the trace) is not a line.
      for (const line of text.split('\n').filter((l) => !/\boutcome = `/.test(l))) {
        for (const m of line.matchAll(/`([a-z]+_)\$\{[^}`]+\}((?:_[a-z]+)*)`/g)) families.add(`${m[1]!}<x>${m[2]!}`);
      }
    }
    // enginePrompts requires each of these where the engine says it; disambiguate_<slot> only the
    // slot's code can offer (two candidates from its fill), and handoff_<reason> is the reason's.
    expect([...families].sort()).toEqual(['ack_<x>', 'ask_<x>', 'ask_<x>_dtmf', 'ask_<x>_retry', 'confirm_<x>', 'disambiguate_<x>', 'handoff_<x>']);
  });

  it('the role-person reason check names is the gate\'s', () => {
    const policy = readFileSync(join(PACKAGE_DIR, 'src', 'gate', 'policy.ts'), 'utf8');
    expect(policy).toContain(`const DEFAULT_ROLE_PERSON_REASON = '${DEFAULT_ROLE_PERSON_REASON}';`);
  });

  it('names every prompt id the engine says as a literal, or says why not', () => {
    const named = new Set([...Object.keys(ENGINE_PROMPTS), 'greeting', 'greeting_chat', 'nomatch_dtmf_menu', ...IDENTITY_PROMPTS.map((p) => p.id), ...PORTAL_PROMPTS.map((p) => p.id)]);
    // The ones an app writes or that depend on the app's own code, never the same in two apps.
    const elsewhere = new Set(['identity_failed', 'handoff_identity']);
    expect(literals().size).toBeGreaterThan(30);
    const unlisted = [...literals()].filter((id) => !named.has(id) && !elsewhere.has(id));
    expect(unlisted).toEqual([]);
  });
});

describe('dialogwright check', () => {
  it('a good folder: a summary line, exit 0', async () => {
    const { io, out, err } = cli();
    expect(await main(['check', LIBRARY_DIR], io)).toBe(0);
    expect(out).toEqual([`${LIBRARY_DIR}: ok`]);
    expect(err).toEqual([]);
  });

  it('a bad folder: one line per problem, then the count, exit 1', async () => {
    const dir = folder({
      'app.ts': `export { code } from ${JSON.stringify(join(here, 'fixture', 'app'))};\n`,
      'forms.yaml': (t) => t.replace('slots: [book, branch]', 'slots: [book, amount]'),
      'prompts.yaml': without('goodbye'),
    });
    const { io, out } = cli();
    expect(await main(['check', dir], io)).toBe(1);
    expect(out).toEqual([
      'forms.yaml:8:19  forms.check_hold.slots[1]  slot "amount" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.amount)',
      'prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml',
      expect.stringContaining('"ask_amount" is missing'),
      expect.stringContaining('"ask_amount_retry" is missing'),
      // the library also speaks es (locale/es), which lacks the new slot's lines too
      'locale/es/prompts.yaml:3:1  prompts  prompt "ask_amount" is missing from the es prompts; the engine says it when it asks for the slot "amount"  ->  add "ask_amount:" with its text and interruptible to locale/es/prompts.yaml',
      expect.stringContaining('"ask_amount_retry" is missing from the es prompts'),
      `6 problems in ${dir}`,
    ]);
  });

  it('one problem reads "1 problem"', async () => {
    const { io, out } = cli();
    expect(await main(['check', folder({ 'prompts.yaml': without('goodbye') })], io)).toBe(1);
    expect(out.at(-1)).toMatch(/^1 problem in /);
  });

  it('a folder with no app module: ok, with a note on stderr that only the YAML was checked', async () => {
    const dir = folder();
    const { io, out, err } = cli();
    expect(await main(['check', dir], io)).toBe(0);
    expect(out).toEqual([`${dir}: ok`]);
    expect(err).toEqual([`${dir}: checked the YAML only; there is no app.ts (or src/app.ts) to check it against (it exports the app's code parts as \`code\`)`]);
  });

  it('--json prints the Problem[] and nothing else', async () => {
    const dir = folder({ 'prompts.yaml': without('goodbye') });
    const { io, out } = cli();
    expect(await main(['check', '--json', dir], io)).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([
      {
        file: 'prompts.yaml',
        line: 2,
        column: 1,
        path: 'prompts',
        message: 'prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends',
        fix: 'add "goodbye:" with its text and interruptible to prompts.yaml',
      },
    ]);
    const good = cli();
    expect(await main(['check', LIBRARY_DIR, '--json'], good.io)).toBe(0);
    expect(good.out).toEqual(['[]']);
  });

  it('several folders: each has its lines and its summary; the exit code is 1 if any has a problem; --json is an object by folder', async () => {
    const bad = folder({ 'prompts.yaml': without('goodbye') });
    const { io, out } = cli();
    expect(await main(['check', LIBRARY_DIR, bad], io)).toBe(1);
    expect(out.filter((l) => l.endsWith(': ok') || / in /.test(l))).toEqual([`${LIBRARY_DIR}: ok`, `1 problem in ${bad}`]);
    const json = cli();
    await main(['check', '--json', LIBRARY_DIR, bad], json.io);
    expect(Object.keys(JSON.parse(json.out[0]!))).toEqual([LIBRARY_DIR, bad]);
  });

  it('a folder that is not there is a problem, not a crash', async () => {
    const { io, out } = cli();
    expect(await main(['check', join(io.cwd, 'nowhere')], io)).toBe(1);
    expect(out[0]).toMatch(/^\.:1:1  \(file\)  the app folder ".*nowhere" does not exist  ->  pass the path of the folder/);
  });

  it('with no folder it checks the app folders under apps/ of the workspace, and says so when there are none', async () => {
    const root = temp();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const none = cli();
    none.io.cwd = root;
    expect(await main(['check'], none.io)).toBe(0);
    expect(none.out).toEqual(['no app folders found: no folder under apps/ has an app.yaml']);

    cpSync(LIBRARY_DIR, join(root, 'apps', 'library'), { recursive: true, filter: (src) => !src.endsWith('.ts') });
    cpSync(LIBRARY_DIR, join(root, 'apps', 'town', 'app'), { recursive: true, filter: (src) => !src.endsWith('.ts') });
    mkdirSync(join(root, 'apps', 'node_modules', 'x'), { recursive: true });
    expect(findAppFolders(join(root, 'apps', 'library')).dirs).toEqual([join(root, 'apps', 'library')]);
    const found = cli();
    found.io.cwd = join(root, 'apps');
    expect(await main(['check'], found.io)).toBe(0);
    expect(found.out).toEqual(['apps/library: ok', 'apps/town/app: ok']);
    const json = cli();
    json.io.cwd = root;
    await main(['check', '--json'], json.io);
    expect(JSON.parse(json.out[0]!)).toEqual({ 'apps/library': [], 'apps/town/app': [] });
  });

  it('a command or option it does not know: usage, exit 2', async () => {
    for (const argv of [[], ['frobnicate'], ['check', '--bogus']]) {
      const { io, out, err } = cli();
      expect(await main(argv, io)).toBe(2);
      expect(out).toEqual([]);
      expect(err[0]).toContain(USAGE);
    }
  });

  it('runs as the package bin does, through tsx: the exit code and the output of a real process', () => {
    const run = (args: string[]) => spawnSync(join(PACKAGE_DIR, 'node_modules', '.bin', 'tsx'), [join(here, 'cli.ts'), ...args], { encoding: 'utf8' });
    const good = run(['check', LIBRARY_DIR]);
    expect({ status: good.status, stdout: good.stdout }).toEqual({ status: 0, stdout: `${LIBRARY_DIR}: ok\n` });
    const bad = run(['check', folder({ 'prompts.yaml': without('goodbye') })]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/prompt "goodbye" is missing from prompts\.yaml/);
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(manifest.bin).toEqual({ dialogwright: './src/define/cli.ts' });
    expect(readFileSync(join(PACKAGE_DIR, manifest.bin.dialogwright!), 'utf8').startsWith('#!/usr/bin/env tsx\n')).toBe(true);
  });
});

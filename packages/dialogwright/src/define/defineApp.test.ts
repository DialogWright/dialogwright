import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { validateApp } from '../core/app/validate';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import { testSlotContext } from '../testing/slots';
import type { AnswerMap } from '../jev/types';
import { AppDefinitionError, defineApp, type AppCode } from './defineApp';
import { libraryApp, libraryCode, LibrarySystems, LIBRARY_DIR } from './fixture/app';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the library's folder (its YAML only), with `files` written over it. */
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-define-'));
  scratch.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

/** The problems defineApp throws for this folder and code, one formatted line each. */
function problems(code: AppCode, dir = LIBRARY_DIR, codeFile?: string): string[] {
  try {
    defineApp(dir, code, codeFile ? { codeFile } : {});
  } catch (error) {
    if (error instanceof AppDefinitionError) return error.problems.map(formatProblem);
    throw error;
  }
  throw new Error('defineApp built the app');
}

/** Every key in an object tree whose value is undefined: a built App has none. */
function undefinedKeys(value: unknown, path = 'app'): string[] {
  if (typeof value !== 'object' || value === null || value instanceof RegExp) return [];
  return Object.entries(value).flatMap(([k, v]) => (v === undefined ? [`${path}.${k}`] : undefinedKeys(v, `${path}.${k}`)));
}

describe('defineApp: the library fixture', () => {
  it('builds the App from the folder and the code, and validateApp passes it', () => {
    expect(() => validateApp(libraryApp)).not.toThrow();
    expect(libraryApp.id).toBe('library');
    expect(libraryApp.identity).toBeUndefined();
    // The code's slots, the book and the branch built again with their es wording (locale/es/slots.yaml).
    expect(Object.keys(libraryApp.slots)).toEqual(Object.keys(libraryCode.slots));
    expect(libraryApp.slots.card).toBe(libraryCode.slots.card);
    for (const id of ['book', 'branch']) {
      expect(libraryApp.slots[id]).toMatchObject({ id, type: 'choice', config: (libraryCode.slots[id] as unknown as { config: object }).config });
      // the wording changes what the slot says, never what the model is asked
      for (const locale of [undefined, 'en-US', 'es']) expect(libraryApp.slots[id]!.questions(testSlotContext('North', { locale }))).toEqual(libraryCode.slots[id]!.questions(testSlotContext('North', { locale })));
    }
    expect((libraryApp.slots.branch as { wording?: unknown }).wording).toEqual({ es: { options: { north: 'Norte', riverside: 'Ribera' } } });
    expect(libraryApp.tools).toBe(libraryCode.tools);
    expect(libraryApp.systems).toBe(libraryCode.systems);
    expect(libraryApp.policy.customRules).toBe(libraryCode.customRules);
  });

  it('keeps the contract\'s field order, the files\' map order, and no key standing for nothing', () => {
    expect(Object.keys(libraryApp)).toEqual(['id', 'intents', 'menu', 'forms', 'slots', 'tools', 'policy', 'systems', 'wording', 'carrySlots', 'brand', 'console', 'voice', 'prompts', 'locales', 'testing', 'configHashes']);
    expect(Object.keys(libraryApp.intents)).toEqual(['renew_loan', 'check_hold', 'check_loans', 'hours', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(libraryApp.intents.hours).toEqual({ criteria: 'Asks when the library is open', label: 'hear the opening hours', kind: 'informational', promptId: 'hours' });
    expect(Object.keys(libraryApp.intents.renew_loan!)).toEqual(['criteria', 'label', 'kind']);
    expect(libraryApp.menu).toEqual([{ digit: '1', intent: 'renew_loan' }, { digit: '2', intent: 'check_hold' }, { digit: '0', intent: 'agent' }]);
    expect(Object.keys(libraryApp.policy)).toEqual(['toolLevel', 'purposeLevel', 'rulesFor', 'serviceFields', 'confirmedFields', 'maxAttempts', 'subjects', 'customRules', 'audit']);
    expect(Object.keys(libraryApp.prompts)).toEqual(['manifest', 'tags', 'spokenVars']);
    expect(Object.keys(libraryApp.prompts.manifest).slice(0, 3)).toEqual(['greeting', 'greeting_chat', 'ask_intent']);
    expect(libraryApp.prompts.manifest.no_input).toEqual({ text: "I didn't hear anything.", interruptible: false });
    expect(libraryApp.prompts.tags).toEqual({});
    expect(undefinedKeys(libraryApp)).toEqual([]);
    // A second build of the same folder is the same App, field for field.
    const again = defineApp(LIBRARY_DIR, libraryCode);
    expect(again).not.toBe(libraryApp);
    expect(again).toStrictEqual(libraryApp);
    expect(JSON.stringify(again)).toBe(JSON.stringify(libraryApp));
  });

  it('gives each form its slots and summary from forms.yaml and its hooks from the code, in the order declared', () => {
    const renew = libraryApp.forms.renew_loan!;
    expect(Object.keys(renew)).toEqual(['slots', 'summaryPromptId', 'confirmedParams', 'complete']);
    expect(renew.slots).toEqual(['book']);
    expect(renew.summaryPromptId).toBe('confirm_renew');
    expect(renew.complete).toBe(libraryCode.forms.renew_loan!.complete);
    expect(renew.confirmedParams).toBe(libraryCode.forms.renew_loan!.confirmedParams);
    expect(libraryApp.forms.check_hold).toEqual({ slots: ['book', 'branch'], summaryPromptId: null, complete: libraryCode.forms.check_hold!.complete });
  });

  it('compiles the spoken-digits patterns with the g flag and passes the presentation through', () => {
    expect(libraryApp.voice).toEqual({ hints: ['renew', 'hold', 'branch', 'Riverside'], spokenDigits: [{ pattern: /(card )(\d{4,})/g, spell: 'lead' }] });
    expect(libraryApp.voice!.spokenDigits![0]!.pattern.flags).toBe('g');
    expect(libraryApp.brand).toEqual({ name: 'Example Town Library', mark: 'TL' });
    expect(libraryApp.console).toEqual({ formLabels: { renew_loan: 'Renew a book', check_hold: 'Check a hold' }, slotLabels: { book: 'Book', branch: 'Branch' } });
    expect(libraryApp.wording).toEqual({ addressee: 'the library line' });
    expect(libraryApp.carrySlots).toEqual(['branch']);
  });

  it('puts every locale on the App: the default\'s lines are its manifest, each other\'s are App.locales.prompts', () => {
    expect(libraryApp.locales?.default).toBe('en-US');
    expect(Object.keys(libraryApp.locales!.prompts)).toEqual(['es']);
    const es = libraryApp.locales!.prompts.es!;
    expect(es.greeting).toEqual({ text: 'Gracias por llamar a la Biblioteca de Example Town. Puedo renovar un libro o revisar una reserva. ¿En qué puedo ayudarle?', interruptible: true });
    // es leaves no_hold out: it is said from the manifest
    expect(Object.hasOwn(es, 'no_hold')).toBe(false);
    expect(libraryApp.prompts.manifest.greeting!.text).toMatch(/^Thanks for calling/);
  });

  it('gives a folder that declares no locale (no locale: in app.yaml, no locale/ folder) no locales, as an app written without them', () => {
    const dir = folder({ 'app.yaml': readFileSync(join(LIBRARY_DIR, 'app.yaml'), 'utf8').replace('locale: en-US\n', '') });
    rmSync(join(dir, 'locale'), { recursive: true });
    const plain = defineApp(dir, libraryCode);
    expect(Object.hasOwn(plain, 'locales')).toBe(false);
    expect(plain.prompts).toStrictEqual(libraryApp.prompts);
    // app.yaml's locale: alone declares one: a single-language app whose language is named
    const named = folder();
    rmSync(join(named, 'locale'), { recursive: true });
    expect(defineApp(named, libraryCode).locales).toEqual({ default: 'en-US', prompts: {} });
  });
});

describe('defineApp: a call through resolve', () => {
  registerApp(libraryApp);
  const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } };

  const answers = (over: AnswerMap = {}): AnswerMap => ({
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    ...over,
  });
  const ANSWERING = { intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) };
  const say = (r: TurnResult, text: string, over: AnswerMap = {}): TurnResult => resolve(r.session, speechEvent(text), answers(over), tc);
  const heard = (r: TurnResult): string => spokenText(libraryApp, r.decision);
  const calls = (r: TurnResult): string[] => r.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`);

  it('greets, takes the intent, fills the slot, reads the summary, and renews on the yes', () => {
    const start = resolve(newSession('library-test', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, tc);
    expect(heard(start)).toBe('Thanks for calling Example Town Library. I can renew a book or check a hold. How can I help?');

    const intent = say(start, 'I want to renew a book', { intent: choice({ renew_loan: 0.95, none: 0.05 }) });
    expect(intent.session.form).toBe('renew_loan');
    expect(heard(intent)).toBe('Sure, I can help you renew a book. Which book is it?');

    const summary = say(intent, 'The River Atlas', { ...ANSWERING, book: choice({ river_atlas: 0.92, none: 0.08 }) });
    expect(summary.session.slots.book?.value).toBe('river_atlas');
    expect(heard(summary)).toBe("You'd like to renew The River Atlas for two more weeks. Shall I do that?");

    const yes = say(summary, 'yes please', {
      ...ANSWERING, confirmsYes: noul(0.95), confirmsNo: noul(0.05), changeSlot: choice({ none: 0.95, book: 0.05 }),
    });
    expect(calls(yes)).toEqual(['renewLoan:ALLOW']);
    expect(heard(yes)).toBe('Done. The River Atlas is now due back Friday, October 2. Is there anything else I can help with?');
    expect((tc.tools.sys as LibrarySystems).renewals).toEqual([{ ref: 'R101', book: 'river_atlas', due: '2026-10-02' }]);
  });

  it('checks a hold through the app\'s own rule, asking for each slot the form needs', () => {
    const start = resolve(newSession('library-hold', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, tc);
    const opener = say(start, 'is my hold for A Quiet Orchard in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ quiet_orchard: 0.9, none: 0.1 }) });
    expect(heard(opener)).toBe('Sure, I can help you check a hold. Which branch is the hold at, North or Riverside?');
    const branch = say(opener, 'Riverside', { ...ANSWERING, branch: choice({ riverside: 0.9, none: 0.1 }) });
    expect(calls(branch)).toEqual(['findHold:ALLOW']);
    expect(branch.gateEvents[0]!.decision.rules.map((r) => `${r.id}:${r.pass}`)).toEqual(['identity:true', 'known-branch:true']);
    expect(heard(branch)).toBe('A Quiet Orchard is on hold for you at the Riverside branch, but it has not come in yet. Is there anything else I can help with?');
  });
});

describe('defineApp: what an unsure intent gets (app.yaml unsureIntent, intents.yaml unsure)', () => {
  const read = (file: string): string => readFileSync(join(LIBRARY_DIR, file), 'utf8');
  const withIntent = (intent: string, line: string): string => read('intents.yaml').replace(`  ${intent}:\n`, `  ${intent}:\n    ${line}\n`);

  it('leaves both off the App unless written, and puts each on it as written', () => {
    expect('unsureIntent' in libraryApp).toBe(false);
    expect(Object.values(libraryApp.intents).some((def) => 'unsure' in def)).toBe(false);
    const dir = folder({
      'app.yaml': read('app.yaml').replace('carrySlots: [branch]', 'carrySlots: [branch]\nunsureIntent: no-match'),
      'intents.yaml': withIntent('hours', 'unsure: confirm').replace('  renew_loan:\n', '  renew_loan:\n    unsure: confirm\n'),
    });
    const app = defineApp(dir, libraryCode);
    expect(app.unsureIntent).toBe('no-match');
    expect(app.intents.hours!.unsure).toBe('confirm');
    expect(app.intents.renew_loan!.unsure).toBe('confirm');
    expect('unsure' in app.intents.check_hold!).toBe(false);
  });

  it('refuses a value it does not have, offering the near one', () => {
    expect(problems(libraryCode, folder({ 'app.yaml': read('app.yaml').replace('carrySlots: [branch]', 'carrySlots: [branch]\nunsureIntent: nomatch') }))).toEqual([
      'app.yaml:28:15  unsureIntent  "unsureIntent" is "nomatch", which is not allowed here; it must be one of "confirm", "no-match"  ->  change it to "no-match"',
    ]);
    expect(problems(libraryCode, folder({ 'intents.yaml': withIntent('hours', 'unsure: confrim') }))).toEqual([
      'intents.yaml:16:13  intents.hours.unsure  "unsure" is "confrim", which is not allowed here; it must be one of "confirm", "no-match"  ->  change it to "confirm"',
    ]);
  });

  it('refuses it on a control intent that is never confirmed, and takes it on done', () => {
    expect(problems(libraryCode, folder({ 'intents.yaml': withIntent('agent', 'unsure: no-match') }))).toEqual([
      'intents.yaml:21:5  intents.agent.unsure  the control intent "agent" is never confirmed, so "unsure" does nothing for it  ->  delete "unsure": only a form intent, an informational one and done are confirmed when the model is unsure of them',
    ]);
    expect(defineApp(folder({ 'intents.yaml': withIntent('done', 'unsure: no-match') }), libraryCode).intents.done!.unsure).toBe('no-match');
  });
});

describe('defineApp: the folder and the code must name the same things', () => {
  const { complete } = libraryCode.forms.renew_loan!;

  it('a hook a form declares that the code does not define', () => {
    expect(problems({ ...libraryCode, forms: { ...libraryCode.forms, renew_loan: { complete } } })).toEqual([
      'forms.yaml:6:13  forms.renew_loan.hooks[0]  form "renew_loan" declares the hook "confirmedParams", but the code does not define it  ->  write it in app.ts (code.forms.renew_loan.confirmedParams), or delete "confirmedParams" from this list',
    ]);
  });

  it('names the app module in its fixes: app.ts by default, the given path when the code lives elsewhere', () => {
    const code = { ...libraryCode, forms: { ...libraryCode.forms, renew_loan: { complete } } };
    const fix = (codeFile?: string): string => problems(code, LIBRARY_DIR, codeFile)[0]!.split('  ->  ')[1]!;
    expect(fix()).toBe('write it in app.ts (code.forms.renew_loan.confirmedParams), or delete "confirmedParams" from this list');
    expect(fix('src/app.ts')).toBe('write it in src/app.ts (code.forms.renew_loan.confirmedParams), or delete "confirmedParams" from this list');
    const { findHold: _, ...tools } = libraryCode.tools;
    const alone = problems({ ...libraryCode, tools, forms: { ...libraryCode.forms, check_hold: { ...libraryCode.forms.check_hold!, onAnswers: () => undefined } } }, LIBRARY_DIR, 'src/app.ts');
    expect(alone.every((line) => !line.includes('app.ts (') || line.includes('src/app.ts (') || line.startsWith('src/app.ts'))).toBe(true);
  });

  it('a hook the code defines that the form does not declare', () => {
    expect(problems({ ...libraryCode, forms: { ...libraryCode.forms, check_hold: { ...libraryCode.forms.check_hold!, onAnswers: () => undefined } } })).toEqual([
      'forms.yaml:10:5  forms.check_hold.hooks  form "check_hold" has the hook "onAnswers" in the code, but forms.yaml does not declare it  ->  add "onAnswers" to forms.check_hold.hooks, or delete the hook from app.ts (code.forms.check_hold.onAnswers)',
    ]);
  });

  it('a tool policy.yaml names that the code does not define', () => {
    const { findHold: _, ...tools } = libraryCode.tools;
    expect(problems({ ...libraryCode, tools })).toEqual([
      'policy.yaml:8:3  actions.findHold  tool "findHold" is not defined in the code  ->  add it to the app\'s tools in app.ts (code.tools.findHold), or delete this action',
      // Only findHold sends the branch, so its audit declaration is left with nothing to declare.
      'policy.yaml:20:3  audit.branch  no tool lists "branch" in its params, so the declaration is never used  ->  delete it, or add "branch" to the params of the tool whose calls carry it',
    ]);
  });

  it('a slot a form (or app.yaml) names that the code does not define', () => {
    const { branch: _, ...slots } = libraryCode.slots;
    expect(problems({ ...libraryCode, slots })).toEqual([
      'app.yaml:16:5  console.slotLabels.branch  slot "branch" has a label, but the code defines no slot "branch"  ->  delete it, or add the slot to app.ts (code.slots.branch)',
      'app.yaml:27:14  carrySlots[0]  slot "branch" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.branch)',
      'forms.yaml:8:19  forms.check_hold.slots[1]  slot "branch" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.branch)',
      'locale/es/slots.yaml:10:1  branch  slot "branch" has wording in locale/es/slots.yaml, but the code defines no slot "branch"  ->  delete it, or add the slot to app.ts (code.slots.branch)',
    ]);
  });

  it('a custom rule policy.yaml names that the code does not define', () => {
    expect(problems({ ...libraryCode, customRules: undefined })).toEqual([
      'policy.yaml:12:17  actions.findHold.rules[1].custom  custom rule "known-branch" is not defined in the code  ->  add it to app.ts (code.customRules["known-branch"]), or delete this rule',
    ]);
  });

  it('what only the code names: a form, a tool and a rule the folder does not, a misspelt hook, a built-in rule id, identity code without identity.yaml', () => {
    const code: AppCode = {
      ...libraryCode,
      forms: { ...libraryCode.forms, renew_lone: { complete }, check_hold: { ...libraryCode.forms.check_hold!, onSumaryRead: () => null } as AppCode['forms'][string] },
      tools: { ...libraryCode.tools, payFine: { run: () => ({ value: null, summary: 'paid' }) } },
      customRules: { ...libraryCode.customRules, R2: libraryCode.customRules!['known-branch']!, 'late-fee': libraryCode.customRules!['known-branch']! },
      identity: { sendCodeParams: () => ({}) },
    };
    expect(problems(code)).toEqual([
      'forms.yaml:2:1  forms  the code has hooks for the form "renew_lone" (code.forms.renew_lone), but forms.yaml has no form "renew_lone"  ->  rename it to "renew_loan" in app.ts (code.forms.renew_lone), or add "renew_lone:" under forms in forms.yaml, or delete the hooks from app.ts (code.forms.renew_lone)',
      'policy.yaml:2:1  actions  tool "payFine" (code.tools.payFine) has no entry under actions, so it can never be called  ->  add "payFine:" under actions with its level and rules, or delete the tool from app.ts (code.tools.payFine)',
      'policy.yaml:2:1  actions  custom rule "late-fee" (code.customRules["late-fee"]) is not named by any action\'s rules, so it never runs  ->  add "- custom: late-fee" to the rules of the action it guards, or delete the rule from app.ts (code.customRules["late-fee"])',
      'app.ts  code.forms.check_hold.onSumaryRead  "onSumaryRead" is not a form hook; the hooks are entry, onEntry, principalEntry, confirmedParams, complete, onAnswers, onSummaryAnswer, keepsSlot, onSummaryRead  ->  rename it to "onSummaryRead", or delete it from app.ts (code.forms.check_hold.onSumaryRead)',
      'app.ts  code.customRules.R2  custom rule "R2" has a built-in rule\'s id  ->  rename it in app.ts (code.customRules.R2) and in policy.yaml\'s custom: rules; the built-in ids are the rules\' names (identity, scope, confirmed, role, attempts, fields, dateInRange, limit, unlisted, subject) and their old ids (R0, R1, R2, R3, R5, R6, R7)',
      'app.ts  code.identity  the code has identity hooks, but the folder has no identity.yaml  ->  add identity.yaml (principals, levels and attempts, with the identity tools), or delete it from app.ts (code.identity)',
    ]);
  });

  it('what the YAML files name of each other: an unknown menu intent, a missing prompt, a level no one can reach', () => {
    const intents = readFileSync(join(LIBRARY_DIR, 'intents.yaml'), 'utf8').replace('intent: check_hold', 'intent: check_holds');
    const forms = readFileSync(join(LIBRARY_DIR, 'forms.yaml'), 'utf8').replace('confirm_renew', 'confirm_renewal');
    const policy = readFileSync(join(LIBRARY_DIR, 'policy.yaml'), 'utf8').replace('  findHold:\n    level: 0', '  findHold:\n    level: 1');
    expect(problems(libraryCode, folder({ 'intents.yaml': intents, 'forms.yaml': forms, 'policy.yaml': policy }))).toEqual([
      'intents.yaml:45:13  menu[1].intent  menu digit "2" names the intent "check_holds", which is not under intents  ->  rename it to "check_hold", or add "check_holds:" under intents',
      'forms.yaml:5:22  forms.renew_loan.summaryPromptId  prompt "confirm_renewal" is not in prompts.yaml  ->  rename it to "confirm_renew", or add "confirm_renewal:" to prompts.yaml with its text and interruptible',
      'policy.yaml:9:12  actions.findHold.level  action "findHold" needs identity level 1, but the app has no identity.yaml, so no caller can reach it  ->  set it to 0, or add identity.yaml so callers can verify',
    ]);
  });

  it('throws one error whose message lists every problem, one line each', () => {
    const { branch: _, ...slots } = libraryCode.slots;
    let error: unknown;
    try {
      defineApp(LIBRARY_DIR, { ...libraryCode, slots, customRules: undefined });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppDefinitionError);
    const lines = (error as Error).message.split('\n');
    expect(lines[0]).toBe(`the app in ${LIBRARY_DIR} is not valid (5 problems):`);
    expect(lines.slice(1)).toEqual((error as AppDefinitionError).problems.map((p) => `  ${formatProblem(p)}`));
    expect(lines.slice(1).map((l) => l.trim().split('  ')[0])).toEqual(['app.yaml:16:5', 'app.yaml:27:14', 'forms.yaml:8:19', 'policy.yaml:12:17', 'locale/es/slots.yaml:10:1']);
    // The code it was given rides along for check, out of sight of a log or JSON.stringify, and not as `code`.
    expect((error as AppDefinitionError).appCode?.tools).toBe(libraryCode.tools);
    expect(Object.keys(error as object)).not.toContain('appCode');
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty('appCode');
    expect((error as { code?: unknown }).code).toBeUndefined();
  });
});

describe('defineApp: what app.yaml shows and the clips name, and what the confirmed rule needs', () => {
  const app = (edit: (text: string) => string): string => folder({ 'app.yaml': edit(readFileSync(join(LIBRARY_DIR, 'app.yaml'), 'utf8')) });

  it('console labels, the slot order and question prefixes name forms and slots that exist; a lookup fact names a tool', () => {
    const dir = app((t) =>
      t
        .replace('    renew_loan: Renew a book', '    renew_lone: Renew a book')
        .replace('    branch: Branch', '    brnach: Branch\n  slotOrder: [book, branchh]\n  questionPrefixes:\n    bok: [bok]\n  facts:\n    - kind: lookup\n      tool: findHolds\n      param: book\n      noun: hold for'),
    );
    expect(problems(libraryCode, dir)).toEqual([
      'app.yaml:12:5  console.formLabels.renew_lone  form "renew_lone" has a label, but forms.yaml has no form "renew_lone"  ->  rename it to "renew_loan", or delete the label',
      'app.yaml:16:5  console.slotLabels.brnach  slot "brnach" has a label, but the code defines no slot "brnach"  ->  rename it to "branch", or delete it, or add the slot to app.ts (code.slots.brnach)',
      'app.yaml:17:21  console.slotOrder[1]  slot "branchh" is in the console\'s slot order, but the code defines no slot "branchh"  ->  rename it to "branch", or delete it, or add the slot to app.ts (code.slots.branchh)',
      'app.yaml:19:5  console.questionPrefixes.bok  slot "bok" has question prefixes, but the code defines no slot "bok"  ->  rename it to "book", or delete it, or add the slot to app.ts (code.slots.bok)',
      'app.yaml:22:13  console.facts[0].tool  the console fact names the tool "findHolds", which the code does not define  ->  rename it to "findHold", or name a tool in app.ts (code.tools)',
    ]);
  });

  it('a voice tag names a vocabulary clip, a clip id is used once, and a clip plays for a variable some line has', () => {
    const dir = app((t) =>
      t.replace(
        'prompts:\n  spokenVars: [due]',
        'prompts:\n  spokenVars: [due]\n  vocabulary:\n    - id: riverside\n      text: Riverside\n      vars: [branch]\n    - id: riverside\n      text: Riverside\n      vars: [brnch]\n  tags:\n    riversde: "[calm]"\n    riverside: "[calm]"',
      ),
    );
    expect(problems(libraryCode, dir)).toEqual([
      'app.yaml:35:11  prompts.vocabulary[1].id  vocabulary id "riverside" is used twice  ->  give each clip its own id',
      'app.yaml:37:14  prompts.vocabulary[1].vars[0]  the clip "riverside" plays for {brnch}, but no line in prompts.yaml has {brnch}  ->  rename it to "branch", or delete it',
      'app.yaml:39:5  prompts.tags.riversde  the voice tag for "riversde" names no clip: the tags are keyed by the vocabulary\'s clip ids  ->  rename it to "riverside", or delete it, or add "riversde" to prompts.vocabulary',
    ]);
  });

  it('a tool that runs the confirmed rule needs a form with confirmedParams, or the rule blocks every call', () => {
    const forms = readFileSync(join(LIBRARY_DIR, 'forms.yaml'), 'utf8').replace('hooks: [confirmedParams, complete]', 'hooks: [complete]');
    const { confirmedParams: _, ...renew } = libraryCode.forms.renew_loan!;
    expect(problems({ ...libraryCode, forms: { ...libraryCode.forms, renew_loan: renew } }, folder({ 'forms.yaml': forms }))).toEqual([
      'policy.yaml:7:9  actions.renewLoan.rules[1]  "renewLoan" runs the confirmed rule, but no form has a confirmedParams hook, so nothing is ever confirmed and the rule blocks every call  ->  add "confirmedParams" to the hooks of the form that makes the write, and write it in the code',
    ]);
  });
});

describe('defineApp: the locales an App has', () => {
  const withoutLocales = (appYaml: (text: string) => string): App => {
    const dir = folder({ 'app.yaml': appYaml(readFileSync(join(LIBRARY_DIR, 'app.yaml'), 'utf8')) });
    rmSync(join(dir, 'locale'), { recursive: true });
    return defineApp(dir, libraryCode);
  };

  it('app.yaml\'s locale: alone gives the App its locales, the default\'s and no others', () => {
    expect(withoutLocales((t) => t).locales).toEqual({ default: 'en-US', prompts: {} });
    expect(withoutLocales((t) => t.replace('locale: en-US', 'locale: en-GB')).locales).toEqual({ default: 'en-GB', prompts: {} });
  });

  it('neither locale: nor a locale/ folder: the App has no locales at all', () => {
    const app = withoutLocales((t) => t.replace('locale: en-US\n', ''));
    expect(app.locales).toBeUndefined();
    expect(Object.keys(app)).not.toContain('locales');
  });
});

describe('defineApp: the voice on the phone, by locale and by number called (voice.locales, voice.numbers)', () => {
  const APP_YAML = readFileSync(join(LIBRARY_DIR, 'app.yaml'), 'utf8');
  /** The library's app.yaml with `lines` added to its voice block (they start at line 23). */
  const withVoice = (...lines: string[]): string => {
    const text = APP_YAML.replace('      spell: lead\n', `      spell: lead\n${lines.join('\n')}\n`);
    expect(text).not.toBe(APP_YAML);
    return folder({ 'app.yaml': text });
  };

  it('loads a voice block that names each locale\'s languages, voices and hints, and the locale a number starts in', () => {
    const dir = withVoice(
      '  numbers:',
      '    "+15555550142": es',
      '  locales:',
      '    en-US:',
      '      voices: { twilio: en-US-Journey-O, telnyx: Telnyx.Ultra.Callie }',
      '    es:',
      '      tts: es-US',
      '      transcription: es-MX',
      '      voices: { twilio: es-US-Journey-F, telnyx: Telnyx.Ultra.Asher }',
      '      hints: [renovar, reserva, sucursal]',
    );
    const app = defineApp(dir, libraryCode);
    expect(app.voice?.numbers).toEqual({ '+15555550142': 'es' });
    expect(app.voice?.locales).toEqual({
      'en-US': { voices: { twilio: 'en-US-Journey-O', telnyx: 'Telnyx.Ultra.Callie' } },
      es: { tts: 'es-US', transcription: 'es-MX', voices: { twilio: 'es-US-Journey-F', telnyx: 'Telnyx.Ultra.Asher' }, hints: ['renovar', 'reserva', 'sucursal'] },
    });
    expect(undefinedKeys(app.voice)).toEqual([]);
    // Without them, the voice is as it was.
    expect(Object.keys(libraryApp.voice!)).toEqual(['hints', 'spokenDigits']);
  });

  it('voice: a locale the app does not have, under voice.locales', () => {
    expect(problems(libraryCode, withVoice('  locales:', '    fr-CA:', '      tts: fr-CA'))).toEqual([
      'app.yaml:24:5  voice.locales.fr-CA  "fr-CA" is not a locale of this app  ->  add locale/fr-CA/ or use one of en-US, es',
    ]);
  });

  it('voice: a number that starts a call in a locale the app does not have', () => {
    expect(problems(libraryCode, withVoice('  numbers:', '    "+15555550142": fr'))).toEqual([
      'app.yaml:24:21  voice.numbers["+15555550142"]  "fr" is not a locale of this app  ->  add locale/fr/ or use one of en-US, es',
    ]);
  });

  it('voice: a number that is not E.164', () => {
    expect(loadProblems(withVoice('  numbers:', '    "555-0142": es'))).toEqual([
      'app.yaml:24:5  voice.numbers["555-0142"]  the key "555-0142" must be an E.164 number like +15555550142  ->  write the number with + and the country code, in quotes ("+15555550142")',
    ]);
  });

  it('voice: a voice for a provider the engine does not know', () => {
    expect(problems(libraryCode, withVoice('  locales:', '    es:', '      voices: { twilio: es-US-Journey-F, acme: Clara }'))).toEqual([
      'app.yaml:25:42  voice.locales.es.voices.acme  unknown voice provider "acme"  ->  use twilio or telnyx',
    ]);
  });

  it('voice: tts and transcription must be language tags', () => {
    expect(loadProblems(withVoice('  locales:', '    es:', '      tts: Spanish', '      transcription: es_MX'))).toEqual([
      expect.stringMatching(/^app\.yaml:25:12 {2}voice\.locales\.es\.tts {2}"Spanish" is not a language tag like "en-US" or "fr" {2}-> {2}write a language tag/),
      expect.stringMatching(/^app\.yaml:26:22 {2}voice\.locales\.es\.transcription {2}"es_MX" is not a language tag like "en-US" or "fr" {2}-> {2}write a language tag/),
    ]);
  });
});

/** The problems loading the folder finds, before the code is looked at. */
function loadProblems(dir: string): string[] {
  return loadAppFolder(dir).problems.map(formatProblem);
}

describe('defineApp: a folder that does not load', () => {
  it('throws the loader\'s problems, unchanged, without looking at the code', () => {
    const forms = readFileSync(join(LIBRARY_DIR, 'forms.yaml'), 'utf8').replace('summaryPromptId: confirm_renew', 'summaryPrompId: confirm_renew');
    const dir = folder({ 'forms.yaml': forms, 'prompts.yaml': 'prompts:\n  greeting:\n    text: Hi\n' });
    const expected = loadAppFolder(dir).problems.map(formatProblem);
    expect(expected.length).toBeGreaterThan(0);
    expect(problems({ ...libraryCode, slots: {} }, dir)).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining([
      'forms.yaml:5:5  forms.renew_loan.summaryPrompId  unknown key "summaryPrompId" under forms.renew_loan  ->  rename "summaryPrompId" to "summaryPromptId"',
    ]));
    expect(expected.some((line) => line.startsWith('prompts.yaml:') && line.includes('"interruptible"'))).toBe(true);
  });

  it('reports a folder that is not there', () => {
    expect(problems(libraryCode, join(LIBRARY_DIR, 'no-such-folder'))).toEqual([
      expect.stringMatching(/^\.:1:1 {2}\(file\) {2}the app folder ".*no-such-folder" does not exist {2}-> {2}pass the path of the folder/),
    ]);
  });
});

describe('defineApp: identity and policy wording', () => {
  const IDENTITY = [
    'principals:',
    '  subject: patron',
    '  delegates:',
    '    staff: { roles: [clerk, volunteer] }',
    'levels:',
    '  1: { name: verified, factors: [card], verify: verifyCard, failedPrompt: card_failed }',
    '  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: checkCode }',
    'attempts: 3',
    '',
  ].join('\n');
  /** policy.yaml for the identity above: `role` is a rule added to findHold, `extra` more top-level sections. */
  const policy = (role = '', extra = '') =>
    [
      'actions:',
      '  renewLoan:',
      '    level: 1',
      '    rules:',
      '      - identity',
      '      - confirmed: [book]',
      '  findHold:',
      '    level: 0',
      '    rules:',
      '      - identity',
      '      - custom: known-branch',
      ...(role ? [`      - role: { ${role} }`] : []),
      '  listLoans:',
      '    level: 0',
      '    rules: [identity]',
      '  verifyCard:',
      '    level: 0',
      '    rules: [attempts]',
      '  checkCode:',
      '    level: 0',
      '    rules: [attempts]',
      '  sendCode:',
      '    level: 0',
      '    rules: [identity]',
      extra,
      'audit:',
      '  book: keep',
      '  branch: keep',
      '',
    ].join('\n');
  const prompts = () => `${readFileSync(join(LIBRARY_DIR, 'prompts.yaml'), 'utf8')}  card_failed:\n    text: That card number did not match.\n    interruptible: true\n`;
  const run = () => ({ value: null, summary: 'ok' });
  const code: AppCode = {
    ...libraryCode,
    tools: { ...libraryCode.tools, verifyCard: { run, params: ['card'] }, checkCode: { run, params: [] }, sendCode: { run, params: ['card'] } },
    identity: { sendCodeParams: (s) => ({ card: s.slots.card?.value ?? '' }) },
  };

  it('builds identity from identity.yaml with the code\'s sendCodeParams, in the contract\'s order', () => {
    const app = defineApp(folder({ 'identity.yaml': IDENTITY, 'policy.yaml': policy(), 'prompts.yaml': prompts() }), code);
    expect(Object.keys(app.identity!)).toEqual(['subjectKind', 'delegateKind', 'factorSlots', 'verifyTool', 'codeTool', 'sendCodeTool', 'sendCodeParams', 'failedPromptId', 'codeLength', 'levelNames', 'delegateRoles', 'maxAttempts']);
    expect(app.identity).toMatchObject({ subjectKind: 'patron', delegateKind: 'staff', factorSlots: ['card'], verifyTool: 'verifyCard', codeTool: 'checkCode', sendCodeTool: 'sendCode', failedPromptId: 'card_failed' });
    expect(app.identity!.sendCodeParams).toBe(code.identity!.sendCodeParams);
    expect(Object.keys(app).indexOf('identity')).toBe(Object.keys(app).indexOf('slots') + 1);
  });

  it('names identity tools and factor slots the code does not define, and leaves the rest to validateApp', () => {
    const { card: _, ...slots } = code.slots;
    const { sendCode: __, ...tools } = code.tools;
    const dir = folder({ 'identity.yaml': IDENTITY, 'policy.yaml': policy(), 'prompts.yaml': prompts() });
    expect(problems({ ...code, slots, tools }, dir)).toEqual([
      // the library's check_loans form asks for the card too
      'forms.yaml:12:13  forms.check_loans.slots[0]  slot "card" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.card)',
      // With no card slot, nothing says the card number is recorded by its last four any more.
      'policy.yaml:12:3  actions.listLoans  the param "card" of "listLoans" (code.tools.listLoans.params) is neither a slot with a redact setting nor declared under audit, so how it is recorded is not said  ->  declare it under audit in policy.yaml ("card: keep" to record it as it is, or last4, mask, length or secret), or make "card" a slot with a redact setting',
      'policy.yaml:15:3  actions.verifyCard  the param "card" of "verifyCard" (code.tools.verifyCard.params) is neither a slot with a redact setting nor declared under audit, so how it is recorded is not said  ->  declare it under audit in policy.yaml ("card: keep" to record it as it is, or last4, mask, length or secret), or make "card" a slot with a redact setting',
      'policy.yaml:21:3  actions.sendCode  tool "sendCode" is not defined in the code  ->  add it to the app\'s tools in app.ts (code.tools.sendCode), or delete this action',
      'identity.yaml:6:34  levels["1"].factors[0]  slot "card" is not defined  ->  add it to the app\'s slots in app.ts (code.slots.card)',
      'identity.yaml:7:74  levels["2"].send  tool "sendCode" is not defined in the code  ->  add it to the app\'s tools in app.ts (code.tools.sendCode)',
    ]);
    // A subject kind the audit reserves is validateApp's to refuse; defineApp reports it in the same format.
    const reserved = folder({ 'identity.yaml': IDENTITY.replace('patron', 'principal'), 'policy.yaml': policy(), 'prompts.yaml': prompts() });
    expect(problems(code, reserved)).toEqual([
      '.  (file)  validateApp refused the app: app "library": identity subjectKind "principal" is reserved  ->  correct the reference it names, in the YAML file or in app.ts',
    ]);
  });

  it('fills policy.yaml\'s role templates with {role} and {tool} only, and never runs them', () => {
    const wording = 'wording:\n  recordOwner: card holder\n  role:\n    allow: "{role} staff may use {tool}"\n    person: "{role} needs a person for {tool}: $(whoami) {other}"\n';
    const roles = 'clerk: allow, volunteer: person';
    expect(problems(code, folder({ 'identity.yaml': IDENTITY, 'policy.yaml': policy(roles, wording), 'prompts.yaml': prompts() }))).toEqual([
      'policy.yaml:29:13  wording.role.person  the template names {other}; only {role} and {tool} are filled in  ->  write {role} or {tool} in its place, or plain words',
    ]);
    const app: App = defineApp(folder({ 'identity.yaml': IDENTITY, 'policy.yaml': policy(roles, wording.replace(' {other}', '')), 'prompts.yaml': prompts() }), code);
    expect(app.policy.roles).toEqual({ findHold: { clerk: 'allow', volunteer: 'person' } });
    expect(app.policy.rolePersonReason).toBeUndefined();
    expect(app.policy.wording?.recordOwner).toBe('card holder');
    const role = app.policy.wording!.role!;
    expect(role('clerk', 'findHold', 'allow')).toBe('clerk staff may use findHold');
    expect(role('volunteer', 'findHold', 'person')).toBe('volunteer needs a person for findHold: $(whoami)');
    // An access the YAML leaves out reads the engine's own words.
    expect(role('guest', 'findHold', 'refuse')).toBe('role guest may findHold: no');
  });
});

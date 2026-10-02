# Authoring an app

This guide is for a developer, or an AI coding assistant, who is building a DialogWright app or changing one. It says what an app is made of, what goes in each file, what stays in TypeScript and why, how `pnpm check` finds mistakes, and how locales and configuration hashes work. Read [CLAUDE.md](../CLAUDE.md) first for the rules (the gate decides, a model never writes a regulated line, an app imports only from `'dialogwright'`).

Two apps in this repository are the examples, and every snippet below is copied from one of them:

- `apps/clinic`: Example Family Practice, a fictional appointment line. Five forms, no identity verification, scheduling hooks. Its README has a section, "The app as a folder", with more detail.
- `packages/dialogwright/src/define/fixture/`: Example Town Library, a tiny app (two forms, one rule of its own, a Spanish locale) that the engine's own tests build. It is the smallest complete app, so the snippets here come mostly from it.

## Contents

1. [The folder](#1-the-folder)
2. [The files, one by one](#2-the-files-one-by-one)
3. [What stays in TypeScript, and why](#3-what-stays-in-typescript-and-why)
4. [The form hooks](#4-the-form-hooks)
5. [Checking an app: `pnpm check`](#5-checking-an-app-pnpm-check)
6. [Locales](#6-locales)
7. [Configuration hashes](#7-configuration-hashes)
8. [Editor support](#8-editor-support)
9. [Walkthroughs](#9-walkthroughs)

## 1. The folder

An app is a folder. What is data is YAML; what runs is TypeScript. `defineApp(dir, code)` loads the folder, checks that the YAML and the code name the same things, and returns the `App` the engine runs. It throws one `AppDefinitionError` that lists every problem if either side is wrong.

```
my-app/
  app.yaml          who the app is and how it presents itself
  intents.yaml      what a caller can ask for, and the keypad menu
  forms.yaml        each form's slots, its summary prompt, and the code hooks it has
  prompts.yaml      every line a caller can hear
  policy.yaml       the gate's tables
  identity.yaml     optional: how a caller proves who they are
  locale/<tag>/     optional: prompts.yaml for each extra language
  app.ts            the code: export const code: AppCode = { ... }
  fixtures/         optional: corpus.jsonl, scripted calls, a baseline, recorded cassettes
```

Five YAML files are required (app, intents, forms, prompts, policy). `identity.yaml` is optional: an app without it verifies no one, and every tool must then be at level 0 (the clinic is like this).

The code lives in `app.ts` in the folder, or in `src/app.ts` when the folder is also a package (the clinic). `dialogwright check` looks in both. The module exports the code parts as `code` (an `AppCode`), and may also call `defineApp` itself to build the app, as both examples do. A module that does so must import without starting anything else: `check` imports it.

`dialogwright check` imports the folder's app module, and importing a module runs it. Never run `check` on a folder whose code you would not run yourself.

Nothing in the YAML is ever run. Prompt text, model criteria and wording templates are strings; the only expression is a spoken-digits pattern, which becomes a regular expression.

## 2. The files, one by one

Each file below shows a short real example and says what the file is for. The complete field list of each file is its JSON Schema in `packages/dialogwright/schemas/`, and every field has a description there.

### app.yaml

Who the app is, and how it presents itself. Only `id` is required. From the library:

```yaml
id: library
locale: en-US

brand:
  name: Example Town Library
  mark: TL

console:
  formLabels:
    renew_loan: Renew a book
    check_hold: Check a hold
  slotLabels:
    book: Book
    branch: Branch

voice:
  hints: [renew, hold, branch, Riverside]
  spokenDigits:
    - pattern: '(card )(\d{4,})'
      spell: lead

wording:
  addressee: the library line

carrySlots: [branch]

prompts:
  spokenVars: [due]
```

- `id` names the app in the registry. `locale` is the language of `prompts.yaml` (default `en-US`).
- `brand` and `console` are what the operator console shows: the app's name, form and slot labels, the badge for each identity level, and the facts a tool call leaves.
- `voice` holds the phone line's speech settings: words the recognizer should expect, and how digits that are identifiers are spelled for text to speech.
- `wording` is the engine's own questions to the decision model, in the app's words (whom the caller is addressing, what counts as a hedge). Every string is sent to the model as written.
- `thresholds` adds the app's own named thresholds (the clinic has `TIME_OF_DAY`). `carrySlots` names slots that outlast the form that filled them (the clinic carries the caller's name and date of birth, so a second task does not ask again).
- `fixtures: { dir: fixtures }` says where the corpus and the scripted calls are. The folder is relative to the app's package root, which is the folder its commands run in: the engine reads it from the working directory, and an app's `regress`, `cli` and `serve` scripts run in its package. It must stay inside the package, so an absolute path or one with `..` is refused. `check` then requires every intent to have examples there.
- `prompts` holds what is said about prompts besides their text: which opening lines to use, which variables are always spoken by text to speech, the clips' vocabulary.

### intents.yaml

What a caller can ask for, in the order the decision model is offered them, and the keypad menu.

```yaml
intents:
  renew_loan:
    criteria: Wants to renew a book they have borrowed, so it is due back later
    label: renew a book
    kind: form
  hours:
    criteria: Asks when the library is open
    label: hear the opening hours
    kind: informational
    promptId: hours
  agent:
    criteria: Asks to speak with a person, a librarian, or the front desk
    label: speak with someone
    kind: control
  repeat_prompt:
    criteria: Asks the system to repeat what it just said
    label: hear that again
    kind: control

menu:
  - digit: "1"
    intent: renew_loan
  - digit: "0"
    intent: agent
```

- `criteria` is sent to the decision model as written, so changing it changes what the model sees (a recorded cassette then misses). `label` is how the line says the intent ("Sure, I can help you renew a book").
- `kind: form` starts the form with the same id in forms.yaml. `kind: informational` plays its `promptId` and goes back to where the caller was. `kind: control` is the engine's own.
- Two control intents are required, because the engine reads them by name: `agent` and `repeat_prompt`. The snippet above shows both. The other control intents (`done`, `other`, `none`) are optional; the library has all three, and the clinic leaves out `done`, since its calls end when a task completes.
- Keypad digits are quoted strings.

### forms.yaml

Each form collects slots, optionally reads them back for a yes, and then does something.

```yaml
forms:
  renew_loan:
    slots: [book]
    summaryPromptId: confirm_renew
    hooks: [confirmedParams, complete]
  check_hold:
    slots: [book, branch]
    summaryPromptId: null
    hooks: [complete]
```

- `slots` are asked in this order. Every slot id must be a slot spec in the code (section 3).
- `summaryPromptId` is the prompt that reads the filled form back for a yes. `null` means the form completes as soon as its slots are full.
- `hooks` lists the code hooks the form uses. `complete` is required. The list must match the code exactly: `defineApp` refuses a hook the code writes that the list leaves out, and a hook the list names that the code does not write. Section 4 says what each hook is.
- Every form id must also be a `kind: form` intent.

### prompts.yaml

Every line a caller can hear, word for word. The agent says exactly these and never composes its own.

```yaml
prompts:
  ask_intent:
    text: How can I help you today?
    interruptible: true
  ask_book:
    text: Which book is it?
    interruptible: true
  confirm_renew:
    text: You'd like to renew {book} for two more weeks. Shall I do that?
    interruptible: true
  renewed:
    text: Done. {book} is now due back {due}.
    interruptible: false
```

- Variables in braces are filled by the engine (`{intentLabel}`) or by the app's code (`{book}`, `{due}`).
- `interruptible: false` for a line that must be heard whole (a keypad instruction, a statement).
- `mode` can only be `fixed` (the default). A model chooses among these lines; it never writes one. Generated wording is a later phase.
- The engine itself says about thirty lines by name (`goodbye`, `no_input`, `offer_transfer`, the handoff lines, and so on), and `ask_<slot>` and `ask_<slot>_retry` for every slot. Some lines depend on the slot's spec in the code: `ask_<slot>_dtmf` for a slot with a keypad rung (`dtmf`), `confirm_<slot>` and `ask_<slot>_dtmf` for a slot whose every spoken value is read back (`spokenConfirm: 'always'`), `ack_<slot>` for one acknowledged by confidence (`spokenConfirm: 'by-confidence'`), and the slot's `partialPromptId`. A role whose access to a tool is `person` needs the handoff line for policy.yaml's `rolePersonReason` (`handoff_role_person` by default). `pnpm check` lists any that are missing and says when the engine says each (section 5).

### policy.yaml

The gate's tables: the whole of what the app's agent may do. Policy is data here, and never lives in a tool.

```yaml
toolLevel:
  renewLoan: 0
  findHold: 0
rulesFor:
  renewLoan: [R1, R3]
  findHold: [R1, known-branch]
confirmedFields: [book]
maxAttempts: 3
```

- `toolLevel` is the identity level each tool needs (0 anonymous, 1 the factors matched, 2 the factors and a one-time code). A tool with no level needs the highest.
- `rulesFor` lists, per tool, the rules the gate runs before it. `R1` is the level, `R2` scope (whose record), `R3` confirmation (the write matches exactly what the caller said yes to), `R5` role, `R6` attempts and `R7` the fields sent on to a downstream service. A name that is not built in is a custom rule, written in the code (`known-branch` above). Every tool in the code needs a row here; a tool with no row cannot be called.
- `confirmedFields` are the fields a confirmed write carries, in the order the confirmation hash is taken over. `maxAttempts` is the limit at each identity check.
- Other tables: `purposeLevel`, `subjects` (R2: which param names the subject), `serviceFields` (R7), `roles` (R5), and `wording` (the words the rules use in the audit and the console).

### identity.yaml (optional)

How a caller proves who they are. The clinic has none. The engine's valid-folder test fixture is:

```yaml
subjectKind: patient
delegateKind: staff
factorSlots: [patientId, dob]
verifyTool: verifyPatient
codeTool: verifyCode
sendCodeTool: sendCode
failedPromptId: identity_failed
```

`factorSlots` are slots the code defines, asked on voice for a step-up; each slot id is also the name of the verify tool's param that carries its value. The three tools are tools in the code, with rows in policy.yaml. The one function in this part, the params of the one-time code call, stays in code as `code.identity.sendCodeParams`. With an identity.yaml, the engine also says the identity lines (`identity_verified`, `ask_otp`, `otp_failed` and others), and `check` requires them in every locale.

### locale/&lt;tag&gt;/prompts.yaml (optional)

The prompts for another language, in the same shape as prompts.yaml. See section 6.

### fixtures/ (optional)

The corpus (`corpus.jsonl`, one labelled utterance per line), scripted calls, the baseline, and recorded cassettes. They are how an app is tested with no keys: the stub decision model answers from the corpus labels. The clinic's README explains the harness; the only rule `check` adds is that every intent has examples in the corpus when `app.yaml` names a fixtures directory:

```json
{"id":"sn-01","text":"I'd like to make an appointment","intent":"schedule_new","context":"no_form"}
```

## 3. What stays in TypeScript, and why

The test for what is data: could a person who does not write code review it, and could it be wrong without anything executing? Intents, forms, prompt text, the gate's tables and presentation are like that. What runs stays in code, because YAML that tried to describe it would grow into a language of its own. The code is one object, `code: AppCode`:

| Part of `code` | What it is | Why it is not YAML |
|---|---|---|
| `slots` | A `SlotSpec` per slot: the questions the decision model is asked, how its answers become a value (`fill`), the keypad shape, how it is read back (`display`) | It is a parser. A slot library of built-in types, so most slots need no code, is planned. |
| `tools` | A `ToolDef` per tool: `run(call, sys, ctx)` does the work and returns `{ value, summary }` | It calls the app's systems. It never decides whether it may run: the gate does, from policy.yaml. |
| `systems` | A factory for a fresh copy of the app's systems for each call, and the gate's lookups over them (`ownerOf`, `scopeOf`) | State and connections. |
| `forms` | The hooks of each form, by form id (section 4) | They run during the dialog. |
| `customRules` | The app's own policy rules, by the id `rulesFor` names them by | A rule compares values and decides. |
| `principals`, `portal`, `services` | Signed-in callers, the app's own portal settings (never read by the engine), downstream service clients | Integration. |
| `facts`, `questions`, `callerState`, `blockPromptId`, `onServiceResult` | What the app keeps on the session, its own model questions, and small decisions the engine asks the app to make | They are functions of the session. |
| `testing` | The hooks the regression harness and the stubs use | Test support. |
| `identity.sendCodeParams` | The one-time code call's params | A function. |

The library's code, in full outline (`packages/dialogwright/src/define/fixture/app.ts`):

```ts
export const libraryCode: AppCode = {
  slots: LIBRARY_SLOTS,
  tools: LIBRARY_TOOLS,
  systems: () => ({ sys: new LibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    renew_loan: { confirmedParams: renewParams, complete: renew },
    check_hold: { complete: checkHold },
  },
  customRules: { 'known-branch': knownBranch },
};

export const code = libraryCode;
export const libraryApp = defineApp(LIBRARY_DIR, libraryCode);
```

A tool says what an action does and nothing about whether it may run:

```ts
export const LIBRARY_TOOLS: Record<string, ToolDef> = {
  findHold: {
    run(call, sys) {
      const status = (sys as LibrarySystems).holds[`${call.params.book}@${call.params.branch}`] ?? null;
      return { value: status, summary: status ? `hold ${status}` : 'no hold' };
    },
  },
  // ...
};
```

A custom rule returns what it compared and whether it passed, so the audit and the console can show it:

```ts
function knownBranch(c: RuleContext): RuleOutcome {
  const branch = c.call.params.branch ?? '';
  const known = Object.hasOwn(BRANCHES, branch);
  const result = { id: 'known-branch', description: 'The hold is at one of the library\'s branches', compared: known ? `branch ${branch}: known` : 'branch not known', pass: known };
  return known ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'branch' } };
}
```

An app outside the engine package imports only from `'dialogwright'` (the clinic's `src/app.ts` does), and the clinic's launchers (`src/index.ts`, `cli.ts`, `regress.ts`, `serve.ts`) show how an app is registered and run.

## 4. The form hooks

`forms.yaml` lists the hooks a form has, and `code.forms.<id>` writes them. `complete` is required; the rest are optional. The hook names, in the order the contract documents them (the type is `FormDef` in `core/app/types.ts`):

| Hook | When it runs |
|---|---|
| `entry` | A call made before the form's own slots are asked (it may step identity up). |
| `onEntry` | Applies a successful entry call's result to the session. |
| `principalEntry` | In place of `entry`, for someone acting for subjects (a delegate). |
| `confirmedParams` | The values a confirmed write sends, read from the session, for the gate's R3. |
| `complete` | The form is full (and confirmed, where it has a summary): does the work, usually by calling a tool through the gate. |
| `onAnswers` | The form heard a spoken turn: lets it keep a volunteered preference. |
| `onSummaryAnswer` | At the summary, an answer that was neither a yes nor a change: the form's own move along what the summary offers. |
| `keepsSlot` | At the summary, whether a named detail is kept and the answer is the form's own move instead. |
| `onSummaryRead` | The summary is about to be read: lets the form look at what it names that the slots do not hold. |

The clinic's reschedule form has six: `[onSummaryRead, onAnswers, onSummaryAnswer, keepsSlot, confirmedParams, complete]`. The library's check_hold has one. Start with `complete` and add a hook only when the form needs it.

## 5. Checking an app: `pnpm check`

```sh
pnpm check                                          # every app folder under apps/
pnpm check ../../apps/clinic                        # one folder (paths are relative to packages/dialogwright)
pnpm check --json ../../apps/clinic                 # the problems as JSON, for a program or an assistant
```

(`pnpm check` runs the `dialogwright check` command in the engine package, so a folder you name is relative to `packages/dialogwright`.)

At the repository root, `pnpm check` finds every folder under `apps/` that has an `app.yaml`. It exits 0 when no folder has a problem, 1 when one has, and 2 for a command it does not understand. CI runs it on every push.

It checks, in one pass:

1. **Each file against its schema.** Unknown keys, wrong types, a missing required file, a YAML syntax error. A misspelt name offers the near match.
2. **The folder against the code**: every slot, tool, hook and custom rule the YAML names exists in the code; every hook the code writes is listed in forms.yaml; every tool in the code has a policy row; every custom rule the code defines is named in `rulesFor`; every prompt the YAML names is in prompts.yaml; the identity tools, factor slots and carried slots exist; what the console names (form and slot labels, the slot order, question prefixes, a lookup fact's tool) and the clips name (a voice tag's clip, a clip's variables) exists; a tool that runs R3 has `confirmedFields` and a form with `confirmedParams` to confirm it; and the whole app passes the engine's own `validateApp`.
3. **The engine's own lines in every locale**: every line the engine says by name, and the lines it builds for each slot and for R5's reason (section 2, prompts.yaml), exists in prompts.yaml and in each `locale/<tag>/prompts.yaml`.
4. **Each locale against prompts.yaml**: a translated line uses only the variables the prompts.yaml line has (the code fills those and no others, so another would fail when it is said), and a locale has no line that prompts.yaml does not (it would never be said).
5. **The corpus**: every intent has at least one labelled example in `corpus.jsonl`, when app.yaml names a fixtures directory. The corpus must be inside the package (a link that leads out is refused) and at most 16 MB.

The format is one line per problem, `file:line:column  path  message  ->  fix`, and then a summary line (`N problems in <folder>`, or `<folder>: ok`). A problem in the code has no YAML line, so it reads `app.ts` (or `src/app.ts`) and a code path such as `code.forms.renew_loan.entry`.

When a schema problem is found, the cross-checks against the code do not run until it is fixed, because a file that does not parse cannot be linked. Fix the schema problems first, then run it again.

These are real messages. The folder was a copy of the library fixture, with these edits: an unknown key `colour: blue` in app.yaml, `maxAttempts: three` in policy.yaml. The first run:

```
app.yaml:5:1  colour  unknown key "colour" in this file  ->  delete "colour"; the keys allowed in this file are id, locale, brand, console, voice, handoff, wording, thresholds, carrySlots, fixtures, prompts
policy.yaml:9:14  maxAttempts  "maxAttempts" must be a number, but is text ("three")  ->  write a number without quotes
2 problems in broken-library
```

After fixing those two, with these further edits made at the same time (the slot `branch` misspelt `branche` in forms.yaml, the hook `entry` listed for `renew_loan` but not written, the `goodbye` prompt deleted, the `hours` intent naming a prompt `opening_hours` that does not exist, `known-branch` misspelt `known_branch` in policy.yaml, and the Spanish `anything_else` line deleted):

```
intents.yaml:15:15  intents.hours.promptId  prompt "opening_hours" is not in prompts.yaml  ->  add "opening_hours:" to prompts.yaml with its text and interruptible
forms.yaml:6:13  forms.renew_loan.hooks[0]  form "renew_loan" declares the hook "entry", but the code does not define it  ->  write it in app.ts (code.forms.renew_loan.entry), or delete "entry" from this list
forms.yaml:8:19  forms.check_hold.slots[1]  slot "branche" is not defined  ->  rename it to "branch", or add it to the app's slots in app.ts (code.slots.branche)
prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche" is missing from prompts.yaml; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche_retry" is missing from prompts.yaml; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to prompts.yaml
policy.yaml:5:1  rulesFor  custom rule "known-branch" (code.customRules["known-branch"]) is not named under rulesFor, so it never runs  ->  add "known-branch" to the rules of the tool it guards, or delete the rule from app.ts (code.customRules["known-branch"])
policy.yaml:7:18  rulesFor.findHold[1]  rule "known_branch" is not a built-in rule (R1, R2, R3, R5, R6, R7) and the code defines no custom rule by that name  ->  rename it to "known-branch", or add it to app.ts (code.customRules.known_branch), or name a built-in rule instead
locale/es/prompts.yaml:3:1  prompts  prompt "opening_hours" is missing from the es prompts; intents.yaml:15 (intents.hours.promptId) says it  ->  add "opening_hours:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "anything_else" is missing from the es prompts; the engine says it when a form is done and it asks whether there is more  ->  add "anything_else:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche" is missing from the es prompts; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche_retry" is missing from the es prompts; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to locale/es/prompts.yaml
12 problems in broken-library
```

(The folder name is whatever you pass.) One mistake can show up in several places: the single typo `branche` produced the unknown slot and four missing prompts, and renaming the slot back to `branch` clears all of them. Fix from the top down and run it again.

A corpus problem reads:

```
intents.yaml:11:3  intents.hours  intent "hours" has no examples in the corpus (fixtures/corpus.jsonl)  ->  add a line to fixtures/corpus.jsonl such as {"id":"hours-01","text":"<what a caller says to mean this>","intent":"hours","context":"no_form"}
```

If the folder has no app module, `check` checks the YAML only and says so (`<dir>: checked the YAML only; there is no app.ts (or src/app.ts) to check it against`). An app module that cannot be imported is reported as a problem against that file, with how to see the full error.

An app's own tests can run the same check, so a broken folder fails `pnpm test` as well. `checkApp` is exported by `'dialogwright'`; pass the app's code so nothing is imported, and expect no problems (the clinic's `src/app.test.ts` does this):

```ts
import { checkApp, formatProblem } from 'dialogwright';
import { CLINIC_DIR, code } from './app';

it('passes dialogwright check', async () => {
  expect((await checkApp(CLINIC_DIR, { code })).map(formatProblem)).toEqual([]);
});
```

`loadAppFolder` (the YAML alone, with each problem) and the `DefineAppOptions` and `CheckOptions` types are exported too.

`pnpm verify` is a different command: the type check and the unit tests (`pnpm typecheck && pnpm test`). Run both before committing an app change, then the regressions the root CLAUDE.md names.

What `check` does not do yet: it cannot check generated wording (every prompt is `mode: fixed`, which the schema enforces), and it does not require a test for each custom rule. Both arrive with the phases that build them (see the roadmap in [design.md](design.md)).

## 6. Locales

An app speaks the language of its `prompts.yaml`, named by `locale:` in app.yaml (default `en-US`). To add a language, add `locale/<tag>/prompts.yaml` with the same shape. The library has `locale/es/prompts.yaml`:

```yaml
prompts:
  greeting:
    text: Gracias por llamar a la Biblioteca de Example Town. Puedo renovar un libro o revisar una reserva. ¿En qué puedo ayudarle?
    interruptible: true
```

- **What `check` requires.** In every locale: each prompt an intent, form, identity.yaml or app.yaml names, and each line the engine says (section 2, prompts.yaml). A line that only the app's code says (the library's `no_hold`) may be left out of a translation. A translated line may use only the variables of its prompts.yaml line, and a locale may not have a line prompts.yaml lacks.
- **Folders.** `locale/` holds one folder per locale, named by its language tag. A file there is a problem, and so are two folders whose names differ only in letter case (`pt-BR` and `pt-br`), which would be one locale.
- **Fallback.** A line missing from a locale is said from the default locale, one line at a time, so a half-translated app still works.
- **Choosing the locale.** The session starts in the default locale. A channel can name another: the `session.start` event carries a `locale`, and the ConversationRelay adapter reads it from a custom parameter named `locale`. It is matched against the app's locales: the same tag (letter case aside), else the app's locale that is the request's language alone (`es-US` finds `es`), else the app's first locale in that language (`es` finds `es-MX`), else the default. The request is untrusted: it is only compared, and what is used is always one of the app's own tags.
- **Spoken text.** A translated line is spoken by text to speech. Recorded clips are in the default language only.
- **Known limits.** Today a locale is chosen and its lines are said, but no channel yet carries the language end to end:
  - The server's ConversationRelay TwiML (`server/twiml.ts`) sends no `locale` parameter and sets no `language`, `ttsLanguage` or `transcriptionLanguage`, and the engine never emits the `set_language` action. So a voice session in a locale other than the default is transcribed and voiced with the relay's defaults (English), even when its lines are Spanish.
  - The chat channel has no way to ask for a locale, so every chat session speaks the default.
  - Outbound ConversationRelay text frames say `lang: en-US` whatever the session's locale.
  - Intent labels (`label:` in intents.yaml) and slot displays stay in the default language, so a Spanish line that says "Claro, puedo ayudarle a {intentLabel}" still ends with the English label.
  - Matching a requested locale looks at the language and the whole tag, not at a script subtag: a request for `zh-Hant` in an app with only `zh-Hans` finds `zh-Hans` by its language, `zh`.

  The channel parts (the TwiML's language attributes and `locale` parameter, `set_language`, a chat request for a locale, the text frames' language tag) belong to Phase 7 (Channels); localized labels and displays come with the slot library (Phase 3). See the roadmap in [design.md](design.md).
- An app with neither `locale:` in app.yaml nor a `locale/` folder behaves exactly as before: its App has no locales, its sessions carry no locale, and nothing it writes changes. `locale:` alone (as the clinic has) gives the App its locales, the default's and no others.

## 7. Configuration hashes

Every configuration file of an app built by `defineApp` has a content hash, so a call can be tied to the exact configuration it ran under.

- A file's hash is SHA-256 over its parsed content as canonical JSON (keys sorted at every level, arrays in order, no whitespace). A comment, a blank line, a reordered key or another quoting style does not change it; a changed value does.
- The combined hash is SHA-256 over the lines `<file>:<hash>`, sorted by file name and joined with newlines. It changes when any file changes, or one is added or removed. Locale files are in it by path (`locale/es/prompts.yaml`).
- They are on the app as `App.configHashes` (`app` for the combined hash, `files` for each file).
- The `call_started` audit row records the combined hash as `config` and the per-file lines as `configFiles`, so the row alone is enough to recompute and verify the combined hash.
- Every trace record carries the combined hash as `configHash`, and the console shows its first eight characters as `config <8 chars>`.
- They are never sent to the model.

An app that is not built from a folder has no hashes, and its rows are as they were.

## 8. Editor support

Every YAML file starts with a line that names its schema:

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/app.schema.json
```

The path is relative to the file (`apps/clinic/app.yaml` points two folders up to the repository root; the library's `locale/es/prompts.yaml` points five up). An editor with the YAML extension then completes keys, shows each field's description, and flags mistakes as you type. Keep the line when you copy a file into a new app, and fix the path if the new folder is at a different depth. The schemas are `app`, `intents`, `forms`, `prompts`, `policy` and `identity`; the locale files use `prompts`.

The schemas are generated from the zod schemas in `packages/dialogwright/src/define/schema/`, which are also what `check` validates with, so they cannot disagree. Never edit a `.schema.json` by hand. After changing a zod schema, run `pnpm --filter dialogwright schemas`; a test fails when the committed files are stale.

## 9. Walkthroughs

Each walkthrough ends with `pnpm check`, which is the quickest way to find what is left to do.

### Add an intent that only says something

For "what are your hours", an informational intent with no form and no code:

1. `intents.yaml`: add `hours:` with `criteria`, `label`, `kind: informational` and `promptId: hours`.
2. `prompts.yaml`: add `hours:` with its `text` and `interruptible`. Add it to every `locale/<tag>/prompts.yaml` too.
3. Optionally, `menu:` in intents.yaml gets a key for it.
4. If app.yaml names a fixtures directory, add labelled utterances to `corpus.jsonl` with `"intent":"hours"`.
5. `pnpm check`.

### Add a form

For a form that collects slots and acts, such as renewing a loan:

1. `intents.yaml`: add the intent with `kind: form`. Its id is the form's id.
2. `forms.yaml`: add the form with its `slots`, a `summaryPromptId` (or `null`) and `hooks: [complete]`. Add `confirmedParams` too if completing it is a confirmed write.
3. `prompts.yaml`: add `ask_<slot>` and `ask_<slot>_retry` for every new slot, the summary prompt, and the line the form says when it completes. Add them to each locale.
4. `app.ts`: for every new slot, add a `SlotSpec` to `code.slots` (the library's `choiceSlot` is the pattern for a list of options). Add the form's hooks under `code.forms.<id>`: `complete` calls the tool and returns what to say.
5. If the form needs a tool, follow the next walkthrough.
6. `pnpm check`, then `pnpm verify`.

### Add a tool

1. `app.ts`: add the tool to `code.tools` with `run`. It does the work and returns `{ value, summary }`. Put no permission logic in it.
2. `policy.yaml`: add a row under `toolLevel` (the level it needs) and under `rulesFor` (the rules the gate runs before it). Use `R1` for the level, add `R3` for a write the caller must confirm, and name `confirmedFields` for it.
3. If the tool is a confirmed write, give the form `confirmedParams`, and make the form's `complete` set `s.confirmedHash = s.pendingHash` before the call, as the library's `renew` does.
4. If the tool needs a rule of its own, write it in `code.customRules` and name its id under `rulesFor`.
5. `pnpm check` says if the tool and its policy row do not match: a tool with no row, a row with no tool, a rule that is never named.

### Where to start

Copy the library fixture's folder (or the clinic's) into `apps/<name>`, give it a `package.json` and the launchers the clinic has (`src/index.ts`, `cli.ts`, `regress.ts`), change `id`, empty the intents, forms, prompts and policy down to the control intents and the engine's lines, and run `pnpm check` until it says `ok`. Then add intents, forms and tools as above, running `pnpm check` after each.

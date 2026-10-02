# Authoring an app

This guide is for a developer, or an AI coding assistant, who is building a DialogWright app or changing one. It says what an app is made of, what goes in each file, what stays in TypeScript and why, how to write a slot, how `pnpm check` finds mistakes, and how locales and configuration hashes work. Read [CLAUDE.md](../CLAUDE.md) first for the rules (the gate decides, a model never writes a regulated line, an app imports only from `'dialogwright'`).

Two apps in this repository are the examples, and every snippet below is copied from one of them:

- `apps/clinic`: Example Family Practice, a fictional appointment line. Five forms, no identity verification, scheduling hooks. Its README has a section, "The app as a folder", with more detail.
- `packages/dialogwright/src/define/fixture/`: Example Town Library, a tiny app (three forms, one rule of its own, a Spanish locale) that the engine's own tests build. It is the smallest complete app, so the snippets here come mostly from it.

## Contents

1. [The folder](#1-the-folder)
2. [The files, one by one](#2-the-files-one-by-one)
3. [What stays in TypeScript, and why](#3-what-stays-in-typescript-and-why)
4. [Writing a slot](#4-writing-a-slot)
5. [The form hooks](#5-the-form-hooks)
6. [Checking an app: `pnpm check`](#6-checking-an-app-pnpm-check)
7. [Locales](#7-locales)
8. [Configuration hashes](#8-configuration-hashes)
9. [Editor support](#9-editor-support)
10. [Walkthroughs](#10-walkthroughs)

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
  slots.yaml        optional: every slot the app has, and their order
  locale/<tag>/     optional: prompts.yaml for each extra language, and slots.yaml for how its slots say values
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

- `slots` are asked in this order. Every slot id must be a slot spec in the code (section 4).
- `summaryPromptId` is the prompt that reads the filled form back for a yes. `null` means the form completes as soon as its slots are full.
- `hooks` lists the code hooks the form uses. `complete` is required. The list must match the code exactly: `defineApp` refuses a hook the code writes that the list leaves out, and a hook the list names that the code does not write. Section 5 says what each hook is.
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
- The engine itself says about thirty lines by name (`goodbye`, `no_input`, `offer_transfer`, the handoff lines, and so on), and `ask_<slot>` and `ask_<slot>_retry` for every slot. Some lines depend on the slot's spec in the code: `ask_<slot>_dtmf` for a slot with a keypad rung (`dtmf`), `confirm_<slot>` and `ask_<slot>_dtmf` for a slot whose every spoken value is read back (`spokenConfirm: 'always'`), `ack_<slot>` for one acknowledged by confidence (`spokenConfirm: 'by-confidence'`), and the slot's `partialPromptId`. A role whose access to a tool is `person` needs the handoff line for policy.yaml's `rolePersonReason` (`handoff_role_person` by default). `pnpm check` lists any that are missing and says when the engine says each (section 6). It cannot see the lines a slot's `fill` names (`disambiguate_<slot>`, a `retryPromptId`, a help prompt) unless the slot declares them in its `prompts` (section 4).

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

### slots.yaml (optional)

Names every slot the app has, one key per slot, and the order of the keys is the order of `App.slots`. Each slot is a library type with its options (the types and their options are in `schemas/slots.schema.json`; section 4 covers choosing and writing a slot) or `{ type: code }`, a slot the code writes in `code.slots.<id>`.

A slots.yaml with three library slots and one written in code (`{ type: code }`). The clinic's own file, with all five of its slots from the library, is `apps/clinic/slots.yaml`.

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/slots.schema.json
name:
  type: name
  exclude: [dr, doctor, chen, cheng, patel]
dob:
  type: birthdate
  keypad: true
card:
  type: digits
  noun: library card
  length: 8
  keypad: true
  group: [4, 4]
plate: { type: code }                          # an example of a slot the code writes (code.slots.plate)
```

The seven types and their options are in section 4 and in [docs/slots](slots/README.md); a small library slot looks like this:

```yaml
note:
  type: text
  what: a note for the librarian
  say: your note
```

The rules, each checked by `defineApp` and `check` with the file and line:

- **The file lists every slot.** Each key of `code.slots` must appear as `{ type: code }`, and each `{ type: code }` must have a `code.slots` entry. A slot that is both a library slot and in `code.slots` is refused: it would be built twice.
- **The order is the file's.** Outside a form the engine fills slots in that order, says their acknowledgements in it, asks the first slot that needs the caller to choose between two values, and lists the slots in it in the model's turn state and in a transfer's handoff. A form's own slots stay in the order forms.yaml gives. Without a slots.yaml, the order is whatever order `code.slots` was written in, which is easy to change by accident; with one, it is written down in one place, and a reorder shows in a diff.
- **A type is a library type, an app type or `code`.** An app adds its own types with `slotTypes` in its code (`code.slotTypes: registerSlotType(myType)`); a name a built-in type has, and `code`, are refused. An unknown type names the closest one.
- **A library slot's options are checked by its type**, strictly: a misspelt option is refused with the one meant, at its line in slots.yaml.

Without the file, every slot is the code's, as before. The file is part of the configuration hashes (section 8). An app that is not built from a folder gets the same rules from `defineSlots(source, codeSlots, types?)`, where `source` is the path of a slots.yaml or the same map as an object; it returns the slots in the file's order, or throws an `AppDefinitionError` listing every problem.

### locale/&lt;tag&gt;/prompts.yaml (optional)

The prompts for another language, in the same shape as prompts.yaml. See section 7.

### locale/&lt;tag&gt;/slots.yaml (optional)

How the library slots say their values in that language: a choice option's `say`, a text slot's stand-in. Never what the model is asked. See section 7.

### fixtures/ (optional)

The corpus (`corpus.jsonl`, one labelled utterance per line), scripted calls, the baseline, and recorded cassettes. They are how an app is tested with no keys: the stub decision model answers from the corpus labels. The clinic's README explains the harness; the only rule `check` adds is that every intent has examples in the corpus when `app.yaml` names a fixtures directory:

```json
{"id":"sn-01","text":"I'd like to make an appointment","intent":"schedule_new","context":"no_form"}
```

## 3. What stays in TypeScript, and why

The test for what is data: could a person who does not write code review it, and could it be wrong without anything executing? Intents, forms, prompt text, the gate's tables and presentation are like that. What runs stays in code, because YAML that tried to describe it would grow into a language of its own. The code is one object, `code: AppCode`:

| Part of `code` | What it is | Why it is not YAML |
|---|---|---|
| `slots` | A `SlotSpec` per slot: the questions the decision model is asked, how its answers become a value (`fill`), the keypad shape, how it is read back (`display`). [Section 4](#4-writing-a-slot) says how to write one. | It is a parser. Most slots need none: a library type named in slots.yaml (section 4) supplies it, and code is for a value no type fits. |
| `tools` | A `ToolDef` per tool: `run(call, sys, ctx)` does the work and returns `{ value, summary }` | It calls the app's systems. It never decides whether it may run: the gate does, from policy.yaml. |
| `systems` | A factory for a fresh copy of the app's systems for each call, and the gate's lookups over them (`ownerOf`, `scopeOf`) | State and connections. |
| `forms` | The hooks of each form, by form id (section 5) | They run during the dialog. |
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
    check_loans: { complete: checkLoans },
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

## 4. Writing a slot

A slot is one value a form collects: a book, a day, a card number. The model never writes the value: it answers typed questions (yes or no, which of these labels), and the slot turns the answers into a value and decides whether it is good.

**Most slots are configuration.** Pick a type in `slots.yaml`, give it options, and the library supplies the questions the model is asked, how its answers become a value, the keypad, and how the value is said back. Write a slot in code only when no type fits. This section covers the types first, then what is true of every slot, then writing one in code.

### Pick a type in slots.yaml

The library has seven types. Each has a page with every option, its default, the default question text, the outcomes it can give, the prompts it needs and starter examples (the pages are [indexed here](slots/README.md)):

| Type | It collects |
|---|---|
| [`digits`](slots/digits.md) | A number of a fixed shape: an account, a library card, a tracking number |
| [`choice`](slots/choice.md) | One of a fixed list: a delivery speed, a branch, a colour |
| [`date`](slots/date.md) | A calendar day, ahead or back: a delivery, an appointment |
| [`birthdate`](slots/birthdate.md) | A date of birth, heard whole or in part |
| [`name`](slots/name.md) | The caller's own name |
| [`record`](slots/record.md) | One of the app's own records, chosen by what the caller says of it |
| [`text`](slots/text.md) | The caller's own words, kept as said |

A slot is a key in `slots.yaml` with a `type` and that type's options. The common cases, each a few lines:

An identifier the caller reads out. The model says whether a number was stated and which span of the words is it; code turns the span into digits and checks them.

```yaml
card:
  type: digits
  noun: library card        # "Does the caller state a library card number ..."
  length: 8                 # a wrong length is invalid; the default pattern is exactly eight digits
  keypad: true              # eight keys after two spoken misses; needs ask_card_dtmf
```

One of a fixed list. The key is the value; the text after it is how the line says it.

```yaml
branch:
  type: choice
  keypad: true              # 1 for the first option, 2 for the second
  options:
    north: the North branch
    riverside: the Riverside branch
```

A list whose entries sound alike has an advanced tier (`disambiguate`, `hedge`, `help`): the clinic's provider slot in `apps/clinic/slots.yaml` uses all three.

A day, ahead or back, and a date of birth. They are two types because a birth date is asked differently, masked, and held in part when the year is missing.

```yaml
pickupDay:
  type: date
  range: future             # or past: today or a day gone, up to two years back
  windows: true             # "next week" is held, and the slot asks which day
dob:
  type: birthdate
  keypad: true              # MMDDYYYY (DDMMYYYY in a Spanish session)
```

The caller's own name. `exclude` lists words that are never the caller's name (a title, the people they may be discussing), so a span holding one is never offered to the model.

```yaml
caller:
  type: name
  exclude: [dr, doctor, rivera, quinn]
```

One of the records a tool returned for this caller. The app gives the records to its slots from `facts.forSlots`; the model picks a label, and the value is the record's key.

```yaml
order:
  type: record
  from: orders
  key: ref
  label: "Order {ref}, {what}, placed {placed|day}"
```

Free words no list holds and no code can check. The words are the value; the summary says the stand-in (`say`), and the trace keeps only their length.

```yaml
note:
  type: text
  what: a note for the courier
  say: your note
```

What the type does not do for you:

- **The lines it says.** A type declares the prompts it may lead to (`ask_<slot>` and `ask_<slot>_retry` for every slot; `ask_<slot>_dtmf` with a keypad; `ack_<slot>` when a value is acknowledged; `disambiguate_<slot>`; a type's own named lines). You write them in `prompts.yaml`, and `pnpm check` says which are missing in every locale, and why.
- **The words the model reads.** Defaults are neutral (`Does the caller state a library card number ...`). To keep the words a recording was made with, or to name your own domain, write a text part as a literal: `text: { given: "..." }`, sent to the model exactly as written. `ids: { given: ... }` keeps a question id. A changed word is a changed model request, so a recorded cassette misses until it is recorded again.
- **Thresholds.** A type compares the model's numbers only to thresholds it reads by name. An option that names one (`fillAt`, a `hedge.threshold`) is checked when the app is defined; see "Thresholds" below.
- **Sensitive values.** The types that hold an identifier mask it by default: `digits` shows `...0417` wherever it leaves the turn and hands a transfer its last four; `birthdate` shows the year only. Turn that off (`redact: none`) only for a value that is no one's secret. Name the tool param and the prompt variable that carry the value exactly as the slot (`card`, `{card}`).
- **Another language.** The types read and say Spanish (`es`, `es-*`); a choice option's `say` and a text stand-in can be worded per locale in `locale/<tag>/slots.yaml` (section 7).
- **Reading a slot from code.** A slot built from a type is an ordinary `SlotSpec` with two more fields: `type` and `config` (the options as parsed, defaults filled in), so code can list a choice slot's options or read a record slot's key.

Every option is strict. A misspelt one is refused at its line, with the one meant:

```
slots.yaml:4:3  card.lenth  unknown key "lenth" under card  ->  rename "lenth" to "length"
```

An app that is not built from a folder gets the same slots from code: `defineSlot('card', { type: 'digits', noun: 'library card', length: 8 })` throws a `SlotConfigError` listing every problem. The library's `app.ts` does this for its three slots, and the clinic's `slots.yaml` is the complete example of a folder.

### Every slot listens on every turn

The engine asks the questions of every slot the turn listens for, not only the one it just asked about: inside a form, the form's slots (and, while an anonymous caller is still to be verified, the identity factors); outside a form, every slot the app has. That is what lets a caller volunteer several details at once, and lets "what do I have out on card 5552 0417" fill the card on the opening turn. It is true of library slots and slots in code alike, and it has two consequences:

- A slot must give `absent` when the words say nothing about it. The library types do; a slot in code must.
- Adding or changing a slot changes the model's request on every turn where it listens, because its questions are in the request and every slot's display is in the turn state. A recorded cassette then misses until it is recorded again, which calls the paid model and is a deliberate step (the clinic's README, "Recording the cassette").

A per-slot `listen:` option, to narrow when a slot's questions are asked, is not built. Any non-default value would change the questions on most turns, so it belongs with a deliberate re-record, not with a type's options.
### Thresholds

Compare the model's numbers against `ctx.thresholds`, by name, never against a number written in the slot. Thresholds can then be overridden for a run (`--threshold SLOT_DETECT=0.7`) and tuned by the sweep, and every slot moves together. The slot thresholds (their defaults are in `core/thresholds.ts`):

| Threshold | Default | What it is for |
|---|---|---|
| `SLOT_DETECT` | 0.6 | A yes-or-no detection question: is a value said at all, was it said whole. |
| `SLOT_CHOICE_CONFIRM` | 0.45 | The least a picked label needs to be taken at all. |
| `SLOT_CHOICE_FILL` | 0.55 | Enough to take a picked label silently; between the two, take it and read it back. |
| `SLOT_CHOICE_MARGIN` | 0.15 | Two labels closer than this are asked about (`disambiguate`). |
| `SLOT_HELP` | 0.6 | A help answer ("I don't know it") to take as one. |

An app's own thresholds go in app.yaml (`thresholds:`, the clinic's `PROVIDER_UNSURE`), and the engine adds them to `ctx.thresholds` on every turn. A unit test's `testSlotContext` has only the engine's, so the clinic reads its own through a helper that falls back to the registered app's value (`clinicThreshold` in `apps/clinic/src/domain/thresholds.ts`).

A slot that names a threshold in its options (a library `choice` slot's `hedge.threshold` or `help.threshold`, the one a `fillAt` or `minConfidence` selects) lists the names in `thresholds`, and a name that is neither one of the engine's nor one under `thresholds:` in app.yaml is refused when the app is defined, `pnpm check` included, with the closest name as the fix. A misspelt name would otherwise be a threshold no probability ever meets, so the slot would quietly never fill:

```
slots.yaml:87:16  provider.hedge.threshold  slot "provider" names the threshold "PROVIDER_UNSURR", which is neither one of the engine's thresholds nor one the app names  ->  rename it to "PROVIDER_UNSURE", or add "PROVIDER_UNSURR" under thresholds in app.yaml
```

Set `detect: true` when the slot's fill rests on a yes-or-no detection question, as the card's does (`cardGiven`). It changes what the trace and the console show, not what fills: the slot's row (`slot:<id>`) is shown against `SLOT_DETECT` instead of `SLOT_CHOICE_CONFIRM`. The comparison that decides is the one in your `fill`.

### Worked example: the library card

The library's `check_loans` form asks for a library card number and says which book on the card is due back first. Everything it took:

- `intents.yaml`: the `check_loans` intent, `kind: form`.
- `forms.yaml`: `check_loans` with `slots: [card]`, `summaryPromptId: null` and `hooks: [complete]`.
- `policy.yaml`: `listLoans: 0` under `toolLevel` and `listLoans: [R1]` under `rulesFor`.
- `prompts.yaml` and `locale/es/prompts.yaml`: `ask_card`, `ask_card_retry`, `ask_card_dtmf` (the keypad rung), `ack_card` (`by-confidence`), `ask_card_length` (the `retryPromptId`), and the form's `next_due`, `no_loans` and `no_card`.
- `app.ts`: the slot, the `listLoans` tool and the form's `complete`.

The slot, from `packages/dialogwright/src/define/fixture/app.ts`. It is a library `digits` slot, so its questions, fill, keypad, display and the lines it declares come from the type, and its options say what the hand-written slot in "Values no list holds", below, did:

```ts
export const cardSlot = defineSlot('card', {
  type: 'digits',
  noun: 'library card',               // "Does the caller state a library card number ..."
  length: 8,                          // exactly eight digits; a wrong length is invalid, reason "length"
  keypad: true,                       // dtmf length 8; needs ask_card_dtmf
  confirm: 'by-confidence',           // spokenConfirm; needs ack_card
  readBack: 'below-fill',             // ack_card only when the span's probability is under SLOT_CHOICE_FILL
  minConfidence: 'SLOT_CHOICE_CONFIRM', // under it: invalid, reason "low_confidence"
  lengthRetryPromptId: 'ask_card_length',
});
```

In a folder app the same options go in `slots.yaml` (`card: { type: digits, noun: library card, ... }`). The defaults give the rest: `questionIds` (`cardGiven`, `cardSpan`, `cardComplete`), `detect: true`, `redact: last4`, `handoff: last4`, the display as the digits, and `prompts` (`ask_card_length`, `ack_card` given `{card}`, `ask_card_dtmf`). The options are in `packages/dialogwright/src/slots/digits/README.md`.

The tool takes the value under the slot's own name, so the gate event, the trace and the audit record `card=...0417`:

```ts
  listLoans: {
    run(call, sys) {
      const { loans: onFile } = sys as LibrarySystems;
      const card = call.params.card ?? '';
      const loans = Object.hasOwn(onFile, card) ? onFile[card]! : null;
      return { value: loans, summary: loans ? `${loans.length} loans` : 'no card' };
    },
  },
```

What a caller hears, from the tests: "Sure, I can help you check your loans. What's your library card number?", then for a confident answer "On card 55520417, A Quiet Orchard is due back next, on Friday, September 25.", and for a less certain one "That's card 55531290." in front of the answer. Seven digits get "A library card number has eight digits. Please say all eight, one at a time."; a second miss gets "Please enter your eight digit library card number on the keypad."; eight keys then fill the slot.

### The clinic's slots, by pattern

All five are library slots, configured in `apps/clinic/slots.yaml` with the clinic's own wording:

| Pattern | Library type |
|---|---|
| A choice from a list, with close names asked about (`disambiguate`), a hedged name read back, help lines for "I don't know the name", and a one-digit keypad | `choice`: the provider |
| A value no list holds: detected, picked as a span, turned into digits and checked, keyed as eight digits, recorded and handed over by its last four | `digits`: the member ID |
| A date from parts (mode, month, day, weekday, a span of days), resolved against today; a span is a partial with a prompt and variables; keypad MMDD | `date`: the appointment day |
| A date of birth: month and day without the year is a partial (`ask_dob_year`), masked to the year, keypad MMDDYYYY | `birthdate` |
| The caller's own name, picked from word spans with every provider's name left out of the candidates; no keypad | `name` |

The hand-written slots these replaced are kept, frozen, in `apps/clinic/src/testing/oracles/`, and used only by the clinic's grid tests (`src/shadow.test.ts`), which compare each library slot with its oracle over large grids of answers. The oracles are not app code, and a test fails if any non-test file imports one.

### When no type fits: a slot in code

The rest of this section is for a slot no library type covers: a value with its own shape, such as a code with letters, or a pairing of two values. In `slots.yaml` it is `{ type: code }`, written as a `SlotSpec` in `code.slots.<id>`. If the same shape would serve other apps, consider contributing it as a type instead (see "Your own slot type", below, and [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-slot-type)).

The types are in `packages/dialogwright/src/core/slots/types.ts` and are exported by `'dialogwright'`. Everything the library types do, they do by building one of these, so reading a type's code (`packages/dialogwright/src/slots/text/` is the plainest) is the best way to learn the contract.

### The contract

```ts
interface SlotSpec {
  id: SlotId;
  spokenConfirm: 'always' | 'by-confidence' | 'summary';
  questionIds?: readonly string[];
  prompts?: readonly SlotPrompt[]; // { id, why, vars? }
  thresholds?: readonly string[]; // the thresholds the slot's options name
  questions(ctx: SlotContext): QuestionMap;
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  dtmf?: { length: number; parse(digits: string, ctx: SlotContext): SlotCandidate | null };
  display(value: string, locale?: string): string;
  redact?: 'last4' | 'mask' | 'length';
  handoff?: 'last4' | 'verified';
  valueKind?: 'date';
  detect?: boolean;
  partialPromptId?: string;
  partialVars?(window: SlotPartial, locale?: string): Record<string, string>;
}
```

(Shortened: the comments are in the file.) `questions(ctx)` returns the questions the slot adds to the turn, by question id. There are three question types (`jev/types.ts`), and each has its answer type and a reader:

| Question | Answer | Read it with |
|---|---|---|
| `{ type: 'noul', instructions, criteria?: { true?, false? } }`: yes or no | `{ type: 'noul', noul }`, the probability of yes | `noulValue(answers, id)`, which is 0 when the answer is missing |
| `{ type: 'choice', instructions, criteria: { <label>: <description or null> } }`: one label of several | `{ type: 'choice', choice, probabilities, confidence }`: the top label, every label's probability, the top one's | `isChoice(a)`, then `a.probabilities[a.choice]`; `rankProbabilities` for the top two |
| `{ type: 'score', instructions, levels: [{ label, description }] }`: ordered levels, lowest first | `{ type: 'score', score, probabilities, confidence }`: the expected level (1-based, may be fractional) | `isScore(a)` |

No slot in the repository uses a score question; the engine's own frustration question is one. A choice question offers a `none` label, so the model has an answer when the words name nothing.

Some rules about questions:

- **Ids are shared.** Every slot's questions and the engine's own go into one map for the turn, so no two may share an id: a turn on which a slot asks an id the engine asks (`ENGINE_QUESTION_IDS`, such as `urgency`) or another slot asks throws. Start each id with the slot's id (`cardGiven`, `cardSpan`), and list them in `questionIds` (the library's slots do): then a collision is refused when the app is defined, `pnpm check` included, rather than on the turn that meets it, and the slot may ask no id it has not listed. A slot that lists none is still tried when the app is defined: `validateApp` (and so `defineApp`, `registerApp` and `pnpm check`) calls its `questions()` on a few made-up turns (no words and words with numbers and a date in them; asked or not; with and without a value on file and a pending partial; in each of the app's locales) and refuses an id the engine asks, an id another slot declares or asks, and, for a slot that lists its ids, one it leaves out. A try that throws is skipped, never a failure, and a question asked only in a state those turns do not reach is still caught on its turn. This is a change: a hand-written slot asking the engine's or another slot's id was once merged over it without a word, and then refused only on the turn that asked it; now the app is refused when it is defined. The console groups questions under a slot by that prefix (app.yaml `console.questionPrefixes` names others) and shows an id ending in `Given` against the detection threshold (`console.detectQuestions` names others).
- **The words are the request.** `instructions` and the criteria are sent to the model as written. Changing them changes what a recorded cassette holds.
- **Every slot listens on every turn** (see above). `fill` must return `absent` when the words say nothing about its slot.

`ctx` (a `SlotContext`) is what the slot sees of the turn:

| Field | What it is |
|---|---|
| `text` | The caller's words this turn. |
| `candidateSpans`, `candidateWordSpans` | The runs of the caller's words a span question can offer: number-ish and word-ish (see "Values no list holds"). |
| `todayIso` | Today, for dates. |
| `thresholds` | The engine's thresholds and the app's own, by name. |
| `window` | This slot's pending partial value, or null (see "Partial values"). |
| `current` | This slot's value already on file, or null (null during a correction at the summary). |
| `records` | The app's records a slot may choose among (`App.facts.forSlots`), opaque to the engine; empty when the app has none. |
| `sources` | The app's records by name (`App.facts.forSlots` returning `{ sources: { parcels: [...], orders: [...] } }`), for a slot that names the list it chooses from (a `record` slot's `from`), so two such slots each read their own. Absent when the app names none. |
| `prompted` | Whether the last prompt asked for this slot. |
| `locale` | The language the session speaks, for an app that declares locales (section 7); absent otherwise. A slot that formats its value for the language reads it here. |

`fill(answers, ctx)` returns a `SlotOutcome`. Each kind, when to return it, and what the engine then does:

| Outcome | Return it when | What the engine does |
|---|---|---|
| `{ kind: 'absent' }` | The words say nothing about this slot. | Nothing. If no slot made progress this turn, it counts as a missed answer to the question that was asked (the retry ladder below). |
| `{ kind: 'filled', value, display, confidence, confirm }` | The words give a value you accept. | Stores `value` and `display` on the slot and clears any pending partial. What it says next depends on `spokenConfirm` (below); `confirm` (`'none'` or `'implicit'`) matters only for `by-confidence`. `confidence` is recorded in the trace's row for the slot; the engine decides nothing with it. |
| `{ kind: 'disambiguate', a, b }` | Two candidates are too close to call (`a` and `b` are `{ value, display }`). | Asks `disambiguate_<slot>` with `{a}` and `{b}` set to the two displays. The slot stays empty, and the caller's answer is read by the same slot's questions on the next turn (the model also sees the two displays as `node.options`). Only the first slot that disambiguates in a turn is asked about. |
| `{ kind: 'window', window, confidence }` | The words give part of the value (a month and day without the year). | Keeps the partial on the slot and asks for the rest (see "Partial values"). |
| `{ kind: 'invalid', reason, raw, retryPromptId? }` | The words were meant as this value but cannot be it (seven digits for an eight-digit number, a birthday in the future). | Stores nothing, and the turn is a missed answer. `retryPromptId`, when set, is said at the first rung in place of `ask_<slot>_retry`, for a reason the generic retry would misdescribe. `reason` shows in the trace's row as `invalid:<reason>`. The engine reads `raw` only for a date-valued slot (see "Partial values"). |
| `{ kind: 'help', promptId }` | The caller says whether they know the value without saying it ("I don't know the doctor's name"). | Says `promptId` in place of the question, and the attempt count does not move. Only for the slot that was just asked, and each help prompt only once until the slot is emptied; anywhere else it counts as `absent`. |

The retry ladder. A missed answer adds one to the slot's attempts. With `MAX_ATTEMPTS` at its default of 3: the first miss re-asks with `ask_<slot>_retry` (or the outcome's `retryPromptId`, or the partial prompt when a partial is pending); the second asks for the keypad with `ask_<slot>_dtmf` when the slot has `dtmf` and the channel has a keypad, and re-asks with the retry line otherwise; the third hands the call to a person (`max-attempts`). Silence counts as a miss too, but its first re-ask is the plain `ask_<slot>` after "I didn't hear anything".

For every slot a form or identity.yaml names, `check` requires `ask_<slot>`, `ask_<slot>_retry` and the lines below that the spec's fields call for. It cannot see the prompts a `fill` returns, so declare them in the spec's `prompts` (`disambiguate_<slot>` with `vars: ['a', 'b']`, a `retryPromptId`, a help `promptId`; the library's card declares `ask_card_length`): `check` then requires each in every locale, and refuses a line that uses a variable the slot does not declare for it.

### Values no list holds

An order number, a code, a card number: the model cannot choose it from a list, and it is never asked to write it. Instead, the code finds every run of the caller's words that could be the value, the model judges which one it is, and the code turns that run into the value and checks it. The value is then always something the caller said, and the code, not the model, decides whether it is valid. The library's `digits` type works this way (the clinic's member ID and the library's card are slots of it), and this section shows the steps as a hand-written slot takes them, for a value the type does not fit:

1. **Candidates, in code.** `ctx.candidateSpans` is every run of one to ten words of the caller's text that holds a digit or a number word, shortest first, at most 120, in the tokenized form (lower case, no punctuation): "it's 5552 0417" gives `5552`, `0417`, `5552 0417` and the longer runs around them. For words rather than numbers (a name), `ctx.candidateWordSpans` is every run of one to four words with no number word that does not start or end with a filler word ("my", "is", "the"), at most 320. Both functions are exported, for tests.
2. **Judgment, by the model.** A yes-or-no question asks whether a value is said at all; a choice question offers the spans as its labels (with `null` criteria, since each span describes itself) and `none`; a second yes-or-no question asks whether it was said whole.
3. **Normalisation and checking, in code.** `spokenToDigits(span)` turns "five five five two zero four one seven" or "5552 0417" into `55520417`, and `matchesMask(digits, /^\d{8}$/)` checks its shape. Anything wrong is `invalid`, with its reason.

What is not on the ballot cannot be chosen, so narrow the candidates rather than arguing in the instructions. The clinic's name slot (a library `name` slot, with its `exclude` list, in `apps/clinic/slots.yaml`) leaves out every span that holds a provider's name, so a caller correcting the doctor is never taken as giving their own name. It also checks that the chosen span is one it offered on this turn, since an answer recorded against other words can name a span the turn never offered.

The questions and fill of such a slot written by hand, as the library's card had them before the `digits` type (the type's default wording is a little different: it says "either as digits or as spoken number words", and its span question names number words like "forty-four" and modifiers like "double"):

```ts
  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a library card number';
    return {
      cardGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state a library card number, as digits or as spoken number words?',
      },
      cardSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the library card number the caller states? ...',
        criteria,
      },
      cardComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states a library card number, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'cardGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    if (noulValue(answers, 'cardComplete') < t.SLOT_DETECT) return { kind: 'invalid', reason: 'incomplete', raw: '' };
    const span = answers.cardSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const p = span.probabilities[span.choice] ?? span.confidence;
    if (p < t.SLOT_CHOICE_CONFIRM) return { kind: 'invalid', reason: 'low_confidence', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, CARD_MASK)) return { kind: 'invalid', reason: 'length', raw: digits, retryPromptId: 'ask_card_length' };
    return { kind: 'filled', value: digits, display: digits, confidence: p, confirm: p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit' };
  },
```

The order matters. Not said is `absent`, so a turn about something else leaves the card alone. Said but trailed off, or said but no span is it, is `invalid`: the caller tried, and the turn is a miss. The digits are checked last, and a wrong length gets its own re-ask ("A library card number has eight digits. Please say all eight, one at a time.") rather than the generic one.

### The keypad

`dtmf: { length, parse }` gives the slot a keypad rung. While the slot is the question the caller was last asked, keys are collected until there are `length` of them, then `parse(digits, ctx)` returns `{ value, display }`, or null for keys that are not a value. A keyed value counts as confirmed: it is not acknowledged or read back, whatever `spokenConfirm` says. A null is a missed answer on the ladder. Keys are taken whenever the slot was the last thing asked, not only at the keypad rung, and `parse` gets a context with no words (`text` is empty, and there is no pending partial). Written by hand, the card's was:

```ts
  dtmf: {
    length: 8,
    parse: (digits) => (matchesMask(digits, CARD_MASK) ? { value: digits, display: digits } : null),
  },
```

A slot with `dtmf` needs `ask_<slot>_dtmf`, the line that asks for the keys ("Please enter your eight digit library card number on the keypad."). Without `dtmf`, the keypad rung is one more spoken retry, and so it is on a chat, which has no keypad. The clinic's keypad shapes: the date as MMDD (`length: 4`), the date of birth as MMDDYYYY (`length: 8`), the provider as one digit.

### Sensitive values

`redact` says how the slot's value is masked wherever it leaves the turn:

| `redact` | Shows as | For |
|---|---|---|
| `last4` | `...0417` | An identifier (the card, the clinic's member ID). |
| `mask` | `••/••/1975`, the year alone; a tool param as `•` | A date of birth (the clinic's `dob`). |
| `length` | `<38 chars>` | The caller's own words, such as a free-text note. The slot's display is a stand-in ("your description") and is kept; the live console keeps the words. The engine's testkit has one (`missingNote`). |

Where it applies: a tool call's param with the same name as the slot, as the gate event, the trace and the audit log record it; and the trace's and the console's copies of the slot (its value and display, the slots in the turn state the model was given, a pending read-back, a prompt's variables named after the slot, a handoff's collected slots). A pending partial of a redacted slot keeps its shape with its numeric parts zeroed. So name the tool param and the prompt variable that carry the value exactly as the slot: the library's `listLoans` takes `card`, and its lines say `{card}`.

What `redact` does not cover is the caller's words. The transcript (the speech event, the turn's text, and the questions the model was asked, whose span labels are the caller's words) is kept in the trace as said, so a trace is sensitive. The audit log holds only the masked calls. The model itself sees each slot's display in its turn state.

`handoff` says what a transfer to a person hands over for the slot (`HandoffDecision.slots`, which the transfer sends on to the channel). Without it, the slot's display. `last4`: the last four digits. `verified`: only whether the caller was verified (`verified` or `not verified`), never the value, which needs an identity.yaml. `redact` does not change what a transfer hands over (only the trace's copy of it), so an identifier needs both, as the card has. Only filled slots are handed over, and a form's slots are emptied when it completes, unless app.yaml's `carrySlots` names them.

### Partial values

A slot that can hear part of a value returns `{ kind: 'window', window, confidence }`. `window` is a `SlotPartial`: `{ kind: <the slot's word for it>, ...parts }`, each part a string or a number. The engine keeps it on the slot, which stays empty, and asks for the rest:

- `partialPromptId` names the line that asks for the rest (the clinic's date of birth: `ask_dob_year`, "And what year?"). Without it, the slot's own `ask_<slot>`. `check` requires it.
- `partialVars(window)` gives that line its variables, wherever it is asked. The clinic's date turns "next week" into `{ window: 'next week' }` for `date_narrow_window`, "{window}. Which day works for you?".
- On the next turn, `ctx.window` is the pending partial, so `fill` can complete it: the clinic's `dob` takes the pending month and day when the caller says only the year, and its `date` reads a bare weekday inside the pending span.
- A partial never replaces a filled value mid-form (only a correction at the summary does). The same partial said again is not progress, so the turn is a missed answer, and the open rung re-asks the partial line rather than the retry.

`valueKind: 'date'` says the value is a calendar day (an ISO date). Every slot reads every turn, so "June fourteenth" said at the birthday question would also give the appointment date. The engine settles it: when the slot that was asked and another date-valued slot hear the same month and day on one turn, the other one's fill or partial is dropped. It reads the day from a fill's value, an `invalid` outcome's `raw`, or a partial's numeric `month` and `day` parts. So a date slot's partial that holds a day names it with numeric `month` and `day` (the clinic's `dob`), and one that holds no single day uses other parts (the date's window keeps `start`, `end` and `label` as strings).

### spokenConfirm

How a spoken value is confirmed. A keyed value never is.

| `spokenConfirm` | What happens to a spoken fill | Lines it needs |
|---|---|---|
| `summary` | Nothing is said for it: the form's summary (`summaryPromptId`) reads it back with the rest. The fill's `confirm` is not read. In a form with no summary, nothing reads it back at all. | none |
| `by-confidence` | The fill's `confirm` decides. `'none'`: taken silently. `'implicit'`: taken, and `ack_<slot>` is said in front of the next line with `{<slot>}` set to the display ("That's card 55520417."). The value stands without a yes. | `ack_<slot>` |
| `always` | The value is read back with `confirm_<slot>` and counts only after a yes. A no goes straight to the keypad (`ask_<slot>_dtmf`), and a second no to a person; an unanswered read-back walks the ladder. | `confirm_<slot>`, `ask_<slot>_dtmf` |

`ask_<slot>_dtmf` is required for `always` even without `dtmf`, so give such a slot a keypad rung: otherwise a declined read-back asks for keys the slot cannot take. No slot in the repository uses `always` yet.

### display

`display(value, locale)` is how the line says a value: "55520417" for the card, "Dr. Patel" for a provider, "Tuesday, September 22" for a date ("martes, 22 de septiembre" in a Spanish call). `locale` is the session's (`ctx.locale` in `fill` and `dtmf.parse`), which only an app that declares locales has; format en-US exactly as with no locale. The engine does not call it itself: what a line says, what the console shows and what the model sees is the `display` your `fill`, `dtmf.parse` or `disambiguate` candidate returned, stored on the slot. Write one formatter, make it the spec's `display`, and use it in all three, so they agree (the library's `choiceSlot` and the clinic's date do). The library's card is said digit by digit because app.yaml's `voice.spokenDigits` rule spells `card ` followed by digits for text to speech, so its lines say "card {card}".

### Your own slot type

A slot you write for one app can be a `SlotSpec` in `code.slots`. A shape you will use more than once, or want others to use, is better as a slot type: a function from validated options to a `SlotSpec`, named in `slots.yaml` like the built-in ones. An app registers its own types with `code.slotTypes`:

```ts
import { defineSlotType, registerSlotType } from 'dialogwright';

export const plateType = defineSlotType({
  type: 'plate',                 // what slots.yaml writes after "type:"
  options: plateOptions,         // a z.strictObject, every option with .describe(...)
  build: (id, options) => ({ id, ...,
    questionIds: [`${id}Given`], // every question id it may ask
    prompts: [],                 // every line it may lead to, beyond ask_<slot> and ask_<slot>_retry
  }),
  examples: plateExamples,       // configurations with starter utterances
});

export const code: AppCode = { slotTypes: registerSlotType(plateType), /* ... */ };
```

A name a built-in type has, and `code`, are refused. The contract a type must keep, and how to write one, are in [the library's README](../packages/dialogwright/src/slots/README.md) and in CONTRIBUTING's "Adding a slot type".

**The conformance kit** proves a type keeps that contract, over its examples, with no model and no keys. In the type's test file:

```ts
import { describe, it } from 'vitest';
import { runSlotConformance } from 'dialogwright/testing';
import { plateType } from './plate';

runSlotConformance(plateType, { describe, it });
```

It checks en-US and es unless you pass `locales` (`locales: ['en-US']` for a type that speaks only English). It checks that the type builds, refuses unknown options, declares every question id and keeps them its own (never the engine's, and different for a second slot) in every state it tries (a value on file, a partial pending, a Sunday, a leap day, the last day of a year), says nothing when it hears nothing, never throws on malformed answers, reads its thresholds by name (scaling every probability and every threshold by one factor must change nothing) and only the ones it declares or the engine has, treats a number exactly at a threshold as meeting it, formats its display the same in the fill, the keypad and every locale and as each example pins it there, declares every line it can lead to with only the variables the engine gives that line, gives ISO dates when its values are dates, and gives the outcome each example utterance expects. A type that passes can run in an app. A check that fails says which example, which check and every problem it found.

### Porting a slot to a library type

If you wrote a slot by hand before a library type covered it, move it onto the type without changing what callers hear. The shadow harness, in `dialogwright/testing`, runs the library slot beside the hand-written one and fails on any difference:

1. Keep the hand-written slot as the app's slot. Build the library slot with `defineSlot` from the options you mean to use (its question wording as literals, so the text does not move).
2. In a test, `shadowSlot(handWritten, librarySlot)` returns a slot that behaves as the hand-written one and, on every call, also runs the library one and compares the questions (as the model's request keys them), the `fill` outcomes, the keypad results, `display` and `partialVars`. Drive it over a large grid of answers, around every threshold, so branches no recorded call reaches are covered. `createShadowReport()` collects differences instead of throwing.
3. For a whole run, `withShadowSlots(app, [librarySlot], { mode: 'report', report })` does the same inside the regression and the recorded replay, and `shadowFromEnv(app, [librarySlot])` in a regression launcher turns it on when `DIALOGWRIGHT_SHADOW` is set (`1` or `throw` to fail on the first difference, `report` to list them all at the end).
4. When nothing differs, switch the app to the library slot and move the hand-written file to a test-only folder (the clinic's is `src/testing/oracles/`) with a header saying it is a frozen copy, used only by the grid tests, never edited. Keep a test that fails if any non-test file imports from it.

### Testing a slot

A library type's own tests (the conformance kit and its unit tests) cover its parsing, so a slot built from one needs no `fill` tests of its own; test the app's use of it (your options and wording, and the whole call). Of the five steps below, step 1 is only for a slot written in code; the others apply to every slot.

1. **Unit tests of `fill`.** Write the model's answers out with `choice`, `noul` and `score`, build a context with `testSlotContext(text)` (all exported by `'dialogwright'`; the context uses today 2026-09-18 and the default thresholds), and assert the outcome. Test every branch: absent on unrelated words, each `invalid` reason, the fill, and `dtmf.parse` with good and bad keys. From the library's test:

   ```ts
   it('is invalid, with its own re-ask, when the digits are not eight', () => {
     expect(cardSlot.fill(heard('five five five two zero four one'), ctx('five five five two zero four one'))).toEqual({
       kind: 'invalid', reason: 'length', raw: '5552041', retryPromptId: 'ask_card_length',
     });
   });
   ```

2. **Whole calls.** `resolveTurn` (the engine's turn), `newSession`, `spokenText` and the event helpers drive a call one turn at a time with written-out answers, so you can assert the lines heard, the gate events (with the masked param) and the keypad path. The library's are in `packages/dialogwright/src/define/cardSlot.test.ts`; the clinic's are in `apps/clinic/src/index.test.ts`, with their helpers in `src/testing/turns.ts`.
3. **The corpus and the scenarios.** In an app with fixtures, add labelled lines to `fixtures/corpus.jsonl` with the slot's labels, in the shape the app's testing hooks read. Two of the clinic's, one opening a form and one answering the birthday question inside it:

   ```json
   {"id":"cn-09","text":"Cancel my appointment, I was born June fourteenth nineteen seventy five","intent":"cancel","context":"no_form","slots":{"dob":{"month":"june","day":"14","year":"nineteen seventy five"}}}
   {"id":"db-03","text":"the fourteenth of June, 1975","intent":"none","context":"schedule_new","prompted":"dob","slots":{"dob":{"month":"june","day":"14","year":"1975"}}}
   ```

   Add scripted calls to `fixtures/scenarios/*.json` for the paths: spoken, keyed (a `{"dtmf": "06141975"}` step), and a miss. The app's `testing` hooks (`apps/clinic/src/domain/testing.ts`) tell the stubs how to answer the new questions: `labeled.spans` for a span question (the label is checked to be a span the question offers), `labeled.noul` and `labeled.choice` for the rest, `quietNoul` for a yes-or-no the words do not bear on, `heuristics` for the keyword stub, `checkCorpusSlots` to reject a label no question could pick, and `seed.placeholders` for a corpus line spoken inside a form.
4. **The regressions.** The stub regression then shows each new line as `+ corpus <id>: new` and any changed outcome as a difference. Read each one; a changed outcome is a finding to explain before the baseline is updated, never something to overwrite. Note that a new slot changes the model's request on every turn: its questions are asked wherever it listens, and every slot is in the turn state. So the recorded replay misses on every turn until the cassette is recorded again, which calls the paid model and is a deliberate step (the clinic's README, "Recording the cassette").
5. **`pnpm check`** (or `pnpm check <folder>`) says which of the slot's lines are missing, in every locale, and why the engine says each. Taking `ask_card_dtmf` and `ack_card` out of the library gives:

   ```
   prompts.yaml:2:1  prompts  prompt "ask_card_dtmf" is missing from prompts.yaml; the engine says it when it asks for the slot "card" on the keypad after spoken answers missed (its slot spec has dtmf)  ->  add "ask_card_dtmf:" with its text and interruptible to prompts.yaml
   prompts.yaml:2:1  prompts  prompt "ack_card" is missing from prompts.yaml; the engine says it when it acknowledges a value it heard for the slot "card" (its slot spec's spokenConfirm is "by-confidence")  ->  add "ack_card:" with its text and interruptible to prompts.yaml
   ```

## 5. The form hooks

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

## 6. Checking an app: `pnpm check`

```sh
pnpm check                                          # every app folder under apps/
pnpm check ../../apps/clinic                        # one folder (paths are relative to packages/dialogwright)
pnpm check --json ../../apps/clinic                 # the problems as JSON, for a program or an assistant
```

(`pnpm check` runs the `dialogwright check` command in the engine package, so a folder you name is relative to `packages/dialogwright`.)

At the repository root, `pnpm check` finds every folder under `apps/` that has an `app.yaml`. It exits 0 when no folder has a problem, 1 when one has, and 2 for a command it does not understand. CI runs it on every push.

It checks, in one pass:

1. **Each file against its schema.** Unknown keys, wrong types, a missing required file, a YAML syntax error. A misspelt name offers the near match.
2. **The folder against the code**: every slot, tool, hook and custom rule the YAML names exists in the code; every hook the code writes is listed in forms.yaml; every tool in the code has a policy row; every custom rule the code defines is named in `rulesFor`; every prompt the YAML names is in prompts.yaml; the identity tools, factor slots and carried slots exist; what the console names (form and slot labels, the slot order, question prefixes, a lookup fact's tool) and the clips name (a voice tag's clip, a clip's variables) exists; a tool that runs R3 has `confirmedFields` and a form with `confirmedParams` to confirm it; every threshold a slot's options name (a `hedge.threshold`) is one of the engine's or one under `thresholds:` in app.yaml; and the whole app passes the engine's own `validateApp`.
3. **The engine's own lines in every locale**: every line the engine says by name, and the lines it builds for each slot and for R5's reason (section 2, prompts.yaml), exists in prompts.yaml and in each `locale/<tag>/prompts.yaml`.
4. **Each locale against prompts.yaml**: a translated line uses only the variables the prompts.yaml line has (the code fills those and no others, so another would fail when it is said), and a locale has no line that prompts.yaml does not (it would never be said).
5. **The corpus**: every intent has at least one labelled example in `corpus.jsonl`, when app.yaml names a fixtures directory. The corpus must be inside the package (a link that leads out is refused) and at most 16 MB.

The format is one line per problem, `file:line:column  path  message  ->  fix`, and then a summary line (`N problems in <folder>`, or `<folder>: ok`). A problem in the code has no YAML line, so it reads `app.ts` (or `src/app.ts`) and a code path such as `code.forms.renew_loan.entry`.

When a schema problem is found, the cross-checks against the code do not run until it is fixed, because a file that does not parse cannot be linked. Fix the schema problems first, then run it again.

These are real messages. The folder was a copy of the library fixture, with these edits: an unknown key `colour: blue` in app.yaml, `maxAttempts: three` in policy.yaml. The first run:

```
app.yaml:5:1  colour  unknown key "colour" in this file  ->  delete "colour"; the keys allowed in this file are id, locale, brand, console, voice, handoff, wording, thresholds, carrySlots, fixtures, prompts
policy.yaml:11:14  maxAttempts  "maxAttempts" must be a number, but is text ("three")  ->  write a number without quotes
2 problems in broken-library
```

After fixing those two, with these further edits made at the same time (the slot `branch` misspelt `branche` in forms.yaml, the hook `entry` listed for `renew_loan` but not written, the `goodbye` prompt deleted, the `hours` intent naming a prompt `opening_hours` that does not exist, `known-branch` misspelt `known_branch` in policy.yaml, and the Spanish `anything_else` line deleted):

```
intents.yaml:19:15  intents.hours.promptId  prompt "opening_hours" is not in prompts.yaml  ->  add "opening_hours:" to prompts.yaml with its text and interruptible
forms.yaml:6:13  forms.renew_loan.hooks[0]  form "renew_loan" declares the hook "entry", but the code does not define it  ->  write it in app.ts (code.forms.renew_loan.entry), or delete "entry" from this list
forms.yaml:8:19  forms.check_hold.slots[1]  slot "branche" is not defined  ->  rename it to "branch", or add it to the app's slots in app.ts (code.slots.branche)
prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche" is missing from prompts.yaml; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche_retry" is missing from prompts.yaml; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to prompts.yaml
policy.yaml:6:1  rulesFor  custom rule "known-branch" (code.customRules["known-branch"]) is not named under rulesFor, so it never runs  ->  add "known-branch" to the rules of the tool it guards, or delete the rule from app.ts (code.customRules["known-branch"])
policy.yaml:8:18  rulesFor.findHold[1]  rule "known_branch" is not a built-in rule (R1, R2, R3, R5, R6, R7) and the code defines no custom rule by that name  ->  rename it to "known-branch", or add it to app.ts (code.customRules.known_branch), or name a built-in rule instead
locale/es/prompts.yaml:3:1  prompts  prompt "opening_hours" is missing from the es prompts; intents.yaml:19 (intents.hours.promptId) says it  ->  add "opening_hours:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "anything_else" is missing from the es prompts; the engine says it when a form is done and it asks whether there is more  ->  add "anything_else:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche" is missing from the es prompts; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche_retry" is missing from the es prompts; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to locale/es/prompts.yaml
12 problems in broken-library
```

(The folder name is whatever you pass.) One mistake can show up in several places: the single typo `branche` produced the unknown slot and four missing prompts, and renaming the slot back to `branch` clears all of them. Fix from the top down and run it again.

A corpus problem reads:

```
intents.yaml:15:3  intents.hours  intent "hours" has no examples in the corpus (fixtures/corpus.jsonl)  ->  add a line to fixtures/corpus.jsonl such as {"id":"hours-01","text":"<what a caller says to mean this>","intent":"hours","context":"no_form"}
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

## 7. Locales

An app speaks the language of its `prompts.yaml`, named by `locale:` in app.yaml (default `en-US`). To add a language, add `locale/<tag>/prompts.yaml` with the same shape, and, for how its library slots say their values there, an optional `locale/<tag>/slots.yaml` (below). The library has `locale/es/prompts.yaml` and `locale/es/slots.yaml`:

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
- **Slots hear and say the session's language.** A slot's context carries the session's locale (`ctx.locale`), and the library types read it. What changes for a Spanish session (`es`, or any `es-*` tag); every other locale, and an app without locales, reads and says values exactly as en-US always has:
  - **Numbers.** The spans a number question offers and the digits read from them are Spanish: "cinco cinco cinco dos cero cuatro uno siete", "cincuenta y cinco cincuenta y dos cero cuatro diecisiete", "mil novecientos noventa y uno". Accents are optional ("dieciséis", "dieciseis"); a span keeps them as said. The engine keeps one word table per language (`core/extract/lexicon.ts`), English and Spanish so far.
  - **Names.** Word spans are Unicode ("María José"), the words around a name are Spanish ("me llamo", "soy", "sí"), a compound surname is one span ("Muñoz de la Cruz": `de`, `del`, `la`, `las`, `los`, `y`, `e` inside a name, never at its ends), and a name is said back with its particles in lower case ("María José Muñoz de la Cruz").
  - **Dates.** A day is said "martes, 22 de septiembre", a birth date "22 de noviembre de 1991", a span of days "la próxima semana" or "en diciembre". A date said as numbers puts the day first: the default month and day questions say so to the model, and the keypad takes `DDMM` (a `date`) and `DDMMYYYY` (a `birthdate`), the same number of keys; write the `ask_<slot>_dtmf` line in each locale to match.
  - **Wording, `locale/<tag>/slots.yaml`.** Words an app chooses for a value are given per locale, by slot id: a choice option's `say` and a text slot's stand-in. They replace the slot's own for sessions in that locale; an option left out keeps its own words.

    ```yaml
    # yaml-language-server: $schema=../../../../packages/dialogwright/schemas/locale-slots.schema.json
    branch:
      options:
        north: Norte
        riverside: { say: Ribera }
    note:
      say: su nota
    ```

    `defineApp` builds each library slot it names again with its wording, whether the slot is in slots.yaml or built in code with `defineSlot`, and `check` reports, at the line: a slot the app does not have (with the closest name), a slot written by hand in code (it has no options to word; format its `display` by `locale` instead), a library slot changed in code after it was built (`{ ...slot, dtmf }`: built again it would lose the change), a type that takes no wording (`digits`, `date`, `birthdate`, `name` and `record` say their values by locale themselves), an option the slot does not have, and any key but `say`. The file is in the configuration hashes, by its path. An app that is not a folder (`defineSlots`) has no locale files.
  - **What stays in the default language, by design.** The questions: their instructions and criteria are what the model reads, and their labels are keys (`north`, `november`), so a Spanish caller is asked about in English, with the Spanish words among a span question's choices. A choice option's `means` and a record's `label` are criteria, so they are not worded per locale either.
- **Known limits.** Today a locale is chosen, its lines are said and its slots hear and say its language, but no channel yet carries the language end to end:
  - The server's ConversationRelay TwiML (`server/twiml.ts`) sends no `locale` parameter and sets no `language`, `ttsLanguage` or `transcriptionLanguage`, and the engine never emits the `set_language` action. So a voice session in a locale other than the default is transcribed and voiced with the relay's defaults (English), even when its lines are Spanish.
  - The chat channel has no way to ask for a locale, so every chat session speaks the default.
  - Outbound ConversationRelay text frames say `lang: en-US` whatever the session's locale.
  - Intent labels (`label:` in intents.yaml) stay in the default language, so a Spanish line that says "Claro, puedo ayudarle a {intentLabel}" still ends with the English label.
  - A slot written by hand in code formats its own values: it says them in Spanish only if it reads `ctx.locale` and `display(value, locale)`.
  - Spanish is the one language besides English the slots read and say; another language's sessions read words as English and say values in English until its lexicon and formats are added.
  - Matching a requested locale looks at the language and the whole tag, not at a script subtag: a request for `zh-Hant` in an app with only `zh-Hans` finds `zh-Hans` by its language, `zh`.

  The channel parts (the TwiML's language attributes and `locale` parameter, `set_language`, a chat request for a locale, the text frames' language tag) belong to Phase 7 (Channels). See the roadmap in [design.md](design.md).
- An app with neither `locale:` in app.yaml nor a `locale/` folder behaves exactly as before: its App has no locales, its sessions carry no locale, and nothing it writes changes. `locale:` alone (as the clinic has) gives the App its locales, the default's and no others.

## 8. Configuration hashes

Every configuration file of an app built by `defineApp` has a content hash, so a call can be tied to the exact configuration it ran under.

- A file's hash is SHA-256 over its parsed content as JSON (object keys in the order written at every level, arrays in order, no whitespace). A comment, a blank line, flow or block style or another quoting style does not change it; a changed value does, and so does reordering keys, since a key's place is meaning (the order of `slots.yaml` is the order of the app's slots).
- The combined hash is SHA-256 over the lines `<file>:<hash>`, sorted by file name and joined with newlines. It changes when any file changes, or one is added or removed. Locale files are in it by path (`locale/es/prompts.yaml`).
- They are on the app as `App.configHashes` (`app` for the combined hash, `files` for each file).
- The `call_started` audit row records the combined hash as `config` and the per-file lines as `configFiles`, so the row alone is enough to recompute and verify the combined hash.
- Every trace record carries the combined hash as `configHash`, and the console shows its first eight characters as `config <8 chars>`.
- They are never sent to the model.

An app that is not built from a folder has no hashes, and its rows are as they were.

## 9. Editor support

Every YAML file starts with a line that names its schema:

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/app.schema.json
```

The path is relative to the file (`apps/clinic/app.yaml` points two folders up to the repository root; the library's `locale/es/prompts.yaml` points five up). An editor with the YAML extension then completes keys, shows each field's description, and flags mistakes as you type. Keep the line when you copy a file into a new app, and fix the path if the new folder is at a different depth. The schemas are `app`, `intents`, `forms`, `prompts`, `policy`, `identity` and `slots`; the locale files use `prompts`. The `slots` schema covers the built-in slot types; an app with types of its own can generate one that lists them too (`slotsJsonSchema(registerSlotType(myType))`, exported by `'dialogwright'`) and point the line at that.

The schemas are generated from the zod schemas in `packages/dialogwright/src/define/schema/`, which are also what `check` validates with, so they cannot disagree. Never edit a `.schema.json` by hand. After changing a zod schema, run `pnpm --filter dialogwright schemas`; a test fails when the committed files are stale.

## 10. Walkthroughs

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
4. `slots.yaml`: for every new slot, add a key with a library `type` and its options ([section 4](#4-writing-a-slot); [the type pages](slots/README.md)). Only when no type fits, write a `SlotSpec` in `code.slots` in `app.ts` and add `<slot>: { type: code }` to slots.yaml. Add the lines the slot's type says it needs (`ask_<slot>_dtmf`, `ack_<slot>`, `disambiguate_<slot>`, its partial line) to prompts.yaml and each locale. In `app.ts`, add the form's hooks under `code.forms.<id>`: `complete` calls the tool and returns what to say.
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

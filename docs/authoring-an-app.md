# Authoring an app

This guide is for a developer, or an AI coding assistant, who is building a DialogWright app or changing one. It says what an app is made of, what goes in each file, how policy and identity are written, tested and reviewed, what stays in TypeScript and why, how to write a slot, how `pnpm check` finds mistakes, how locales and configuration hashes work, and how an app answers general questions from a knowledge base of approved passages. Read [CLAUDE.md](../CLAUDE.md) first for the rules (the gate decides, a model never writes a regulated line, an app imports only from `'dialogwright'`).

Two apps in this repository are the examples, and the snippets below are copied from them, except where a snippet says it is only an illustration:

- `apps/clinic`: Example Family Practice, a fictional appointment line. Five forms, no identity verification, scheduling hooks. Its README has a section, "The app as a folder", with more detail.
- `packages/dialogwright/src/define/fixture/`: Example Town Library, a tiny app (three forms, one rule of its own, a Spanish locale) that the engine's own tests build. It is the smallest complete app, so the snippets here come mostly from it. Section 3 also draws on the engine's own test app, Example Parcels, which has the full identity ladder and delegates.

## Contents

1. [The folder](#1-the-folder)
2. [The files, one by one](#2-the-files-one-by-one)
3. [Policy and identity](#3-policy-and-identity)
4. [What stays in TypeScript, and why](#4-what-stays-in-typescript-and-why)
5. [Writing a slot](#5-writing-a-slot)
6. [The form hooks](#6-the-form-hooks)
7. [Checking an app: `pnpm check`](#7-checking-an-app-pnpm-check)
8. [Locales](#8-locales)
9. [Configuration hashes](#9-configuration-hashes)
10. [Editor support](#10-editor-support)
11. [Walkthroughs](#11-walkthroughs)
12. [The knowledge base](#12-the-knowledge-base)

## 1. The folder

An app is a folder. What is data is YAML; what runs is TypeScript. `defineApp(dir, code)` loads the folder, checks that the YAML and the code name the same things, and returns the `App` the engine runs. It throws one `AppDefinitionError` that lists every problem if either side is wrong.

```
my-app/
  app.yaml          who the app is and how it presents itself
  intents.yaml      what a caller can ask for, and the keypad menu
  forms.yaml        each form's slots, its summary prompt, and the code hooks it has
  prompts.yaml      every line a caller can hear
  policy.yaml       what the agent may do, action by action, and the rules the gate runs before each
  identity.yaml     optional: who the app serves, and how a caller proves who they are
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
- `kind: form` starts the form with the same id in forms.yaml. `kind: informational` plays its `promptId` and goes back to where the caller was; its key on the menu does the same, then gives the menu back. `kind: control` is the engine's own.
- Two control intents are required, because the engine reads them by name: `agent` and `repeat_prompt`. The snippet above shows both. The other control intents (`done`, `other`, `none`) are optional; the library has all three, and the clinic leaves out `done`, since its calls end when a task completes.
- Keypad digits are quoted strings.
- A key on the menu starts a form, plays an informational intent's line, or (`agent`) goes to a person. A key for any other control intent does nothing on a call (the caller hears nothing), so `pnpm check` refuses one.
- The menu listens only once it has been offered. On a call with a keypad (a phone call; a chat has none), the second missed answer to the intent question (words it did not understand, or a silence) offers it with `nomatch_dtmf_menu`, and the keys of the next turn are menu keys; with `MAX_ATTEMPTS` at its default of 3, a third miss goes to a person. A key pressed before then, at the greeting for example, is ignored. After an informational key the menu is offered again, so it keeps listening. A scripted call that presses a menu key therefore misses twice first.

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

- `slots` are asked in this order. Every slot id must be a slot spec in the code (section 5).
- `summaryPromptId` is the prompt that reads the filled form back for a yes. `null` means the form completes as soon as its slots are full.
- `hooks` lists the code hooks the form uses. `complete` is required. The list must match the code exactly: `defineApp` refuses a hook the code writes that the list leaves out, and a hook the list names that the code does not write. Section 6 says what each hook is.
- `calls` lists the actions (tools) the form's hooks call through the gate. Declare it for every form or for none (`calls: []` for a form that calls nothing). The engine never reads it; the app map and `check` do ([section 3.7](#37-how-a-form-reaches-an-action-calls)).
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

- Variables in braces are filled by the engine (`{intentLabel}`) or by the app's code (`{book}`, `{due}`). The engine's lines are given only a few: `{intentLabel}` (`ack_intent`, `ack_queued`, `bridge_next`, `confirm_intent_explicit`), `{a}` and `{b}` (`disambiguate_intent`, `ack_intent_then`), `{first}` (`identity_verified`, `signin_thanks`, `greeting_chat_signed_in`, `greeting_chat_delegate`), `{phoneLast4}` (`ask_otp`, empty when the caller has no phone on record), and the slot's own value (`confirm_<slot>`, `ack_<slot>`, as `{<slot>}`). The rest are given none. `pnpm check` names them when it asks for a missing line.
- `interruptible: false` for a line that must be heard whole (a keypad instruction, a statement).
- `mode` can only be `fixed` (the default). A model chooses among these lines; it never writes one. Generated wording, which lets a model choose the words of a line you flag, never its content, is an opt-in later phase ([design.md §5](design.md#5-generated-wording)).
- The engine itself says about thirty lines by name (`goodbye`, `no_input`, `offer_transfer`, the handoff lines, and so on), and `ask_<slot>` and `ask_<slot>_retry` for every slot. Some lines depend on the slot's spec in the code: `ask_<slot>_dtmf` for a slot with a keypad rung (`dtmf`), `confirm_<slot>` and `ask_<slot>_dtmf` for a slot whose every spoken value is read back (`spokenConfirm: 'always'`), `ack_<slot>` for one acknowledged by confidence (`spokenConfirm: 'by-confidence'`), and the slot's `partialPromptId`. A role whose access to a tool is `person` needs the handoff line for its role rule's `reason` (`handoff_role_person` by default). `pnpm check` lists any that are missing and says when the engine says each (section 7). It cannot see the lines a slot's `fill` names (`disambiguate_<slot>`, a `retryPromptId`, a help prompt) unless the slot declares them in its `prompts` (section 5).

### policy.yaml

What the app's agent may do, action by action: the whole of it. Each action is a tool, with the identity level it needs and the rules the gate runs before it, in the order written; the first rule that fails decides. Policy is data here, and never lives in a tool.

```yaml
actions:
  renewLoan:
    level: 0
    rules:
      - identity
      - confirmed: [book]
  findHold:
    level: 0
    rules:
      - identity
      - custom: known-branch
  listLoans:
    level: 0
    rules: [identity]
```

Every tool in the code needs an action here, and an action not listed is refused. [Section 3](#3-policy-and-identity) is the whole treatment: each built-in rule (`identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`), rules of your own, purposes, redaction, what is recorded, and how the policy is tested and reviewed.

### identity.yaml (optional)

How a caller proves who they are, and who the app serves. The clinic has none. The engine's valid-folder test fixture is:

```yaml
principals:
  subject: patient
  delegates:
    staff: { roles: [viewer, clerk] }
levels:
  1: { name: verified, factors: [patientId, dob], verify: verifyPatient, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
```

An app without the file verifies no one, and every action must be level 0. [Section 3.6](#36-the-identity-ladder) says what each part means: the principals, the ladder's levels and factors, the length of the one-time code, the attempts, and sign-in.

### slots.yaml (optional)

Names every slot the app has, one key per slot, and the order of the keys is the order of `App.slots`. Each slot is a library type with its options (the types and their options are in `schemas/slots.schema.json`; section 5 covers choosing and writing a slot) or `{ type: code }`, a slot the code writes in `code.slots.<id>`.

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

The eight types and their options are in section 5 and in [docs/slots](slots/README.md); a small library slot looks like this:

```yaml
note:
  type: text
  what: a note for the librarian
  say: your note
```

The rules, each checked by `defineApp` and `check` with the file and line:

- **The file lists every slot.** Each key of `code.slots` must appear as `{ type: code }`, and each `{ type: code }` must have a `code.slots` entry. A slot that is both a library slot and in `code.slots` is refused: it would be built twice.
- **The order is the file's.** Outside a form the engine fills slots in that order, says their acknowledgements in it, asks the first slot that needs the caller to choose between two values, and lists the slots in it in the model's turn state and in a transfer's handoff. A form's own slots stay in the order forms.yaml gives. Without a slots.yaml, the order is whatever order `code.slots` was written in, which is easy to change unintentionally; with one, it is written down in one place, and a reorder shows in a diff.
- **A type is a library type, an app type or `code`.** An app adds its own types with `slotTypes` in its code (`code.slotTypes: registerSlotType(myType)`); a name a built-in type has, and `code`, are refused. An unknown type names the closest one.
- **A library slot's options are checked by its type**, strictly: a misspelt option is refused with the one meant, at its line in slots.yaml.

Without the file, every slot is the code's, as before. The file is part of the configuration hashes (section 9). An app that is not built from a folder gets the same rules from `defineSlots(source, codeSlots, types?)`, where `source` is the path of a slots.yaml or the same map as an object; it returns the slots in the file's order, or throws an `AppDefinitionError` listing every problem.

### locale/&lt;tag&gt;/prompts.yaml (optional)

The prompts for another language, in the same shape as prompts.yaml. See section 8.

### locale/&lt;tag&gt;/slots.yaml (optional)

How the library slots say their values in that language: a choice option's `say`, a text slot's stand-in. Never what the model is asked. See section 8.

### fixtures/ (optional)

The corpus (`corpus.jsonl`, one labelled utterance per line), scripted calls, the baseline, and recorded cassettes. They are how an app is tested with no keys: the stub decision model answers from the corpus labels. The clinic's README explains the harness; the only rule `check` adds is that every intent has examples in the corpus when `app.yaml` names a fixtures directory:

```json
{"id":"sn-01","text":"I'd like to make an appointment","intent":"schedule_new","context":"no_form"}
```

### kb/ (optional)

The folder of an app that answers general questions from approved passages: `kb.yaml`, `topics.yaml`, passages with the source documents they are approved against, a language's wording, drafts waiting for review, and the log of approvals. It is the subject of [section 12](#12-the-knowledge-base), which has each file with an example and everything built on it.

## 3. Policy and identity

The gate decides whether an action may run, and it decides from two files that a person who does not write code can read: `policy.yaml` (what the agent may do, action by action) and `identity.yaml` (who the app serves and how a caller proves who they are). Policy is data, and never lives in a tool. A tool does its work; the gate decides whether it runs. This section is the whole of how to write, test and review those two files. [design.md](design.md#6-identity-and-policy) says why they are shaped this way.

The snippets here come from the engine's own test app, Example Parcels (a fictional parcel depot, `packages/dialogwright/src/testing/testkit/`), which runs from the same files an app folder has: a customer who verifies with an account ID and date of birth and then a texted code, and depot agents who act for customers with a role. Where a snippet is only an illustration it says so. Every YAML block in this guide that is a policy or identity file is checked against the schemas and the rules by a test, so an example cannot drift from what the loader accepts.

- [3.1 The two files](#31-the-two-files)
- [3.2 An action and its rules](#32-an-action-and-its-rules)
- [3.3 The built-in rules](#33-the-built-in-rules)
- [3.4 Rules of your own: `defineRule`](#34-rules-of-your-own-definerule)
- [3.5 Purposes and wording](#35-purposes-and-wording)
- [3.6 The identity ladder](#36-the-identity-ladder)
- [3.7 How a form reaches an action: `calls`](#37-how-a-form-reaches-an-action-calls)
- [3.8 Redaction per principal: `redact`](#38-redaction-per-principal-redact)
- [3.9 What is recorded: `audit`, and the rule names](#39-what-is-recorded-audit-and-the-rule-names)
- [3.10 Testing the policy](#310-testing-the-policy)
- [3.11 Reading the policy: the card and the app map](#311-reading-the-policy-the-card-and-the-app-map)
- [3.12 Who reviews it: CODEOWNERS](#312-who-reviews-it-codeowners)
- [3.13 Converting an old file](#313-converting-an-old-file)

### 3.1 The two files

`policy.yaml` is required. Its keys:

| Key | What it holds |
|---|---|
| `actions` | One entry per action (a tool): its `level`, its rules in order, and a `say` that names it in plain words. |
| `purposes` | The level a purpose (what the caller wants done) needs, where it is more than its first action's. |
| `wording` | The words the built-in rules use in their lines, so the console and the audit read in the app's terms. |
| `redact` | The fields of an action's result withheld from a party who acts for subjects. |
| `audit` | How each param that is not a slot with a redact setting is recorded. |

`identity.yaml` is optional. An app without it verifies no one: every caller stays anonymous, and every action must be level 0 (the clinic is like this). Its keys are `principals` (who the app serves, and who acts for them), `levels` (the ladder), `attempts` and `signIn`. Section 3.6 has them.

The two are read together. Policy names the levels and roles identity declares, and identity names tools that policy gives actions; the loader checks each against the other and against the app's code, and reports every disagreement at its line.

### 3.2 An action and its rules

```yaml
actions:
  getParcel:
    say: read a parcel
    level: 2
    rules:
      - identity
      - scope: { record: parcel }
  createReport:
    say: report a missing parcel
    level: 2
    rules:
      - identity
      - role: { viewer: refuse, clerk: person }
      - scope: { param: accountId }
      - confirmed: [accountId, missingNote, expectedDate]
      - custom: not-delivered-that-day
```

- An action is a tool. Every tool in the code needs an action here, and every action needs a tool: a tool with no action cannot be called, and the gate blocks any call to a tool the policy does not list (`unlisted`), for every caller.
- `level` is the identity level the action needs: 0 anonymous, 1 the factors matched, 2 the factors and a one-time code (`identity.yaml` names them). An action with no `level` needs the highest, so one left without fails closed. `say` is what the action does, in a reviewer's words, as the policy card says it; write it for every action.
- `rules` is a list, run in the order written. The first rule that fails decides, and the gate answers with that rule's verdict: `BLOCK`, `STEP_UP` (verify further, then try again) or `NEEDS_HUMAN` (a person takes the call). Order is part of the policy: put `scope` before a rule that looks something up, so a lookup is only asked about a record the caller may see. A rule with no parameters is its bare name (`identity`, `attempts`); a rule with parameters is a one-key map. A rule is listed once per action (a range rule once per field). An empty list runs no rule, and the policy card says so.
- No rule is implied. An action that must check the level lists `identity`; a tool that verifies a caller lists only `attempts` at level 0 (it cannot ask for a level its own call is there to raise).

### 3.3 The built-in rules

| Rule | Written | Passes when | When it fails |
|---|---|---|---|
| `identity` | `identity` | the caller's level is at least the action's (raised to the call's purpose's level, if that is higher) | `STEP_UP` to that level for one of the app's subjects, who can give the factors; `BLOCK` `identity` for any other party, who cannot |
| `scope` | `scope: { param: accountId }` or `scope: { record: parcel }` | the subject the call names is one the caller may see | `BLOCK` `scope` |
| `role` | `role: { viewer: refuse, clerk: person, reason: staff-filing }` | the caller's role is allowed the action | `BLOCK` `role`, or `NEEDS_HUMAN` with the rule's `reason` |
| `confirmed` | `confirmed: [accountId, missingNote, expectedDate]` | the call sends exactly these fields, and their values are the ones the caller said yes to | `BLOCK` `confirmation` |
| `attempts` | `attempts` | the failed tries at the identity checks are fewer than `identity.yaml`'s `attempts` | `NEEDS_HUMAN` `attempts` |
| `fields` | `fields: [report, missingNote, expectedDate]` | the call sends no field beyond these | `BLOCK` `minimization` |
| `dateInRange` | `dateInRange: { field: returnDate, notAfter: today }` | the date is within its bounds | `BLOCK` or `NEEDS_HUMAN`, by reason |
| `limit` | `limit: { field: amount, max: 500 }` | the number is within its limits | `BLOCK` or `NEEDS_HUMAN`, by reason |
| `custom` | `custom: not-delivered-that-day` | the app's own rule says so (section 3.4) | the rule's own verdict and reason |

Every rule fails closed: a param that is missing, a record that does not exist or a lookup that throws is a refusal, never a pass.

**`identity`.** Level comparison, nothing more. A caller below the level is stepped up if they can be (the engine then asks for the factors on a channel that cannot sign them in) and refused if not.

**`scope`.** Whose record it is. `param` says the call's param is the subject's own id (`accountId`); `record` says it is a record id the gate resolves to its owner with the app's `ownerOf` lookup. A caller may see what the `scopeOf` lookup gives for them: a subject sees their own records, a party acting for subjects sees those of the subjects they act for. A missing, empty or unknown subject fails the rule, with the same refusal either way, so the line cannot be used to learn which records exist. Scope never comes from the conversation. `wording` can describe the rule in the app's own terms (section 3.5).

**`role`.** What each role may do with the action: `allow`, `refuse`, or `person` (a person takes the call, for the `reason` named, `role-person` if none; its handoff line is `handoff_` and the reason with its hyphens as underscores, `handoff_role_person` by default, and `check` requires it in every locale). A role not listed is refused, and so is a party who acts for subjects and has no role. One of the app's own subjects passes: roles govern the parties acting for them. The roles are those `identity.yaml` declares under `principals`.

**`confirmed`.** What makes a write match exactly what the caller agreed to. The form reads its slots back, the caller says yes, and the engine hashes the values of these fields in this order; the write goes through only if the call carries exactly these fields with exactly those values. A correction said with the yes ("yes, but Thursday") changes a value, so the write is refused and the read-back is said again. For now every `confirmed` rule of an app names the same fields in the same order, since the read-back's hash is taken once, over one list; `check` reports one that differs.

**`attempts`.** Failed tries at an identity check, the factors' and the code's, counted against the one number `identity.yaml` gives.

**`fields`.** The minimum a downstream service receives: the call may send these fields and no others. An empty list sends none.

**`dateInRange` and `limit`.** Two rules that hold a param's value to bounds, so a common check needs no code. A store's refund, say (an illustration): the amount at most the order's total, the return date no later than today and inside the order's return window.

```yaml
actions:
  refundOrder:
    level: 2
    rules:
      - identity
      - scope: { record: orderId }
      - fields: [orderId, amount, returnDate]
      - limit: { field: amount, min: 0.01, max: orderTotal(orderId) }
      - dateInRange:
          field: returnDate
          notAfter: today
          within: returnWindow(orderId)
          reasons: { outsideWindow: late-return }
          verdicts: { outsideWindow: NEEDS_HUMAN }
```

- `dateInRange: { field, notBefore?, notAfter?, within?, unscoped?, reasons?, verdicts? }`. `field` is the param holding the date, `yyyy-mm-dd` and a day the calendar has. `notBefore` and `notAfter` are `today` (the call session's date, never the clock), a number of days from today, a date, or a reference to a lookup that gives one. `within` is a reference to a lookup that gives a window, `{ start, end }` with `end: null` for one with no end; a lookup that gives `null` has no window, and the date is outside it. At least one of the three.
- A number of days from today is `today+N` or `today-N`, N a whole number from 1 to 3660, with no spaces and no leading zero: `notAfter: today+30` holds a date to no later than 30 days from today, `notBefore: today-7` to no earlier than a week ago. The day is today's date with N calendar days added or taken away, counted in UTC days, so a month's end, a year's end and a leap day fall where the calendar has them. Any other spelling (`today+0`, `today + 30`, `today+030`, `today+30d`, `today+3661`) is a problem `check` reports. Two bounds that both count from today must be in order; a date and a number of days from today are not compared, since today moves. The policy card says it in words: "no later than 30 days from today", "no earlier than 7 days before today".
- `limit: { field, min?, max?, unscoped?, reasons?, verdicts? }`. `field` is the param holding the number: an optional minus, digits, an optional point and digits (`12`, `0.50`, `-3`), and nothing else (no units, currency, thousands separators, exponents or spaces). `min` and `max` are numbers, or references to a lookup that gives one (a number, or a text in the same form). At least one of the two. Numbers are compared exactly, as decimals. A bound beyond 9007199254740991 (the largest whole number a YAML number holds exactly) is written quoted, as text (`max: "12345678901234567890"`); `check` refuses it unquoted, since it may already be rounded.
- Every bound is inclusive: a value equal to a bound, or to either end of a window, passes.
- `reasons` names the reason the gate gives for each way the rule fails, for the app's refusal lines (`blockPromptId`) and handoffs: `invalid` (not a date: `not-a-date`; not a number: `not-a-number`), `outOfRange` (`date-range`; `limit`), and for `dateInRange` `outsideWindow` (`date-window`). `verdicts` sets `outOfRange` and `outsideWindow` to `BLOCK` (the default) or `NEEDS_HUMAN`.
- They fail closed. A value that is not a date or a number BLOCKs, whatever `verdicts` says. A bound that cannot be found BLOCKs with the reason `bound-unknown`: the param a reference reads is missing, the lookup is not a function or gives something that is not a date, a number or a window. A lookup that throws BLOCKs the call too (`rule-error`).

A reference is `<lookup>(<param>)`, or `<lookup>(<param>).<field>` to read one field of what the lookup gives (`order(orderId).total`). Each part is a plain word (a letter, then letters, digits and underscores). It is read when the app is built, never run: the lookup is a function of the gate's lookups (what `systems()` returns beside `ownerOf` and `scopeOf`), called with the value of `<param>` in the call, and the app names the lookups a reference may call in `code.lookups` (`definePolicy(..., { lookups })` for an app that is not a folder):

```ts
export const code: AppCode = {
  // ...
  lookups: ['orderTotal', 'returnWindow'],
  systems: () => {
    const store = new StoreSystems();
    return {
      sys: store,
      lookups: {
        ownerOf: (id) => store.ownerOf(id),
        scopeOf: (p) => store.scopeOf(p),
        orderTotal: (id) => store.order(id)?.total ?? null,
        returnWindow: (id) => store.returnWindow(id),
      },
    };
  },
};
```

**Whose lookup it is.** A lookup called with a param is about the record that param names, so a caller must not be able to read a bound off someone else's: every param a reference reads must be held to the caller's own records by a `scope` rule earlier in the same action (`scope: { param: <it> }`, or `scope: { record: <it> }` for a record id), as `scope: { record: orderId }` does above. Where the lookup is about no one's record (a price list, a calendar, terms that are the same for everyone), say so on the rule with `unscoped: true`, and no scope rule is needed:

```yaml
      - limit: { field: fee, unscoped: true, max: feeSchedule(service) }
```

`check` refuses a reference whose param no earlier scope rule holds, in a rule that is not `unscoped`, and `unscoped` on a rule with no reference. The policy card says, for each range rule with a reference, whose lookup it is.

A bound comes only from the app's code and systems, never from the session's facts or the conversation. `check` refuses a reference to a lookup `code.lookups` does not name, a name every object has (`constructor`, `toString`, `prototype`, ...) as a lookup or a field, the gate's own `ownerOf` or `scopeOf`, and, where the action's `fields` or `confirmed` rule says which params it sends, a `field` or reference param outside them. A field is read only as a plain object's own value, never a getter or an inherited one.

Each records itself under its name (`dateInRange`, `limit`) with lines like `amount at least 0.01, at most orderTotal(orderId) 120` and `returnDate outside returnWindow(orderId) 2026-09-20..2026-10-20`: the param's name and the bounds it was held to (today's date, a number of days from today with the date it gave, `on or before today+30 2026-11-01`, a literal, what a lookup gave), with a reference as written: the param a lookup was called with by its name only. No param's value is ever in the line, not even its last four, since it may be a value the app records hidden or never, and a line goes to the audit as it is.

### 3.4 Rules of your own: `defineRule`

When no built-in rule says it, an app writes one in TypeScript and names it in the action with `custom: <id>`. A custom rule is written with `defineRule` (from `'dialogwright/policy'`): its id, a plain-English description, a `run` that says whether the call passes and what it compared, and examples of what it allows and refuses. The library fixture's rule holds a hold request to a branch the library has:

```ts
export const knownBranch = defineRule({
  id: 'known-branch',
  description: 'The hold is at one of the library\'s branches',
  run(c) {
    const branch = c.call.params.branch ?? '';
    return Object.hasOwn(BRANCHES, branch) ? { pass: true, compared: `branch ${branch}: known` } : { pass: false, compared: 'branch not known', verdict: 'BLOCK', reason: 'branch' };
  },
  examples: [
    { name: 'a hold at a branch the library has', call: { params: { book: 'river_atlas', branch: 'north' } }, principal: CALLER, expect: { verdict: 'ALLOW' } },
    { name: 'a hold at a branch it does not have', call: { params: { book: 'river_atlas', branch: 'east' } }, principal: CALLER, expect: { verdict: 'BLOCK', reason: 'branch' } },
  ],
});
```

```yaml
  findHold:
    level: 0
    rules:
      - identity
      - custom: known-branch
```

It is registered in the code (`customRules: { 'known-branch': knownBranch }`) and named by the action.

- `run(c)` gets the rule context: the call (`c.call.params`, `c.call.purpose`), the caller (`c.p`), the gate's facts, and the app's lookups (`c.lk`). It answers `{ pass: true, compared }`, or `{ pass: false, compared, verdict, reason }` with the verdict the gate stops at (`BLOCK`, `NEEDS_HUMAN`, or `STEP_UP` with a `needLevel`). `compared` is the line recorded in the console and the audit as it is, so write only what may be recorded: a masked id, never a value the app redacts (3.9 says how masks reach it too). A `run` that throws, or answers something else, blocks the call like any rule would.
- The policy card shows the rule's `description`, so write it in a reviewer's words.
- The examples are required. `check` refuses a custom rule that is a plain function, one whose id is a built-in's (a rule's name, `unlisted`, or one of the old ids `R0` to `R7`), one without a description, and one without at least one example the gate allows and one it refuses. Each example is a call, who makes it (`principal`; `CALLER` here is `{ kind: 'anonymous', level: 0 }`, since the library verifies no one), and the verdict and reason expected. The matrix runner (3.10) runs each through the compiled gate in every action that names the rule, so it must pass the action's other rules too: an example's `facts` default to no failed attempts and the call's values confirmed, and `lookups` sets lookups of its own over the app's. A refusal must come from this rule.
- An App built by hand may still carry a plain function; the gate runs it as before.

### 3.5 Purposes and wording

**Purposes.** A call carries the purpose it is made for (the form's id, or none). `purposes` is the level a purpose needs when it is more than its first action's: reporting a parcel missing may begin with an action at level 1, but the caller should prove the code before the form begins.

```yaml
purposes:
  report_missing: { level: 2 }
```

The level the gate asks of a call is the higher of the action's and the purpose's. A purpose's level must be one the ladder has.

**Wording.** The built-in rules write a description and a `compared` line for every decision, and the defaults are neutral. `wording` puts them in the app's terms: what the scope rule says when a subject or a party acting for subjects asks (by `record` or `param`), what its line calls an owner (`recordOwner`) and a subject, and the role rule's line by what the role gets, a template with `{role}` and `{tool}`.

```yaml
wording:
  scope:
    subject:
      record: The parcel belongs to this customer
      param: The customer is the caller
    delegate:
      record: The parcel belongs to a customer of this depot
  recordOwner: parcel owner
  subject: customer
  role:
    allow: "{role} may use {tool}"
    refuse: "{role} may not use {tool}"
    person: "{tool} by {role} goes to a person"
```

### 3.6 The identity ladder

`identity.yaml` is how a caller proves who they are, and who the app serves. Example Parcels':

```yaml
principals:
  subject: customer
  delegates:
    agent: { roles: [viewer, clerk] }
levels:
  1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
signIn: { level: 2 }
```

- **Principals.** `subject` is the kind of principal the app serves and verifies (a customer, a patient), a lowercase word, since it is also an audit detail key. `delegates` are the kinds of party who act for subjects (a depot agent, a caregiver), each with the roles one may have: the roles the policy's `role` rules and `redact` rows name. Anonymous is the kind nobody is yet. Every party the app's portal lists and every principal it signs in (`code.portal`, `code.principals`) must fit these: a delegate of a declared kind, with a declared role. `defineApp` (through `validateApp`) refuses one that does not.
- **Levels.** The ladder above level 0 (anonymous), cumulative: level 2 is level 1 and its own factors. Each level has a `name`, a label for the console and the policy card (the engine records the numbers everywhere).
  - Level 1's `factors` are slots the code defines, asked for a step-up (each slot id is also the name of the verify tool's param that carries its value). `verify` is the tool that checks them, `failedPrompt` the line said before they are asked again (default `identity_failed`).
  - Level 2 adds the one-time code, `factors: [{ otp: { length: 6 } }]`, keyed on the keypad: `send` is the tool that sends it to the contact on file, `verify` the tool that checks it. The code is no slot: it is masked, never traced and never held on the session. Its `length` is 4 to 8 digits, 6 if left out, and the lines that ask for it say the length in their own words. The one function in this part, the params of the send call, stays in code as `code.identity.sendCodeParams`.
  - Level 2 is optional. A ladder of one rung has no code, and then no action or purpose may need level 2.
  - The identity tools are tools with actions in the policy. Level 1's `verify` lists only `attempts` at level 0, so a caller can try before they are verified; the code's `send` and `verify` need level 1:

    ```yaml
    actions:
      verifyCustomer:
        say: check the account ID and date of birth
        level: 0
        rules: [attempts]
      sendCode:
        say: text a one-time code
        level: 1
        rules:
          - identity
          - scope: { param: accountId }
      verifyCode:
        say: check the one-time code
        level: 1
        rules: [identity, attempts]
    ```

- **The identity tools are for the subject.** The verify tool and the code's two tools prove a subject to themselves: the factors are a subject's, and the code goes to a subject's own phone. The gate refuses them to any party who is not one of the app's subjects (a party who acts for subjects, or any other kind) before their own rules run: BLOCK with reason `not-subject`, recorded as the `subject` line. A caller not yet verified (anonymous) and a subject are held to the actions' rules as written. No file writes this check and none can turn it off. A tool of the app's own that contacts a subject (sends them a link, say) is not an identity tool: if a party who acts for subjects may use it, its policy says so like any other action's.
- **Attempts.** The failed tries allowed at each check, the factors' and the code's, before a person takes the call. It is the one number every `attempts` rule holds an action to.
- **Sign-in.** `signIn: { level }` says a channel that can sign a caller in (a web portal) proves that level, always the top of the ladder, and a signed-in caller starts there; factors are never asked on such a channel. The engine checks the channel's capability, never its name. An app without `signIn` takes no sign-in: it ignores the sign-in event, and on a channel that can sign a caller in, a caller whose request needs identity goes to a person (there is nothing to wait for and no factor to ask).
- **Lines.** With an identity.yaml the engine also says the identity lines (`identity_verified`, `handoff_identity`, and with level 2 `ask_otp`, `otp_failed` and others), and `check` requires them in every locale.

### 3.7 How a form reaches an action: `calls`

The action a form's hooks call goes through the gate, but the engine does not read which. Declare it in forms.yaml (`calls`, on each form, section 2) so the policy can be read as a whole: `calls` lists the actions the form's entry, summary and completion hooks make, and `check` reports an action no form reaches (an action the identity flow calls itself, the identity tools, is not counted). The app map (3.11) draws a form to its actions and their rules with it. Declare it for every form or for none (`calls: []` for a form that calls nothing).

### 3.8 Redaction per principal: `redact`

A party who acts for subjects (a depot agent for its customers, say) may read a record without being shown all of it. The tool returns the whole record, and the policy says what each kind of party, or one of its roles, does not see:

```yaml
actions:
  getParcel:
    say: read a parcel
    level: 2
    rules:
      - identity
      - scope: { record: parcel }
  listParcels:
    say: list the customer's parcels
    level: 2
    rules:
      - identity
      - scope: { param: accountId }

redact:
  agent:
    getParcel: [safePlace]
    listParcels: [safePlace]
  agent.clerk:
    getParcel: []
    listParcels: []
```

```ts
getParcel: { run: (call, sys) => { /* the whole parcel */ }, fields: ['safePlace'] },
```

- A key is a delegate kind from identity.yaml (`agent`), or the kind and one of its roles (`agent.clerk`). A role's list for an action replaces its kind's, so an empty list shows a role what its kind may not see. A role with no row of its own gets the kind's.
- A tool declares the fields of its result the policy may withhold (`fields` on the tool, in code): by name, wherever its result holds them. `redact` may name only those, and only actions the policy lists.
- The engine strips them in one place, right after the tool runs (the lifecycle's `callTool`): each withheld field is set to `null` wherever the result holds it, at any depth (the value when it is an object, each item when it is a list, and every object and list below them; own keys only, a shared object or a cycle copied once). The top object, or each object of a top-level list, always gets the field, as `null`, present or not. `redacted: <fields>` is added to the call's summary (`in_transit; redacted: safePlace`), and every text a withheld field held is masked (`•`) wherever the tool's summary or the record it names repeats it, as a whole token. Nothing else ever sees the whole value: not the form hooks (`onEntry`, `complete`, `callTool`'s `value`, whose `redacted` lists what was withheld), the facts, the lines, the trace, the console or the audit. Still write the tool's own summary without these fields: it is written before the stripping, and a value it reshapes is not recognised.
- What redaction does not reach: what the tool itself does with the whole record while it runs (a side effect it queues goes to its downstream service as queued, though its params as recorded have every withheld text masked; what it writes to the session) and an error it throws. Those are the tool's code, and must keep to what the caller may see.
- A result that cannot be stripped (a tool with fields that returns text, a number, a list of those, or a Map or a Set somewhere inside) is never handed on: the call that ran is still recorded, its summary says the result was not, and the call goes to a person (`NEEDS_HUMAN`, reason `result-unredactable`).
- A subject acting for themselves is never redacted, and neither is an anonymous caller. A party who is neither and whose kind has no row at all (nor its role), in an app with no `redact` section too, has every field each tool declares withheld: the policy said nothing of them, so it fails closed. Give the kind a row (an empty list shows a field) to say otherwise. The gate's decisions do not change; only what the call hands on does.
- `check` refuses a key that is not a delegate kind or one of its roles (the subject kind included), an action the policy does not list, and a field the tool does not declare, each with the closest name. An app built in code (`validateApp`) refuses the same when it is registered.
- The policy card has a section, "What is withheld", with a row per kind or role and action.

### 3.9 What is recorded: `audit`, and the rule names

Every call is recorded: the gate's decision carries a copy of it into the gate event, the trace, the console and the audit. A param named after a slot with a redact setting is masked as the slot says. Every other param is recorded as `audit` declares it, by param name, in every action that sends it:

```yaml
audit:
  recordId: keep
  branch: keep
  pin: secret
```

```ts
getRecord: { params: ['recordId'], run: (call, sys) => { /* ... */ } },
```

| `audit` | Recorded as |
| --- | --- |
| `last4` | its last four characters (`...1234`) |
| `mask` | hidden (`•`) |
| `length` | its length only (`<38 chars>`) |
| `secret` | never: the param is left out of the call as recorded, and is `•` wherever else its value would appear |
| `keep` | as it is |

- Each tool lists the params its calls carry (`params` on the tool, in code; `params: []` for none). The calls are built in code (a form's hooks, the identity flow), so the tool, which reads them, is where they are listed. `check` requires the list of every tool, refuses a listed param that is neither a slot with a redact setting nor declared here (the fix names both ways out), refuses a param a `scope`, `confirmed` or `fields` rule names that the tool does not list, and refuses a declaration of a slot that has a redact setting or of a param no tool lists. A range rule's field and the params its references read are held to the tool's list where no `confirmed` or `fields` rule closes the params. An app built in code (`validateApp`) refuses a listed param that nothing declares when it is registered.
- The same masks reach the free text recorded beside the call: the rules' lines (a custom rule writes its `compared` line as it likes), the tool's summary and the record it names, the params of the side effects it queues as it runs, whatever their names, in the trace and the console (the service is sent them as they are), the tool's own audit rows (`audit` on the tool), and a downstream service's audit row for its answer to one of those effects (`audit` on the service). Where a value is recorded hidden, by length or never, its last four (`...1234`, as the scope rule names a subject) are masked too. Wherever one of them repeats the raw value of a param that is recorded masked or never, the value is replaced by its recorded form, in any case, as a whole token (not inside a longer run of letters or digits). A value of fewer than three characters is not looked for, since it cannot be told from a line's own words and numbers (`level 1`, `a caller`); the call as recorded still masks it. A value a rule or a tool reshapes (a date reformatted, digits spaced out, a part of it quoted) or runs into other letters or digits is not recognised either, so a custom rule still writes only what may be recorded.
- The gate decides on the raw call: what is recorded never changes a decision.
- The gate-event goldens (`gateEventGolden` in `dialogwright/testing`) report any param an app's own calls carry that its tool does not list (`unlistedParams`); an app's golden test expects none.
- The policy card has a section, "What is recorded", with a row per action and value.

**Rule names.** Each rule's line is recorded under the rule's name: `scope fail: record owner ...5678 · caller may see ...1234 only`, `confirmed pass: confirmed hash = call hash`. The names are `identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange` and `limit`; a custom rule is recorded under its own id; an action the policy does not list is recorded as `unlisted`; and an identity tool refused to a party who is not a subject (3.6) is recorded as `subject`. These are in a decision's `rules`, the gate event, the trace, the console and the audit's `rules` lines. An app's code that asks whether a rule passed asks by name, with `passed(decision, 'role')` from `'dialogwright/policy'`, and never reads an id of its own invention.

**Ids changed on 2026-10-03.** Before that, the same lines were recorded as `R1 pass: ...`: R1 is `identity`, R2 `scope`, R3 `confirmed`, R5 `role`, R6 `attempts`, R7 `fields` and R0 `unlisted`. The audit files of the days before keep the old ids and still verify, since the chain hashes what was written and no verdict, reason, level or line of words changed; a query over the audit that spans the date reads both. The old ids stay reserved: an app's own rule may take neither a name above (`unlisted` and `subject` included) nor `R0` to `R7` for its id, and an old `rulesFor` table still lists them (`dialogwright policy:convert` reads them as before).

### 3.10 Testing the policy

Three tests hold the gate to what policy.yaml says, each from `'dialogwright/testing'` and each run over the gate grid: every action crossed with every kind of caller, subject and fact. The grid's people and records come from the app's `testing.policyMatrix()` hook (`code.testing`, never read by a call): a subject at level 1 and at level 2, a party for each role, a role the policy does not name, a party with no role, an unrelated party, and the records each may and may not see.

```ts
import { expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';

describe('the policy against its file', () => {
  it('holds to the policy\'s invariants on the gate grid', () => {
    expect(policyInvariants(app).violations).toEqual([]);
  });
  it('every custom rule does what its examples say', () => {
    expect(runRuleExamples(app)).toEqual([]);
  });
  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/my-app');
  });
});
```

- **Invariants.** `policyInvariants(app)` asserts what must hold whatever order the rules are written in: an action not listed is blocked for everyone; an identity tool is never allowed for a party who is not one of the app's subjects; a caller below an action's level is never allowed; `scope`, `confirmed`, `role`, `fields` and `attempts` each refuse what they exist to refuse; an allowed call ran every rule its action lists, and each passed; raising the caller's level never turns an allow into a refusal; and the scope rule's answer does not move with the conversation. They are derived from the policy as written and the grid's lookups, not from the gate's own lines, so a gate that is wrong in a way its lines agree with is still caught. A failure names the invariant, the grid case and the rule. The report says how many cases each invariant applied to, so a test can also assert that an invariant was exercised.
- **The matrix.** `expectPolicyMatrix(app, file)` compares `policy.matrix`, beside policy.yaml, with what the gate decides today, and fails with a diff. The matrix is written for a reviewer: under each action, a row per kind of caller with the verdict and its reason, split by what the call carries only where the verdict depends on it, then each custom rule's examples:

  ```text
  findHold · level 0 · identity, custom known-branch
    every caller   fields exact|extra, params known    ALLOW
                   fields exact|extra, params unknown  BLOCK branch
                   fields missing                      BLOCK branch
  ```

  A policy change is a diff of this file. Write it deliberately with `pnpm policy:matrix <folder>` (with no folder, every `policy.matrix` in the workspace), read the diff, and commit it; never in CI.
- **Rule examples.** `runRuleExamples(app)` runs every custom rule's examples through the compiled gate, and fails on one the gate decides otherwise, or whose refusal is not the rule's own.

When a rule or the gate itself changes, the same grid is the way to prove nothing else moved: the **shadow gate** (`withShadowGate`, `shadowGate`, `legacyGateEvaluator`) runs a second gate beside the one under test, over the whole grid and inside every replay of a recorded call, and fails on any decision that differs. The engine used it to move every app from the gate's old tables to the files, with the old evaluator frozen as the reference; an app that rewrites a rule of its own can do the same.

### 3.11 Reading the policy: the card and the app map

**The policy card.** `POLICY.md`, beside policy.yaml, is the policy in plain English for someone who will not read YAML: written from the compiled app (the gate's own rules, so it cannot say what the gate does not do). Write it with `pnpm policy:card <folder>` (with no folder, every `POLICY.md` in the workspace) and commit it; GitHub renders it, diagrams included. It has:

- the files' config hashes (policy.yaml and identity.yaml, as every call's audit record carries them);
- the defaults ("anything not listed is refused", identifiers by their last four, what is recorded masked);
- the identity ladder: each level by its name, what the caller gives in the words of the slots' nouns, the tools that check it, the code, the sign-in, with a Mermaid diagram of it;
- who the app serves and who acts for them, with what each role gets;
- what is withheld from them (`redact`), and what is recorded of each value an action is sent (a slot's redact setting, `audit`);
- one row per action, with its label (`say:`, else the tool id), its level by name and each rule in words with its parameters (the scope rule's param as a noun, the confirmed values, the fields sent, a range rule's bounds, a custom rule's `description`);
- a second diagram of the actions grouped by level, with their rules and the roles refused or handed to a person.

Write `say:` for every action, and a `description` for every custom rule, in the words a reviewer would use. A role is shown by its id spelt out (`office_admin` as "office admin"). `expectPolicyCard(app, file)` (from `'dialogwright/testing'`) fails a test on any difference between the page and what the app generates, with a line diff and the command that writes it; put it beside the policy matrix's test. The card is a golden: a policy change is a diff of two files a reviewer reads, and only the command writes it, never CI.

**The app map.** `APP-MAP.md`, beside policy.yaml, draws the app's structure with Mermaid: a table of the intents and what each does; the keypad menu as a tree, with the intents that only say a line joined to their prompt; and, for each form, a diagram from its intent to its slots (each with its type), the summary it reads back, the actions it calls (`calls`) and each action's rules. Write it with `pnpm app:diagram <folder>` and test it with `expectAppMap(app, file)`, as the card.

It is the structure, not a script for a call: the dialog is mixed-initiative, so a caller may give the slots in any order, change their mind or ask for two things in a row. What the map cannot connect is drawn marked and listed under "Dangling references" (`danglingReferences(app)` returns it): an intent with no form, a form no intent starts, an informational intent whose line is not there, a keypad digit to no intent, a form that asks for a slot that does not exist, a call to an action the policy does not list, and an action no form reaches. `check` reports the ones it can from the YAML, with a fix, including the last.

### 3.12 Who reviews it: CODEOWNERS

Policy is a file compliance owns, so a change to it should need their review. GitHub's CODEOWNERS does that: list the files that say what the agent may do, and the people who must approve a change to them (turn on "Require review from Code Owners" in the branch protection rule). For an app's repository:

```text
# .github/CODEOWNERS: a pull request that changes these files needs the owners' approval.
# What the agent may do, and how a caller proves who they are:
policy.yaml        @your-org/compliance
identity.yaml      @your-org/compliance
# What compliance reads, and the golden that shows a change as a diff:
POLICY.md          @your-org/compliance
policy.matrix      @your-org/compliance
# The knowledge base: the answers callers hear, their sources, and the log of approvals.
**/kb/kb.yaml           @your-org/compliance @your-org/content
**/kb/topics.yaml       @your-org/content
**/kb/sources/          @your-org/content
**/kb/passages/         @your-org/compliance @your-org/content
**/kb/locale/           @your-org/compliance @your-org/content
**/kb/approvals.jsonl   @your-org/compliance
```

A bare file name matches in every folder, so each app of a repository is covered. A change to the rules lands as a diff of policy.yaml, of `POLICY.md` and of `policy.matrix` together, in plain words and as the verdicts that follow from it, which a reviewer who does not write code can read and accept or refuse. Owners may be users or teams; an owner needs write access to the repository, or the line is ignored. The knowledge base's lines use `**/kb/...` so they match an app's `kb/` in any folder, and name the files an approval stands on: the passages and their sources, the topics, `kb.yaml`, and `kb/approvals.jsonl`; give them to the people who own the content and, for regulated answers, compliance. Drafts in `kb/pending/` are left open: a draft is never said, and approving it changes `kb/passages/`, which they own. This repository's own file (`.github/CODEOWNERS`) owns the same four names, and the knowledge base's files.

### 3.13 Converting an old file

A policy.yaml or identity.yaml written before this shape (`toolLevel`, `rulesFor`, `subjectKind`, ...) is refused with a message that says how to convert it. `dialogwright policy:convert <folder>` (or `--from-tables <module>` for an app whose tables are TypeScript; `--dry-run` writes nothing) writes the new files from the old, keeping every decision and as many comments as it can, and says which rows it dropped because no rule read them. Before identity.yaml, a caller signed in on any channel that can sign one in (a web chat's portal) was taken at level 2, so where the old identity has a code the converter writes `signIn: { level: 2 }` and the app keeps taking a sign-in. Give `--no-sign-in` for an app no channel signs a caller in to: identity.yaml then has no `signIn`, the app ignores a sign-in, and a chat caller whose request needs identity goes to a person (the factors are never asked on a channel that signs callers in).

## 4. What stays in TypeScript, and why

The test for what is data: could a person who does not write code review it, and could it be wrong without anything executing? Intents, forms, prompt text, the gate's tables and presentation are like that. What runs stays in code, because YAML that tried to describe it would grow into a language of its own. The code is one object, `code: AppCode`:

| Part of `code` | What it is | Why it is not YAML |
|---|---|---|
| `slots` | A `SlotSpec` per slot: the questions the decision model is asked, how its answers become a value (`fill`), the keypad shape, how it is read back (`display`). [Section 5](#5-writing-a-slot) says how to write one. | It is a parser. Most slots need none: a library type named in slots.yaml (section 5) supplies it, and code is for a value no type fits. |
| `tools` | A `ToolDef` per tool: `run(call, sys, ctx)` does the work and returns `{ value, summary }` | It calls the app's systems. It never decides whether it may run: the gate does, from policy.yaml. |
| `systems` | A factory for a fresh copy of the app's systems for each call, and the gate's lookups over them (`ownerOf`, `scopeOf`) | State and connections. |
| `forms` | The hooks of each form, by form id (section 6) | They run during the dialog. |
| `customRules` | The app's own policy rules, by the id `custom:` names them by ([section 3.4](#34-rules-of-your-own-definerule)) | A rule compares values and decides. |
| `lookups` | The names of the gate's lookups (on `systems().lookups`) the range rules' references may call ([section 3.3](#33-the-built-in-rules)) | They are functions of the app's systems. |
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

A custom rule is written with `defineRule`, with the examples that say what it allows and refuses; [section 3.4](#34-rules-of-your-own-definerule) has the library's rule in full.

An app outside the engine package imports only from `'dialogwright'` (the clinic's `src/app.ts` does), and the clinic's launchers (`src/index.ts`, `cli.ts`, `regress.ts`, `serve.ts`) show how an app is registered and run.

## 5. Writing a slot

A slot is one value a form collects: a book, a day, a card number. The model never writes the value: it answers typed questions (yes or no, which of these labels), and the slot turns the answers into a value and decides whether it is good.

**Most slots are configuration.** Pick a type in `slots.yaml`, give it options, and the library supplies the questions the model is asked, how its answers become a value, the keypad, and how the value is said back. Write a slot in code only when no type fits. This section covers the types first, then what is true of every slot, then writing one in code.

### Pick a type in slots.yaml

The library has eight types. Each has a page with every option, its default, the default question text, the outcomes it can give, the prompts it needs and starter examples (the pages are [indexed here](slots/README.md)):

| Type | It collects |
|---|---|
| [`digits`](slots/digits.md) | A number of a fixed shape: an account, a library card, a tracking number |
| [`choice`](slots/choice.md) | One of a fixed list: a delivery speed, a branch, a colour |
| [`date`](slots/date.md) | A calendar day, ahead or back: a delivery, an appointment |
| [`birthdate`](slots/birthdate.md) | A date of birth, heard whole or in part |
| [`name`](slots/name.md) | The caller's own name |
| [`record`](slots/record.md) | One of the app's own records, chosen by what the caller says of it |
| [`text`](slots/text.md) | The caller's own words, kept as said |
| [`topic`](slots/topic.md) | Which of the knowledge base's topics the caller asks about, from those retrieval nominates |

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
- **Another language.** The types read and say Spanish (`es`, `es-*`); a choice option's `say` and a text stand-in can be worded per locale in `locale/<tag>/slots.yaml` (section 8).
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
| `KB_TOPIC_MARGIN` | 0.15 | Two knowledge-base topics closer than this are asked about (a `topic` slot's `disambiguate`). |

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
- `policy.yaml`: a `listLoans` action with `level: 0` and `rules: [identity]`.
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
| A value no list holds: detected, picked as a span, turned into digits and checked, keyed as eight digits, recorded and handed over by its last four | `digits`: the clinic's billing ID (`accountId`) |
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
| `locale` | The language the session speaks, for an app that declares locales (section 8); absent otherwise. A slot that formats its value for the language reads it here. |
| `nominated` | The knowledge-base topics the app's retriever nominated for this turn's words, best first, for a slot that reads them (`nominates: true`, a `topic` slot). Present only on a turn retrieval ran for (an app with knowledge, words, and such a slot listening); absent otherwise. |

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

An order number, a code, a card number: the model cannot choose it from a list, and it is never asked to write it. Instead, the code finds every run of the caller's words that could be the value, the model judges which one it is, and the code turns that run into the value and checks it. The value is then always something the caller said, and the code, not the model, decides whether it is valid. The library's `digits` type works this way (the clinic's billing ID, `accountId`, and the library's card are slots of it), and this section shows the steps as a hand-written slot takes them, for a value the type does not fit:

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
| `last4` | `...0417` | An identifier (the card, the clinic's billing ID, `accountId`). |
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

`display(value, locale)` is how the line says a value: "55520417" for the card, "Dr. Patel" for a provider, "Tuesday, September 22" for a date ("martes, 22 de septiembre" in a Spanish call). `locale` is the session's (`ctx.locale` in `fill` and `dtmf.parse`), which only an app that declares locales has; format en-US exactly as with no locale. The engine does not call it itself: what a line says, what the console shows and what the model sees is the `display` your `fill`, `dtmf.parse` or `disambiguate` candidate returned, stored on the slot. Write one formatter, make it the spec's `display`, and use it in all three, so they agree (the library's `bookSlot` and `branchSlot`, both `choice` slots, and the clinic's date do). The library's card is said digit by digit because app.yaml's `voice.spokenDigits` rule spells `card ` followed by digits for text to speech, so its lines say "card {card}".

### Your own slot type

A slot you write for one app can be a `SlotSpec` in `code.slots`. A shape you will use more than once, or want others to use, is better as a slot type: a function from validated options to a `SlotSpec`, named in `slots.yaml` like the built-in ones. An app registers its own types with `code.slotTypes`:

```ts
import { registerSlotType } from 'dialogwright';
import { defineSlotType } from 'dialogwright/slot-kit'; // the helpers a slot type is written with

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

## 6. The form hooks

`forms.yaml` lists the hooks a form has, and `code.forms.<id>` writes them. `complete` is required; the rest are optional. The hook names, in the order the contract documents them (the type is `FormDef` in `core/app/types.ts`):

| Hook | When it runs |
|---|---|
| `entry` | A call made before the form's own slots are asked (it may step identity up). |
| `onEntry` | Applies a successful entry call's result to the session. |
| `principalEntry` | In place of `entry`, for someone acting for subjects (a delegate). |
| `confirmedParams` | The values a confirmed write sends, read from the session, for the gate's `confirmed` rule. |
| `complete` | The form is full (and confirmed, where it has a summary): does the work, usually by calling a tool through the gate. |
| `onAnswers` | The form heard a spoken turn: lets it keep a volunteered preference. |
| `onSummaryAnswer` | At the summary, an answer that was neither a yes nor a change: the form's own move along what the summary offers. |
| `keepsSlot` | At the summary, whether a named detail is kept and the answer is the form's own move instead. |
| `onSummaryRead` | The summary is about to be read: lets the form look at what it names that the slots do not hold. |

The clinic's reschedule form has six: `[onSummaryRead, onAnswers, onSummaryAnswer, keepsSlot, confirmedParams, complete]`. The library's check_hold has one. Start with `complete` and add a hook only when the form needs it.

## 7. Checking an app: `pnpm check`

```sh
pnpm check                                          # every app folder under apps/
pnpm check ../../apps/clinic                        # one folder (paths are relative to packages/dialogwright)
pnpm check --json ../../apps/clinic                 # the problems as JSON, for a program or an assistant
```

(`pnpm check` runs the `dialogwright check` command in the engine package, so a folder you name is relative to `packages/dialogwright`.)

At the repository root, `pnpm check` finds every folder under `apps/` that has an `app.yaml`. It exits 0 when no folder has a problem, 1 when one has, and 2 for a command it does not understand. CI runs it on every push.

It checks, in one pass:

1. **Each file against its schema.** Unknown keys, wrong types, a missing required file, a YAML syntax error. A misspelt name offers the near match, and a top-level key that belongs in another file names that file (`purposes` in identity.yaml: `move "purposes" and what is under it to policy.yaml`).
2. **The folder against the code**: every slot, tool, hook and custom rule the YAML names exists in the code; every hook the code writes is listed in forms.yaml; every tool in the code has an action in policy.yaml and every action is a tool; every custom rule the code defines is named by a `custom:` rule; every prompt the YAML names is in prompts.yaml; the identity tools, factor slots and carried slots exist; what the console names (form and slot labels, the slot order, question prefixes, a lookup fact's tool) and the clips name (a voice tag's clip, a clip's variables) exists; an action that runs the `confirmed` rule has a form with `confirmedParams` to confirm it; every form's `calls` names tools the code defines, and, when forms declare `calls`, every action is reached by a form or the identity flow; every threshold a slot's options name (a `hedge.threshold`) is one of the engine's or one under `thresholds:` in app.yaml; and the whole app passes the engine's own `validateApp`.
3. **The engine's own lines in every locale**: every line the engine says by name, and the lines it builds for each slot and for a role rule's reason (section 2, prompts.yaml), exists in prompts.yaml and in each `locale/<tag>/prompts.yaml`. A missing line's message says when the engine says it and, when it gives the line variables, which ones (`..., and gives it {first}  ->  add "signin_thanks:" with its text (it may use {first}) and interruptible to prompts.yaml`).
4. **The keypad menu**: every key names a form intent, an informational intent or `agent`; a key for another control intent is refused, since the engine ignores it.
5. **Each locale against prompts.yaml**: a translated line uses only the variables the prompts.yaml line has (the code fills those and no others, so another would fail when it is said), and a locale has no line that prompts.yaml does not (it would never be said).
6. **The corpus**: every intent has at least one labelled example in `corpus.jsonl`, when app.yaml names a fixtures directory. The corpus must be inside the package (a link that leads out is refused) and at most 16 MB.

The format is one line per problem, `file:line:column  path  message  ->  fix`, and then a summary line (`N problems in <folder>`, or `<folder>: ok`). A problem in the code has no YAML line, so it reads `app.ts` (or `src/app.ts`) and a code path such as `code.forms.renew_loan.entry`.

When a schema problem is found, the cross-checks against the code do not run until it is fixed, because a file that does not parse cannot be linked. Fix the schema problems first, then run it again. Any other problem does not hold the rest back: an app module that builds the app with `defineApp` throws when the folder and the code disagree, and `check` still reads the code that `defineApp` was given, so the lines the code needs (a keypad slot's `ask_<slot>_dtmf`, a portal's sign-in lines) are reported in the same run as the problem that made it throw.

These are real messages. The folder was a copy of the library fixture, with these edits: an unknown key `colour: blue` in app.yaml, `level: three` for `renewLoan` in policy.yaml. The first run:

```
app.yaml:5:1  colour  unknown key "colour" in this file  ->  delete "colour"; the keys allowed in this file are id, locale, brand, console, voice, handoff, wording, thresholds, carrySlots, fixtures, prompts
policy.yaml:4:12  actions.renewLoan.level  "level" is "three", which is not allowed here; it must be one of 0, 1, 2  ->  use one of 0, 1, 2
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
policy.yaml:2:1  actions  custom rule "known-branch" (code.customRules["known-branch"]) is not named by any action's rules, so it never runs  ->  add "- custom: known-branch" to the rules of the action it guards, or delete the rule from app.ts (code.customRules["known-branch"])
policy.yaml:12:17  actions.findHold.rules[1].custom  custom rule "known_branch" is not defined in the code  ->  rename it to "known-branch", or add it to app.ts (code.customRules.known_branch), or delete this rule
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

What `check` does not do yet: it cannot check generated wording (every prompt is `mode: fixed`, which the schema enforces); that arrives with the phase that builds it (see the roadmap in [design.md](design.md)). It does require each custom rule to be defined with examples (`defineRule`), which the policy matrix runs.

## 8. Locales

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
- **The knowledge base** has its own wording and passages per locale, with its own fallback rule (`localeFallback`): see [12.7](#127-locales-and-fallback).
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

## 9. Configuration hashes

Every configuration file of an app built by `defineApp` has a content hash, so a call can be tied to the exact configuration it ran under.

- A file's hash is SHA-256 over its parsed content as JSON (object keys in the order written at every level, arrays in order, no whitespace). A comment, a blank line, flow or block style or another quoting style does not change it; a changed value does, and so does reordering keys, since a key's place is meaning (the order of `slots.yaml` is the order of the app's slots).
- The combined hash is SHA-256 over the lines `<file>:<hash>`, sorted by file name and joined with newlines. It changes when any file changes, or one is added or removed. Locale files are in it by path (`locale/es/prompts.yaml`).
- They are on the app as `App.configHashes` (`app` for the combined hash, `files` for each file).
- The `call_started` audit row records the combined hash as `config` and the per-file lines as `configFiles`, so the row alone is enough to recompute and verify the combined hash.
- Every trace record carries the combined hash as `configHash`, and the console shows its first eight characters as `config <8 chars>`.
- An app with a knowledge base has a line for each `kb/` file it is read from (kb.yaml, topics, passages, sources and the locale files; not drafts, rejected drafts, the approvals log or the vector index), so the combined hash changes when an approved answer or its source does ([12.12](#1212-what-is-recorded)).
- They are never sent to the model.

An app that is not built from a folder has no hashes, and its rows are as they were.

The hashes changed format in this release: a file's hash used to be taken over its content with object keys sorted, and now keeps them in the order written. A `config` or `configFiles` hash in a `call_started` row written before the change is not comparable with one written after it, even for the same files; compare hashes only between rows written by the same version.

## 10. Editor support

Every YAML file starts with a line that names its schema:

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/app.schema.json
```

The path is relative to the file (`apps/clinic/app.yaml` points two folders up to the repository root; the library's `locale/es/prompts.yaml` points five up). An editor with the YAML extension then completes keys, shows each field's description, and flags mistakes as you type. Keep the line when you copy a file into a new app, and fix the path if the new folder is at a different depth. The schemas are `app`, `intents`, `forms`, `prompts`, `policy`, `identity` and `slots`; the locale files use `prompts`. The `slots` schema covers the built-in slot types; an app with types of its own can generate one that lists them too (`slotsJsonSchema(registerSlotType(myType))`, exported by `'dialogwright'`) and point the line at that.

The schemas are generated from the zod schemas in `packages/dialogwright/src/define/schema/`, which are also what `check` validates with, so they cannot disagree. Never edit a `.schema.json` by hand. After changing a zod schema, run `pnpm --filter dialogwright schemas`; a test fails when the committed files are stale.

## 11. Walkthroughs

Each walkthrough ends with `pnpm check`, which is the quickest way to find what is left to do.

### Add an intent that only says something

For "what are your hours", an informational intent with no form and no code:

1. `intents.yaml`: add `hours:` with `criteria`, `label`, `kind: informational` and `promptId: hours`.
2. `prompts.yaml`: add `hours:` with its `text` and `interruptible`. Add it to every `locale/<tag>/prompts.yaml` too.
3. Optionally, `menu:` in intents.yaml gets a key for it: the key plays the line, as asking does, and the menu is offered again.
4. If app.yaml names a fixtures directory, add labelled utterances to `corpus.jsonl` with `"intent":"hours"`.
5. `pnpm check`.

### Add a form

For a form that collects slots and acts, such as renewing a loan:

1. `intents.yaml`: add the intent with `kind: form`. Its id is the form's id.
2. `forms.yaml`: add the form with its `slots`, a `summaryPromptId` (or `null`) and `hooks: [complete]`. Add `confirmedParams` too if completing it is a confirmed write.
3. `prompts.yaml`: add `ask_<slot>` and `ask_<slot>_retry` for every new slot, the summary prompt, and the line the form says when it completes. Add them to each locale.
4. `slots.yaml`: for every new slot, add a key with a library `type` and its options ([section 5](#5-writing-a-slot); [the type pages](slots/README.md)). Only when no type fits, write a `SlotSpec` in `code.slots` in `app.ts` and add `<slot>: { type: code }` to slots.yaml. Add the lines the slot's type says it needs (`ask_<slot>_dtmf`, `ack_<slot>`, `disambiguate_<slot>`, its partial line) to prompts.yaml and each locale. In `app.ts`, add the form's hooks under `code.forms.<id>`: `complete` calls the tool and returns what to say.
5. If the form needs a tool, follow the next walkthrough.
6. `pnpm check`, then `pnpm verify`.

### Add a tool

1. `app.ts`: add the tool to `code.tools` with `run` and the `params` its calls carry. It does the work and returns `{ value, summary }`. Put no permission logic in it.
2. `policy.yaml`: add an action under `actions` with a `say`, the `level` it needs and the `rules` the gate runs before it, in order ([section 3.3](#33-the-built-in-rules)). Use `identity` for the level, `scope` for whose record it is, and `confirmed: [<the fields>]` for a write the caller must confirm. Declare under `audit` how each param that is not a slot with a redact setting is recorded.
3. If the tool is a confirmed write, give the form `confirmedParams`, and make the form's `complete` set `s.confirmedHash = s.pendingHash` before the call, as the library's `renew` does.
4. If the tool needs a rule of its own, write it with `defineRule` (with an example the gate allows and one it refuses) in `code.customRules`, and name its id with a `custom:` rule in the action.
5. Write the goldens a reviewer reads and read their diffs: `pnpm policy:matrix <folder>` (what the gate decides), `pnpm policy:card <folder>` (the policy in plain English) and `pnpm app:diagram <folder>` (the app map), then commit them with the policy ([section 3.10](#310-testing-the-policy)).
6. `pnpm check` says if the tool and its action do not match: a tool with no action, an action with no tool, a rule that is never named.

### Answer a general question from the knowledge base

For "what is the late fee", an answer a person approved, said word for word ([section 12](#12-the-knowledge-base) has each file):

1. `kb/`: `kb.yaml` (the resolving `action`, and `applies` if the answer depends on the caller), `topics.yaml` (the topic with its keywords and example questions), `sources/<doc>.yaml` (the document's text, by hand or from `pnpm kb:ingest`), and `passages/<id>.yaml` (the answer, its source section and its dates).
2. `pnpm kb:approve <id> --by "<your name>"`, after you have read the passage against its source. Only a person approves.
3. `slots.yaml`: a slot of `type: topic`. `forms.yaml`: a form with that slot, `summaryPromptId: null` and `answers: { slot: <the slot> }`. `intents.yaml`: a `kind: form` intent for it.
4. `app.ts`: the resolving tool, `kbAnswerTool({ facts })`, with the facts read from your records. `policy.yaml`: its action, and `topic: keep` under `audit`. `prompts.yaml`: `ask_<slot>`, `ask_<slot>_retry`, `disambiguate_<slot>`, `kb_answer` (`'{answer}'`) and `kb_unavailable`, in every locale; `app.yaml`: `answer` in `prompts.dataVars`.
5. Paraphrases in `fixtures/kb/paraphrases.yaml` and a recall test ([12.11](#1211-testing)); corpus lines labelled with the topic question.
6. `pnpm kb:index` if `kb.yaml` names an embedder, then `pnpm check`, then `pnpm verify`.

### Follow one scripted call turn by turn

The stub regression (`pnpm --filter @dialogwright/example-<name> regress`) prints one line per difference from the baseline, a `FAIL scenario <id>: <field>: expected ..., got ...` line for each scripted call that does not reach what it expects, and `no changes` when there is neither, then a summary (`corpus 129/129 outcomes match expected`, `scenarios 34/34 pass expectation, 34/34 match expected`). A `FAIL` line names only the field that differed. To see how the call got there, ask for its transcript:

```sh
pnpm --filter @dialogwright/example-<name> regress --scenario plan-by-phone
pnpm --filter @dialogwright/example-<name> regress --corpus pl-02 --scenario plan-keypad   # repeatable; both together
```

Each step of the call, what the caller said or keyed, then for each turn: the prompt id, the acknowledgements said before it, the words the caller hears, the form, the caller's level and the slots that hold a value after the turn, and every gate decision (the tool, its purpose, the verdict, the reason and the rule that decided). Keyed digits run one turn each; only the keys that said something or asked the gate are shown. Then what the call expects, `pass` or `FAIL ...`, and `baseline: no changes` or the differences from the baseline. A corpus line shows the state it is seeded in (the form, the question it answers, the caller's level and the seeded slots), then its one turn. For example, the last step of the testkit's `track-other-customers-parcel` (`pnpm --filter dialogwright regress:testkit --scenario track-other-customers-parcel`):

```
  4. keys 123456
       (6 keys, one turn each; 5 said nothing and are not shown)
       -> prompt anything_else
          acks   otp_verified, parcel_blocked_scope
          says   "Thank you, you're verified. I don't see that parcel on your account, and I can only share your own parcels. Is there anything else I can help with?"
          form   -   level 2   slots accountId=55501234, dob=1985-04-12
          gate   verifyCode ALLOW
          gate   listParcels ALLOW
          gate   getParcel BLOCK reason=scope; scope The record belongs to someone this caller may see: record owner ...5678 · caller may see ...1234 only
```

It runs the same turns as the whole regression, with the same client (`--client recorded` works too), and exits 1 when a call misses its expectation or an outcome differs from the baseline. It writes nothing; `--update` cannot be given with it.

Note what the last line above shows: once a form completes, the form and its own slots are cleared (the slots app.yaml lists under `carrySlots` excepted; the identity factors, which no form lists, stay on the call). A scripted call that ends after a completion can expect `promptId: anything_else`, the `gate` and the completion line's words (`text`), never `form` or the form's `slots`.

### Where to start

To build an app from a description (a paragraph of what callers can ask for, who must verify, what is confirmed), follow the create-app skill, [.claude/skills/create-app/SKILL.md](../.claude/skills/create-app/SKILL.md): it plans the app in a worksheet, maps it onto slot types, policy and identity, scaffolds it, and iterates on the checks until green. Its [patterns](../.claude/skills/create-app/patterns.md) and [corpus guide](../.claude/skills/create-app/corpus.md) are useful on their own.

Run `pnpm create-app <name>` (add `--identity` when callers must verify who they are). It writes `apps/<name>` from the template in `packages/dialogwright/templates/`: the five YAML files, `slots.yaml`, `identity.yaml` with `--identity`, `src/app.ts` with one stub tool over fixture data, a corpus and three scripted calls, the launchers, its tests, the policy read back (`policy.matrix`, `POLICY.md` and `APP-MAP.md`, written for the example, with the golden tests that compare them), a README with the recording steps, a `.env.example` and a short `CLAUDE.md`. It runs `pnpm install` so the workspace links the new app (`--no-install` skips that), and the result passes `pnpm check`, its type check, its tests and its stub regression as created. Replace the one example intent, form, slot and tool with your own and add more as above, running `pnpm check` after each change. The scaffold ships the example's stub baseline (`fixtures/expected`); make your own app's first baseline once with `regress --update`, review it in full, and never regenerate it after that.

To start from an existing app instead, copy the library fixture's folder (or the clinic's) into `apps/<name>`, give it a `package.json` and the launchers the clinic has (`src/index.ts`, `cli.ts`, `regress.ts`), change `id`, empty the intents, forms, prompts and policy down to the control intents and the engine's lines, and run `pnpm check` until it says `ok`.

## 12. The knowledge base

A knowledge base is for the questions callers ask that no form handles: when are you open, what happens if I return a book late, how do I renew my card. Its answers are short passages that people approved, chosen by what the caller means, and spoken word for word. No model writes them and none changes them: the model only picks which topic the caller asked about, and code finds the one approved passage for this caller and this day.

This section is the whole of it, in the order you meet it: the folder, how a call uses it, the three places an answer is said from, approval and staleness, building one from documents, tuning retrieval, testing and what is recorded. The examples are one small knowledge base, Example Town Library's, whose files are the ones the engine's own tests build. [The topic slot's page](slots/topic.md) has the question the model is asked.

### 12.1 The folder

An app with a knowledge base has a `kb/` folder beside its other files. Only `kb.yaml` and `topics.yaml` are required.

```
kb/
  kb.yaml                       the settings: the gated action that resolves a passage, the facts a passage may depend on, retrieval
  topics.yaml                   what callers ask about: a title, keywords and example questions each, and an optional line from the caller's own data
  passages/<id>.yaml            one approved answer each, in the app's default language
  sources/<doc>.yaml            the documents the answers come from, by section: what an approval is held to
  locale/<tag>/topics.yaml      a language's titles, keywords and example questions
  locale/<tag>/passages/        a language's passages, usually translations
  pending/<id>.yaml             drafts waiting for a person: never read at run time, never said
  pending/topics.yaml           topics the drafts propose
  rejected/<id>.yaml            drafts a person turned down, with who, when and why
  approvals.jsonl               every approval, one line each, appended and never rewritten
  .index/<embedder>.json        the vectors of the topics' texts, for retrieval by meaning (optional; commit it)
```

Every file has a JSON Schema (`kb-settings`, `kb-topics`, `kb-locale-topics`, `kb-passage`, `kb-source`, `kb-pending`), named on its first line like the app's other files (the examples below show the file's path there instead). A file that is not in this list is a problem, so a mistyped folder name does not go unnoticed. `pnpm check` reads all of it, and so does `defineApp`.

**kb.yaml** says how the knowledge base is read, never what it says:

```yaml
# kb/kb.yaml
action: findPassage        # the gated tool that resolves a passage for a caller (a tool with an action in policy.yaml)
applies:                   # the facts a passage may depend on, each with every value it can take
  card: [adult, junior]
localeFallback: none       # a missing translation is "unavailable" (none), or the default language's passage (default)
maxAnswerChars: 400        # an answer is spoken, so it is short (40 to 2000; default 400)
retrieval:
  cap: 8                   # the most topics a turn offers the model (default 8)
```

`applies` is the one thing that makes passages differ by caller. A fact is a name and the values it can take; every topic needs a passage in force for every combination, and `pnpm check` lists a combination that has none. An app whose answers are the same for everyone leaves it out. The retrieval settings are in [12.10](#1210-retrieval-settings).

**topics.yaml** names what callers ask about. Retrieval reads each topic's title, keywords and example questions; the topic question offers the title.

```yaml
# kb/topics.yaml
opening_hours:
  title: Opening hours
  keywords: [opening hours, open, closed, hours]
  asks:
    - When are you open?
    - Are you open on Sunday?
  risk: low
late_fees:
  title: Late fees
  keywords: [late fee, overdue, fine]
  asks:
    - How much is the fee for a late book?
  accountLine:
    text: Your card has {balance} in late fees right now.
    from: getFees
```

`keywords` are words and phrases that name the topic exactly (a plan name, a code); a keyword said whole counts for more. `asks` are example questions in a caller's own words. `risk` is `regulated` (the default: only an approved passage is ever said) or `low`, which marks content a later release may let an app answer in generated wording, grounded in approved passages; nothing reads it yet. `accountLine` is explained in [12.5](#125-answers-through-the-gate).

**A source** is a document's text by section. An approval is held to the section's text, so a changed word makes the passages drawn from it stale. You can write one by hand, or have `pnpm kb:ingest` read it from the document ([12.9](#129-building-one-from-documents)).

```yaml
# kb/sources/patron-guide.yaml
document: Example Town Library Patron Guide
provenance:
  file: patron-guide.pdf
  retrieved: 2025-12-01
sections:
  "1.1":
    heading: Opening hours
    text: >-
      All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m.
      to 4 p.m. All branches are closed on Sunday.
  "3.1":
    heading: Late fees on adult cards
    text: An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.
  "3.2":
    heading: Late fees on junior cards
    text: Junior cards are not charged late fees.
```

**A passage** is one approved answer: the topic it answers, who it answers (`applies`), the days it is in force, the source section it is drawn from, the answer, and its approval.

```yaml
# kb/passages/late-fees-junior.yaml
id: late-fees-junior
topic: late_fees
version: "2026.1"
applies: { card: junior }
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 18345c1533866b482125f9f1f66d537d51741e4c0fce296322696bf920018b6a
  hash: 7ae3662c77942ba368eecc8588b3ccaa2162791ab32880af189ed7331b648d0c
```

- `id` is the file's name. `version` is the passage's own ("2026.1") and is recorded with every answer.
- `applies` gives, for each fact of kb.yaml, a value or a list of values; a fact left out means any value. A topic's passages must not overlap: no two may be in force for the same caller on the same day, and `check` refuses a pair that would.
- `effective` is a range of days, both ends inclusive; no `to` means open-ended. A change in the tariff is a second passage that starts the day after the first one's `to`, so the history stays in the repository and a caller always hears the one in force today.
- `answer` is fixed text: no `{variable}`, no braces at all, no more than `maxAnswerChars`. It is said exactly as written, so write it to be heard: numbers as people say them, no abbreviations.
- `approval` is written by `pnpm kb:approve`, never by hand ([12.8](#128-approval-staleness-and-withholding)).

The second adult passage, `late-fees-adult`, differs only in `applies: { card: adult }`, its source section and its words. Last year's rate would keep its own passage, ending with `effective: { from: 2025-01-01, to: 2025-12-31 }`.

```yaml
# kb/passages/late-fees-adult.yaml
id: late-fees-adult
topic: late_fees
version: "2026.1"
applies: { card: adult }
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "3.1" }
answer: Late books on an adult card cost 25 cents a day, up to 5 dollars a book.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: a3502dd02204f66615d5227dfafdb55a5b53572022c5982f1c5e53036ee9b850
  hash: d5c58a4130fba40b914fd022093868d7f475c0744ed54c7d59cd32c244fa4f6a
```

```yaml
# kb/passages/opening-hours.yaml
id: opening-hours
topic: opening_hours
version: "2026.1"
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "1.1" }
answer: We're open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We're closed on Sunday.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c
  hash: 13ef68b619cf02e9f86cb3776a57ca009833408d65ae9f1b92f4ed29bd74f278
```

**A locale** has its own topic wording and its own passages, under `locale/<tag>/`:

```yaml
# kb/locale/es/topics.yaml
opening_hours:
  title: Horario
  keywords: [horario, abierto, cerrado]
  asks:
    - ¿A qué hora abren?
late_fees:
  title: Multas por retraso
  keywords: [multa, retraso]
  accountLine:
    text: Su tarjeta tiene {balance} en multas ahora mismo.
```

```yaml
# kb/locale/es/passages/opening-hours-es.yaml
id: opening-hours-es
topic: opening_hours
version: "2026.1"
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "1.1" }
answer: Abrimos de lunes a viernes de 9 de la mañana a 8 de la noche, y los sábados de 10 a 4. Los domingos cerramos.
translates: opening-hours
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c
  hash: 3edab6d60c3d2d0b862cfc8ef162274878ca1e2fd1bb5312e47523fce7602ba8
```

More in [12.7](#127-locales-and-fallback).

**A draft** is a passage waiting for a person. It has no `approval`, and says where it came from, with the words of the source it was drawn from:

```yaml
# kb/pending/late-fees-junior-2025.yaml: a draft, never said
id: late-fees-junior-2025
topic: late_fees
version: "2025.1"
applies: { card: junior }
effective: { from: 2025-01-01, to: 2025-12-31 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
drafted:
  by: kb:draft
  on: 2026-10-02
  excerpt: Junior cards are not charged late fees.
```

`pending/topics.yaml` is a `topics.yaml`-shaped file of the topics the drafts propose. Nothing in `pending/` is read when a call runs.

**A rejected draft** is the draft as it was, with who turned it down and why, kept in the repository so the same draft is not proposed again:

```yaml
# kb/rejected/late-fees-junior-2025.yaml: a draft a person turned down
id: late-fees-junior-2025
topic: late_fees
version: "2025.1"
applies: { card: junior }
effective: { from: 2025-01-01, to: 2025-12-31 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
drafted:
  by: kb:draft
  on: 2026-10-02
  excerpt: Junior cards are not charged late fees.
rejected:
  by: Branch Manager
  on: 2026-10-03
  reason: The 2025 fee schedule is out of date; the 2026 passage says it.
```

**The approvals log** has one JSON line for each approval, written by `pnpm kb:approve` and only ever appended to. It keeps the source section's text as it was approved (`sourceText`), so a later review can show what changed in it:

```jsonl
{"id":"opening-hours","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c","hash":"13ef68b619cf02e9f86cb3776a57ca009833408d65ae9f1b92f4ed29bd74f278","from":"pending","sourceText":"All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday."}
```

### 12.2 How a call uses it

Four steps, and only the second is a model's: nominate, select, resolve, speak.

1. **Nominate.** Before a turn is planned, the engine runs the app's retriever once on what the caller said, in their language and for today, and gets back up to `cap` topics, best first, each with a score and how it was found (`keyword`, `dense` or `app`). This is the turn's one asynchronous step, since the questions are built before the model is asked.
2. **Select.** The topic slot asks the model one question over those topics and "none": which does the caller ask about? The model answers with a probability for each. Code reads them: a topic is chosen when it reaches the threshold, two that cannot be told apart make the slot ask which one was meant, and "none" or a weak answer chooses nothing.
3. **Resolve.** The form's completion reads the answer through the gate, with the topic and, where the policy says whose record it is, the caller's id. The tool finds the one passage in force: for this topic, for this caller's facts, on today's date, in the call's language, approved and not stale.
4. **Speak.** The passage's answer is said word for word through the `kb_answer` line, followed by the topic's account line when it has one and the caller's own data allows it. When there is no passage to say, the caller hears the `kb_unavailable` line and is offered a person, once per call.

**When retrieval runs.** Only on a turn where all of these hold: the app has a knowledge base, the turn has the caller's words (speech or text, not after the call has ended or while a downstream service's answer is awaited), and a topic slot is among the slots the turn asks. A turn that is none of these is exactly the turn it was without a knowledge base: no retrieval, no extra question, the same request to the model. An app with no `kb/` folder is unchanged byte for byte.

**When the topics are asked.** Only when retrieval nominated something. Nominating is the cheap, fast check that a knowledge question is plausible, so a call that never asks one never pays for the question. A turn on which nothing was nominated asks nothing, and the slot has no value.

**The budget.** The caller waits on retrieval, so it has 150 milliseconds (`RETRIEVE_BUDGET_MS`, fixed: it is a latency budget, not a threshold you tune). It fails open. A retriever that throws, returns something that is not a list of topics, or is not back in time nominates nothing, the turn goes on without a knowledge question, and the trace says which it was (`failed: 'error' | 'invalid' | 'late'`). The engine's own retrievers answer in well under a millisecond, so the budget is there for a retriever of your own that calls out.

**Determinism.** The same words, language, day and knowledge base nominate the same topics in the same order with the same scores, on any machine. The nominations shape the model's request, so this is what lets a recorded call replay exactly.

### 12.3 The topic slot

A form that answers from the knowledge base has one `topic` slot. Its value is a topic's id, which is how the completion finds the passage; it never holds an answer.

```yaml
# slots.yaml
subject:
  type: topic
  cap: 4
```

The slot opts in to retrieval, so naming it is what makes a turn retrieve. It asks one choice question over the nominated topics (`subjectTopic`, with each topic's id as a label and `none`), fills when the model's probability for a topic reaches `SLOT_CHOICE_FILL`, and asks "Do you mean {a} or {b}?" when the top two are within `KB_TOPIC_MARGIN` of each other. It says a topic by its title, in the call's language where the knowledge gives one. Its options (`cap`, `accept`, `disambiguate`, `fillAt`, the question's words) and its outcomes are on [its page](slots/topic.md). `pnpm check` refuses a topic slot in an app with no `kb/`, since it would never ask.

When a caller's words name a task the engine confirms first ("can I park there with my pass?", then "yes"), the topic is read from the topics nominated for the words that named the task, not from the "yes".

### 12.4 Lines the answers are said through

Three lines in `prompts.yaml` (and in every locale), plus the slot's own:

```yaml
# prompts.yaml
prompts:
  ask_subject:
    text: What would you like to know?
    interruptible: true
  ask_subject_retry:
    text: Sorry, what would you like to know about the library?
    interruptible: true
  disambiguate_subject:
    text: Is that about {a}, or {b}?
    interruptible: true
  kb_answer:
    text: '{answer}'
    interruptible: false
  kb_unavailable:
    text: I'm sorry, I don't have an answer to that I can give you right now.
    interruptible: false
```

`kb_answer` says `{answer}` and nothing else: the passage's text, then the account line after a space. `answer` must be among `app.yaml`'s `prompts.dataVars`, because a line that carries a passage is spoken whole. `kb_unavailable` has no variable. A form may name its own two lines (`answers: { answer, unavailable }`).

### 12.5 Answers through the gate

A form that answers says so in `forms.yaml`, and its completion is the engine's, so it has no `complete` hook in code:

```yaml
# forms.yaml
forms:
  ask_library:
    slots: [subject]
    summaryPromptId: null
    answers: { slot: subject }
```

`answers` takes `slot` (the form's topic slot), and optionally `via` (the resolving action, default kb.yaml's `action`), `answer` and `unavailable` (the two lines). The intent is an ordinary form intent:

```yaml
# intents.yaml
intents:
  ask_library:
    criteria: Asks a question about the library, its cards or its fees
    label: answer a question
    kind: form
```

**The resolving tool.** The action kb.yaml names is a tool in the app's code with an action in `policy.yaml`, like any other: the gate decides whether it may run, and the rules you give it (`identity`, `scope`, ...) apply as to any read. The engine ships the tool for an app with a `kb/` folder:

```ts
// src/app.ts, in code.tools
findPassage: kbAnswerTool({
  facts: (_params, sys) => {
    const kind = (sys as LibrarySystems).cardKind; // read from the library's records, never from what the caller said
    return kind === null ? null : { card: kind };
  },
}),
```

and its action in `policy.yaml`, with its `topic` param declared under `audit:` like every param that is not a slot:

```yaml
# policy.yaml
actions:
  findPassage:
    level: 0
    rules: [identity]
audit:
  topic: keep
```

- **The facts are read by code.** `facts(params, systems, turn)` returns the caller's value for each fact kb.yaml's `applies` names, read from the system of record. They are never taken from what the caller said, since a caller who says "I have a junior card" does not get the junior answer. It returns null when there is no record to read them from (no passage: `no-facts`). Without `facts`, only a passage that applies to every caller answers.
- **The params** are `topic` and, when the answer is a subject's (the action's `scope` rule names a param), that param first: `kbAnswerTool({ subject: 'cardNumber', facts })`. The completion fills it with the subject's id from the session, where the scope rule names one.
- **When there is no answer** the tool says why: `unknown-topic`, `not-in-force`, `no-translation`, `ambiguous`, `stale` (with the withheld passage's record), or `no-facts`. Whatever the reason, the caller hears the `kb_unavailable` line and is offered a person. A refusal by the gate is the engine's usual one.
- **An app that resolves answers in its own code** gives a tool of its own that returns the same shape (`{ answer, source }` or `{ unavailable }`, with `source` the knowledge record `kbSourceOf` builds). A `complete` hook may also delegate: `complete: kbCompletion({ slot: 'subject' })`.

**Account lines.** A topic may add a line from the caller's own data after the approved answer: "Your card has 2 dollars in late fees right now." It is `accountLine` in topics.yaml (and each locale's wording): its `text` has `{variables}`, and `from` is a second gated tool that reads the caller's data. That tool is an ordinary read with its own action in `policy.yaml`, declaring the `fields` its result has (`ToolDef.fields`), and every variable of the line must be one of them. The line is said only when the read is allowed and has a value for every variable; a refused read, a record with nothing in it, or a missing field leaves the line out and the answer is said alone. A line is never said with a gap in it. The approved answer is the same either way, and the account line's text is part of what an approval covers.

### 12.6 Informational passages

For an answer that is the same for everyone and needs no question, an informational intent can name a passage instead of a prompt:

```yaml
# intents.yaml
intents:
  hours:
    criteria: Asks when the library is open
    label: hear the opening hours
    kind: informational
    passage: opening-hours
```

There is no retrieval and no gate: the passage in force today for that passage's topic, in the call's language, is said through `kb_answer`. It keeps what the knowledge base adds to a fixed line: approval, staleness, effective dates and a variant for each language. Because there is no gate and so no facts about the caller, no passage of its topic may apply to some callers only (`check` says which); use a form that answers for that. An intent names the passage of the default language, and a call in another language hears its translation. It may also be a key on the keypad menu. When it cannot be said (not in force, stale, no translation), the caller hears `kb_unavailable` and is offered a person once per call; declining returns them to the question they were on.

### 12.7 Locales and fallback

A language has its own wording for each topic (`kb/locale/<tag>/topics.yaml`: title, keywords, example questions and account line text, for the topics it words) and its own passages (`kb/locale/<tag>/passages/`, each with `translates:` naming the default language's passage of the same topic). The tag is one the app speaks, with a `locale/<tag>/prompts.yaml` ([section 8](#8-locales)), and the examples in [12.1](#121-the-folder) are a Spanish pair.

- A call hears the passages of the language the session chose, and retrieval reads a topic's wording in that language, falling back to the default's wording for a topic that has none.
- **Fallback** is kb.yaml's `localeFallback`. `none` (the default) says nothing when a topic has no passage in the caller's language: the answer is unavailable and a person is offered. That fails closed, which is right for regulated text, since a translation is something a person approved. `default` speaks the default language's passage instead. Choose it only where hearing the other language is acceptable.
- A translation is approved like any other passage, against the same source section, and goes stale the same way: changing the section withholds the default and every translation until each is approved again.
- Questions to the model are never translated: the topic question's labels are topic ids and its instructions are in English, as for every slot.

### 12.8 Approval, staleness and withholding

A passage is said only while it is approved and nothing it was approved over has changed. Its `approval` records the content's owner (a team), the person who approved it, the day, and two hashes: `sourceHash`, of its source section's text, and `hash`, of everything approved (the topic, the answer, `applies`, the effective dates, the source text and the topic's account line). Whitespace aside, any change to one of them makes the passage **stale**. At run time a stale passage is **withheld**: the caller hears the unavailable line and is offered a person once, and the trace records the passage with `fresh: false`. `pnpm check` fails on a passage that is stale or was never approved, and its fix names the two commands below.

- `pnpm kb:status [app folder]` lists the passages by state: approved and fresh; stale because the source section changed; stale because the passage was edited (`git diff` shows the edit); never approved; and the drafts in `kb/pending/`. Each comes with its fix.
- `pnpm kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>]` approves each passage as it is now, after a person has read it against its source. It writes the `approval` in place, keeping the file's comments and layout, and appends one line to `kb/approvals.jsonl` (`id`, `version`, `approvedBy`, `owner`, `on`, both hashes, `from`: `passage` or `pending`, and `sourceText`). `--owner` is needed the first time; a re-approval keeps the owner unless `--owner` says otherwise.
- A draft is approved by id too: `kb:approve` checks it as the passage it would be and moves it into `kb/passages/` (or `kb/locale/<tag>/passages/`), dropping `drafted`.
- `kb:approve` writes nothing for an id it refuses. It refuses an id that is no passage or draft, a passage that would fail `pnpm check` for anything but its approval (an unknown topic or source, a variable in the answer, an overlap with another passage, a locale the app does not speak), a draft whose excerpt is not in its section word for word, and a `--by` that names no person. **An assistant or a tool may draft a passage, and only a person approves one.**
- An app moving approved content from an earlier format may carry its approvals over with a script of its own: one line per passage with `from: migration`, the original `approvedBy`, `owner` and `on`, the hashes taken under this format, and a `note` ("content unchanged; migrated from ..."). `kb:status` marks those passages `(migrated: ...)` for as long as they stand on that approval, and the people who own the content confirm the migration in review.

The files an approval stands on are the ones `CODEOWNERS` should protect ([3.12](#312-who-reviews-it-codeowners)): the passages, their sources, the topics, `kb.yaml` and the approvals log. Drafts are left open, since a draft is never said and approving it changes `kb/passages/`.

### 12.9 Building one from documents

Answers scale only if they are cheap to make, so the knowledge base has an authoring pipeline, in its own package (`@dialogwright/kb-author`, which an app never imports and the engine does not depend on). It never runs on a call. Every step before the last is a proposal, and the last is a person:

```sh
pnpm kb:ingest docs/ --dir apps/my-app                                  # 1. documents or a website into kb/sources
pnpm kb:draft apps/my-app                                                # 2. a model drafts passages into kb/pending
pnpm kb:review apps/my-app                                               # 3. a person approves, edits or rejects each draft
pnpm kb:approve <id...> --by "<your name>"                               #    (the same approval, from the command line)
pnpm kb:refresh apps/my-app                                              # 4. read the sources again; withhold what changed
pnpm kb:gaps apps/my-app [--traces traces/*.jsonl] [--since 2026-10-01]  # 5. what callers asked that nothing answered
```

**Ingest.** `kb:ingest <folder | file | url> --dir <app folder>` reads PDF, DOCX, HTML, Markdown and text files, or a website to a link depth (`--depth`, default 1; `--include '/help/**'` narrows it), and writes each document as `kb/sources/<doc>.yaml`: its title, its provenance (its URL, or its file's path from the app folder, and the day it was read) and its text by section. Sections are cut at headings (h1 to h3, a DOCX's Heading 1 to 3, Markdown's `#` to `###`, a PDF's larger type) and named by the heading path (`late-fees`, `shifts/training`); a PDF's section records the page it starts on (`page`, `lastPage`), and a PDF without headings is cut by page. A website is crawled politely: the start page's host only (unless `--allow-host`), robots.txt followed, one request a second (`--rate`), at most 50 pages (`--max-pages`), no cookies or sign-ins; linked PDF and DOCX files are read too. It reads only public addresses: a host on a loopback, private, link-local or other non-public network is refused (each host resolved before each request, and the connection pinned to the address checked), unless `--allow-private` names a site on your own network. Re-ingesting is safe: the same documents give the same bytes, an unchanged document is not rewritten, and each run says per section what was added (`+`), changed (`~`) and removed (`-`). `--dry-run` shows it without writing. A source written by hand is never overwritten. Crawling is for you to run; it never runs in CI.

**Draft.** `kb:draft` gives each source's sections that nothing cites yet (no passage, draft or rejected draft; `--all` for every section) to a drafter: by default Claude through the Messages API, with **your own** `ANTHROPIC_API_KEY`, from the environment or from a `.env` file where you run it (the file is git-ignored; never commit a key, and never put one in CI, a test or a fixture). The default model is `claude-haiku-4-5`; `--model` takes another, and `--topic-hint "<what to cover>"` steers it. It proposes, for each answer a document supports, a topic (one `topics.yaml` has, or a new one with a title, keywords and example questions), a spoken answer of one or two sentences, and the exact words of the section that support it. Every draft is checked before it is written, and a draft that fails is reported with its reasons and never written:

| Check | Why |
|---|---|
| the excerpt is in the section word for word | the answer is held to what the document says |
| the answer is within `maxAnswerChars` and has no brace | a spoken answer is short, and is fixed text |
| the topic is one that exists, or a new one proposed with a title | a draft cannot name a topic out of the air |
| `applies` and dates are ones kb.yaml allows | the passage can be resolved |
| it does not repeat another passage's or draft's answer | no near-duplicates |

A draft that passes is `kb/pending/<id>.yaml`, and a new topic goes to `kb/pending/topics.yaml`, never to `topics.yaml`. Drafting is pluggable (a `Drafter` is `{ id, draft(request) }`; the tests use a fake), **never runs in CI** (`kb:draft` refuses when `CI` is set), and nothing pending is ever said. A model can be wrong; the excerpt check proves the answer cites the document, not that it says what the document means, which is what the person reviewing is for.

**Review.** `kb:review` starts a small server on 127.0.0.1 on a free port (`--port` for a fixed one) and prints its URL with a one-time token that every request needs. It answers only this machine and stops with Ctrl-C. It is not the operator console, which has no access control until Phase 8, and whose tunnel carries the public's requests. The page lists the proposed topics, the drafts and the passages withheld (stale or edited), each beside its source section with the excerpt marked, and, for a source that changed, a word diff of the section as it was approved (read from `kb/approvals.jsonl`) against the section now. It asks each browser once for your name and your team (kept in a signed, HttpOnly session cookie, so another browser is another reviewer), then you can: approve (it is `kb:approve` itself); edit, then approve (the answer, `applies`, the dates and a draft's excerpt, checked as a draft is); reject (the draft moves to `kb/rejected/<id>.yaml` with who, when and why); and for a proposed topic, accept it into `topics.yaml` (under another id if you rename it; its drafts follow) or merge it into a topic the knowledge base has. A draft of a proposed topic is approved after its topic. Every change carries a hash of what its page showed, and is refused when the file or its source section changed since it was opened (reload and review it again). Every page reads without JavaScript, and every field has a label. After accepting topics in an app with an embedder, run `pnpm kb:index`.

**Refresh.** `kb:refresh` reads every source again from its provenance (the file, or the crawl with the settings it had) and writes those that changed, nothing else. It reads a file only inside the app folder (a `../`, absolute or linked path out of it is refused), reads a URL only through the crawler's public-address check (`--allow-private` for your own network), and prints the hosts it will ask before it asks them. It lists the passages now withheld because their section changed (review them in `kb:review`), those whose section is gone (point them at the section that says it now, or delete them), and the sections nothing cites, to draft from with `kb:draft --source <doc>`. A source written by hand, or whose file is gone, is left alone and listed.

**Gaps.** `kb:gaps` reads the traces of real calls (`--traces`: a file, a folder or a glob; by default `$TRACE_DIR`, else the app's `traces/`, else `./traces`) and ranks what callers asked that the knowledge base did not answer: a topic question answered `none`; words that look like a question with no topic nominated; a passage that could not be said (stale, not in force, no translation, no facts); and a close call between two topics. They are grouped by the nearest topic and ranked, each group with a few of the callers' words and the fix for each kind it holds: write a passage, draft from a source section nothing cites, re-approve the stale passage, add a translation, add keywords or asks to the topic. The words are the traces' own, so keep a report as private as the traces; a turn on which an identity value was masked is counted but its words are not shown. The review page has the same list as its Gaps tab.

[The package's README](../packages/kb-author/README.md) has the extraction, crawling, drafting and review rules in full.

### 12.10 Retrieval settings

Unless the app's code gives a retriever of its own (`code.knowledge.retriever`, an object with an `id` and `nominate({ text, locale, todayIso })` that returns `{ topic, title, score, via }` entries, deterministic and quick), the engine's is used, set in kb.yaml:

```yaml
# kb/kb.yaml, with an embedder
action: findPassage
applies:
  card: [adult, junior]
retrieval:
  cap: 8                    # the most topics a turn offers (default 8)
  embedder: potion-base-8M  # optional: also find topics by meaning, not only by their words
  floor: 0.3                # optional: the similarity below which a topic found by meaning is not offered
```

- **Without `embedder`**, topics are found by their words alone: BM25 over each topic's title, keywords and example questions, with a boost for a keyword said whole. Accents and common endings are folded, and greetings and question words are ignored.
- **With `embedder`**, the same keyword search runs beside a dense one, and the two rankings are merged by reciprocal rank fusion. A topic found by meaning counts only at `floor` or above (default: the model's own); a keyword match always counts. The model is potion-base-8M, a static model run in TypeScript: about a hundredth of a millisecond per question, and the same numbers on every machine, so a recorded call replays exactly.
- **The index.** Every topic's vectors are in `kb/.index/<embedder>.json`, which you commit. Write it with `pnpm kb:index [app folder]` after any change to `topics.yaml` or a locale's wording; it embeds only the texts that changed, and gives the same bytes for the same topics. `pnpm check` reports a topic whose texts the index no longer matches, with the fix.
- **The model.** The weights are not in the repository: `pnpm kb:model` downloads them once, at a pinned revision, checks each file's SHA-256, and keeps them in `~/.cache/dialogwright/models` (or `$DIALOGWRIGHT_MODEL_DIR`). `kb:index` downloads them when they are missing. A call never downloads anything: an app whose weights are not in the cache retrieves by keywords alone, and the trace's `retrieverId` says so (`keyword` rather than `hybrid:potion-base-8M`).
- **Choose `cap` and `floor` offline, never by re-recording calls.** They change what the model is asked, which re-keys a recording. Write a paraphrase set ([12.11](#1211-testing)) and run `pnpm kb:bakeoff <app folder> --paraphrases fixtures/kb/paraphrases.yaml --sweep`. It reports each retriever's recall at the cap (the share of a topic's paraphrases whose nominations include it), how many topics it offers per question (and per question about nothing), and its speed; the sweep then shows recall against candidates for every floor and cap, so a floor is picked by what it costs.
- **ONNX.** A larger model (bge-small, through the optional `@huggingface/transformers`) is available to code as `OnnxEmbedder` from `dialogwright/kb/onnx`, used with `HybridRetriever`, and the bake-off includes it when the package is installed. It is not the default: it is a large native install, and its numbers can differ in the last bits between machines.

An app that keeps a retriever of its own and later moves to the engine's hybrid one changes the topics some turns offer, so it re-records the calls those turns are in. Plan that as a deliberate step.

### 12.11 Testing

- **Paraphrase sets.** `fixtures/kb/paraphrases.yaml` maps each topic id to things callers say about it in words other than its own title, keywords and example questions, and `none:` to things no topic answers:

  ```yaml
  # fixtures/kb/paraphrases.yaml
  opening_hours:
    - What time do you close tonight?
    - Is the library open on Saturday mornings?
  late_fees:
    - I returned a book late, what do I owe?
    - How much do you charge for overdue DVDs?
  none:
    - Where do I park?
    - I would like to speak to a librarian.
  ```

  Collect them from real wording, from the people who answer the phones, and from `kb:gaps`, and write at least eight for each topic. `pnpm kb:bakeoff` reads the file, and an id that is not a topic is an error.
- **The recall test.** A test of the app's own that holds retrieval to its paraphrases, so a change to a topic's wording or a retriever's settings that loses recall fails in CI instead of on a call:

  ```ts
  // src/kb.test.ts
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { expect, it } from 'vitest';
  import { bakeoff, defaultRetriever, loadKnowledgeFolder, parseParaphrases } from 'dialogwright';

  const APP = fileURLToPath(new URL('..', import.meta.url));

  it('nominates the right topic for what callers say', async () => {
    const kb = loadKnowledgeFolder(`${APP}kb`).kb!;
    const paraphrases = parseParaphrases(readFileSync(`${APP}fixtures/kb/paraphrases.yaml`, 'utf8'), kb);
    const result = await bakeoff(defaultRetriever(kb).retriever, paraphrases, 'en-US', '2026-10-03');
    expect(result.recall).toBeGreaterThanOrEqual(0.9); // the floor you chose from the sweep
    expect(result.noneCandidates).toBeLessThanOrEqual(2); // few topics offered for questions about nothing
  });
  ```

- **Goldens.** Write each retriever's nominations for every paraphrase to a file you commit and compare it in a test, as the engine does for its own fixture. A change to a keyword or a floor then shows as a diff of what is offered, to read and accept. Write it deliberately, never to make a test pass.
- **Turns.** To test a form that answers, `fixedRetriever` from `'dialogwright/testing'` nominates exactly what a test says for given words, and a call's answers are written out as for any slot ([the corpus guide](../.claude/skills/create-app/corpus.md) labels the topic question). The stub regression runs the app's real retriever, so a corpus line about a topic exercises nomination, selection, resolution and speaking against the baseline.
- **State.** `pnpm check` is the test of the knowledge base itself: every passage approved with matching hashes, a passage in force for every topic and every combination of facts, no overlaps, every link to the app, the index current.

### 12.12 What is recorded

- **The trace** has `retrieval` on each turn retrieval ran: the retriever's id (`hybrid:potion-base-8M`, `keyword`, or your own), the SHA-256 of the index it read, the topics it nominated each with score and `via`, and `failed` (with `message` for an error) when it nominated nothing because it did not answer as asked. The turn's timing has `retrieveMs`.
- **The knowledge record** is on the turn that answered (`kb` in the trace, `TurnOut.kb`) and on the console's source card: the passage, its version, the facts it answered for (`applies`, only those it depends on), its language, the source document and section, the days it is in force, who approved it and when, the first 12 hex characters of both hashes, and `fresh`. A passage that was withheld has its record with `fresh: false`. It is never part of what the model is asked.
- **The audit** has a `kb_answer` row for each answer: the passage's id, its version, whether it was fresh, its language and the short hashes. It holds nothing of the caller's.
- **The configuration hashes** include every file of `kb/` that is read (kb.yaml, topics, passages, sources and the locale files), so a call is tied to the exact knowledge it ran under. Drafts, rejected drafts, the approvals log and the index are not in them; the index's own hash is in the retrieval record.

# Authoring an app

This guide is for a developer, or an AI coding assistant, who is building a DialogWright app or changing one. It says what an app is made of, what goes in each file, how policy and identity are written, tested and reviewed, what stays in TypeScript and why, how to write a slot, how `pnpm check` finds mistakes, how locales and configuration hashes work, how an app answers general questions from a knowledge base of approved passages, how it is served on the phone and the web (carriers, languages, web chat, sign-in and the widget), and how it runs on a machine you own (the first hour with two keys, then a machine that stays on, survives its own restart and lets its owner look at calls from a phone). Read [CLAUDE.md](../CLAUDE.md) first for the rules (the gate decides, a model never writes a regulated line, an app imports only from `'dialogwright'`).

Two apps in this repository are the examples, and the snippets below are copied from them, except where a snippet says it is only an illustration:

- `apps/clinic`: Example Family Practice, a fictional appointment line. Five forms, no identity verification, scheduling hooks. Its README has a section, "The app as a folder", with more detail.
- `packages/dialogwright/src/define/fixture/`: Example Town Library, a tiny app (three forms, one rule of its own, a Spanish locale) that the engine's own tests build. It is the smallest complete app, so the snippets here come mostly from it. Section 3 also draws on the engine's own test app, Example Parcels, which has the full identity ladder and delegates.

## Contents

The guide is long, too long to read in one go: read it a section at a time, from the list below. Building an app with the [create-app skill](../.claude/skills/create-app/SKILL.md), read only the sections each of its steps names. `grep -n '^##' docs/authoring-an-app.md` lists every heading with its line.

1. [The folder](#1-the-folder)
2. [The files, one by one](#2-the-files-one-by-one): [app.yaml](#appyaml) (with [`callerNumber`](#the-number-the-caller-is-calling-from-callernumber)), [intents.yaml](#intentsyaml) (with [`unsure`](#when-the-model-is-unsure-unsure) and [`priority`](#must-never-wait-priority)), [forms.yaml](#formsyaml) (with [checks](#checks-ending-a-form-part-way)), [prompts.yaml](#promptsyaml), [policy.yaml](#policyyaml), [identity.yaml](#identityyaml-optional), [slots.yaml](#slotsyaml-optional), [fixtures/](#fixtures-optional), [kb/](#kb-optional)
3. [Policy and identity](#3-policy-and-identity) (its own list of thirteen subsections is at its head)
4. [What stays in TypeScript, and why](#4-what-stays-in-typescript-and-why)
5. [Writing a slot](#5-writing-a-slot): [Pick a type](#pick-a-type-in-slotsyaml), [Every slot listens on every turn](#every-slot-listens-on-every-turn), [Where a slot listens](#where-a-slot-listens-listen), [A callback number](#a-callback-number-callernumber), [A text offer](#a-text-offer-onno-and-ifnone), [Thresholds](#thresholds), [When no type fits](#when-no-type-fits-a-slot-in-code), [The contract](#the-contract), [The keypad](#the-keypad), [Sensitive values](#sensitive-values), [Testing a slot](#testing-a-slot)
6. [The form hooks](#6-the-form-hooks)
7. [Checking an app: `pnpm check`](#7-checking-an-app-pnpm-check)
8. [Locales](#8-locales)
9. [Configuration hashes](#9-configuration-hashes)
10. [Editor support](#10-editor-support)
11. [Walkthroughs](#11-walkthroughs)
12. [The knowledge base](#12-the-knowledge-base)
13. [Channels](#13-channels)
14. [Running it](#14-running-it)

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
- `voice` holds the phone line's speech settings: words the recognizer should expect, and how digits that are identifiers are spelled for text to speech. An app can also say, per locale, which voice and recognizer each carrier uses and which hints it hears, and which number a call starts in which locale (`voice.locales`, `voice.numbers`): see [13.3](#133-languages-on-the-phone). How long an interrupt may come after the agent starts a reply and still be the caller who had not finished (`voice.continueWithinMs`, default 300), and the words the voice says wrong with the respelling it is sent (`voice.pronounce`): see [13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said).
- `wording` is the engine's own questions to the decision model, in the app's words (whom the caller is addressing, what counts as a hedge). Every string is sent to the model as written.
- `handoff` is the handoff: the note's words about the app's domain (who it is for, the identity line by level, refusals and reasons in words), and `data`, what a transfer hands the channel of the slots the call collected. On a phone call that is the relay's `end` frame, which the carrier (Twilio, Telnyx) holds and posts back on its action callback, so it leaves the engine; a chat's transfer sends its reason only, never a collected value. The default keeps verification factors off the carrier: an identity factor slot (identity.yaml) is left out, a slot with a `redact` setting goes masked as the trace masks it (`...1234`, `••/••/1980`, a statement's stand-in), and any other slot goes as it is. `data.slots` says which go (`all`, the default; `none`; or a list), and `data.send` says, by slot, how one goes in place of its default: `omit`, `masked` or `as-is`. An app whose human desk needs a value in the clear names it:

  ```yaml
  handoff:
    data:
      slots: [accountId, missingNote]   # only these go
      send:
        accountId: masked               # a factor, sent by its last four rather than left out
  ```

  `pnpm check` refuses a slot that is not one, a slot listed twice, a listed identity factor with no `send` (it would still be left out), a `send` for a slot that is never sent, and `masked` for a slot with no `redact` (or `handoff: last4` or `verified`), which would send it as it is; `validateApp` refuses the same for an app built in code.

  `data.unconfirmed` says what goes of a value the caller never confirmed. A filled slot is confirmed when its own flag is set (a yes to its `confirm_<slot>` read-back, a keyed value, a fill the slot takes with no read-back), or when it holds the value the caller said yes to at a summary: when the caller says yes to a summary, spoken or keyed, and the yes changes nothing it read (or a form with a summary completes on the caller's yes), each of the form's filled slots' values is kept as agreed (on the session, as `agreed`, only for an app that sets `mark` or `omit`), so a carried name counts as confirmed in a later form, a completion that hands the call to a person right after the yes names none of them, and a value corrected after the yes does not. Anything else is unconfirmed: every value of a form whose read-back the caller interrupted, a value changed since the yes. An identity factor, and a slot handed over only as `verified`, is never counted: the note's Identity line says what was proven. `send`, the default, sends them as any other value, as before the option. `mark` sends them and names them: the `end` frame gains `unconfirmed`, the ids of the slots it sends that the caller never confirmed, beside `slots`; the console's handoff card prints each as `howUrgent: right away (not confirmed)`; and the audit's `handoff` row lists their ids (never their values), which the handoff note's facts carry, so its Next line can say what to check. `omit` leaves them out of the data; the console and the audit still name them. `pnpm check` refuses any other value, and warns of `mark` or `omit` with `slots: none`, which sends nothing to mark. A chat's transfer sends no slot whatever this says.

  ```yaml
  handoff:
    data:
      unconfirmed: mark   # the office sees which values to check with the caller
  ```
- `thresholds` adds the app's own named thresholds (the clinic has `TIME_OF_DAY`), which a slot's options or a priority intent (`priority: { threshold: NAME }`) may name. `carrySlots` names slots that outlast the form that filled them (the clinic carries the caller's name and date of birth, so a second task does not ask again). It is shorthand for `listen: call` on each slot it names ([Where a slot listens](#where-a-slot-listens-listen)); a carried slot that says another `listen` is refused.
- `unsureIntent` says what an intent the model is unsure of gets, for every intent that does not say: `confirm` (the default) or `no-match` ([When the model is unsure](#when-the-model-is-unsure-unsure), under intents.yaml).
- `changeSlotWithValue` says what the change question does at a form's summary when the same turn also gives one of the form's slots a new value. The change question (`wording.changeSlot`) asks which detail the caller names as wrong without saying its new value, and a reading at `SLOT_CHANGE` (0.6) or more reopens that detail and asks for it again. A turn that gives a slot a value it does not already hold contradicts that reading: in "not Chen, Cheng" the model can take the doctor's surname for the caller's name. `set-aside`, the default, lets such a reading decide nothing, so the turn goes as it would without it: a no with a correction, the value applied and the summary read again (the debug table's changeSlot row says `value_given:<slot>`, naming the detail the reading named). A value said again unchanged ("no, it's Patel" with Patel held) is not new, so "the doctor, it's Patel" still reopens the doctor. What the default gives up: a caller who does name one detail and give another its value in one breath ("the doctor's wrong, and make it Thursday") has the value applied and hears the summary again, where they name the doctor once more; where the naming was misread (as the clinic's recordings showed for "not Chen, Cheng"), letting it decide would instead clear a detail that was right and ask for it. `decides` lets the reading decide as it would alone: the detail named is reopened unless the same turn gives it its new value, and a value given for another slot is filled on the way.

  ```yaml
  changeSlotWithValue: decides   # "the description, and make it Sunday" asks for the description again
  ```
- `anythingElseSilence` says what a caller who says nothing after "Is there anything else I can help with?" (the `anything_else` line, said when a form is done and the call goes on) hears when the no-input wait runs out. `repeat`, the default: "I didn't hear anything." (`no_input`) and "anything else?" again, the question they were asked. `opener`: `no_input` and the opening question (`ask_intent`), as the engine did before this option. `goodbye`: `no_input` and the goodbye, ending the call as the `done` intent does, for an app that takes a caller with nothing more to say as one who has finished. With `repeat` and `opener`, a further silence walks the intent ladder as it does at the opening (the keypad menu, then a person). Only the first silence after the line changes; silence after the opening question is never affected. Every line it uses is one each app already has, so `pnpm check` asks for nothing more, and refuses a value it does not know.

  ```yaml
  anythingElseSilence: goodbye   # nothing said after "anything else?" ends the call
  ```
- `fixtures: { dir: fixtures }` says where the corpus and the scripted calls are. The folder is relative to the app's package root, which is the folder its commands run in: the engine reads it from the working directory, and an app's `regress`, `cli` and `serve` scripts run in its package. It must stay inside the package, so an absolute path or one with `..` is refused. `check` then requires every intent to have examples there.
- `prompts` holds what is said about prompts besides their text: which opening lines to use, which variables are always spoken by text to speech, the clips' vocabulary.
- `callerNumber` keeps the number the caller is calling from for the app's own code, and may look the caller up by it once at call start: [The number the caller is calling from](#the-number-the-caller-is-calling-from-callernumber), below.

#### The number the caller is calling from: `callerNumber`

On a phone call the carrier sends the number the caller is calling from, and often the number they called. An app may use them, as a hint: to look something up by, to propose a value from, to offer to text the caller. Never as identity: a caller ID is set by the calling side and can be forged, so it proves no one. An app says what it uses in app.yaml, off by default:

```yaml
callerNumber:
  use: hint                   # keep the caller's number for the app's code
  called: true                # keep the number called (the DNIS) too; default false
  lookup: findAccountByPhone  # optional: called once at call start, through the gate
```

- **Keeping.** With `use: hint` the session keeps any usable number the call came with ([13.13](#1313-the-number-the-caller-is-calling-from) says what counts: digits as a carrier writes them, and not a withheld placeholder), whether or not a slot offers it. `called: true` keeps the number called as well. A chat has neither. Without the block, the number is kept only for a slot that offers it ([A callback number](#a-callback-number-callernumber)), as before.
- **Reading.** App code reads them with `callerOf(s)`, `{ number: '+15555550142', last4: '0142' }` or null, and `calledOf(s)`, the number called or null, both from `'dialogwright'`. Each is null on a chat, on a call with no number, and for an app that did not opt in, so code written against them is safe anywhere.
- **The call-start lookup.** `lookup` names a tool the engine calls once, right after the call starts and before the greeting: `{ tool, params: { callerNumber }, purpose: 'caller-lookup' }`, through the gate as the caller not yet proven, like any other call. The tool lists exactly one param, `callerNumber` (`pnpm check` refuses any other), and has an action in policy.yaml whose level, rules and `audit:` masking are the owner's; give it level 0, since it runs before anyone is verified (`check` warns otherwise: it would always be refused), and `audit: callerNumber: last4` (`check` warns on `keep`). Hold its param to the number calling with the `callerNumber` rule ([3.3](#33-the-built-in-rules)) so the tool can only ever look up the caller's own. A refusal is silent: nothing is said, nothing is kept, and the call goes on as one without a number. So is a failure: a tool that throws is recorded as failed (its error is not), and a `fromCallerLookup` that throws leaves the facts as they were. Tools run synchronously, so the greeting waits on nothing but the tool's own run: answer from the app's systems as they are, never from a slow service. An allowed result goes to the app's facts through `FactsConfig.fromCallerLookup(f, value)`, as a form's `onEntry` applies its entry's result. The lookup is a gate event and a tool result in the trace, the console and the audit, its param masked as policy.yaml says.
- **What the lookup may return.** Whatever it returns may end up said to a caller who has proven nothing: anyone holding, or forging, the number. Return the least that works (a line type, a street to propose), never a balance, a claim or a name. The tool decides that, not the policy: policy.yaml's `redact:` withholds fields only from a party acting for subjects, never from the anonymous caller the lookup is made as, so the tool returns only what may be said before identity, and the action's policy decides whether it runs at all. A match is never verification: the principal, the identity level and the identity attempts do not change, and an identity factor slot never takes the number.
- **Rules.** The gate learns the number through `GateFacts.callerNumber` (and `callerNumberAs`, the number as each slot that offers it holds it), set only for a session that kept one. The built-in `callerNumber` rule reads it; a rule of your own may too.
- **Privacy.** The numbers are masked as a start event's number is: by their last four on the console and in the frame log, and in the trace file by the slot that offers the number where there is one, else by their last four. The trace's start record says `callerNumber: kept` or `none`. The number goes to the app's tool and nowhere else; it never enters the model's turn state, and a call with a number sends the model exactly what a call with none sends, but where an offer line says its last four.

Testing it: a scripted call takes `"callerNumber"` and `"calledNumber"`; the text CLI takes `--caller-number` and `--called-number`. Replaying a logged call stands a made-up number in for the caller's, ending in the last four the frame log kept, in the international form carriers send (`+1555555` and the four), so key a lookup fixture by the last four. The frame log does not keep the number called, so a replayed call has none: `calledOf(s)` is null there. The engine's own fixture is `packages/dialogwright/src/testing/texting`: a call-start lookup of the line type, a text offer, and the rule on both.

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
- How sure the model must be. Outside a form, a form intent read at `INTENT_IMPLICIT` (0.6) or more starts its form, and one read from `INTENT_EXPLICIT` (0.4) up to that is confirmed first with `confirm_intent_explicit` ("Just to check, do you want to {intentLabel}?"); below that the caller hears `nomatch_open`. An informational intent has the same band: said at 0.6 or more, confirmed from 0.4, and said on the yes, so a caller the model half understood is asked rather than told the words were not understood. A form close behind either (within `GATE_INTENT_MARGIN`) is asked about as a choice between the two (`disambiguate_intent`). Inside a form, an informational intent is said at `INTENT_SWITCH` (0.85) and has no band: a confirmation there would stand in for the question the form is asking.
- When the model is unsure, see the next subsection: an app or an intent can say that such a reading is no match rather than confirmed.
- Something that must never wait or be missed (an emergency, a safety report) is marked `priority: true`: read at `PRIORITY_INTENT` (0.8) or more it is acted on this turn, mid-form included; `priority: { correctsForm: true }` also corrects what the call holds from the same words before the handoff ([Must never wait: `priority`](#must-never-wait-priority)).
- Two control intents are required, because the engine reads them by name: `agent` and `repeat_prompt`. The snippet above shows both. The other control intents (`done`, `other`, `none`) are optional to the engine; the library has all three.
- `done` is how a caller who is finished is understood: outside a form, "no, that's all" ends the call with the goodbye (`goodbye`, or `goodbye_chat` in a chat). Every app has the `anything_else` line, which the engine says when a form is done and the call goes on, so `pnpm check` refuses an app with that line and no `done` intent: without it, "no, that's all" is no intent the app knows, and the caller hears the no-match line, then the keypad menu or a person, instead of the goodbye. The fix it prints is the intent to paste. Give it corpus lines at the `anything_else` context (`testing.seed.anythingElse`) in the words callers use ("no, that's all", "I'm all set", "I don't need anything else").
- Keypad digits are quoted strings.
- An informational intent may switch the call's language: `locale:` names one of the app's locales, with a `promptId` said in it, or alone (never with a `passage`). No intent switches unless the app writes one; [13.3](#133-languages-on-the-phone) has the example and what a switch does on a call and in a chat.
- A key on the menu starts a form, plays an informational intent's line, or (`agent`) goes to a person. A key for any other control intent does nothing on a call (the caller hears nothing), so `pnpm check` refuses one.
- The menu listens only once it has been offered. On a call with a keypad (a phone call; a chat has none), the second missed answer to the intent question (words it did not understand, or a silence) offers it with `nomatch_dtmf_menu`, and the keys of the next turn are menu keys; with `MAX_ATTEMPTS` at its default of 3, a third miss goes to a person. A key pressed before then, at the greeting for example, is ignored. After an informational key the menu is offered again, so it keeps listening. A scripted call that presses a menu key therefore misses twice first.

#### When the model is unsure: `unsure`

The band above, a reading from `INTENT_EXPLICIT` (0.4) up to `INTENT_IMPLICIT` (0.6) outside a form, is an option. `confirm`, the default, asks the caller ("Just to check, do you want to {intentLabel}?"); a yes starts the form or says the answer, and a no is the intent question again, counted. `no-match` takes such a reading as no match: the caller hears `nomatch_open` and the attempt is counted, as for a reading below 0.4 (the debug table's intent row says `unsure_no_match`). app.yaml's `unsureIntent` sets it for every intent, and an intent's own `unsure:` overrides it, in either direction:

```yaml
# app.yaml: no intent the model is unsure of is confirmed...
unsureIntent: no-match

# intents.yaml: ...but this one is
intents:
  renew_loan:
    criteria: Wants to renew a book they have borrowed, so it is due back later
    label: renew a book
    kind: form
    unsure: confirm
```

It applies alike to a form intent, an informational one and `done`; `check` refuses it on another control intent, which is never confirmed. It changes nothing else: a reading of 0.6 or more acts as before, a hedged request read at 0.6 or more ("I think I might want to ...") is still confirmed, since the doubt is the caller's and not the model's, a switch away from the form in hand is still confirmed in its own band, since it would drop what the caller has given, and inside a form an informational intent still needs `INTENT_SWITCH`. Keep `confirm` where a caller half understood is better asked one yes-or-no question than told the words were not understood. Choose `no-match` where a wrong guess costs more than a second try: intents that sound alike, so that "did you want X?" would often be wrong, or a request that should start only when the caller is understood plainly. The setting is the app's, and changes no question the model is sent.

#### Must never wait: `priority`

Inside a form, a request for another form starts it only when the model reads the turn as replacing the task in hand (the `intentChange` question at `INTENT_CHANGE`, 0.6) and the intent at `INTENT_SWITCH` (0.85); a turn read as answering the question goes to the form, whatever intent it names. And a turn the model reads as not addressed to the line (`addressedToSystem` under `GATE_ADDRESSED`, 0.65) is ignored. Both are right for most requests and wrong for one that must never wait: "actually, water is pouring in right now", said at "Do you own the home?", reads as an answer, and "hold on, the wall just started giving way" reads as said half aside. Mark such an intent `priority`:

```yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: true      # acted on at PRIORITY_INTENT (0.8) or more, whatever else the turn was
```

Read at `PRIORITY_INTENT` or more, the intent is acted on this turn: its form starts (with its acknowledgement, never a "just to check" confirmation, even for a hedge), or an informational one is said. What it takes the turn from:

- The question in hand: an answer, an added task, a switch the model was unsure of. The form in hand is left as a switch leaves it: not queued, its values still on the session (a slot the priority form shares is not asked again), and what this turn said fills the priority form's own slots.
- A pending confirmation: the summary (the form read back is not filed), an intent or slot read-back, the transfer offer.
- A spoken menu number, while the keypad menu listens. A key pressed is a key, and does what it does.
- Side speech (`addressedToSystem`) and words read as unintelligible (`intelligible`): a caller in trouble is not talking to the line alone, and a re-ask costs the turn that matters. A false reading costs a caller put through to a form or a person they did not need.

What it never takes the turn from:

- The injection screen, which runs before the gates and discards the turn's answers when it fires.
- A handoff to a person (`wantsHuman`, the third frustrated turn, the `agent` intent): the caller reaches someone at once either way.
- A partial still being said (`utteranceComplete` holding a transcript that is not final): the words are read again when they are.
- The policy gate: what the priority form may do is decided as for any other form. Inside the priority form itself nothing changes.

The trace and the console show it as a gate row of its own, `priorityIntent`, read only in an app that marks an intent priority (any other app's rows are unchanged): `act:<intent>:over:<gate>` when it took the turn (it is the row that decided, and `<gate>` is the row that would have, which keeps its own outcome), `agrees` when the turn already did what it would, `stands:<gate>` for a handoff or a hold it leaves, `in_form` inside its own form, `below` under the threshold, `none` when no priority intent was read. `priority: { threshold: NAME }` reads another threshold in place of `PRIORITY_INTENT`: one of the engine's, or one under `thresholds:` in app.yaml (`check` refuses a name neither defines), so an app sets its own:

```yaml
# app.yaml
thresholds:
  URGENT_SURE: 0.75
```

```yaml
# intents.yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: { threshold: URGENT_SURE }
```

What the handoff carries after a priority switch is every filled slot of the call, the form left included: the form is left, not closed, so the name, the number and the address the caller gave are still there for the person who takes the call. By default those are the values as they were before the switch, so one the caller's own switching words contradict goes to the office stale: a caller who said the problem was getting worse, then at the read-back says "wait, water is coming through the wall right now", is handed over with "getting worse". `correctsForm` fixes that:

```yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: { correctsForm: true }    # threshold: PRIORITY_INTENT, as with `true`
```

Before the priority form is entered, the switching turn's answers fill the slots it was asked about, as a correction: the open form's slots, or, with no form open ("anything else?"), the call's own (the carried slots, a slot that listens anywhere, the identity factors where the turn listens for them). A new value replaces an old one; a value said again unchanged is no change. It is an ordinary fill, not a summary's correction, since nothing is read back on the way out: a part of a date never empties a slot that holds a whole one, and a text slot keeps what is on file unless it was the slot just asked (its `keep`), so the urgency changes and the problem the caller described does not. A switch the engine asks about first (`confirm_intent_explicit`, for an intent read below its priority threshold) corrects the same way on the caller's yes, from the words it asked about; a no changes nothing. The turn was planned with that form open, so the model was already asked about those slots: no question it is sent changes. What the correction would say is dropped (an acknowledgement of the corrected value before the handoff line is noise, and a choice between two values has no question to be asked on the way out), and its fill shows on the debug table's slot rows. The form left is still neither closed nor completed, nothing in it is confirmed by this, and its checks do not run: a corrected value a check would refuse ("and I rent it") still goes to the office, since the priority switch wins. Only a switch to a priority intent corrects; a replacing switch to an ordinary form does not, since its words may not be about the form left. `check` warns of `correctsForm` on an informational intent, which opens no form (the turn already fills the form in hand as it is said). Set [`handoff.data.unconfirmed: mark`](#appyaml) as well, so the office sees which values the caller never confirmed: at an interrupted read-back, none of them.

A run moves `PRIORITY_INTENT` with `--threshold PRIORITY_INTENT=0.85`; the sweep leaves it alone unless asked (`--only PRIORITY_INTENT`), since a rise lets such a request wait. `priority` is for a form intent or an informational one; `check` refuses it on a control intent (a person on request is the `agent` intent, which `wantsHuman` already acts on at once). It reads only answers the model already gives (the intent's probabilities), so it changes no question the model is sent, and an app without a priority intent behaves exactly as before. Give the intent corpus lines inside the forms (`context: <form>`, `change: replacing`), in the words a caller would use there, and one said half aside.

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
- `checks` and `checksPassed` (optional) end a form part-way on an answer: see [Checks](#checks-ending-a-form-part-way) below.
- Every form id must also be a `kind: form` intent.

#### Checks: ending a form part-way

Some lines rule a caller out before they collect the rest: a renter calling a homeowners' service, a home outside the area, a caller under 18. A form's `checks` ask the gate about an answer as soon as it is given, and end the form on a refusal, before the next question. The qualifying slots come first in the form, the booking's after them, and one summary reads all of them back.

```yaml
forms:
  book_inspection:
    slots: [problem, ownership, town, howUrgent, address, name, phone, day, timeOfDay]
    summaryPromptId: confirm_book_inspection
    hooks: [confirmedParams, complete]
    calls: [bookInspection]
    checks:
      - action: checkUrgency
        with: [howUrgent]
        on:
          emergency: { then: handoff }
      - action: checkOwner
        with: [ownership]
        on:
          not-owner: { say: decline_renter, then: end }
      - action: checkArea
        with: [town]
        on:
          out-of-area: { say: decline_out_of_area, then: end }
    checksPassed: home_qualifies
```

- `action` is an action in policy.yaml marked `check: true` ([section 3.2](#32-an-action-and-its-rules)): a question to the gate only. It has no tool, and an ALLOW runs nothing. The rule that refuses lives in policy.yaml with every other rule, and the write names the same rule, so the completion still refuses what the check refused. A qualifying answer is usually one of a list, so the rule is usually a built-in one: `oneOf` (the town is one of the four the business works in, the caller owns the home) or `noneOf` (how urgent it is is not an emergency), each with the reason `on` maps ([section 3.3](#33-the-built-in-rules)). A rule of your own (`defineRule`) is for what no list says.
- `with` lists the form's slots the check reads. Each is sent as the param of the same name, its value as the slot holds it. A check is ready when every slot in `with` holds a value. It runs then, and again whenever one of them changes; a slot reopened and given the same value, or an unchanged yes at the summary, asks the gate nothing.
- Checks run in the order written, on every turn that changed slots: after a disambiguation and a slot read-back (so never on an unsettled value) and after the form's entry call (so identity the form needs is proven first), before the next question. They run again first thing at completion, so "yes, but I rent" is refused with the check's own line and the write is never attempted. The first refusal ends the turn. Put the check the business cares most about first: a caller with two reasons hears its line.
- `on` maps a reason the gate gives to what follows. `then: end` says the line, then the call ends (the goodbye follows; with a request queued, the call goes on to it instead). `then: anything-else` says the line, closes the form uncounted, and carries on to the next queued request or "anything else?". `then: handoff` goes to a person with the line `handoff_<reason>` (`reason:` names another), after `say` if there is one. `say` is required for `end` and `anything-else`. A reason `on` does not list gets what a completion's refusal gives (`c.refusal`): a BLOCK with a line from the app's `blockPromptId` says it and carries on; anything else goes to a person. A `STEP_UP` from a check always goes to a person.
- `checksPassed` (optional) is a line said once, on the turn every check of the form has passed, and never again after a correction. Every line a check says renders with the form's slot displays as variables, as the summary does, so `home_qualifies` can say `{town}`.
- When a check ends the form on the very turn the form was entered ("I'm renting and there's water in the basement", or a value carried from an earlier form), the engine drops the line that started it (its `ack_intent`, or the `bridge_next` into it from the queue), so the caller does not hear "Sure, I can help" and "we can't help" in one breath. Write each refusal line so it names what it refuses ("Our visits are for homeowners, ..."): it may be the first the caller hears of the form.
- One check per answer refuses on the turn the answer is given. One check over several slots (`with: [howUrgent, ownership, town]`) runs only once all are filled, so a renter is asked the town and the urgency first: use it when the answers only rule a caller out together.
- What is recorded: each check that runs is a gate event like any call (the trace and the console show it as they show an entry call). A check that ends the form adds the audit row `form_stopped { form, action, reason, then }` before the handoff or the call's end, and the console's NOW panel says "stopped: checkOwner, not-owner". The form is not counted as completed. The session keeps what each check passed with (`checked`), which is absent until a check runs.
- A check never writes the session's queue: a form's hooks never write `s.queued`, which is the engine's.
- One form with checks also keeps what the caller says up front. The turn that opens a form fills every slot of it, so "I own the house, can someone come out on a Saturday morning", said on the opener, fills the ownership, the day and the time; the ownership check runs on that turn, and the day and the time are never asked. A line split into a qualifying form and a booking form loses the day and the time instead, since a turn fills only the form it opens ([Where a slot listens](#where-a-slot-listens-listen)). So put the slots a caller names in their first sentence in the same form as the step they open, even when they are asked last.

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
- **Every slot takes `listen:`** beside its type's options: where it listens outside a form (`up-front`, the default, `form`, `anywhere` or `call`). Section 5, [Where a slot listens](#where-a-slot-listens-listen), says what each does and when to choose it.

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

Recording a cassette, or running the server with `JEV_CLIENT=jev`, needs a key for the decision model. Jev is served by TypeSafe (`TYPESAFE_API_KEY`, the default), OpenRouter (`JEV_PROVIDER=openrouter`, `OPENROUTER_API_KEY`) and the Vercel AI Gateway (`JEV_PROVIDER=vercel`, `AI_GATEWAY_API_KEY`); `JEV_PROVIDER=custom` reaches a compatible endpoint at `JEV_BASE_URL` with `JEV_MODEL` (and `JEV_API_KEY` if it needs one). Each model gets its own cassette, named after it (`typesafe/jev-1.13` records `typesafe__jev-1.13.jsonl`), and the run's first line and the trace's session start say which provider and model answered. A compatible model is not Jev: its probabilities are not calibrated like Jev's, and the thresholds were measured on Jev, so a run on one warns once; record a cassette with it and compare with `regress` before trusting a threshold. Nothing is changed for you.

Record a cassette under the Node major in `.nvmrc` (22). A recorded request is replayed by its exact text, and the engine reads text with Unicode properties (letters and digits, case folding, accents folded for retrieval) whose tables come with Node's ICU and can change between majors. CI replays on 22 and 24; a miss that only one major shows is such a table change, not a regression, and the fix is a deliberate re-record under `.nvmrc`'s major, never a recording made on another one.

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
- `rules` is a list, run in the order written. The first rule that fails decides, and the gate answers with that rule's verdict: `BLOCK`, `STEP_UP` (verify further, then try again) or `NEEDS_HUMAN` (a person takes the call). Order is part of the policy: put `scope` before a rule that looks something up, so a lookup is only asked about a record the caller may see. A rule with no parameters is its bare name (`identity`, `attempts`); a rule with parameters is a one-key map. A rule is listed once per action (a range or list rule once per field). An empty list runs no rule, and the policy card says so.
- No rule is implied. An action that must check the level lists `identity`; a tool that verifies a caller lists only `attempts` at level 0 (it cannot ask for a level its own call is there to raise).
- `check: true` makes the action a form's check ([forms.yaml, Checks](#checks-ending-a-form-part-way)): a question to the gate only, with no tool, so an ALLOW runs nothing (the gate event is recorded with no tool result). Some form's `checks` must name it. It may not list `confirmed` (nothing is confirmed part-way through a form), and its level is 0 unless the form's entry call proves more first (a form with an `entry` hook whose purpose, under `purposes`, needs that level). Name the same rules in the action the form writes with, so the write holds what the check held:

```yaml
actions:
  checkOwner:
    say: check the caller owns the home
    check: true
    level: 0
    rules:
      - identity
      - oneOf: { field: ownership, values: [own], reason: not-owner }
  bookInspection:
    say: book a free inspection
    level: 0
    rules:
      - identity
      - oneOf: { field: ownership, values: [own], reason: not-owner }
      - confirmed: [ownership, address, name, phone, day]
```

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
| `oneOf` | `oneOf: { field: town, values: [millbrook, ashford], reason: out-of-area }` | the value is one of those listed | `BLOCK` (or `NEEDS_HUMAN`) with the rule's `reason`, `not-one-of` if none; `BLOCK` `value-missing` with no value |
| `noneOf` | `noneOf: { field: howUrgent, values: [emergency], verdict: NEEDS_HUMAN }` | the value is none of those listed | `BLOCK` (or `NEEDS_HUMAN`) with the rule's `reason`, `one-of` if none; `BLOCK` `value-missing` with no value |
| `callerNumber` | `callerNumber: { field: textTo, else: confirmed }` | the number is the one the caller is calling from, or with `else: confirmed` one the caller confirmed at the summary | `BLOCK` `not-caller-number`, or `no-caller-number` on a call with no number; `BLOCK` `value-missing` with no value |
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

**`oneOf` and `noneOf`.** Two rules that hold a param's value to a list, so the commonest qualifying question needs no code: the home is in one of the towns the business works in, the caller owns it, the problem is not an emergency. They are what a form's checks most often ask ([Checks](#checks-ending-a-form-part-way)):

```yaml
actions:
  checkUrgency:
    say: send an emergency to the office
    check: true
    level: 0
    rules:
      - identity
      - noneOf: { field: howUrgent, values: [emergency], reason: emergency, verdict: NEEDS_HUMAN }
  checkArea:
    say: check the home is in the service area
    check: true
    level: 0
    rules:
      - identity
      - oneOf: { field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }
```

- `oneOf: { field, values, reason?, verdict? }` passes when the value is one of `values`; `noneOf` (the same keys) when it is none of them. `field` is the param that holds the value: for a check, one of the slots its `with` sends (`check` refuses one no check of it sends); for an action with a tool, a param it sends, as for the range rules. `values` lists at least one value, each once, each as text (quote one YAML would read as a number or as true or false: `"1"`, `"true"`).
- The match is exact: the value as the call carries it, character for character. A slot's value is already what its type made of the caller's words, and a choice slot's is one of its option ids (`cedar_falls`, never "Cedar Falls"), so list the ids. `check` holds a list on a param of a choice slot's name to that slot's option ids, and names the closest when one is not (`"cedar falls" is not an option of the choice slot "town" ... rename it to "cedar_falls"`). There is no case-insensitive match on purpose: words a caller says several ways belong in a choice slot's options, which turn them into one id, not in the policy.
- `reason` names the reason a refusal gives, for a check's `on:`, the app's refusal lines (`blockPromptId`) and handoff lines (`handoff_<reason>`). Without it, `not-one-of` for `oneOf` and `one-of` for `noneOf`. `verdict` is `BLOCK` (the default) or `NEEDS_HUMAN`, for a person to take the call (an emergency).
- They fail closed. A value that is missing or empty BLOCKs with the reason `value-missing`, whatever `verdict` says, for `noneOf` too: a call that says nothing is not "none of these". A check never sends an empty value (it runs once its slots are filled), so `value-missing` is what a write without the param gets.
- Each records itself under its name (`oneOf`, `noneOf`) with lines like `town one of [millbrook, cedar_falls, ashford, riverton]` (a `oneOf` that passes), `town not one of [...]` (one that refuses) and `howUrgent none of [emergency]` (a `noneOf` that passes): the param's name and the list, never the call's value. The policy card says it in words, with a choice option's own words: "town must be one of Millbrook, Cedar Falls, Ashford or Riverton: any other is refused (`out-of-area`), and a missing value is refused".

**`callerNumber`.** A rule that holds a param to the number the caller is calling from, so a text the app sends goes only to the caller's own phone, or to a number the caller heard read back whole and said yes to:

```yaml
actions:
  sendUpdates:
    say: text updates about a request
    level: 0
    rules:
      - identity
      - callerNumber: { field: textTo, else: confirmed }
      - confirmed: [topic, textTo]
  findAccountByPhone:
    say: find the service address for the number calling
    level: 0
    rules:
      - identity
      - callerNumber: { field: callerNumber }
audit:
  callerNumber: last4
  topic: keep
```

- `callerNumber: { field, else? }`. `field` is a param the action sends. It is compared as the slot of the same name holds the caller's number (its `callerNumber` offer's `take`: `5555550142` for `+15555550142`); a param named `callerNumber` is the number as the session keeps it (the call-start lookup's param); any other is compared digit for digit with the number as kept, and `check` warns.
- `else: refuse`, the default: any other number BLOCKs with `not-caller-number`, and on a call with no number kept (a chat, a withheld number) every number BLOCKs with `no-caller-number`. `else: confirmed`: another number passes only when the caller confirmed the call's values at the summary (the action's `confirmed` rule, hashed as the summary hashed them), so the caller heard it whole and said yes; `check` requires the field in the action's `confirmed` rule.
- It fails closed: a missing or empty value BLOCKs with `value-missing`. The number is a hint, never identity: the rule says where a call may send something, never whose record it reads, so never use it in place of `scope`.
- It records itself under its name with lines like `textTo is the caller's number`, `textTo is not the caller's number, but a number the caller confirmed` and `textTo with no caller's number`: never a number, the call's or the caller's. `check` warns of the rule in an app that keeps no caller's number (no `callerNumber` in app.yaml and no slot that offers it), where it refuses every call. The policy matrix of an app whose policy matrix names a `callerNumber` runs every call with that number kept and with none (its `caller` axis), and the invariants hold the rule with the list rules' (`one-of`).

`oneOf` cannot do this: its values are fixed in the policy, not the call's. A rule of your own could, reading `GateFacts.callerNumber`, but this one is common enough to be built in.

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
- **Which token claim names the subject.** A channel that signs in with a token (the engine's web chat, `CHAT_SIGNIN=jwt`) reads the subject's id from the token claim `sub`, or the one `signIn.claim` names; `code.principals.fromClaims` reads the token claims in code for anything one token claim cannot say (a delegate, a tenant). See [13.5](#135-sign-in-on-the-web-chat).
- **Lines.** With an identity.yaml the engine also says the identity lines (`identity_verified`, `handoff_identity`, and with level 2 `ask_otp`, `otp_failed` and others), and `check` requires them in every locale.

### 3.7 How a form reaches an action: `calls`

The action a form's hooks call goes through the gate, but the engine does not read which. Declare it in forms.yaml (`calls`, on each form, section 2) so the policy can be read as a whole: `calls` lists the actions the form's entry, summary and completion hooks make, and `check` reports an action no form reaches (an action the identity flow calls itself, the identity tools, is not counted). The app map (3.11) draws a form to its actions and their rules with it. Declare it for every form or for none (`calls: []` for a form that calls nothing). A form reaches its check actions through `checks`, which `calls` does not list; the app map draws each check beside the slots it reads.

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

An address the caller says in their own words. `pick` keeps only the part that is the address, and `numbers: digits` with `case: title` has code write the value a tool gets ("seventy six twenty five oak hollow lane" said, "7625 Oak Hollow Lane" sent), while the summary reads back the words as said (`say: null`), since text-to-speech reads "7625" as a quantity. The model is asked the same questions either way; the rules are English's, and a language without rules keeps the words as said.

```yaml
place:
  type: text
  what: the street address where the problem is
  say: null                 # the summary reads back the words themselves
  redact: none              # needed with say: null: the words are in the trace and the audit
  pick: { what: the street address }
  numbers: digits           # the value: number words as digits; ordinals ("fifth avenue") stay words
  case: title               # the value: all-lower-case words capitalized
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

The engine asks the questions of every slot the turn listens for, not only the one it just asked about: inside a form, the form's slots (and, while an anonymous caller is still to be verified, the identity factors); outside a form, every slot the app has but one that listens only in its form (`listen: form`, below). That is what lets a caller volunteer several details at once, and lets "what do I have out on card 5552 0417" fill the card on the opening turn. Outside a form, what is heard for a form's slot is kept only for the form the turn opens: the turn routes, the form opens and fills from what was said for it. A turn that opens a form fills that form's slots (and, while an anonymous caller is still to be verified, the identity factors) and no others, whatever their `listen`: a day said for another form is not kept. A turn that opens no form (an informational answer, a declined offer of a person) keeps only what belongs to the call, the identity factors and the slots the app carries (`carrySlots`, or `listen: call`), and the slots that keep a value said anywhere (`listen: anywhere`); a topic or a day said in an informational question is not kept for a form asked for later, which starts from what is said then. It is true of library slots and slots in code alike, and it has two consequences:

- A slot must give `absent` when the words say nothing about it. The library types do; a slot in code must.
- Adding or changing a slot changes the model's request on every turn where it listens, because its questions are in the request and every slot's display is in the turn state. A recorded cassette then misses until it is recorded again, which calls the paid model and is a deliberate step (the clinic's README, "Recording the cassette").

### Where a slot listens: `listen`

Every slot takes `listen:` beside its type's options: in slots.yaml, in `defineSlot`'s configuration, or on a slot written in code (`SlotSpec.listen`). It says what the slot does outside a form; inside a form that has the slot, it always listens.

| `listen` | Its question, outside a form | A value said outside a form |
|---|---|---|
| `up-front` (the default) | asked | kept only when the turn enters a form that has the slot: values said up front with the request. A turn that opens no form keeps none. |
| `form` | not sent | never taken: the form asks for it once it is open, even when it was said with the request |
| `anywhere` | asked | kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it and empties it as it closes. Not kept from a turn that opens a form without it (a known gap, below) |
| `call` | asked | kept, and it outlasts every form, for the whole call |

```yaml
firstDate:
  type: date
  range: future
  listen: form
```

When to choose each:

- **`up-front`** suits most slots. "Book a delivery window for tomorrow morning" has its day and time of day taken with the request, and an informational question that mentions a day leaves nothing behind for a later form.
- **`form`** is for a value whose words come up in other requests, to be heard only in answer to its own form. A payment arrangement's first payment date is one: "are you open on Saturday", a question about office hours, mentions a day, and the arrangement should never take it as the first payment. The slot's question is then not sent outside its form, and a date said with the request ("set up a payment plan starting Friday") is asked for again once the form is open.
- **`anywhere`** is for a value a caller often gives before saying what they want, which a later form should not ask for again: a reference number said at the greeting, an order number said with a question. That is how every slot behaved before a value said outside a form was tied to the form the turn enters.

  It does not reach across forms on the turn one opens. "Book me in for a Saturday morning", said on the opener of a line whose first form qualifies the caller and whose second books the day, opens the first form, and the turn fills only that form's slots: the Saturday and the morning are lost, with `anywhere` or `call` on them alike. A line that qualifies before it books does not meet this: make it one form, the qualifying slots first and the booking's after, with a check on each qualifying answer ([Checks](#checks-ending-a-form-part-way)). The opener then opens that form and fills every slot of it, the day and the time included, and they are never asked. The engine's fixture for checks has the call (`day-and-time-up-front-kept`).

  What is still lost is a detail for a second request named in the same breath: "where is my parcel, and book a delivery window for tomorrow morning" opens the tracking form and queues the window, and the window's form asks the day again when it is reached. Let it ask, pin it with a scripted call, and write it in the app's gaps; keeping such a value for a queued form is a known gap in the engine, held by a test so that a change to it is deliberate.
- **`call`** is for a value that is the caller's rather than one task's: their name, their date of birth. It is what app.yaml's `carrySlots` does, and `carrySlots` is shorthand for it; a slot `carrySlots` names that says another `listen` is refused by `check`. A carried value pre-fills the next form that has the slot, so give a form that writes from one a summary.

An identity factor (identity.yaml) listens as identity says: while an anonymous caller is still to be verified, inside a form and out, and it stays for the call. `listen` does not apply to it, and `check` refuses it there. An unknown value is refused with the near one (`change it to "anywhere"`).

Any value but the default changes what the model is sent: `form` takes the slot's questions out of every turn outside a form, and `anywhere` and `call` keep values that then show in the turn state of later turns. A recorded cassette misses where they differ, so choose one with a deliberate re-record.

### A callback number: `callerNumber`

On a phone call the carrier almost always sends the number the caller is calling from, and ten digits is the most fragile answer a caller gives. A `digits` slot that holds a phone number can offer that number as a yes or no rather than ask for it:

```yaml
phone:
  type: digits
  noun: phone
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'        # +15555550142 becomes 5555550142; a number from another country is no number
```

and its line in prompts.yaml, in every locale (`pnpm check` requires it):

```yaml
offer_phone:
  text: Is the number you're calling from, ending in {last4}, the best one to reach you?
  interruptible: true
```

When the form would ask `phone` and the call came with a number that fits the slot, the line says `offer_phone` in place of `ask_phone`. `{last4}` is the number's last four digits, the only variable the line is given (it may leave it out: "Is the number you're calling from the best one to reach you?"). The offer is the slot's read-back, with the slot still empty:

| The caller | What happens |
|---|---|
| A yes ("yes, that's fine") | The slot holds the number, confirmed, as a keyed number is, and the form goes on. What else the yes said ("yes, and it's about an order") fills the form's other slots. |
| A no | `ask_phone`, with no attempt counted: the caller answered what was asked. |
| A number, with the no or without it ("no, use my cell, 555 555 0199") | The number fills as said, and the form goes on. A number the slot refuses (too short, the wrong shape) closes the offer and is retried as a missed answer to `ask_phone` (`ask_phone_retry`, or the slot's own retry line). |
| Silence, or words that answer neither | The offer again, as any read-back is asked again: each counts a turn, and the slot's keypad rung (`ask_phone_dtmf`, or `ask_phone_retry` for a slot with no keypad) comes as it would. |
| A number keyed | It fills as keyed. |

It is offered once per slot per form: a number reopened at the summary ("the number is wrong") is asked with `ask_phone`, not offered, whether or not it was offered before. A chat has no number, and neither does a call whose number is withheld or does not fit, so there the slot is asked as always ([13.13](#1313-the-number-the-caller-is-calling-from) says what counts as a number, and where each carrier puts it).

What the option promises, and what it does not:

- **It is never identity.** A caller ID can be forged. `pnpm check` refuses `callerNumber` on an identity factor, and the number is never compared with a record to verify anyone: it only fills a callback number the caller said yes to. (A gated lookup by it may propose a value, never verify: [The number the caller is calling from](#the-number-the-caller-is-calling-from-callernumber).)
- **It is never used silently.** Only the caller's yes fills the slot. A switchboard, a shared line or someone else's phone is the caller's to correct, which is why the line asks.
- **It is said in part.** The offer says the last four digits, and the model is told no more ("the number they are calling from, ending in 0142"). The whole number is said only where the form's summary reads the slot back, so `pnpm check` warns when a form with the slot has no summary.
- **It is masked as the slot is.** Once filled, it is the slot's value: a `digits` slot's default `redact: last4` masks it in the trace, the gate events and the audit, and a transfer hands it over by its last four. The start event's number (`SessionStart.callerNumber`) is masked on the console and in the frame log, and in the trace file as the slot masks its value, as is the setup's own copy of it in the start event's provider details (Twilio's `from`, Telnyx's `param.telnyx_call_from`) when the session kept it. A number not kept (withheld, or not one the slot can use) is no value of the slot's, and the trace file's provider details keep it as the carrier sent it, as for every app. Nothing else of the app's sessions changes: a session keeps the number only when the app has such a slot, and the trace's first record says `callerNumber: kept` or `none`, so a builder can see why no offer was made.

A slot kept for the call (`listen: call`, or app.yaml's `carrySlots`) is offered in the first form that asks it and, once filled, keeps its value: `pnpm check` warns so that it is meant.

Every offer the caller settles writes an `offer` row to the audit ([A text offer](#a-text-offer-onno-and-ifnone), below, says what it holds).

Testing it: a scripted call takes `"callerNumber": "+15555550142"` as a carrier sends it (a withheld one as the carrier writes it), which reaches the call only for an app with such a slot, never a chat; the text CLI takes `--caller-number`. A corpus line at the offer is in the form's context, `prompted` the slot, with `confirm` (`yes`, `no` or `unanswered`), as a summary's line is. Turning it on changes the model's request on the offer turn (the pending read-back is in its turn state), so a recorded cassette misses there until it is recorded again. The frame log keeps only the number's last four, on a line of its own (`{"callerNumber": "…0142"}`, written only when the session kept the number), and replaying a logged call stands a made-up number ending in those four in for it (the shortest in the 555 range the slot takes), so the replay makes the offer the call made, with the same line and the same request to the model; after a yes the slot holds the stand-in, which the trace masks to the same last four, so a later turn's request, which shows the model the slot, is not the call's. A log written before that line replays with no offer. The engine's own fixture is `packages/dialogwright/src/testing/callback`.

### A text offer: `onNo` and `ifNone`

A callback number is a slot the form needs: a no to the offer asks for another. An offer to text the caller ("Can I text you updates at the number you're calling from?") is one the caller may turn down, and a no means no text. Two options of the `callerNumber` offer say so:

```yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'
    onNo: skip      # ask (default): a no asks ask_<slot>. skip: a no leaves the slot empty.
    ifNone: skip    # ask (default): no number to offer asks ask_<slot>. skip: the slot is left empty.
```

```yaml
offer_textTo:
  text: Can I text you updates at the number you're calling from, ending in {last4}?
  interruptible: true
```

- **A skipped slot is declined**: empty, but answered, so the form does not ask it and goes on (`SlotState.declined`). Its completion sees no value and sends nothing. A number said instead ("no, text my cell, 555 555 0199") still fills the slot as said, as does a number keyed; a declined slot reopened at the summary ("the text number is wrong") is asked, never offered.
- **`onNo: skip`.** A no, and the end of the offer's retry ladder (silence, or answers that are neither yes nor no, until the ladder would leave the offer), leave the slot empty: a text nobody agreed to is not worth a person. With `ask`, a no asks `ask_<slot>` with no attempt counted, and the ladder goes on to the slot's own rungs, as for a callback number.
- **`ifNone: skip`.** A call with nothing to offer (a chat, a withheld number, one that does not fit the slot, or one the app will not offer, below) leaves the slot empty. With `ask` the slot is asked as always.
- **The summary.** A slot that may be left empty is never named in its form's summary line as `{<slot>}` (`pnpm check` refuses it: the line would read nothing there). Read it back from a line of its own when it is filled: the form's `onSummaryRead` hook returns that line's `promptId` ("That's a request about an order, with updates texted to 555 555 0142. Shall I open it?"), and the summary's yes, keypad and ladder work there as on the summary itself.

**Refusing an offer: `App.callerOffer`.** A landline cannot take a text. The app's code may refuse an offer with `callerOffer(ctx, slot)`, called only when an offer is about to be made (the form would ask the slot, and the call has a number that fits it), once per slot per form. False makes no offer, and the slot goes on as `ifNone` says. It may read the facts (a line type the call-start lookup found), or call a gated tool through `ctx.callTool` (a line-type lookup, its param held to the caller's number by the `callerNumber` rule) and keep the answer in the facts. Without it, every offer is made.

```ts
export const code: AppCode = {
  // ...
  callerOffer(ctx, slot) {
    if (slot !== 'textTo') return true;
    const caller = callerOf(ctx.s);
    if (caller === null) return false;
    const { decision, value } = ctx.callTool({ tool: 'lineType', params: { callerNumber: caller.number } });
    return decision.verdict === 'ALLOW' && (value as { lineType?: string } | null)?.lineType === 'mobile';
  },
};
```

**Sending the text.** The app's own tool sends it, from the form's completion, with the slot's value as its param, and only when the slot holds one. Hold that param with the `callerNumber` rule ([3.3](#33-the-built-in-rules)): `callerNumber: { field: textTo }` sends only to the caller's own number; `else: confirmed` sends to a number the caller confirmed at the summary too.

**What is recorded: the `offer` row.** Every offer the caller settles, a callback number's, a text's, writes one row to the audit, in the day's hash chain, so `pnpm audit:verify` covers it:

```
type: offer
detail: { slot: textTo, source: caller-number, promptId: offer_textTo,
          said: "Can I text you updates at the number you're calling from, ending in 0142?",
          answer: yes | no | other | none, by: speech | keypad | null, last4: "0142", locale: en-US }
```

`said` is the line as it was said, since the prompt manifest may change later. `answer` is `yes` (the number offered), `no` (a no with no number of the caller's own), `other` (a number of their own, said or keyed, with or without a no) or `none` (no answer before the ladder left the offer; `by` is then null). An offer asked again is not settled yet, and one dropped unanswered by a switch to another task or a handoff writes no row. The text tool's own row (its gate row, with the slot's param masked) follows when the form completes.

**Consent is the owner's question.** Whether a spoken yes on this line is consent to be texted, under the TCPA or any other law, is a legal question for the line's owner, and the answer differs between informational and marketing texts. The engine records what was asked, in the words said, and what was answered. It does not decide that the answer is consent, and it sends nothing on its own.

Testing it: a corpus line at the offer has `confirm` `yes`, `no` or `unanswered` as for a callback number; write one for each answer a caller gives there, "that's my landline" among them. The engine's own fixture is `packages/dialogwright/src/testing/texting`.

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
- **`fill` only reads.** It returns an outcome and changes nothing, neither `ctx` nor anything of its own: the engine may call it more than once on a turn with the same answers (at a form's summary it reads the turn's new values before the fill, for app.yaml `changeSlotWithValue`), so the same answers and context must give the same outcome each time.

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

Where it applies: a tool call's param with the same name as the slot, as the gate event, the trace and the audit log record it; and the trace's and the console's copies of the slot (its value and display, the slots in the turn state the model was given, a pending read-back, a prompt's variables named after the slot, a handoff's collected slots). What our own lines said of it is masked too: the trace's say actions, the console's spoken line, the frame log's outbound text frames and the part of a line an interruption heard have each redacted slot's value, display and digits (however a voice line spaces or groups them) replaced by its masked form. A pending partial of a redacted slot keeps its shape with its numeric parts zeroed. The console shows a passage's `applies` (whom it answered) only as `audit:` in policy.yaml declares each fact. So name the tool param and the prompt variable that carry the value exactly as the slot: the library's `listLoans` takes `card`, and its lines say `{card}`.

What `redact` does not cover is the caller's words. The transcript (the speech event, the turn's text, and the questions the model was asked, whose span labels are the caller's words) is kept in the trace as said, so a trace is sensitive. The audit log holds only the masked calls. The model itself sees each slot's display in its turn state.

`handoff` says what a transfer to a person hands over for the slot (`HandoffDecision.slots`). Without it, the slot's display. `last4`: the last four digits. `verified`: only whether the caller was verified (`verified` or `not verified`), never the value, which needs an identity.yaml. Only filled slots are handed over, and a form's slots are emptied when it completes, unless app.yaml's `carrySlots` names them. What the transfer then sends on to the channel is app.yaml's `handoff.data` ([app.yaml](#appyaml)): by default an identity factor is left out, a slot with a `redact` setting goes masked as the trace masks it, and any other slot goes as its `handoff` setting says. So `redact` also masks what a transfer sends, unless app.yaml names the slot `as-is`.

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

Where they run in a turn: the turn fills slots (speech, the keypad, a correction at the summary), then the form loop asks a disambiguation or a slot read-back if one is due, makes the `entry` call if the form has not passed it, runs the form's `checks` ([forms.yaml, Checks](#checks-ending-a-form-part-way)), and asks the next slot or reads the summary. A yes at the summary runs the checks once more, then `complete`. A form that rules a caller out on an answer needs no hook for it: write a check, not a `complete` that turns the caller away after the rest was asked, and never write `s.queued` from a hook to chain a second form.

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
2. **The folder against the code**: every slot, tool, hook and custom rule the YAML names exists in the code; every hook the code writes is listed in forms.yaml; every tool in the code has an action in policy.yaml and every action is a tool; every custom rule the code defines is named by a `custom:` rule; every prompt the YAML names is in prompts.yaml; the identity tools, factor slots and carried slots exist; what the console names (form and slot labels, the slot order, question prefixes, a lookup fact's tool) and the clips name (a voice tag's clip, a clip's variables) exists; an action that runs the `confirmed` rule has a form with `confirmedParams` to confirm it; every form's `calls` names tools the code defines, and, when forms declare `calls`, every action is reached by a form or the identity flow; every form's `checks` names a `check: true` action and the form's own slots (not an identity factor), each check action is named by a form, has no tool in the code and no `confirmed` rule, and needs no level the form's entry does not prove, and every line a check says is in prompts.yaml; app.yaml's `callerNumber.lookup` is an action whose tool takes `callerNumber` alone, reached at call start, and a slot that may be left empty (`onNo` or `ifNone: skip`) is not named in its form's summary line; every threshold a slot's options name (a `hedge.threshold`) is one of the engine's or one under `thresholds:` in app.yaml; and the whole app passes the engine's own `validateApp`.
3. **The engine's own lines in every locale**: every line the engine says by name, and the lines it builds for each slot and for a role rule's reason (section 2, prompts.yaml), exists in prompts.yaml and in each `locale/<tag>/prompts.yaml`. A missing line's message says when the engine says it and, when it gives the line variables, which ones (`..., and gives it {first}  ->  add "signin_thanks:" with its text (it may use {first}) and interruptible to prompts.yaml`).
4. **The keypad menu**: every key names a form intent, an informational intent or `agent`; a key for another control intent is refused, since the engine ignores it.
5. **A caller who is done**: an app that says `anything_else` ("Is there anything else I can help with?") has a `done` intent, so "no, that's all" ends the call with the goodbye rather than the no-match line (section 2, intents.yaml). The fix is the intent, ready to paste.
6. **Each locale against prompts.yaml**: a translated line uses only the variables the prompts.yaml line has (the code fills those and no others, so another would fail when it is said), and a locale has no line that prompts.yaml does not (it would never be said).
7. **The corpus**: every intent has at least one labelled example in `corpus.jsonl`, when app.yaml names a fixtures directory. The corpus must be inside the package (a link that leads out is refused) and at most 16 MB.

The format is one line per problem, `file:line:column  path  message  ->  fix`, and then a summary line (`N problems in <folder>`, or `<folder>: ok`). A problem in the code has no YAML line, so it reads `app.ts` (or `src/app.ts`) and a code path such as `code.forms.renew_loan.entry`.

A warning is a line that starts `warning: ` in the same format. It is printed and never counted: the exit code is the problems'. Under `--json` the warnings go to stderr and the JSON is the problems. Two things are warnings about a form's checks: an `on` reason the check's rules never refuse for (the outcome would never apply; a custom rule's reasons are the ones its examples expect), and a rule a check holds the caller to that no action in the form's `calls` runs (the write would not hold what the check held). Others are about the number the caller is calling from: a form with a slot that offers it and no summary, a call-start lookup above level 0 or with its number recorded with `keep`, a `callerNumber` rule in an app that keeps no number, and one on a param no slot that offers the number holds ([The number the caller is calling from](#the-number-the-caller-is-calling-from-callernumber), [3.3](#33-the-built-in-rules)).

When a schema problem is found, the cross-checks against the code do not run until it is fixed, because a file that does not parse cannot be linked. Fix the schema problems first, then run it again. Any other problem does not hold the rest back: an app module that builds the app with `defineApp` throws when the folder and the code disagree, and `check` still reads the code that `defineApp` was given, so the lines the code needs (a keypad slot's `ask_<slot>_dtmf`, a portal's sign-in lines) are reported in the same run as the problem that made it throw.

These are real messages. The folder was a copy of the library fixture, with these edits: an unknown key `colour: blue` in app.yaml, `level: three` for `renewLoan` in policy.yaml. The first run:

```
app.yaml:5:1  colour  unknown key "colour" in this file  ->  delete "colour"; the keys allowed in this file are id, locale, brand, console, voice, handoff, wording, thresholds, carrySlots, unsureIntent, changeSlotWithValue, anythingElseSilence, callerNumber, fixtures, prompts
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

And an app that asks "anything else?" with no `done` intent (the library fixture with `done` taken out):

```
intents.yaml:2:1  intents  the app asks whether there is anything else (the line "anything_else", said when a form is done) but has no "done" intent, so a caller who answers "no, that's all" is not understood: they hear the no-match line instead of the goodbye, then the keypad menu or a person  ->  add under intents: done: { criteria: "Says they are finished and need nothing more, as in no thanks, that's all, I'm all set, nothing else, I don't need anything else, or goodbye, including a bare no when just asked whether there is anything else", label: finish up, kind: control }; then give it corpus lines, such as {"id":"dn-01","text":"no, that's all","intent":"done","context":"anything_else"} (the anything_else context needs testing.seed.anythingElse; "no_form" otherwise)
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
- **Choosing the locale.** The session starts in the default locale. A channel can name another: the `session.start` event carries a `locale`. On the phone the relay adapter reads it from a custom parameter named `locale`, which the start document sets from app.yaml's `voice.numbers` for the number called; a web chat asks for one as it starts (`start.locale`, the widget's `locale` option or the page's `<html lang>`). See [13.3](#133-languages-on-the-phone) and [13.4](#134-web-chat). It is matched against the app's locales: the same tag (letter case aside), else the app's locale that is the request's language alone (`es-US` finds `es`), else the app's first locale in that language (`es` finds `es-MX`), else the default. The request is untrusted: it is only compared, and what is used is always one of the app's own tags. An intent with `locale:` switches the call mid-way ([13.3](#133-languages-on-the-phone)).
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
- **On the phone and in a chat.** The call's language, its voice and recognizer per carrier, and a switch mid-call are [13.3](#133-languages-on-the-phone); a chat's request for a language is [13.4](#134-web-chat). An app without locales, and a one-locale en-US app, sends exactly what it did before: no languages, and text frames in `en-US`.
- **Known limits.** The phone's own (hints after a switch, and what is still to be confirmed on a live call) are in [13.3](#133-languages-on-the-phone).
  - Intent labels (`label:` in intents.yaml) stay in the default language, so a Spanish line that says "Claro, puedo ayudarle a {intentLabel}" still ends with the English label.
  - A slot written by hand in code formats its own values: it says them in Spanish only if it reads `ctx.locale` and `display(value, locale)`.
  - Spanish is the one language besides English the slots read and say; another language's sessions read words as English and say values in English until its lexicon and formats are added.
  - Matching a requested locale looks at the language and the whole tag, not at a script subtag: a request for `zh-Hant` in an app with only `zh-Hans` finds `zh-Hans` by its language, `zh`.
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
3. If the tool is a confirmed write, give the form `confirmedParams`, and make the form's `complete` set `s.confirmedHash = s.pendingHash` before the call, as the library's `renew` does. If it writes at all, give it `idempotent: true` and pass `ctx.idempotencyKey` to the system it writes to ([14.13](#1413-writes-that-are-never-done-twice)), so a write repeated after a crash is not done twice.
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

### After a recorded run

A run against a model or its cassette (`--client record`, `recorded` or `jev`, and `cassette:trim`) reads the app's `.env` first, as `pnpm start` does (ENV_FILE names another file; a variable already in the environment wins; a stub run reads none). It ends with one more line, what needs a decision: `to triage: 3 untagged corpus differences, 1 failing scripted call, 0 passing scripted calls that differ from the baseline, 0 cassette misses`. `regress --client recorded --corpus <id>` adds, under the line's turn, every question the model was asked with its probabilities, and the screen's reading. `--json` with `--corpus <id>` (or `--scenario <id>`) prints only the outcome, in the baseline file's own shape: the lines between its braces paste into `fixtures/expected/corpus.json` (or `scenarios.json`) as an entry added by hand. `pnpm --filter <package> cassette:trim` rewrites the cassette with only the answers a whole replay asks for, and writes nothing if a request misses.

A borderline line the model reads one way in one recording and another way in the next can be tagged with a few outcomes instead of one: `"knownGap": {"reason": "...", "outcomes": [{"promptId": "ask_name"}, {"promptId": "anything_else"}]}`. Any one of them shown is allowed (`allowed: knownGap: <reason>`), anything else fails, and the baseline itself reads `knownGap now matches`. A tag has `outcome` or `outcomes`, never both ([known gaps](known-gaps.md)).

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

**topics.yaml** names what callers ask about. Retrieval reads each topic's title, keywords and example questions; the topic question offers the title. A title is spoken, so an approval covers it: renaming a topic sends its passages back for review ([12.8](#128-approval-staleness-and-withholding)).

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
  hash: 83130b55c5f2be7a628620a4dcacca0dac5b6d8bfb97b4852b5816c7c65c3a03
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
  hash: f2a183c49c4bdec0ab8b3253d90d5fd1a5a0b58a368882173ee7c6aa92a53ae7
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
  hash: be0ce40c52aeb3f1db18d14e464e98d8c16d885e44ed070889526fd19c236a30
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
  hash: fe8bf374b3b707e2dd142f8ba25c6e5b0852abb505f7483d680f8e395c8d630b
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

**The approvals log** has one JSON line for each approval, written by `pnpm kb:approve` and only ever appended to. It keeps the source section's text as it was approved (`sourceText`), so a later review can show what changed in it, and `pnpm check` holds every passage's approval to a line of its id and hash:

```jsonl
{"id":"opening-hours","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c","hash":"be0ce40c52aeb3f1db18d14e464e98d8c16d885e44ed070889526fd19c236a30","from":"pending","sourceText":"All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday."}
{"id":"late-fees-adult","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"a3502dd02204f66615d5227dfafdb55a5b53572022c5982f1c5e53036ee9b850","hash":"f2a183c49c4bdec0ab8b3253d90d5fd1a5a0b58a368882173ee7c6aa92a53ae7","from":"pending","sourceText":"An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item."}
{"id":"late-fees-junior","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"18345c1533866b482125f9f1f66d537d51741e4c0fce296322696bf920018b6a","hash":"83130b55c5f2be7a628620a4dcacca0dac5b6d8bfb97b4852b5816c7c65c3a03","from":"pending","sourceText":"Junior cards are not charged late fees."}
{"id":"opening-hours-es","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c","hash":"fe8bf374b3b707e2dd142f8ba25c6e5b0852abb505f7483d680f8e395c8d630b","from":"pending","sourceText":"All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday."}
```

### 12.2 How a call uses it

Four steps, and only the second is a model's: nominate, select, resolve, speak.

1. **Nominate.** Before a turn is planned, the engine runs the app's retriever once on what the caller said, in their language and for today, and gets back up to `cap` topics, best first, each with a score and how it was found (`keyword`, `dense` or `app`). This is the turn's one asynchronous step, since the questions are built before the model is asked.
2. **Select.** The topic slot asks the model one question over those topics and "none": which does the caller ask about? The model answers with a probability for each. Code reads them: a topic is chosen when it reaches the threshold, two that cannot be told apart make the slot ask which one was meant, and "none" or a weak answer chooses nothing.
3. **Resolve.** The form's completion reads the answer through the gate, with the topic and, where the policy says whose record it is, the caller's id. The tool finds the one passage in force: for this topic, for this caller's facts, on today's date, in the call's language, approved and not stale.
4. **Speak.** The passage's answer is said word for word through the `kb_answer` line, followed by the topic's account line when it has one and the caller's own data allows it. When there is no passage to say, the caller hears the `kb_unavailable` line and is offered a person, once per call.

**When retrieval runs.** Only on a turn where all of these hold: the app has a knowledge base, the turn has the caller's words (speech or text, not after the call has ended or while a downstream service's answer is awaited), and a topic slot is among the slots the turn asks. A turn that is none of these is exactly the turn it was without a knowledge base: no retrieval, no extra question, the same request to the model. An app with no `kb/` folder is unchanged byte for byte.

**When the topics are asked.** Only when retrieval nominated something. Nominating is the cheap, fast check that a knowledge question is plausible, so a call that never asks one never pays for the question. A turn on which nothing was nominated asks nothing, and the slot has no value.

**The budget.** The caller waits on retrieval, so it has 150 milliseconds (`RETRIEVE_BUDGET_MS`, fixed: it is a latency budget, not a threshold you tune). It fails open. A retriever that throws, returns something that is not a list of topics, or is not back in time nominates nothing, the turn goes on without a knowledge question, and the trace says which it was (`failed: 'error' | 'invalid' | 'late'`). The engine's own retrievers answer in well under a millisecond, so the budget is there for a retriever of your own that calls out. The budget bounds a retriever that returns a promise; one that answers synchronously runs to the end before the turn goes on (JavaScript cannot stop it), so a retriever of your own that may take long must be asynchronous.

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
- **When there is no answer** the tool says why: `unknown-topic`, `not-in-force`, `no-translation`, `ambiguous`, `stale` (with the withheld passage's record), or `no-facts`. Whatever the reason, the caller hears the `kb_unavailable` line and is offered a person. A yes to that offer, plain or "yes, connect me to someone", is a handoff for a person (`live-agent`, its `handoff_live_agent` line), not a frustrated caller's: the caller asked something there was no answer to. A refusal by the gate is the engine's usual one.
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

A passage is said only while it is approved and nothing it was approved over has changed. Its `approval` records the content's owner (a team), the person who approved it, the day, and two hashes: `sourceHash`, of its source section's text, and `hash`, of everything approved: the passage's `id`, its locale (the `kb/locale/<tag>` it is in, or the default), its `version`, the topic, the topic's title (in the default locale, and in the passage's own where that locale gives one), the answer, `applies`, the effective dates, the source text and the topic's account line. Whitespace aside, any change to one of them makes the passage **stale**. A topic's title is spoken (the topic question offers it, and a caller asked which of two topics they meant hears both), so renaming a topic sends its passages back for review; and an approval copied with its file to another id or locale does not hold there. At run time a stale passage is **withheld**: the caller hears the unavailable line and is offered a person once, and the trace records the passage with `fresh: false`. `pnpm check` fails on a passage that is stale or was never approved, and on an approval with no line of its id and hash in `kb/approvals.jsonl` (written by hand or copied, not by `kb:approve`, so no one is on record for it); its fix names the two commands below.

- `pnpm kb:status [app folder]` lists the passages by state: approved and fresh; approved outside `kb:approve` (no line in the log); stale because the source section changed; stale because the passage was edited (`git diff` shows the edit); never approved; and the drafts in `kb/pending/`. Each comes with its fix.
- `pnpm kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>]` approves each passage as it is now, after a person has read it against its source. It first asks you to confirm at your terminal (the ids, your name, the team, and that you read each against its source); where there is no terminal (a script, a pipe, an assistant's shell) it refuses, unless `--yes` confirms on the command line, and `--yes` is refused when `CI` is set. It writes the `approval` in place, keeping the file's comments and layout, and appends one line to `kb/approvals.jsonl` (`id`, `version`, `approvedBy`, `owner`, `on`, both hashes, `from`: `passage` or `pending`, and `sourceText`). `--owner` is needed the first time; a re-approval keeps the owner unless `--owner` says otherwise. A passage approved outside it is approved again the same way, which puts a person on record for it.
- A draft is approved by id too: `kb:approve` checks it as the passage it would be and moves it into `kb/passages/` (or `kb/locale/<tag>/passages/`), dropping `drafted`.
- `kb:approve` writes nothing for an id it refuses. It refuses an id that is no passage or draft, a passage that would fail `pnpm check` for anything but its approval (an unknown topic or source, a variable in the answer, an overlap with another passage, a locale the app does not speak), a draft with no excerpt, or one not in its section word for word, shorter than 4 words and 20 characters, or missing a number its answer says (as `kb:draft` and `kb:review` hold an excerpt), and a `--by` that names no person. **An assistant or a tool may draft a passage, and only a person approves one.**
- An app moving approved content from an earlier format may carry its approvals over with a script of its own: one line per passage with `from: migration`, the original `approvedBy`, `owner` and `on`, the hashes taken under this format, and a `note` that says what the original approval covered and what its owners are to confirm. `kb:status` marks those passages `(migrated: <note>)` for as long as they stand on that approval, and the people who own the content confirm the migration in review: `kb:review` lists them under "Approvals to confirm", and a passage's "Confirm this approval" appends a line under the reviewer's name (`from: passage`, the same hashes) without changing the passage. The log is appended to, never rewritten: when the hash's definition changes, the migration is taken again as new lines, and the last line with a passage's id and hash is the one that stands.

The files an approval stands on are the ones `CODEOWNERS` should protect ([3.12](#312-who-reviews-it-codeowners)): the passages, their sources, the topics, `kb.yaml` and the approvals log. Drafts are left open, since a draft is never said and approving it changes `kb/passages/`.

### 12.9 Building one from documents

Answers scale only if they are cheap to make, so the knowledge base has an authoring pipeline, in its own package (`@dialogwright/kb-author`, which an app never imports and the engine does not depend on). It never runs on a call. Every step before the last is a proposal, and the last is a person. Start from an app whose `kb/` already has `kb.yaml` and `topics.yaml` ([12.1](#121-the-folder)): `kb:ingest` writes `kb/sources` into any app folder, but until those two files exist `pnpm check` reports each as missing and `kb:status` does not take the folder as a knowledge base.

```sh
pnpm kb:ingest docs/ --dir apps/my-app                                  # 1. documents or a website into kb/sources
pnpm kb:draft apps/my-app                                                # 2. a model drafts passages into kb/pending
pnpm kb:review apps/my-app                                               # 3. a person approves, edits or rejects each draft
pnpm kb:approve <id...> --by "<your name>"                               #    (the same approval, from the command line)
pnpm kb:refresh apps/my-app                                              # 4. read the sources again; withhold what changed
pnpm kb:gaps apps/my-app [--traces traces/*.jsonl] [--since 2026-10-01]  # 5. what callers asked that nothing answered
```

**Ingest.** `kb:ingest <folder | file | url> --dir <app folder>` reads PDF, DOCX, HTML, Markdown and text files, or a website to a link depth (`--depth`, default 1; `--include '/help/**'` narrows it), and writes each document as `kb/sources/<doc>.yaml`: its title, its provenance (its URL, or its file's path from the app folder, and the day it was read) and its text by section. Sections are cut at headings (h1 to h3, a DOCX's Heading 1 to 3, Markdown's `#` to `###`, a PDF's larger type) and named by the heading path (`late-fees`, `shifts/training`); a PDF's section records the page it starts on (`page`, `lastPage`), and a PDF without headings is cut by page. A website is crawled politely: the start page's host only (unless `--allow-host`), robots.txt followed, one request a second (`--rate`), at most 50 pages (`--max-pages`), no cookies or sign-ins; linked PDF and DOCX files are read too. It reads only public addresses: a host on a loopback, private, link-local or other non-public network is refused (each host resolved before each request, and the connection pinned to the address checked), unless `--allow-private` names a site on your own network. A file is read only up to its limits (50 MB; a DOCX's zip at most 50 MB uncompressed and checked before it is opened, so a zip bomb is refused; a PDF at most 500 pages, opened with code evaluation off). Re-ingesting is safe: the same documents give the same bytes, an unchanged document is not rewritten, and each run says per section what was added (`+`), changed (`~`) and removed (`-`). `--dry-run` shows it without writing. A source written by hand is never overwritten. Crawling is for you to run; it never runs in CI.

**Draft.** `kb:draft` gives each source's sections that nothing cites yet (no passage, draft or rejected draft; `--all` for every section) to a drafter: by default Claude through the Messages API, with **your own** `ANTHROPIC_API_KEY`, from the environment or from a `.env` file where you run it (the file is git-ignored; never commit a key, and never put one in CI, a test or a fixture). The default model is `claude-haiku-4-5`; `--model` takes another, and `--topic-hint "<what to cover>"` steers it. It proposes, for each answer a document supports, a topic (one `topics.yaml` has, or a new one with a title, keywords and example questions), a spoken answer of one or two sentences, and the exact words of the section that support it. Every draft is checked before it is written, and a draft that fails is reported with its reasons and never written:

| Check | Why |
|---|---|
| the excerpt is in the section word for word | the answer is held to what the document says |
| the excerpt is at least 4 words and 20 characters, and says every number the answer says (amounts, times, dates, counts in figures) | an answer cannot hang a fee or a date on a fragment that does not hold it |
| the answer is within `maxAnswerChars` and has no brace | a spoken answer is short, and is fixed text |
| the topic is one that exists, or a new one proposed with a title | a draft cannot name a topic out of the air |
| `applies` and dates are ones kb.yaml allows | the passage can be resolved |
| it does not repeat another passage's or draft's answer | no near-duplicates |

A draft that passes is `kb/pending/<id>.yaml`, and a new topic goes to `kb/pending/topics.yaml`, never to `topics.yaml`. Drafting is pluggable (a `Drafter` is `{ id, draft(request) }`; the tests use a fake), **never runs in CI** (`kb:draft` refuses when `CI` is set), and nothing pending is ever said. A model can be wrong; the excerpt check proves the answer cites the document, not that it says what the document means, which is what the person reviewing is for.

**Review.** `kb:review` starts a small server on 127.0.0.1 on a free port (`--port` for a fixed one) and prints its URL with a one-time token that every request needs. It answers only this machine and stops with Ctrl-C. It is not the operator console: the console's sign-in (`CONSOLE_AUTH=token`, section 14) is for one owner watching calls, with no roles to say who may approve what callers are told, so a page that approves stays on this machine. The page lists the proposed topics, the drafts, the passages withheld (stale or edited) and those approved outside `kb:approve` (fresh, but with no line in `kb/approvals.jsonl`, which `pnpm check` refuses), each beside its source section with the excerpt marked, and, for a source that changed, a word diff of the section as it was approved (read from `kb/approvals.jsonl`) against the section now. It asks each browser once for your name and your team (kept in a signed, HttpOnly session cookie, so another browser is another reviewer), then you can: approve (it is `kb:approve` itself); edit, then approve (the answer, `applies`, the dates and a draft's excerpt, checked as a draft is); reject (the draft moves to `kb/rejected/<id>.yaml` with who, when and why); and for a proposed topic, accept it into `topics.yaml` with its title as you review it (callers hear a topic's title when the topic question offers it), under another id if you rename it (its drafts follow), or merge it into a topic the knowledge base has. A draft of a proposed topic is approved after its topic. Every change carries a hash of what its page showed, and is refused when the file or its source section changed since it was opened (reload and review it again). Every page reads without JavaScript, and every field has a label. After accepting topics in an app with an embedder, run `pnpm kb:index`.

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
- **A fallback is said.** When kb.yaml names an embedder and the engine's retriever is keywords alone all the same (the weights not in the cache, or not the pinned ones; the index missing, not an index, or another model's), `defineApp`, `defineKnowledge` and `registerApp` warn on stderr with the reason and the command that fixes it. With `NODE_ENV=production`, or `DIALOGWRIGHT_REQUIRE_EMBEDDER=1`, `registerApp` throws instead, so a server does not start without retrieval by meaning. `pnpm check` stays independent of the model cache: it reports the index, never the weights, and says nothing of a fallback.
- **Choose `cap` and `floor` offline, never by re-recording calls.** They change what the model is asked, which re-keys a recording. Write a paraphrase set ([12.11](#1211-testing)) and run `pnpm kb:bakeoff <app folder> --paraphrases fixtures/kb/paraphrases.yaml --sweep`. It reports each retriever's recall at the cap (the share of a topic's paraphrases whose nominations include it), how many topics it offers per question (and per question about nothing), and its speed; the sweep then shows recall against candidates for every floor and cap, so a floor is picked by what it costs.
- **ONNX.** A larger model (bge-small, through the optional `@huggingface/transformers`) is available to code as `OnnxEmbedder` from `dialogwright/kb/onnx`, used with `HybridRetriever`, and the bake-off includes it when the package is installed and `--onnx-revision <commit>` names the model's commit. `OnnxEmbedder.create({ revision })` needs that commit (40 hex characters): there is no default, since a branch such as `main` moves under a committed index. It is not the default: it is a large native install, and its numbers can differ in the last bits between machines.

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

## 13. Channels

The same app answers on the phone, through Twilio, Telnyx or both, and on the web, through the engine's own chat endpoint and the widget a site embeds. The engine knows no carrier and no site: a carrier is a voice provider behind one interface ([CONTRIBUTING.md, "Adding a voice provider"](../CONTRIBUTING.md#adding-a-voice-provider)), and the web chat is our own small protocol. Every choice below is an option with a default. A deployment sets its options in the environment (each app's `.env.example` lists them, commented, with their defaults); an app sets its own in app.yaml, intents.yaml and identity.yaml, and `pnpm check` holds them to the app. An app and a deployment that set none of them behave as they did before any of this existed: Twilio only, the app's default language, no web chat.

### 13.1 The options

| Choice | Where it is set | Default | When to choose otherwise |
|---|---|---|---|
| Which carriers answer | `VOICE_PROVIDERS` (env), a comma list of `twilio`, `telnyx` | `twilio` | Add `telnyx` to answer Telnyx numbers too, or name it alone. |
| A carrier's secret | `TWILIO_AUTH_TOKEN`, `TELNYX_PUBLIC_KEY` (env) | none; required for a listed carrier only | Always, for each carrier listed. The Telnyx key is the account's base64 Ed25519 public key. |
| Webhook signatures | `SIGNATURE_CHECK` (env), `on` or `off` | `on` | `off` only to post webhooks by hand on a laptop. |
| Twilio's voice | `TTS_PROVIDER` and `TTS_VOICE` (env), set together | Twilio's default voice | To choose the voice of the app's default locale on Twilio (`Google`, `en-US-Neural2-F`). |
| Telnyx's voice | `TELNYX_VOICE` (env), a Telnyx voice name | Telnyx's default voice | To choose the voice of the default locale on Telnyx (`Telnyx.NaturalHD.astra`; Telnyx's Ultra voices are named by an id, `Telnyx.Ultra.<id>`, as Mission Control lists them). |
| Twilio's recognizer | `TWILIO_TRANSCRIPTION_PROVIDER`, `TWILIO_SPEECH_MODEL` (env) | `Deepgram`, and `flux` with Deepgram (no model with another provider) | When the app's default locale is not English (flux hears English), or to try another model. |
| Telnyx's recognizer | `TELNYX_TRANSCRIPTION_PROVIDER` (env) | Telnyx's own default | To name `deepgram`, `google` or `telnyx`. |
| Telnyx's events | `TELNYX_EVENTS` (env): `speaker-events`, `tokens-played`, space-separated; quote it in the settings file (`TELNYX_EVENTS="speaker-events tokens-played"`), which lets a shell `source` the file too (the server's loader takes it either way) | none | To have Telnyx report when the agent and the caller speak and what it played: each is written to the call's frame log, and they are what finds a line Telnyx cuts short ([13.9](#139-a-line-the-carrier-cut-short)). |
| A line the carrier cut short | `RESAY_CUT_LINES` (env), `on` or `off`; `RESAY_MIN_FRACTION` (env), 0.05 to 0.95 | `on`, `0.35`: a turn's lines reported finished in under 0.35 of their estimated length, with the caller not heard, are said again once. Active only on a carrier that reports its playback (Telnyx with `TELNYX_EVENTS`) | `off` to never say a line twice; a lower fraction if lines the caller did hear are said again ([13.9](#139-a-line-the-carrier-cut-short)). |
| An interrupt the caller did not make | `RESAY_SPURIOUS_INTERRUPTS` (env), `on` or `off`; `SPURIOUS_INTERRUPT_WINDOW_MS` (env), 0 to 5000 | `on`, `700`: on a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events), an `interrupt` with no caller heard within 700 ms before it, nor within 0.4 s after it (2 s before the caller has been heard at all, as over the greeting), is no barge-in, and the lines it cut are said again from the start, once | `off` to take every interrupt as the caller's; a longer window if real barge-ins are said again over the caller ([13.9](#139-a-line-the-carrier-cut-short)). |
| The goodbye before the hang-up | `END_AFTER_PLAYBACK` (env): `auto`, `on` or `off`; `END_PLAYBACK_MAX_MS` (env) | `auto`, `15000`: on a carrier that drops what it has not said when `end` comes (Telnyx), a turn that ends the call holds its `end` until the lines before it have played, never longer than 15 s | `on` if callers on another carrier lose the goodbye or the transfer line; `off` to send the `end` with the lines, as before ([13.10](#1310-the-goodbye-before-the-hang-up)). |
| The no-input wait | `NO_INPUT_MS` (env); `NO_INPUT_AFTER_SPEECH_MS` (env) | `7000`: after a question has played (by its estimated length), 7 s of silence runs a silence turn ("I didn't hear anything." and the question again); `2500`: on a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events), the wait is held while they speak and runs at least 2.5 s after they stop | `0` turns the wait off. A longer `NO_INPUT_AFTER_SPEECH_MS` if a silence turn still comes just before a transcript; shorter if callers wait too long after a cough ([13.11](#1311-the-no-input-wait-and-a-caller-heard-speaking)). |
| Who may talk over a line | `BARGE_IN` (env): `any`, `speech`, `dtmf` or `none` | `any`: speech or a keypress cuts a line off, as the engine always connected | When a carrier's barge-in stops the agent's speech on noise or echo (`speech` keeps a keypress, `dtmf` or `none` stop speech cutting a line); or to rule barge-in in or out when callers report not hearing replies (try `none`, and see whether they hear the whole reply). It is the relay element's `interruptible` on every carrier (both take all four values; a value a listed carrier does not take is refused at startup). With `dtmf` or `none` the lines the engine sends say `interruptible: false` as well, so no line offers what the setting forbids; with `any` or `speech` each line keeps the `interruptible` its prompt has. |
| Reconnects after a dropped relay | `RECONNECT_LIMIT` (env) | `2` | Fewer to hand a troubled call to a person sooner. |
| Offering the number the caller is calling from | `callerNumber` on a `digits` slot (slots.yaml), with an `offer_<slot>` line | not offered: the slot is asked | For a callback number: the line asks whether the number the call came from is the best one, by its last four ([A callback number](#a-callback-number-callernumber), [13.13](#1313-the-number-the-caller-is-calling-from)). Never for an identity factor. |
| What a transfer hands the carrier | `handoff.data` (app.yaml): `slots` (`all`, `none` or a list), `send` by slot (`omit`, `masked`, `as-is`) | no identity factor; a redacted slot masked; any other slot as it is | When the person taking the call needs a value in the clear (name it `as-is`), or fewer values on the carrier. |
| Values the caller never confirmed, in a transfer | `handoff.data.unconfirmed` (app.yaml): `send`, `mark` or `omit` | `send`: sent as any other, nothing named | `mark` when the person should know which values to check with the caller (the end frame's `unconfirmed`, the console's "(not confirmed)", the audit's handoff row); `omit` to send only what the caller agreed to ([app.yaml](#appyaml)). |
| The language a call starts in | `voice.numbers` (app.yaml): number called to locale | the app's default locale | A number per language. |
| A locale's languages on the phone | `voice.locales.<tag>.tts`, `.transcription` (app.yaml) | the locale's tag | When the carrier needs a regional tag (`es` spoken as `es-US`, heard as `es-MX`). |
| A locale's voice, per carrier | `voice.locales.<tag>.voices.<carrier>` (app.yaml): a name, or for Twilio `{ voice, provider }` | the deployment's voice for the default locale; the carrier's default for any other | For every locale besides the default, so it is not read by the carrier's default voice. |
| A locale's recognizer, per carrier | `voice.locales.<tag>.recognition.<carrier>` (app.yaml): `{ provider, model }` | the deployment's for the default locale; the carrier's default for any other | When a language needs a recognizer the carrier does not default to. |
| A locale's recognition hints | `voice.locales.<tag>.hints` (app.yaml) | `voice.hints` | Words of that language. |
| Switching language mid-call | an informational intent with `locale:` (intents.yaml) | no switch | When callers may ask for another language. |
| A caller who had not finished | `voice.continueWithinMs` (app.yaml), 0 to 2000 | `300`: a reply interrupted within 300 ms is the caller still talking, and the next prompt continues theirs | Higher for a recognizer that breaks prompts at longer pauses; `0` to take every final prompt alone ([13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said)). |
| A caller who came back in, with no interrupt | `RESUME_AFTER_PAUSE_MS` (env), 0 to 10000; `RESUME_INTO_REPLY_MS` (env), 0 to 5000 | `2000`, `1000`: on a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events), a caller who speaks again within 2 s of stopping, and within 1 s of the reply to that prompt going out, had not finished, and their next prompt continues it | A longer pause if callers who stop to think mid-address are still split; a shorter one (or a shorter time into the reply) if answers to the reply are joined to the prompt before it ([13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said)). |
| A caller clearly not finished | `INCOMPLETE_WAIT_MS` (env), 0 to 3000; `INCOMPLETE_WAIT_BELOW` (env), 0.05 to 0.95 | `1000`, unset (the gates' `GATE_COMPLETE`, 0.6): on a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events), the reply to a final prompt the model reads as unfinished is held up to 1 s, and never said if the caller goes on in that time: their next prompt continues it | `0` to send every reply at once; a lower `INCOMPLETE_WAIT_BELOW` if finished answers wait too often, a higher one if fragments still get a reply ([13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said)). |
| Words the voice says wrong | `voice.pronounce` (app.yaml), word to respelling; a locale's own in `voice.locales.<tag>.pronounce` | none | When the voice misreads a name callers give or the lines say (a street, a town). |
| Whether web chat is served | `CHAT` (env), `on` or `off` | `off` | To serve `/chat`. |
| Which sites may open a chat | `CHAT_ALLOWED_ORIGINS` (env): exact origins, comma-separated | none; required when `CHAT=on` | Always, with chat on: the sites whose pages carry the widget. `*` only on a laptop. |
| How long a quiet chat lives | `CHAT_IDLE_MS` (env) | `1800000` (30 minutes) | Shorter for a busy server, longer for slow conversations. |
| How many chats at once | `CHAT_MAX_SESSIONS` (env) | `1000` | To fit the server's size. A limit per visitor is the reverse proxy's. |
| How a chat user signs in | `CHAT_SIGNIN` (env): `none`, `jwt` or `mock`; with `jwt`, `CHAT_JWKS_URL`, `CHAT_ISSUER`, `CHAT_AUDIENCE` | `none` | `jwt` when the site has an identity provider; `mock` on a laptop only. |
| Which token claim names the subject | `signIn.claim` (identity.yaml); `principals.fromClaims` in code for anything else | `sub` | When the site's tokens carry the account id elsewhere, or a delegate signs in. |
| Whether the server serves the widget's script | `WIDGET` (env), `on` or `off`; `WIDGET_FILE` | `off`; `node_modules/@dialogwright/widget/dist/dialogwright-widget.js` | On a laptop or a simple deployment. A production site loads the script from its own CDN. |
| The widget's look, words and behaviour | `data-*` attributes or `DialogWright.mount({...})`; CSS custom properties | neutral theme following the visitor's colour scheme, English words | Always, to match the site: [13.7](#137-the-widget). |

The startup line names what is in force (`voice providers`, each carrier's voice and recognizer, `chat on (...)`, the sign-in method, `widget on (...)`), never a secret's value: a secret is shown by its length.

### 13.2 Serving voice: Twilio, Telnyx or both

Each carrier listed in `VOICE_PROVIDERS` answers on three paths of its own: `POST /voice/<carrier>` (the number's voice webhook), `POST /cr-action/<carrier>` (the relay's end-of-session callback) and the WebSocket `/conversation/<carrier>`. The unprefixed `/voice`, `/cr-action` and `/conversation` stay Twilio's, so a Twilio number set up before carriers were plug-ins keeps working with no change in the Twilio console. A carrier not listed answers 404 on its paths, and an unknown name in `VOICE_PROVIDERS` is refused at startup.

- **Twilio**: point the number's voice webhook at `https://<PUBLIC_HOST>/voice/twilio` (or `/voice`). Webhooks are signed with the account's auth token, `TWILIO_AUTH_TOKEN`.
- **Telnyx**: create a TeXML application whose voice URL is `https://<PUBLIC_HOST>/voice/telnyx` with its Voice Method set to POST (Telnyx defaults it to GET), assign the number to it (on the Numbers page, the small link icon next to the number), set `VOICE_PROVIDERS=telnyx` (or `twilio,telnyx`) and `TELNYX_PUBLIC_KEY`, the account's public key as Telnyx shows it (base64). Webhooks are signed with Ed25519 over the timestamp and the body; one more than five minutes away from the server's clock is refused. Some of what Telnyx does is not in its published pages yet, and is written down as assumptions in `server/voice/telnyx.ts` to confirm on a live call ([docs/live-checks.md](live-checks.md)).

A webhook's answer starts the relay with a one-time token in the socket's URL. The token is tied to the call and to the carrier that answered it: a Telnyx call's token opens no Twilio socket, and a Twilio call's opens no Telnyx one. When the socket drops mid-call, the carrier posts the action callback and the call reconnects, up to `RECONNECT_LIMIT` times, then goes to a person with an apology; the call resumes where it was, in the language it is in by then. Each carrier says whether the call is still live in its own words (Twilio: `in-progress`; Telnyx: `active` or `in-progress`), and a call that is not live hangs up. A callback that carries no call status at all reconnects only when its `SessionStatus` is `failed` and the engine still holds the call; anything else hangs up (to confirm on a live Telnyx call: [live-checks.md](live-checks.md), check 3).

Each carrier names voices and recognizers its own way, so each has its own settings, and one carrier's never reaches another: `TTS_PROVIDER` and `TTS_VOICE` (both or neither) and `TWILIO_TRANSCRIPTION_PROVIDER` and `TWILIO_SPEECH_MODEL` are Twilio's; `TELNYX_VOICE` and `TELNYX_TRANSCRIPTION_PROVIDER` are Telnyx's. A Telnyx voice name carries its engine (`Telnyx.NaturalHD.astra`, `AWS.Polly.Joanna-Neural`), so Telnyx has no provider variable; a Twilio-style name in `TELNYX_VOICE` is refused at startup. These settings are for the app's default locale; [13.3](#133-languages-on-the-phone) says how an app names them for each of its languages. The dashboard names the carrier of each call.

### 13.3 Languages on the phone

An app that speaks more than one language ([section 8](#8-locales)) says in app.yaml how the phone speaks and hears each, and which number a call starts in which language. Every key is optional. An illustration, on the library's languages (its own app.yaml sets only `hints`):

```yaml
# app.yaml
voice:
  hints: [renew, hold, branch, Riverside]
  numbers:
    "+15555550142": es        # a call to this number starts in Spanish
  locales:
    en-US:
      voices: { twilio: en-US-Journey-O, telnyx: Telnyx.NaturalHD.astra }
    es:
      tts: es-US              # the language the voice speaks; default: the locale's tag
      transcription: es-US    # the language speech is heard in; default: the locale's tag
      voices:
        twilio: { voice: es-US-Neural2-A, provider: Google }   # a Twilio voice with its own provider
        telnyx: Telnyx.NaturalHD.albion
      hints: [renovar, reserva, sucursal]   # default: voice.hints
      recognition:            # the speech recognizer, per carrier
        twilio: { provider: Deepgram, model: nova-3-general }
        telnyx: { provider: google }
```

- `voice.numbers` maps a number called (E.164, in quotes: unquoted, YAML reads `+1555...` as a number) to the locale its calls start in. Any other number starts in the default locale.
- `voice.locales.<tag>` is keyed by the app's own locale tags. `tts` and `transcription` are language tags; the start document names the call's language by them, and each line's text frame says its `tts`.
- `voices` names a voice per carrier, in that carrier's own names. A Twilio voice written as a name alone is one of the deployment's `TTS_PROVIDER` (or of Twilio's default provider when that is unset); written as `{ voice, provider }` it names its own provider (`Google`, `Amazon` or `ElevenLabs`), so the app does not depend on how the deployment is set. A Telnyx voice is always a name alone, since its name carries its provider. An app's voice wins over the deployment's (`TTS_VOICE`, `TELNYX_VOICE`), which is used for the default locale only: another locale with no voice of its own gets the carrier's default voice for its language, never the default locale's voice reading another language.
- `recognition` names the speech recognizer per carrier: `provider` and `model`, in the carrier's own names. On Twilio they are `transcriptionProvider` and `speechModel`; on Telnyx `provider` is `transcriptionProvider`, and a `model` is written on the locale's `<Language>` only, the one place Telnyx documents a `speechModel`. The app's recognizer for a locale wins, as a whole: a field it leaves out is the carrier's default, and `{}` asks for the carrier's default outright. Without one, the default locale has the deployment's recognizer and every other locale the carrier's default. The deployment's stops at the default locale on purpose: it is chosen for one language (Deepgram's flux is for English), and a recognizer that does not hear a language is worse than the carrier's default for it. A deployment whose app's default locale is not English should set `TWILIO_SPEECH_MODEL`, or the app should name the default locale's `recognition`.
- `hints` replaces `voice.hints` for a call that starts in that locale.
- **What the carrier is sent.** For an app that names its languages (more than one locale, `voice.locales` or `voice.numbers`, or a default other than en-US), the start document (Twilio's and Telnyx's, and the legacy `/voice`) names the call's language, one `<Language>` per locale the call may switch to, and a `locale` parameter the relay hands back when the call starts. A `<Language>` child inherits whatever it leaves out from the relay element, so a voice or recognizer goes on the relay element only when every language has the same one, and otherwise on each language's own `<Language>`; a language with none of its own then gets the carrier's default. Each text frame says its line's language, and a switch sends the `language` frame (`set_language`). A one-locale en-US app with none of these keys, and an app without locales, writes the same documents as before languages: no languages, and text frames in `en-US`.
- **`pnpm check` refuses**, each in one line with its fix: a locale the app does not have (`add locale/<tag>/ or use one of ...`), a number that is not E.164, a carrier the engine does not know under `voices` or `recognition` (`use twilio or telnyx`), a `{ voice, provider }` for a carrier other than Twilio, a Twilio provider that is not one of its three, a `tts` or `transcription` that is not a language tag, and a recognizer `provider` or `model` that is not a plain name (letters, digits, dots, hyphens and underscores). `validateApp` checks the same for an app built in code.

**Switching language mid-call.** An informational intent with `locale:` switches the call to one of the app's locales, with a `promptId` said in it, or alone (never with a `passage`). No intent switches unless the app writes one:

```yaml
# intents.yaml
intents:
  spanish:
    kind: informational
    label: continue in Spanish
    criteria: The caller asks to continue in Spanish, or says they speak Spanish
    locale: es
    promptId: switched_to_spanish   # "Muy bien, seguimos en español." in locale/es/prompts.yaml
```

Choosing it, by words, by its menu key or on the yes to an unsure reading, sets the session's locale. On a phone call the turn first asks the relay to speak and hear that locale (`set_language`, with its `tts` and `transcription` from `voice.locales`), so the line and the question the call resumes on are said, and the caller's next words heard, in it. Values already collected are said in the new language from then on (each slot's `display(value, locale)`), those heard in the same breath as the switch included. A chat switches its lines only. Choosing the locale the call is already in says the line and changes nothing else. `pnpm check` refuses a locale the app does not have, `locale:` on a form or control intent, and `locale:` with a `passage`. The app map draws the switch as an intent of its own. A scripted call or chat can start in a locale (a scenario's optional `locale`), to test the language without a number.

**Known limits.** These are still to be confirmed on live calls, or are the carriers' own; [docs/live-checks.md](live-checks.md) is the checklist.

- A call's `hints` are its starting locale's: a mid-call switch keeps them, since the carriers take hints on the relay element only.
- That a carrier applies a `<Language>` child's voice and recognizer to the call's first language as well as to a switch is read from Twilio's reference ("map a language code to a set of text-to-speech and speech-to-text settings"), and is to be confirmed on a live call, on Twilio and on Telnyx.
- Telnyx documents the `<Language>` child (`code`, and per language `voice`, `ttsProvider`, `transcriptionProvider` and `speechModel`, so a locale's recognizer model on Telnyx is a documented attribute), the `<Parameter>` child (its pairs come back in the setup frame's `customParameters`, where the engine reads `locale`) and the `language` frame. Still to confirm on a live Telnyx call: whether it reads a text frame's `lang` (its text frame example has `token` and `last` only), and whether a `<Language>` child inherits what it leaves out from the relay element, as Twilio documents.
- The no-input wait is cancelled at the caller's first syllable by the relay's partial prompts on Twilio. That a locale moved off Deepgram flux keeps sending them is to be confirmed live. Telnyx sends no partial prompts; with `TELNYX_EVENTS` speaker-events its reports of the caller speaking hold the wait instead ([13.11](#1311-the-no-input-wait-and-a-caller-heard-speaking)).

### 13.4 Web chat

`CHAT=on` serves the engine's own web chat on the WebSocket `/chat`, to the pages of the sites in `CHAT_ALLOWED_ORIGINS`. Off (the default), `/chat` is a 404 like any unknown path, and nothing about the server changes. Each chat is a session on the `WEB_CHAT` channel, run through the same turn path as a call: the same app, policy, gate, trace, audit (`channel: chat`) and console, and the same handoff summary. A chat gets the app's lines as words, never recorded clips, and is never asked for a keypad key.

- **Who may open one.** The page's `Origin` is checked against `CHAT_ALLOWED_ORIGINS` before the upgrade (403 otherwise, and a request with no `Origin` is refused). Origins are exact (scheme, host and any port, no path); `*` is allowed only with `PUBLIC_HOST=localhost`.
- **The wire** is our own JSON, one message per WebSocket frame (`src/channel/chat/protocol.ts`, version 1). The client sends `start` (`v: 1`, and optionally `locale`, `token`, `resume`) within 10 seconds, then `text` (1 to 500 characters), `sign_in` (`token`) and `ping`. The server sends `ready` (`session`, `resume`, `locale`), `say` (`text`, `lang`), `transfer` (`reason`, never the values collected), `end`, `signed_in` (`level`), `pong` and `error` (`code`: `bad_message`, `too_long`, `not_allowed`, `sign_in_failed`, `session_unknown`, `busy`, `server_error`). A refusal names the field and the rule, never the value. A message is at most 16 KiB; ten malformed ones close the socket.
- **A drop is not the end.** `start { resume }` reopens the chat with the resume token the last `ready` gave (a fresh one each time) until `CHAT_IDLE_MS` of quiet ends it (recorded as `abandoned`). A second resume takes the chat over and closes the socket it replaced. A resume of a chat that has ended starts a new one.
- **Limits.** At most `CHAT_MAX_SESSIONS` chats are live at once, a dropped one waiting for its resume included: over it a new `start` is answered `busy` and closed, and a resume is never refused for it. A chat holds at most five messages waiting for their reply; past that a message is answered `busy`. A limit per visitor is the reverse proxy's to keep: behind one, every chat comes from its address.
- **A transfer** sends the line, `transfer` and `end`, and closes; what happens next is the site's (the widget's `onTransfer`).
- **The language.** `start.locale` asks for a language, matched to the app's locales as a call's is ([section 8](#8-locales)): `es-MX` finds `es`, and a language the app does not speak keeps the default. `ready.locale` names the one chosen, and each `say` carries its line's language.

An app may still mount chat pages of its own (`AppRoute`, `chatTurn.ts`); the engine's endpoint does not change them.

### 13.5 Sign-in on the web chat

`CHAT_SIGNIN` says how a chat user proves who they are:

- `none` (the default): no sign-in. A token on `start` or in `sign_in` is answered `not_allowed`, and the chat goes on as it was.
- `jwt`: a signed token from the site's identity provider (an OpenID Connect ID token, say), passed by the page. It is verified against the provider's published keys at `CHAT_JWKS_URL` (https only), with `iss` equal to `CHAT_ISSUER`, `CHAT_AUDIENCE` among its `aud`, and its times checked with 60 seconds of skew. RS256 (2048-bit keys or more), ES256 (P-256) and EdDSA are taken; `none`, HMAC and a `crit` header are refused. The keys are fetched with a 5 second timeout and a 256 KiB cap, cached for the response's `max-age` (default 10 minutes, at most a day), and fetched again for a key id not seen, at most once every 30 seconds; when a fetch fails the cached keys are kept.
- `mock`: `mock:<id>`, unsigned, for a laptop: refused at startup unless `PUBLIC_HOST=localhost`.

A token never appears in a log line, an error or the frame log.

**From a token to a principal.** The app decides who a verified token names, in identity.yaml's `signIn` and, when that is not enough, in code:

- `signIn.level` is what a sign-in proves (the top of the ladder, [3.6](#36-the-identity-ladder)); an app without `signIn` takes no sign-in.
- `signIn.claim` names the token claim that carries the subject's id, as the token carries it: `account_id` beside `level` under `signIn`, or a namespaced `https://example.com/account`; default `sub`. A whole number is read as its digits. The id is looked up with `code.principals.subjectPrincipal(id, level)`.
- For anything one token claim cannot say (a delegate signing in, a tenant to check, two token claims together), set `code.principals.fromClaims`: it is asked first, with the verified token claims, and returns the principal, or null to fall back to `signIn.claim`. Code that throws is a failed sign-in (`sign_in_failed`), logged.
- What comes back is checked as any signed-in principal is: a subject at the sign-in level, or a delegate of a declared kind and role.
- A subject may sign in on `start` or later with `sign_in`; the chat is answered `signed_in` when the core takes it, and a second sign-in is refused. A delegate's token is taken only on `start`, and the chat then begins as theirs, as the harness's `as` does.

### 13.6 Serving the widget, and where its script comes from

The widget is its own package, `@dialogwright/widget` (`packages/widget`): a script with no runtime dependencies that carries no engine code and speaks only the chat wire. `pnpm --filter @dialogwright/widget build` writes `dist/dialogwright-widget.js` (a classic script: a `<script>` tag mounts it from its `data-*` attributes and it sets `window.DialogWright`) and `dist/dialogwright-widget.mjs` (an ES module for a site's own bundler), about 5.6 KB gzipped against a 15 KB budget a test enforces.

- **In production**, the site loads the script from its own CDN, versioned and cached as it caches its other scripts; from a host it does not control, with a Subresource Integrity hash (`integrity` and `crossorigin` on the tag).
- **On a laptop or a simple deployment**, `WIDGET=on` makes the engine serve `WIDGET_FILE` on `GET /widget.js` (uncached, `nosniff`, read on each request). The default file is `node_modules/@dialogwright/widget/dist/dialogwright-widget.js` from where the server runs, so an app that depends on the widget package (as the utility does) needs only the build; another names the built file. A file that does not exist is refused at startup. `/widget.js` is public by design, through a tunnel too, since a site's pages load it.

The utility's `/chat-demo` page is the worked example: a fictional account page with the widget on it, mounted only in laptop mode ([its README](../apps/utility/README.md#try-the-web-chat-on-your-laptop)).

### 13.7 The widget

One script tag, its options as `data-*` attributes:

```html
<script src="https://cdn.example.com/dialogwright-widget.js"
        data-endpoint="wss://chat.example.com/chat"
        data-title="Help" data-position="bottom-left"></script>
```

Or from code, for the options only code can give (a sign-in token, what a transfer does):

```html
<script src="https://cdn.example.com/dialogwright-widget.js"></script>
<script>
  DialogWright.mount({
    endpoint: 'wss://chat.example.com/chat',
    getToken: async () => mySite.idToken(),
    onTransfer: (reason) => mySite.openLiveChat(reason),
  });
</script>
```

The server must list the site's origin in `CHAT_ALLOWED_ORIGINS`, and, for `getToken`, sign in with `CHAT_SIGNIN=jwt` against the same identity provider.

| Option | `data-` attribute | Default | What it does |
|---|---|---|---|
| `endpoint` | `data-endpoint` | required | The chat endpoint, `wss://host/chat`; an `https:` or page-relative URL is given the socket scheme. |
| `locale` | `data-locale` | the page's `<html lang>`, else none | The language asked for; the server answers in the app's closest one. |
| `title` | `data-title` | "Chat with us" | The panel's heading. |
| `strings` | `data-strings` (JSON) | English | Any of the widget's 21 words (`packages/widget/src/strings.ts`). |
| `position` | `data-position` | `bottom-right` | `bottom-right`, `bottom-left`, or `inline` (inside `container`, always open). |
| `container` | `data-container` (a CSS selector) | none | Where an `inline` widget goes. |
| `startOpen` | `data-start-open` | `false` | Open, and connect, on load; otherwise it connects when first opened. |
| `getToken` | code only | none | The site's sign-in token, or null; with it, the panel offers sign-in. |
| `onTransfer` | code only | the panel says `transferred` | What a transfer does on the site. |
| `onEvent` | code only | none | Every event the client reports, after the panel has shown it. |
| `backoffMs` | code only | `[500, 1000, 2000, 5000]` | Delays between reconnect attempts, in ms, the last repeating. |
| `maxReconnects` | code only | no limit | Reconnects in a row a dropped chat may try before the panel says `unavailable`. |

**Theming.** The panel renders in a shadow root on a `dialogwright-chat` element, so a site's CSS cannot break it; it is themed with CSS custom properties on that element: `--dw-accent`, `--dw-accent-fg`, `--dw-bg`, `--dw-fg`, `--dw-user-bg`, `--dw-agent-bg`, `--dw-radius`, `--dw-font` and `--dw-z`. Colours a site leaves unset follow the visitor's light or dark scheme.

**Behaviour.** A dropped chat reconnects after each step of `backoffMs` and resumes, for as long as the page is open unless `maxReconnects` says otherwise; what is typed meanwhile is sent once it is back. A chat that never starts (an origin the server refuses, an endpoint it cannot reach, a full server) is tried once per step of `backoffMs`, then the panel says `unavailable`, with no loop. A chat whose session has ended starts afresh (`restarted`), signed in again with the site's token if it was signed in. A site that wants its own interface uses the client alone, `createChatClient`. The package's [README](../packages/widget/README.md) has the events, the words and the accessibility notes.

### 13.8 A caller who had not finished, and how a word is said

Two settings in app.yaml for how the phone hears and speaks, each with a default:

```yaml
# app.yaml
voice:
  continueWithinMs: 300        # the default; 0 takes every final prompt alone
  pronounce:
    Alder: All-der             # matched whole, whatever its case
    St. Ives: Saint Ives
  locales:
    es:
      pronounce: { Alder: Al-dair }   # in place of voice.pronounce for lines said in Spanish
```

**A caller who had not finished (`continueWithinMs`).** A recognizer that ends a prompt at a short pause sends half an answer as a final prompt: asked where the problem is, a caller says "at", "22", "Alder Street." with two short breaths, and each comes as a final prompt. Taken alone, "at" gets a re-ask, and the caller, still talking, talks over it at once: the carrier sends an `interrupt` a hundred or so milliseconds into it. Then "22" gets another, and "Alder Street." is taken as the answer, without the house number. No one answers a line that fast, so an interrupt within `continueWithinMs` of the start of the reply to a final prompt means the caller had not finished: the next final prompt continues theirs. The engine joins the words (the fragments so far and the new prompt, with single spaces) and runs the turn as if "at 22 Alder Street." had been said at once, on the session as it was before the first fragment. The re-asks the caller talked over are undone (no retry is counted and no barge-in reported), none is said again, and the joined turn says what it decides.

- Only a reply that did nothing but speak is undone. After a turn that went through the gate (a tool, an identity check), handed work to a service, switched the language, ended the call or was quarantined, the next prompt is a turn of its own, as before.
- A key pressed, a no-input silence, a reconnect, or any other event between them ends joining. An interrupt after `continueWithinMs` is an ordinary barge-in: the next final prompt is its own, unless the caller came back in at once (below). At most three prompts are joined, and never past the wire's 4000 characters.
- The trace keeps each fragment's own turn, and the joined turn's record says which prompts it joined (`joined: { fragments: [...] }`, with the joined words as its event's text). At the code prompt, where the joined words hold a code said aloud, each fragment's digits are masked too, since the code may have been said across them. The audit log keeps whatever a fragment's turn recorded (an answer read from the knowledge base, a code said aloud): it is the record of what happened, and a turn is never taken out of it. The frame log notes the window when the call starts (`{ continueWithinMs: 300 }`) and each joined turn (`{ joined: 3 }`); replaying the log joins where the call did, and a log with no window line (the option off, or one written before it) replays with none.
- It is the engine's, on every carrier: it reads the core's interrupt and prompt events, and a chat, which has no interrupts, never joins. What it keeps of a call lives in memory, so a call resumed after a restart takes its next prompt alone.
- **With the carrier's barge-in off.** With `BARGE_IN` at `none` or `dtmf` the carrier never sends an `interrupt` for the caller's speech, so a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events) stands in for it. Seen on live Telnyx calls: "...for one two" came as a final prompt 0.31 s after the caller stopped, the reply went out 0.21 s later, the caller was heard again 24 ms after it, and "three four" came as a prompt of its own, the number split in two. On another call the caller stopped mid-address, the prompt came 0.79 s later, the reply went out 0.19 s after it, and the caller went on 0.70 s after the reply (1.68 s after they had stopped): the rest of the address came as a prompt of its own and was taken as the answer to the reply. A window from the reply alone misses the second, so the engine reads the caller's own pause: they had not finished when they **speak again no later than `RESUME_AFTER_PAUSE_MS` (default 2000) after the speech that gave their last final prompt stopped, and no later than `RESUME_INTO_REPLY_MS` (default 1000) after the reply to that prompt went out** (or before it went out; a real answer to the reply cannot start before the caller has heard some of it), **and go on into the next final prompt**: across pauses no longer than `RESUME_AFTER_PAUSE_MS`, with the prompt arriving while they speak or no later than `NO_INPUT_AFTER_SPEECH_MS` after they stop. A caller speaking as the prompt comes is back in already. That prompt continues the one before it, as after an early interrupt, though no line was cut. The joined turn's reply goes out as any line does; on Telnyx a new frame was not seen to stop the reply still playing, so the caller may hear the rest of it first. A caller who says "mm" at once, then listens for longer than the pause, then answers gives an answer of its own, and so does one who starts speaking more than a second into the reply. `continueWithinMs` still decides for a carrier's own interrupt, and `0` still turns joining off. With the barge-in on, the same speech also cuts the reply off, and the carrier's `interrupt` can come later than `continueWithinMs`: on a live Telnyx call the caller was heard again 0.52 s into the re-ask, the interrupt came 0.30 s after that (730 ms into the line), and the rest of the address came as a prompt 1.96 s later. That interrupt is the caller who had not finished, not a barge-in, whether it comes before or after the caller is heard again: the prompt still continues the one before it. The frame log has `{ callerResumed: { pauseMs, intoReplyMs } }` just before the prompt it joins (how long the caller had paused, and how long after the reply went out they came back in, 0 when before it), and replay joins there too; the startup line says `caller resumes within 2000 ms of a pause, 1000 ms into the reply`.
- **A reply held for a caller clearly not finished.** Joining puts the words together, but by then the reply to the first fragment has gone out, and the caller, still talking, talks over it: on a live Telnyx call "seventy six" came as a final prompt, the re-ask ("Sorry, what's the address?") went out 0.16 s later, and the caller went on with "twenty five oak hollow lane" 0.52 s into it. The model already reads every final prompt for whether the caller finished (`utteranceComplete`, in the same request, so a finished answer waits for nothing); the gates only note a low reading on a final prompt. On a carrier that reports the caller speaking, when a final prompt's turn reads under `INCOMPLETE_WAIT_BELOW` (unset: the call's `GATE_COMPLETE`, 0.6) and the turn did nothing but speak (the same rule as undoing: no gate, no service, no language switch, no end, no quarantine), its reply is held after the turn has run and before any frame goes, for up to `INCOMPLETE_WAIT_MS` (default 1000). If the caller is heard going on in that time (the carrier reports them speaking, or a prompt comes; or they were speaking again already), the reply is never said, and their next final prompt continues this one, joined and run on the session before the first fragment as above. If not, the reply goes when the wait has passed. A key pressed sends it at once. The no-input wait does not run during the hold; a caller heard going on with no prompt after it (a cough) is asked again `NO_INPUT_AFTER_SPEECH_MS` after they stop, not a whole `NO_INPUT_MS` later. Not on Twilio (it reports no caller speaking, so no wait could end early), not for an app whose `continueWithinMs` is `0`, and never past three fragments. The frame log has `{ replyHeld: { ms, outcome, utteranceComplete, turn } }` when the hold ends (`outcome` is `joined` or `sent`, `turn` the held turn's number), and replay joins after that turn as the call did; the startup line says `replies held up to 1000 ms for an unfinished caller (under GATE_COMPLETE)`, with `inactive without TELNYX_EVENTS speaker-events` where Telnyx is not asked for them. Why 1000 ms: on live calls callers who had not finished came back in 0.23 s, 0.68 s and 0.89 s after their fragment's prompt arrived, and it is `RESUME_INTO_REPLY_MS`'s default, past which a caller is taken as answering the reply anyway. Why `GATE_COMPLETE`: in the recorded cassettes the clear fragments ("um", "I was wondering if", "so my appointment", "hang on a second") read under it, and short finished replies ("pardon", "come again", "two") at or over it, so they are never held.

The default is 300 ms because an interrupt that early cannot be a reply to the agent's words: the caller has heard a syllable at most, and the recognizer itself takes time to notice speech. It is the same on every carrier. A recognizer that rarely breaks a prompt at a pause joins rarely, and only when the caller did keep talking over the reply; whatever they said then ("no wait", a correction) is read together with what they said before, against the question they were answering, which is the question they meant. A "yes" that went through the gate (a confirmed write) is never undone, so a "no wait" after it is a turn of its own, as before. A recognizer that breaks prompts at longer pauses may want more (up to 2000); `0` takes every final prompt alone, as the engine did before the option.

**How a word is said (`pronounce`).** The text-to-speech voice says some names wrong. `voice.pronounce` lists them, each with a respelling the voice says right. A listed word is matched whole and whatever its case ("Alder" and "ALDER", never "Alderman"), in every line the agent speaks, a value the caller gave and the agent reads back included, and only there: the text sent to the voice is respelled, while the session, the trace, the console's readable text and a chat keep the words as written. The frame log records the frames as they went out, respellings and all, as it does the spelled-out digits of `spokenDigits`, except that a redacted value read back is masked as written, before its words are respelled. The respellings come after `spokenDigits`, whose rules match the lines as written, so a respelled word that leads an identifier still leads its digits. What a caller's interruption heard of a line comes back from the carrier with the respellings in it; each whole one is mapped back to its word before the session, the trace or the console sees it (a respelling cut off part way is left as heard). An accented word is matched however the line encodes the accent. A locale's own list (`voice.locales.<tag>.pronounce`) replaces the app's for the lines said in that locale, since a respelling is written for one language's voice; `{}` there respells nothing in it.

A respelling is plain letters, not a phonetic alphabet: Twilio passes SSML (a `<phoneme>` among it) through in a text frame, but Telnyx documents nothing of the kind for its relay, and markup a carrier does not read would be spoken aloud. `pnpm check` refuses, each with its fix: a word that is not a word or a few words (letters and digits, with spaces, apostrophes, hyphens or periods between them; at most 60 characters), a word listed twice but for case, and a respelling that is empty, longer than 120 characters, on more than one line, or has `<` or `>` in it. `validateApp` refuses the same for an app built in code, and a `continueWithinMs` that is not a whole number from 0 to 2000.

### 13.9 A line the carrier cut short

A carrier may stop playing a reply almost as soon as it starts and still report it played. Seen on Telnyx (the notes in `server/voice/telnyx.ts`): right after the caller spoke, the engine sent a 24-word line, 9.6 s by its estimate; Telnyx reported the agent speaking 0.07 s later, reported the whole line played 0.67 s after that, and the agent silent again, with no interrupt and no caller heard between. The caller heard nothing, and sat in silence until the no-input wait asked again 16.6 s after the line went out.

With `RESAY_CUT_LINES` on (the default), the engine finds such a line and says it again:

- **What the carrier reports, in the engine's terms.** A voice provider reads its carrier's own events into three kinds (`VoiceProvider.readEvent`): the playback started; the playback finished, with the line it says it played or without; the caller started or stopped speaking. Telnyx's are its `agentSpeaking` (`on`, `off`), `tokensPlayed` and `clientSpeaking` (`on`, `off`), which it sends only when `TELNYX_EVENTS` asks for them. Twilio reports none, so on Twilio nothing changes. Every event is still written to the call's frame log as it came (`{ carrierEvent: ... }`).
- **A cut line.** The engine keeps what each turn sent and how long it should take to say (the estimate the no-input wait uses: 2.5 words a second, a clip by its length). The turn's playback is finished when the carrier says it stopped, or that it played the turn's last line. Finished in under `RESAY_MIN_FRACTION` of the estimate (default 0.35), measured from when the carrier said it started (or from the send, when it did not), with no `interrupt`, no caller speaking, no digit and no prompt since the lines went out, the lines were cut. The engine waits a quarter of a second more: a carrier that starts playing again (the next line of the turn) or a caller heard in that time means it was not.
- **Said again, once.** The turn's lines go again as they were sent (the same text and clips, with `last` as the carrier needs it), and the no-input wait is armed again from the new playback. The server log says `<call>: playback cut short (0.67 s of ~9.6 s), lines said again`, and the frame log has `{ resaid: { heardMs, expectedMs } }` before the frames. Never more than once for a turn (a re-send cut as well is logged as `{ cutAgain: ... }` and left to the no-input wait), never while the caller is speaking, never after the call has ended, and never for a turn that ends the call or sends digits.
- **Not a turn.** Nothing reaches the core, the trace or the audit: the caller said nothing, and the session is where the turn left it. The console notes it under the line ([13.12](#1312-what-happened-on-the-line-in-the-console)). Replaying a frame log reads only what came in, and passes over the carrier's events, so a call with a re-send replays to the same turns.

**An interrupt the caller did not make (`RESAY_SPURIOUS_INTERRUPTS`).** A carrier's barge-in can fire with no caller speaking: on a live Telnyx call (`BARGE_IN=speech`) an `interrupt` came 1704 ms into the greeting with no `clientSpeaking` at all, and the caller, hearing nothing, said nothing for about 11 s. On a carrier that reports the caller speaking (Telnyx with `TELNYX_EVENTS` speaker-events), with the setting on (the default):

- **Heard, or not.** An interrupt is the caller's when they are speaking as it comes, or were heard starting or stopping within `SPURIOUS_INTERRUPT_WINDOW_MS` (default 700) before it. Otherwise it waits 0.4 s in the call's queue (nothing runs ahead of it): a report of the caller speaking in that time (Telnyx's can come after its interrupt), a prompt, a digit or another interrupt makes it theirs, and it is taken as before. 700 ms covers Telnyx's interrupt coming 0.30 s after the caller was heard on a live call; 0.4 s is over the largest gap seen between the two, and short enough that the line comes back with little more silence. Before the carrier has reported the caller's voice at all on the call (`quietMs` `null`), the wait is 2 s instead: see the greeting, below.
- **Not a barge-in.** With no caller heard, no turn runs for it: the core never sees it, so the next answer is not told of a barge-in, and an interrupt within `continueWithinMs` of a re-ask does not make the next prompt continue the one before it. The frame log has `{ spuriousInterrupt: { afterMs, quietMs } }` (how far into the line it came, and how long since the caller was last heard, `null` for never), and replay skips the interrupt there, so a replayed call runs the turns the live one did.
- **Said again.** The interrupted turn's lines go again from the start, once, as a cut line does: `{ resaid: { reason: 'spurious-interrupt', afterMs, expectedMs } }` before the frames, the server log's `interrupted 1.70 s into the lines with no caller heard, lines said again`, and the no-input wait armed from them. Not when a turn has said anything since, the lines are already a re-send, the caller is speaking, or the call is over; never a turn that ends the call or sends digits.

**The greeting.** Telnyx has sent no `clientSpeaking` while a call's first line plays ([live checks](live-checks.md)), so a caller who really talks over the greeting is not heard until their prompt comes, about a second after they stop; and on Telnyx a line once sent plays to its end, so the greeting said again after a short barge-in ("agent") would play in full before the answer to it. So before the carrier has reported the caller's voice at all on the call, an interrupt waits 2 s, not 0.4 s: the prompt of a barge-in up to about a second long comes in that time and makes it the caller's. A longer one is still going when the greeting comes again, and a greeting cut with no caller at all comes back 2 s after the cut. `off` takes every interrupt as the caller's, as before. The startup line says `spurious interrupts said again (no caller heard within 700 ms)`, with `inactive without TELNYX_EVENTS speaker-events` where Telnyx is not asked for them.

The fraction is low because the estimate is rough: a voice that speaks faster than 2.5 words a second takes less than the estimate, never a third of it. `RESAY_MIN_FRACTION` takes 0.05 to 0.95; a value out of that range is refused at startup. The startup line says whether it is on, and, on Telnyx without `TELNYX_EVENTS`, that it is inactive.

### 13.10 The goodbye before the hang-up

A turn that ends the call says its lines (a goodbye, or the line before a transfer) and then sends the carrier an `end` frame, which hangs up or transfers. Twilio plays the lines already sent before it acts on `end`, as long as the socket stays open (the server keeps it open for a grace period after the `end`). Telnyx does not: seen on a live call, "Goodbye." and the `end` went out in the same millisecond, Telnyx stopped speaking 14 ms after it started and closed the socket, and the caller heard no goodbye. A voice provider says which kind its carrier is (`VoiceProvider.endDropsSpeech`, true for Telnyx).

With `END_AFTER_PLAYBACK` at `auto` (the default), a turn that ends the call on such a carrier sends its lines at once and holds the `end` until they have played:

- **When the carrier reports its playback** (Telnyx with `TELNYX_EVENTS`), the `end` goes when it reports the last line played (`tokensPlayed` naming it), or stopped speaking after it started and stayed stopped for a quarter of a second (`agentSpeaking` off). If no such report comes, it goes anyway at the lines' estimate (the one the no-input wait uses) plus 2 s.
- **When it reports nothing** (Telnyx without `TELNYX_EVENTS`, or any carrier with `on`), the `end` goes after the lines' estimate plus half a second for the carrier to begin speaking.
- **Never longer than `END_PLAYBACK_MAX_MS`** (default 15000), whatever the estimate.
- **The call has ended already.** It is ended in the session store and its token revoked before the wait, so a caller who hangs up meanwhile is a call that ended (the carrier's callback hangs up; it never reconnects), and nothing more is sent. Anything the caller says meanwhile is ignored, as after any end. The end-close grace runs from the `end` once it is sent.
- **A transfer is still made.** Should the socket close during the wait with the caller still on the line (a relay session that failed), the carrier's callback puts the caller through to the handoff number, as the `end` would have.
- **A stopping server waits for it.** The drain (`DRAIN_MS`) counts a call whose `end` is held as a live call, so a restart does not cut its line short.

The frame log has one line for the wait, before the `end` it releases: `{ endAfter, endHeldMs, expectedMs }`, where `endAfter` is `played` (the carrier's report), `estimate` (no report expected), `timeout` (the ceiling passed) or `closed` (the socket closed first, and no `end` was sent). `on` holds the `end` on every carrier, should another one lose the goodbye; `off` sends it with the lines, as before. The startup line says which carriers have their `end` held.

### 13.11 The no-input wait and a caller heard speaking

After each question the engine waits for an answer: the question's estimated length (2.5 words a second, a clip by its length) and then `NO_INPUT_MS` (default 7000). If nothing comes, a silence turn runs: "I didn't hear anything." and the question again, walking the same ladder as an answer that missed (the keypad menu or rung, then a person). A transcript, a digit or an interrupt ends the wait. On Twilio, partial transcripts arrive while the caller is still speaking, so the wait ends at their first syllable.

Telnyx sends no partial transcripts: only the final one, about a second after the caller stops. Seen on a live call: the caller spoke one long sentence, the wait ran out 0.7 s after they stopped, and "I didn't hear anything." went out 0.3 s before the transcript of the sentence arrived. With `TELNYX_EVENTS` asking for speaker-events, Telnyx reports when the caller starts and stops speaking (`clientSpeaking` on and off), and the voice provider reads those reports into the engine's terms (`VoiceProvider.readEvent`, the caller started or stopped speaking), so the wait uses them:

- **While the caller speaks, the wait is held.** No silence turn runs over a caller who is talking. A question that goes out while they are still speaking starts its wait held, too.
- **When they stop, the wait resumes, never sooner than the settle.** The silence turn comes when the wait would have run out anyway, or `NO_INPUT_AFTER_SPEECH_MS` (default 2500) after the caller stopped, whichever is later. A transcript in that time ends the wait as any prompt does. So a cough with half the wait left changes nothing (the silence turn comes when it would have), and speech that runs past the deadline with no transcript (a noise the recognizer drops) is followed by 2.5 s, not by a whole new `NO_INPUT_MS`.
- **A stop that never comes.** A caller reported speaking for 30 s with no stop reported is taken as stopped, and the wait resumes as above, so a lost report cannot leave a call with no wait at all.
- **What the frame log shows.** `{ noInputHeld: "speaking" }` when the wait is held, and `{ noInputArmedMs, after: "speech" }` when it resumes (`after: "holdLimit"` for a stop taken as given), beside each `{ carrierEvent: ... }` as it came. The startup line says `no-input after speech 2500 ms` when a carrier that reports the caller speaking is listed.

Twilio reports no speaking, so nothing changes there. A carrier added later that reports the caller's voice maps its own events in its provider's `readEvent`, and the wait uses them with no other change.

### 13.12 What happened on the line, in the console

The console's conversation (Turns and Script alike) shows a small muted note, labelled "on the line", under a line whose delivery the frame log says something about, so the frame log need not be read to know it:

| What happened | The frame log | The note, under |
|---|---|---|
| A line the carrier cut short, said again ([13.9](#139-a-line-the-carrier-cut-short)) | `{ resaid: { heardMs, expectedMs } }` | "cut off at 0.7 s of about 9.6 s, said again", the agent's line |
| The same line cut short again | `{ cutAgain: { heardMs, expectedMs } }` | "cut short again at 0.5 s of about 9.6 s, not said a third time", the agent's line |
| The carrier's interrupt | the `interrupt` frame's `durationUntilInterruptMs` | "caller talked over this, 0.7 s in", the agent's line |
| An interrupt the caller did not make, said again ([13.9](#139-a-line-the-carrier-cut-short)) | `{ spuriousInterrupt: { afterMs, quietMs } }`, then `{ resaid: { reason: 'spurious-interrupt', afterMs, expectedMs } }` | "interrupted 1.7 s in with no caller speaking, said again" (without ", said again" when it could not be), in place of the interrupt's note: the adapter's decision, not a second note |
| A reply held for a caller not finished ([13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said)) | `{ replyHeld: { ms, outcome, utteranceComplete, turn } }` | `sent`: "reply held 1.0 s for the caller to finish, then said"; `joined`: the held turn's line struck through, "not said: the caller went on" (the console shows each turn's line as it runs, before a held reply goes) |
| The caller's words joined to their last answer ([13.8](#138-a-caller-who-had-not-finished-and-how-a-word-is-said)) | `{ joined: n }`, after `{ callerResumed: { pauseMs, intoReplyMs } }` when the caller came back in | "joined with the previous answer (paused 1.2 s)", the joined words' caller line |
| The end held until the lines played ([13.10](#1310-the-goodbye-before-the-hang-up)) | `{ endAfter, endHeldMs, expectedMs }` | "call end held 2.0 s until it played" (or "until the time limit"; "caller hung up 1.2 s into it"), the goodbye or transfer line |

A no-input silence is a turn of its own and shows as before: `silence · 12 s` under the question, counted from the turn that asked it (so the question's playback is in it).

The adapter hands each note to the console as it writes the frame-log line (a `delivery` event on the live feed), and a replay of a past call reads the same facts back from the frame log (`/dashboard/traces/<call>` answers them as `deliveries`), so a reloaded call shows the notes the live one did; nothing is added to the trace. A note carries timings and short codes only, never the caller's words or ours.

To note something new, add one line to `DELIVERY_NOTES` in `packages/dialogwright/src/server/dashboard/view.js` (its kind, the line it goes under, and its sentence from the fact's fields; optionally the kinds of an earlier note it takes the place of, and whether the line was never said), and have the adapter write the frame-log line through its `logDelivery` helper instead of writing it directly. A kind's frame-log line is read as a fact by its key: `{ replyHeld: { ms, outcome } }` is the fact `{ kind: 'replyHeld', ms, outcome }`, and a fact that names a `turn` goes under that turn's line.

### 13.13 The number the caller is calling from

Each carrier's setup frame carries the number the call came from, in its own place, and its voice provider reads it (`VoiceProvider.setupCallerOf`):

| Carrier | Where the number is | Seen |
|---|---|---|
| Twilio | the setup's `from`, in E.164 (`+15555550142`) | as documented |
| Telnyx | `customParameters.telnyx_call_from`; the setup's `from`, `to` and `direction` are null | on live calls, 2026-10-05 |

The number called (the DNIS), for an app that keeps it (app.yaml's `callerNumber: { use: hint, called: true }`), is read the same way (`VoiceProvider.setupCalledOf`):

| Carrier | Where the number called is | Seen |
|---|---|---|
| Twilio | the setup's `to`, in E.164 | as documented |
| Telnyx | `customParameters.telnyx_call_to` | in a live call's setup frame, 2026-10-05; its use by an app is not yet checked on a live call ([live-checks.md](live-checks.md)) |

The console's `call_started` shows it by its last four on either carrier ("unknown" when the setup carries none). It goes to the core only for an app with a slot that offers it ([A callback number](#a-callback-number-callernumber)) or that keeps it for its code ([The number the caller is calling from](#the-number-the-caller-is-calling-from-callernumber)), as the start event's `callerNumber`. An app that keeps it for its code keeps any number that passes steps 1 and 2 below; for a slot, the session keeps it only when it is a number such a slot can use:

1. Digits as a carrier writes them: a leading `+`, spaces, dashes, dots or brackets. A word (`anonymous`, `unknown`), a SIP address, a client name or anything else is no number.
2. Not one of Twilio's placeholders for a withheld caller ID, the keypad spellings of ANONYMOUS (266696687), RESTRICTED (7378742833), UNAVAILABLE (86282452253) and BLOCKED (2562533), with or without a country code. RESTRICTED has ten digits and fits a ten-digit phone mask, so the mask alone would not refuse it.
3. The slot's `countryCode`: a number in international form (`+15555550142`, as both carriers send it) must begin with it, and it is taken off, so ten digits from another country (`+3545550142`) are no number for the slot. A number with no `+` has it taken off when what is left has the slot's `length`; otherwise it must have the length already.
4. What is left matches the slot's `mask`.

How Telnyx writes a withheld number is not yet seen: until a live call shows it ([live-checks.md](live-checks.md)), anything that is not a number by the rules above makes no offer, and a placeholder of Telnyx's own made of ten digits would be offered as a number. A web chat has no number at all.

## 14. Running it

An app's server is `pnpm --filter <app> serve`, configured by its environment. On a machine you own, a few commands at the repository root do the rest, in the order a developer meets them below: try it with no keys, configure a phone line, start it with a tunnel that needs no account, point the carrier at it, diagnose it, then move it to a machine that stays on. Each command prints what it does, and none sends a key anywhere.

```sh
pnpm configure [--app <name>]                # asks, and writes <app>/.env (mode 600): a laptop with no keys, or a phone line
pnpm start [--app <name>] [--tunnel quick|named|none]   # the server with that file; quick opens a tunnel that needs no account
pnpm diagnose [--app <name>] [--offline]     # what is misconfigured, one line per check with its fix
ENV_FILE=<path> pnpm service <launchd|systemd> --app <name>   # a service file that keeps it running; prints the install commands, runs none
pnpm fallback --provider <twilio|telnyx> --number <E.164> --out fallback.xml   # what the carrier plays when it cannot reach the server
pnpm console:link [--app <name>]             # with CONSOLE_AUTH=token: a new one-time sign-in link for the console, on the server's machine
pnpm audit:verify <audit folder>             # each audit day's hash chain, exit 1 at the first break
```

The website's guide, [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html), tells the same story step by step with the carriers' consoles, the tunnels and the service managers; this section is the reference, and [14.12](#1412-the-options) lists every option with its default.

### 14.1 Try it with no keys

```sh
pnpm configure --app utility --mode try
pnpm start --app utility
```

`pnpm configure` asks which app and whether to try it on this computer or make a phone line (the flags above answer both). Trying it writes `apps/utility/.env` with the server on `localhost`, the web chat on (and its widget, once it is built with `pnpm --filter @dialogwright/widget build`), and no model (`JEV_CLIENT=heuristic`: the app understands by its own labelled examples and keywords, enough to walk every path). `pnpm start` runs the server with that file and no tunnel, since `PUBLIC_HOST` is `localhost`. Open `http://localhost:3000/dashboard`, the console, to watch each call and chat, and, for an app with a chat page (the utility's is `/chat-demo`), the page with the widget on it. Both answer only on this machine. With no server at all, `pnpm --filter <app> cli --client heuristic` is a text console.

### 14.2 A phone line: configure

A phone line needs two keys: a carrier's (Telnyx or Twilio, with a number) and a decision model's (TypeSafe, OpenRouter or the Vercel AI Gateway; or none, with a compatible model on your own machine, `JEV_PROVIDER=custom`). Nothing else needs an account.

```sh
pnpm configure --app <name> --force         # --force replaces the .env the try-out wrote
```

It asks, in order: the app; this computer or a phone line; the carrier and its secret (`TELNYX_PUBLIC_KEY` or `TWILIO_AUTH_TOKEN`); the model and its key; and the number a call goes to for a person (`HANDOFF_NUMBER`). A key is read with the echo off (the line editor keeps no history), or taken from the environment variable of its own name when that is set; a key is never a flag, since a flag stays in the shell's history. It is printed by its length only and written only to `<app>/.env`, mode 600, git-ignored. `pnpm configure` refuses to replace a `.env` without `--force` (before it asks anything), checks the file it wrote with `pnpm diagnose --offline`, and prints what to run next and where the webhook goes in the carrier's console. Every question is a flag for a script: `--mode try|phone`, `--carrier telnyx|twilio`, `--model typesafe|openrouter|vercel|custom|none` (with `--base-url` and `--model-id` for `custom`), `--handoff`, `--public-host`, `--port` and `--non-interactive`, which answers from the flags and the environment and asks nothing.

The commands are `pnpm configure`, not `pnpm setup`, and `pnpm diagnose`, not `pnpm doctor`: those two names are pnpm's own commands, which win over a script of the same name.

### 14.3 Start it with a quick tunnel

```sh
pnpm start --app <name> --tunnel quick
```

The carrier reaches the server over HTTPS and a WebSocket, so a laptop behind a home router needs a tunnel. `quick`, the default when `PUBLIC_HOST` is unset, starts `cloudflared tunnel --url http://localhost:<PORT>` (Cloudflare's quick tunnel, which needs no account; `cloudflared` must be installed, and without it `pnpm start` says how), reads the `*.trycloudflare.com` hostname it is given (within 30 seconds), starts the server with that `PUBLIC_HOST`, and prints the webhook URL and the carrier's steps. The hostname changes every run, so the webhook does too: fine for an evening, wrong for a line people rely on. `named` runs the server alone for a named tunnel that runs as its own service, with `PUBLIC_HOST` its hostname; `none`, the default when `PUBLIC_HOST` is set, runs the server alone.

A stop (Ctrl-C, SIGTERM, or the terminal closing) is passed to the server once, and `cloudflared` is stopped only after the server has drained, so live calls keep their way in while they finish ([14.6](#146-an-always-on-machine)). If `cloudflared` stops on its own, the server is stopped too, since no carrier can reach it.

### 14.4 Point the carrier at it

`pnpm start` prints the webhook, `https://<PUBLIC_HOST>/voice/<carrier>`, and where it goes: for Telnyx, a TeXML application's voice URL (method POST) with the number assigned to it; for Twilio, the number's "A call comes in" webhook (HTTP POST). Then call the number. [13.2](#132-serving-voice-twilio-telnyx-or-both) has the paths each carrier answers on, and the website's guide the console steps for each.

### 14.5 Diagnose

```sh
PUBLIC_HOST=<the tunnel's hostname> pnpm diagnose --app <name>   # pnpm start prints this line
```

`pnpm diagnose` reads the settings the server would and checks, one line each with `ok`, `warn`, `fail` or `skip` and a fix: the settings file is its owner's alone; the config loads (with the server's own messages); `PUBLIC_HOST` resolves and `/health` answers through it within five seconds; the console is a 404 there (or, with `CONSOLE_AUTH=token`, sends a browser with no cookie to the sign-in page, and its data answers 401); each carrier's secret has its shape and signatures are checked; which model, from where, and its key variable set; `HANDOFF_NUMBER` is not a 555 number; the trace and audit folders can be written, with a gigabyte free; the clock is within a minute of the carrier's API host's (Telnyx refuses a webhook signed more than five minutes off); and, with `SESSION_STORE=file:`, its folder ([14.7](#147-surviving-a-restart)). It exits 1 only on a `fail`. It calls no carrier or model API and sends no key: its requests are DNS, a few GETs to the server's own address, and one `HEAD` with no key and no body to the carrier's API host (or else the model provider's) for its `Date`. `--offline` makes no request at all; it is what `pnpm configure` runs.

### 14.6 An always-on machine

For a line people rely on, the same setup moves to a machine that stays on (any Mac or Linux machine), with the settings outside the repository, a named tunnel whose hostname stays, and the service manager keeping the server up.

**The settings file.** The server reads its environment and, when `ENV_FILE` names one, a settings file (Node's own parser); a variable already in the environment wins over the file, and a file that does not exist stops the start. `pnpm start` sets it to `<app>/.env`. A file kept elsewhere (the right place on a machine that stays up, mode 600) is named with `ENV_FILE=<path>` in front of the command: `ENV_FILE=~/ivr/myline.env pnpm start --app myline`, and the same for `pnpm diagnose`, `pnpm service` and `pnpm console:link`. `--env-file <path>` works too where pnpm passes it on, but some pnpm builds read a `--env-file` themselves, and fail on a relative path before the command starts, so `ENV_FILE=` is the form to use.

**The service.** `ENV_FILE=<path> pnpm service <launchd|systemd> --app <name> [--label <label>] [--out <file>] [--force]` writes a launchd agent or a systemd user unit from `packages/dialogwright/templates/service/`, with this machine's absolute paths (the repository, pnpm, node's folder, the settings file): it runs the app's server with `ENV_FILE`, starts it at login (and at boot, with a launchd daemon or systemd's lingering, which it explains), restarts it when it exits, and gives a stop `DRAIN_MS` and ten seconds more before anything is killed. It prints the commands that install, check and stop it, and runs none of them. It warns when the settings file can be read by others. Nothing from the file goes into the service file but its path.

**Ready, and a drain.** `GET /ready` answers 200 `{"ready":true}` while the server takes new calls, and 503 `{"ready":false,"draining":true}` once it stops. `GET /health` stays 200 while the process runs: it counts live calls (`sessions`), and adds `chat` with the chat on, `draining` while it drains, and `disk` when a retention is set ([14.10](#1410-keeping-the-disk-in-check)). A stopping server (SIGTERM from the service manager, or Ctrl-C) first drains: a new call is put through to `HANDOFF_NUMBER`, a new chat is told `busy`, and live calls and chats go on until they end or `DRAIN_MS` passes (30 seconds by default). Then the calls still live are closed as going away (WebSocket 1001), and the carrier calls back for each: with the memory store the server, about to close, puts that caller through to `HANDOFF_NUMBER` (it waits up to three seconds for those callbacks); with `SESSION_STORE=file:` it hands each call over to the server that starts next instead ([14.7](#147-surviving-a-restart)). A second signal stops it at once (exit 130 or 143).

**A crash** (an uncaught exception, or a promise rejected with nothing to catch it) is logged with its stack and its causes' stacks (never the settings); then the server closes as far as it can in three seconds (turns under way finish; a new call goes to `HANDOFF_NUMBER`) and exits 1, for the service manager to start it again. That is Node's own rule for an unhandled rejection, kept on purpose rather than made an option: a server in a state nothing planned for should start again, not go on answering calls. Code that means to carry on after a failed promise catches it where it happens.

### 14.7 Surviving a restart

With the default memory store a restart (an update, a reboot, a crash) ends the calls under way. With `SESSION_STORE=file:<dir>` it does not.

**What is saved.** The server saves each call after every turn, before the turn's frames go out (its session with `SESSION_SCHEMA` beside it, its reconnect count, its audit entries, and a service request it is waiting on with its key), each chat with its resume token's hash, and the live relay tokens as hashes, in a folder of its own (mode 700, each file 600, every write a temporary file renamed over the last). `pnpm diagnose` checks the folder is writable, kept across a reboot (not a temporary filesystem), and its owner's alone. One server uses a folder: two servers on one folder would sweep each other's calls. The folder holds what callers said, as traces do: keep it on this machine, never in the repository (`sessions/` is git-ignored).

**What the caller hears.** When a carrier calls back for a call this server does not hold (`/cr-action/<carrier>`, its relay having lost the socket), or opens a socket for one, the server loads it, and the caller hears the `resumed` line ("Sorry, I lost you for a moment." unless prompts.yaml says otherwise) and then the question they were last asked, with every value they gave still on the form; the reconnect counts toward `RECONNECT_LIMIT`. A web chat resumes the same way with its resume token, and the client sees `ready` for the same session. The trace, the frame log and the day's audit chain go on in the same files, and `pnpm audit:verify` passes across the restart. What is not resumed: a call saved under another `SESSION_SCHEMA`, or for an app this server does not run (the caller is put through to `HANDOFF_NUMBER`, and the log says why); one saved for another carrier; one past `SESSION_TTL_MS` idle or `SESSION_MAX_AGE_MS` old; and one whose carrier never calls back (forgotten once past its time, with a `call_ended` in the audit).

**A planned restart** (SIGTERM from a service manager, Ctrl-C, `pnpm start` stopped for an update) hands each call still live after `DRAIN_MS` over to the restarted server. The server closes the call's socket as going away; the carrier calls back at once, and this server, still listening, answers with a document that pauses `RESTART_PAUSE_S` seconds (a `<Pause>` before the `<Connect>`, which Twilio's TwiML and Telnyx's TeXML both take) and then connects again, with a relay token saved where the restarted server finds it. Once every call has called back (or three seconds have passed) the server stops listening and exits, and while it is still there it turns every socket away (503), so the carrier's lands on the restarted server. A carrier that connects too early meets that 503, calls back, and is told to wait again (each time counts toward `RECONNECT_LIMIT`, so the loop ends with a person). What the caller hears: silence for `RESTART_PAUSE_S` seconds, then the `resumed` line and the question they were on. Set `RESTART_PAUSE_S` a little above how long the server takes to stop and start (the log's `listening on` line says when it is back); a restart slower than the pause fails the carrier's connect, and its callback, finding no server, goes to the fallback ([14.8](#148-when-the-server-is-down-the-carriers-fallback)). `RESTART_PAUSE_S=0` skips the handover: the server stops listening first, and every callback goes to the fallback unless the restarted server is already up. A voice provider of your own that leaves out the pause (`StartDocumentOptions.pauseS`) connects at once and meets the 503 until its reconnects run out.

**The same address before and after.** Both a planned restart and a crash bring a call back only to the hostname the carrier already has. A named tunnel keeps it. `pnpm start --tunnel quick` stops its tunnel with the server, and the next quick tunnel gets a new `*.trycloudflare.com` hostname, so a call cannot come back to it: to try a restart on a laptop, run the quick tunnel in a window of its own (`cloudflared tunnel --url http://localhost:3000`), set `PUBLIC_HOST` to its hostname, and restart only the server (`pnpm start --app <app> --tunnel none`).

**A crash** (or a kill, a reboot, a power cut) hands nothing over: the server stops listening at once, and a carrier calls back the moment the socket drops, so its callback usually finds no server and fails. The carrier then uses the number's fallback ([14.8](#148-when-the-server-is-down-the-carriers-fallback)), and the caller is put through to `HANDOFF_NUMBER`; a callback that comes after the restarted server is up resumes the call. A call waiting on a service's answer when its server went away keeps the request, and the restarted server sends it again once, with the same key ([14.13](#1413-writes-that-are-never-done-twice)).

**The disk.** A save is renamed into place whole, so a process that stops or crashes loses nothing. It is not flushed to the disk unless `SESSION_FSYNC=on`, so a power cut may lose the last few seconds of saves (a call whose save is lost resumes a turn or two back, or not at all); `on` flushes each save and its folder, at the disk's latency on every turn, for a machine with no battery or UPS. A save that fails (a full disk) is logged and the call goes on; it only cannot be resumed from that turn.

### 14.8 When the server is down: the carrier's fallback

A carrier turns to a number's fallback document when it cannot reach the server at all: a call that comes in while it is down, and a callback for a live call that comes before a restarted server is listening. `pnpm fallback --provider <twilio|telnyx> --number <HANDOFF_NUMBER> [--message "..."] --out fallback.xml [--force]` writes one: the carrier's own apology (or your `--message`, escaped) and a dial to the number. It reads no setting and sends nothing. Host the file at an https URL somewhere that stays up when this machine does not (GitHub Pages, Cloudflare Pages, object storage), and paste the URL where the command says: Twilio's number's "Primary handler fails", Telnyx's TeXML application's fallback URL. Write it again when `HANDOFF_NUMBER` changes. Without one, a caller whose callback finds no server hears the carrier's own error. Whether a carrier uses it for a failed callback mid-call, and not only for a call that comes in, is [live check 3](live-checks.md#3-reconnect-after-the-relay-socket-fails-and-a-restart-mid-call).

### 14.9 Looking at calls from your phone

The console shows calls as they happen, with what callers said, so by default (`CONSOLE_AUTH=local`) it answers only a request made on this machine, and is a 404 through the tunnel (`CONSOLE_LOCAL_ONLY`, on by default). Another computer can reach it over SSH (`ssh -L 3000:localhost:3000 <the machine>`). `CONSOLE_AUTH=token` serves it through the tunnel too, for its one owner, behind a sign-in (refused with `DASHBOARD=off`):

1. When the server starts it makes a one-time sign-in link, `https://<PUBLIC_HOST>/dashboard/login?code=<64 hex digits>` (on a laptop, `http://localhost:<port>/...`), valid for ten minutes and used once, and writes it to `CONSOLE_LINK_FILE` (mode 600, in a folder of mode 700; a folder another account owns or others may write in is refused). The log names the file and a short hash of the code, never the code.
2. On the server's machine, `pnpm console:link` prints a new link (the one before it stops working). It reads the link file, refuses one that others can read or another account owns, and posts the key in it to the server's `/dashboard/link`, which answers only a request made directly on this machine that carries that key and no `Origin`; through the tunnel there is no such path. The key is what proves the caller is the owner: other accounts on the same machine can reach its localhost ports, but not read the file. Send yourself the link however you like.
3. Opening the link shows a page with a Sign in button, so a link preview, which only fetches the page, never uses the code up. Pressing it sets the session cookie, signed with HMAC-SHA256 (`CONSOLE_SESSION_KEY`, or a key made at start), HttpOnly, Secure, SameSite=Strict, on `/dashboard` only, for `CONSOLE_SESSION_HOURS`; on a laptop (`PUBLIC_HOST=localhost`) a plain http request on the machine gets it without Secure. The console's header then has Sign out, which ends that session at once, closing a live feed it has open. With `CONSOLE_SESSION_KEY` set, sign-outs are kept beside the link file (`signed-out.json`, mode 600: a SHA-256 of each session's id with its expiry, never the id or the cookie), so a signed-out cookie stays refused after a restart. A cookie whose expiry is further off than `CONSOLE_SESSION_HOURS` allows (the hours were lowered since) is refused too; to sign every browser out at once, change `CONSOLE_SESSION_KEY`.

The console fits a phone's width: up to 820 pixels wide its columns stack, and the header (Sign out included) and the replay bar wrap.

**What protects it.** Without a session, `/dashboard` sends the browser to the sign-in page, which shows nothing of the app or of any call, and everything else under `/dashboard` (the live feed, the traces, a replay) answers 401. Codes are kept only as SHA-256 and compared in constant time; a used, expired, replaced or unknown code is refused the same way. A sign-in or sign-out form from another site's page is refused (by its `Origin`, and by `Sec-Fetch-Site`, which a browser sends whatever the page's policy). Failed sign-ins are limited: ten in a quarter of an hour from one address, and a hundred through the tunnel as a whole, after which an attempt is refused (429) without being looked at; a request made on the machine itself is held only to its own address's limit, so the owner can always sign in. The address is read as `CONSOLE_CLIENT_ADDRESS` says. `auto` takes `cf-connecting-ip`, which Cloudflare's edge sets whatever the client sent, else the last `x-forwarded-for` entry, the one the proxy in front added, else the socket's. That is right for Cloudflare's tunnels; behind another tunnel a client could send a `cf-connecting-ip` of its own and choose the address it is counted under (the limit for everyone still holds), so name the header your tunnel sets: `cf-connecting-ip` for Cloudflare, `x-forwarded-for` for ngrok or another proxy that appends the address it saw, and `remote` when nothing sits in front of the server. Every answer under `/dashboard` carries a Content-Security-Policy (nothing from anywhere else, the page's own script and style only by a nonce, no framing), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The app's own local-only pages (its chats) stay local only either way. `pnpm diagnose` checks, through the tunnel, that `/dashboard` sends to the sign-in page and its data answers 401.

**The access log.** With `CONSOLE_AUTH=token`, the audit records who looked, as `console_access` entries on channel `console`: each link made (`link_made`, at start or by `console:link`), each mint refused (`link_refused`), each sign-in (`sign_in`) and refusal (`sign_in_refused`, with why: `used`, `expired`, `replaced`, `unknown`, `malformed`, or `rate_limited` once per lock), each sign-out, the live feed's first open in a session (`live`), and every replay of a stored call (`replay`, under that call's id, so a call's audit shows who replayed it). An entry names the session by a short hash of its id and a code by a short hash, never the cookie or the code, with the address and whether it came through the tunnel or from the machine. The entry is written before the answer, so an access the audit could not record is not served. One owner, no roles: roles and many users are for later (design §8).

### 14.10 Keeping the disk in check

Nothing deletes a trace or an audit day unless a retention says so. `TRACE_RETENTION_DAYS` removes trace files and their frame logs last written more than that many days ago, and `AUDIT_RETENTION_DAYS` audit day files older than that, both swept at startup and once an hour, never a live call's files and never today's audit day; the log says `retention: removed N trace files, M audit days`. With either set, `/health` reports `disk` (`traceBytes`, `auditBytes`, measured at most once a minute) for a monitor. Deleting an audit day ends its record, so the server warns at startup when `AUDIT_RETENTION_DAYS` is set: keep it as long as the record must be kept. The traces are what `pnpm kb:gaps` reads to find the questions a knowledge base did not answer, so archive them first. `pnpm audit:verify <audit folder>` checks each day file's hash chain and exits 1 at the first break. The sessions folder needs no sweep or backup: it holds only the calls under way.

### 14.11 Updating and restarting

Update on purpose (the project is pre-release, and its APIs change), and note the commit you last ran well so you can go back: `git pull`, `pnpm install`, `pnpm check`, the app's tests, the widget's build if you serve it, then restart through the service manager (`systemctl --user restart <unit>`, `launchctl kickstart -k gui/$(id -u)/<label>`). The restart drains as in [14.6](#146-an-always-on-machine): with the file store a call still live after `DRAIN_MS` is handed over and resumed ([14.7](#147-surviving-a-restart)); with the memory store it is put through to `HANDOFF_NUMBER`, so check `/health` says `"sessions":0` first. A version whose `SESSION_SCHEMA` differs from the one that saved a call puts that caller through to a person rather than resume them.

### 14.12 The options

Every option here has a default that keeps the behaviour a deployment had before it existed: nothing is saved, nothing is swept, the console stays on the machine. The server checks each at startup and refuses to start, naming the variable, when one is malformed. Each app's `.env.example` lists them, commented, with their defaults.

| Choice | Where it is set | Default | When to choose otherwise |
|---|---|---|---|
| A settings file read at startup | `ENV_FILE` (env), or `--env-file <path>` | none: the environment alone | Always on a machine you own (`pnpm start` sets it to `<app>/.env`). A variable already in the environment wins over the file. |
| Which tunnel `pnpm start` opens | `--tunnel quick\|named\|none` | `quick` when `PUBLIC_HOST` is unset, `none` when it is set | `named` for a named tunnel that runs as its own service. |
| How long a stopping server waits for live calls | `DRAIN_MS` (env) | `30000` | Longer for long calls; `0` to close at once. The service's stop timeout is `DRAIN_MS` and ten seconds more. |
| How long traces and frame logs are kept | `TRACE_RETENTION_DAYS` (env) | unset: forever | To keep the disk in check. Archive what `pnpm kb:gaps` should still read first. |
| How long audit day files are kept | `AUDIT_RETENTION_DAYS` (env) | unset: forever (the audit is a record) | Only as long as the record must be kept; deleting a day ends its record. |
| Where calls, chats and relay tokens are kept between turns | `SESSION_STORE` (env): `memory` or `file:<dir>` | `memory`: a restart ends the calls under way | `file:sessions` (or an absolute path) on any machine that stays up, so an update, a reboot or a crash does not drop a caller. |
| How long a planned restart asks each carrier to wait before it connects again | `RESTART_PAUSE_S` (env, with `file:`), 0 to 60 | `5` | Longer when the server takes longer than that to stop and start again; `0` stops listening at once and leaves each callback to the carrier's fallback. |
| Whether each save is flushed to the disk | `SESSION_FSYNC` (env, with `file:`): `on` or `off` | `off`: a crash loses nothing, a power cut may lose the last few seconds | `on` on a machine with no battery or UPS, at the disk's latency on every turn. |
| The line a call resumed after a restart hears first | `resumed` in prompts.yaml (and a locale's prompts) | the engine's "Sorry, I lost you for a moment." | When the app speaks another language, or says it its own way. |
| Whether a tool's write is given a key, so a repeat is not done twice | `idempotent: true` on the tool (`code.tools`) | absent: no key | Every tool that writes (files, books, sends), with a system that keeps the keys it has seen ([14.13](#1413-writes-that-are-never-done-twice)). |
| Who may open the console | `CONSOLE_AUTH` (env): `local` or `token` | `local`: only a request made on this machine, 404 through the tunnel | `token` to look at calls from elsewhere (your phone), behind a one-time sign-in link ([14.9](#149-looking-at-calls-from-your-phone)). |
| How long a console sign-in lasts | `CONSOLE_SESSION_HOURS` (env, token only), 1 to 168 | `12` | Shorter on a shared phone or laptop. |
| The key console sessions are signed with | `CONSOLE_SESSION_KEY` (env, token only) | unset: a key made at start, so a restart signs everyone out | To stay signed in across restarts: 32 random bytes or more, hex or base64 (`openssl rand -hex 32`); never echoed. |
| Where the current sign-in link is written | `CONSOLE_LINK_FILE` (env, token only) | `.console-link/link.json` beside the trace folder | A folder of the server's own account; one others may write in is refused. |
| Where a console request's address is read | `CONSOLE_CLIENT_ADDRESS` (env, token only): `auto`, `cf-connecting-ip`, `x-forwarded-for` or `remote` | `auto`: `cf-connecting-ip`, else the last `x-forwarded-for` entry, else the socket's | `cf-connecting-ip` behind a Cloudflare tunnel (quick or named); `x-forwarded-for` behind ngrok or another proxy that appends the address it saw; `remote` with no proxy in front. |
| The document a carrier plays when it cannot reach the server | `pnpm fallback`, a file hosted elsewhere, its URL in the carrier's console | none: the carrier's own error | Always, on a line people rely on ([14.8](#148-when-the-server-is-down-the-carriers-fallback)). |

The options from before Phase 8 that a machine you own may also set (`PUBLIC_HOST`, `PORT`, `TRACE_DIR`, `AUDIT_DIR`, `DASHBOARD`, `CONSOLE_LOCAL_ONLY`, `RECONNECT_LIMIT`, `SESSION_TTL_MS`, `SESSION_MAX_AGE_MS`, `TIMEZONE`) keep their defaults; the carriers' and the chat's are in [13.1](#131-the-options).

### 14.13 Writes that are never done twice

A call resumed after a crash may run a write again: the turn that filed a report ran, the server went away before it saved the call, and the restarted server resumes at the summary, where the caller says yes again. A tool that writes declares `idempotent: true`, and its `run` is given `ctx.idempotencyKey`: the first 32 hex characters of the SHA-256 of the JSON array `["tool", call id, form, confirmed, tool]`, where confirmed is the hash of the values the caller confirmed at the summary (or, for a call with nothing confirmed, of the call's params as canonical JSON). The same confirmed write on the same call has the same key however often it runs; any value changed makes another. Pass it to the system the tool writes to, which keeps the keys it has seen and answers a repeat with what it did the first time. An illustration, shaped like the engine's own test app's `createReport` (`testing/testkit/domain/tools.ts`):

```ts
createReport: {
  params: ['accountId', 'missingNote', 'expectedDate'],
  idempotent: true,
  run(call, sys, { idempotencyKey }) {
    const r = (sys as Systems).createReport(call.params, idempotencyKey); // a key seen before: the report it filed
    return { value: { number: r.number }, summary: `report ${r.number}`, ref: r.number };
  },
},
```

A request to a downstream service (`code.services`) always gets a key, in `resolve`'s options (`opts.idempotencyKey`, over `["service", call id, turn, service, params]`, the turn being the one that left the request), which a service sends on as an `Idempotency-Key` header where its system takes one. The turn that leaves a request records it, with its key, in the call before the turn is saved and before the request is sent; a call waiting on the answer when its server went away keeps it, and the restarted server sends it again, once, with that same key, after the `resumed` line. Nothing changes for a tool without `idempotent`. The engine only makes and passes the key: a system that ignores it may still do a repeated write twice. What goes into each key is a promise kept across versions: a key made another way would make a retry look new.

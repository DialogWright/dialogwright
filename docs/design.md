# DialogWright design

DialogWright is a TypeScript framework for voice and chat agents that act safely. This document describes its design: the idea it rests on, how an app is shaped, how policy and identity work, how it is tested, how it runs in production, and what is built so far. It is written for developers evaluating the framework or contributing to it.

The project is pre-release. Where this document describes something not yet built, it says so; the [roadmap](#12-roadmap) lists what is done and what comes next.

## Contents

1. [The idea](#1-the-idea)
2. [The roles](#2-the-roles)
3. [Shape: packages and the app folder](#3-shape-packages-and-the-app-folder)
4. [Built for AI coding assistants](#4-built-for-ai-coding-assistants)
5. [Generated wording](#5-generated-wording)
6. [Identity and policy](#6-identity-and-policy)
7. [Testing](#7-testing)
8. [Production architecture, and laptop mode](#8-production-architecture-and-laptop-mode)
9. [Knowledge base](#9-knowledge-base)
10. [Channels: our own event model, providers as adapters](#10-channels-our-own-event-model-providers-as-adapters)
11. [Foundations designed in from the start](#11-foundations-designed-in-from-the-start)
12. [Roadmap](#12-roadmap)
13. [Open source and licensing](#13-open-source-and-licensing)

## 1. The idea

People who ask for a smarter IVR or chat assistant are not asking for varied wording, or for summaries of knowledge articles. Their complaint is understanding. They want to talk the way they would to a person, and have the system map what they mean to the right action, instead of listening to a menu or guessing the phrase it expects. Generative agents invert this. Their understanding is weak where it matters, since a model composing a reply will answer a question it misheard; their output is slow and varies from one call to the next; and then a great deal of effort goes into forcing the consistency back, with longer prompts, filters and retries. DialogWright splits the problem the other way. Understanding is flexible: the model perceives through typed questions, so a caller can say it in their own words, give three answers at once or change their mind. Saying and doing are predictable: the words are fixed lines, code decides what happens, and a policy gate checks every action. And replies are fast, because a decision is a short typed question, never a composed answer.

Conversations that change something real (booking an appointment, reading a balance, setting up a payment plan) need more than a fluent reply. They need the right identity check before the right action, exact confirmation of what will be written, a refusal that cannot be talked around, and a record an auditor can follow. Free-form generation, where a large language model reads the conversation and decides what to say and do, is good at fluency and poor at all four.

DialogWright splits the work differently:

- **A fast, calibrated decision model perceives.** It reads what the caller said and answers typed questions: is this a request to reschedule, which of these three appointments, what date was given. It returns judgments with probabilities, not generated text.
- **Deterministic code decides.** The core owns the dialog: which form is active, which slot to ask next, when to confirm, when to hand off. Given the same judgments and state, it always makes the same decision.
- **A policy gate checks every action.** Before any tool runs, the gate checks identity level, whose record it is, exact confirmation, role and attempt limits. A model cannot talk its way past it, because the gate does not read the conversation.
- **An audit log records everything.** Every gate decision, allowed or refused, and every tool result is written to a hash-chained log with personal data minimized.

This is the old form-filling pattern of VoiceXML, made to work with mixed initiative (the caller can give three answers in one sentence, change one, or ask something else) by a decision model whose cost per decision rounds to zero and whose latency fits inside a phone turn.

**Why this beats free-form generation for regulated conversations.** Every decision is reproducible: replaying a call against its recorded model answers gives the same outcome. Every action is explainable: the audit shows which rule passed or failed, and what it compared. Every line the caller hears about their own data is an approved template filled with checked values. Prompt injection has nothing to grab: the caller's words are data the perceiver classifies, never instructions the core follows. And thresholds are tunable numbers, so behavior is adjusted by measurement rather than by rewording a prompt.

**Goals.** An app is a folder, mostly configuration. Policy lives in a file that compliance can review. An AI coding assistant can stand up a new app from a paragraph in one session. It runs on a laptop with no keys, and it runs in production without dropping calls on deploy.

**Non-goals for the first release.** Memory across calls (cross-channel continuity belongs to a contact-center platform); outbound campaigns; a visual flow designer (a later step that would edit the same files); running our own speech recognition and synthesis (a later channel adapter, see §10).

## 2. The roles

Every turn has three steps: perception (what did they mean), the decision (what happens next, and is it allowed), and wording (how it is said).

1. **The perceiver.** A decision model reads the caller's words and the current state and answers the core's typed questions. Perceivers are pluggable: the first adapter is TypeSafe's Jev; others, such as an LLM with structured outputs or another decision-model provider, implement the same typed interface.
2. **The core.** Deterministic code runs the fill-and-ask loop: intents start forms, forms collect slots, filled forms are read back and confirmed, and silence, repetition, frustration and handoff are handled in one place. An intent the model is unsure of is confirmed with the caller by default, or taken as no match where the app or the intent says so (`unsureIntent` in app.yaml, `unsure:` on an intent). The core never imports an app; it reads everything app-specific through the `App` contract.
3. **The gate.** Every tool call goes through the gate, which returns one of four verdicts: `ALLOW`, `BLOCK`, `STEP_UP` (verify identity further, then try again) or `NEEDS_HUMAN`. Every verdict, with each rule's comparison, goes to the audit log.

**The renderer** turns the core's structured decision into words. Its default is approved templates; an opt-in generated-wording option (§5) can phrase a line an author flags, inside checks, but never chooses what is said.

| Role | Default | Model option |
|---|---|---|
| Perceiver | A decision model through an adapter (TypeSafe's Jev first) | An LLM with structured outputs, same typed interface |
| Core | The deterministic fill-and-ask loop | An LLM proposing the next step or tool call, which still only the gate can execute (later, experimental) |
| Renderer | Approved prompt templates | An LLM phrasing a structured speech act within checked facts (§5) |

The gate, typed state, the audit log, replay and recorded-model regression stay the same in every mode.

**Where the model is.** The Jev adapter reaches the same API through TypeSafe, OpenRouter, the Vercel AI Gateway, or a compatible endpoint (`JEV_PROVIDER`; one resolver, `src/jev/provider.ts`, for the server, the CLI and the regression run). The first three serve TypeSafe's Jev. A compatible open-weight model answers in the same shape, but its probabilities are not calibrated like Jev's, so the thresholds are measured with its own cassette (each model records its own) rather than carried over; a run on one says so at startup, and the trace names the provider and model that answered.

**Model-agnostic by design.** Decision models are becoming a category, so the framework names the category, not a vendor. Every perceiver adapter passes the same conformance tests and records into the same cassette format, which makes an app's scenario suite a built-in benchmark: run your recorded calls against each provider and compare accuracy, calibration, latency and cost.

## 3. Shape: packages and the app folder

### Packages

Today the engine ships as one package, `dialogwright`. As the framework grows it splits into packages under the `@dialogwright` scope, so an app depends only on what it uses:

| Package | What it is |
|---|---|
| `core` | Session, the pure turn resolver, the fill-and-ask loop, confirmations, silence, frustration, handoff; the channel event model (§10) and capability checks; the role interfaces |
| `slots` | The standard slot library (below). Today it lives in the engine package (`src/slots/`); a separate package is a later call |
| `policy` | The gate as a named-rule engine, the identity model, the hash-chained audit log |
| `perceive` | The perceiver interface, conformance tests, and the injection screen's questions |
| `perceive-typesafe`, `perceive-llm`, others | Perceiver adapters: TypeSafe first, any LLM with structured outputs, more as providers appear |
| `render-llm` | Generated wording (§5) |
| `kb` | Approved passages, staleness hashing, hybrid retrieval (§9). Today in the engine package (`src/kb/`) |
| `kb-author` | Building a knowledge base from documents: ingest, draft, review, refresh, gaps (§9). `@dialogwright/kb-author`, its own package, so the runtime stays light |
| `channels` | The text relay with Twilio and Telnyx adapters and their conformance kit, the web chat endpoint and its sign-in (§10). Today in the engine package (`src/server/voice/`, `src/server/chat/`, `src/channel/`) |
| `widget` | The web chat widget a site embeds (§10). `@dialogwright/widget`, its own package with no runtime dependencies, so a site loads a few kilobytes and none of the engine |
| `stores` | Session, audit, trace and event-bus interfaces with laptop and production implementations (§8). Today the session stores (memory and file, with their contract suite) are in the engine package (`src/server/stores/`) |
| `console` | The live operator console and call replay, with access control |
| `harness` | Corpus and scenario runner, cassette record and replay, regression, threshold sweep, adversarial suite |
| `a2a` | A strict client for downstream services that speak the agent-to-agent protocol (optional) |
| `apps/clinic` | Example: appointment scheduling with name and date of birth, as an app folder |
| `apps/utility` | Example: identity, policy, writes, delegates, knowledge base |

### An app is a folder

An app is a folder of YAML for what is data, plus TypeScript for what runs. `defineApp(dir, code)` joins the two into the `App` contract the engine runs, and `pnpm check` finds everything wrong with either, or with how they meet, in one pass. [authoring-an-app.md](authoring-an-app.md) is the guide; `apps/clinic` is the worked example.

```
my-app/
  app.yaml          id, locale, brand, console, voice, handoff, wording, thresholds, carried slots, unsure intents, fixtures
  intents.yaml      intents and the keypad menu
  forms.yaml        each form's slots, summary prompt and the code hooks it has
  prompts.yaml      every line the caller hears (mode: fixed)
  policy.yaml       the gate's tables: levels, rules per tool, confirmed fields, attempts
  identity.yaml     optional: the principal kind, the factor slots and the identity tools
  kb/               optional: the knowledge base (§9): topics, approved passages, their sources, the log of approvals
  locale/<tag>/     optional: prompts.yaml per extra locale
  app.ts            export const code: AppCode (slots, tools, systems, form hooks, custom rules, ...)
  fixtures/         corpus.jsonl, scenarios, the baseline, recorded cassettes
```

Every YAML file has a JSON Schema (`packages/dialogwright/schemas/`, generated from the zod schemas that validate the files), and each file names its schema on its first line so an editor completes and checks it. The code stays in TypeScript: slot specs (what the perceiver is asked and how the answer becomes a value), tools and the systems behind them, the form hooks, custom policy rules and the test hooks. The folder cannot say any of those without becoming a programming language, and the check keeps the two sides in step: every name the YAML uses must exist in the code, and every hook the code writes must be listed in `forms.yaml`.

Built with the slot library: `slots.yaml`, which names every slot the app has (a library type with its options, or `{ type: code }`) and sets the order they are filled in, and `locale/<tag>/slots.yaml` for how a locale says its slots' values. Built with the knowledge base (Phase 6): `kb/` (§9), the topics, approved passages, their sources and the log of approvals, with a `topic` slot to choose among them and a form's `answers:` to say one. Not built yet, and planned for the folder: `style.yaml` (persona and word budgets, with generated wording), declarative tools (so an app built from the slot library and HTTP tools has no code beyond one `defineApp` line), named policy rules (Phase 4), and `mode: generative` prompts. Apps are registered by id, sessions carry the id, and a boundary test forbids the engine from importing any app.

### The slot library

A slot is one value a form collects. Most slots are configuration: an app names a type in `slots.yaml` and gives it options, and the engine runs it exactly as it runs a slot written in code. Each type bundles its typed questions for the perceiver, fill and validation, readback and confirmation behavior, default retry and keypad prompts (overridable), a display formatter, locale-aware parsing (English and Spanish), and starter test utterances. The model never writes a value: it answers typed questions, and the type's code turns the answers into a value and decides whether it is good.

```yaml
# slots.yaml
accountNumber: { type: digits, noun: account, length: 10, keypad: true }
outageType:
  type: choice
  options: { no_power: no power at all, partial: some lights out }
startDate: { type: date, range: future, windows: true }
bill: { type: record, from: bills, key: id, label: "{period}, {amount}" }
```

Built, with their main options (each has a [page](slots/README.md) generated from its options schema):

| Type | Typical use | Main options |
|---|---|---|
| `digits` | Account number, meter number | `length` or `mask`; `keypad`; `group` for the readback; `minConfidence`; `redact` and `handoff` (default last four) |
| `choice` | Outage type, reason for calling | `options` with a criterion each; `keypad` menu; `fillAt`; `confirm` and `readBack`; the advanced tier `disambiguate`, `hedge` and `help` for names that sound alike |
| `date` | A delivery day, an appointment | `range` future or past; `windows` for a span such as next week; `qualifier` ("this" or "next" Tuesday); `fillAt`; `whenUnsaid` and `whenUnresolved`; `keypad` |
| `birthdate` | A date of birth | A month and day held until the year is said (`yearPrompt`); `minYear`; `notThisDate`; masked to its year; `keypad` |
| `name` | The caller's own name | Word spans picked by the model; `exclude` withholds words that are never the caller's name |
| `record` | A bill or appointment a tool returned | `from` a named list the app gives its slots; `key`; a `label` template per record; `spoken` numbers; `disambiguate` |
| `text` | A short description of the problem | The caller's words kept as said; `maxLength`; a stand-in `say`; `redact: length` |
| `topic` | Which knowledge-base topic a caller asks about | One choice question over the topics retrieval nominated for the caller's words (none nominated, none asked); `cap`; `accept` (only a nominated topic, or any of the catalog); `disambiguate`; `fillAt`; `criterion` and `text.<part>` for the wording |

Every type also takes `text.<part>` (a literal in place of any default question text, sent word for word) and `ids.<part>` (an existing question id), so an app keeps its own wording, or the words a recording was made with, while the library's defaults stay neutral. Every slot, of a type or in code, also says where it listens outside a form (`listen:`): `up-front` by default (asked there, kept only for the form the turn enters), `form` (asked only inside its form), `anywhere` (kept whenever said) or `call` (kept for the whole call, which is what app.yaml's `carrySlots` does); an identity factor listens as identity says.

Not built yet:

| Type | Why it waits |
|---|---|
| `time-slot` | An appointment time, with windows and disambiguation. Apps that have one ask it from form state today; making it a slot would re-key every recorded request, so it waits for a deliberate re-record. |
| Name spelling | A different set of questions; left until an app needs it. |

The one-time code is not a slot type: it is a factor of `identity.yaml`'s level 2 (§6), keypad only, masked and never traced, so it never joins the slots a request carries. Yes or no confirmation is built into the core. A slot a type does not fit is written in code (`{ type: code }`), or becomes a type: contributors add types, and the conformance kit (§7) is how a type proves it keeps the engine's contract.

### Tools versus policy

A tool says what an action does, never whether it may run. The engine calls the gate before a tool runs, and the tool's own code contains no permission checks.

```ts
export const getBalance = tool({
  params: { account: z.string() },
  subject: ({ account }, sys) => sys.accounts.holderOf(account),  // whose record, for scope
  run: ({ account }, sys) => sys.accounts.balance(account),
  summary: (r) => `balance read`,                                 // the audit line, never the payload
  idempotent: true,
})
```

Plain REST calls can be declarative tools (a URL template, an auth reference, a response mapping), so many apps need no tool code at all.

## 4. Built for AI coding assistants

A first-class goal: a developer points an AI coding assistant such as Claude Code at the repository and has an app running from a one-paragraph description in one session, with `pnpm check` and the scenario suite green.

1. **`CLAUDE.md`** at the root: the roles and the gate in a page, the commands, and the rules (never put policy in tool code, never let a model write a regulated line, the engine imports no app, run `pnpm check` and `pnpm verify` before committing an app). Each example app has a short one of its own, and so does every app `pnpm create-app` writes.
2. **A create-app skill** in `.claude/skills/create-app/` (built): from a plain-language description, it fills in a worksheet (the intents, each piece of information mapped to a built-in slot type, the policy and identity, what is recorded), scaffolds the app, drafts the prompts, policy, identity and tool stubs, writes starter corpus utterances and scripted calls, and runs the checks until they pass. It comes with a page of verified patterns and a corpus guide, and a test checks its links and its vocabulary.
3. **`pnpm create-app <name>`** (built; `--identity` for an app that verifies its callers), a deterministic scaffold the skill calls. It writes an app that passes `pnpm check`, its own tests and its stub regression as created, with its own `CLAUDE.md`; a test scaffolds both variants and runs all of that.
4. **`pnpm check`**, with errors written for an agent to act on: each is one line, `file:line:column  path  message  ->  fix`, such as `forms.yaml:8:19  forms.check_hold.slots[1]  slot "branche" is not defined  ->  rename it to "branch", or add it to the app's slots in app.ts (code.slots.branche)`. It validates every schema (unknown keys, wrong types, a misspelt name with the near match offered) and cross-checks the folder against the code: referenced prompts exist, forms' slots are defined, every form's hooks match exactly what the code writes, every tool has a policy row and every policy row a tool, every custom rule the policy names exists and is used, and the identity tools and carried slots exist. It checks that every line the engine itself says is present in every locale (including the ones it builds from a slot's spec, such as `ask_<slot>_dtmf` for a slot with a keypad rung), that a translated line uses only its default line's variables, that what the console and the clips name exists, and that every intent has examples in the app's corpus. Every prompt is `mode: fixed` because the schema allows no other mode today; checking generated wording waits for it (Phase 9). Each custom rule must be defined with examples (`defineRule`: one call the gate allows, one it refuses), which the policy matrix runs. The command is `dialogwright check [--json] [dir...]`, and exits 1 when there is any problem.
5. **It runs with no keys.** The stub perceiver answers from the app's own labelled corpus, templates render, and the text harness and console work end to end.
6. **Docs for agents**: [authoring-an-app.md](authoring-an-app.md) (written for a developer and an assistant alike), [`llms.txt`](../llms.txt) at the repository root (an index for assistants), a [page per slot type](slots/README.md) with its options, default question text and examples (generated from the types, so they cannot drift), and the example apps as reference patterns.

The skill has been tried, and the evidence is in [trials/README.md](trials/README.md). Two fresh assistants with no context, given one paragraph each and the skill, built a working app (about 15 and 11 minutes, by their own count, which the commit times bear out), with `pnpm check` and the scenario suites green; the first is the utility example, `apps/utility`. The first trial's `pnpm -r test` was still red on a framework test that assumed no new app (fixed before the second). Both found the same real hole in their own policy by reading the policy matrix (a delegate could have had a one-time code texted to someone else's phone); the engine now refuses any party that is not the subject on the identity tools, for every app (folder or code), and the policy matrix and card show it. Each stumble the trials logged was fixed in the docs, the skill, the error messages or the framework, or recorded with its reason. The second trial met none of the first one's again, except two: it read the framework's source once more, for the shape of a policy matrix's records (since fixed), and a keypad key was ignored, from a different cause (a key before the menu listens).

## 5. Generated wording

Generated wording is an option, not the point of the framework. Everything above works with fixed lines, and an app that never turns it on never meets it. It is kept so it can be tried and measured: a team that wants a warmer acknowledgement on one line can have it, and a run says what it costs in latency and in consistency.

It is opt-in per prompt (or per state of a form). The author flags a prompt as generated, tells it the line's intent and the data items the line must carry, and keeps the fixed line as the fallback. The core ends each turn with a structured decision and the renderer turns it into words; generated wording changes how something is said, never what is decided. **The model chooses the words, never the content.**

- **`TemplateRenderer`** is the default. **`LlmRenderer`** wraps it and renders only prompts marked `mode: generative`, using a small, fast model. A turn can mix the two: a generated acknowledgement, then a fixed answer passed through verbatim.

```yaml
ask_outageStart:
  mode: generative
  template: "When did the power go out?"     # the fixed fallback, and the meaning
  goal: "Ask when the outage started; briefly acknowledge what they just said."
balance_answer:
  mode: fixed
  template: "Your balance is {amount}, due {dueDate}."
```

- **The model receives a speech act, not the conversation**: the act (ask, read back, acknowledge, re-ask with its reason, offer a person, hand off) with the line's intent, the data items it must include (display values only, never identifiers), the caller's last utterance quoted as data, their frustration level, the channel, and `style.yaml` (persona, tone, word budget per channel, one question per turn, phrases to avoid).
- **Every generated line is checked before anyone hears it.** Any failure falls back to the fixed line, and the audit records `render_fallback`. The checks: (1) every required data item is present; (2) no other numbers, dates, amounts or names appear, except from those items or the caller's own words; (3) the line is within its word budget, and an ask ends in exactly one question; (4) a decision-model yes or no check, "does this text do anything other than the act's goal?", which catches drift. A turn the injection screen flagged is never generated.
- **Latency**: one fast model call per generated line, checked before it is spoken (no streaming into synthesis), capped by a per-turn timeout (about 700 ms on voice) after which the fixed line is used.
- **Determinism**: the trace records the act, the text, the check results and any fallback; cassettes record generations keyed by act and context; regression re-runs the checks on every recorded line and reports the fallback rate; the console shows each line's mode.

## 6. Identity and policy

Policy is a file compliance owns, and identity is a file next to it. `policy.yaml` says what the agent may do, action by action; `identity.yaml` says who the app serves and how a caller proves who they are. Both are plain, reviewable YAML that compile to what the gate runs, every app (the framework's testkit included) runs from them, and [authoring-an-app.md](authoring-an-app.md#3-policy-and-identity) is the guide to writing them.

### Identity

Identity is a ladder of named levels above anonymous. Each level has the factors a caller gives (slots, asked on voice) and the tools that check them; level 2 adds a one-time code, a factor of its own kind that is keyed on the keypad, masked, never traced and never held as a slot. The ladder is cumulative and has one or two rungs; a ladder of one has no code, and then nothing may need level 2. Levels stay numbers everywhere the engine records them, and a level's name is a label for the console and the policy card.

```yaml
# identity.yaml
principals:
  subject: customer
  delegates:
    agent: { roles: [viewer, clerk] }
levels:
  1: { name: account verified, factors: [accountNumber, serviceZip], verify: verifyAccount }
  2: { name: code verified, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
signIn: { level: 2 }
```

- **Step-up**: when the gate answers `STEP_UP`, the request is parked, the channel satisfies it (spoken or keyed factors on voice, sign-in on a channel that can sign a caller in), and the request goes back through the gate. Factors are ordinary slots, never asked on a channel where the caller signs in instead.
- **Sign-in is keyed by capability, not by channel name** (`signIn: { level }`), as §10 has it: the core checks what a channel can do. The level a sign-in proves is always the top of the ladder.
- **Principals**: anonymous, the verified subject (whatever the app calls its customer or patient), and delegates acting for subjects (a caregiver, a depot agent), each kind with its roles. Every party an app's portal lists must fit what `identity.yaml` declares, and `defineApp` refuses one that does not. The identity tools (the factors' check and the one-time code's two tools) are for the subject only: the gate refuses them to any other party before their rules run (`subject`, reason `not-subject`), whatever the file says.
- **Attempts**: one number, the failed tries allowed at each check, before a person takes the call.

### Policy

```yaml
# policy.yaml
actions:
  getBalance:
    say: read the balance
    level: 1
    rules:
      - identity
      - scope: { param: accountId }
  paymentArrangement:
    say: set up a payment plan
    level: 2
    rules:
      - identity
      - scope: { param: accountId }
      - role: { viewer: refuse, clerk: person }
      - confirmed: [accountId, amount, firstPaymentDate]
      - limit: { field: amount, max: accountBalance(accountId) }
      - dateInRange: { field: firstPaymentDate, notBefore: today, notAfter: today+30 }
      - custom: no-arrangement-in-last-12-months
redact:
  agent: { getBalance: [paymentHistory] }
audit:
  accountId: last4
  amount: keep
  firstPaymentDate: keep
```

- **Built-in rules** (each is a name with parameters, listed in the order the gate runs them; the first that fails decides): `identity` (the level is strong enough), `scope` (the subject the call names is one the caller may see; never from the conversation), `role` (allow, refuse, or a person, per role), `confirmed` (a hash of exactly what the caller confirmed matches what the write sends), `attempts`, `fields` (the minimum data sent to downstream services), `dateInRange` (a date inside bounds, written as `today`, a number of days from today, a date, or a lookup the app supplies) `limit` (a number inside limits), and `oneOf` and `noneOf` (a value that is, or is not, one of a list, matched exactly: a town in the service area, an owner and not a renter). An action not listed is blocked. Bounds come only from the app's code and systems, through a small reference grammar that is read when the app is built and never run, and every range rule fails closed.
- **Custom rules** are TypeScript referenced by name, written with `defineRule`. They return the same shape as built-ins (a description, what was compared, pass or fail, the verdict) and must ship with examples: one call the gate allows and one it refuses, which the matrix runner runs. `check` refuses a rule without them.
- **Purposes** raise the level a purpose needs above its first action's, and **wording** puts the rules' lines in the app's own terms.
- **Redaction per principal** (`redact`): the tool returns the whole record; the policy names, by delegate kind or kind and role, the fields of a result withheld from a party acting for subjects. The engine strips them in one place, right after the tool runs, so no hook, line, trace, console or audit ever sees the whole value.
- **What is recorded** (`audit`): every param that is not a slot with a redact setting is declared `last4`, `mask`, `length`, `secret` or `keep`, and `check` refuses one that is undeclared. The same masks reach the free text recorded beside a call. The gate always decides on the raw call.
- **The audit log** is built in, with one stable schema and minimization declared per field: identifiers masked to the last four characters, secrets never logged, free text recorded by length only. Each rule is recorded under its name (`scope fail: ...`, not an opaque id), so an auditor reads what failed.

### Ownership and review

Compliance edits `policy.yaml` and `identity.yaml`, with required reviewers through `CODEOWNERS`; the framework owns how built-in rules are checked; app engineers own custom rules. Three generated files make a change readable by someone who does not write code, each written deliberately by a command and compared by a test, never written by CI:

- `POLICY.md`, the policy card (`pnpm policy:card`): a plain-English table from the same compiled object the gate runs, so it cannot say what the gate does not do. It carries the files' config hashes, the defaults, the identity ladder, who acts for whom and what each role gets, what is withheld, what is recorded, one row per action with each rule in words, and Mermaid diagrams of the ladder and of the actions by level.
- `policy.matrix` (`pnpm policy:matrix`): for every action and every kind of caller, the verdict and its reason, so a policy change is a diff of what the gate decides.
- `APP-MAP.md` (`pnpm app:diagram`): the app's intents, keypad menu, forms, slots, actions and rules as diagrams, with dangling references (an intent with no form, an action no form reaches) drawn marked. It is structure, not a call script, since the dialog is mixed-initiative.

A change to the rules lands as a diff of the policy, the card and the matrix together. A file written in the gate's old table shape is converted with `dialogwright policy:convert`.

## 7. Testing

1. **Framework tests.** Each slot type and built-in rule ships its own suite. A slot type's suite starts with the conformance kit (below).
2. **App tests.** A labelled corpus (drafted by the skill, grown with real phrasings); multi-turn scenarios with expected outcomes (delegates, sign-in steps, keypad input); **policy tests read from `policy.yaml`**: the invariants, the matrix golden and the custom rules' examples (below), and the policy card and app map goldens.
3. **The model loop.** Stub runs need no keys: the stub perceiver answers from the corpus labels. Record against a decision model once (per provider, for benchmarking), replay offline from the recorded cassette, regress with allowed cosmetic drift, sweep thresholds to the center of their plateaus, and trim the cassette.

Around those:

- **Regression** compares every run's outputs with a baseline. A changed output is a finding to explain, never noise to overwrite. Two allowances exist, both only for runs that reach a model's answers (recorded, live): a scenario marked `cosmeticDrift` may differ in which gate decided and its verdict, and a corpus entry carrying `knownGap` (a one-line reason and the outcome fields the model is known to produce) may show exactly that known outcome, printed as allowed with its reason and counted in the summary; any other difference on the entry still fails. A documented model gap is tolerated there and nowhere else: stub runs (fixture and heuristic) stay exact, so `knownGap` never hides a change in the stub baseline.
- **The slot conformance kit** (`dialogwright/testing`) runs over every example configuration of a slot type, with no model and no keys, and proves the type keeps the contract the engine relies on: it builds and declares its question ids and prompts; it refuses unknown options; its question ids are its own and never the engine's; it gives no value for no answers, for answers that hear nothing, or for malformed answers; it reads thresholds by name (scaling every probability and threshold by one factor changes nothing, so no number is written into the type); its display is the same in the fill, the keypad and every locale; every line it can lead to is declared; and each example utterance gives the outcome it expects. A contributed type must pass it. The kit's own tests break a small correct type one way at a time and show the check meant for that fault catches it.
- **Oracles and grids** are the pattern for moving a slot onto a library type without changing what a caller hears. The hand-written slot is frozen as a test-only oracle, and a shadow harness runs the library slot beside it over a large grid of answers around every threshold, comparing the questions as the model's request keys them, the fill outcomes, the keypad results and the displays. The same harness runs inside the regression and the recorded replay, so branches no recorded call reaches are compared too. When the grids and every recorded call agree, the oracle stays as a test and the app runs the library slot; the recorded cassette replays with zero misses because the model's requests are byte-identical. The clinic's slots moved this way.
- **Policy tests** hold the gate to what the file says, over a grid of every action crossed with every kind of caller, subject and fact (the app supplies its principals and records through one test hook). Three things run over it. **Invariants** say what must hold whatever order the rules are written in: an action not listed is blocked for everyone; an identity tool is never allowed for a party who is not one of the app's subjects; a caller below an action's level is never allowed; `scope`, `confirmed`, `role`, `fields` and `attempts` each refuse what they exist to refuse; an allowed call ran every rule its action lists, and each passed; raising the level never turns an allow into a refusal; and the scope answer does not move with the conversation. They are derived from the policy as written, not from the gate's own lines, so a gate that is wrong in a way its lines agree with is still caught, and the tests of the invariants break a small correct gate one way at a time to show each is caught. The **matrix golden** (`policy.matrix`, beside the policy) is the verdict and reason for every action and kind of caller, reviewed and written deliberately, so a policy change is a diff compliance reads. **Rule examples** run each custom rule's examples through the compiled gate in every action that names it. The policy card and the app map are goldens of the same kind.
- **The shadow gate** is the pattern for changing the gate itself without changing a decision, as the shadow harness is for slots. The old evaluator is frozen as a reference, a second gate (here, the one that reads the policy's named rules) runs beside it over the whole grid and inside every replay of a recorded call, and the run fails on any decision that differs, with a count of how often each rule passed and failed so a rule no call exercised is visible. When both agree everywhere and the recorded calls replay with zero misses, the reference stays as a test and the new gate runs the apps. The engine moved every app from the old tables to the policy files this way.
- **The threshold sweep** varies each decision threshold across the recorded calls and picks values from the middle of the range where outcomes are stable.
- **Generated wording**, for an app that opts in, joins the cassette; regression re-checks every line and reports the fallback rate.
- **A shared adversarial suite** that every app inherits, filled in with its own intents and records: announced injections (including at identity and code prompts), callers asserting a relationship they have not proven, off-scope requests, spoken codes, and hostile replies from downstream services.
- **Channel conformance tests** from captured real frames per provider.
- **Store contract tests**: one suite, `runStoreContract` (`dialogwright/testing`), run against every implementation of the session stores (memory and file today; a shared store in Phase 8b), with a reopen for a store that outlives its process (§8).
- **Thesis metrics** from every run: slots per utterance, turns to completion, decision latency, cost per call.
- **CI** runs the checks, unit tests, and stub and recorded regression on every push with no secrets. Recording stays a deliberate local step with real keys.

## 8. Production architecture, and laptop mode

**Principle: the agent failing never means dead air.**

1. A turn fails: re-ask, then hand off to a person.
2. A server stops or dies mid-call: the socket closes, the carrier calls the action URL, and the call reconnects to a server that loads the saved session and resumes it ("Sorry, I lost you for a moment"). Built for one machine (below); across many servers it needs a shared store (Phase 8b).
3. The whole service is down: the carrier's fallback URL serves static markup from somewhere independent (static hosting or object storage) that apologizes and dials the human queue. Built: `pnpm fallback` writes the document.

DialogWright is built to run first on one machine its owner controls: a laptop to try it, then any Mac or Linux machine that stays on, with two keys (a carrier's and a decision model's) and no cloud sign-up beyond them. For most lines one machine is the right answer, and scaling out is a deliberate step for a business that needs it. So Phase 8 built everything one machine needs, and the seams many servers need (store interfaces with a contract suite, sessions that are versioned and serializable, idempotency keys), and left the shared stores themselves for Phase 8b. The developer-facing story is [section 14 of the authoring guide](authoring-an-app.md#14-running-it) and the website's guide, [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html).

### Built: one machine, run for months

- **The first hour.** `pnpm configure` asks for the app, the carrier and its key, the model and its key, and the handoff number, reads each key with the echo off (never a flag), and writes `<app>/.env` mode 600; with no keys it sets up a try-out on `localhost`. `pnpm start` runs the server with that file and, when `PUBLIC_HOST` is unset, opens a Cloudflare quick tunnel (no account), prints the webhook URL, and stops the tunnel only after the server has drained. `pnpm diagnose` checks the settings, the tunnel, the console's privacy, each secret's shape, the model, the handoff number, the folders, the disk and the clock, one line each with its fix, calling no carrier or model API.
- **A settings file and a service.** `ENV_FILE` names a settings file the server reads at startup (a variable already in the environment wins). `pnpm service launchd|systemd` writes a launchd agent or a systemd user unit with this machine's absolute paths that starts the server at login or boot, restarts it when it exits, and gives a stop the drain and ten seconds more.
- **Ready, drain and crash handling.** `/ready` answers 503 while the server drains; `/health` stays liveness. A stop drains for `DRAIN_MS` (a new call goes to `HANDOFF_NUMBER`, a new chat is told it is busy, live ones go on); a second signal stops at once; an uncaught exception or rejection is logged with its causes and exits 1 after a short close, for the service manager to restart.
- **Sessions that survive a restart.** The server's state sits behind three interfaces (`CallStateStore`, `ChatStateStore`, `TokenStore`, `server/stores/types.ts`), each method answering at once or with a promise so a networked store fits the same seam. Two implementations: memory (the default, nothing saved, as before) and a file store (`SESSION_STORE=file:<dir>`: mode 700 folders, mode 600 files, tokens kept only as SHA-256, every write atomic, `SESSION_FSYNC=on` to flush). One contract suite, `runStoreContract` in `dialogwright/testing`, holds every implementation to the same behaviour, including surviving a reopen. A session carries `SESSION_SCHEMA` beside it; `sessionRoundTrip` replays every app's corpus and scripted calls with the session put through JSON before each turn and shows nothing changes. A call is saved after every turn; a carrier's callback after a restart loads it and the caller hears the `resumed` line and the question they were on; a call saved under another schema is handed to a person. A kill-the-server test (`server/restart.e2e.test.ts`) kills the server mid-form on each carrier and resumes the call on a new process with the audit chain and the trace continuous.
- **A planned restart hands calls over.** With the file store, a call still live after the drain is told to wait `RESTART_PAUSE_S` seconds and connect again, and the stopping server refuses sockets (503) until it exits, so the carrier's connection lands on the restarted server. A crash relies on the carrier's fallback for a callback that finds no server.
- **Writes are idempotent.** A tool that declares `idempotent: true` gets a key derived from the session (call id, form, confirmed-values hash, tool), stable for the same confirmed write; a service request always gets one (call id, turn, service, params), recorded in the call before it is sent and sent again once, with the same key, by a server that resumes a call waiting on it.
- **Retention.** `TRACE_RETENTION_DAYS` and `AUDIT_RETENTION_DAYS` sweep old files at startup and hourly, never a live call's or today's audit day; `/health` then reports the bytes kept. `pnpm audit:verify` checks every day's chain.
- **The console from elsewhere, for one owner.** `CONSOLE_AUTH=local`, the default, keeps the console to the machine it runs on, as it always was. `CONSOLE_AUTH=token` serves it through the tunnel behind a sign-in: a one-time link (32 random bytes, ten minutes, one use) that the server writes to a file only its owner can read, and that `pnpm console:link` replaces without a restart through an endpoint that answers only a request made on the machine carrying the file's key; the link sets an HMAC-signed, HttpOnly, Secure, SameSite=Strict session cookie on `/dashboard`. Failed sign-ins are rate-limited, every console answer carries a strict Content-Security-Policy, the page fits a phone, and the access log is in the audit chain (`console_access`: sign-ins and refusals, sign-outs, the live feed's first open, and every replay of a stored call, by a hash of the session).

### Designed, for many servers (Phase 8b)

What a business with more than one machine's worth of calls, or a deploy that must never drop one, needs on top. Each piece goes behind the seams above, so laptop mode and one machine keep working unchanged; the website's [scaling out](https://dialogwright.com/guides/scaling.html) guide describes the shape.

- **Shared stores** passing the same contract suite: a Redis (or similar) `CallStateStore`, `ChatStateStore` and `TokenStore`, so any instance can resume any call or chat. One instance owns a call's turns at a time (a lease per call id), and the reconnect counter is incremented atomically. Chosen by configuration (`SESSION_STORE=redis://...`).
- **The audit in Postgres**, a hash chain per session with each session's final hash anchored into a daily chain, since two processes appending to one day file would fork it.
- **Traces in object storage**, continued in one trace when a call moves instance.
- **Console events over pub/sub**, so one console sees every instance's calls, and a chat resume that takes a chat over closes the old socket wherever it is.
- **Roles**: one codebase, separate deploys, `--role voice | chat | console`. Voice and chat are public; the console is internal only.
- **Containers and a compose stack**: a container image, and `docker compose` with two instances behind a local load balancer and the shared stores, where the kill-an-instance test runs: a deploy never drops a call.
- **Console roles**: viewer, supervisor and admin with single sign-on, and many users; the knowledge base's review page could move into the console then, once a role says who may approve.
- **Load balancing and deploys**: WebSockets with an idle timeout longer than the longest call, no sticky sessions (carrier webhooks are stateless HTTP); new instances report ready, old ones drain (for longer than one machine's `DRAIN_MS`, about 15 minutes) and hand their calls to the shared session.
- **Hosting**: a starter setup on a container platform with WebSockets (two instances, managed Redis and Postgres); production on containers behind an application load balancer across availability zones, with a second region as the carrier's fallback target. For regulated data: services covered by the relevant agreements (such as a HIPAA BAA), encryption at rest, retention policies and in-region data.
- **Observability**: OpenTelemetry metrics and traces; logs carry ids, never personal data; alerts on fallback hits, system-failure handoffs, reconnect rate and turn latency.

**Laptop mode stays first-class.** Every production dependency is an interface whose default is the laptop implementation: sessions in memory, audit and traces in local files, the console bus in process, the stub perceiver and templates without keys, the chat widget served locally, a mock sign-in. One process (`pnpm --filter <app> serve`, or `pnpm start`) serves voice, chat and the console. The same code runs in every mode (resume, idempotency and drain run on one machine against the file store), and the contract suite keeps the implementations honest. Configuration selects each piece independently.

## 9. Knowledge base

Answers to general questions come from approved passages, never from generation. It is built (Phase 6): the guide's [section 12](authoring-an-app.md#12-the-knowledge-base) says how to use it, and this section says what it is and why. **A passage is the unit of approved knowledge**, one file in the app's `kb/` folder:

```yaml
# kb/passages/outage-credit-2026.yaml
id: outage-credit-2026
topic: outage_credit
version: "2026.1"
applies: { state: CA, customer: residential }
effective: { from: 2026-01-01 }
source: { document: tariff-rule-14, section: "3.2" }
answer: If your power is out for more than 24 hours, you can get a credit of 25 dollars.
approval:
  owner: Customer Content
  approvedBy: Compliance
  on: 2025-12-10
  sourceHash: 17e82b0ccd14d6493f43690cc883ae53603e5893d9963664e5bb590c2df22d32
  hash: 79a9d3c3384b1671b2303c323cce68b248862c5510c814c4edcb1649244d1d51
```

- **Staleness.** An approval holds two hashes: of the source section's text, and of everything approved (the passage's id, locale and version, the topic and its spoken title, the answer, who it applies to, its dates, the source text and the topic's account line). Either changing, whitespace aside, makes the passage stale, and `pnpm check` refuses an approval that is not in the append-only log `kb:approve` writes. A stale passage fails `pnpm check` and is withheld at run time: the caller hears a fixed "unavailable" line and is offered a person. Answers are always fixed text with no variables. The caller's own data is a separate, gated read, said as an optional account line after the answer.
- **Select, don't generate: nominate, select, resolve, speak.** Retrieval nominates a few topics for the caller's words. The decision model selects one, or "none", with one choice question over those topics alone (a `topic` slot, §3); where two cannot be told apart, the agent asks which was meant. Code resolves the passage in force for the caller's facts, the day and the call's language, through the gate, and checks that it has not gone stale. The approved answer is spoken verbatim. A form says `answers:` and its completion is the engine's; an informational intent may name a `passage:` instead of a line, with no retrieval and no gate.
- **Retrieval is one async step before planning.** Questions are built before the model is asked, so `runTurn` runs the retriever once, within a fixed 150 ms budget, only when the app has a knowledge base, the turn has words and a topic slot is listening. It fails open: a retriever that throws, answers wrongly or is late nominates nothing, and the trace says why. "Ask about topics only when a knowledge question is plausible" is the nomination itself: nothing nominated asks nothing, so no turn pays for the knowledge base unless a caller seems to ask something. Every other turn, and every app without a `kb/`, is byte-identical to what it was.
- **Hybrid retrieval from the start.** The decision model guards precision, so retrieval only needs recall: keywords (BM25 with exact phrases, so plan names and codes match) catch exact terms; embeddings catch meaning and misrecognized speech; the two rankings are merged by reciprocal rank fusion and capped (eight). The default embedder is a static model (Model2Vec `potion-base-8M`) run in pure TypeScript: no key, no native dependency, about a hundredth of a millisecond a question, and the same bits on every machine, which a cassette replay needs since the nominations shape the request. Its weights are downloaded once at a pinned revision, checked by SHA-256 and cached (`pnpm kb:model`), never vendored and never fetched on a call. The vectors of the topics' texts are a committed index (`pnpm kb:index`, keyed by content hash, which re-embeds only what changed); `pnpm check` holds it to the topics. A larger model (bge-small through ONNX) is an optional adapter behind a peer dependency, since its last bits can differ between CPUs. `pnpm kb:bakeoff` compares the retrievers on paraphrase sets (recall at the cap, candidates, speed) and sweeps the floor and the cap offline, because they change what the model is asked and so cannot be tuned by re-recording. The index is in memory (brute force is fine at thousands of topics); production is to use the same `VectorIndex` interface in a database (pgvector; not built in Phase 8, and a candidate for Phase 8b beside its Postgres audit).
- **Authoring that scales.** Pre-approved answers only scale with a way to make them, so the package `@dialogwright/kb-author` (authoring only: an app never imports it and the runtime carries none of its dependencies) builds a knowledge base from documents, with a person at the end. `pnpm kb:ingest` reads a folder of PDF, DOCX, HTML, Markdown and text files, or a website to a link depth (same host, robots.txt, a rate and page limit), into `kb/sources` by section with provenance. `pnpm kb:draft` has a model, with the author's own key on their machine and never in CI, propose passages into `kb/pending`; each must quote its source section word for word, fit the answer length and name a real topic, or it is not written. Pending drafts are never read at run time. `pnpm kb:review` is a page where a person approves (`pnpm kb:approve`, which records the approver, the day and both hashes in an append-only `kb/approvals.jsonl`), edits, rejects, or accepts a proposed topic; only a person approves. `pnpm kb:refresh` reads the sources again and withholds any passage whose source changed until it is reviewed again, with a word diff against the text as approved. Every "none" in production feeds `pnpm kb:gaps`, a ranked backlog from the traces, with the fix for each. For the long tail, each app chooses a handoff today; generated wording grounded in approved passages, for content marked `risk: low`, is Phase 9, under §5's checks.
- **The review page is a local server, not the operator console.** The plan was to put it in the console. The console had no access control then, and its tunnel carries the public's requests, so a page that approves what callers hear would be open to whoever reaches it. `kb:review` instead serves 127.0.0.1 on a free port, answers only a loopback peer, and needs a one-time token that is in the URL it prints. The console now has a sign-in for one owner (`CONSOLE_AUTH=token`, §8); the review page could move into it once roles say who may approve.
- **Testing.** Paraphrase sets per topic, with an app test that holds retrieval's recall to them and goldens of what each retriever nominates for each line, so a change to a keyword or a floor is a diff to read; the stub regression runs the real retriever. In production, `kb:gaps` counts the "none" selections and the close calls between two topics.
- **Two-part questions are deferred.** One choice question cannot select two topics, and a second one would re-key the requests of every turn.

## 10. Channels: our own event model, providers as adapters

The core speaks its own channel event model. Every provider is an adapter that maps its wire format onto it, so the core never sees a provider's messages and never checks a channel's name. Built today: the phone through Twilio ConversationRelay and Telnyx Conversation Relay, and the web through the engine's own chat endpoint and an embeddable widget. Every choice a deployment or an app makes about them is an option with a default (the guide's [section 13](authoring-an-app.md#13-channels) has the whole table), and a deployment that sets none of them answers on Twilio alone, in the app's default language, with no web chat.

**Events into the core** (`SessionEvent`):

| Event | Carries | Source |
|---|---|---|
| `session.start` | Provider details (call ids, numbers, custom parameters), opaque to the core | Channel |
| `user.speech` | `text`, `final`, `lang`; only a final transcript is a turn | Channel |
| `user.text` | `text`; typed text is always final | Channel |
| `user.key` | One `digit` | Channel |
| `user.interrupt` | `heard` (the part of our own line that had played), `afterMs` | Channel |
| `channel.error` | `description`; logged by the adapter, ignored by the core | Channel |
| `user.silence` | Nothing said or pressed for the no-input wait | Server-made |
| `service.result` | A downstream service's answer to the request the session waits on; untrusted | Server-made |
| `auth.signed_in` | The `principal` a user signed in as during a chat | Server-made |

Server-made events never come off a wire.

A caller who had not finished is the engine's, not a carrier's (`run/continuation.ts`, app.yaml's `voice.continueWithinMs`, default 300 ms): when the reply to a final `user.speech` is cut off by a `user.interrupt` within that window, the next final prompt continues it, and the turn runs on the words joined, on the session as it was before the first fragment. Only a turn that did nothing but speak is undone; the voice server and the frame-log replay run every turn through it, so a replayed call joins where the live one did.

**Actions out of the core** (`Action`):

| Action | Carries |
|---|---|
| `say` | `parts` (text for the channel's own voice or display, or a recorded clip's URL) and `interruptible` |
| `end` | `completed`: the business done |
| `transfer` | `reason`, `completed`, `queued`, and the collected `slots`, for the person taking over, as app.yaml's `handoff.data` lets them leave the engine: by default no identity factor, and a redacted slot only masked; with `handoff.data.unconfirmed: mark`, also `unconfirmed`, the ids of the values the caller never confirmed. On a phone call they are the relay's `end` frame's `handoffData`, which the carrier holds and posts back; a chat's transfer sends none |
| `send_digits` | Key tones to play on the line |
| `set_language` | Speech and recognition languages |

A `say` action's text is the readable line. What a voice is sent differs only at the voice wire: identifier digits spelled out (`voice.spokenDigits`) and the words the voice says wrong respelled (`voice.pronounce`, plain letters, since only one of the two carriers documents SSML in its relay's text); the trace, the console and a chat keep the line as written.

Planned additions: a `ui` action for buttons and quick replies (such as "Sign in to continue"), and confidence and alternative transcripts on speech.

**Capabilities** (`ChannelCaps`): each channel declares `speech`, `keypad`, `bargeIn`, `recordedAudio`, `richUi`, `signIn` and `async`. The core checks capabilities, never names: no keypad prompt where `!keypad`, no spoken identity factors where the user signs in instead. Two channels are defined today: `VOICE_RELAY` (speech, keypad, barge-in, recorded audio) and `WEB_CHAT` (rich UI, sign-in). The core reads `speech`, `keypad` and `signIn` today; the others are declared for the channels that need them.

**Providers as adapters:**

| Type | Who does speech | Examples | When |
|---|---|---|---|
| Text relay | The provider | Twilio ConversationRelay and Telnyx Conversation Relay (today; the same message types, different webhook signatures and start documents) | First release |
| Web and app chat | None | The embeddable widget | First release |
| Messaging | None, asynchronous | SMS, WhatsApp | Soon after |
| Audio streaming | The framework (recognition, synthesis, end-of-speech, barge-in), likely through Pipecat or LiveKit Agents | Twilio Media Streams, Telnyx media streaming, SIP, WebRTC | Later |
| Contact-center connectors | Varies | Contact-center platforms' audio and digital connectors | Later; audio connectors need the audio pipeline |

**Carriers as plug-ins.** A carrier is a `VoiceProvider` (`server/voice/provider.ts`): how its webhooks are signed (`verify`), how its callback reads into the engine's terms (`parse`: the call id, numbers, statuses, whether the call is still live in the carrier's own words, and the end frame's handoff data), and the documents that start the relay and end the call (`startDocument`, `hangupDocument`, `dialDocument`, `apologizeAndDialDocument`). The socket frames are not the provider's: both carriers speak the same relay messages, so they share one wire mapping (`channel/relay`). `VOICE_PROVIDERS` (env, default `twilio`) names the carriers a deployment answers, each on `/voice/<id>`, `/cr-action/<id>` and `/conversation/<id>`; the unprefixed paths stay Twilio's, so a number set up before carriers were plug-ins needs no change. A carrier's secret (`TWILIO_AUTH_TOKEN`, `TELNYX_PUBLIC_KEY`) is required only when it is listed. A call's socket token is tied to the call and to the carrier that answered it. Carriers name voices and recognizers differently, so each has its own settings and one carrier's never reaches another: `TTS_PROVIDER` and `TTS_VOICE`, `TWILIO_TRANSCRIPTION_PROVIDER` and `TWILIO_SPEECH_MODEL` (default Deepgram flux) are Twilio's; `TELNYX_VOICE` and `TELNYX_TRANSCRIPTION_PROVIDER` (default Telnyx's own) are Telnyx's. They are the default locale's; an app names each locale's voice and recognizer per carrier in app.yaml (§11.1). Nothing in the core, the run loop or the prompts knows a carrier.

**The conformance kit.** `runVoiceProviderConformance` (`dialogwright/testing`; `describe` and `it` are passed in, as the slot kit's are) runs a provider against fixtures copied from the carrier's own documentation, each line naming its source (`__fixtures__/<id>/frames.jsonl` and `webhooks.json`): every documented inbound frame parses into a core event; a setup frame's ids and numbers are kept; every documented outbound frame serializes with the same fields; the provider verifies its own signature and refuses a tampered, unsigned or other-body webhook; the voice, action and alternative webhooks read as expected; the start document points at the provider's own socket and action paths with keypad detection on; and the hangup and dial documents are well formed. An end-to-end test (`telnyx.e2e.test.ts`) runs a whole call as the carrier would. What the carrier does not document is marked `ASSUMED` in the fixtures and the provider's notes until a live call settles it ([live-checks.md](live-checks.md)). It found a gap on its first run: the wire was dropping the call ids Telnyx adds to its setup frame. CONTRIBUTING.md, "Adding a voice provider", is the recipe.

**The web chat: our own wire.** The relay messages are a carrier's, so the web gets its own small protocol (`channel/chat/protocol.ts`): JSON, one message per WebSocket frame, versioned by the first message's `v`. The client sends `start` (with an optional language, sign-in token and resume token), `text`, `sign_in` and `ping`; the server sends `ready`, `say` (the line and its language), `transfer` (a reason, never the values collected), `end`, `signed_in`, `pong` and `error` with a fixed code. The core, the run loop and the prompts never import the wire, and the wire never imports the server. `CHAT=on` serves it on `/chat` (off by default, and then the server is unchanged): the page's origin is checked against `CHAT_ALLOWED_ORIGINS` before the upgrade; each chat is a `WEB_CHAT` session run through the same turn path as a call, with the same trace, audit and console; a dropped socket does not end the chat, which a resume token reopens until `CHAT_IDLE_MS` of quiet; `CHAT_MAX_SESSIONS` bounds the chats live at once and a session's waiting messages are bounded too, so a script cannot queue model calls without end. An app's own chat pages (`AppRoute`) are unchanged beside it.

**Sign-in methods.** `CHAT_SIGNIN` chooses: `none` (the default), `jwt` (the site's identity provider's signed token, verified with `node:crypto` against its published keys at `CHAT_JWKS_URL`, with the issuer and audience the deployment names; RS256, ES256 and EdDSA, never `none` or HMAC), or `mock` (`mock:<id>`, refused unless the server is on a laptop). The app decides who a verified token names: identity.yaml's `signIn.claim` (default `sub`) names the token claim that carries the subject's id, looked up through the app's principal directory, and `principals.fromClaims` in code reads the token claims for anything else (a delegate, a tenant). Whatever comes back is checked as a signed-in principal always is, and a subject's sign-in is the core's `auth.signed_in` event, so the gate sees a signed-in chat exactly as it sees any other session at that level. A token never reaches a log, an error or the frame log.

**The widget.** `@dialogwright/widget` is a separate package: a classic script (and an ES module) of about 5.6 KB gzipped, under a 15 KB budget its test enforces, with no runtime dependencies and none of the engine. A site loads it from its own CDN and mounts it with a script tag's `data-*` attributes or `DialogWright.mount({...})`: the endpoint, the language to ask for (default the page's `<html lang>`), the title, every visible word, the position, and in code the sign-in token (`getToken`), what a transfer does (`onTransfer`), every client event (`onEvent`) and the reconnect schedule (`backoffMs`, `maxReconnects`). It renders in a shadow root, themed with CSS custom properties, and puts every line in as text. `createChatClient` is the same client without a page, for a site with its own interface. `WIDGET=on` makes the server serve the built script on `/widget.js` for a laptop or a simple deployment; it does not host the site's pages.

## 11. Foundations designed in from the start

Each of these is a field, an interface or a few lines of configuration, so later features never need a redesign.

1. **Languages**: a locale on the session and on every prompt, slot parser and passage. Built today: `locale:` in app.yaml, a `locale/<tag>/prompts.yaml` per extra language, the session's locale from the channel's start, and per-line fallback to the default language; translated lines are spoken by text-to-speech, since recorded clips are in the default language. Carried end to end on the channels (Phase 7): a line carries its language (`Say.lang`) to the wire, so each text frame and each chat `say` names it; on the phone, app.yaml's `voice.numbers` starts a call to a number in its locale, and for an app that names its languages the start document carries the call's language, one `<Language>` per locale it may switch to (each with its own voice and recognizer per carrier, from `voice.locales`, a language with none of its own getting the carrier's default rather than another language's), and a `locale` parameter the relay hands back; an intent with `locale:` switches mid-call, emitting `set_language` and saying the line, the resumed question and the values already collected in the new language; a reconnect resumes in the language the call is in; and a chat asks for its language as it starts (`start.locale`, matched as a call's is). An app that names no languages sends exactly what it sent before. What is still not carried, or not yet confirmed: hints stay the starting language's after a switch, since the carriers take hints on the relay element only; that a carrier applies a `<Language>` child's voice and recognizer to the call's first language (as Twilio's reference reads) is to be confirmed on a live call, on both carriers; Telnyx now documents the `<Language>` child (its `code`, and per language `voice`, `ttsProvider`, `transcriptionProvider` and `speechModel`), the `<Parameter>` child (its pairs come back in the setup frame's `customParameters`) and the `language` frame, while whether it reads a text frame's `lang` (its text frame example has `token` and `last` only) and whether a child inherits what it leaves out from the relay element are to be confirmed live; and the inbound `user.speech.lang` is not read (no decision depends on it). Built with the slot library: the session's locale on every slot's context, a word table per language (English, Spanish) for number words, name spans and fillers, Spanish formats for days, birth dates and spans of days, a day-first keypad, and `locale/<tag>/slots.yaml` for the words an app chooses for a value (a choice option's `say`, a text slot's stand-in); the questions stay in the default language by design, since the model reads them and their labels are keys. Spanish is proven on the library fixture, where a call fills a card number and a branch by Spanish voice; another language needs a lexicon and formats added behind the same locale gate. Built with the knowledge base: a topic's wording and its passages by locale (`kb/locale/<tag>/`), each translation approved like any passage, and a fallback that fails closed (`localeFallback: none`, the default) or speaks the default language's passage. Intent labels by locale come later.
2. **Versioned configuration per decision**: every configuration file carries a content hash (SHA-256 of its parsed content, so comments and quoting do not change it, and key order does, since it is meaning) and the app a combined one. Built today: the `call_started` audit row records the combined hash and each file's, every trace record carries the combined hash, and the console shows its first eight characters. The hashes are never sent to the model. Built with the knowledge base: the hashes include every file of `kb/` that is read (kb.yaml, topics, passages, sources and the locale files), so a call is tied to the exact knowledge it ran under, and the knowledge record a turn writes carries the short hashes of the approval (12 hex characters of the source section's and of everything approved) with the passage's id and version; the index's hash is in the trace's retrieval record. Still to come: the hashes on each gate decision.
3. **Retention and erasure**: the hash chain holds hashes and minimized entries; personal data lives in separately keyed records that can be erased without breaking the chain; retention is set per store. Built for one machine: `TRACE_RETENTION_DAYS` and `AUDIT_RETENTION_DAYS` (§8); erasure of a subject's records is still to come.
4. **Handoff integration**: a handoff-target interface (phone transfer now; SIP transfer with headers; a webhook delivering the note to the agent desktop; contact-center adapters later).
5. **Time zones and business hours**: a per-app time zone and calendar, an injected clock everywhere, and a built-in after-hours path (callback, voicemail or message).
6. **Asynchronous channels**: session lifetime and resume per channel; the channel interface supports messaging that pauses for hours.
7. **Who can see calls**: console sign-in with roles (viewer, supervisor, admin) and an access log of who replayed which call, in the audit store. Built for one owner: `CONSOLE_AUTH=token`'s sign-in and the `console_access` entries in the audit chain (§8). Still to come: roles and many users.
8. **Extension hooks**: call started, turn resolved, handoff, call ended. Hooks are observe-only by default: a hook can act externally but never change a decision.
9. **Resilient tools**: the tool context provides timeouts, retries with idempotency keys, a circuit breaker and caching, declared per tool. Built: the idempotency keys (`idempotent: true` on a tool, a key on every service request, §8). Still to come: timeouts, retries, a circuit breaker and caching, and a cap on model requests in flight.
10. **Business analytics**: a stable event stream derived from the audit log (containment by intent, handoff reasons, knowledge gaps) and a small built-in report.

## 12. Roadmap

Each phase ends with green tests and a working app.

| Phase | Name | Delivers | Proves | Status |
|---|---|---|---|---|
| 1 | Groundwork | The `App` contract and registry, with sessions that carry an app id and a boundary test that forbids engine-to-app imports (the seam); our own channel events, actions and capabilities, with the carrier format moved into an adapter (the channel model); an engine with no app names, data or assumptions left, proved by a test fixture app (`testkit`); this workspace, the `dialogwright` package, community files, this document and CI (the repository); and the clinic on the `App` contract (`apps/clinic`), with its own corpus, scripted calls, stub baseline and a recording against a decision model, replayed offline | Behavior identical across each move; the engine stands on its own, in the open, with a real app on it | Done |
| 2 | App definition | `defineApp`, JSON Schemas, the loader, `pnpm check`; the clinic as a folder; locales; configuration hashes; [authoring-an-app.md](authoring-an-app.md) | An app is a folder | Done |
| 3 | Slot library | `slots.yaml` and seven built-in types (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`), each with an options schema, a generated docs page and starter examples; the conformance kit and the shadow harness; Spanish number words, names and dates; the clinic's slots all on the library with its cassette replaying with zero misses | Most slots are configuration, and slot types are something people can contribute | Done |
| 4 | Policy and identity | `policy.yaml` of named rules (including `dateInRange` and `limit`) and `identity.yaml` with named levels, a one-time code, sign-in by capability and delegates, every app running from them; redaction per principal and declared audit minimization; policy tested against the file (invariants, the matrix golden, required rule examples); the policy card, the app map and `CODEOWNERS` | Compliance-owned policy, tested against the file, with the gate's decisions unchanged by the move | Done |
| 5 | The utility app, built by an AI coding assistant | The create-app skill (a worksheet, verified patterns and a corpus guide, with a test of its links), `pnpm create-app` (a scaffold with and without identity, which passes `pnpm check`, its tests and its regression as created), a `CLAUDE.md` for each app; the utility example, built through that path from a paragraph; and two trials of the path with fresh assistants, with their logs and what each stumble changed ([trials/README.md](trials/README.md)). Its recording against a decision model, the maintainer's step, came after | The assistant goal, by doing it: a working app from one paragraph in about 15 and 11 minutes (self-reported, consistent with the commit times), with the checks and the scenario suites green (the first trial's `pnpm -r test` excepted, a framework test since fixed), and a policy hole both builders found through the matrix (a delegate could have had a one-time code texted to someone else's phone), now closed by the engine for every app and shown in the policy matrix and card | Done |
| 6 | Knowledge base | An app's `kb/` folder of topics and approved passages with their sources, approval, staleness and withholding; retrieval in the turn before planning, with a fail-open budget; the `topic` slot type; answers said word for word through the gate (a form's `answers:`, an informational intent's `passage:`, account lines from the caller's own data); hybrid retrieval with a static in-process embedder (`kb:model`, `kb:index`, `kb:bakeoff` with the floor and cap sweep); `kb:approve` and `kb:status`; the authoring package `@dialogwright/kb-author` (`kb:ingest` for folders and websites, `kb:draft`, `kb:review`, `kb:refresh`, `kb:gaps`); the knowledge hashes and record | Knowledge that scales without generated answers: a knowledge base built from documents by a model's drafts and a person's approval, spoken word for word and withheld when its source changes, with every app that has none unchanged byte for byte (the clinic's cassette replays with zero misses) | Done |
| 7 | Channels | Carriers as plug-ins (`VoiceProvider`), Twilio and Telnyx, chosen by `VOICE_PROVIDERS`, with a conformance kit run against each carrier's documented frames and webhooks; a call in the caller's language end to end (`voice.numbers`, `voice.locales` with a voice and recognizer per carrier and locale, a language-switch intent and `set_language`); the engine's web chat (`CHAT=on`: our own wire, allowed origins, resume, limits) with sign-in by the site's token (`CHAT_SIGNIN`, `signIn.claim`, `principals.fromClaims`) and a chat's request for a language; the widget, `@dialogwright/widget`, a few kilobytes a site embeds and themes. Every choice an option with a default ([the guide's section 13](authoring-an-app.md#13-channels)) | Same app, two carriers, plus web; what only real accounts can confirm is a checklist for the maintainer, [live-checks.md](live-checks.md) | Done |
| 8 | Local-first, on a machine you own | The first hour (`pnpm configure`, `pnpm start` with a quick tunnel, `pnpm diagnose`), a settings file (`ENV_FILE`), service files (`pnpm service`), readiness and a drain, crash handling, retention, the session store interfaces with memory and file implementations and their contract suite, versioned sessions that resume after a restart (`SESSION_STORE=file:`, `RESTART_PAUSE_S`, `SESSION_FSYNC`), idempotent writes, carrier fallback documents (`pnpm fallback`), console sign-in for one owner (`CONSOLE_AUTH=token`, `pnpm console:link`) with an access log, and the text slot's `pick` option (§8) | A developer answers a real phone call on their own laptop within an hour with two keys, then runs the same line on any Mac or Linux machine that stays on, where a restart (an update, a reboot, a crash) does not drop a caller (the kill-the-server test) and the owner looks at calls from a phone | Done |
| 8b | Many servers | Shared stores passing the same contract suite (Redis, say, for calls, chats and tokens); the audit in Postgres with a chain per session anchored daily; traces in object storage; console events over pub/sub; `--role voice\|chat\|console`; a container image and a `docker compose` stack with two instances behind a load balancer; console roles with single sign-on (§8) | A deploy or a failed instance never drops a call (the kill-an-instance test), and the same app folder runs on one machine or many | Planned |
| 9 | Generated wording (opt-in) | Renderer interface, the LLM adapter, `style.yaml`, checks, fallback, cassette, console display; a prompt is flagged as generated, and the fixed line is its fallback | The model chooses the words, never the content, and the difference is measured | Planned |
| 10 | Open source polish | An adopter's README, adversarial suite inheritance (`llms.txt`, the slot pages and the slot contribution notes came with the slot library) | Someone else can adopt it | Planned |

The foundations (§11) land in the phase that owns their area.

What each phase left for later:

- **Slot library (Phase 3):** `time-slot` (later, with a re-record, since it would re-key every recorded request). The per-slot `listen:` option is built, with today's behaviour as its default (`up-front`); an app that chooses another value for a slot records again. The one-time code never became a slot type: it is a factor of `identity.yaml` (§6).
- **App definition (Phase 2):** `style.yaml` and generated wording (Phase 9); a locale carried end to end on the channels was Phase 7's, and is built (§11.1).
- **Policy and identity (Phase 4):** the shared adversarial suite, which every app inherits (Phase 10); a link from a form to the action it writes, which would let each `confirmed` rule name its own fields (until then every `confirmed` rule of an app names the same fields in the same order, since a read-back's hash is taken once); the config hashes on each gate decision (§11); and a review item for apps: a tool of an app's own that contacts a subject directly (a text or an email to the contact on file, a link to send a document, say) and that a party acting for subjects may call. The engine keeps its identity tools for the subject alone, but such a tool is the app's, so whether a party acting for subjects may set it going is the app's policy to say (a role rule, or a check that the contact asked for it); the policy card lists it among the actions every role may ask for until the policy says otherwise.
- **Knowledge base (Phase 6):** two-part questions, where one call asks two things and hears two passages (one choice question cannot select two topics, and adding a second re-keys the requests of every turn, so it waits for a deliberate re-record); moving an app that keeps a retriever of its own to the engine's hybrid retrieval (the candidates some turns offer change, so the calls those turns are in are re-recorded); pgvector for production, behind the same `VectorIndex` interface (not built in Phase 8; a candidate for Phase 8b); low-risk answers in generated wording grounded in approved passages, for topics marked `risk: low` (Phase 9, opt-in, under §5's checks); and the review page in the operator console, once the console's sign-in has roles to say who may approve (until then it is a local server behind a one-time token, §9).
- **The utility app (Phase 5):** a slot type for an amount of money (cents, "a hundred and fifty", keypad entry; until then a whole amount is a `digits` slot with a mask); more than one seeded caller in a corpus (every corpus line inside a form runs as the one `testing.seed.caller`, so a delegate's answer inside a form is covered only by scripted calls); a confirmed list for each action (a form's `calls` could carry it, so a write need not confirm another write's fields); a regress mode that adds only new baseline entries (today a new corpus line or scripted call in an app with a baseline means a hand edit, since `--update` is for a first baseline); a value read back in the caller's own words without recording it verbatim (a `text` slot keeps the whole turn, unless its `pick` option picks out the part that is the value, as the utility's `place` now does); the wording of the menu's re-offer after an informational key, which opens as if the caller had missed again. (The recording of the utility app against a decision model, the maintainer's paid step, has since been made, and CI replays its cassette.)
- **Channels (Phase 7):** messaging (SMS, WhatsApp) and audio streaming stay "later" in §10; the planned `ui` action (buttons, quick replies such as "Sign in to continue") was not needed by anything here; the inbound `user.speech.lang` is still not read, since no decision depends on it; intent labels by locale (§11.1); a chat session now survives a restart of its server with the file store (Phase 8), but a resume still reaches only the machine that holds it until Phase 8b's shared store; and the widget is published to npm with the engine in Phase 10 (until then a deployment builds it, `pnpm --filter @dialogwright/widget build`, and publishes the file to its own CDN). What a live call or a real identity provider must confirm is [live-checks.md](live-checks.md).
- **Local-first (Phase 8):** everything for many servers is Phase 8b (§8: shared stores passing the same contract suite, the audit in Postgres, traces in object storage, console events over pub/sub, `--role`, a container image and a compose stack with the kill-an-instance test, console roles); what only a live call can show (whether each carrier uses its fallback for a failed callback mid-call, takes a `<Pause>` before the `<Connect>`, and reaches a quick tunnel's WebSocket) is [live-checks.md](live-checks.md), checks 3 and 7; the utility's `place` turns on the text slot's `pick` (its cassette is to be recorded again, as its README says); and the personal line (a first app of its own: taking a message and delivering it, business hours and an after-hours path, caller recognition, urgent callers handed to a mobile), which needs nothing from 8b.

### Phase 7 follow-ups

Small things the phase's reviews found and left, each to fix on its own:

- **Hints after a language switch.** A call's recognition hints are the starting locale's for the whole call: the carriers take `hints` on the relay element only, and `set_language` carries no hints. A caller who switches to Spanish is heard with the English words as hints. A fix needs a carrier that takes hints per language (or per `language` frame); until then an app can list both languages' words in the starting locale's `hints`.
- **The widget: no unread indicator.** A line that arrives while the panel is closed shows nothing on the launcher; the person sees it only on opening the panel.
- **The widget: Escape propagates.** Escape closes the panel and is not stopped there, so a page's own Escape handler (a dialog the widget sits in, say) also sees it.
- **The widget: double load.** A page that loads the script twice (two tags, or a tag and `DialogWright.mount`) gets two widgets; the second load does not find the first.
- **Telnyx assumptions.** The webhook encoding and call id field, the handoff field name, `hints`, text frames' `lang`, a `<Language>` child inheriting from the relay element, the action callback's call status (and what a callback with none gets), and whether the action callback is posted when the relay socket fails are written as assumptions in `server/voice/telnyx.ts` and marked `ASSUMED` in the fixtures until [live-checks.md](live-checks.md) settles them; a JSON webhook is read by its top-level fields only, so a nested Call Control payload would need the parser to follow it.
- **A recognizer moved off Deepgram flux and partial prompts.** The no-input wait is cancelled at the caller's first syllable by the relay's partial prompts; whether another recognizer keeps sending them is to be confirmed live; if one does not, the wait can run out, and the question be asked again, while a caller on it is still speaking.
- **Tests that dial `localhost`.** The widget's end-to-end tests (`packages/widget/src/testServer.ts`) and the utility's `/chat-demo` test start the server on every address and dial `localhost` (deliberately: the laptop's public host). Where `localhost` resolves to 127.0.0.1 first they have the exposure the engine's server tests had (a port another process holds on 127.0.0.1 alone), which those now avoid by listening on 127.0.0.1; these need the same care without losing what they test.

### Phase 8 follow-ups

Small things the four parts' reviews found and left, grouped, each to fix on its own:

- **Services.**
  - The systemd user unit names `After=` and `Wants=network-online.target`, a system target a user manager does not have: harmless, and left for a system unit.
  - Whether `launchctl kickstart -k` sends SIGTERM (so the drain runs) is not checked; the guide says to restart with it.
  - The `cloudflared` output the tunnel parser is tested on is written in its log format, not captured from a run (`server/fixture/cloudflared-quick.README.md`).
- **The server.**
  - `/health`'s `disk` scan is synchronous (at most once a minute, and only with a retention set).
  - `RunningServer` and `ChatEndpoint` gained required properties: an app that builds its own fake of either would need them (none in the repository does).
- **Stores and restarts.**
  - The server calls its `TokenStore` synchronously (`decideAction`'s mint and revoke, the socket's `verify`): a networked store (Phase 8b) needs those calls awaited.
  - Nothing stops two servers sharing one sessions folder (they would sweep each other's calls): the docs say one server per folder; a lock would enforce it.
  - An existing root folder for `SESSION_STORE=file:` keeps its mode, with a warning (its `calls/` and `chats/` are always 700, and every file 600), since the folder may hold other files.
  - `SessionStore` and `CallTokens` stay in `server/sessions.ts` and `server/tokens.ts` (re-exported from `server/stores/memory.ts`), so no import path changed.
  - A chat resumed after a restart is sent `ready` only, as any chat resume is; the `resumed` line is voice's.
- **The console.**
  - One owner and no roles; the review page stays a local server until roles say who may approve.
  - `CONSOLE_CLIENT_ADDRESS=auto` trusts `cf-connecting-ip` first, which a client behind a tunnel that is not Cloudflare's could set: documented, with the setting to name the right header.
- **Picking the value out of the words.**
  - A pick's joining words and prepositions live in the slot's options (`pick.words`), not `locale/<tag>/slots.yaml`, since they decide what the model is asked; English and Spanish are built in.
  - Only two clauses are joined at a time ("Elm and Third and Main" offers "Elm and Third" and "Third and Main", never all three).
  - The tails from each word (to the end of a clause or a join) are offered after the parts split at punctuation, joining words and prepositions, so a lead-in no word list names ("yeah my address is", any language) is cut off by selection, not by a list. Only tails: no heads or inner spans, so a value with an aside after it and nothing to cut at keeps the whole words. A tail is two spoken words or more. The split parts keep their eight letters; the tails fill up to sixteen, a clause's before a join's and the shortest first, so a long lead-in is what the cap drops.

## 13. Open source and licensing

The framework is Apache-2.0. Some enterprise features may be offered separately under a commercial license.

Contributors are asked to sign a contributor license agreement on their first pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](../NOTICE).

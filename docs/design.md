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
2. **The core.** Deterministic code runs the fill-and-ask loop: intents start forms, forms collect slots, filled forms are read back and confirmed, and silence, repetition, frustration and handoff are handled in one place. The core never imports an app; it reads everything app-specific through the `App` contract.
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
| `channels` | The text relay with Twilio and Telnyx adapters, the web chat endpoint and widget (§10) |
| `stores` | Session, audit, trace and event-bus interfaces with laptop and production implementations (§8) |
| `console` | The live operator console and call replay, with access control |
| `harness` | Corpus and scenario runner, cassette record and replay, regression, threshold sweep, adversarial suite |
| `a2a` | A strict client for downstream services that speak the agent-to-agent protocol (optional) |
| `apps/clinic` | Example: appointment scheduling with name and date of birth, as an app folder |
| `apps/utility` | Example: identity, policy, writes, delegates, knowledge base |

### An app is a folder

An app is a folder of YAML for what is data, plus TypeScript for what runs. `defineApp(dir, code)` joins the two into the `App` contract the engine runs, and `pnpm check` finds everything wrong with either, or with how they meet, in one pass. [authoring-an-app.md](authoring-an-app.md) is the guide; `apps/clinic` is the worked example.

```
my-app/
  app.yaml          id, locale, brand, console, voice, handoff, wording, thresholds, carried slots, fixtures
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

- **Built-in rules** (each is a name with parameters, listed in the order the gate runs them; the first that fails decides): `identity` (the level is strong enough), `scope` (the subject the call names is one the caller may see; never from the conversation), `role` (allow, refuse, or a person, per role), `confirmed` (a hash of exactly what the caller confirmed matches what the write sends), `attempts`, `fields` (the minimum data sent to downstream services), `dateInRange` (a date inside bounds, written as `today`, a number of days from today, a date, or a lookup the app supplies) and `limit` (a number inside limits). An action not listed is blocked. Bounds come only from the app's code and systems, through a small reference grammar that is read when the app is built and never run, and every range rule fails closed.
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
- **Store contract tests**: one suite run against every implementation of each store (§8).
- **Thesis metrics** from every run: slots per utterance, turns to completion, decision latency, cost per call.
- **CI** runs the checks, unit tests, and stub and recorded regression on every push with no secrets. Recording stays a deliberate local step with real keys.

## 8. Production architecture, and laptop mode

**Principle: the agent failing never means dead air.**

1. A turn fails: re-ask, then hand off to a person.
2. An instance dies or redeploys mid-call: the socket closes, the carrier calls the action URL, and the call reconnects to another instance and resumes from the shared session ("Sorry, I lost you for a moment"). The single-process version exists today: reconnect with a one-time token, up to a limit, then a polite transfer.
3. The whole service is down: the carrier's fallback URL serves static markup from somewhere independent (a CDN or object storage) that apologizes and dials the human queue.

- **Sessions are externalized.** The pure core already returns a new serializable session each turn. It is saved after every turn (keyed by call or chat id, with a time-to-live and a signed resume token), so any instance can resume any call. Sessions carry a schema version; a resume onto an incompatible version hands off politely.
- **Writes are idempotent.** Every write tool gets a key derived from the session (call id, form, confirmed-values hash), so a retry after a crash never acts twice. In-flight effects are recorded in the session and re-issued with the same key.
- **Load balancing**: WebSockets with an idle timeout longer than the longest call; no sticky sessions; carrier webhooks are stateless HTTP.
- **Deploys drain.** New instances report ready; old ones stop taking new calls, keep serving, and after a drain limit (about 15 minutes) close remaining sockets, which reconnect to the new version.
- **Shared stores**: sessions in Redis; the audit log in Postgres with a hash chain per session and each session's final hash anchored into a daily chain; traces in object storage; console events over Redis pub/sub.
- **Roles**: one codebase, separate deploys: `--role voice | chat | console`. Voice and chat are public; the console is internal only (single sign-on or VPN).
- **Hosting**: a starter setup on a container platform with WebSockets (two instances, managed Redis and Postgres); production on containers behind an application load balancer across availability zones, with a second region as the carrier's fallback target. For regulated data: services covered by the relevant agreements (such as a HIPAA BAA), encryption at rest, retention policies and in-region data.
- **Observability**: OpenTelemetry metrics and traces; logs carry ids, never personal data; alerts on fallback hits, system-failure handoffs, reconnect rate and turn latency.

**Laptop mode stays first-class.** Every production dependency is an interface whose default is the laptop implementation: sessions in memory, audit and traces in local files, the console bus in process, the stub perceiver and templates without keys, the chat widget served locally, a mock sign-in. `pnpm dev` runs voice, chat and console in one process. The same code runs in both modes (resume, idempotency and drain run locally against the memory store), and contract tests keep the implementations honest. `pnpm dev:stack` optionally brings up Redis, Postgres and an object-storage stand-in with `docker compose`, with two instances behind a local load balancer, where the kill-an-instance test runs. Configuration selects each piece independently (`SESSION_STORE=redis://...`).

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
- **Hybrid retrieval from the start.** The decision model guards precision, so retrieval only needs recall: keywords (BM25 with exact phrases, so plan names and codes match) catch exact terms; embeddings catch meaning and misrecognized speech; the two rankings are merged by reciprocal rank fusion and capped (eight). The default embedder is a static model (Model2Vec `potion-base-8M`) run in pure TypeScript: no key, no native dependency, about a hundredth of a millisecond a question, and the same bits on every machine, which a cassette replay needs since the nominations shape the request. Its weights are downloaded once at a pinned revision, checked by SHA-256 and cached (`pnpm kb:model`), never vendored and never fetched on a call. The vectors of the topics' texts are a committed index (`pnpm kb:index`, keyed by content hash, which re-embeds only what changed); `pnpm check` holds it to the topics. A larger model (bge-small through ONNX) is an optional adapter behind a peer dependency, since its last bits can differ between CPUs. `pnpm kb:bakeoff` compares the retrievers on paraphrase sets (recall at the cap, candidates, speed) and sweeps the floor and the cap offline, because they change what the model is asked and so cannot be tuned by re-recording. The index is in memory (brute force is fine at thousands of topics); production uses the same `VectorIndex` interface in a database (Phase 8).
- **Authoring that scales.** Pre-approved answers only scale with a way to make them, so the package `@dialogwright/kb-author` (authoring only: an app never imports it and the runtime carries none of its dependencies) builds a knowledge base from documents, with a person at the end. `pnpm kb:ingest` reads a folder of PDF, DOCX, HTML, Markdown and text files, or a website to a link depth (same host, robots.txt, a rate and page limit), into `kb/sources` by section with provenance. `pnpm kb:draft` has a model, with the author's own key on their machine and never in CI, propose passages into `kb/pending`; each must quote its source section word for word, fit the answer length and name a real topic, or it is not written. Pending drafts are never read at run time. `pnpm kb:review` is a page where a person approves (`pnpm kb:approve`, which records the approver, the day and both hashes in an append-only `kb/approvals.jsonl`), edits, rejects, or accepts a proposed topic; only a person approves. `pnpm kb:refresh` reads the sources again and withholds any passage whose source changed until it is reviewed again, with a word diff against the text as approved. Every "none" in production feeds `pnpm kb:gaps`, a ranked backlog from the traces, with the fix for each. For the long tail, each app chooses a handoff today; generated wording grounded in approved passages, for content marked `risk: low`, is Phase 9, under §5's checks.
- **The review page is a local server, not the operator console.** The plan was to put it in the console. The console has no access control until Phase 8, and its tunnel carries the public's requests, so a page that approves what callers hear would be open to whoever reaches it. `kb:review` instead serves 127.0.0.1 on a free port, answers only a loopback peer, and needs a one-time token that is in the URL it prints. It moves into the console once Phase 8's access control exists.
- **Testing.** Paraphrase sets per topic, with an app test that holds retrieval's recall to them and goldens of what each retriever nominates for each line, so a change to a keyword or a floor is a diff to read; the stub regression runs the real retriever. In production, `kb:gaps` counts the "none" selections and the close calls between two topics.
- **Two-part questions are deferred.** One choice question cannot select two topics, and a second one would re-key the requests of every turn.

## 10. Channels: our own event model, providers as adapters

The core speaks its own channel event model. Every provider is an adapter that maps its wire format onto it, so the core never sees a provider's messages and never checks a channel's name. This is implemented today, with Twilio ConversationRelay as the first adapter.

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

**Actions out of the core** (`Action`):

| Action | Carries |
|---|---|
| `say` | `parts` (text for the channel's own voice or display, or a recorded clip's URL) and `interruptible` |
| `end` | `completed`: the business done |
| `transfer` | `reason`, `completed`, `queued`, and the collected `slots`, for the person taking over |
| `send_digits` | Key tones to play on the line |
| `set_language` | Speech and recognition languages |

Planned additions: a `ui` action for buttons and quick replies (such as "Sign in to continue"), and confidence and alternative transcripts on speech.

**Capabilities** (`ChannelCaps`): each channel declares `speech`, `keypad`, `bargeIn`, `recordedAudio`, `richUi`, `signIn` and `async`. The core checks capabilities, never names: no keypad prompt where `!keypad`, no spoken identity factors where the user signs in instead. Two channels are defined today: `VOICE_RELAY` (speech, keypad, barge-in, recorded audio) and `WEB_CHAT` (rich UI, sign-in). The core reads `speech`, `keypad` and `signIn` today; the others are declared for the channels that need them.

**Providers as adapters:**

| Type | Who does speech | Examples | When |
|---|---|---|---|
| Text relay | The provider | Twilio ConversationRelay (today); Telnyx Conversation Relay (same message types, different webhook signatures and transfer markup) | First release |
| Web and app chat | None | The embeddable widget | First release |
| Messaging | None, asynchronous | SMS, WhatsApp | Soon after |
| Audio streaming | The framework (recognition, synthesis, end-of-speech, barge-in), likely through Pipecat or LiveKit Agents | Twilio Media Streams, Telnyx media streaming, SIP, WebRTC | Later |
| Contact-center connectors | Varies | Contact-center platforms' audio and digital connectors | Later; audio connectors need the audio pipeline |

The web chat widget is a small bundle on a CDN that a site embeds. It opens a WebSocket to the chat endpoint (allowed origins checked) and signs in by passing the site's identity token, verified against the identity provider's published keys. The server does not host the site's pages.

## 11. Foundations designed in from the start

Each of these is a field, an interface or a few lines of configuration, so later features never need a redesign.

1. **Languages**: a locale on the session and on every prompt, slot parser and passage. Built today: `locale:` in app.yaml, a `locale/<tag>/prompts.yaml` per extra language, the session's locale from the channel's start (a `locale` custom parameter on ConversationRelay), and per-line fallback to the default language; translated lines are spoken by text-to-speech, since recorded clips are in the default language. Not yet carried by any channel: the server's TwiML sends no `locale` parameter and sets no `language`, `ttsLanguage` or `transcriptionLanguage`, and the engine never emits `set_language`, so a voice session in another locale is still transcribed and voiced with the relay's defaults; chat has no way to ask for a locale; and the outbound text frames say `lang: en-US`. That channel work is Phase 7 (Channels). Built with the slot library: the session's locale on every slot's context, a word table per language (English, Spanish) for number words, name spans and fillers, Spanish formats for days, birth dates and spans of days, a day-first keypad, and `locale/<tag>/slots.yaml` for the words an app chooses for a value (a choice option's `say`, a text slot's stand-in); the questions stay in the default language by design, since the model reads them and their labels are keys. Spanish is proven on the library fixture, where a call fills a card number and a branch by Spanish voice; another language needs a lexicon and formats added behind the same locale gate. Built with the knowledge base: a topic's wording and its passages by locale (`kb/locale/<tag>/`), each translation approved like any passage, and a fallback that fails closed (`localeFallback: none`, the default) or speaks the default language's passage. Intent labels by locale come later.
2. **Versioned configuration per decision**: every configuration file carries a content hash (SHA-256 of its parsed content, so comments and quoting do not change it, and key order does, since it is meaning) and the app a combined one. Built today: the `call_started` audit row records the combined hash and each file's, every trace record carries the combined hash, and the console shows its first eight characters. The hashes are never sent to the model. Built with the knowledge base: the hashes include every file of `kb/` that is read (kb.yaml, topics, passages, sources and the locale files), so a call is tied to the exact knowledge it ran under, and the knowledge record a turn writes carries the short hashes of the approval (12 hex characters of the source section's and of everything approved) with the passage's id and version; the index's hash is in the trace's retrieval record. Still to come: the hashes on each gate decision.
3. **Retention and erasure**: the hash chain holds hashes and minimized entries; personal data lives in separately keyed records that can be erased without breaking the chain; retention is set per store.
4. **Handoff integration**: a handoff-target interface (phone transfer now; SIP transfer with headers; a webhook delivering the note to the agent desktop; contact-center adapters later).
5. **Time zones and business hours**: a per-app time zone and calendar, an injected clock everywhere, and a built-in after-hours path (callback, voicemail or message).
6. **Asynchronous channels**: session lifetime and resume per channel; the channel interface supports messaging that pauses for hours.
7. **Who can see calls**: console sign-in with roles (viewer, supervisor, admin) and an access log of who replayed which call, in the audit store.
8. **Extension hooks**: call started, turn resolved, handoff, call ended. Hooks are observe-only by default: a hook can act externally but never change a decision.
9. **Resilient tools**: the tool context provides timeouts, retries with idempotency keys, a circuit breaker and caching, declared per tool.
10. **Business analytics**: a stable event stream derived from the audit log (containment by intent, handoff reasons, knowledge gaps) and a small built-in report.

## 12. Roadmap

Each phase ends with green tests and a working app.

| Phase | Name | Delivers | Proves | Status |
|---|---|---|---|---|
| 1 | Groundwork | The `App` contract and registry, with sessions that carry an app id and a boundary test that forbids engine-to-app imports (the seam); our own channel events, actions and capabilities, with the carrier format moved into an adapter (the channel model); an engine with no app names, data or assumptions left, proved by a test fixture app (`testkit`); this workspace, the `dialogwright` package, community files, this document and CI (the repository); and the clinic on the `App` contract (`apps/clinic`), with its own corpus, scripted calls, stub baseline and a recording against a decision model, replayed offline | Behavior identical across each move; the engine stands on its own, in the open, with a real app on it | Done |
| 2 | App definition | `defineApp`, JSON Schemas, the loader, `pnpm check`; the clinic as a folder; locales; configuration hashes; [authoring-an-app.md](authoring-an-app.md) | An app is a folder | Done |
| 3 | Slot library | `slots.yaml` and seven built-in types (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`), each with an options schema, a generated docs page and starter examples; the conformance kit and the shadow harness; Spanish number words, names and dates; the clinic's slots all on the library with its cassette replaying with zero misses | Most slots are configuration, and slot types are something people can contribute | Done |
| 4 | Policy and identity | `policy.yaml` of named rules (including `dateInRange` and `limit`) and `identity.yaml` with named levels, a one-time code, sign-in by capability and delegates, every app running from them; redaction per principal and declared audit minimization; policy tested against the file (invariants, the matrix golden, required rule examples); the policy card, the app map and `CODEOWNERS` | Compliance-owned policy, tested against the file, with the gate's decisions unchanged by the move | Done |
| 5 | The utility app, built by an AI coding assistant | The create-app skill (a worksheet, verified patterns and a corpus guide, with a test of its links), `pnpm create-app` (a scaffold with and without identity, which passes `pnpm check`, its tests and its regression as created), a `CLAUDE.md` for each app; the utility example, built through that path from a paragraph; and two trials of the path with fresh assistants, with their logs and what each stumble changed ([trials/README.md](trials/README.md)). Its recording against a decision model is the maintainer's step, not yet taken | The assistant goal, by doing it: a working app from one paragraph in about 15 and 11 minutes (self-reported, consistent with the commit times), with the checks and the scenario suites green (the first trial's `pnpm -r test` excepted, a framework test since fixed), and a policy hole both builders found through the matrix (a delegate could have had a one-time code texted to someone else's phone), now closed by the engine for every app and shown in the policy matrix and card | In progress (PR) |
| 6 | Knowledge base | An app's `kb/` folder of topics and approved passages with their sources, approval, staleness and withholding; retrieval in the turn before planning, with a fail-open budget; the `topic` slot type; answers said word for word through the gate (a form's `answers:`, an informational intent's `passage:`, account lines from the caller's own data); hybrid retrieval with a static in-process embedder (`kb:model`, `kb:index`, `kb:bakeoff` with the floor and cap sweep); `kb:approve` and `kb:status`; the authoring package `@dialogwright/kb-author` (`kb:ingest` for folders and websites, `kb:draft`, `kb:review`, `kb:refresh`, `kb:gaps`); the knowledge hashes and record | Knowledge that scales without generated answers: a knowledge base built from documents by a model's drafts and a person's approval, spoken word for word and withheld when its source changes, with every app that has none unchanged byte for byte (the clinic's cassette replays with zero misses) | Done |
| 7 | Channels | The relay with Twilio and Telnyx adapters and conformance tests; the CDN widget with token sign-in; a session's locale carried to the carrier (its language attributes, `set_language`) and requested from chat | Same app, two carriers, plus web | Planned |
| 8 | Production | Store interfaces with production implementations; resume across instances; idempotent writes; readiness and drain; a `docker compose` stack; a reference deployment; console access control | A deploy never drops a call (the kill-an-instance test) | Planned |
| 9 | Generated wording (opt-in) | Renderer interface, the LLM adapter, `style.yaml`, checks, fallback, cassette, console display; a prompt is flagged as generated, and the fixed line is its fallback | The model chooses the words, never the content, and the difference is measured | Planned |
| 10 | Open source polish | An adopter's README, adversarial suite inheritance (`llms.txt`, the slot pages and the slot contribution notes came with the slot library) | Someone else can adopt it | Planned |

The foundations (§11) land in the phase that owns their area.

What each phase left for later:

- **Slot library (Phase 3):** `time-slot` (later, with a re-record, since it would re-key every recorded request). The per-slot `listen:` option is built, with today's behaviour as its default (`up-front`); an app that chooses another value for a slot records again. The one-time code never became a slot type: it is a factor of `identity.yaml` (§6).
- **App definition (Phase 2):** `style.yaml` and generated wording (Phase 9); and a locale carried end to end on the channels (Phase 7: the TwiML's `locale` parameter and language attributes, the `set_language` action, a chat request for a locale, and the outbound text frames' language tag).
- **Policy and identity (Phase 4):** the shared adversarial suite, which every app inherits (Phase 10); a link from a form to the action it writes, which would let each `confirmed` rule name its own fields (until then every `confirmed` rule of an app names the same fields in the same order, since a read-back's hash is taken once); the config hashes on each gate decision (§11); and a review item for apps: a tool of an app's own that contacts a subject directly (a text or an email to the contact on file, a link to send a document, say) and that a party acting for subjects may call. The engine keeps its identity tools for the subject alone, but such a tool is the app's, so whether a party acting for subjects may set it going is the app's policy to say (a role rule, or a check that the contact asked for it); the policy card lists it among the actions every role may ask for until the policy says otherwise.
- **Knowledge base (Phase 6):** two-part questions, where one call asks two things and hears two passages (one choice question cannot select two topics, and adding a second re-keys the requests of every turn, so it waits for a deliberate re-record); moving an app that keeps a retriever of its own to the engine's hybrid retrieval (the candidates some turns offer change, so the calls those turns are in are re-recorded); pgvector for production, which Phase 8 implements behind the same `VectorIndex` interface; low-risk answers in generated wording grounded in approved passages, for topics marked `risk: low` (Phase 9, opt-in, under §5's checks); and the review page in the operator console, once Phase 8's access control exists (until then it is a local server behind a one-time token, §9).
- **The utility app (Phase 5):** a slot type for an amount of money (cents, "a hundred and fifty", keypad entry; until then a whole amount is a `digits` slot with a mask); more than one seeded caller in a corpus (every corpus line inside a form runs as the one `testing.seed.caller`, so a delegate's answer inside a form is covered only by scripted calls); a confirmed list for each action (a form's `calls` could carry it, so a write need not confirm another write's fields); a regress mode that adds only new baseline entries (today a new corpus line or scripted call in an app with a baseline means a hand edit, since `--update` is for a first baseline); a value read back in the caller's own words without recording it verbatim (a `text` slot keeps the whole turn); the wording of the menu's re-offer after an informational key, which opens as if the caller had missed again; and the recording of the utility app against a decision model, the maintainer's paid step, after which `--client recorded` has a cassette to replay.

## 13. Open source and licensing

The framework is Apache-2.0. Some enterprise features may be offered separately under a commercial license.

Contributors are asked to sign a contributor license agreement on their first pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](../NOTICE).

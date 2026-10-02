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

**The renderer** turns the core's structured decision into words. Its default is approved templates; a generated-wording option (§5) can phrase some lines, inside checks, but never chooses what is said.

| Role | Default | Model option |
|---|---|---|
| Perceiver | A decision model through an adapter (TypeSafe's Jev first) | An LLM with structured outputs, same typed interface |
| Core | The deterministic fill-and-ask loop | An LLM proposing the next step or tool call, which still only the gate can execute (later, experimental) |
| Renderer | Approved prompt templates | An LLM phrasing a structured speech act within checked facts (§5) |

The gate, typed state, the audit log, replay and recorded-model regression stay the same in every mode.

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
| `kb` | Approved passages, staleness hashing, hybrid retrieval (§9) |
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
  locale/<tag>/     optional: prompts.yaml per extra locale
  app.ts            export const code: AppCode (slots, tools, systems, form hooks, custom rules, ...)
  fixtures/         corpus.jsonl, scenarios, the baseline, recorded cassettes
```

Every YAML file has a JSON Schema (`packages/dialogwright/schemas/`, generated from the zod schemas that validate the files), and each file names its schema on its first line so an editor completes and checks it. The code stays in TypeScript: slot specs (what the perceiver is asked and how the answer becomes a value), tools and the systems behind them, the form hooks, custom policy rules and the test hooks. The folder cannot say any of those without becoming a programming language, and the check keeps the two sides in step: every name the YAML uses must exist in the code, and every hook the code writes must be listed in `forms.yaml`.

Built with the slot library: `slots.yaml`, which names every slot the app has (a library type with its options, or `{ type: code }`) and sets the order they are filled in, and `locale/<tag>/slots.yaml` for how a locale says its slots' values. Not built yet, and planned for the folder: `style.yaml` (persona and word budgets, with generated wording), `kb/` (approved passages), declarative tools (so an app built from the slot library and HTTP tools has no code beyond one `defineApp` line), named policy rules (Phase 4), and `mode: generative` prompts. Apps are registered by id, sessions carry the id, and a boundary test forbids the engine from importing any app.

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

Every type also takes `text.<part>` (a literal in place of any default question text, sent word for word) and `ids.<part>` (an existing question id), so an app keeps its own wording, or the words a recording was made with, while the library's defaults stay neutral.

Not built yet:

| Type | Why it waits |
|---|---|
| `otp` | A one-time code: keypad only, a spoken code masked and reissued, never traced. Identity owns the code path, so it comes with identity and policy (Phase 4). |
| `topic` | A knowledge-base question, selected from retrieval candidates (§9). It needs the knowledge base's retrieval contract (Phase 6). |
| `time-slot` | An appointment time, with windows and disambiguation. Apps that have one ask it from form state today; making it a slot would re-key every recorded request, so it waits for a deliberate re-record. |
| Name spelling | A different set of questions; left until an app needs it. |

Yes or no confirmation is built into the core. A slot a type does not fit is written in code (`{ type: code }`), or becomes a type: contributors add types, and the conformance kit (§7) is how a type proves it keeps the engine's contract.

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

1. **`CLAUDE.md`** at the root: the roles and the gate in a page, the commands, and the rules (never put policy in tool code, never let a model write a regulated line, the engine imports no app, run `pnpm check` and `pnpm verify` before committing an app). Each example app gets a short one of its own (planned).
2. **A create-app skill** (planned, Phase 5) in `.claude/skills/`: from a plain-language description, pick intents, map each piece of information to a built-in slot type, draft prompts, policy, identity and tool stubs, write starter corpus utterances and scenarios, then run the checks until they pass.
3. **`pnpm create-app <name>`** (planned, Phase 5), a deterministic scaffold the skill calls.
4. **`pnpm check`**, with errors written for an agent to act on: each is one line, `file:line:column  path  message  ->  fix`, such as `forms.yaml:8:19  forms.check_hold.slots[1]  slot "branche" is not defined  ->  rename it to "branch", or add it to the app's slots in app.ts (code.slots.branche)`. It validates every schema (unknown keys, wrong types, a misspelt name with the near match offered) and cross-checks the folder against the code: referenced prompts exist, forms' slots are defined, every form's hooks match exactly what the code writes, every tool has a policy row and every policy row a tool, every custom rule the policy names exists and is used, and the identity tools and carried slots exist. It checks that every line the engine itself says is present in every locale (including the ones it builds from a slot's spec, such as `ask_<slot>_dtmf` for a slot with a keypad rung), that a translated line uses only its default line's variables, that what the console and the clips name exists, and that every intent has examples in the app's corpus. Every prompt is `mode: fixed` because the schema allows no other mode today; checking generated wording waits for it (Phase 9). That each custom rule has a test waits for the policy matrix tests (Phase 4). The command is `dialogwright check [--json] [dir...]`, and exits 1 when there is any problem.
5. **It runs with no keys.** The stub perceiver answers from the app's own labelled corpus, templates render, and the text harness and console work end to end.
6. **Docs for agents**: [authoring-an-app.md](authoring-an-app.md) (written for a developer and an assistant alike), [`llms.txt`](../llms.txt) at the repository root (an index for assistants), a [page per slot type](slots/README.md) with its options, default question text and examples (generated from the types, so they cannot drift), and the example apps as reference patterns.

## 5. Generated wording

The core ends each turn with a structured decision; the renderer turns it into words. Generated wording changes how something is said, never what is decided. **The model chooses the words, never the content.**

- **`TemplateRenderer`** is the default. **`LlmRenderer`** wraps it and renders only prompts marked `mode: generative`, using a fast LLM (Claude Haiku in the first adapter). A turn can mix the two: a generated acknowledgement, then a fixed answer passed through verbatim.

```yaml
ask_outageStart:
  mode: generative
  template: "When did the power go out?"     # the fallback, and the meaning
  goal: "Ask when the outage started; briefly acknowledge what they just said."
balance_answer:
  mode: fixed
  template: "Your balance is {amount}, due {dueDate}."
```

- **The model receives a speech act, not the conversation**: the act (ask, read back, acknowledge, re-ask with its reason, offer a person, hand off), the facts it may use (display values only, never identifiers), the caller's last utterance quoted as data, their frustration level, the channel, and `style.yaml` (persona, tone, word budget per channel, one question per turn, phrases to avoid).
- **Every generated line is checked before anyone hears it.** Any failure falls back to the template, and the audit records `render_fallback`. The checks: (1) every required fact is present; (2) no other numbers, dates, amounts or names appear, except from the facts or the caller's own words; (3) the line is within its word budget, and an ask ends in exactly one question; (4) a decision-model yes or no check, "does this text do anything other than the act's goal?", which catches drift. A turn the injection screen flagged is never generated.
- **Latency**: one fast model call per generated line, checked before it is spoken (no streaming into synthesis), capped by a per-turn timeout (about 700 ms on voice) after which the template is used.
- **Determinism**: the trace records the act, the text, the check results and any fallback; cassettes record generations keyed by act and context; regression re-runs the checks on every recorded line and reports the fallback rate; the console shows each line's mode.

## 6. Identity and policy

### Identity

Identity is a ladder of levels. Today an app's optional `identity.yaml` declares the principal kind it serves, the factor slots asked on voice, and the tools that verify factors and send and check a one-time code (an app without the file verifies no one, and every tool must be level 0). The ladder below, with named levels, per-channel step-up and attempts in one file, is planned (Phase 4):

```yaml
# identity.yaml
levels:
  1: { name: account verified, factors: [accountNumber, serviceZip], verify: verifyAccount }
  2: { name: code verified, factors: [otp], send: sendCode, verify: verifyCode }
attempts: 3
channels:
  chat: { signIn: portal, level: 2 }
```

**Step-up**: when the gate answers `STEP_UP`, the request is parked, the channel satisfies it (spoken or keyed factors on voice, sign-in on chat), and the request goes back through the gate. Factors are ordinary slots, never offered on a channel where the user signs in instead.

**Principals**: anonymous, the verified subject (whatever the app calls its customer or patient), and delegates acting for others (a caregiver, a property manager), each with a role and an organization.

### Policy

Policy is a file compliance owns. Today `policy.yaml` holds the gate's tables (`toolLevel`, `rulesFor` with the built-in rule ids R1 to R7 and any custom rule by name, `confirmedFields`, `subjects`, `roles`, `serviceFields`, `maxAttempts`, and the words the rules use in the audit). The planned shape (Phase 4) is named, parameterized rules:

```yaml
# policy.yaml
getBalance:         { level: 1, rules: [identity, scope] }
reportOutage:       { level: 0, rules: [confirmed: [address, outageType]] }
paymentArrangement:
  level: 2
  rules:
    - identity
    - scope
    - role: { delegate: person }
    - confirmed: [amount, firstPaymentDate]
    - limit: { field: amount, max: account.balance }
    - custom: noArrangementInLast12Months
redact:
  delegate: { getBalance: [paymentHistory] }
```

- **Built-in rules**: `identity` (level strong enough), `scope` (the record is the caller's own, or one a relationship table the app supplies allows), `role` (allow, refuse, or a person, per role), `confirmed` (a hash of exactly what the caller confirmed matches what the write sends), `dateInRange`, `limit`, `attempts`, and `fields` (the minimum data sent to downstream services). An action not listed is blocked. Scope never comes from the conversation. Today's gate already enforces identity, scope, exact confirmation, role, attempts and fields, and blocks any tool not on the approved list.
- **Custom rules** are TypeScript referenced by name. They return the same shape as built-ins (a description, what was compared, pass or fail, the verdict) and must ship with a test.
- **Ownership**: compliance edits `policy.yaml` and `identity.yaml` (with required reviewers through `CODEOWNERS`); the framework owns how built-in rules are checked; app engineers own custom rules. `pnpm policy:card` renders the files as a one-page table in plain English, so compliance reviews a card that cannot drift from what is enforced. The YAML stays plain: named rules, comments, simple references only.
- **The audit log** is built in, with one stable schema and minimization declared per field: identifiers masked to the last four characters, secrets never logged, free text recorded by length only.

## 7. Testing

1. **Framework tests.** Each slot type and built-in rule ships its own suite. A slot type's suite starts with the conformance kit (below).
2. **App tests.** A labelled corpus (drafted by the skill, grown with real phrasings); multi-turn scenarios with expected outcomes (delegates, sign-in steps, keypad input); **policy matrix tests generated from `policy.yaml`** (every action against every principal, the gate checked against the file); the required tests for custom rules.
3. **The model loop.** Stub runs need no keys: the stub perceiver answers from the corpus labels. Record against a decision model once (per provider, for benchmarking), replay offline from the recorded cassette, regress with allowed cosmetic drift, sweep thresholds to the center of their plateaus, and trim the cassette.

Around those:

- **Regression** compares every run's outputs with a baseline. A changed output is a finding to explain, never noise to overwrite. Two allowances exist, both only for runs that reach a model's answers (recorded, live): a scenario marked `cosmeticDrift` may differ in which gate decided and its verdict, and a corpus entry carrying `knownGap` (a one-line reason and the outcome fields the model is known to produce) may show exactly that known outcome, printed as allowed with its reason and counted in the summary; any other difference on the entry still fails. A documented model gap is tolerated there and nowhere else: stub runs (fixture and heuristic) stay exact, so `knownGap` never hides a change in the stub baseline.
- **The slot conformance kit** (`dialogwright/testing`) runs over every example configuration of a slot type, with no model and no keys, and proves the type keeps the contract the engine relies on: it builds and declares its question ids and prompts; it refuses unknown options; its question ids are its own and never the engine's; it gives no value for no answers, for answers that hear nothing, or for malformed answers; it reads thresholds by name (scaling every probability and threshold by one factor changes nothing, so no number is written into the type); its display is the same in the fill, the keypad and every locale; every line it can lead to is declared; and each example utterance gives the outcome it expects. A contributed type must pass it. The kit's own tests break a small correct type one way at a time and show the check meant for that fault catches it.
- **Oracles and grids** are the pattern for moving a slot onto a library type without changing what a caller hears. The hand-written slot is frozen as a test-only oracle, and a shadow harness runs the library slot beside it over a large grid of answers around every threshold, comparing the questions as the model's request keys them, the fill outcomes, the keypad results and the displays. The same harness runs inside the regression and the recorded replay, so branches no recorded call reaches are compared too. When the grids and every recorded call agree, the oracle stays as a test and the app runs the library slot; the recorded cassette replays with zero misses because the model's requests are byte-identical. The clinic's slots moved this way.
- **The threshold sweep** varies each decision threshold across the recorded calls and picks values from the middle of the range where outcomes are stable.
- **Generated wording** joins the cassette; regression re-checks every line and reports the fallback rate.
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

Answers to general questions come from approved passages, never from generation. **A passage is the unit of approved knowledge:**

```yaml
id: outage-credit-2026
topic: outage_credit
applies: { state: CA, customer: residential }
effective: { from: 2026-01-01 }
source: { document: Tariff Rule 14, section: "3.2", text: "..." }
answer: "If your power is out for more than 24 hours, you can get a credit of 25 dollars."
accountLine: { text: "Your last outage on record was {lastOutage}.", from: getOutageHistory }
approval: { owner: Customer Content, approvedBy: Compliance, on: 2025-12-10, sourceHash: ... }
```

- **Staleness**: the source text is hashed at approval; a changed source withholds the answer (fail closed) until it is re-approved. Answers are always `mode: fixed`. The caller's own data is a separate, gated read.
- **Select, don't generate: nominate, select, resolve, speak.** Retrieval nominates candidates; the decision model selects one, or "none", by meaning above a threshold (below it, the agent asks which topic); code resolves the passage in force for the caller's metadata and date, through the gate, and checks the hash; the approved answer is spoken verbatim. A two-part question can select two passages.
- **Hybrid retrieval from the start.** The decision model guards precision, so retrieval only needs recall: keywords catch exact terms (plan names, codes), embeddings catch meaning and misrecognized speech; the lists are merged, de-duplicated and capped (about eight). The default embedding model runs locally in-process (no key); an API model is configuration. The index is in memory on a laptop (brute force is fine at thousands of passages) and pgvector in production. `pnpm kb:index` embeds ahead of time, keyed by content hash. Two controls keep cost down: a similarity floor (tuned by the sweep), and asking about topics only when a knowledge question is plausible.
- **Authoring that scales**: `pnpm kb:draft <document>` has an LLM propose passages and answer lines offline, marked pending until `pnpm kb:approve` records the approver and source hash (generation where a human reviews before anyone hears it). Every "none" in production feeds `pnpm kb:gaps`, a ranked backlog. For the long tail, each app chooses: a handoff, or, for content marked low-risk, generated wording grounded in the nearest approved passages under §5's checks.
- **Testing**: paraphrase-consistency sets per topic; regression counts "none" selections and wrong-topic picks.

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
| Contact-center connectors | Varies | Genesys Audio Connector and Digital Connector, Amazon Connect, NICE CXone, Five9 | Later; audio connectors need the audio pipeline |

The web chat widget is a small bundle on a CDN that a site embeds. It opens a WebSocket to the chat endpoint (allowed origins checked) and signs in by passing the site's identity token, verified against the identity provider's published keys. The server does not host the site's pages.

## 11. Foundations designed in from the start

Each of these is a field, an interface or a few lines of configuration, so later features never need a redesign.

1. **Languages**: a locale on the session and on every prompt, slot parser and passage. Built today: `locale:` in app.yaml, a `locale/<tag>/prompts.yaml` per extra language, the session's locale from the channel's start (a `locale` custom parameter on ConversationRelay), and per-line fallback to the default language; translated lines are spoken by text-to-speech, since recorded clips are in the default language. Not yet carried by any channel: the server's TwiML sends no `locale` parameter and sets no `language`, `ttsLanguage` or `transcriptionLanguage`, and the engine never emits `set_language`, so a voice session in another locale is still transcribed and voiced with the relay's defaults; chat has no way to ask for a locale; and the outbound text frames say `lang: en-US`. That channel work is Phase 7 (Channels). Built with the slot library: the session's locale on every slot's context, a word table per language (English, Spanish) for number words, name spans and fillers, Spanish formats for days, birth dates and spans of days, a day-first keypad, and `locale/<tag>/slots.yaml` for the words an app chooses for a value (a choice option's `say`, a text slot's stand-in); the questions stay in the default language by design, since the model reads them and their labels are keys. Spanish is proven on the library fixture, where a call fills a card number and a branch by Spanish voice; another language needs a lexicon and formats added behind the same locale gate. Intent labels and passages by locale come later (the knowledge base).
2. **Versioned configuration per decision**: every configuration file carries a content hash (SHA-256 of its parsed content, so comments and quoting do not change it, and key order does, since it is meaning) and the app a combined one. Built today: the `call_started` audit row records the combined hash and each file's, every trace record carries the combined hash, and the console shows its first eight characters. The hashes are never sent to the model. Still to come: the knowledge base's hashes, and the hashes on each gate decision.
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

| Phase | Delivers | Proves | Status |
|---|---|---|---|
| Engine/app seam | The `App` contract and registry; sessions carry an app id; the engine reads intents, forms, slots, identity, tools, policy and prompts from the app; a boundary test forbids engine-to-app imports | Behavior identical: every recorded regression output unchanged | Done |
| Channel event model | Our own events, actions and capabilities; the Twilio format moved into an adapter | Behavior identical | Done |
| App-agnostic engine | No app names, data or assumptions left in the engine; a test fixture app (`testkit`) proves it builds and passes alone | The engine stands on its own | Done |
| The repository | This workspace, the `dialogwright` package, community files, this document, CI | The engine is public-ready | Done |
| Example apps | The clinic on the `App` contract (`apps/clinic`): its own corpus, scripted calls and stub baseline, built on the engine's generic hooks; recorded against a decision model through the adapter | A real app on the public engine | Clinic done (recording to come) |
| App definition | `defineApp`, JSON Schemas, the loader, `pnpm check`; the clinic as a folder; locales; configuration hashes; [authoring-an-app.md](authoring-an-app.md) | An app is a folder | Done |
| Slot library | `slots.yaml` and seven built-in types (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`), each with an options schema, a generated docs page and starter examples; the conformance kit and the shadow harness; Spanish number words, names and dates; the clinic's slots all on the library with its cassette replaying with zero misses | Most slots are configuration, and slot types are something people can contribute | Done |
| Policy and identity | Named rules, `identity.yaml`, delegates, redaction, matrix tests, `policy:card`, `CODEOWNERS` | Compliance-owned policy, tested against the file | Planned |
| The utility app, built by an AI coding assistant | The create-app skill, `create-app`, `CLAUDE.md` files; the utility app built through that path from a paragraph, then recorded | The assistant goal, by doing it | Planned |
| Knowledge base | Passages, staleness, hybrid retrieval with a local embedding model, `kb:index`, `kb:draft`, `kb:approve`, `kb:gaps` | Knowledge that scales without generated answers | Planned |
| Channels | The relay with Twilio and Telnyx adapters and conformance tests; the CDN widget with token sign-in; a session's locale carried to the carrier (its language attributes, `set_language`) and requested from chat | Same app, two carriers, plus web | Planned |
| Production | Store interfaces with production implementations; resume across instances; idempotent writes; readiness and drain; a `docker compose` stack; a reference deployment; console access control | A deploy never drops a call (the kill-an-instance test) | Planned |
| Generated wording | Renderer interface, the LLM adapter, `style.yaml`, checks, fallback, cassette, console display | The model chooses the words, never the content | Planned |
| Open source polish | An adopter's README, adversarial suite inheritance (`llms.txt`, the slot pages and the slot contribution notes came with the slot library) | Someone else can adopt it | Planned |

The foundations (§11) land in the phase that owns their area.

Phases are counted from App definition as Phase 2, and the slot library is Phase 3. What the slot library left for later: `otp` (Phase 4, with identity), `topic` (Phase 6, with the knowledge base), `time-slot` (later, with a re-record, since it would re-key every recorded request), and a per-slot `listen:` option that narrows which turns a slot's questions are asked on (later, with a re-record, for the same reason; every slot listens on every turn today). What the App definition phase left for later phases: named policy rules and the policy matrix tests (Phase 4), the knowledge base folder `kb/` (Phase 6), `style.yaml` and generated wording (Phase 9), and a locale carried end to end on the channels (Phase 7: the TwiML's `locale` parameter and language attributes, the `set_language` action, a chat request for a locale, and the outbound text frames' language tag).

## 13. Open source and licensing

The framework is Apache-2.0. Some enterprise features may be offered separately under a commercial license.

Contributors are asked to sign a contributor license agreement on their first pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](../NOTICE).

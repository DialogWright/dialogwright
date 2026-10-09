# Contributing to DialogWright

Pull requests are welcome. Thank you for helping.

## Build and test

Node 22.19 or later and pnpm are required. Record cassettes under the major in `.nvmrc` (22): the Unicode tables behind the engine's text handling come with Node and can change between majors, which changes a recorded request's text (see the authoring guide's fixtures).

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm --filter dialogwright regress:testkit
```

`pnpm verify` runs the type check and the tests together, and `pnpm check` checks every app folder (its YAML against the schemas and the cross-references, and against the app's code). Run all of the above before you open a pull request.

## Rules

- The engine imports no app. Apps depend on the engine, never the other way around.
- No private data or real personal information in code, tests or fixtures. Use the 555 phone range and invented names.
- Policy belongs in the gate, never in tool code. A tool does its job; the gate decides whether it may run.
- A model never writes a regulated line. It only chooses among approved ones.
- A knowledge base's answers are approved text, said word for word. Only a person approves a passage, a drafting tool only proposes one, and no key for a model is ever committed or used in CI or a test.
- Do not regenerate a regression baseline or snapshot to make a test pass. If output changed, understand why first.

## Adding a slot type

Slot types are where most contributions will arrive. A slot type turns validated options into a `SlotSpec`, so an app names it in `slots.yaml` instead of writing code (see the [slot types](docs/slots/README.md)). Read `packages/dialogwright/src/slots/README.md` first: it says what a type is and what the shared parts give you. The simplest type to copy is `text`.

**Layout.** One folder per type under `packages/dialogwright/src/slots/<type>/`:

| File | What it holds |
|---|---|
| `index.ts` | `defineSlotType({ type, options, build, examples, describe })` |
| `options.ts` | The options schema, the type's text parts and question parts, the defaults |
| `questions.ts`, `fill.ts`, `display.ts` | The questions asked, how answers become an outcome, how a value is said |
| `examples.yaml` | Example configurations with starter utterances (and keypad keys) |
| `<type>.test.ts` | `runSlotConformance` over the examples, then tests of what the kit cannot know |
| `README.md` | The hand-written part of the docs page: what it is for, outcomes, question wording, notes |

Add the type to `BUILT_IN_SLOT_TYPES` in `slots/registry.ts`, and export its options type from `slots/index.ts` and the root `src/index.ts` (the type itself is reached through `BUILT_IN_SLOT_TYPES`). A type is a pure function of its options: no global state, and no import from an app. A type written outside the package imports its helpers from `dialogwright/slot-kit` (`defineSlotType`, `textParts`, `questionParts`, `meetsThreshold`, `examplesFrom`, ...), the readers from `dialogwright`, and the conformance kit from `dialogwright/testing`.

**Options.** Write them as a `z.strictObject`, so a misspelt option is an error, and give every option a `.describe(...)`. That text is the option's documentation: the generated docs page and the problems an author sees are made of it. Say what the option does, its default, and when it is needed. Put cross-option rules in a `superRefine` with a `fix` that tells the author what to write.

**Wording.** Declare each piece of question text as a part with `textParts` (a default template over the options), so an app can replace any part word for word with `text.<part>`. Declare question ids with `questionParts` (the slot's id followed by the part's name, so two slots of one type never share an id); `ids.<part>` lets an app keep an id it was recorded with. A type declares `questionIds` and every prompt it may lead to in `prompts` (with the variables each is given), and the thresholds its options name in `thresholds`. Compare the model's numbers only through `meetsThreshold`, never to a number written in the type.

**Neutral words and invented data.** Defaults, examples, tests and docs in the engine package use neutral vocabulary (account, card, parcel, book, appointment, caller, record). Names, numbers and dates are invented: the 555 phone range, fictional people. No real data, and no one industry's words; they belong in the app that needs them, as `text.<part>` literals.

**Locale.** A type must read and say en-US. Spanish is encouraged: read `ctx.locale`, format with the one `display(value, locale)`, and use the lexicon in `core/extract/lexicon.ts` for number words, fillers and names. en-US output must stay exactly the same whether a locale is given or not, and anything another locale changes must be gated on it. Put Spanish examples in `examples.yaml` (`context: { locale: es }`), and pin what each example says in every locale the kit checks (`expect.display` on an utterance said there, or `expect.displays: { es: ... }`). Words an app chooses for a value, such as a choice option's `say`, can be given per locale through the type's `wording`; the questions stay in the default language.

**Privacy.** A type that holds an identifier defaults to masking it: `redact` (`last4`, `mask` or `length`) for what leaves the turn, `handoff` (`last4` or `verified`) for what a transfer carries. Free text defaults to `redact: length`. An app can turn masking off for a value that is no one's secret; the type must not do it for them.

**The conformance kit.** Run the checks with `pnpm --filter dialogwright test slots/<type>` (then the whole suite). Each runs over every example of the type, with no model and no keys:

| Check | What it proves |
|---|---|
| `builds` | The configuration builds a slot that declares its question ids and its lines |
| `unknown-keys` | An option the type does not have is refused, with a problem that names it |
| `question-ids` | `questions()` asks only declared ids (with and without a value on file and a pending partial, in each locale, and on a Sunday, February 28th and 29th of a leap year and December 31st), none the engine's, the same ones each time, other ids for a second slot, and the same questions whatever the wording by locale |
| `empty` | No answers at all never give a value |
| `quiet` | Answers that hear nothing never give a value |
| `malformed` | Answers of the wrong type, missing or out of range never make it throw |
| `thresholds` | Thresholds are read by name: with every probability and threshold scaled by one factor, nothing changes |
| `threshold-names` | Every threshold a fill reads is the engine's or declared in `thresholds`, and every declared one is read |
| `boundary` | A number exactly at a threshold meets it, as `atLeast` has it: a `>` is caught |
| `display` | `display(value, locale)` is what every fill, keypad value and candidate carries, and en-US formats as no locale does; the example pins a display in each locale checked, and the slot gives it |
| `keypad` | The example's keys give its value, and keys of a wrong length give none |
| `prompts` | Every line an outcome can lead to is declared with the variables it is given |
| `prompt-vars` | Every declared line uses only variables the engine gives it (`ack_<slot>` gets `{<slot>}`; the keypad ask, a retry and a help line get none), and a `by-confidence` slot that acknowledges a value declares `ack_<slot>` |
| `values` | A `date`-valued slot gives ISO dates; every confidence is from 0 to 1 |
| `utterances` | Each example utterance gives the outcome it expects, and at least one fills the slot |

The kit checks en-US and es unless it is given `locales`. The kit proves the contract, not that the parsing is right. Write tests for each outcome and each `invalid` reason, and for the edges of the type.

**Evidence for borderline wording.** The questions are requests to a model, and one word can change its answers. When a question's wording is a judgment call (what counts as a hedge, where a name ends), show why it is right: the utterances you tried and what a model answered, and a recorded run if you have a key (the clinic's README, "Recording the cassette", says how; never commit one that holds real calls). If you cannot record, say so in the pull request and a maintainer will.

**Regenerate and commit.** After a change to a type's options, run `pnpm --filter dialogwright schemas` (the JSON Schemas) and `pnpm --filter dialogwright slot-docs` (the page `docs/slots/<type>.md`, built from the type's README, options schema and examples). Do not write an options table by hand: put the markers `<!-- slot-docs:options -->` and `<!-- slot-docs:examples -->` in the README where the generated parts go, and add the type to the index in `docs/slots/README.md`. Tests fail when a schema or a page is stale, or when a type has no page.

Before you open the pull request: `pnpm verify`, `pnpm check`, and both regressions, as above. The CLA (below) covers a new type like any other contribution.

## Adding a built-in policy rule

The built-in rules (`identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf`, `noneOf`, `callerNumber`) are what an app's `policy.yaml` names, and the gate runs them. A new one is a change to what compliance reads and what an auditor sees, so it is held to more than a function: it needs a shape in the file, a place in the gate, tests, an invariant if it refuses something it exists to refuse, wording on the policy card, and a page in the docs. Read [authoring-an-app.md](docs/authoring-an-app.md#3-policy-and-identity) first: it says what each existing rule does, and `packages/dialogwright/src/gate/bounded.ts` (the range rules) and `gate/listed.ts` (the list rules) are the models to copy.

**Where it goes.**

| Part | Where |
|---|---|
| The rule: a pure function of its parameters that returns `(c: RuleContext) => RuleOutcome` | `packages/dialogwright/src/gate/`, in a file of its own (as `bounded.ts` is) |
| Its place in the gate: the `Rule` union, `BUILT_IN_RULES` (so no app's own rule can take its name), `RULE_ID` and the `case` that compiles it | `gate/compiled.ts` |
| Its shape in the file: the name in `PARAM_RULES` and `RULE_NAMES`, a strict object with a `.describe(...)` on every option, `RULE_EXAMPLES`, the `RuleEntryYaml` type | `define/schema/policy.ts` |
| Reading the file: turning the entry into the `Rule`, and the cross-checks that name what exists (params a tool carries, lookups the code declares, roles identity.yaml has) | `define/policyFile.ts` |
| Its words: the policy card's sentence, the matrix's and the app map's label | `testing/policyCard.ts` (`ruleText`, `ruleName`), `testing/policyMatrix.ts` |

**The rule itself.**

- It fails closed. A param that is missing, a record that does not exist, a value of the wrong shape or a lookup that throws is a refusal, never a pass. The gate turns a throw into a `BLOCK` (`rule-error`), but write the rule so it does not throw.
- It is a function of the call, the caller, the gate's facts and the app's lookups. It reads nothing from the conversation, and it never runs anything the file says: a parameter written in the file is data, read when the app is built.
- It records a line under its name, with what it compared, and that line reaches the console and the audit as it is. Write the param's name and the bounds, masked where they are identifiers, and never the call's own value, which may be a value the app redacts.
- Give each way it can fail a reason and a verdict, and let the file change them only where that is safe (a limit may go to a person; a value that is not a number never does). Reasons are short machine words (`not-a-number`, `date-range`).
- Neutral words in the engine package, as everywhere in it.

**Tests.** Beside the rule, a test of every outcome: each way it fails, the boundaries (are they inclusive?), every malformed input, a lookup that throws. Beside the schema, tests of each problem `check` reports, with its fix. A compile test shows the entry becomes the rule. Then the policy tests: the gate grid (`testing/gateGrid.ts`) runs every rule an action lists; the legacy evaluator the shadow gate compares with does not know a rule that only the file has, so `define/rangeRules.test.ts` shows how a stable, fail-closed run of the grid stands in. If the rule refuses something it exists to refuse, add an invariant (`INVARIANTS`, `INVARIANT_ABOUT` and its check in `testing/policyInvariants.ts`) and a test that a gate with that one bug trips it: an invariant is derived from the file, never from the gate's own lines, so a gate that is wrong in a way its lines agree with is still caught.

**The card.** Write the rule's sentence on the policy card in the words a reviewer who does not read YAML would use, with its parameters: "no later than 30 days from today", not `notAfter: today+30`. A reviewer reads this and nothing else. Add the rule to an app's test policy where it can be seen, and look at the diff of its `POLICY.md`, `policy.matrix` and `APP-MAP.md` (`pnpm policy:card`, `pnpm policy:matrix`, `pnpm app:diagram`): the diff is part of the review.

**Docs and the rest.** Regenerate the schemas (`pnpm --filter dialogwright schemas`); add the rule to the table in section 3.3 of the authoring guide with an example (a YAML block there is built by `define/docPolicyBlocks.test.ts`, so it cannot drift), to design.md §6, to the rule lists in CLAUDE.md, llms.txt and the README, and to `BUILT_IN_RULES`. The rule's name is recorded in the audit: never reuse one of the old ids `R0` to `R7`. Before you open the pull request: `pnpm verify`, `pnpm check` and both regressions, as above, with no decision of an existing app changed.

## Adding a retriever or an embedder

Retrieval decides which few topics the decision model is asked about, so it is held to more than finding the right one: it must give the same answer every time, quickly, on any machine, because its nominations shape the model's request and a recorded call replays only if they do not move. Read [the knowledge base section of the guide](docs/authoring-an-app.md#12-the-knowledge-base) first, and `packages/dialogwright/src/kb/hybrid.ts` (the default retriever, and the model to copy) and `kb/embed/types.ts`.

**A retriever** is an object with an `id` (its name in the trace), an optional `indexHash` and `nominate({ text, locale, todayIso })`, which returns `{ topic, title, score, via }` entries, best first, in the order that ties are broken by (topic id), at most the knowledge base's cap, sync or async (`Retriever` in `kb/types.ts`). An app gives its own as `code.knowledge.retriever`; one that belongs in the engine goes beside `keyword.ts` and `hybrid.ts` and is chosen in `defaultRetriever`.

- **Deterministic.** The same words, locale, day and knowledge base give the same nominations in the same order with the same scores. Round scores (`kb/score.ts`), break ties by topic id, and read no clock or randomness. The engine runs it once per turn before the model is asked, within a fixed 150 ms budget (`RETRIEVE_BUDGET_MS`); a retriever that throws, answers with something that is not a list, or is late nominates nothing, which the trace records. It must not rely on that: it should be quick and should not call out by default.
- **Neutral and read-only.** It reads the knowledge base it was given (`RetrievalKb`: topics with their wording by locale) and nothing else, and it never writes. It reads a topic in the caller's locale, falling back to the default's wording, as `kb/words.ts` does.
- **Tests.** Beside it, a test of what it nominates and what it does not (words that name no topic, greetings, the cap, a locale), and a golden of its nominations for every line of the fixture paraphrase set (`kb/__fixtures__/paraphrases.yaml`, `nominations.golden.json`), as `keyword.test.ts` and `hybrid.test.ts` do. Add it to the bake-off (`kb/commands.ts`) and say in the pull request what `pnpm kb:bakeoff <fixture kb> --paraphrases <file> --sweep` reports: recall at the cap, candidates per question and per question about nothing, and speed. A retriever that does not beat the keyword one on recall at the same candidates has no reason to be the default.
- **A database's vector search** is not a retriever but a `VectorIndex` (`search({ vector, limit, floor })`): pass it to `DenseRetriever` and `HybridRetriever` as `makeIndex`, and the retriever above it does not change. A pgvector index for production (not built yet; a candidate for Phase 8b) would be this.

**An embedder** turns texts into vectors (`Embedder` in `kb/embed/types.ts`: `id`, `revision`, `sha256`, `dim` and `embed(texts)`). Its vectors are written to a committed index (`kb/.index/<id>.json`, by `pnpm kb:index`), so it must be deterministic: the same text, the same bits, on every machine.

- **A static model** (a Model2Vec model of the same file layout as `potion-base-8M`) is added to `STATIC_MODELS` in `kb/embed/model.ts`, pinned: its repository, the exact revision, the SHA-256 of every file it reads, its dimension, its licence (it must allow redistribution of a download, and be compatible with Apache-2.0) and the floor the bake-off recommends. Weights are never vendored: `pnpm kb:model` downloads them once, checks each hash, and keeps them in the cache, and a call never downloads anything. Pin a golden checksum of a sentence's vector, so a change in any bit shows (`kb/embed/embed.test.ts` does this for `potion-base-8M`).
- **Any other embedder** goes behind a subpath and, when it needs a package of its own, an optional peer dependency, imported only when it is asked for, as `dialogwright/kb/onnx` is: the engine must install and run without it. Say what it costs (install size, speed, whether its last bits vary between CPUs, which would move a topic near the floor in or out of the nominations between machines) and what the bake-off reports against the static model.
- **Neutral words and invented data** in everything you add: fixtures, paraphrases and tests use the library's topics or topics of your own, in neutral vocabulary, with invented names.

Before you open the pull request: `pnpm verify`, `pnpm check` and both regressions, and the clinic's recorded run (`pnpm --filter @dialogwright/example-clinic regress --client recorded`) with no new miss: an app without a `kb/` must be unchanged.

## Adding an extraction format

The authoring tool, `packages/kb-author`, reads documents into sources (`pnpm kb:ingest`); a format is one file under `src/extract/` that turns a document's bytes into sections. Read the package's README (the formats table and "What a source file holds") and `src/sections.ts` first. `markdown.ts` is the simplest to copy.

- **The shape.** The extractor returns an `ExtractedDocument`: an optional `title` and `sections`, each with an `id` (the slug of its heading path, `late-fees` or `shifts/training`, so it stays put when a section is added elsewhere), an optional `heading`, its `text`, and for a format with pages its `page` and `lastPage`. Use `cleanText` and the helpers in `sections.ts`: paragraphs are kept (a blank line between them), whitespace is collapsed inside each one, and invisible characters are dropped. Approvals hash the text with whitespace collapsed, so a re-wrapped paragraph is not a change and a changed word is.
- **Deterministic.** The same bytes give the same sections, in document order, with the same ids. Re-ingesting an unchanged document must not rewrite its file.
- **Safe.** Never run anything the document holds (no scripts, macros or embedded code, no network, no external entities), never read a path the document names, and bound what you read (the size, the number of pages and of sections). A document that cannot be read is reported and skipped, never a crash; one that has no text (a scanned page) says that it needs OCR.
- **Registered.** Add the format to `Format`, its extensions to `EXTENSIONS` and its case to `extract()` in `src/extract/index.ts`, and the formats table in the package's README. A website's pages and linked documents reach it through the same table.
- **Dependencies** stay out of the engine and are few: prefer pure JavaScript, check the licence is compatible with Apache-2.0, and list the package, its licence and its size in the README's dependency table. A native or very large dependency needs a reason in the pull request.
- **Tests.** A small fictional document of the format in `src/__fixtures__/folder/` (invented names, nothing real) and a test in `extract.test.ts` of what it reads: headings, nested headings, lists, tables, what it drops, and a malformed file. The extractor never makes a network call, and no test of any kind makes a drafting call: drafting uses a fake in tests.

Run `pnpm --filter @dialogwright/kb-author typecheck` and `pnpm --filter @dialogwright/kb-author test`, then `pnpm verify` and `pnpm check`.

## Adding a voice provider

A phone carrier that runs a text relay in front of the engine (the relay messages Twilio's ConversationRelay and Telnyx's Conversation Relay both speak) is a voice provider: one file under `packages/dialogwright/src/server/voice/`, its fixtures, and a line in the registry. Nothing in the core, the run loop or the prompts changes, and no app does. Read the [design's §10](docs/design.md#10-channels-our-own-event-model-providers-as-adapters) and `server/voice/provider.ts` first; `telnyx.ts` is the provider to copy, and its notes show how to write down what the carrier does not document. (A carrier that streams audio instead, so that the framework would do recognition and synthesis, is not this; it waits for the audio pipeline, §10.)

1. **Implement `VoiceProvider`** (`server/voice/<id>.ts`): an `id` (lower case, the name in `VOICE_PROVIDERS` and in the paths `/voice/<id>`, `/cr-action/<id>`, `/conversation/<id>`), the documents' `contentType`, and
   - `verify(req, secret, publicHost)`: whether a webhook came from the carrier, by its signature, in constant time, refusing a missing or stale one;
   - `parse(req)`: the webhook read into `CallbackParams` (the call id, numbers, call and session statuses, `live`, whether the call is still live read from the carrier's own status words and absent when the callback carries no status, the end frame's handoff data, and every field raw for the frame log), or null when it names no call;
   - `startDocument(options)`: the document that connects the call to `wss://<publicHost>/conversation/<id>?token=...` with keypad detection on and its action at `/cr-action/<id>`, with the carrier's own voice and recognizer, and for an app that names its languages the call's language, one child per language it may switch to and the `locale` parameter (`xml.ts placeLanguages` does the placing for a carrier shaped like TwiML);
   - `hangupDocument()`, `dialDocument(number)` and `apologizeAndDialDocument(number)`.
   - optionally, `readEvent(message)`: the carrier's own socket events (a message the relay wire does not know) read into a `PlaybackEvent` (the playback started or finished, with the line it played; the caller speaking or not), or null. A carrier that reports its playback this way has a line it cuts short said again (the guide's [13.9](docs/authoring-an-app.md#139-a-line-the-carrier-cut-short)); one without it never does. One that reports the caller speaking has the no-input wait held while the caller talks ([13.11](docs/authoring-an-app.md#1311-the-no-input-wait-and-a-caller-heard-speaking)): a carrier that sends no partial transcripts should, or a caller finishing a long sentence can hear "I didn't hear anything." A caller it reports speaking again soon after their own pause and the reply continues their last prompt (the guide's [13.8](docs/authoring-an-app.md#138-a-caller-who-had-not-finished-and-how-a-word-is-said)).
   - optionally, `setupCallerOf(setup)`: the number the caller is calling from, as the carrier's setup frame carries it, or null when it carries none. Without it, the setup's `from`. And `setupCalledOf(setup)`, the number called, likewise (without it, the setup's `to`), for an app that keeps it (app.yaml's `callerNumber: { called: true }`). The console's `call_started` shows it masked, and a slot that offers the caller's number reads it (the guide's [13.13](docs/authoring-an-app.md#1313-the-number-the-caller-is-calling-from)); pass on what the carrier sends, a withheld one included, since the engine refuses the placeholders it knows.
   The socket frames are the shared relay wire (`channel/relay`); if the carrier sends a field on a frame that the wire drops, keep it there (as Telnyx's call ids on `setup` were), and show the wire goldens unchanged.
2. **Fixtures from the carrier's docs** (`server/voice/__fixtures__/<id>/`): `frames.jsonl`, one documented frame per line, inbound and outbound, and `webhooks.json`, the voice webhook, the action callback and any other form the carrier may send them in, each with the fields the parser must read. Copy them from the carrier's documentation verbatim, with phone numbers made fictional (+1555), and give each a `source`: the page it came from and what was changed. What the carrier does not document is written as you expect it, with `source` starting `ASSUMED:`, and listed in the provider's notes and in [docs/live-checks.md](docs/live-checks.md), where the maintainer settles it on a live call and replaces it with a `captured <date>` entry.
3. **Run the conformance kit.** In `server/voice/conformance.test.ts`, call `runVoiceProviderConformance(provider, { describe, it, frames, voice, action, alternatives, sign })` (from `dialogwright/testing`; `describe` and `it` are passed in, so the kit runs under any test runner). `sign` signs a webhook as the carrier does, with a key or token made in the test, never a stored secret. The kit checks that every documented frame parses or serializes as documented, that the setup frame's ids are kept, that the provider verifies its own signature and refuses a tampered, unsigned or other-body webhook, that each webhook reads as its fixture says, and that the documents point at the provider's own paths. Then a test of the provider's own (`<id>.test.ts`): its documents byte for byte, its signature's edge cases (the clock, a malformed header), every `parse` path.
4. **An end-to-end test** like `server/voice/telnyx.e2e.test.ts`: the engine's server answering only the new carrier, a signed `POST /voice/<id>`, the worked example run over `/conversation/<id>` with the carrier's own setup frame, the trace written, and a signed `/cr-action/<id>` answered with a hangup. Listen on 127.0.0.1, the address the test dials (`host: '127.0.0.1'`).
5. **Register it and its secret.** Add the id to `VOICE_PROVIDER_IDS` (`channel/voiceProviders.ts`, which an app's YAML is checked against) and the provider to `ALL` in `server/voice/registry.ts`, with the environment variable that holds its secret (required only when `VOICE_PROVIDERS` lists it), how the startup line names it, and a `checkSecret` that refuses at startup a value that cannot be one. If the carrier names its voices or recognizers its own way, give it variables of its own in `server/config.ts` (`voiceFor`, `recognitionFor`, and the startup line), never another carrier's: one carrier's settings never reach another.
6. **Document it.** The guide's [section 13](docs/authoring-an-app.md#13-channels) (the options table and "Serving voice"), §10 of the design, the `.env.example` of each app and of the template (`packages/dialogwright/templates/app/.env.example`), commented with its defaults, and the checks only a live call can make in [docs/live-checks.md](docs/live-checks.md).

Before you open the pull request: `pnpm verify`, `pnpm check`, the three stub regressions (`no changes`), and the wire goldens (`packages/dialogwright/src/channel/__snapshots__/wire-testkit*.txt`) unchanged: a new carrier changes no call on the ones before it.

## Adding a session store

Where the server keeps calls, chats and relay tokens between turns is behind three interfaces in `packages/dialogwright/src/server/stores/types.ts`: `CallStateStore` (`load`, `save`, `remove`, `list`), `ChatStateStore` (the same, and `findByResume`) and `TokenStore` (`mint`, `verify`, `has`, `revoke`, `evictExpired`). The memory stores (`stores/memory.ts`, the default) and the file stores (`stores/file.ts`, `SESSION_STORE=file:<dir>`) implement them; the file stores are the ones to copy. Read [section 14.7 of the guide](docs/authoring-an-app.md#147-surviving-a-restart) and design §8 first.

1. **Implement the three.** A method may answer at once or with a promise (`Awaitable`). What is stored is plain data (`StoredCall`, `StoredChat`): hand back a copy equal to what was saved after a JSON round trip, the last save winning. Keep a relay token and a chat's resume token only as their SHA-256 (`tokenHash`), never the token. Treat an id as an opaque string (any characters, long ones included). A record that cannot be read is logged once and loads as absent, never a crash.
2. **Run the contract.** In a test beside the store, call `runStoreContract('<name>', (ctx) => yourStores(ctx), { describe, it, reopen })` from `dialogwright/testing` (`describe` and `it` are passed in, so the kit runs under any test runner). `ctx` gives the clock the stores must read (`now`) and the token lifetime to make them with (`tokenTtlMs`). `reopen` makes new stores over the same storage as the last `make`; a store that outlives its process must pass it. The kit checks saving and loading, removal, the last write winning, copies handed out, concurrent saves, ids a file name cannot hold, chats found by their resume token and that token's rotation, tokens bound to their call and carrier, expiry and the sweep's count, revocation, and everything still there after a reopen. Each check fails by name, so a broken store says what it broke.
3. **Register it.** Give `SESSION_STORE` its value (`sessionStoreOf` and `SessionStoreSetting` in `server/config.ts`, refusing a malformed one at startup), open the stores where the server does (`startServer` in `server/index.ts`), and name the store on the startup line without any secret. Add what can be misconfigured to `pnpm diagnose` (`server/doctor.ts`; check 10 is the file store's).
4. **Document it**: the options table in [section 14.12 of the guide](docs/authoring-an-app.md#1412-the-options), each `.env.example` (the apps' and the template's), and design §8.

Phase 8b's shared store for many servers (Redis, say) goes through the same steps and must pass the same suite unchanged. It also needs what one machine never did: one instance owning a call's turns at a time (a lease per call id), the reconnect counter incremented atomically, and the token calls the server makes synchronously today (`decideAction`'s mint and revoke in `server/http.ts`, the socket's `verify` in `server/adapter.ts`) awaited. Run the kill-the-server test (`server/restart.e2e.test.ts`) against it as well as the contract.

Before you open the pull request: `pnpm verify`, `pnpm check`, the three stub regressions (`no changes`) and the wire goldens unchanged: with `SESSION_STORE` unset nothing may change.

## Pull requests

On your first pull request, CLA Assistant will ask you to sign the [Individual Contributor License Agreement](docs/CLA.md) with your GitHub account; it takes a minute and covers all your future contributions. The agreement lets the project keep offering your work under Apache-2.0 and under other terms in the future, while you keep your copyright. If you contribute for a company, open an issue about a corporate agreement first.

Keep changes focused, and say what changed and why.

## Be kind

Be respectful and constructive in issues, reviews and discussions. Assume good faith.

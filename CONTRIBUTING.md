# Contributing to DialogWright

Pull requests are welcome. Thank you for helping.

## Build and test

Node 22.19 or later and pnpm are required.

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

Add the type to `BUILT_IN_SLOT_TYPES` in `slots/registry.ts` and export it from `slots/index.ts` and the root `src/index.ts`. A type is a pure function of its options: no global state, and no import from an app.

**Options.** Write them as a `z.strictObject`, so a misspelt option is an error, and give every option a `.describe(...)`. That text is the option's documentation: the generated docs page and the problems an author sees are made of it. Say what the option does, its default, and when it is needed. Put cross-option rules in a `superRefine` with a `fix` that tells the author what to write.

**Wording.** Declare each piece of question text as a part with `textParts` (a default template over the options), so an app can replace any part word for word with `text.<part>`. Declare question ids with `questionParts` (the slot's id followed by the part's name, so two slots of one type never share an id); `ids.<part>` lets an app keep an id it was recorded with. A type declares `questionIds` and every prompt it may lead to in `prompts` (with the variables each is given), and the thresholds its options name in `thresholds`. Compare the model's numbers only through `meetsThreshold`, never to a number written in the type.

**Neutral words and invented data.** Defaults, examples, tests and docs in the engine package use neutral vocabulary (account, card, parcel, book, appointment, caller, record). Names, numbers and dates are invented: the 555 phone range, fictional people. No real data, and no one industry's words; they belong in the app that needs them, as `text.<part>` literals.

**Locale.** A type must read and say en-US. Spanish is encouraged: read `ctx.locale`, format with the one `display(value, locale)`, and use the lexicon in `core/extract/lexicon.ts` for number words, fillers and names. en-US output must stay exactly the same whether a locale is given or not, and anything another locale changes must be gated on it. Put Spanish examples in `examples.yaml` (`context: { locale: es }`). Words an app chooses for a value, such as a choice option's `say`, can be given per locale through the type's `wording`; the questions stay in the default language.

**Privacy.** A type that holds an identifier defaults to masking it: `redact` (`last4`, `mask` or `length`) for what leaves the turn, `handoff` (`last4` or `verified`) for what a transfer carries. Free text defaults to `redact: length`. An app can turn masking off for a value that is no one's secret; the type must not do it for them.

**The conformance kit.** Run the checks with `pnpm --filter dialogwright test slots/<type>` (then the whole suite). Each runs over every example of the type, with no model and no keys:

| Check | What it proves |
|---|---|
| `builds` | The configuration builds a slot that declares its question ids and its lines |
| `unknown-keys` | An option the type does not have is refused, with a problem that names it |
| `question-ids` | `questions()` asks only declared ids, none the engine's, the same ones each time, other ids for a second slot, and the same questions whatever the wording by locale |
| `empty` | No answers at all never give a value |
| `quiet` | Answers that hear nothing never give a value |
| `malformed` | Answers of the wrong type, missing or out of range never make it throw |
| `thresholds` | Thresholds are read by name: with every probability and threshold scaled by one factor, nothing changes |
| `display` | `display(value, locale)` is what every fill, keypad value and candidate carries, and en-US formats as no locale does |
| `keypad` | The example's keys give its value, and keys of a wrong length give none |
| `prompts` | Every line an outcome can lead to is declared with the variables it is given |
| `utterances` | Each example utterance gives the outcome it expects, and at least one fills the slot |

The kit proves the contract, not that the parsing is right. Write tests for each outcome and each `invalid` reason, and for the edges of the type.

**Evidence for borderline wording.** The questions are requests to a model, and one word can change its answers. When a question's wording is a judgment call (what counts as a hedge, where a name ends), show why it is right: the utterances you tried and what a model answered, and a recorded run if you have a key (the clinic's README, "Recording the cassette", says how; never commit one that holds real calls). If you cannot record, say so in the pull request and a maintainer will.

**Regenerate and commit.** After a change to a type's options, run `pnpm --filter dialogwright schemas` (the JSON Schemas) and `pnpm --filter dialogwright slot-docs` (the page `docs/slots/<type>.md`, built from the type's README, options schema and examples). Do not write an options table by hand: put the markers `<!-- slot-docs:options -->` and `<!-- slot-docs:examples -->` in the README where the generated parts go, and add the type to the index in `docs/slots/README.md`. Tests fail when a schema or a page is stale, or when a type has no page.

Before you open the pull request: `pnpm verify`, `pnpm check`, and both regressions, as above. The CLA (below) covers a new type like any other contribution.

## Pull requests

On your first pull request, CLA Assistant will ask you to sign the [Individual Contributor License Agreement](docs/CLA.md) with your GitHub account; it takes a minute and covers all your future contributions. The agreement lets the project keep offering your work under Apache-2.0 and under other terms in the future, while you keep your copyright. If you contribute for a company, open an issue about a corporate agreement first.

Keep changes focused, and say what changed and why.

## Be kind

Be respectful and constructive in issues, reviews and discussions. Assume good faith.

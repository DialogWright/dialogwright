# The slot library

A slot is one value a form collects. An app can write each slot by hand as a `SlotSpec` (see section 5 of `docs/authoring-an-app.md`), or name a slot type from this library and give it options:

```ts
import { defineSlot } from 'dialogwright';

const courierNote = defineSlot('courierNote', {
  type: 'text',
  what: 'a note for the courier',
  say: 'your note',
});
```

`defineSlot` checks the options against the type's schema, builds the slot, and returns an ordinary `SlotSpec` with two more fields: `type` (the type's name) and `config` (the options as parsed, defaults filled in), so app code can read them. The engine runs a library slot exactly as it runs a hand-written one.

## What a type is

A slot type (`SlotType<O>` in `types.ts`) is:

| Field | What it is |
|---|---|
| `type` | Its name, as an app writes it: lower case letters, digits and hyphens. |
| `options` | A strict zod object (`z.strictObject`) for its options, each described with `.describe(...)`. Strict, so a misspelt option is refused instead of silently ignored. |
| `build(id, options, wording?, env?)` | The `SlotSpec`, from the slot's id and its parsed options (and its wording by locale, and what the app gives every slot: `env.catalog`, its knowledge's topics, which the `topic` type reads). It must declare `questionIds` (every question id it may ask) and `prompts` (every line it may lead to beyond `ask_<slot>` and `ask_<slot>_retry`). |
| `examples` | Configurations with starter utterances, read from the type's `examples.yaml` the first time they are asked for. |
| `describe` | A summary and notes for the type's docs page. |

`defineSlotType(def)` checks a type's name and that its options refuse unknown keys. An app adds its own types to a map with `registerSlotType(type)`, which returns a new map to pass to `defineSlot(id, config, types)`; there is no global registry for an import to change.

When a configuration is wrong, `defineSlot` throws a `SlotConfigError` whose `problems` are in the app loader's format (`file:line:column  path  message  ->  fix`). `buildSlot(id, config, { source })` returns them instead of throwing; given the YAML document a configuration came from, it points each problem at its line.

## The folder of a type

Each type has a folder under `src/slots/`:

| File | What it holds |
|---|---|
| `index.ts` | The type: `defineSlotType({ type, options, build, examples, describe })`. |
| `options.ts` | The options schema, the type's text parts and question parts, and the defaults. |
| `questions.ts` | The questions the slot asks, rendered from the options. |
| `fill.ts` | How the model's answers become an outcome. |
| `display.ts` | `display(value, locale)`: how a value is said. The fill, the keypad and any disambiguation candidates use the same function, so they always agree. |
| `<type>.test.ts` | `runSlotConformance` over the examples, then unit tests of what the kit does not cover. |
| `examples.yaml` | Example configurations with starter utterances. |
| `README.md` | The type's hand-written docs: what it collects, the outcomes, its question wording, the prompts it needs, notes. Two marker lines, `<!-- slot-docs:options -->` and `<!-- slot-docs:examples -->`, say where the generated options, text parts, question ids and examples go. |

The docs page for a type, `docs/slots/<type>.md`, is its README with those two markers replaced by tables read from the options schema (names, types, defaults and the `.describe(...)` text) and from `examples.yaml`. Run `pnpm --filter dialogwright slot-docs` to write the pages; a test fails when a committed page is stale, and when a type lacks a page or the index (`docs/slots/README.md`) lacks the type.

`text/` is the pattern to copy.

## Shared parts

`parts/` holds what types share. A type written outside this package imports them from `dialogwright/slot-kit` (`defineSlotType`, `textParts`, `questionParts`, `questionText`, `renderTemplate`, `meetsThreshold`, `examplesFrom`, `parseSlotExamples`, `wordingFor`, and the types of an example), the readers from `dialogwright`, and the conformance kit from `dialogwright/testing`:

```ts
import { defineSlotType, meetsThreshold, questionParts, textParts } from 'dialogwright/slot-kit';
import { noulValue, type SlotType } from 'dialogwright';
```

- **Text parts** (`textParts`). A type declares its pieces of question text by name, each with a default template that uses only neutral words. Templates have `{name}` placeholders and nothing else; a placeholder the type does not give is an error when the type is defined. An app replaces a part with `text: { <part>: "..." }`, which is sent to the model exactly as written. That is how an app keeps its own wording, or the words a recording was made with.
- **Question ids** (`questionParts`). A question's id is the slot's id followed by the part's name (`courierNote` and `given` give `courierNoteGiven`), so two slots of one type never share an id. `ids: { <part>: "..." }` keeps the id an existing slot used.
- **Thresholds by name** (`meetsThreshold(ctx.thresholds, 'SLOT_DETECT', p)`). A type compares the model's numbers only to thresholds it reads by name from the context, never to a number written in the type.
- **Readers**, from the package root (`dialogwright`): `noulValue`, `isChoice`, `rankProbabilities`, `topMargin`, `atLeast`, `candidateSpans`, `candidateWordSpans`, `spokenToDigits`, `tokenize`, `numbersSaid`, `matchesMask`, and the date helpers.
- **Examples** (`examplesFrom`, `parseSlotExamples`): reading and checking an `examples.yaml`.

## The conformance kit

The kit (`conformance/`, exported from `dialogwright/testing`, not the root entry) checks that a type keeps the contract the engine relies on. It runs over every example configuration of the type:

| Check | What it proves |
|---|---|
| `builds` | The configuration builds a slot that declares its question ids and its lines. |
| `unknown-keys` | An option the type does not have is refused, with a problem that names it (and so is an unknown part under `text` or `ids`). |
| `question-ids` | `questions()` asks only the ids the slot declares, in every context the kit tries (no words and each utterance's; asked or not; with and without a value on file; with and without each pending partial, or one the kit makes up for a type whose examples make none; in each locale; and on a Sunday, February 28th and 29th of a leap year and December 31st as well as the kit's Friday); none is the engine's; the same configuration gives the same ids and questions; a second slot of the type gets other ids; an example's `wording` (a locale's) leaves the questions as they are. |
| `empty` | No answers at all give `absent` when the slot was not asked for. When it was asked for, they give `absent` or `invalid` (a slot with nothing to offer, or one that reads a turn that named nothing as a miss, says so), never a value, a pair to choose between or a partial. |
| `quiet` | Answers that hear nothing (every yes-or-no at 0, every choice on `none`, every score on its lowest level) give `absent` or `invalid`, never a value. |
| `malformed` | Answers of the wrong type, missing or out of range, and keys that are no value, never make it throw, and what it returns is an outcome. |
| `thresholds` | A fill reads at least one threshold by name; with every threshold it reads out of reach it does not fill; and with every probability and every threshold scaled by the same factor, every outcome stays the same. A number written into the type breaks that last one. |
| `threshold-names` | Every threshold a fill reads is one of the engine's (`DEFAULT_THRESHOLDS`) or one the slot declares in `thresholds`, and every threshold it declares is read by some utterance of the example. |
| `boundary` | For every threshold a fill reads, set exactly to a number the model gave, the outcome is the one it gives with the threshold just below: a number that equals its threshold meets it (`atLeast`, `meetsThreshold`), so a `>` is caught. |
| `display` | `display(value, locale)` is the display every fill, keypad value and candidate carries, in every locale the kit is given, and en-US formats as no locale does. A slot shown as said (`displayFrom: 'said'`: a text slot whose value code writes from the words) is the one exception: its fill carries the words, which `display(value)` cannot give back. The example pins at least one display in each of those locales (`expect.display` on an utterance said there, `expect.displays: { <tag>: ... }`, or a keypad value's `display`), and every pinned display is what the slot gives, so a display wrong the same way every time is caught. |
| `keypad` | For a type with a keypad rung: the example's keys give the value expected, and keys of a wrong length give none. |
| `prompts` | Every line an outcome can lead to (a `retryPromptId`, a help prompt, `disambiguate_<slot>` with `a` and `b`, the partial prompt with its variables) is in the slot's `prompts` with the variables it is given. |
| `prompt-vars` | Every line the slot declares lists only variables the engine gives it: `ack_<slot>` and `confirm_<slot>` get `{<slot>}`, `disambiguate_<slot>` gets `{a}` and `{b}`, the partial prompt gets its `partialVars` (and so does `ask_<slot>` when there is no partial prompt), and `ask_<slot>_dtmf`, `ask_<slot>_retry`, a `retryPromptId` and a help line get none. A line declared with another would pass `dialogwright check` and fail when it is said. A `by-confidence` slot that fills with `confirm: implicit` declares `ack_<slot>`. |
| `values` | A slot whose `valueKind` is `date` gives ISO dates (`YYYY-MM-DD`) from every fill, candidate and keypad value; every confidence is a number from 0 to 1. |
| `utterances` | Each example utterance gives the outcome it expects, answers only questions the slot asks, and at least one fills the slot. |

In a type's test file:

```ts
import { describe, it } from 'vitest';
import { runSlotConformance } from 'dialogwright/testing';
import { myType } from './index';

runSlotConformance(myType, { describe, it });
```

The kit checks en-US and es unless it is given `locales`. The runner's `describe` and `it` are passed in, so importing the kit loads no test runner. `slotConformanceChecks(type)` returns the checks for any other runner. The kit's own tests (`conformance/conformance.test.ts`) break a small correct type in one way at a time and show that the check meant for each fault catches it.

### Examples and starter utterances

A slot reads the model's answers, not the caller's words, so an example gives both:

```yaml
- name: courier note
  about: A note with its own stand-in.
  slot: courierNote
  config:
    what: a note for the courier
    say: your note
  utterances:
    - text: please leave it behind the blue gate
      answers:
        courierNoteGiven: { noul: 0.9 }
      expect: { kind: filled, value: please leave it behind the blue gate, display: your note }
    - text: ring the bell twice
      answers:
        courierNoteGiven: { noul: 0.91 }
      context: { current: please leave it behind the blue gate, prompted: true }
      expect: { kind: absent }
```

An answer is `{ noul: p }`, `{ choice: { <label>: p, ... } }` or `{ score: { <level>: p, ... } }`. `context` sets `prompted`, `current`, `locale`, `window`, `todayIso`, `records`, `sources` or `nominated` (the topics retrieval nominated for the words, `{ topic, title, score, via? }` each, which go with the words into every context the kit tries them in, as the records do). An example of a type that reads the app's knowledge topics gives them as `topics: [{ id, title, titles? }]`, and its slot is built with them. `expect` gives the outcome's `kind` and any of `value`, `display`, `confirm`, `reason`, `raw`, `retryPromptId` and `promptId`, and `displays: { <tag>: ... }`, the display the same answers give in another locale (`displays: { es: "su nota" }`). A type with a keypad rung adds `keypad: [{ digits, locale?, expect: { value, display? } | null }]` (`locale`: the keys are pressed in that locale, as a day-first date is in Spanish). An example of a type that takes a locale's wording may add `wording: { <tag>: ... }`, written as a locale's slots.yaml writes it; the kit builds the slot with it, checks every display in that locale, and checks the questions are the same as without it.

## Locales

A slot hears and says its value in the session's locale (`ctx.locale`, and the `locale` of `display` and `partialVars`), which only an app that declares locales has. Every type formats en-US exactly as it does with no locale; anything another locale changes is gated on it:

- **Words.** `ctx.candidateSpans` and `ctx.candidateWordSpans` are already in the session's language, and `spokenToDigits`, `numbersSaid`, `tokenize` and `normalizeYear` take the locale (core/extract/lexicon.ts: one lexicon per language, English and Spanish so far; `es-*` reads as `es`). A Spanish span keeps its accents; the tables compare it without them.
- **Formats.** `describeDay`, `describeDob` and `describeWindow` take the locale ("martes, 22 de septiembre", "22 de noviembre de 1991", "la próxima semana"); `titleCase` keeps Spanish particles in lower case ("Muñoz de la Cruz"). `dayFirst(locale)` says whether numbers give the day first, for a keypad (`DDMM`) and the day-first sentence of a date's default questions.
- **Wording.** A type whose display has words an app chooses (a choice option's `say`, a text slot's stand-in) declares `wording(options?)`: the schema of what a locale's `locale/<tag>/slots.yaml` may give, strict over the slot's options. `build(id, options, wording)` receives it by locale tag, and the display reads `wordingFor(wording, locale)`. Wording never reaches the questions: the model reads them as written in every locale, and their labels are keys.


## Adding a type

1. Copy `text/` to a folder named after the type, and rename.
2. Write the options in `options.ts` with `z.strictObject`, describing each one. Use `textParts` for any question text and `questionParts` for question ids, with neutral default wording (account, card, parcel, book, appointment).
3. Write `questions.ts`, `fill.ts` and `display.ts`. Compare probabilities only through `meetsThreshold` (or `atLeast` against `ctx.thresholds.<NAME>`). Format every display with the one `display` function, given `ctx.locale`.
4. Write `examples.yaml`: a few configurations, each with utterances that fill, that miss, and that hit each `invalid` reason the type has.
5. Add the type to `BUILT_IN_SLOT_TYPES` in `registry.ts`, and export its options type from `index.ts` (the package root re-exports it). The type itself is reached through `BUILT_IN_SLOT_TYPES`, not exported by name.
6. Run its checks: `pnpm --filter dialogwright test slots/<type>`. Then the whole suite, `pnpm verify`, and `pnpm check`.
7. Write its `README.md`: what it collects, the outcomes, the question wording, the prompts it needs and notes, with the two marker lines where the options and examples go. Do not write an options table; the page generates it. Then `pnpm --filter dialogwright slot-docs`, commit `docs/slots/<type>.md`, and add the type to the index in `docs/slots/README.md`.

Keep the words of the engine package neutral: no one industry's vocabulary in a type, its defaults, its examples or its docs. Names, numbers and dates in examples are invented.

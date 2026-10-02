# `name`

The caller's own name, as they say it: "Anna Petrov", "Sam", "Priya Raghunathan".

The model never writes the name. It answers two questions about the caller's words: does the caller state their own name, and which of the offered spans of their words is it (the engine finds the candidate word spans, the model picks one). The value is the span as the caller said it, so it is always words the caller said, and the code, not the model, decides which spans are on the ballot.

A span can be withheld before the model sees it. `exclude` lists words that are never the caller's name (a title, the names of people who are discussed on the call but are not the caller), and no span holding one is offered. That matters when a caller corrects someone else's name ("not Rivera, Quinn"): read alone, a correction can look like the caller naming themselves, and a name the caller never said is worse than no name. What is not on the ballot cannot be chosen, and a span the model answers anyway (an answer built against other words, as a recording made before a word was excluded can be) is refused.

Reach for it for the caller's own name. For a name chosen from a list (a doctor, a branch), use `choice`; for free words (a description, a note), use `text`.

## Options

<!-- slot-docs:options -->

The slot is always `detect: true` (its row in the console is measured against `SLOT_DETECT`), read back in the final summary and never on its own (`spokenConfirm: summary`), and has no keypad rung: a name cannot be keyed, so a caller whose name is not heard goes through the retry ladder to a person.

## The outcome

| What the caller said | The outcome |
|---|---|
| No name (the first question is below `SLOT_DETECT`) | `absent`, so a turn about something else leaves the slot alone |
| A name, but no span chosen (or `none`) | `invalid`, reason `no_span` |
| A span this turn's question did not offer | `invalid`, reason `no_span`, with the span as raw |
| An offered span | `filled`: the value is the span with its whitespace collapsed, the display is the name title-cased, with the span's own probability as its confidence, never acknowledged |

## The questions

On the slot `name` the questions are `nameGiven` and `nameSpan`. Each text part has a default, listed under Text parts after the options table; `text` replaces any of them.

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. `span` is a choice whose labels are the offered spans and `none`, which means `spanNone`; `<slot>` is the slot's id. The word `none` said aloud is a span like any other and would collide with the question's own `none`, so it is never offered as a span.

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot, and nothing more: the slot has no partial value and no keypad. `dialogwright check` requires each in every locale.

## Examples

The starter examples, listed below, are three configurations with starter utterances: the defaults, a call where the caller names someone else too (words withheld, handed over as verified), and a masked name with its own wording and ids. In an app's `slots.yaml`:

```yaml
caller:
  type: name
  exclude: [dr, doctor, rivera, quinn]
```

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the two questions are asked even while the form is on another slot, and "this is Morgan Ellis, calling about my appointment" can fill the name on the opening turn.
- The words that are withheld are a list in the slot's configuration, not a reference to another slot, because a slot is built from its own options alone. An app whose other people are a list it already has (a roster of providers) keeps one source for both and checks in a test that the list here equals the one derived from the roster.
- The model sees at most the engine's candidate word spans (one to four words each, never starting or ending with a filler such as "my" or "is"), so a name of more than four words is not offered whole.
- Display is title-casing of each run of letters; names with apostrophes ("O'Neil") are said as "O Neil", as the words were tokenized.
- In a Spanish session (`es`, `es-*`) the spans are Unicode words ("maría josé"), the fillers are Spanish ("me llamo", "soy"), a compound surname is one span (up to three particles, `de`, `del`, `la`, `las`, `los`, `y`, `e`, between its words, beyond the four: "maría josé muñoz de la cruz"), the display keeps those particles in lower case ("María José Muñoz de la Cruz"), and `exclude` compares words without accents ("munoz" withholds "muñoz").
- Run its checks with `pnpm --filter dialogwright test slots/name`.

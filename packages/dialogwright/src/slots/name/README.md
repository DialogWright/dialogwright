# `name`

The caller's own name, as they say it: "Anna Petrov", "Sam", "Priya Raghunathan".

The model never writes the name. It answers two questions about the caller's words: does the caller state their own name, and which of the offered spans of their words is it (the engine finds the candidate word spans, the model picks one). The value is the span as the caller said it, so it is always words the caller said, and the code, not the model, decides which spans are on the ballot.

A span can be withheld before the model sees it. `exclude` lists words that are never the caller's name (a title, the names of people who are discussed on the call but are not the caller), and no span holding one is offered. That matters when a caller corrects someone else's name ("not Rivera, Quinn"): read alone, a correction can look like the caller naming themselves, and a name the caller never said is worse than no name. What is not on the ballot cannot be chosen, and a span the model answers anyway (an answer built against other words, as a recording made before a word was excluded can be) is refused.

Reach for it for the caller's own name. For a name chosen from a list (a doctor, a branch), use `choice`; for free words (a description, a note), use `text`.

## Options

| Option | Default | What it does |
|---|---|---|
| `exclude` | none | Words that never belong to the caller's name: a span holding any of them is not offered, and one answered anyway is `invalid` with the reason `no_span`. One word per entry, letters and digits only, compared in lower case word by word (so `chen` withholds "chen" and "dr chen" but not "chenoweth"). A caller who shares one of the words cannot give their name by voice, so list only what is needed. |
| `redact` | `none` | How the value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name): `mask` ("•"), or `none` to keep it as it is. |
| `handoff` | `display` | What a transfer to a person hands over: the name as it is said (`display`), or only whether the caller was `verified`. |
| `text` | none | A literal for any text part (below), sent to the model exactly as written in place of the default. One line each. |
| `ids` | none | A question id for `given` or `span` in place of `<slot>Given` and `<slot>Span`, to keep the ids an existing slot was recorded with. |

The slot is always `detect: true` (its row in the console is measured against `SLOT_DETECT`), read back in the final summary and never on its own (`spokenConfirm: summary`), and has no keypad rung: a name cannot be keyed, so a caller whose name is not heard goes through the retry ladder to a person.

## The outcome

| What the caller said | The outcome |
|---|---|
| No name (the first question is below `SLOT_DETECT`) | `absent`, so a turn about something else leaves the slot alone |
| A name, but no span chosen (or `none`) | `invalid`, reason `no_span` |
| A span this turn's question did not offer | `invalid`, reason `no_span`, with the span as raw |
| An offered span | `filled`: the value is the span with its whitespace collapsed, the display is the name title-cased, with the span's own probability as its confidence, never acknowledged |

## The questions

On the slot `name` the questions are `nameGiven` and `nameSpan`. Each text part has a default; `text` replaces any of them.

| Part | Default |
|---|---|
| `given` | Read asr.text. Does the caller state their own name, first name alone or first and last? |
| `givenTrue` | The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan, including a correction to their own name just read back to them, as in no, it's Sam Lee |
| `givenFalse` | No personal name, or a name that is not the caller's, such as the name of someone they are talking about |
| `span` | Read asr.text. Which of these spans is the caller's own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose anyone else's name. When `slots.<slot>` is already set and the caller gives a different name for themselves, as in no, it's Sam Lee, choose that span. A single word can be the whole name, as in Prince. Choose none if no span is the caller's name. |
| `spanNone` | No span of asr.text is the caller's name, as when the caller only agrees, refuses, or names something other than themselves |

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. `span` is a choice whose labels are the offered spans and `none`, which means `spanNone`; `<slot>` is the slot's id. The word `none` said aloud is a span like any other and would collide with the question's own `none`, so it is never offered as a span.

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot, and nothing more: the slot has no partial value and no keypad. `dialogwright check` requires each in every locale.

## Examples

`examples.yaml` beside this file has three configurations with starter utterances: the defaults, a call where the caller names someone else too (words withheld, handed over as verified), and a masked name with its own wording and ids. In an app's `slots.yaml`:

```yaml
caller:
  type: name
  exclude: [dr, doctor, rivera, quinn]
```

## Notes

- Every slot listens on every turn, so the two questions are asked even while the form is on another slot, and "this is Morgan Ellis, calling about my appointment" can fill the name on the opening turn.
- The words that are withheld are a list in the slot's configuration, not a reference to another slot, because a slot is built from its own options alone. An app whose other people are a list it already has (a roster of providers) keeps one source for both and checks in a test that the list here equals the one derived from the roster.
- The model sees at most the engine's candidate word spans (one to four words each, never starting or ending with a filler such as "my" or "is"), so a name of more than four words is not offered whole.
- Display is title-casing of each run of letters; names with apostrophes ("O'Neil") are said as "O Neil", as the words were tokenized.
- Run its checks with `pnpm --filter dialogwright test slots/name`.

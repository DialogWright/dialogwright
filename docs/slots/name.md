# `name`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/name/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

The caller's own name, as they say it: "Anna Petrov", "Sam", "Priya Raghunathan".

The model never writes the name. It answers two questions about the caller's words: does the caller state their own name, and which of the offered spans of their words is it (the engine finds the candidate word spans, the model picks one). The value is the span as the caller said it, so it is always words the caller said, and the code, not the model, decides which spans are on the ballot.

A span can be withheld before the model sees it. `exclude` lists words that are never the caller's name (a title, the names of people who are discussed on the call but are not the caller), and no span holding one is offered. That matters when a caller corrects someone else's name ("not Rivera, Quinn"): read alone, a correction can look like the caller naming themselves, and a name the caller never said is worse than no name. What is not on the ballot cannot be chosen, and a span the model answers anyway (an answer built against other words, as a recording made before a word was excluded can be) is refused.

Reach for it for the caller's own name. For a name chosen from a list (a doctor, a branch), use `choice`; for free words (a description, a note), use `text`.

## Options

A slot of this type is written under its id in slots.yaml, with `type: name` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `exclude` | list of string | `[]` | Words that never belong to the caller's name: a span holding any of them is not offered to the model, and one answered anyway is refused. For the titles and names of people who are discussed on the call but are not the caller (a doctor, a technician). Compared in lower case, word by word. A caller who shares one of the words cannot give their name by voice, so list only what is needed. Default: none. |
| `redact` | one of `none`, `mask` | `none` | How the value is masked wherever it leaves the turn (the trace, a tool call's param of the same name): "mask" ("•") or "none", kept as it is. |
| `handoff` | one of `display`, `verified` | `display` | What a transfer to a person hands over: the name as its "display", or only whether the caller was "verified", never the name. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, givenTrue, givenFalse, span, spanNone. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, span), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept whenever it is said, until a form that has the slot uses it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller gives their own name at all. | `Read asr.text. Does the caller state their own name, first name alone or first and last?` |
| `text.givenTrue` | What a yes to the first question means (its "true" criterion). | `The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan, including a correction to their own name just read back to them, as in no, it's Sam Lee` |
| `text.givenFalse` | What a no to the first question means (its "false" criterion). | `No personal name, or a name that is not the caller's, such as the name of someone they are talking about` |
| `text.span` | The question that asks which span of the caller's words is their name. Its choices are the word spans the engine finds, less the ones `exclude` withholds, and none. Variables: `{slot}`. | `` Read asr.text. Which of these spans is the caller's own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose anyone else's name. When `slots.{slot}` is already set and the caller gives a different name for themselves, as in no, it's Sam Lee, choose that span. A single word can be the whole name, as in Prince. Choose none if no span is the caller's name. `` |
| `text.spanNone` | What the span question's "none" choice means. | `No span of asr.text is the caller's name, as when the caller only agrees, refuses, or names something other than themselves` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller states their own name. |
| `ids.span` | The id of the question that asks which span of the caller's words is their name. |

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

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### caller's name

The defaults. First and last name, or one word, said back title-cased. A correction to a name already on file replaces it, and a turn that gives no name leaves the slot alone.

```yaml
name:
  type: name
```

<details><summary>Starter utterances (9)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| my name is Morgan Ellis | `nameGiven`: yes 0.95<br>`nameSpan`: `morgan ellis` 0.9, `none` 0.1 | filled: value `morgan ellis`, display `Morgan Ellis`, confirm `none` |
| it's Cher | `nameGiven`: yes 0.9<br>`nameSpan`: `cher` 0.92, `none` 0.08 | filled: value `cher`, display `Cher` |
| me llamo María José Muñoz de la Cruz<br>_locale es_ | `nameGiven`: yes 0.95<br>`nameSpan`: `maría josé muñoz de la cruz` 0.9, `none` 0.1 | filled: value `maría josé muñoz de la cruz`, display `María José Muñoz de la Cruz`, confirm `none` |
| hola, soy Íñigo Peña<br>_locale es-MX_ | `nameGiven`: yes 0.92<br>`nameSpan`: `íñigo peña` 0.9, `none` 0.1 | filled: value `íñigo peña`, display `Íñigo Peña` |
| me llamo Ana<br>_locale es_ | `nameGiven`: yes 0.9<br>`nameSpan`: `me llamo ana` 0.9, `none` 0.1 | invalid: reason `no_span`, raw `me llamo ana` |
| no, it's Sam Lee<br>_prompted; current sam leigh_ | `nameGiven`: yes 0.9<br>`nameSpan`: `sam lee` 0.9, `none` 0.1 | filled: value `sam lee`, display `Sam Lee` |
| I want to change my address | `nameGiven`: yes 0.05<br>`nameSpan`: `none` 1 | absent |
| none of your business | `nameGiven`: yes 0.7<br>`nameSpan`: `none` 0.95 | invalid: reason `no_span`, raw `` |
| this is Morgan Ellis | `nameGiven`: yes 0.9<br>`nameSpan`: `ellis morgan` 0.9, `none` 0.1 | invalid: reason `no_span`, raw `ellis morgan` |

</details>

#### name beside a second person's

A call where the caller names someone else too (a technician, a manager). The words that are never the caller's name are listed, and no span holding one is offered, so a correction to the other person's name cannot be taken as the caller's own.

```yaml
caller:
  type: name
  exclude:
    - tech
    - technician
    - rivera
    - quinn
  handoff: verified
```

<details><summary>Starter utterances (4)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| this is Morgan Ellis calling about technician Rivera | `callerGiven`: yes 0.95<br>`callerSpan`: `morgan ellis` 0.9, `none` 0.1 | filled: value `morgan ellis`, display `Morgan Ellis`, display in es `Morgan Ellis` |
| not Rivera, Quinn | `callerGiven`: yes 0.4<br>`callerSpan`: `none` 1 | absent |
| not Rivera, Quinn | `callerGiven`: yes 0.8<br>`callerSpan`: `rivera quinn` 0.8, `none` 0.2 | invalid: reason `no_span`, raw `rivera quinn` |
| I'd like to talk to technician Quinn | `callerGiven`: yes 0.9<br>`callerSpan`: `technician quinn` 0.8, `none` 0.2 | invalid: reason `no_span`, raw `technician quinn` |

</details>

#### name in the line's own words

A masked name with its own wording and its own question ids, as an app keeps the words a recording was made with.

```yaml
contact:
  type: name
  redact: mask
  ids:
    given: saysContactName
  text:
    given: Read asr.text. Does the caller give the name of the person to contact?
    givenTrue: The caller names the person to contact, with or without their own name
    givenFalse: No name, or a name that is not the contact's
    span: Read asr.text. Which of these spans is the contact's name? Choose none if no span is a name.
    spanNone: No span of asr.text is the contact's name
```

<details><summary>Starter utterances (2)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| ask for Priya Raghunathan | `saysContactName`: yes 0.93<br>`contactSpan`: `priya raghunathan` 0.88, `none` 0.12 | filled: value `priya raghunathan`, display `Priya Raghunathan`, display in es `Priya Raghunathan` |
| I'll tell you later | `saysContactName`: yes 0.1<br>`contactSpan`: `none` 1 | absent |

</details>

## Notes

- Every slot listens on every turn, so the two questions are asked even while the form is on another slot, and "this is Morgan Ellis, calling about my appointment" can fill the name on the opening turn.
- The words that are withheld are a list in the slot's configuration, not a reference to another slot, because a slot is built from its own options alone. An app whose other people are a list it already has (a roster of providers) keeps one source for both and checks in a test that the list here equals the one derived from the roster.
- The model sees at most the engine's candidate word spans (one to four words each, never starting or ending with a filler such as "my" or "is"), so a name of more than four words is not offered whole.
- Display is title-casing of each run of letters; names with apostrophes ("O'Neil") are said as "O Neil", as the words were tokenized.
- In a Spanish session (`es`, `es-*`) the spans are Unicode words ("maría josé"), the fillers are Spanish ("me llamo", "soy"), a compound surname is one span (up to three particles, `de`, `del`, `la`, `las`, `los`, `y`, `e`, between its words, beyond the four: "maría josé muñoz de la cruz"), the display keeps those particles in lower case ("María José Muñoz de la Cruz"), and `exclude` compares words without accents ("munoz" withholds "muñoz").
- Run its checks with `pnpm --filter dialogwright test slots/name`.

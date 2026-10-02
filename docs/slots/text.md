# `text`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/text/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

The caller's own words, kept as said: a description of a problem, a note for a courier, a reason for a request.

One yes-or-no question asks whether the caller gives the text. When the model says yes (at `SLOT_DETECT` or above), the value is the caller's words on that turn, trimmed and cut to `maxLength`. The model never writes or rewrites the value. A summary reads the slot back by a stand-in (`say`, "your description"), and by default the words leave the turn (the trace, a tool call's param of the same name) as their length only.

Reach for it for a value no list holds and no code can check. For a number, a date, a name or a choice from a list, use the type made for it: those check what they hear.

## Options

A slot of this type is written under its id in slots.yaml, with `type: text` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `what` | string | unset | What the caller gives, as a noun phrase the default question names ("a description of the problem"). Needed unless text.given gives the question in its own words. |
| `instructions` | string | unset | More guidance for the model, added after the default question ("Count it even when it comes with a request."). |
| `maxLength` | integer, 1 or more | `500` | The most characters of the caller's words the value keeps; the rest is cut off. |
| `say` | string or null | `your description` | The display: what a line, the console and the model's turn state show in place of the words ("your note"). null: the words themselves. |
| `keep` | one of `first`, `first-unless-prompted` | `first-unless-prompted` | When a value is on file: "first-unless-prompted" replaces it only when the slot was just asked for; "first" never does. A correction at the summary replaces it either way. |
| `redact` | one of `length`, `none` | `length` | "length": the words leave the turn (the trace, a tool call's param) as their length only, and the display is kept. "none": as they are. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given), to keep the ids an existing slot used. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller gives the text, word for word. Variables: `{what}`, `{instructions}`. | `Read asr.text. Does the caller give {what}? A request alone is not {what}.{instructions}` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller gives the text. |

The slot is fixed to `spokenConfirm: summary` and `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`.

## The question

With `what: a description of the problem` on the slot `problem`, the question is `problemGiven`:

> Read asr.text. Does the caller give a description of the problem? A request alone is not a description of the problem.

With `instructions`, its words follow, after a space.

## Examples

The starter examples, listed below, are four configurations with starter utterances: the defaults, a courier note with its own stand-in and length, a slot keeping its recorded wording and id (`text.given`, `ids.given`), and a phrase shown as said. In an app's `slots.yaml`:

```yaml
courierNote:
  type: text
  what: a note for the courier
  instructions: Count where to leave the parcel and how to reach the door.
  say: your note
```

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### problem description

The defaults. One question asks whether the caller describes the problem; the words are the value, shown as "your description".

```yaml
problem:
  type: text
  what: a description of the problem
```

<details><summary>Starter utterances (5)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| The screen on my tablet went dark and it will not turn back on. | `problemGiven`: yes 0.93 | filled: value `The screen on my tablet went dark and it will not turn back on.`, display `your description`, confirm `none`, display in es `your description` |
| I need some help please | `problemGiven`: yes 0.12 | absent |
| oh and the charger is missing too<br>_prompted false; current The screen went dark._ | `problemGiven`: yes 0.9 | absent |
| Actually the screen flickers first and then goes dark.<br>_prompted; current The screen went dark._ | `problemGiven`: yes 0.88 | filled: value `Actually the screen flickers first and then goes dark.`, display `your description` |
|     | `problemGiven`: yes 0.9 | absent |

</details>

#### courier note

A note with more guidance for the model, its own stand-in (in Spanish, the locale's), a length limit, and a first note that is never replaced.

```yaml
courierNote:
  type: text
  what: a note for the courier
  instructions: Count where to leave the parcel and how to reach the door.
  say: your note
  keep: first
  maxLength: 36
```

In `locale/es/slots.yaml`:

```yaml
courierNote:
  say: su nota
```

<details><summary>Starter utterances (3)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| please leave it behind the blue gate next to the shed, thank you | `courierNoteGiven`: yes 0.9 | filled: value `please leave it behind the blue gate`, display `your note` |
| ring the bell twice<br>_prompted; current please leave it behind the blue gate_ | `courierNoteGiven`: yes 0.91 | absent |
| déjelo detrás de la puerta azul<br>_locale es_ | `courierNoteGiven`: yes 0.9 | filled: value `déjelo detrás de la puerta azul`, display `su nota` |

</details>

#### existing wording and ids

A slot moved onto the library keeps the question text and id it was recorded with, word for word.

```yaml
issue:
  type: text
  text:
    given: Read asr.text. Does the caller say what went wrong with the order? A request alone is not.
  ids:
    given: describesIssue
```

<details><summary>Starter utterances (2)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the box arrived crushed and the lamp inside is broken | `describesIssue`: yes 0.81 | filled: value `the box arrived crushed and the lamp inside is broken`, display `your description`, display in es `your description` |
| I want to talk about my order | `describesIssue`: yes 0.3 | absent |

</details>

#### words as the display

A short phrase that is not sensitive, shown as said and kept in the trace.

```yaml
reference:
  type: text
  what: a short reference phrase for the booking
  say: null
  redact: none
  maxLength: 60
```

<details><summary>Starter utterances (1)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| blue heron on the lake | `referenceGiven`: yes 0.95 | filled: value `blue heron on the lake`, display `blue heron on the lake`, display in es `blue heron on the lake` |

</details>

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- The value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence.
- In another locale the stand-in can be that locale's: `locale/<tag>/slots.yaml` gives `say: <stand-in>` for the slot. The words themselves are the caller's, in whatever language they spoke. A slot whose display is the words (`say: null`) takes none.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

# `text`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/text/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

The caller's own words, kept as said: a description of a problem, a note for a courier, a reason for a request.

One yes-or-no question asks whether the caller gives the text. When the model says yes (at `SLOT_DETECT` or above), the value is the caller's words on that turn, trimmed and cut to `maxLength`. The model never writes or rewrites the value. A summary reads the slot back by a stand-in (`say`, "your description"), and by default the words leave the turn (the trace, a tool call's param of the same name) as their length only.

With `pick`, the value is the part of the words that is the value, picked out rather than written: code splits the words into candidate parts, a second question asks which of them is the value, and the value is that part, as said (see "Picking the value out of the words").

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
| `pick` | map | unset | Pick the value out of the words. Code splits the caller's words into candidate parts (clauses, split at punctuation and at joining words, and each clause's tail after a preposition; each verbatim, at most 8), and a second question (`ids.pick`, default `<slot>Pick`) asks which of them is `pick.what`, by letter, or none of these. The value is the part chosen, as said; none, a choice below SLOT_DETECT, or words that make one candidate keep the whole words. Default: off, the value is the whole words and only the one question is asked. |
| `pick.what` | string | required | What the value is, as a noun phrase the pick question names ("the street address"). |
| `pick.words` | map of map | unset | The joining words and prepositions by language tag ("fr", or "fr-CA" for one region), for a language with no built-in list or to replace one. Built in: English ("and", "but", "so", "because"; "at", "on", "in", "near", "by"), also read with no locale, and Spanish ("y", "e", "pero", "porque", "así que"; "en", "cerca de", "junto a"). A language with neither splits at punctuation only. |
| `pick.words.<key>.joiners` | list of string | unset | Words or phrases that join two clauses, where the words are split ("et", "parce que"). Replaces the built-in list of the language. |
| `pick.words.<key>.prepositions` | list of string | unset | Words or phrases after which a clause's tail is offered too ("au", "près de"). Replaces the built-in list of the language. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, pick, pickNone. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, pick), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept whenever it is said, until a form that has the slot uses it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller gives the text, word for word. Variables: `{what}`, `{instructions}`. | `Read asr.text. Does the caller give {what}? A request alone is not {what}.{instructions}` |
| `text.pick` | With `pick`: the question that asks which of the candidate parts is the value; {what} is pick.what. Variables: `{what}`. | `Read asr.text. Which of these parts of the caller's words is {what}, with nothing else in it?` |
| `text.pickNone` | With `pick`: what the pick question's "none" label means, which keeps the whole words; {what} is pick.what. Variables: `{what}`. | `None of these is {what}` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller gives the text. |
| `ids.pick` | The id of the question that asks which part of the caller's words is the value (with `pick`). |

The slot is fixed to `spokenConfirm: summary` and `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`.

## The question

With `what: a description of the problem` on the slot `problem`, the question is `problemGiven`:

> Read asr.text. Does the caller give a description of the problem? A request alone is not a description of the problem.

With `instructions`, its words follow, after a space.

## Picking the value out of the words

A caller rarely says only the value. Asked where the outage is, they say "the power is out at 22 Alder Street and nothing works", and without `pick` that whole sentence is the value. With `pick: { what: the street address }` on the slot `place`, code splits the words into candidate parts, each copied as said:

- **Clauses.** The words are split at punctuation (`.` `!` `?` `;` `:` `,` before a space or the end, so "1,200" and "10:30" stay whole, and `¿` `¡` and the full-width marks anywhere) and at a joining word, which is dropped: in English "and", "but", "so", "because".
- **Tails.** After each clause comes its tail after each preposition in it: in English "at", "on", "in", "near", "by".
- **Each once, at most 8**, in the order said. A ninth part is not offered.

The sentence above gives three, and the slot asks `placePick` beside `placeGiven`:

> Read asr.text. Which of these parts of the caller's words is the street address, with nothing else in it?
>
> `a`: the power is out at 22 Alder Street, `b`: 22 Alder Street, `c`: nothing works, `none`: None of these is the street address

The model chooses a letter; the value is that part, "22 Alder Street", copied from the words. The model never writes the value: every part it can choose is the caller's own words, cut where code cut them. When it chooses `none`, or its choice is below `SLOT_DETECT`, the value is the whole words, as without `pick`. Words that make one candidate (a single clause with no preposition, "200 Heron Row") are the value as they are, and the pick question is not asked; nor is it while a value on file would be kept (`keep`). The candidates are the criteria, by letter, so a recording holds what the model was offered.

**Locales.** Words match whole, case and accents aside, and a phrase ("así que", "cerca de") matches word by word. The joining words and prepositions are the session's language's: English with no locale and in `en-*`; Spanish ("y", "e", "pero", "porque", "así que"; "en", "cerca de", "junto a") in `es-*`. A language with no built-in list splits at punctuation only, so English words never cut a French sentence. A slot gives its own for any language in `pick.words`, by language tag ("fr", or "fr-CA" for one region), each list replacing the built-in one:

```yaml
place:
  type: text
  what: where the problem is
  say: null
  redact: none
  pick:
    what: the street address
    words:
      fr: { joiners: [et, parce que], prepositions: [au, à, près de] }
```

The words live in the slot's options, not in `locale/<tag>/slots.yaml`, because they decide what the model is asked, and a locale's wording only ever changes what a slot says.

**Turning it on in an app.** `pick` adds a question to the turns the slot listens on, so the requests the model is sent change: an app that turns it on records its cassette again, and its corpus can label the part picked with the question's id and the part's words (`labels: { placePick: 22 Alder Street }`), which the fixture stub answers with that part's letter.

## Examples

The starter examples, listed below, are five configurations with starter utterances: the defaults, a courier note with its own stand-in and length, a slot keeping its recorded wording and id (`text.given`, `ids.given`), a phrase shown as said, and an address picked out of the words (`pick`). In an app's `slots.yaml`:

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

#### picking the value out of the words

pick: code splits the words into candidate parts, a second question chooses which part is the street address, and the value is that part as said. None of these, a choice below SLOT_DETECT, or words that make one candidate keep the whole words. French is split with the slot's own words; in a Spanish session an English sentence is one clause, so it keeps the whole words.

```yaml
place:
  type: text
  what: where the problem is
  say: null
  redact: none
  maxLength: 200
  pick:
    what: the street address
    words:
      fr:
        joiners:
          - et
          - parce que
        prepositions:
          - au
          - à
          - près de
```

<details><summary>Starter utterances (9)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the power is out at 22 Alder Street and nothing works | `placeGiven`: yes 0.92<br>`placePick`: `a` 0.05, `b` 0.9, `c` 0.01, `none` 0.04 | filled: value `22 Alder Street`, display `22 Alder Street`, confirm `none`, display in es `the power is out at 22 Alder Street and nothing works` |
| my lights are out at home and next door too | `placeGiven`: yes 0.7<br>`placePick`: `a` 0.04, `b` 0.06, `c` 0.02, `none` 0.88 | filled: value `my lights are out at home and next door too`, display `my lights are out at home and next door too` |
| it is near the old mill by Cedar Road | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.08, `b` 0.5, `c` 0.4, `none` 0.02 | filled: value `it is near the old mill by Cedar Road`, display `it is near the old mill by Cedar Road` |
| 200 Heron Row | `placeGiven`: yes 0.95 | filled: value `200 Heron Row`, display `200 Heron Row` |
| Yes, at 14 Birch Lane. By the school. | `placeGiven`: yes 0.93<br>`placePick`: `a` 0.01, `b` 0.1, `c` 0.85, `d` 0.01, `e` 0.01, `none` 0.02 | filled: value `14 Birch Lane`, display `14 Birch Lane` |
| sorry, one moment, the kids, the dog, the noise, okay, right, well, it is 9 Quarry Hill | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.02, `h` 0.03, `none` 0.95 | filled: value `sorry, one moment, the kids, the dog, the noise, okay, right, well, it is 9 Quarry Hill`, display `sorry, one moment, the kids, the dog, the noise, okay, right, well, it is 9 Quarry Hill` |
| se fue la luz en la calle Alder 22 y nada funciona<br>_locale es_ | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.06, `b` 0.9, `c` 0.01, `none` 0.03 | filled: value `la calle Alder 22`, display `la calle Alder 22` |
| la panne est au 22 rue Alder et rien ne marche<br>_locale fr_ | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.05, `b` 0.91, `c` 0.01, `none` 0.03 | filled: value `22 rue Alder`, display `22 rue Alder` |
| the lights flicker at night | `placeGiven`: yes 0.2<br>`placePick`: `a` 0.1, `b` 0.1, `none` 0.8 | absent |

</details>

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- Without `pick`, the value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence. With `pick`, it is the part the model chooses among those code found.
- The candidates are cut by words, not by meaning: a joining word inside a value splits it too ("the corner of Elm and Third" offers "the corner of Elm" and "Third"). Then the model chooses none, and the value is the whole words.
- In another locale the stand-in can be that locale's: `locale/<tag>/slots.yaml` gives `say: <stand-in>` for the slot. The words themselves are the caller's, in whatever language they spoke. A slot whose display is the words (`say: null`) takes none.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

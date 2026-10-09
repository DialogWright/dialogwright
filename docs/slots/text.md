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
| `pick` | map | unset | Pick the value out of the words. Code splits the caller's words into candidate parts (clauses, split at punctuation and at joining words, and each clause's tail after a preposition; then two clauses side by side joined as said, and that join's tails; at most 8 of these; then the tails from each word of a clause or a join to its end, of 2 words or more, the shortest kept, so a value after any lead-in can be chosen; each verbatim, at most 16 in all), and a second question (`ids.pick`, default `<slot>Pick`) asks which of them is `pick.what`, by letter, or none of these. The value is the part chosen, as said; none, a choice below SLOT_DETECT, or words that make one candidate keep the whole words. Default: off, the value is the whole words and only the one question is asked. |
| `pick.what` | string | required | What the value is, as a noun phrase the pick question names ("the street address"). |
| `pick.words` | map of map | unset | The joining words and prepositions by language tag ("fr", or "fr-CA" for one region, whose missing list is the language's), for a language with no built-in list or to replace one. Built in: English ("and", "but", "so", "because"; "at", "on", "in", "near", "by", "for"), also read with no locale, and Spanish ("y", "e", "pero", "porque", "así que"; "en", "cerca de", "junto a"). A language with neither splits at punctuation only. |
| `pick.words.<key>.joiners` | list of string | unset | Words or phrases that join two clauses, where the words are split ("et", "parce que"). Replaces the built-in list of the language. |
| `pick.words.<key>.prepositions` | list of string | unset | Words or phrases after which a clause's tail is offered too ("au", "près de"). Replaces the built-in list of the language. |
| `numbers` | one of `words`, `digits` | `words` | How the value writes the numbers the caller says in words. "words": as said. "digits": code writes each run of number words as digits ("seventy six twenty five oak hollow lane" is "7625 oak hollow lane", "one zero two four six" is "10246", "one oh two" is "102"); ordinals stay words ("fifth avenue", "twenty third street"), and so do digits already said. The value (a tool's param, the gate, the audit, the console) is written; with say: null the display, which a line reads back, stays the words as said, since text-to-speech reads "7625" as a quantity. With pick, the part picked is written. Only in a language with rules: English, also read with no locale; another keeps the words as said. |
| `case` | one of `as-said`, `title` | `as-said` | How the value writes the case of the words. "as-said": as the recognizer or the caller wrote them. "title": words written with no capital at all (a recognizer that writes none) have each word capitalized, but for minor words after the first ("7625 oak hollow lane" is "7625 Oak Hollow Lane"); words with any capital stay as they are. The value only: with say: null the display stays the words as said. Only in a language with rules: English, also read with no locale. |
| `confirm` | one of `summary`, `always` | unset | "summary" (the default): the words are neither acknowledged nor read back on their own; the form's final confirm covers them. "always": what the caller said is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, pick, pickNone. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, pick), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller gives the text, word for word. Variables: `{what}`, `{instructions}`. | `Read asr.text. Does the caller give {what}? A request alone is not {what}.{instructions}` |
| `text.pick` | With `pick`: the question that asks which of the candidate parts is the value; {what} is pick.what. Variables: `{what}`. | `Read asr.text. Which of these parts of the caller's words is the whole of {what}, with nothing else in it?` |
| `text.pickNone` | With `pick`: what the pick question's "none" label means, which keeps the whole words; {what} is pick.what. Variables: `{what}`. | `None of these is {what}` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller gives the text. |
| `ids.pick` | The id of the question that asks which part of the caller's words is the value (with `pick`). |

The slot is `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`, but for `confirm_<slot>` with `confirm: always`. It is read back in the final summary and not on its own (`confirm: summary`, the default), since the stand-in says nothing a caller could correct; with `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person. A read-back says the display, so `confirm: always` needs `say: null` (with `redact: none`), the words themselves: with a stand-in the caller would hear "your description?", and `dialogwright check` refuses it.

## The question

With `what: a description of the problem` on the slot `problem`, the question is `problemGiven`:

> Read asr.text. Does the caller give a description of the problem? A request alone is not a description of the problem.

With `instructions`, its words follow, after a space.

## Picking the value out of the words

A caller rarely says only the value. Asked where the outage is, they say "the power is out at 22 Alder Street and nothing works", and without `pick` that whole sentence is the value. With `pick: { what: the street address }` on the slot `place`, code splits the words into candidate parts, each copied as said:

- **Clauses.** The words are split at punctuation (a mark that ends a clause in any script, such as `.` `!` `?` `;` `:` `,` or `…`, before a space or the end, so "1,200" and "10:30" stay whole; and `¿` `¡` and the full-width marks anywhere) and at a joining word, which is dropped: in English "and", "but", "so", "because". A word with an apostrophe or a hyphen inside it is one word ("O'Neil", "rock-and-roll").
- **Tails.** After each clause comes its tail after each preposition in it: in English "at", "on", "in", "near", "by", "for" ("an outage for 22 Alder Street").
- **Joined clauses.** Then, for two clauses side by side with only a joining word between them (no punctuation), the two together as said, followed by the tails of that join that start in the first clause. A joining word can sit inside a value: "meet me at the corner of Elm and Third, by the bank" offers "the corner of Elm" and "Third", and then "meet me at the corner of Elm and Third" and "the corner of Elm and Third". Only two clauses are joined at a time ("Elm and Third and Main" offers "Elm and Third" and "Third and Main", never all three).
- **Each once, at most 8**, in that order: every clause and tail first, in the order said, then the joined parts, in the order said. So a joined part never pushes a clause or a tail out of the 8, and never moves one to another letter.
- **Tails from each word.** Then, up to 16 candidates in all, the tails from each word: from each word of a clause to the clause's end, and from each word of the first of two joined clauses to the second's end, each of two spoken words or more and not offered already. A recognizer gives no punctuation and a caller's lead-in is anything ("yeah my address is", "it's", "the address would be", or any other language), so no word list can cut it off; a tail from each word does. "yeah my address is seventy six twenty five oak hollow lane" has no preposition and no punctuation, and offers "seventy six twenty five oak hollow lane" among its tails. A tail starts only after a space, so "1,200" and "10:30" are never cut inside. When there are more tails than room, a clause's are kept before a join's, and the shortest first: the value is mostly said last, so the tails dropped are the longest, which start near the start of a long clause that is offered whole anyway. They are given in the order said, the longest of each clause first. A word alone is not a tail ("lane" is mostly the end of a longer value); nor is a span that stops before the clause's end, so a value with an aside after it and nothing to cut at ("... lane I think") is not offered alone: the model chooses none, and the value is the whole words. A script written without spaces between words (Chinese, Japanese, Thai) has no tails from each word.

The sentence above gives sixteen, and the slot asks `placePick` beside `placeGiven`:

> Read asr.text. Which of these parts of the caller's words is the whole of the street address, with nothing else in it?
>
> `a`: the power is out at 22 Alder Street, `b`: 22 Alder Street, `c`: nothing works, `d`: the power is out at 22 Alder Street and nothing works, `e`: 22 Alder Street and nothing works, `f`: power is out at 22 Alder Street, `g`: is out at 22 Alder Street, `h`: out at 22 Alder Street, `i`: at 22 Alder Street, `j`: Alder Street, `k`: power is out at 22 Alder Street and nothing works, `l`: is out at 22 Alder Street and nothing works, `m`: out at 22 Alder Street and nothing works, `n`: at 22 Alder Street and nothing works, `o`: Alder Street and nothing works, `p`: Street and nothing works, `none`: None of these is the street address

Since the tails nest ("Alder Street" is inside "22 Alder Street"), the question asks for the whole of the value: the model chooses the part that holds all of it and nothing else.

The model chooses a letter; the value is that part, "22 Alder Street", copied from the words. The model never writes the value: every part it can choose is the caller's own words, cut where code cut them. When it chooses `none`, or its choice is below `SLOT_DETECT`, the value is the whole words, as without `pick`. Words that make one candidate (a single clause of two words or fewer with no preposition, "Heron Row") are the value as they are, and the pick question is not asked; nor is it while a value on file would be kept (`keep`). The candidates are the criteria, by letter, so a recording holds what the model was offered.

**Locales.** Words match whole, case and accents aside, and a phrase ("así que", "cerca de") matches word by word. The joining words and prepositions are the session's language's: English with no locale and in `en-*`; Spanish ("y", "e", "pero", "porque", "así que"; "en", "cerca de", "junto a") in `es-*`. A language with no built-in list splits at punctuation only (its tails from each word are offered all the same), so English words never cut a French sentence. A slot gives its own for any language in `pick.words`, by language tag ("fr", or "fr-CA" for one region), each list replacing the built-in one; a list a region's entry leaves out is its language's entry's, then the built-in one:

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

**Turning it on in an app.** `pick` adds a question to the turns the slot listens on, so the requests the model is sent change: an app that turns it on records its cassette again, and its corpus can label the part picked with the question's id and the part's words (`labels: { placePick: 22 Alder Street }`), which the fixture stub answers with that part's letter. A letter itself is read as the letter; words that name two parts but for case (said "Elm Park" and "elm park") must be written as said.

## Writing the value: numbers and case

A recognizer on the phone gives numbers as words: "seventy six twenty five oak hollow lane", "one zero two four six aspen glade lane". A tool wants "7625 Oak Hollow Lane". With `numbers: digits` (and `case: title`), code writes the value from the words, and the display stays the words as said:

```yaml
place:
  type: text
  what: the street address where the power problem is
  say: null
  redact: none
  numbers: digits
  case: title
  pick: { what: the street address }
```

- **The value** is written: "7625 Oak Hollow Lane". It is what a tool's param of the same name, the gate (and the hash of the values the caller confirmed, which a form's `confirmedParams` takes from the values, as its write does), the audit, the trace, the console and a handoff get.
- **The display** of a slot shown as said (`say: null`) is the words as the caller said them: "seventy six twenty five oak hollow lane". A line that reads the slot back (`{place}` in a summary) says it, since text-to-speech reads "7625" as a quantity ("seven thousand six hundred twenty five"), not as the caller grouped it. The model's turn state holds the display too, so the requests the model is sent are the same as without the options. Such a slot is `displayFrom: 'said'`: a locale switch keeps its display, since `display(value)` cannot give the words back. With a stand-in (`say: your address`), the display is the stand-in as ever.
- **Code writes it, never the model.** The model chooses a part of the words (`pick`) or keeps them whole, as before; the rules below then rewrite that part. With `pick`, the part picked is written; with no pick, or none chosen, the whole words are.

`numbers: digits`, in English: each run of number words (side by side, with only spaces or a hyphen between them) becomes one string of digits, and the numbers in a run concatenate.

| Said | Written |
|---|---|
| one zero two four six | 10246 |
| one oh two; nineteen oh five | 102; 1905 |
| seventy six twenty five; seven six twenty five | 7625 |
| eighty six; twelve | 86; 12 |
| twenty five hundred; two thousand four | 2500; 2004 |
| one hundred twenty three; one hundred and five; a hundred | 123; 105; 100 |
| unit four at twenty two alder street | unit 4 at 22 alder street |
| twenty third street; fifth avenue | (as said: ordinals stay words) |
| seventy six twenty third street | 76 twenty third street |
| one hundred first street | (as said: which part is the house number is not clear) |
| 22 alder street; oh I see; five and six | 22 alder street; oh I see; 5 and 6 |

"oh" and "o" are a zero only between two number words; "a" is one only before "hundred" or "thousand", and "and" is part of a number only after one of them, so "the corner of Elm and Third" is unchanged. Digits already said stay, and every other character is kept. A run the rules cannot read whole stays words. Since the rules run on the slot's value only, which `pick` cuts to the part that is the value, "one" in prose is written too ("one main street" is "1 main street").

`case: title`, in English: words written with no capital at all (a recognizer that writes none) have each word capitalized, but for minor words after the first ("the corner of elm and third" is "The Corner of Elm and Third"). Words with any capital were cased by the recognizer or the caller, and stay as they are. It is a separate option because it is a separate choice: a recognizer that writes capitals needs only `numbers`, and a note or a reason (not a name or an address) should keep its case.

**Languages.** The rules are English's, read with no locale and in `en-*` (`WRITTEN_RULES` in `written.ts`, one entry per language: `digits` and `title`). In a language with no rules the value is the words as said, whatever the options, so English number words never change a Spanish sentence. A language is added there, with its tests.

**Turning it on in an app.** The model's requests do not change, so a recorded cassette still replays. The baseline does, wherever a slot's value had number words or was all lower case: edit those values by hand, and say why.

## Examples

The starter examples, listed below, are six configurations with starter utterances: the defaults, a courier note with its own stand-in and length, a slot keeping its recorded wording and id (`text.given`, `ids.given`), a phrase shown as said, an address picked out of the words (`pick`), and an address written as digits (`numbers`, `case`). In an app's `slots.yaml`:

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

pick: code splits the words into candidate parts, a second question chooses which part is the street address, and the value is that part as said. Two clauses side by side are offered joined as said too, so the corner of Elm and Third can be picked whole; then each clause's tails from each word, so an address after any lead-in ("yeah my address is") can be picked, and one past the eighth clause too. None of these, a choice below SLOT_DETECT, or words that make one candidate keep the whole words. French is split with the slot's own words.

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

<details><summary>Starter utterances (11)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the power is out at 22 Alder Street and nothing works | `placeGiven`: yes 0.92<br>`placePick`: `a` 0.05, `b` 0.9, `c` 0.01, `none` 0.04 | filled: value `22 Alder Street`, display `22 Alder Street`, confirm `none` |
| yeah my address is twelve oak hollow road | `placeGiven`: yes 0.93<br>`placePick`: `a` 0.02, `b` 0.01, `c` 0.01, `d` 0.02, `e` 0.88, `f` 0.04, `g` 0.01, `none` 0.01 | filled: value `twelve oak hollow road`, display `twelve oak hollow road` |
| my lights are out at home and next door too | `placeGiven`: yes 0.7<br>`placePick`: `a` 0.04, `b` 0.06, `c` 0.02, `none` 0.88 | filled: value `my lights are out at home and next door too`, display `my lights are out at home and next door too` |
| it is near the old mill by Cedar Road | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.08, `b` 0.5, `c` 0.4, `none` 0.02 | filled: value `it is near the old mill by Cedar Road`, display `it is near the old mill by Cedar Road` |
| 200 Heron Row | `placeGiven`: yes 0.95 | filled: value `200 Heron Row`, display `200 Heron Row` |
| Yes, at 14 Birch Lane. By the school. | `placeGiven`: yes 0.93<br>`placePick`: `a` 0.01, `b` 0.1, `c` 0.85, `d` 0.01, `e` 0.01, `none` 0.02 | filled: value `14 Birch Lane`, display `14 Birch Lane` |
| sorry, one moment, the kids, the dog, the noise, okay, right, well, it is 9 Quarry Hill | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.02, `h` 0.01, `i` 0.03, `k` 0.9, `none` 0.04 | filled: value `9 Quarry Hill`, display `9 Quarry Hill` |
| se fue la luz en la calle Alder 22 y nada funciona<br>_locale es_ | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.06, `b` 0.9, `c` 0.01, `none` 0.03 | filled: value `la calle Alder 22`, display `la calle Alder 22` |
| meet me at the corner of Elm and Third, by the bank | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.02, `b` 0.05, `c` 0.01, `d` 0.01, `e` 0.01, `f` 0.04, `g` 0.84, `none` 0.02 | filled: value `the corner of Elm and Third`, display `the corner of Elm and Third` |
| la panne est au 22 rue Alder et rien ne marche<br>_locale fr_ | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.05, `b` 0.91, `c` 0.01, `none` 0.03 | filled: value `22 rue Alder`, display `22 rue Alder` |
| the lights flicker at night | `placeGiven`: yes 0.2<br>`placePick`: `a` 0.1, `b` 0.1, `none` 0.8 | absent |

</details>

#### an address written as digits

A street address a recognizer gives in words. Code writes the value (numbers as digits, words in lower case capitalized) from the part picked; a line reads back the words as said, since text-to-speech reads "7625" as a quantity. The model is asked what it is asked without these options.

```yaml
place:
  type: text
  what: the street address where the problem is
  say: null
  redact: none
  maxLength: 200
  numbers: digits
  case: title
  pick:
    what: the street address
```

<details><summary>Starter utterances (6)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| yeah my address is seventy six twenty five oak hollow lane | `placeGiven`: yes 0.93<br>`placePick`: `a` 0.02, `b` 0.01, `c` 0.01, `d` 0.02, `e` 0.88, `f` 0.04, `none` 0.02 | filled: value `7625 Oak Hollow Lane`, display `seventy six twenty five oak hollow lane`, confirm `none`, display in es `seventy six twenty five oak hollow lane` |
| one zero two four six aspen glade lane | `placeGiven`: yes 0.9<br>`placePick`: `a` 0.9, `none` 0.1 | filled: value `10246 Aspen Glade Lane`, display `one zero two four six aspen glade lane` |
| it's nineteen oh five twenty third street | `placeGiven`: yes 0.9<br>`placePick`: `b` 0.9, `none` 0.1 | filled: value `1905 Twenty Third Street`, display `nineteen oh five twenty third street` |
| 22 Alder Street | `placeGiven`: yes 0.95 | filled: value `22 Alder Street`, display `22 Alder Street` |
| se fue la luz en la calle Alder veintidós<br>_locale es_ | `placeGiven`: yes 0.9<br>`placePick`: `b` 0.9, `none` 0.1 | filled: value `la calle Alder veintidós`, display `la calle Alder veintidós` |
| the lights flicker at night | `placeGiven`: yes 0.2 | absent |

</details>

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- Without `pick`, the value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence. With `pick`, it is the part the model chooses among those code found.
- The candidates are cut by words, not by meaning. A joining word inside a value is covered by the joined parts, but only for two clauses side by side with no punctuation between them; a value that spans punctuation ("5 St. James Place", where "St." ends a clause) or three clauses is not offered whole. Then the model chooses none, and the value is the whole words.
- In another locale the stand-in can be that locale's: `locale/<tag>/slots.yaml` gives `say: <stand-in>` for the slot. The words themselves are the caller's, in whatever language they spoke. A slot whose display is the words (`say: null`) takes none.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

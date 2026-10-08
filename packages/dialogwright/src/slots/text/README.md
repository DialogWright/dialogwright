# `text`

The caller's own words, kept as said: a description of a problem, a note for a courier, a reason for a request.

One yes-or-no question asks whether the caller gives the text. When the model says yes (at `SLOT_DETECT` or above), the value is the caller's words on that turn, trimmed and cut to `maxLength`. The model never writes or rewrites the value. A summary reads the slot back by a stand-in (`say`, "your description"), and by default the words leave the turn (the trace, a tool call's param of the same name) as their length only.

With `pick`, the value is the part of the words that is the value, picked out rather than written: code splits the words into candidate parts, a second question asks which of them is the value, and the value is that part, as said (see "Picking the value out of the words").

Reach for it for a value no list holds and no code can check. For a number, a date, a name or a choice from a list, use the type made for it: those check what they hear.

## Options

<!-- slot-docs:options -->

The slot is `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`, but for `confirm_<slot>` with `confirm: always`. It is read back in the final summary and not on its own (`confirm: summary`, the default), since the stand-in says nothing a caller could correct; with `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), and a second no goes to a person.

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

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- Without `pick`, the value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence. With `pick`, it is the part the model chooses among those code found.
- The candidates are cut by words, not by meaning. A joining word inside a value is covered by the joined parts, but only for two clauses side by side with no punctuation between them; a value that spans punctuation ("5 St. James Place", where "St." ends a clause) or three clauses is not offered whole. Then the model chooses none, and the value is the whole words.
- In another locale the stand-in can be that locale's: `locale/<tag>/slots.yaml` gives `say: <stand-in>` for the slot. The words themselves are the caller's, in whatever language they spoke. A slot whose display is the words (`say: null`) takes none.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

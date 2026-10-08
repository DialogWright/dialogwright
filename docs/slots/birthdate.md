# `birthdate`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/birthdate/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

A caller's date of birth: a month, a day and a year, heard whole or in part.

The model never writes the date. It answers four questions about the caller's words: is a birth date stated, which month (one of the twelve, or none), which day of the month (1 to 31, or none), and which span of the words is the year (the engine finds the candidate spans, the model picks one). The code turns the year's span into a year ("seventy five" becomes 1975, the last such year before today), puts the three together, and checks that the day exists and is in the past. So the value is always a day the caller said, and the code, not the model, says whether it is one.

A month and day without the year are held as the slot's partial value, and the year is asked for on its own (`yearPrompt`). The caller may answer with the year alone or restate the whole date; all four questions are asked either way, and only the year question changes to say what was asked.

Reach for it for a date of birth asked to know or to verify who is calling. For any other date (an appointment, a delivery, the day something happened), use the type made for dates.

## Options

A slot of this type is written under its id in slots.yaml, with `type: birthdate` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `keypad` | boolean | `false` | Whether the caller can key the date on the keypad as eight digits, month, day and year (MMDDYYYY), or in a day-first locale (Spanish) day, month and year (DDMMYYYY). Needs an `ask_<slot>_dtmf` line. |
| `yearPrompt` | string | unset | The prompt that asks for the year alone once a month and day are heard without it (the slot's partialPromptId). Default: `ask_<slot>_year.` |
| `wholePrompt` | string | unset | The prompt that asks for the whole date again when a month or a day was not heard; the outcome is invalid, with the reason no_month_day, no_month or no_day. Absent: the outcome is invalid with the reason no_year and the slot's generic retry asks again. |
| `minYear` | integer, 1 or more | `1900` | The earliest year a date of birth may be in. An earlier one is invalid (reason impossible), and the keypad refuses it. |
| `notThisDate` | string | unset | Another date the caller is likely to mention, which the birth date is not, as a noun phrase ("an appointment date", "the date of the order"). The default month and day questions then say "This is the birth date, not `<it>.`", and the default "false" criterion names it. |
| `redact` | one of `mask`, `none` | `mask` | How the value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name): "mask" keeps the year only ("••/••/1985"); "none" keeps it as it is. |
| `handoff` | one of `display`, `verified` | `display` | What a transfer to a person hands over: the date as it is said ("display"), or, for a birth date asked to verify identity, only whether the caller was "verified". app.yaml's handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked. |
| `confirm` | one of `summary`, `always` | `summary` | "summary": a birth date is neither acknowledged nor read back on its own; the form's final confirm covers it. "always": the birth date is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung where the slot takes keys), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, givenTrue, givenFalse, month, monthHint, day, dayHint, year, yearAsked, yearNone. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, month, day, year), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller states their date of birth at all. | `Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)?` |
| `text.givenTrue` | What a yes to the first question means (its "true" criterion). | `The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year` |
| `text.givenFalse` | What a no to the first question means (its "false" criterion). By default it names `notThisDate`, when given, and someone else's birth date. Variables: `{others}`. | `No birth date. {others} is not the caller's date of birth` |
| `text.month` | The question that asks which month the birth date is in. Its choices are the twelve months and none. By default it ends with the `notThisDate` sentence and `monthHint`. Variables: `{notThis}`, `{hint}`. | `Read asr.text. Which month is the caller's date of birth in, if they say one?{notThis}{hint}` |
| `text.monthHint` | A sentence the default month question ends with, such as how a month said as a number is read. Default: none. | none (empty) |
| `text.day` | The question that asks which day of the month the birth date is. Its choices are 1 to 31 and none. By default it ends with the `notThisDate` sentence and `dayHint`. Variables: `{notThis}`, `{hint}`. | `Read asr.text. Which day of the month is the caller's date of birth, if they say one?{notThis}{hint}` |
| `text.dayHint` | A sentence the default day question ends with, such as which number of a date said as numbers is the day. Default: none. | none (empty) |
| `text.year` | The question that asks which span of the caller's words is the year, when no month and day are on hand. Its choices are the spans the engine finds, and none. | `Read asr.text. Which of these spans is the year of the caller's birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.` |
| `text.yearAsked` | The year question in place of `year` while a month and day are on hand, so the caller was just asked for the year alone (they may still restate the whole date). | `Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.` |
| `text.yearNone` | What the year question's "none" choice means. | `No span of asr.text is a year of the caller's birth` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller states their date of birth. |
| `ids.month` | The id of the question that asks which month the date of birth is in. |
| `ids.day` | The id of the question that asks which day of the month the date of birth is. |
| `ids.year` | The id of the question that asks which span of the caller's words is the year of birth. |

The slot is always `detect: true` (its row in the console is measured against `SLOT_DETECT`) and `valueKind: date`: when the caller was asked for their birth date and another date-valued slot hears the same month and day on that turn, the engine drops the other slot's reading, so a birthday is never also taken as some other day.

## The outcome

| What the caller said | The outcome |
|---|---|
| No birth date (the first question is below `SLOT_DETECT`) | `absent`, so a turn about something else leaves the slot alone |
| None of the month, the day and the year heard this turn (each counts at `SLOT_CHOICE_CONFIRM` or above) | `absent`: an answer nothing can be read from is not progress |
| A month or a day missing, with nothing pending to supply it | `invalid`: `no_year`, or with `wholePrompt` `no_month_day`, `no_month` or `no_day` and that prompt as its re-ask |
| A month and day, no year | `window`: the partial `{ kind: dob, month, day }`, and `yearPrompt` asks for the year |
| A year before `minYear` | `invalid`, reason `impossible`, raw the year |
| No such day (February 30th) | `invalid`, reason `impossible`, raw `year-month-day` as heard |
| Today or a later day | `invalid`, reason `future`, raw the ISO date (so the engine can still tell which day was heard) |
| A real day in the past | `filled`: the value is the ISO date (1975-06-14), the display says it as a birthday ("June 14th, 1975"), and nothing is read back on its own (with `confirm: always`, it is read back for a yes) |

A month or a day not heard this turn is taken from the pending partial, so "seventy five" after "June fourteenth" fills June 14th, 1975, and "July, seventy five" fills July 14th, 1975. The confidence of a fill is the least of the parts heard this turn.

The keypad takes eight digits that make a real day from `minYear` up to yesterday, and nothing else.

## The questions

On the slot `dob`, the questions are `dobGiven`, `dobMonth`, `dobDay` and `dobYear`. Each is made of text parts, and `text.<part>` replaces a part word for word (the defaults are listed under Text parts, after the options table).

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. The month question's choices are the twelve months and `none`; the day's are 1 to 31 and `none`; the year's are the spans the engine found in the caller's words, and `none`, which means `yearNone`. `yearAsked` takes the place of `year` while a month and day are pending.

A hint is the place for how a date said as numbers is read ("A date said as numbers is month first, then day, then year."), which matters when callers say "six fourteen seventy five".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. Always `yearPrompt` (default `ask_<slot>_year`). With `wholePrompt`, that line. With `keypad`, `ask_<slot>_dtmf`. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung with `keypad`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person. `dialogwright check` requires each in every locale.

## Examples

The starter examples, listed below, are three configurations with starter utterances and keypad keys: an account holder's birth date on the defaults with the keypad on, a library patron's birth date beside the date a book is due (with hints, a whole-date re-ask, a later `minYear` and a verified handoff), and a slot keeping the ids, the year prompt and the year wording it was recorded with. In an app's `slots.yaml`:

```yaml
dob:
  type: birthdate
  keypad: true
  notThisDate: the date a book is due
  wholePrompt: ask_dob_whole
  text:
    monthHint: "A date said as numbers is month first, then day, then year."
    dayHint: "A date said as numbers is month first, then day, then year."
```

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### account holder

The defaults, with the keypad on (MMDDYYYY; DDMMYYYY in Spanish). A month and day without the year are held, and the year is asked for alone (ask_dob_year); a month or a day missing is "no_year", and the generic retry asks again.

```yaml
dob:
  type: birthdate
  keypad: true
```

<details><summary>Starter utterances (9)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| I was born June fourteenth nineteen seventy five | `dobGiven`: yes 0.96<br>`dobMonth`: `june` 0.95, `none` 0.05<br>`dobDay`: `14` 0.93, `none` 0.07<br>`dobYear`: `nineteen seventy five` 0.92, `none` 0.08 | filled: value `1975-06-14`, display `June 14th, 1975`, confirm `none` |
| nací el catorce de junio de mil novecientos setenta y cinco<br>_locale es_ | `dobGiven`: yes 0.96<br>`dobMonth`: `june` 0.95, `none` 0.05<br>`dobDay`: `14` 0.93, `none` 0.07<br>`dobYear`: `mil novecientos setenta y cinco` 0.92, `none` 0.08 | filled: value `1975-06-14`, display `14 de junio de 1975`, confirm `none` |
| setenta y cinco<br>_prompted; locale es-US; window {"kind":"dob","month":6,"day":14}_ | `dobGiven`: yes 0.88<br>`dobMonth`: `none` 0.9<br>`dobDay`: `none` 0.9<br>`dobYear`: `setenta y cinco` 0.9, `none` 0.1 | filled: value `1975-06-14`, display `14 de junio de 1975` |
| it's June fourteenth | `dobGiven`: yes 0.9<br>`dobMonth`: `june` 0.94, `none` 0.06<br>`dobDay`: `14` 0.92, `none` 0.08<br>`dobYear`: `none` 0.97 | window |
| seventy five<br>_prompted; window {"kind":"dob","month":6,"day":14}_ | `dobGiven`: yes 0.88<br>`dobMonth`: `none` 0.9<br>`dobDay`: `none` 0.9<br>`dobYear`: `seventy five` 0.9, `none` 0.1 | filled: value `1975-06-14`, display `June 14th, 1975` |
| I'd like to update my mailing address | `dobGiven`: yes 0.03<br>`dobMonth`: `none` 0.99<br>`dobDay`: `none` 0.99<br>`dobYear`: `none` 0.99 | absent |
| nineteen seventy five | `dobGiven`: yes 0.8<br>`dobMonth`: `none` 0.9<br>`dobDay`: `none` 0.9<br>`dobYear`: `nineteen seventy five` 0.9, `none` 0.1 | invalid: reason `no_year` |
| February thirtieth nineteen ninety | `dobGiven`: yes 0.9<br>`dobMonth`: `february` 0.9, `none` 0.1<br>`dobDay`: `30` 0.9, `none` 0.1<br>`dobYear`: `nineteen ninety` 0.9, `none` 0.1 | invalid: reason `impossible`, raw `1990-2-30` |
| October second twenty thirty | `dobGiven`: yes 0.9<br>`dobMonth`: `october` 0.9, `none` 0.1<br>`dobDay`: `2` 0.9, `none` 0.1<br>`dobYear`: `twenty thirty` 0.9, `none` 0.1 | invalid: reason `future`, raw `2030-10-02` |

</details>

<details><summary>Keypad (6)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `06141975` | any | `1975-06-14`, said `June 14th, 1975` |
| `14061975` | es | `1975-06-14`, said `14 de junio de 1975` |
| `06141975` | es | no value |
| `02301990` | any | no value |
| `10022030` | any | no value |
| `06141875` | any | no value |

</details>

#### library patron

A birth date asked to confirm who a patron is, beside the date a book is due. The month and day questions say which date this is not, and give a hint for a date said as numbers; a month or a day missing asks for the whole date again; a transfer hands over only whether the patron was verified.

```yaml
patronBirth:
  type: birthdate
  keypad: true
  notThisDate: the date a book is due
  wholePrompt: ask_patronBirth_whole
  minYear: 1910
  handoff: verified
  text:
    monthHint: A date said as numbers is month first, then day, then year.
    dayHint: A date said as numbers is month first, then day, then year.
```

<details><summary>Starter utterances (6)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| three nine sixty two | `patronBirthGiven`: yes 0.9<br>`patronBirthMonth`: `march` 0.9, `none` 0.1<br>`patronBirthDay`: `9` 0.88, `none` 0.12<br>`patronBirthYear`: `sixty two` 0.91, `none` 0.09 | filled: value `1962-03-09`, display `March 9th, 1962`, confirm `none` |
| the ninth, nineteen sixty two | `patronBirthGiven`: yes 0.85<br>`patronBirthMonth`: `none` 0.8, `march` 0.2<br>`patronBirthDay`: `9` 0.9, `none` 0.1<br>`patronBirthYear`: `nineteen sixty two` 0.9, `none` 0.1 | invalid: reason `no_month`, retryPromptId `ask_patronBirth_whole` |
| March, I think | `patronBirthGiven`: yes 0.8<br>`patronBirthMonth`: `march` 0.9, `none` 0.1<br>`patronBirthDay`: `none` 0.95<br>`patronBirthYear`: `none` 0.95 | invalid: reason `no_day`, retryPromptId `ask_patronBirth_whole` |
| nineteen sixty two | `patronBirthGiven`: yes 0.8<br>`patronBirthMonth`: `none` 0.95<br>`patronBirthDay`: `none` 0.95<br>`patronBirthYear`: `nineteen sixty two` 0.9, `none` 0.1 | invalid: reason `no_month_day`, retryPromptId `ask_patronBirth_whole` |
| March ninth nineteen oh five | `patronBirthGiven`: yes 0.9<br>`patronBirthMonth`: `march` 0.9, `none` 0.1<br>`patronBirthDay`: `9` 0.9, `none` 0.1<br>`patronBirthYear`: `nineteen oh five` 0.9, `none` 0.1 | invalid: reason `impossible`, raw `1905` |
| the book is due March ninth | `patronBirthGiven`: yes 0.1<br>`patronBirthMonth`: `march` 0.6, `none` 0.4<br>`patronBirthDay`: `9` 0.6, `none` 0.4<br>`patronBirthYear`: `none` 0.95 | absent |

</details>

<details><summary>Keypad (4)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `03091962` | any | `1962-03-09`, said `March 9th, 1962` |
| `09031962` | es | `1962-03-09`, said `9 de marzo de 1962` |
| `03091905` | any | no value |
| `13091962` | any | no value |

</details>

#### kept wording

A slot keeping the question ids and the year prompt it was recorded with, and its own words for the year question and its none.

```yaml
customerBirth:
  type: birthdate
  yearPrompt: ask_birth_year
  ids:
    given: givesBirthDate
    month: birthMonth
    day: birthDay
    year: birthYear
  text:
    year: Read asr.text. Which of these spans is the year of the caller's birth, if they say one? Choose none when no year is said.
    yearAsked: Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year? Choose none when no year is said.
    yearNone: No span of asr.text is the year of the caller's birth
```

<details><summary>Starter utterances (4)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| November twenty second | `givesBirthDate`: yes 0.9<br>`birthMonth`: `november` 0.9, `none` 0.1<br>`birthDay`: `22` 0.9, `none` 0.1<br>`birthYear`: `none` 0.95 | window |
| forty eight<br>_prompted; window {"kind":"dob","month":11,"day":22}_ | `givesBirthDate`: yes 0.9<br>`birthMonth`: `none` 0.95<br>`birthDay`: `none` 0.95<br>`birthYear`: `forty eight` 0.9, `none` 0.1 | filled: value `1948-11-22`, display `November 22nd, 1948` |
| cuarenta y ocho<br>_prompted; locale es; window {"kind":"dob","month":11,"day":22}_ | `givesBirthDate`: yes 0.9<br>`birthMonth`: `none` 0.95<br>`birthDay`: `none` 0.95<br>`birthYear`: `cuarenta y ocho` 0.9, `none` 0.1 | filled: value `1948-11-22`, display `22 de noviembre de 1948` |
| um, let me think<br>_prompted; window {"kind":"dob","month":11,"day":22}_ | `givesBirthDate`: yes 0.7<br>`birthMonth`: `none` 0.95<br>`birthDay`: `none` 0.95<br>`birthYear`: `none` 0.95 | absent |

</details>

## Notes

- Every slot listens on every turn, so the four questions are asked even while the form is on another slot, and "this is about my account, my birthday is June fourteenth seventy five" can fill the birth date on the opening turn.
- The partial's `kind` is `dob`, with numeric `month` and `day`: the engine reads them to tell one day heard twice, and zeroes them where the slot is redacted.
- A keyed date counts as confirmed: it is not acknowledged or read back.
- In a Spanish session (`es`, `es-*`) the display is "14 de junio de 1975", a year said in Spanish is read ("mil novecientos setenta y cinco"), the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US. The questions are otherwise the same in every locale.
- Run its checks with `pnpm --filter dialogwright test slots/birthdate`.

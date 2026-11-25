# `birthdate`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/birthdate/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

A caller's date of birth: a month, a day and a year, heard whole or in part.

The model never writes the date. It answers four questions about the caller's words: is a birth date stated, which month (one of the twelve, or none), which day of the month (1 to 31, or none), and which span of the words is the year (the engine finds the candidate spans, the model picks one). The code turns the year's span into a year ("seventy five" becomes 1975, the last such year before today), puts the three together, and checks that the day exists and is in the past. So the value is always a day the caller said, and the code, not the model, says whether it is one.

A month and day without the year are held as the slot's partial value, and the year is asked for on its own (`yearPrompt`). The caller may answer with the year alone or restate the whole date; all four questions are asked either way, and only the year question changes to say what was asked.

A date said only in numbers at the slot's own question ("oh eight two one nineteen eighty four", "eight twenty one eighty four") is read by the code from its digits, the way the keypad reads them, not from the model's month and day, which guess a month from a run of digits; a run of numbers the digits cannot read one way is asked again with an example (below, "A date said in numbers").

Reach for it for a date of birth asked to know or to verify who is calling. For any other date (an appointment, a delivery, the day something happened), use the type made for dates.

## Options

A slot of this type is written under its id in slots.yaml, with `type: birthdate` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `keypad` | boolean | `false` | Whether the caller can key the date on the keypad as eight digits, month, day and year (MMDDYYYY), or in a day-first locale (Spanish) day, month and year (DDMMYYYY). Needs an `ask_<slot>_dtmf` line. |
| `readNumbers` | boolean | `true` | Whether a date of birth said only in numbers, at the slot's own question, is read from its digits the way the keypad reads them ("oh eight two one nineteen eighty four", "eight twenty one eighty four", "08/21/1984"), in place of the model's month and day: a run the digits read one way only, a real day from `minYear` to yesterday, is the value (or a month and day alone, the partial) once the model judges a birth date is stated; any other run of numbers is not read (see `numbersExample`). A turn with a word that is not a number (a month name, "the", "first") or a year alone is the model's, as before. false: the model reads every turn. |
| `numbersExample` | boolean | `true` | Whether a date said only in numbers that gives no date (a run the digits cannot read one way, or, with `readNumbers: false`, one the model hears no date in) is asked again with an example of a date said in a way that is understood: the outcome is invalid, reason numbers_unclear, and the re-ask is `ask_<slot>_example`, which the app words (and, with `keypad`, may offer the keypad in). false: the slot's generic retry asks again. Needs an `ask_<slot>_example` line. |
| `yearPrompt` | string | unset | The prompt that asks for the year alone once a month and day are heard without it (the slot's partialPromptId). Default: `ask_<slot>_year.` |
| `wholePrompt` | string | unset | The prompt that asks for the whole date again when a month or a day was not heard; the outcome is invalid, with the reason no_month_day, no_month or no_day. Absent: the outcome is invalid with the reason no_year and the slot's generic retry asks again. |
| `minYear` | integer, 1 or more | `1900` | The earliest year a date of birth may be in. An earlier one is invalid (reason impossible), and the keypad refuses it. |
| `notThisDate` | string | unset | Another date the caller is likely to mention, which the birth date is not, as a noun phrase ("an appointment date", "the date of the order"). The default month and day questions then say "This is the birth date, not `<it>.`", and the default "false" criterion names it. |
| `redact` | one of `mask`, `none` | `mask` | How the value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name): "mask" keeps the year only ("••/••/1985"); "none" keeps it as it is. |
| `handoff` | one of `display`, `verified` | `display` | What a transfer to a person hands over: the date as it is said ("display"), or, for a birth date asked to verify identity, only whether the caller was "verified". app.yaml's handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked. |
| `confirm` | one of `summary`, `always` | `summary` | "summary": a birth date is neither acknowledged nor read back on its own; the form's final confirm covers it. "always": the birth date is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung where the slot takes keys), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, givenTrue, givenFalse, month, monthHint, day, dayHint, year, yearAsked, yearNone. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, month, day, year), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |
| `askedOf` | list of string | unset | The callers the slot is asked of: principal kinds as identity.yaml names them (the subject kind, or a delegate kind such as broker), or a delegate kind and one of its roles (broker.office_admin). For any other caller the slot is not part of its forms: its question is not sent, it is not asked, and its form completes without it (a caller not yet verified is no kind listed but anonymous, which may not be listed). Use it for what only some callers need to say, such as which client a delegate is asking about. Never on an identity factor; pnpm check refuses a kind or a role identity.yaml does not have. Default: every caller. |
| `attempts` | integer, 1 to 10 | `3` | How many failed answers the slot takes before onMaxAttempts, 1 to 10. Each failure before the last but one re-asks: a missed answer with `ask_<slot>_retry`, or `ask_<slot>_retry2` at the second failure (and so on) where prompts.yaml has it; a silence with `ask_<slot>_noinput2` (and so on), else `ask_<slot>_noinput`, else no_input then the question (`ask_<slot>`) again (at the keypad rung of a slot that takes no keys, on a channel with a keypad, no_input then its retry line). The last but one is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad, else another re-ask; the last runs onMaxAttempts. Default: the engine's MAX_ATTEMPTS (3). |
| `onMaxAttempts` | one of `handoff`, `skip` or map | `handoff` | What happens when the slot runs out of attempts (a missed answer, a silence, an unanswered read-back, or a second no to its read-back). "handoff" (the default): to a person, with handoff_max_attempts. "skip": the slot is left empty and declined, and the form goes on; never on an identity factor, nor on a slot its form's summary names. Or written out, { say, then, reason, form, goodbye }: then is handoff (reason names the handoff, default max-attempts), skip, end (say required; the call ends, the goodbye after the line unless goodbye: false), anything-else (say required; the form closes uncompleted and "anything else?" is asked) or form (the form closes uncompleted and `form` is entered, keeping the slots both list); say, a prompt said first. An offer of the caller's number with onNo: skip that runs out leaves the slot empty whatever this says; with no onNo: skip, the slot's ladder goes on to it. |

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
| Only numbers, at the slot's question, that the digits read one way only (`readNumbers`), and a birth date stated (`SLOT_DETECT`) | `filled` with that day, or `window` for a month and a day alone; the confidence is the yes-or-no's, or, where the model heard the same day, its outcome stands as it is |
| Only numbers, at the slot's question, that give no date: the digits read no day or two (or, with `readNumbers: false`, the model hears none), or the model hears no birth date stated | `invalid`, reason `numbers_unclear`, re-asked with `ask_<slot>_example` (`numbersExample`), or the generic retry with `numbersExample: false` |

A month or a day not heard this turn is taken from the pending partial, so "seventy five" after "June fourteenth" fills June 14th, 1975, and "July, seventy five" fills July 14th, 1975. The confidence of a fill is the least of the parts heard this turn.

The keypad takes eight digits that make a real day from `minYear` up to yesterday, and nothing else.

## A date said in numbers

When the slot asked its question (it is the prompted slot) and every word of the answer is a number word or a number written as digits (no month name, no "the", "it's" or "first"; "oh", "o" and "zero" are 0, "double" repeats the digit after it), the turn is a date said in numbers, unless it holds fewer than three digits or is a year alone (a four-digit year from `minYear` to this year, however it is said: "nineteen eighty four", "one nine eight four", "two thousand one"), which stay the model's to read, as the year asked for once a month and day are on hand. Such a turn is read by the code (`readNumbers`, on by default), never by the model's month and day:

- **Pieces.** Single digits said one after another run together, as the keypad's keys do ("oh eight two one"). A number from ten to ninety-nine said as one ("twenty one", "veintiuno", "ochenta y cuatro") is a piece of two digits, a number written as digits ("21", "1984", "08211984") a run of its own, and a year said with a thousand ("two thousand and one", "mil novecientos ochenta y cuatro") a year.
- **Fields.** The pieces are divided, in order, into a month, a day and a year (the day first in a day-first locale, Spanish, as its keypad takes it), or into a month and a day alone. A month or a day is one digit or two, or a number said as one; a year is two or four digits, a number said as one ("eighty four"), two of them ("nineteen eighty four"), one and "oh" and a digit ("nineteen oh five"), or a year said with a thousand. Inside a run of digits a field ends only where the keypad's would, after a pair of digits or at the run's end, except that a run of exactly two digits said one by one may be a one-digit month and a one-digit day ("three nine sixty two").
- **Reading.** Every division that makes a real day from `minYear` to yesterday counts (two digits of a year stand for the latest year that puts the day before today: "eighty four" is 1984; "twenty six" is 2026 for a day already past this year, else 1926), and so does every month and day that is a day of some year. When they all give the same reading, it is the value (a month and a day: the partial, and the year is asked for), once the model judges a birth date stated (`SLOT_DETECT`); its confidence is that judgement's. Where the model's own month, day and year give the same day, its outcome stands as it always has (its confidence the least of the parts it heard): the digits decide only where the two differ. The value is said and handled exactly as one heard any other way.
- **Not read.** No division, two readings, a number word that fits no piece ("hundred" outside a year said with a thousand, a joiner between two numbers), or no birth date stated: the outcome is `invalid`, reason `numbers_unclear`, and the caller hears `ask_<slot>_example` (`numbersExample`, on by default), a retry with an example of a date said in a way that is understood, in the app's own words; with the keypad on it may offer the keypad too, since keys are taken whenever the slot is asked. With `numbersExample: false`, the generic retry asks again.

| Said at the question | Read as |
|---|---|
| "zero eight two one one nine eight four", "08211984" | August 21st, 1984 (eight digits, MMDDYYYY) |
| "oh eight two one eight four", "082184" | August 21st, 1984 (six digits, MMDDYY) |
| "eight twenty one nineteen eighty four", "eight twenty one eighty four", "oh eight two one eighty four", "8/21/84" | August 21st, 1984 |
| "three nine sixty two" | March 9th, 1962 (a one-digit month and day) |
| "eight twenty one" | the month and day; the year is asked for |
| "eight two one eight four" | not read: five digits in a run divide only where the keypad would not (8/21/84, or 8/2/1984 with a nine missed); the example |
| "one two nineteen eighty four" | not read: January 2nd or December 19th, 1984; the example |
| "oh two three oh nineteen ninety", "oh nine one eight two oh two six" (today) | not read: no such day, or not before today; the example |
| "veintiuno ocho mil novecientos ochenta y cuatro", "dos uno cero ocho uno nueve ocho cuatro" (Spanish) | 21 de agosto de 1984 (the day first) |
| "august twenty one eighty four", "the twenty first of august", "nineteen eighty four" | the model's, as before |

With `readNumbers: false` the model reads every turn as before, and `numbersExample` answers a date said in numbers in which the model hears no value or partial. With both off, the slot is as it was before either.

A wording for the example line, in an app's `prompts.yaml` (with the keypad on; without it, end at the example):

```yaml
ask_dob_example:
  text: "Sorry, I didn't catch that date. You can say it like August twenty-first, nineteen eighty-four, or key in the eight digits."
```

In Spanish, where the keypad takes the day first: "Perdone, no entendí la fecha. Puede decirla así: veintiuno de agosto de mil novecientos ochenta y cuatro, o marcar los ocho dígitos: día, mes y año."

## The questions

On the slot `dob`, the questions are `dobGiven`, `dobMonth`, `dobDay` and `dobYear`. Each is made of text parts, and `text.<part>` replaces a part word for word (the defaults are listed under Text parts, after the options table).

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. The month question's choices are the twelve months and `none`; the day's are 1 to 31 and `none`; the year's are the spans the engine found in the caller's words, and `none`, which means `yearNone`. `yearAsked` takes the place of `year` while a month and day are pending.

A hint is the place for how a date said as numbers is read ("A date said as numbers is month first, then day, then year."), which matters when callers say "six fourteen seventy five".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. Always `yearPrompt` (default `ask_<slot>_year`). With `wholePrompt`, that line. With `keypad`, `ask_<slot>_dtmf`. With `numbersExample` (the default), `ask_<slot>_example`, the retry with an example after a date said in numbers that could not be read. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung with `keypad`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person. `dialogwright check` requires each in every locale.

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

The defaults, with the keypad on (MMDDYYYY; DDMMYYYY in Spanish). A month and day without the year are held, and the year is asked for alone (ask_dob_year); a month or a day missing is "no_year", and the generic retry asks again. A date said only in numbers at its question is read from the digits as the keypad reads them, whatever month the model guessed; a run of numbers the digits cannot read one way is asked again with an example (ask_dob_example).

```yaml
dob:
  type: birthdate
  keypad: true
```

<details><summary>Starter utterances (13)</summary>

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
| zero eight two one one nine eight four<br>_prompted_ | `dobGiven`: yes 0.9<br>`dobMonth`: `january` 0.75, `august` 0.04, `none` 0.21<br>`dobDay`: `1` 0.58, `21` 0.05, `none` 0.37<br>`dobYear`: `one nine eight four` 0.56, `none` 0.44 | filled: value `1984-08-21`, display `August 21st, 1984`, confirm `none` |
| eight twenty one eighty four<br>_prompted_ | `dobGiven`: yes 0.83<br>`dobMonth`: `august` 0.68, `none` 0.32<br>`dobDay`: `1` 0.32, `21` 0.29, `none` 0.39<br>`dobYear`: `eighty four` 0.25, `none` 0.75 | filled: value `1984-08-21`, display `August 21st, 1984` |
| eight two one eight four<br>_prompted_ | `dobGiven`: yes 0.82<br>`dobMonth`: `january` 0.7, `august` 0.04, `none` 0.26<br>`dobDay`: `1` 0.6, `21` 0.03, `none` 0.37<br>`dobYear`: `none` 0.8, `eight four` 0.2 | invalid: reason `numbers_unclear`, retryPromptId `ask_dob_example` |
| dos uno cero ocho uno nueve ocho cuatro<br>_prompted; locale es_ | `dobGiven`: yes 0.9<br>`dobMonth`: `february` 0.6, `none` 0.4<br>`dobDay`: `1` 0.5, `none` 0.5<br>`dobYear`: `none` 0.9 | filled: value `1984-08-21`, display `21 de agosto de 1984` |

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
- A keyed date counts as confirmed: it is not acknowledged or read back. A date read from numbers said is not: it is a spoken answer, confirmed as the slot's others are (by the form's summary, or with `confirm: always`, its own read-back).
- The questions are the same whether or not a turn is said in numbers: the digits change only what the slot does with the answers.
- In a Spanish session (`es`, `es-*`) the display is "14 de junio de 1975", a year said in Spanish is read ("mil novecientos setenta y cinco"), the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US. The questions are otherwise the same in every locale.
- Run its checks with `pnpm --filter dialogwright test slots/birthdate`.

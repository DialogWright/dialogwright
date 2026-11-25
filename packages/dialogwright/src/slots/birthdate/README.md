# `birthdate`

A caller's date of birth: a month, a day and a year, heard whole or in part.

The model never writes the date. It answers four questions about the caller's words: is a birth date stated, which month (one of the twelve, or none), which day of the month (1 to 31, or none), and which span of the words is the year (the engine finds the candidate spans, the model picks one). The code turns the year's span into a year ("seventy five" becomes 1975, the last such year before today), puts the three together, and checks that the day exists and is in the past. So the value is always a day the caller said, and the code, not the model, says whether it is one.

A month and day without the year are held as the slot's partial value, and the year is asked for on its own (`yearPrompt`). The caller may answer with the year alone or restate the whole date; all four questions are asked either way, and only the year question changes to say what was asked.

A date said only in numbers at the slot's own question ("oh eight two one nineteen eighty four", "eight twenty one eighty four") is read by the code from its digits, the way the keypad reads them, not from the model's month and day, which guess a month from a run of digits; a run of numbers the digits cannot read one way is asked again with an example (below, "A date said in numbers").

Reach for it for a date of birth asked to know or to verify who is calling. For any other date (an appointment, a delivery, the day something happened), use the type made for dates.

## Options

<!-- slot-docs:options -->

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

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the four questions are asked even while the form is on another slot, and "this is about my account, my birthday is June fourteenth seventy five" can fill the birth date on the opening turn.
- The partial's `kind` is `dob`, with numeric `month` and `day`: the engine reads them to tell one day heard twice, and zeroes them where the slot is redacted.
- A keyed date counts as confirmed: it is not acknowledged or read back. A date read from numbers said is not: it is a spoken answer, confirmed as the slot's others are (by the form's summary, or with `confirm: always`, its own read-back).
- The questions are the same whether or not a turn is said in numbers: the digits change only what the slot does with the answers.
- In a Spanish session (`es`, `es-*`) the display is "14 de junio de 1975", a year said in Spanish is read ("mil novecientos setenta y cinco"), the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US. The questions are otherwise the same in every locale.
- Run its checks with `pnpm --filter dialogwright test slots/birthdate`.

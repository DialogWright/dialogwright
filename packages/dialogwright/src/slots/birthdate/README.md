# `birthdate`

A caller's date of birth: a month, a day and a year, heard whole or in part.

The model never writes the date. It answers four questions about the caller's words: is a birth date stated, which month (one of the twelve, or none), which day of the month (1 to 31, or none), and which span of the words is the year (the engine finds the candidate spans, the model picks one). The code turns the year's span into a year ("seventy five" becomes 1975, the last such year before today), puts the three together, and checks that the day exists and is in the past. So the value is always a day the caller said, and the code, not the model, says whether it is one.

A month and day without the year are held as the slot's partial value, and the year is asked for on its own (`yearPrompt`). The caller may answer with the year alone or restate the whole date; all four questions are asked either way, and only the year question changes to say what was asked.

Reach for it for a date of birth asked to know or to verify who is calling. For any other date (an appointment, a delivery, the day something happened), use the type made for dates.

## Options

| Option | Default | What it does |
|---|---|---|
| `keypad` | `false` | The caller can key the date as eight digits, month, day and year (`MMDDYYYY`: 06141975). Needs an `ask_<slot>_dtmf` line. |
| `yearPrompt` | `ask_<slot>_year` | The prompt that asks for the year alone once a month and day are heard without it (the slot's `partialPromptId`). It is given no variables. |
| `wholePrompt` | none | The prompt that asks for the whole date again when a month or a day was not heard. With it, that outcome is `invalid` with the reason `no_month_day`, `no_month` or `no_day` and this prompt as its re-ask. Without it, the reason is `no_year` and the slot's generic `ask_<slot>_retry` asks again. |
| `minYear` | `1900` | The earliest year a date of birth may be in. An earlier one is `invalid` with the reason `impossible`, and the keypad refuses it. |
| `notThisDate` | none | Another date the caller is likely to mention, as a noun phrase ("an appointment date", "the date a book is due"). The default month and day questions then end with "This is the birth date, not the date a book is due.", and the default `givenFalse` criterion names it. |
| `redact` | `mask` | How the value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name): `mask` keeps the year only ("••/••/1975"), `none` keeps the date as it is. A pending month and day are masked too. |
| `handoff` | `display` | What a transfer to a person hands over: the date as it is said (`display`), or, for a birth date asked to verify identity, only whether the caller was `verified`. |
| `confirm` | `summary` | `summary`: a birth date is neither acknowledged nor read back on its own; the form's final confirm covers it. |
| `text` | none | A literal for any text part (below), sent to the model exactly as written in place of the default. One line each. |
| `ids` | none | A question id for `given`, `month`, `day` or `year` in place of `<slot>Given`, `<slot>Month`, `<slot>Day` and `<slot>Year`, to keep the ids an existing slot was recorded with. |

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
| A real day in the past | `filled`: the value is the ISO date (1975-06-14), the display says it as a birthday ("June 14th, 1975"), and nothing is read back |

A month or a day not heard this turn is taken from the pending partial, so "seventy five" after "June fourteenth" fills June 14th, 1975, and "July, seventy five" fills July 14th, 1975. The confidence of a fill is the least of the parts heard this turn.

The keypad takes eight digits that make a real day from `minYear` up to yesterday, and nothing else.

## The questions

On the slot `dob`, the questions are `dobGiven`, `dobMonth`, `dobDay` and `dobYear`. Each is made of text parts, and `text.<part>` replaces a part word for word:

| Part | Default |
|---|---|
| `given` | Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)? |
| `givenTrue` | The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year |
| `givenFalse` | No birth date. Someone else's birth date is not the caller's date of birth (with `notThisDate`: No birth date. The date a book is due, or someone else's birth date, is not the caller's date of birth) |
| `month` | Read asr.text. Which month is the caller's date of birth in, if they say one? (then the `notThisDate` sentence and `monthHint`, when there are any) |
| `monthHint` | none: a sentence the default `month` question ends with, such as how a month said as a number is read |
| `day` | Read asr.text. Which day of the month is the caller's date of birth, if they say one? (then the `notThisDate` sentence and `dayHint`, when there are any) |
| `dayHint` | none: a sentence the default `day` question ends with |
| `year` | Read asr.text. Which of these spans is the year of the caller's birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said. |
| `yearAsked` | Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said. |
| `yearNone` | No span of asr.text is a year of the caller's birth |

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. The month question's choices are the twelve months and `none`; the day's are 1 to 31 and `none`; the year's are the spans the engine found in the caller's words, and `none`, which means `yearNone`. `yearAsked` takes the place of `year` while a month and day are pending.

A hint is the place for how a date said as numbers is read ("A date said as numbers is month first, then day, then year."), which matters when callers say "six fourteen seventy five".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. Always `yearPrompt` (default `ask_<slot>_year`). With `wholePrompt`, that line. With `keypad`, `ask_<slot>_dtmf`. `dialogwright check` requires each in every locale.

## Examples

`examples.yaml` beside this file has three configurations with starter utterances and keypad keys: an account holder's birth date on the defaults with the keypad on, a library patron's birth date beside the date a book is due (with hints, a whole-date re-ask, a later `minYear` and a verified handoff), and a slot keeping the ids, the year prompt and the year wording it was recorded with. In an app's `slots.yaml`:

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

## Notes

- Every slot listens on every turn, so the four questions are asked even while the form is on another slot, and "this is about my account, my birthday is June fourteenth seventy five" can fill the birth date on the opening turn.
- The partial's `kind` is `dob`, with numeric `month` and `day`: the engine reads them to tell one day heard twice, and zeroes them where the slot is redacted.
- A keyed date counts as confirmed: it is not acknowledged or read back.
- The display is the same in every locale for now.
- Run its checks with `pnpm --filter dialogwright test slots/birthdate`.

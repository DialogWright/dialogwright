# `birthdate`

A caller's date of birth: a month, a day and a year, heard whole or in part.

The model never writes the date. It answers four questions about the caller's words: is a birth date stated, which month (one of the twelve, or none), which day of the month (1 to 31, or none), and which span of the words is the year (the engine finds the candidate spans, the model picks one). The code turns the year's span into a year ("seventy five" becomes 1975, the last such year before today), puts the three together, and checks that the day exists and is in the past. So the value is always a day the caller said, and the code, not the model, says whether it is one.

A month and day without the year are held as the slot's partial value, and the year is asked for on its own (`yearPrompt`). The caller may answer with the year alone or restate the whole date; all four questions are asked either way, and only the year question changes to say what was asked.

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

A month or a day not heard this turn is taken from the pending partial, so "seventy five" after "June fourteenth" fills June 14th, 1975, and "July, seventy five" fills July 14th, 1975. The confidence of a fill is the least of the parts heard this turn.

The keypad takes eight digits that make a real day from `minYear` up to yesterday, and nothing else.

## The questions

On the slot `dob`, the questions are `dobGiven`, `dobMonth`, `dobDay` and `dobYear`. Each is made of text parts, and `text.<part>` replaces a part word for word (the defaults are listed under Text parts, after the options table).

`given` is a yes-or-no question whose criteria are `givenTrue` and `givenFalse`. The month question's choices are the twelve months and `none`; the day's are 1 to 31 and `none`; the year's are the spans the engine found in the caller's words, and `none`, which means `yearNone`. `yearAsked` takes the place of `year` while a month and day are pending.

A hint is the place for how a date said as numbers is read ("A date said as numbers is month first, then day, then year."), which matters when callers say "six fourteen seventy five".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. Always `yearPrompt` (default `ask_<slot>_year`). With `wholePrompt`, that line. With `keypad`, `ask_<slot>_dtmf`. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` with `keypad`), and a second no goes to a person. `dialogwright check` requires each in every locale.

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
- A keyed date counts as confirmed: it is not acknowledged or read back.
- In a Spanish session (`es`, `es-*`) the display is "14 de junio de 1975", a year said in Spanish is read ("mil novecientos setenta y cinco"), the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US. The questions are otherwise the same in every locale.
- Run its checks with `pnpm --filter dialogwright test slots/birthdate`.

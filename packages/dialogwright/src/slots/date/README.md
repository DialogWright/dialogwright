# `date`

A calendar day, ahead or back: an appointment, a delivery, the day something happened.

The model never writes the date. It answers a question about how the caller refers to the day (the mode: a relative day such as "tomorrow", a weekday, a month and a day of the month, or, with `windows`, a span of days such as "next week") and a choice for each part a day can be named by: the relative day, the weekday, the month (one of the twelve, or none), the day of the month (1 to 31, or none), and with their options "this" or "next" before a weekday and the span. The code resolves the parts against today for the slot's `range`, so the value is always a real day in range, and the code, not the model, says which one.

Ahead (`range: future`), "Tuesday" is the next Tuesday, "October fifth" this year's (or next year's once it is more than a month gone), and "the day after tomorrow" two days on. Back (`range: past`), "Tuesday" is the last Tuesday (a week back when today is a Tuesday), "the fifth" the last fifth of a month, "October fifth" the last October fifth, and nothing more than two years back counts.

With `windows`, a span of days ("next week", "in December") is held as the slot's partial value and the `narrowPrompt` asks which day in it; a weekday said next is looked for inside the span ("Wednesday" after "December" is the first Wednesday in December), and a span said with a weekday ("Tuesday of next week") is that day at once.

Reach for it for any day a caller names that is not their date of birth (use `birthdate` for that).

## Options

<!-- slot-docs:options -->

The slot is always `valueKind: date`: when the caller was asked for another date-valued slot (a birth date) and this slot hears the same month and day on that turn, the engine drops this slot's reading, so a birthday is never also taken as this day.

## The outcome

| What the caller said | The outcome |
|---|---|
| No day (the mode is none, below `SLOT_CHOICE_CONFIRM`, or not answered at all) | `whenUnsaid` |
| A day that does not resolve (February 30th; a month without a day and no `windows`; back, more than two years ago) | `whenUnresolved` |
| A span of days, with `windows` | `window`: `{ kind: window, start, end, label }` (ISO days and the span's label), and `narrowPrompt` asks which day |
| A day below the `fillAt` threshold | `fill`: `whenUnresolved`; `confirm`: `invalid`, reason `low_confidence`, raw the ISO day |
| A weekday while a span is pending, with no such day left in it | `invalid`, reason `outside_window`, raw the day first resolved |
| A day | `filled`: the value is the ISO date (2026-09-22), the display says it ("Tuesday, September 22"), and `confirm`/`readBack` say whether it is acknowledged, or (`confirm: always`) read back for a yes |

The confidence of a fill is the least of the parts the resolver read: the mode and the part it names (and the qualifier, when one is said; the span and the weekday, for a weekday picked out of a span).

The keypad takes four digits that make a real month and day in range, and nothing else.

## The questions

On the slot `visit` with `range: future`, the questions are `visitMode`, `visitRelative`, `visitWeekday`, `visitMonth` and `visitDay`; `qualifier` adds `visitQualifier` and `windows` adds `visitWindow` (with `windows` they are asked in the order mode, month, day, weekday, qualifier, relative, window). Each is made of text parts, and `text.<part>` replaces a part word for word (the defaults are listed under Text parts, after the options table).

`{context}` is the `context` sentence. `{modes}` says what each mode means for the range:

- `past`: "relative_day" is today, yesterday, or the day before yesterday. "weekday" names a day of the week. "absolute" names a day of the month, with or without its month.
- `future`: "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month and a day of the month.
- `future` with `windows`: as `future`, but "absolute" names a month, or a month and a day of the month, and "window" is a span of days such as this week or next month.

Every question is a choice. The mode's choices are `relative_day`, `weekday`, `absolute` and `none` (with `windows`: `absolute`, `relative_day`, `weekday`, `window`, `none`); the relative day's, the three for the range and `none`; the weekday's, the seven days and `none`; the qualifier's, `this`, `next` and `none`; the month's, the twelve months and `none`; the day's, 1 to 31 and `none`; the span's, `this_week`, `next_week`, `this_month`, `next_month` and `none`.

A correction is the place for a sentence of your own: "When they correct a day, the word not marks the day they are rejecting; choose the other one." at the end of `text.weekday` helps a model with "not Monday, Friday".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `windows`, `narrowPrompt` (default `ask_<slot>_narrow`), given `{window}`. With `confirm: by-confidence`, `ack_<slot>`, given `{<slot>}`. With `keypad`, `ask_<slot>_dtmf`. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` with `keypad`), and a second no goes to a person. `dialogwright check` requires each in every locale.

## Examples

The starter examples, listed below, are three configurations with starter utterances and keypad keys: the day a parcel was due (back, keyable, a context sentence and a date-of-birth sentence), a delivery day (ahead, the defaults), and a table booking (ahead, with spans of days and "this" or "next", taken at `SLOT_CHOICE_CONFIRM` and acknowledged below `SLOT_CHOICE_FILL`, a day that does not resolve always invalid, keyable). In an app's `slots.yaml`:

```yaml
booking:
  type: date
  range: future
  windows: true
  qualifier: true
  fillAt: confirm
  whenUnsaid: absent
  whenUnresolved: invalid
  confirm: by-confidence
  readBack: below-fill
  keypad: true
  context: The caller is saying which day they want to book a table for.
```

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the questions are asked even while the form is on another slot, and "I'd like a table next Tuesday" can fill the day on the opening turn.
- A month without a day ahead is a span (the month, from today if it is this month); without `windows` it does not resolve.
- The partial's `kind` is `window`, and its parts are strings, so the engine never reads it as a day heard.
- A keyed day counts as confirmed: it is not acknowledged or read back.
- In a Spanish session (`es`, `es-*`) the display is "martes, 22 de septiembre", the narrow prompt's `{window}` is "la próxima semana" or "en diciembre", the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US.
- Run its checks with `pnpm --filter dialogwright test slots/date`.

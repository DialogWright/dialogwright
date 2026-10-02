# `date`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/date/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

A calendar day, ahead or back: an appointment, a delivery, the day something happened.

The model never writes the date. It answers a question about how the caller refers to the day (the mode: a relative day such as "tomorrow", a weekday, a month and a day of the month, or, with `windows`, a span of days such as "next week") and a choice for each part a day can be named by: the relative day, the weekday, the month (one of the twelve, or none), the day of the month (1 to 31, or none), and with their options "this" or "next" before a weekday and the span. The code resolves the parts against today for the slot's `range`, so the value is always a real day in range, and the code, not the model, says which one.

Ahead (`range: future`), "Tuesday" is the next Tuesday, "October fifth" this year's (or next year's once it is more than a month gone), and "the day after tomorrow" two days on. Back (`range: past`), "Tuesday" is the last Tuesday (a week back when today is a Tuesday), "the fifth" the last fifth of a month, "October fifth" the last October fifth, and nothing more than two years back counts.

With `windows`, a span of days ("next week", "in December") is held as the slot's partial value and the `narrowPrompt` asks which day in it; a weekday said next is looked for inside the span ("Wednesday" after "December" is the first Wednesday in December), and a span said with a weekday ("Tuesday of next week") is that day at once.

Reach for it for any day a caller names that is not their date of birth (use `birthdate` for that).

## Options

A slot of this type is written under its id in slots.yaml, with `type: date` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `range` | one of `future`, `past` | required | Which days the slot takes. "future": today or a day to come (an appointment, a delivery); "tomorrow" and "Monday" are the next ones. "past": today or a day gone, up to two years back (when something happened); "yesterday" and "Monday" are the last ones. |
| `windows` | boolean | `false` | `range: future` only. Whether the caller may name a span of days ("next week", "in December") rather than a day: the span is held as the partial { kind: window, start, end, label }, the `narrowPrompt` asks which day in it, and a bare weekday said next is looked for inside it. Adds the window question. |
| `qualifier` | boolean | `false` | `range: future` only. Whether to ask if a weekday is "this" one or "next" one ("next Tuesday" is in the next week). Adds the qualifier question. |
| `narrowPrompt` | string | unset | With `windows`: the prompt that asks which day in a span of days (the slot's partialPromptId), given {window} ("next week", "in December"). Default: `ask_<slot>_narrow.` |
| `preferMonthDay` | boolean | `true` | Whether a month and a day the model is sure of (SLOT_CHOICE_CONFIRM) win over a weekday reading of the mode: "Monday, September 28" names one day twice, and a weekday reading would land on the next or last Monday instead of the date said. |
| `fillAt` | one of `fill`, `confirm` | `fill` | How sure the model must be of the day (the least of the parts it read) for it to count. "fill": SLOT_CHOICE_FILL; a day below it is treated as not resolved (`whenUnresolved`). "confirm": SLOT_CHOICE_CONFIRM; a day below it is invalid (reason low_confidence, raw the ISO day), and `readBack` says whether one below SLOT_CHOICE_FILL is acknowledged. |
| `whenUnsaid` | one of `invalid-if-prompted`, `absent` | `invalid-if-prompted` | What a turn that names no day (the mode question answers none, is below SLOT_CHOICE_CONFIRM, or is not answered at all) gives. "invalid-if-prompted": invalid (reason unresolvable, raw empty) when the caller was asked for the day, so the retry ladder moves on, else absent. "absent": always absent. |
| `whenUnresolved` | one of `invalid-if-prompted`, `invalid` | `invalid-if-prompted` | What a day named but not resolved (no such day, out of range, a span without `windows`, or below the `fillAt` threshold under "fill") gives. "invalid-if-prompted": invalid (reason unresolvable, raw empty) when the caller was asked for the day, else absent. "invalid": always invalid (reason unresolvable), its raw the mode the caller used (absolute, weekday, ...). |
| `keypad` | boolean | `false` | Whether the caller can key the day on the keypad as four digits, month then day (MMDD: 0922), or in a day-first locale (Spanish) day then month (DDMM: 2209), resolved as a spoken month and day are for the `range`. Needs an `ask_<slot>_dtmf` line. |
| `confirm` | one of `summary`, `by-confidence` | `summary` | "summary": a spoken day is neither acknowledged nor read back on its own; the form's final confirm covers it. "by-confidence": it is acknowledged (`ack_<slot>`, given the day as `{<slot>}`) when `readBack` says so. |
| `readBack` | one of `implicit`, `below-fill`, `none` | `implicit` | With `confirm: by-confidence`, what a filled day asks for: "implicit" (always acknowledged), "below-fill" (only when the model is less sure of it than SLOT_CHOICE_FILL), "none" (never). |
| `context` | string | unset | The sentence each default question starts with after "Read asr.text.", saying what day the caller is giving ("The caller is saying which day a parcel was due."). Default, by `range`: "The caller is saying the day something happened." (past), "The caller is saying the day they want." (future). |
| `exclude` | string | unset | A sentence naming a date the caller may also say that is not this day ("A date of birth is not the day the parcel was due."), which the default mode, month and day questions end with. Default: none. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: mode, modeNone, relative, weekday, qualifier, month, day, window. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: mode, relative, weekday, qualifier, month, day, window), to keep the ids an existing slot used. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.mode` | The question that asks how the caller refers to the day: a relative day, a weekday, a month and day, a span of days (with `windows`), or none. By default {modes} describes each choice for the slot's `range`, and the question ends with the `exclude` sentence. Variables: `{context}`, `{modes}`, `{exclude}`. | `Read asr.text. {context} How do they refer to the day? {modes} "none" if no day is mentioned.{exclude}` |
| `text.modeNone` | What the mode question's "none" choice means (its criterion), such as which dates are not this day. Default: nothing (the label alone). | none (empty) |
| `text.relative` | The question that asks which relative day the caller says: today, yesterday or the day before (`range: past`), or today, tomorrow or the day after (`range: future`). Variables: `{context}`, `{relativeDays}`. | `Read asr.text. {context} Do they say {relativeDays}?` |
| `text.weekday` | The question that asks which day of the week the caller names. Variables: `{context}`. | `Read asr.text. {context} Which day of the week do they name, if any?` |
| `text.qualifier` | With `qualifier`: the question that asks whether a weekday is "this" one or "next" one. Variables: `{context}`. | `Read asr.text. {context} If they name a day of the week, do they say "this" or "next" before it?` |
| `text.month` | The question that asks which month the caller names. By default it ends with the `exclude` sentence. Variables: `{context}`, `{exclude}`. | `Read asr.text. {context} Which month do they name, if any?{exclude}` |
| `text.day` | The question that asks which day of the month the caller names. By default it ends with the `exclude` sentence. Variables: `{context}`, `{exclude}`. | `Read asr.text. {context} Which day of the month do they name, if any?{exclude}` |
| `text.window` | With `windows`: the question that asks which span of days the caller names. Variables: `{context}`. | `Read asr.text. {context} Do they name a span of days such as this week, next week, this month, or next month?` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.mode` | The id of the question that asks how the caller refers to the day. |
| `ids.relative` | The id of the question that asks which relative day the caller says. |
| `ids.weekday` | The id of the question that asks which day of the week the caller names. |
| `ids.qualifier` | The id of the question that asks whether a weekday is this one or next one. |
| `ids.month` | The id of the question that asks which month the caller names. |
| `ids.day` | The id of the question that asks which day of the month the caller names. |
| `ids.window` | The id of the question that asks which span of days the caller names. |

The slot is always `valueKind: date`: when the caller was asked for another date-valued slot (a birth date) and this slot hears the same month and day on that turn, the engine drops this slot's reading, so a birthday is never also taken as this day.

## The outcome

| What the caller said | The outcome |
|---|---|
| No day (the mode is none, below `SLOT_CHOICE_CONFIRM`, or not answered at all) | `whenUnsaid` |
| A day that does not resolve (February 30th; a month without a day and no `windows`; back, more than two years ago) | `whenUnresolved` |
| A span of days, with `windows` | `window`: `{ kind: window, start, end, label }` (ISO days and the span's label), and `narrowPrompt` asks which day |
| A day below the `fillAt` threshold | `fill`: `whenUnresolved`; `confirm`: `invalid`, reason `low_confidence`, raw the ISO day |
| A weekday while a span is pending, with no such day left in it | `invalid`, reason `outside_window`, raw the day first resolved |
| A day | `filled`: the value is the ISO date (2026-09-22), the display says it ("Tuesday, September 22"), and `confirm`/`readBack` say whether it is acknowledged |

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

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `windows`, `narrowPrompt` (default `ask_<slot>_narrow`), given `{window}`. With `confirm: by-confidence`, `ack_<slot>`, given `{<slot>}`. With `keypad`, `ask_<slot>_dtmf`. `dialogwright check` requires each in every locale.

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

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### parcel due day

A day already gone, the day a parcel was due to arrive, keyable as MMDD. A weekday is the last one, a day of the month without its month the last one too. A turn that names no day, or one that cannot be resolved, is invalid when the caller was asked for the day and absent otherwise (the defaults).

```yaml
dueDay:
  type: date
  range: past
  keypad: true
  context: The caller is saying which day a parcel was due to arrive.
  exclude: A date of birth is not the day the parcel was due.
```

<details><summary>Starter utterances (7)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| it was due yesterday | `dueDayMode`: `relative_day` 0.93, `none` 0.07<br>`dueDayRelative`: `yesterday` 0.92, `none` 0.08 | filled: value `2026-09-17`, display `Thursday, September 17`, confirm `none` |
| last Saturday | `dueDayMode`: `weekday` 0.9, `none` 0.1<br>`dueDayWeekday`: `saturday` 0.91, `none` 0.09 | filled: value `2026-09-12`, display `Saturday, September 12` |
| on the twentieth | `dueDayMode`: `absolute` 0.9, `none` 0.1<br>`dueDayMonth`: `none` 0.95<br>`dueDayDay`: `20` 0.9, `none` 0.1 | filled: value `2026-08-20`, display `Thursday, August 20` |
| Thursday the tenth of September | `dueDayMode`: `weekday` 0.6, `absolute` 0.38, `none` 0.02<br>`dueDayWeekday`: `thursday` 0.95, `none` 0.05<br>`dueDayMonth`: `september` 0.96, `none` 0.04<br>`dueDayDay`: `10` 0.94, `none` 0.06 | filled: value `2026-09-10`, display `Thursday, September 10` |
| I'm not sure<br>_prompted_ | `dueDayMode`: `none` 0.9, `weekday` 0.1 | invalid: reason `unresolvable`, raw `` |
| February thirtieth<br>_prompted_ | `dueDayMode`: `absolute` 0.9, `none` 0.1<br>`dueDayMonth`: `february` 0.9, `none` 0.1<br>`dueDayDay`: `30` 0.9, `none` 0.1 | invalid: reason `unresolvable`, raw `` |
| can I change my address | `dueDayMode`: `none` 0.98 | absent |

</details>

<details><summary>Keypad (4)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `0912` | any | `2026-09-12`, said `Saturday, September 12` |
| `0920` | any | `2025-09-20`, said `Saturday, September 20` |
| `1332` | any | no value |
| `0230` | any | no value |

</details>

#### delivery day

A day to come, the day a parcel should be delivered, with the defaults otherwise. "Tuesday" is the next one; a month without a day is a span, which this slot does not hold, so it is not resolved.

```yaml
deliveryDay:
  type: date
  range: future
  context: The caller is saying which day they want a parcel delivered.
```

<details><summary>Starter utterances (9)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| tomorrow please | `deliveryDayMode`: `relative_day` 0.94, `none` 0.06<br>`deliveryDayRelative`: `tomorrow` 0.93, `none` 0.07 | filled: value `2026-09-19`, display `Saturday, September 19`, confirm `none` |
| on Tuesday | `deliveryDayMode`: `weekday` 0.9, `none` 0.1<br>`deliveryDayWeekday`: `tuesday` 0.92, `none` 0.08 | filled: value `2026-09-22`, display `Tuesday, September 22` |
| October fifth | `deliveryDayMode`: `absolute` 0.92, `none` 0.08<br>`deliveryDayMonth`: `october` 0.95, `none` 0.05<br>`deliveryDayDay`: `5` 0.93, `none` 0.07 | filled: value `2026-10-05`, display `Monday, October 5` |
| el martes, por favor<br>_locale es_ | `deliveryDayMode`: `weekday` 0.9, `none` 0.1<br>`deliveryDayWeekday`: `tuesday` 0.92, `none` 0.08 | filled: value `2026-09-22`, display `martes, 22 de septiembre` |
| pasado mañana<br>_locale es-US_ | `deliveryDayMode`: `relative_day` 0.93, `none` 0.07<br>`deliveryDayRelative`: `day_after_tomorrow` 0.92, `none` 0.08 | filled: value `2026-09-20`, display `domingo, 20 de septiembre` |
| el cinco del diez<br>_locale es_ | `deliveryDayMode`: `absolute` 0.9, `none` 0.1<br>`deliveryDayMonth`: `october` 0.9, `none` 0.1<br>`deliveryDayDay`: `5` 0.9, `none` 0.1 | filled: value `2026-10-05`, display `lunes, 5 de octubre` |
| sometime in October<br>_prompted_ | `deliveryDayMode`: `absolute` 0.85, `none` 0.15<br>`deliveryDayMonth`: `october` 0.9, `none` 0.1<br>`deliveryDayDay`: `none` 0.9 | invalid: reason `unresolvable`, raw `` |
| tomorrow, I think | `deliveryDayMode`: `relative_day` 0.9, `none` 0.1<br>`deliveryDayRelative`: `tomorrow` 0.5, `today` 0.3, `none` 0.2 | absent |
| where is my parcel | `deliveryDayMode`: `none` 0.97 | absent |

</details>

#### table booking

A day to book a table on, said as a day or a span of days ("next week", "in December"), with "this" or "next" before a weekday. A span is held and the narrow prompt asks which day; a weekday said next is looked for inside it. A day is taken at SLOT_CHOICE_CONFIRM and acknowledged below SLOT_CHOICE_FILL; below SLOT_CHOICE_CONFIRM it is invalid, low_confidence. A day that cannot be resolved is always invalid, with the mode as raw; a turn that names no day is absent. Keyable as MMDD, and as DDMM in Spanish.

```yaml
booking:
  type: date
  range: future
  windows: true
  qualifier: true
  narrowPrompt: ask_booking_which_day
  fillAt: confirm
  whenUnsaid: absent
  whenUnresolved: invalid
  confirm: by-confidence
  readBack: below-fill
  keypad: true
  context: The caller is saying which day they want to book a table for.
  text:
    modeNone: No day for the booking. The day a booking was made on is not one
```

<details><summary>Starter utterances (11)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| next week sometime | `bookingMode`: `window` 0.9, `none` 0.1<br>`bookingWindow`: `next_week` 0.88, `none` 0.12 | window |
| Wednesday<br>_prompted; window {"kind":"window","start":"2026-09-21","end":"2026-09-27","label":"next_week"}_ | `bookingMode`: `weekday` 0.9, `none` 0.1<br>`bookingWeekday`: `wednesday` 0.9, `none` 0.1 | filled: value `2026-09-23`, display `Wednesday, September 23`, confirm `none` |
| la próxima semana<br>_locale es_ | `bookingMode`: `window` 0.9, `none` 0.1<br>`bookingWindow`: `next_week` 0.88, `none` 0.12 | window |
| el miércoles<br>_prompted; locale es; window {"kind":"window","start":"2026-09-21","end":"2026-09-27","label":"next_week"}_ | `bookingMode`: `weekday` 0.9, `none` 0.1<br>`bookingWeekday`: `wednesday` 0.9, `none` 0.1 | filled: value `2026-09-23`, display `miércoles, 23 de septiembre`, confirm `none` |
| in December, on a Wednesday<br>_prompted; window {"kind":"window","start":"2026-12-01","end":"2026-12-31","label":"december"}_ | `bookingMode`: `weekday` 0.9, `none` 0.1<br>`bookingWeekday`: `wednesday` 0.9, `none` 0.1 | filled: value `2026-12-02`, display `Wednesday, December 2` |
| next Tuesday | `bookingMode`: `weekday` 0.9, `none` 0.1<br>`bookingWeekday`: `tuesday` 0.93, `none` 0.07<br>`bookingQualifier`: `next` 0.9, `none` 0.1 | filled: value `2026-09-22`, display `Tuesday, September 22` |
| October fifth, I think | `bookingMode`: `absolute` 0.9, `none` 0.1<br>`bookingMonth`: `october` 0.9, `none` 0.1<br>`bookingDay`: `5` 0.5, `15` 0.3, `none` 0.2 | filled: value `2026-10-05`, display `Monday, October 5`, confirm `implicit` |
| the fifth or the fifteenth or the twenty fifth | `bookingMode`: `absolute` 0.9, `none` 0.1<br>`bookingMonth`: `october` 0.9, `none` 0.1<br>`bookingDay`: `5` 0.3, `15` 0.25, `25` 0.25, `none` 0.2 | invalid: reason `low_confidence`, raw `2026-10-05` |
| February thirtieth | `bookingMode`: `absolute` 0.9, `none` 0.1<br>`bookingMonth`: `february` 0.9, `none` 0.1<br>`bookingDay`: `30` 0.9, `none` 0.1 | invalid: reason `unresolvable`, raw `absolute` |
| a Friday<br>_prompted; window {"kind":"window","start":"2026-12-01","end":"2026-12-02","label":"december"}_ | `bookingMode`: `weekday` 0.9, `none` 0.1<br>`bookingWeekday`: `friday` 0.9, `none` 0.1 | invalid: reason `outside_window`, raw `2026-09-25` |
| I'm not sure yet<br>_prompted_ | `bookingMode`: `none` 0.9, `window` 0.1 | absent |

</details>

<details><summary>Keypad (6)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `1005` | any | `2026-10-05`, said `Monday, October 5` |
| `0101` | any | `2027-01-01`, said `Friday, January 1` |
| `1305` | any | no value |
| `0510` | es | `2026-10-05`, said `lunes, 5 de octubre` |
| `3102` | es | no value |
| `0230` | any | no value |

</details>

## Notes

- Every slot listens on every turn, so the questions are asked even while the form is on another slot, and "I'd like a table next Tuesday" can fill the day on the opening turn.
- A month without a day ahead is a span (the month, from today if it is this month); without `windows` it does not resolve.
- The partial's `kind` is `window`, and its parts are strings, so the engine never reads it as a day heard.
- A keyed day counts as confirmed: it is not acknowledged or read back.
- In a Spanish session (`es`, `es-*`) the display is "martes, 22 de septiembre", the narrow prompt's `{window}` is "la próxima semana" or "en diciembre", the keypad takes the day first, and the default month and day questions end with a sentence telling the model that a date said as numbers gives the day first. Every other locale, and none, is as en-US.
- Run its checks with `pnpm --filter dialogwright test slots/date`.

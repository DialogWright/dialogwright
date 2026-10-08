# `record`

One of the app's own records, chosen by what the caller says of it: a parcel ("the one with the books"), an order, a booking. The records are the app's (a tool returned them, and the app gives them to its slots from `facts.forSlots`), so the list differs from caller to caller and from turn to turn.

The model is asked one question: which of these does the caller mean? Each record is a label (`labelPrefix` and the record's key) with a criterion written from the record's fields (`label`), and `none`. With `spoken`, the numbers the caller says are offered too, after the records, even when no record has them, so a caller can name one that is not on their list (whether they may hear about it is the policy gate's call, not the slot's). The slot fills with the key, so the value is always a key (`labelPrefix` and a match for `keyPattern`); the model never writes it. The fill takes any label of that shape, not only one offered on that turn, as the hand-written slots it replaced did: a recorded answer given against another turn's list can name a record this turn did not offer, so an app that must refuse such a key checks the value against its records.

Reach for it when the caller chooses among things the app has looked up. For a fixed list you can write down, use `choice`; for an identifier no list holds, use `digits`.

## Options

<!-- slot-docs:options -->

The slot is read back in the final summary and not on its own unless `confirm: always` says so, and its display is the key as it is.

## Labels

`label` and `spoken.label` are templates with nothing evaluated but these:

- `{field}`: the record's field of that name, as text (a number or a yes-or-no written out; a field the record lacks, or a list or a map, is empty).
- `{key}`: the record's key, whatever its field is called. In `spoken.label` it is the number said, and the only name allowed.
- `{field|day}`: an ISO date (`2026-09-18`) said as a day ("Friday, September 18"). A value that is not an ISO date is kept as it is. `day` is the only filter.

A brace that is not around a name is kept as written. A filter that does not exist, or a name other than `{key}` in `spoken.label`, is a problem when the slot is defined.

## The outcome

The slot reads the probabilities the model gives each label, not its one pick:

| What the caller said | The outcome |
|---|---|
| A record, and the model's probability for it reaches `fillAt` | `filled`: the value and the display are the key, and no read-back is asked for |
| Two records, the top one at `SLOT_CHOICE_CONFIRM` or above and the second within `SLOT_CHOICE_MARGIN` of it (with `disambiguate`) | `disambiguate`, between the two keys |
| `none`, a label the slot never offers, a key `keyPattern` refuses, or a top label below `SLOT_CHOICE_CONFIRM` or (without a rival) below `fillAt` | `invalid` with `missReason` when the slot was asked for, else `absent` |
| No answer at all (the question was not asked, having nothing to offer) | the same: `invalid` with `missReason` when the slot was asked for (so the retry ladder moves on), else `absent` |

## The question

On the slot `parcel`, the question is `parcelChoice`, a choice whose labels are the records and spoken numbers, in that order, then `none`. With nothing to offer (no records, no number said), the slot asks nothing that turn.

With this configuration:

```yaml
parcel:
  type: record
  key: number
  keyPattern: '\d{4}'
  labelPrefix: parcel_
  label: "Parcel {number}, {item}, due {day|day}"
  spoken: { digits: 4 }
```

the records `{ number: "7101", item: a box of books, day: "2026-09-14" }` and `{ number: "7102", item: a pair of boots, day: "2026-09-16" }`, and the words "it is four four one two", the question's labels are:

> - `parcel_7101`: Parcel 7101, a box of books, due Monday, September 14
> - `parcel_7102`: Parcel 7102, a pair of boots, due Wednesday, September 16
> - `parcel_4412`: Number 4412, as the caller said it
> - `none`: Names none of these

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `disambiguate` (the default), `disambiguate_<slot>` with `{a}` and `{b}`, the two keys. With `keypad`, `ask_<slot>_dtmf`. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` with `keypad`), and a second no goes to a person. `dialogwright check` requires each in every locale, with only those variables.

## Examples

The starter examples, listed below, are three configurations with starter utterances: a customer's parcels from the app's one list, with spoken numbers and a keypad; orders read from a list by name beside another list, with their own words, no disambiguation and a lower threshold; and bookings with the defaults. In an app's `slots.yaml`:

```yaml
order:
  type: record
  from: orders
  key: ref
  label: "Order {ref}, {what}, placed {placed|day}"
```

with the app's facts giving `forSlots: (f) => ({ sources: { orders: ordersOf(f) } })`.

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot, whenever there is something to offer.
- The list is the app's, read on every turn: before the tool that lists the records has run (before identity, say), there is nothing to offer unless the caller says a number.
- Keep labels short and distinct: what the model reads to tell one record from another is the label. A record's day, its contents or its status are good; a field the caller would never say is noise.
- A spoken number is found in the caller's words by the engine (`numbersSaid`: runs of number words or digits that read as exactly `digits` digits, then numbers written as digits on their own), never by the model.
- In a Spanish session (`es`, `es-*`) a spoken number is read in Spanish ("cuarenta y cuatro doce" is 4412, the "y" inside the number), and a year after a Spanish month ("marzo de dos mil veinticinco") is skipped. Labels are criteria the model reads, so they are not worded per locale, and `{field|day}` stays English there.
- Run its checks with `pnpm --filter dialogwright test slots/record`.

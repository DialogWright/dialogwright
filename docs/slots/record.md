# `record`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/record/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

One of the app's own records, chosen by what the caller says of it: a parcel ("the one with the books"), an order, a booking. The records are the app's (a tool returned them, and the app gives them to its slots from `facts.forSlots`), so the list differs from caller to caller and from turn to turn.

The model is asked one question: which of these does the caller mean? Each record is a label (`labelPrefix` and the record's key) with a criterion written from the record's fields (`label`), and `none`. With `spoken`, the numbers the caller says are offered too, after the records, even when no record has them, so a caller can name one that is not on their list (whether they may hear about it is the policy gate's call, not the slot's). The slot fills with the key, so the value is always a key (`labelPrefix` and a match for `keyPattern`); the model never writes it. The fill takes any label of that shape, not only one offered on that turn, as the hand-written slots it replaced did: a recorded answer given against another turn's list can name a record this turn did not offer, so an app that must refuse such a key checks the value against its records.

Reach for it when the caller chooses among things the app has looked up. For a fixed list you can write down, use `choice`; for an identifier no list holds, use `digits`.

## Options

A slot of this type is written under its id in slots.yaml, with `type: record` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `from` | string | unset | The list of records to choose among, by name: the app gives its lists by name from facts.forSlots ({ sources: { `<name>`: [...] } }), so two record slots can each read their own. Default: the app's one list (facts.forSlots records). |
| `key` | string | `id` | The record field whose value the slot takes (a string or a number), and which the keypad and a spoken number give. |
| `keyPattern` | string | `[A-Za-z0-9_-]+` | A regular expression (its source, no slashes) the whole key must match, such as "\d{4}" for four digits. A record whose key does not match is not offered, and a label or keys that do not match are no value. A key longer than 64 characters is never tried, and a group that repeats a repeat, such as (\d+)+, is refused. |
| `labelPrefix` | string | `record_` | What each label the model chooses starts with, before the key ("parcel_" gives parcel_4711). It keeps a key from being taken for the question's own "none". |
| `label` | string | `Number {key}` | The criterion the model is given for each record. A template: {field} is the record's field of that name, {key} the record's key, and {field\|day} formats an ISO date as a day ("Friday, September 18"). Nothing else is evaluated. |
| `spoken` | map | unset | Numbers of `digits` digits the caller says (spoken or written) are offered too, after the records, even when no record has them, so a caller can name one that is not on their list. Default: off, only the records are offered. |
| `spoken.digits` | integer, 1 to 20 | required | How many digits a number the caller says has. |
| `spoken.label` | string | `Number {key}, as the caller said it` | The criterion the model is given for a number the caller says; {key} is the number. A template: {field} is the record's field of that name, {key} the record's key, and {field\|day} formats an ISO date as a day ("Friday, September 18"). Nothing else is evaluated. |
| `spoken.skipYearAfterMonth` | boolean | `false` | Whether a spoken year right after a month name ("March twenty twenty five") is a date rather than a number. |
| `missReason` | string | `no_match` | The reason of the invalid outcome when the slot was asked for and the caller chose nothing (or the model was not sure enough). Not asked for, that is absent. |
| `keypad` | integer, 1 to 20 | unset | How many keys the caller keys the key with, after spoken answers missed; the keys are the value when they match keyPattern. Needs an `ask_<slot>_dtmf` line. Default: no keypad. |
| `disambiguate` | boolean | `true` | Whether two records the model cannot tell apart (the top two within SLOT_CHOICE_MARGIN) make the slot ask which one (`disambiguate_<slot>`, with {a} and {b}). |
| `fillAt` | one of `SLOT_CHOICE_FILL`, `SLOT_CHOICE_CONFIRM` | `SLOT_CHOICE_FILL` | The threshold the model's probability for the record must reach for the slot to fill. Below SLOT_CHOICE_CONFIRM nothing was chosen. |
| `confirm` | one of `summary`, `always` | unset | "summary" (the default): a record is neither acknowledged nor read back on its own; the form's final confirm covers it. "always": the record is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung where the slot takes keys), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions, none. |
| `ids` | map | unset | Question ids in place of the default: `ids.choice` is the question's id (default: the slot's id followed by "Choice"), to keep the id an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.instructions` | The question that asks which record the caller means, sent to the model in place of the default. | `Read asr.text and node.promptJustPlayed. Which of these does the caller mean? They may name it by its number or by what the list says about it. Choose none only when they name none of these.` |
| `text.none` | What the question's "none" label means: the caller names no record. | `Names none of these` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.choice` | The id of the question that asks which record the caller means. |

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

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `disambiguate` (the default), `disambiguate_<slot>` with `{a}` and `{b}`, the two keys. With `keypad`, `ask_<slot>_dtmf`. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung with `keypad`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person. `dialogwright check` requires each in every locale, with only those variables.

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

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### parcel

The customer's parcels from the app's one list, each labelled with what is in it and its day, any four-digit number the caller says offered too, and a keypad.

```yaml
parcel:
  type: record
  key: number
  keyPattern: \d{4}
  labelPrefix: parcel_
  label: Parcel {number}, {item}, due {day|day}
  spoken:
    digits: 4
  keypad: 4
  missReason: no_parcel
  ids:
    choice: parcelChoice
```

<details><summary>Starter utterances (6)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the one with the books<br>_records [{"number":"7101","item":"a box of books","day":"2026-09-14"},{"number":"7102","item":"a pair of boots","day":"2026-09-16"}]_ | `parcelChoice`: `parcel_7101` 0.91, `parcel_7102` 0.05, `none` 0.04 | filled: value `7101`, display `7101`, confirm `none` |
| the books, or was it the boots<br>_records [{"number":"7101","item":"a box of books","day":"2026-09-14"},{"number":"7102","item":"a pair of boots","day":"2026-09-16"}]_ | `parcelChoice`: `parcel_7101` 0.48, `parcel_7102` 0.44, `none` 0.08 | disambiguate |
| parcel four four one two<br>_records [{"number":"7101","item":"a box of books","day":"2026-09-14"}]_ | `parcelChoice`: `parcel_4412` 0.9, `parcel_7101` 0.04, `none` 0.06 | filled: value `4412`, display `4412` |
| el paquete cuarenta y cuatro doce<br>_locale es; records [{"number":"7101","item":"a box of books","day":"2026-09-14"}]_ | `parcelChoice`: `parcel_4412` 0.9, `parcel_7101` 0.04, `none` 0.06 | filled: value `4412`, display `4412` |
| I am not sure which<br>_prompted; records [{"number":"7101","item":"a box of books","day":"2026-09-14"}]_ | `parcelChoice`: `none` 0.9, `parcel_7101` 0.1 | invalid: reason `no_parcel`, raw `` |
| I am not sure which<br>_records [{"number":"7101","item":"a box of books","day":"2026-09-14"}]_ | `parcelChoice`: `none` 0.9, `parcel_7101` 0.1 | absent |

</details>

<details><summary>Keypad (3)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `4412` | any | `4412`, said `4412` |
| `0007` | any | `0007` |
| `441` | any | no value |

</details>

#### order

Two lists by name (the app's sources), this slot reading its orders; its own key, labels, words and reason; no spoken numbers, no disambiguation, no keypad.

```yaml
order:
  type: record
  from: orders
  key: ref
  keyPattern: "[A-Z]\\d{2}"
  labelPrefix: order_
  label: Order {ref}, {what}, placed {placed|day}
  disambiguate: false
  fillAt: SLOT_CHOICE_CONFIRM
  missReason: no_order
  text:
    instructions: Read asr.text. Which of the caller's orders do they mean, by its reference or by what was ordered?
    none: Names no order
```

<details><summary>Starter utterances (2)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the lamp order<br>_sources {"orders":[{"ref":"A12","what":"a desk lamp","placed":"2026-09-02"},{"ref":"B07","what":"a lampshade","placed":"2026-09-10"}],"parcels":[{"number":"7101","item":"a box of books","day":"2026-09-14"}]}_ | `orderChoice`: `order_A12` 0.62, `order_B07` 0.3, `none` 0.08 | filled: value `A12`, display `A12`, display in es `A12` |
| the lamp, or the shade<br>_prompted; sources {"orders":[{"ref":"A12","what":"a desk lamp","placed":"2026-09-02"},{"ref":"B07","what":"a lampshade","placed":"2026-09-10"}]}_ | `orderChoice`: `order_A12` 0.42, `order_B07` 0.4, `none` 0.18 | invalid: reason `no_order` |

</details>

#### booking

The defaults, over records keyed by their id.

```yaml
booking:
  type: record
```

<details><summary>Starter utterances (2)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| booking B twelve<br>_records [{"id":"B12","room":"the north room"},{"id":"C3","room":"the garden room"}]_ | `bookingChoice`: `record_B12` 0.88, `record_C3` 0.02, `none` 0.1 | filled: value `B12`, display `B12`, display in es `B12` |
| no booking yet<br>_records [{"id":"B12","room":"the north room"}]_ | `bookingChoice`: `none` 0.95, `record_B12` 0.05 | absent |

</details>

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot, whenever there is something to offer.
- The list is the app's, read on every turn: before the tool that lists the records has run (before identity, say), there is nothing to offer unless the caller says a number.
- Keep labels short and distinct: what the model reads to tell one record from another is the label. A record's day, its contents or its status are good; a field the caller would never say is noise.
- A spoken number is found in the caller's words by the engine (`numbersSaid`: runs of number words or digits that read as exactly `digits` digits, then numbers written as digits on their own), never by the model.
- In a Spanish session (`es`, `es-*`) a spoken number is read in Spanish ("cuarenta y cuatro doce" is 4412, the "y" inside the number), and a year after a Spanish month ("marzo de dos mil veinticinco") is skipped. Labels are criteria the model reads, so they are not worded per locale, and `{field|day}` stays English there.
- Run its checks with `pnpm --filter dialogwright test slots/record`.

# Slot types

A slot is one value a form collects: a card number, a day, a branch, a name. Most slots are configuration. You name a type in the app's `slots.yaml`, give it options, and the engine asks the decision model the right questions, turns its answers into a value, and says it back. The model never writes the value: it answers typed questions, and code decides what they mean.

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/slots.schema.json
account:
  type: digits
  noun: account
  length: 8
  keypad: true
speed:
  type: choice
  options:
    standard: standard delivery
    express: express delivery
pickupDay:
  type: date
  range: future
note:
  type: text
  what: a note for the courier
  say: your note
```

Each type has a page with every option, its default, the default question text, the outcomes it can give, the lines it needs in `prompts.yaml`, and starter examples. The pages are generated from the types themselves, so they cannot drift from the options. For how slots fit into an app, read section 4 of the [authoring guide](../authoring-an-app.md#4-writing-a-slot).

## The types

| Type | It collects | Pick it when |
|---|---|---|
| [`digits`](digits.md) | A number of a fixed shape: an account, a library card, a tracking number | The caller reads out an identifier made only of digits. The code, not the model, turns the spoken words into digits and checks the length or pattern. |
| [`choice`](choice.md) | One of a fixed list: a delivery speed, a branch, a colour | You can write the answers down. Basic use is a list with a criterion each. The advanced options handle names that sound alike (`disambiguate`), a caller who hedges (`hedge`) and one who says they do not know (`help`). |
| [`date`](date.md) | A calendar day, ahead or back: a delivery, an appointment, the day something happened | The caller names a day by weekday, month and day, "tomorrow", or (with `windows`) a span such as "next week". Code resolves it against today and the range. |
| [`birthdate`](birthdate.md) | A date of birth | You ask for a birth date to know or verify who is calling. A month and day without the year are held and the year is asked for alone. Masked to its year by default. |
| [`name`](name.md) | The caller's own name | The caller says who they are. `exclude` lists words that never belong to the caller's name, such as the names of people discussed on the call. |
| [`record`](record.md) | One of the app's own records, found by a tool and chosen by what the caller says of it | The list differs from caller to caller: their parcels, orders or bookings. The slot takes the record's key, never anything the model wrote. |
| [`text`](text.md) | The caller's own words, kept as said | The value is free text no list holds and no code can check: a description, a note, a reason. A summary reads it back by a stand-in. |

When no type fits, write the slot in code (`{ type: code }` in `slots.yaml`) or contribute a type: see [Adding a slot type](../../CONTRIBUTING.md#adding-a-slot-type).

### Which type?

- A value the caller reads out in digits: `digits`. With letters in it, there is no type yet; write the slot in code.
- A day: `date`. Their date of birth: `birthdate`, since its questions, masking and handling of a missing year are different.
- One of a short list you write in the YAML: `choice`. One of a list a tool returns for this caller: `record`.
- The caller's own name: `name`. A name picked from a list (a provider, a branch): `choice`.
- Anything said in the caller's own words: `text`. If the words can be checked, use the type made for them.

### Defaults for sensitive values

`redact` says how a value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name). `handoff` says what a transfer to a person carries. The types that hold an identifier mask by default; a value that is no one's secret can turn that off.

| Type | `redact` | `handoff` |
|---|---|---|
| `digits` | `last4` ("...0417") | `last4` |
| `birthdate` | `mask` (the year only) | `display` |
| `name` | `none` | `display` |
| `text` | `length` (`<38 chars>`) | the display, a stand-in |
| `choice`, `date`, `record` | none | the display |

### Locales

Every type reads and says en-US exactly as it did before there were locales. In a Spanish session (`es`, or any `es-*`) the types also read Spanish number words, names and dates and say values in Spanish formats, and a day-first keypad applies. `choice` options and a `text` slot's stand-in can be worded per locale in `locale/<tag>/slots.yaml`. The questions the model reads are never translated. See section 7 of the authoring guide and the "Notes" of each page.

## Not yet in the library

| Type | Why it waits |
|---|---|
| `otp` (a one-time code) | Identity owns the code path (how a code is sent and checked), and a spoken code must be masked, reissued and never traced. It arrives with identity and the named policy rules in Phase 4, so the slot and the gate agree on one design. |
| `topic` (a knowledge-base question) | It needs the knowledge base's retrieval contract, which does not exist yet (Phase 6). |
| `time-slot` (an appointment time) | An appointment time is asked by form state in the apps that have it today. Making it a slot would change every recorded request, so it waits for a deliberate re-record. |
| Name spelling | Letter-by-letter capture is its own set of questions, left until an app needs it. |

Also deferred is a per-slot `listen:` option. Every slot listens on every turn, which is what lets a caller volunteer several details in one breath. Narrowing that for one slot changes the questions asked on most turns, so any non-default value would re-key a recorded cassette. It will arrive with a deliberate re-record.

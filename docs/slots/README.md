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

Each type has a page with every option, its default, the default question text, the outcomes it can give, the lines it needs in `prompts.yaml`, and starter examples. The pages are generated from the types themselves, so they cannot drift from the options. For how slots fit into an app, read section 5 of the [authoring guide](../authoring-an-app.md#5-writing-a-slot).

## The types

| Type | It collects | Pick it when |
|---|---|---|
| [`digits`](digits.md) | A number of a fixed shape: an account, a library card, a tracking number | The caller reads out an identifier made only of digits. The code, not the model, turns the spoken words into digits and checks the length or pattern. |
| [`choice`](choice.md) | One of a fixed list: a delivery speed, a branch, a colour | You can write the answers down. Basic use is a list with a criterion each. The advanced options handle names that sound alike (`disambiguate`), a caller who hedges (`hedge`) and one who says they do not know (`help`). |
| [`date`](date.md) | A calendar day, ahead or back: a delivery, an appointment, the day something happened | The caller names a day by weekday, month and day, "tomorrow", or (with `windows`) a span such as "next week". Code resolves it against today and the range. |
| [`birthdate`](birthdate.md) | A date of birth | You ask for a birth date to know or verify who is calling. A month and day without the year are held and the year is asked for alone. Masked to its year by default. |
| [`name`](name.md) | The caller's own name | The caller says who they are. `exclude` lists words that never belong to the caller's name, such as the names of people discussed on the call. |
| [`record`](record.md) | One of the app's own records, found by a tool and chosen by what the caller says of it | The list differs from caller to caller: their parcels, orders or bookings. The slot takes the record's key, never anything the model wrote. |
| [`text`](text.md) | The caller's own words, kept as said | The value is free text no list holds and no code can check: a description, a note, a reason. A summary reads it back by a stand-in. With `pick`, the value is the part of the words the model chooses among those code split them into. |
| [`topic`](topic.md) | Which of the knowledge base's topics the caller asks about | The app answers general questions from approved passages. The app's retriever nominates a few topics for the caller's words, the question offers only those, and a turn that nominates none asks nothing. The answer is never the slot's: its value is a topic id, and the form's completion finds the approved passage and says it word for word ([the knowledge base](../authoring-an-app.md#12-the-knowledge-base)). |

When no type fits, write the slot in code (`{ type: code }` in `slots.yaml`) or contribute a type: see [Adding a slot type](../../CONTRIBUTING.md#adding-a-slot-type).

### Which type?

- A value the caller reads out in digits: `digits`. With letters in it, there is no type yet; write the slot in code.
- A day: `date`. Their date of birth: `birthdate`, since its questions, masking and handling of a missing year are different.
- One of a short list you write in the YAML: `choice`. One of a list a tool returns for this caller: `record`.
- The caller's own name: `name`. A name picked from a list (a provider, a branch): `choice`.
- Anything said in the caller's own words: `text`. If the words can be checked, use the type made for them.
- A general question the app answers from its knowledge base: `topic`, which needs the app's knowledge (a `kb/` folder and a retriever; [the guide's section 12](../authoring-an-app.md#12-the-knowledge-base) says how a form answers from it). It chooses among a few topics a retriever nominated for this turn, so it has no list to write; use `choice` for a fixed list the caller picks from as part of a task.

### Defaults for sensitive values

`redact` says how a value is masked wherever it leaves the turn (the trace, the console, a tool call's param of the same name). `handoff` says what a transfer to a person carries. The types that hold an identifier mask by default; a value that is no one's secret can turn that off.

| Type | `redact` | `handoff` |
|---|---|---|
| `digits` | `last4` ("...0417"; four digits or fewer as "••••"), or `length` for a short secret | `last4` |
| `birthdate` | `mask` (the year only) | `display` |
| `name` | `none` | `display` |
| `text` | `length` (`<38 chars>`) | the display, a stand-in |
| `choice`, `date`, `record`, `topic` | none | the display |

### Where a slot listens

Every slot takes `listen:` beside its type's options, so each page lists it: `up-front` (the default: asked outside a form, and a value kept only when the turn enters a form that has the slot), `form` (asked only while its form is open), `anywhere` (a value said outside a form is kept, on a turn that opens no form or opens one that has the slot; not on a turn that opens a different form) or `call` (kept for the whole call, as app.yaml's `carrySlots` keeps it). An identity factor takes none. Any value but the default changes what the model is sent on some turns, so it re-keys a recorded cassette there. When to choose each is in section 5 of the [authoring guide](../authoring-an-app.md#where-a-slot-listens-listen).

### Proposing a value

Every slot also takes `offer: facts` beside its type's options: when the form would ask the slot and the app's facts have a value for it (`facts.offers` in the code, from what the call-start lookup found), the line proposes it as a yes or no (`offer_<slot>`, with the value as `{<slot>}`) in place of the question. A yes fills that slot and nothing else, never who the caller is; a no asks the slot's question. It needs app.yaml's `callerNumber` with a `lookup`, and is never on an identity factor. It changes what the model is sent on the offer turns, so it re-keys a recorded cassette there. See [Proposing a value from a lookup](../authoring-an-app.md#proposing-a-value-from-a-lookup-offer-facts) in the authoring guide.

### Locales

Every type reads and says en-US exactly as it did before there were locales. In a Spanish session (`es`, or any `es-*`) the types also read Spanish number words, names and dates and say values in Spanish formats, and a day-first keypad applies. `choice` options and a `text` slot's stand-in can be worded per locale in `locale/<tag>/slots.yaml`; a `text` slot's `pick` splits the words with the session's language's joining words and prepositions (English, Spanish, or the slot's own in `pick.words`); a `topic` slot says a topic by the title the knowledge base gives that locale. The questions the model reads are never translated. See section 7 of the authoring guide and the "Notes" of each page.

## Not yet in the library

| Type | Why it waits |
|---|---|
| `otp` (a one-time code) | Identity owns the code path (how a code is sent and checked), and a spoken code must be masked, reissued and never traced. It arrives with identity and the named policy rules in Phase 4, so the slot and the gate agree on one design. |
| `time-slot` (an appointment time) | An appointment time is asked by form state in the apps that have it today. Making it a slot would change every recorded request, so it waits for a deliberate re-record. |
| Name spelling | Letter-by-letter capture is its own set of questions, left until an app needs it. |

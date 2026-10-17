# 5. Writing a slot

[Contents](README.md) · Previous: [4. What stays in TypeScript, and why](04-what-stays-in-typescript-and-why.md) · Next: [6. The form hooks](06-the-form-hooks.md)

A slot is one value a form collects: a book, a day, a card number. The model never writes the value: it answers typed questions (yes or no, which of these labels), and the slot turns the answers into a value and decides whether it is good.

**Most slots are configuration.** Pick a type in `slots.yaml`, give it options, and the library supplies the questions the model is asked, how its answers become a value, the keypad, and how the value is said back. Write a slot in code only when no type fits. This section covers the types first, then what is true of every slot, then writing one in code.

### Pick a type in slots.yaml

The library has eight types. Each has a page with every option, its default, the default question text, the outcomes it can give, the prompts it needs and starter examples (the pages are [indexed here](../slots/README.md)):

| Type | It collects |
|---|---|
| [`digits`](../slots/digits.md) | A number of a fixed shape: an account, a library card, a tracking number |
| [`choice`](../slots/choice.md) | One of a fixed list: a delivery speed, a branch, a colour |
| [`date`](../slots/date.md) | A calendar day, ahead or back: a delivery, an appointment |
| [`birthdate`](../slots/birthdate.md) | A date of birth, heard whole or in part |
| [`name`](../slots/name.md) | The caller's own name |
| [`record`](../slots/record.md) | One of the app's own records, chosen by what the caller says of it |
| [`text`](../slots/text.md) | The caller's own words, kept as said |
| [`topic`](../slots/topic.md) | Which of the knowledge base's topics the caller asks about, from those retrieval nominates |

A slot is a key in `slots.yaml` with a `type` and that type's options. The common cases, each a few lines:

An identifier the caller reads out. The model says whether a number was stated and which span of the words is it; code turns the span into digits and checks them.

```yaml
card:
  type: digits
  noun: library card        # "Does the caller state a library card number ..."
  length: 8                 # a wrong length is invalid; the default pattern is exactly eight digits
  keypad: true              # eight keys after two spoken misses; needs ask_card_dtmf
```

One of a fixed list. The key is the value; the text after it is how the line says it.

```yaml
branch:
  type: choice
  keypad: true              # 1 for the first option, 2 for the second
  options:
    north: the North branch
    riverside: the Riverside branch
```

A list whose entries sound alike has an advanced tier (`disambiguate`, `hedge`, `help`): the clinic's provider slot in `apps/clinic/slots.yaml` uses all three.

An answer that ends the call, read back before it does. A misheard "I rent" should not turn a homeowner away, so that one option is read back as soon as it is said, and the other is left to the summary:

```yaml
ownership:
  type: choice
  options: { own: "you own it", rent: "you rent it" }
  confirmValues: [rent]     # "Just to check, you rent it?" (confirm_ownership); "own" waits for the summary
```

A day, ahead or back, and a date of birth. They are two types because a birth date is asked differently, masked, and held in part when the year is missing.

```yaml
pickupDay:
  type: date
  range: future             # or past: today or a day gone, up to two years back
  windows: true             # "next week" is held, and the slot asks which day
dob:
  type: birthdate
  keypad: true              # MMDDYYYY (DDMMYYYY in a Spanish session)
```

The caller's own name. `exclude` lists words that are never the caller's name (a title, the people they may be discussing), so a span holding one is never offered to the model.

```yaml
caller:
  type: name
  exclude: [dr, doctor, rivera, quinn]
```

One of the records a tool returned for this caller. The app gives the records to its slots from `facts.forSlots`; the model picks a label, and the value is the record's key.

```yaml
order:
  type: record
  from: orders
  key: ref
  label: "Order {ref}, {what}, placed {placed|day}"
```

Free words no list holds and no code can check. The words are the value; the summary says the stand-in (`say`), and the trace keeps only their length.

```yaml
note:
  type: text
  what: a note for the courier
  say: your note
```

An address the caller says in their own words. `pick` keeps only the part that is the address, and `numbers: digits` with `case: title` has code write the value a tool gets ("seventy six twenty five oak hollow lane" said, "7625 Oak Hollow Lane" sent), while the summary reads back the words as said (`say: null`), since text-to-speech reads "7625" as a quantity. The model is asked the same questions either way; the rules are English's, and a language without rules keeps the words as said.

```yaml
place:
  type: text
  what: the street address where the problem is
  say: null                 # the summary reads back the words themselves
  redact: none              # needed with say: null: the words are in the trace and the audit (or length-summarized, for words a model summarizes: guide 16.3)
  pick: { what: the street address }
  numbers: digits           # the value: number words as digits; ordinals ("fifth avenue") stay words
  case: title               # the value: all-lower-case words capitalized
```

What the type does not do for you:

- **The lines it says.** A type declares the prompts it may lead to (`ask_<slot>` and `ask_<slot>_retry` for every slot; `ask_<slot>_dtmf` with a keypad; `ack_<slot>` when a value is acknowledged; `disambiguate_<slot>`; a type's own named lines). You write them in `prompts.yaml`, and `pnpm check` says which are missing in every locale, and why.
- **The words the model reads.** Defaults are neutral (`Does the caller state a library card number ...`). To keep the words a recording was made with, or to name your own domain, write a text part as a literal: `text: { given: "..." }`, sent to the model exactly as written. `ids: { given: ... }` keeps a question id. A changed word is a changed model request, so a recorded cassette misses until it is recorded again.
- **Thresholds.** A type compares the model's numbers only to thresholds it reads by name. An option that names one (`fillAt`, a `hedge.threshold`) is checked when the app is defined; see "Thresholds" below.
- **Sensitive values.** The types that hold an identifier mask it by default: `digits` shows `...0417` wherever it leaves the turn and hands a transfer its last four; `birthdate` shows the year only. Turn that off (`redact: none`) only for a value that is no one's secret. Name the tool param and the prompt variable that carry the value exactly as the slot (`card`, `{card}`).
- **Another language.** The types read and say Spanish (`es`, `es-*`); a choice option's `say` and a text stand-in can be worded per locale in `locale/<tag>/slots.yaml` (section 8).
- **Reading a slot from code.** A slot built from a type is an ordinary `SlotSpec` with two more fields: `type` and `config` (the options as parsed, defaults filled in), so code can list a choice slot's options or read a record slot's key.

Every option is strict. A misspelt one is refused at its line, with the one meant:

```
slots.yaml:4:3  card.lenth  unknown key "lenth" under card  ->  rename "lenth" to "length"
```

An app that is not built from a folder gets the same slots from code: `defineSlot('card', { type: 'digits', noun: 'library card', length: 8 })` throws a `SlotConfigError` listing every problem. The library's `app.ts` does this for its three slots, and the clinic's `slots.yaml` is the complete example of a folder.

### Every slot listens on every turn

The engine asks the questions of every slot the turn listens for, not only the one it just asked about: inside a form, the form's slots (and, while an anonymous caller is still to be verified, the identity factors); outside a form, every slot the app has but one that listens only in its form (`listen: form`, below). That is what lets a caller volunteer several details at once, and lets "what do I have out on card 5552 0417" fill the card on the opening turn. Outside a form, what is heard for a form's slot is kept only for the form the turn opens: the turn routes, the form opens and fills from what was said for it. A turn that opens a form fills that form's slots (and, while an anonymous caller is still to be verified, the identity factors) and no others, whatever their `listen`: a day said for another form is not kept. A turn that opens no form (an informational answer, a declined offer of a person) keeps only what belongs to the call, the identity factors and the slots the app carries (`carrySlots`, or `listen: call`), and the slots that keep a value said anywhere (`listen: anywhere`); a topic or a day said in an informational question is not kept for a form asked for later, which starts from what is said then. It is true of library slots and slots in code alike, with one exception the app decides: a turn that gives a `text` slot its words while that slot is the one just asked for, and fills it, is that slot's content where the slot says `others: quiet`, and no other slot fills or changes from it, so a word in a dictated message ("could someone send it again") never replaces who the message is for; `others: listen` lets every slot listen there too, and `others: { listen: [howUrgent] }` lets only the slots listed (each a slot of a form that holds it, which `pnpm check` holds it to), such as how urgent a message is, read from the message itself ([docs/slots/text.md](../slots/text.md)). The default is `quiet` for a text slot that takes the whole answer as its content (no `pick`), and `listen` for one that picks part of a longer answer (`pick`: "14 Birch Lane, and there's a line down" gives the symptom too); an explicit setting wins. Whether that turn is read for requests at all is the slot's `commands`: by default (`ignore`, for a slot without `pick`) the turn at its own question is its words, whole, whatever its question reads, and no request in it is acted on (no intent, priority switch, repeat, request for a person or frustration rung; an aside is taken as words too), so "could you send me the updated spreadsheet" at "Go ahead with your message" is the message, read back for a yes or a no; the injection screen, silence, words the model cannot make out, a partial held and an unfinished answer joined still work as on any turn. `commands: { listen: [urgent, agent] }` acts on the intents listed there and takes every other turn as the words; `commands: listen` (the default with `pick`) reads the turn as any other, and then a turn at that question that gives no text ("oh, it's for Sam actually") is no dictation, and fills every slot ([docs/slots/text.md](../slots/text.md)). The questions are still asked; where a priority switch is acted on it corrects the form with what it said, and the form a turn switches to hears it whole. It has two consequences:

- A slot must give `absent` when the words say nothing about it. The library types do; a slot in code must.
- Adding or changing a slot changes the model's request on every turn where it listens, because its questions are in the request and every slot's display is in the turn state. A recorded cassette then misses until it is recorded again, which calls the paid model and is a deliberate step (the clinic's README, "Recording the cassette").

### Where a slot listens: `listen`

Every slot takes `listen:` beside its type's options: in slots.yaml, in `defineSlot`'s configuration, or on a slot written in code (`SlotSpec.listen`). It says what the slot does outside a form; inside a form that has the slot, it always listens. A slot that sets none listens as its forms say (forms.yaml `listenBeforeEntered`, [above](02-the-files-one-by-one.md#a-form-that-goes-on-to-the-next-next-and-internal-forms)): `form` when every form that lists it says `false` (the default for an internal form), `up-front` otherwise, so an app that sets neither listens as the table says.

| `listen` | Its question, outside a form | A value said outside a form |
|---|---|---|
| `up-front` (the default) | asked | kept only when the turn enters a form that has the slot: values said up front with the request. A turn that opens no form keeps none. |
| `form` | not sent | never taken: the form asks for it once it is open, even when it was said with the request |
| `anywhere` | asked | kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it and empties it as it closes. Not kept from a turn that opens a form without it (a known gap, below) |
| `call` | asked | kept, and it outlasts every form, for the whole call |

```yaml
firstDate:
  type: date
  range: future
  listen: form
```

When to choose each:

- **`up-front`** suits most slots. "Book a delivery window for tomorrow morning" has its day and time of day taken with the request, and an informational question that mentions a day leaves nothing behind for a later form.
- **`form`** is for a value whose words come up in other requests, to be heard only in answer to its own form. A payment arrangement's first payment date is one: "are you open on Saturday", a question about office hours, mentions a day, and the arrangement should never take it as the first payment. The slot's question is then not sent outside its form, and a date said with the request ("set up a payment plan starting Friday") is asked for again once the form is open.
- **`anywhere`** is for a value a caller often gives before saying what they want, which a later form should not ask for again: a reference number said at the greeting, an order number said with a question. That is how every slot behaved before a value said outside a form was tied to the form the turn enters.

  It does not reach across forms on the turn one opens. "Book me in for a Saturday morning", said on the opener of a line whose first form qualifies the caller and whose second books the day, opens the first form, and the turn fills only that form's slots: the Saturday and the morning are lost, with `anywhere` or `call` on them alike. A line that qualifies before it books does not meet this: make it one form, the qualifying slots first and the booking's after, with a check on each qualifying answer ([Checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)). The opener then opens that form and fills every slot of it, the day and the time included, and they are never asked. The engine's fixture for checks has the call (`day-and-time-up-front-kept`). A line with several screeners and one booking uses `next` instead ([A form that goes on to the next](02-the-files-one-by-one.md#a-form-that-goes-on-to-the-next-next-and-internal-forms)): the answers both forms list carry across, and the booking's own slots are asked once it is open.

  What is still lost is a detail for a second request named in the same breath: "where is my parcel, and book a delivery window for tomorrow morning" opens the tracking form and queues the window, and the window's form asks the day again when it is reached. Let it ask, pin it with a scripted call, and write it in the app's gaps; keeping such a value for a queued form is a known gap in the engine, held by a test so that a change to it is deliberate. `next` does not change this: a slot only the second form lists waits for that form, and listing it in the first form too would have the first form ask it, so do that only where the first form should ask it anyway.
- **`call`** is for a value that is the caller's rather than one task's: their name, their date of birth. It is what app.yaml's `carrySlots` does, and `carrySlots` is shorthand for it; a slot `carrySlots` names that says another `listen` is refused by `check`. A carried value pre-fills the next form that has the slot, so give a form that writes from one a summary.

An identity factor (identity.yaml) listens as identity says: while an anonymous caller is still to be verified, inside a form and out, and it stays for the call. `listen` does not apply to it, and `check` refuses it there. An unknown value is refused with the near one (`change it to "anywhere"`).

Any value but the default changes what the model is sent: `form` takes the slot's questions out of every turn outside a form, and `anywhere` and `call` keep values that then show in the turn state of later turns. A recorded cassette misses where they differ, so choose one with a deliberate re-record.

### A callback number: `callerNumber`

On a phone call the carrier almost always sends the number the caller is calling from, and ten digits is the most fragile answer a caller gives. A `digits` slot that holds a phone number can offer that number as a yes or no rather than ask for it:

```yaml
phone:
  type: digits
  noun: phone
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'        # +15555550142 becomes 5555550142; a number from another country is no number
```

and its line in prompts.yaml, in every locale (`pnpm check` requires it):

```yaml
offer_phone:
  text: Is the number you're calling from, ending in {last4}, the best one to reach you?
  interruptible: true
```

When the form would ask `phone` and the call came with a number that fits the slot, the line says `offer_phone` in place of `ask_phone`. `{last4}` is the number's last four digits, the only variable the line is given (it may leave it out: "Is the number you're calling from the best one to reach you?"). The offer is the slot's read-back, with the slot still empty:

| The caller | What happens |
|---|---|
| A yes ("yes, that's fine") | The slot holds the number, confirmed, as a keyed number is, and the form goes on. What else the yes said ("yes, and it's about an order") fills the form's other slots. |
| A no | `ask_phone`, with no attempt counted: the caller answered what was asked. |
| A number, with the no or without it ("no, use my cell, 555 555 0199") | The number fills as said, and the form goes on. A number the slot refuses (too short, the wrong shape) closes the offer and is retried as a missed answer to `ask_phone` (`ask_phone_retry`, or the slot's own retry line). |
| Silence, or words that answer neither | The offer again, as any read-back is asked again: each counts a turn, and the slot's keypad rung (`ask_phone_dtmf`, or `ask_phone_retry` for a slot with no keypad) comes as it would. |
| A number keyed | It fills as keyed. |

That is the default, `answers: yes-no-or-value`: the offer takes a yes, a no, or a number. An offer whose line asks only a yes or no question takes `answers: yes-no` ([Yes or no only](#yes-or-no-only-answers), below).

It is offered once per slot per form: a number reopened at the summary ("the number is wrong") is asked with `ask_phone`, not offered, whether or not it was offered before. A chat has no number, and neither does a call whose number came as a withheld placeholder, a withheld number the app ignores (app.yaml's `callerNumber.withheld: ignore`), or one that does not fit, so there the slot is asked as always; a number the caller withheld that the carrier sent anyway is offered as any other by default ([13.13](13-channels.md#1313-the-number-the-caller-is-calling-from) says what counts as a number, and where each carrier puts it).

What the option promises, and what it does not:

- **It is never identity on its own.** A caller ID can be forged. `pnpm check` refuses `callerNumber` on an identity factor: offering a value for a yes is no verification. Here it only fills a callback number the caller said yes to. (A gated lookup by it may propose a value: [The number the caller is calling from](02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber). An app may let a caller-ID match identify an account, filled silently and verified by a knowledge factor the caller gives: [A caller-ID match as the identifier](03-policy-and-identity.md#a-caller-id-match-as-the-identifier-callerid).)
- **It is never used silently.** Only the caller's yes fills the slot. A switchboard, a shared line or someone else's phone is the caller's to correct, which is why the line asks.
- **It is said in part, unless the app says it whole.** The offer's line has the last four digits (`{last4}`) and the whole number as the slot displays it (`{callerNumber}`); which it says is the line's. The model is told only what the line says ("the number they are calling from, ending in 0142"). Where the line says only the last four, the whole number is said only where the form's summary reads the slot back, so `pnpm check` warns when a form with the slot has no summary.
- **It is masked as the slot is.** Once filled, it is the slot's value: a `digits` slot's default `redact: last4` masks it in the trace, the gate events and the audit, and a transfer hands it over by its last four. The start event's number (`SessionStart.callerNumber`) is masked on the console and in the frame log as app.yaml's `records` writes a caller's number (its last four by default), and in the trace file as the slot masks its value, as is the setup's own copy of it in the start event's provider details (Twilio's `from`, Telnyx's `param.telnyx_call_from`). The offer line's `{callerNumber}` is masked in the trace as the slot masks its value too. Every app's session keeps the number as the call's data; the trace's first record of an app that acts on it says `callerNumber: kept`, `ignored` or `none`, so a builder can see why no offer was made.

A slot kept for the call (`listen: call`, or app.yaml's `carrySlots`) is offered in the first form that asks it and, once filled, keeps its value: `pnpm check` warns so that it is meant.

Every offer the caller settles writes an `offer` row to the audit ([A text offer](#a-text-offer-onno-and-ifnone), below, says what it holds).

Testing it: a scripted call takes `"callerNumber": "+15555550142"` as a carrier sends it (a withheld one as the carrier writes it: Twilio's placeholder, or the number with `"callerWithheld": true` as Telnyx marks it), which reaches every call, never a chat; the text CLI takes `--caller-number`. A corpus line at the offer is in the form's context, `prompted` the slot, with `confirm` (`yes`, `no` or `unanswered`), as a summary's line is. Turning it on changes the model's request on the offer turn (the pending read-back is in its turn state), so a recorded cassette misses there until it is recorded again. The frame log keeps only the number's last four, on a line of its own (`{"callerNumber": "…0142"}`, with `"callerWithheld": true` for a number the caller withheld, written when the session kept the number), and replaying a logged call stands a made-up number ending in those four in for it (the shortest in the 555 range the slot takes), so the replay makes the offer the call made, with the same line and the same request to the model; after a yes the slot holds the stand-in, which the trace masks to the same last four, so a later turn's request, which shows the model the slot, is not the call's. A log written before that line replays with no offer. The engine's own fixture is `packages/dialogwright/src/testing/callback`.

### A number on the phone: `sayAs` and `waitForRestMs`

Two things a `digits` slot does on the phone, each with a default:

```yaml
account:
  type: digits
  noun: account
  length: 8
  group: [4, 4]
  sayAs: digits          # the default; number for a quantity the voice may read as a number
  waitForRestMs: 1500    # the default; 0 takes the words at once
```

**Said back digit by digit (`sayAs`).** A text-to-speech voice reads "0142" as "one hundred forty-two" and an account number as a number in the millions. So wherever a line says the slot's value (a read-back, the form's summary, a line worded by a model, a repeat of the last line, a line of the app's own code), the last four of the caller's number at its offer, or the consent to text, the voice is sent each digit, with a short pause between the display's groups: "Account 5552 0417" goes out as "Account 5 5 5 2, 0 4 1 7". Only the text sent to the voice changes, as for app.yaml's `voice.spokenDigits` and `voice.pronounce` ([13.8](13-channels.md#138-a-caller-who-had-not-finished-and-how-a-word-is-said)): the session, the trace, the console, a chat and the regression baselines keep the line as written. The engine finds the value in a line by the value itself (the slot's value and display, a value read back or offered, the last four offered), whole, never inside a longer number, so a line needs no marking. An app's own `spokenDigits` rules run first, and a value they spelled out stays as they spelled it. `sayAs: number` leaves the value to the voice.

**A number said with a pause (`waitForRestMs`).** A recognizer ends a prompt at a short pause. A caller reading an account number off a card says "five", looks again, and says the rest: the engine is sent "Five." as a whole answer. Taken alone it is a miss, and its re-ask goes out as the caller goes on. Seen on a live call (Telnyx, barge-in off): after a nine-digit miss, "Five." got the keypad line, the caller spoke over it 235 ms later, and Telnyx, which does not transcribe while a line it may not interrupt is playing, heard none of the rest. So when the slot the caller was just asked has a `length`, and a final prompt's words hold, read without the model, at least one digit and fewer than `length`, the voice server holds the words, before any turn runs, for up to `waitForRestMs`:

- A prompt in that time is joined to them ("Five. five five two zero four one seven." is 55520417), and runs no turn of its own. While the words joined are still fewer digits than `length`, the wait starts again (a number said in fours, pairs or single digits is joined whole, up to ten prompts); once they are not, the turn runs at once.
- The caller heard speaking (a carrier that reports it, Telnyx) stops the clock until they stop, and it then starts again whole, for their transcript; on Twilio a partial prompt starts it again.
- Nothing more, or speech with no prompt after it (a cough): the words run alone, as they would have, a little later.
- Words, then keys: a digit keyed, for a slot that takes keys (`keypad`), drops the words (a `#` or a `*`, or a key for a slot that takes none, is no answer, and leaves the hold as it is). The caller has gone to the keypad, and the keys answer the question already asked, taken as keyed at it (were the words run first, their re-ask would be said, and the keys keyed over it refused). The socket gone (a hang-up, a reconnect) drops them too; a reconnect asks its question again, as always.

One turn runs, on the words as held: nothing is said and taken back, no attempt is counted twice, no silence turn runs over the hold, and it works at every rung of the slot's ladder, the keypad line and the last attempt included. It is on every carrier, whatever `continueWithinMs` and `INCOMPLETE_WAIT_MS` say; a chat, where a message comes whole, never waits; a slot with a `mask` and no `length` never waits (it knows no least length), nor does a number as long as the slot's or longer, which is taken or refused at once (a carrier that heard eight digits as nine is still refused and asked again). The frame log has `{ wordsHolding: { slot } }` when the hold starts and `{ wordsHeld: { slot, ms, fragments, end } }` when it ends, before the turn (with `dropped`, the words with their digits masked, where none runs), which replay follows as logged, whatever the app's settings are then. The hold is in memory: a server restarted during it has lost the words, and the caller is asked again; replay runs no turn on words whose hold the log never saw end, and says so; the turn's record names the prompts it joined (`joined: { fragments: [...], waitedFor: account }`), and the console notes the join with the hold. Why 1500 ms: words of fewer digits than the number are certainly not a whole answer, so waiting costs only a miss taken a little later, and a caller reading a number pauses longer than one finishing a sentence (`INCOMPLETE_WAIT_MS`, for words the model reads as unfinished, is 1000).

### A bare name: `bareAnswer`

A caller who answers the name question with only a name ("Jordan Avery") gives the model's yes-or-no question ("does the caller state their own name?") little to go on: on a live call it read 0.41, under `SLOT_DETECT`, while the span question was 0.74 sure "jordan avery" was the name, and the caller was asked again. So right after the question (the slot the one just asked), a short answer whose chosen span the model is sure of is taken as the name given:

```yaml
caller:
  type: name
  bareAnswer: { words: 4, given: NAME_BARE_GIVEN, span: NAME_BARE_SPAN }   # the defaults; words: 0 turns it off
```

`words` is the most words the answer may have ("it's Jordan Avery" is three); `span` the threshold the span's probability must reach (`NAME_BARE_SPAN`, 0.7); `given` the threshold the yes-or-no must still reach (`NAME_BARE_GIVEN`, 0.2), so an unsure yes-or-no is overruled and a confident no never is. Each is an engine threshold or one of the app's own (app.yaml `thresholds:`), read by name like every other. Anywhere else (a turn the slot was not just asked, a longer answer) the yes-or-no decides, as always, so a name said in passing, which may be someone else's, is never taken on the span alone. The questions are the same either way, so a recording made before the option reads the same.

### A text offer: `onNo` and `ifNone`

A callback number is a slot the form needs: a no to the offer asks for another. An offer to text the caller ("Can I text you updates at the number you're calling from?") is one the caller may turn down, and a no means no text. Two options of the `callerNumber` offer say so:

```yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'
    onNo: skip      # ask (default): a no asks ask_<slot>. skip: a no leaves the slot empty.
    ifNone: skip    # ask (default): no number to offer asks ask_<slot>. skip: the slot is left empty.
```

```yaml
offer_textTo:
  text: Can I text you updates at the number you're calling from, ending in {last4}?
  interruptible: true
```

- **A skipped slot is declined**: empty, but answered, so the form does not ask it and goes on (`SlotState.declined`). Its completion sees no value and sends nothing. A number said instead ("no, text my cell, 555 555 0199") still fills the slot as said, as does a number keyed; a declined slot reopened at the summary ("the text number is wrong") is asked, never offered.
- **`onNo: skip`.** A no, and the end of the offer's retry ladder (silence, or answers that are neither yes nor no, until the ladder would leave the offer), leave the slot empty: a text nobody agreed to is not worth a person. With `ask`, a no asks `ask_<slot>` with no attempt counted, and the ladder goes on to the slot's own rungs, as for a callback number.
- **`ifNone: skip`.** A call with nothing to offer (a chat, a withheld placeholder or a withheld number the app ignores, one that does not fit the slot, or one the app will not offer, below) leaves the slot empty. With `ask` the slot is asked as always.
- **The summary.** A slot that may be left empty is never named in its form's summary line as `{<slot>}` (`pnpm check` refuses it: the line would read nothing there). Read it back from a line of its own when it is filled: the form's `onSummaryRead` hook returns that line's `promptId` ("That's a request about an order, with updates texted to 555 555 0142. Shall I open it?"), and the summary's yes, keypad and ladder work there as on the summary itself.

**Required or optional.** An offer is required or optional by its `onNo` and `ifNone`, and nothing else is needed:

- **A required offer** keeps the defaults, `onNo: ask` and `ifNone: ask`: the number to send a one-time code to, or to call back. A no asks the slot's own question; with no number to offer, the slot is asked; and the slot's ladder ends at a person, so the form never reaches its summary without a value. The callback fixture's `offer-required-no-then-nothing` call pins it: a no, then nothing said, ends at a person.
- **An optional offer** says `onNo: skip` (and usually `ifNone: skip`): an appointment reminder, updates about a request. A no, or no answer, leaves the slot empty and the form goes on.

#### Yes or no only: `answers`

What an offer takes follows its question. "Shall I use the number you're calling from, or tell me another?" takes a yes, a no or a number: the default, `answers: yes-no-or-value`. "Are you calling from the phone on the account?" asks a yes or no question, and a number said there is more likely a slip than an answer: `answers: yes-no` takes a yes or a no only.

```yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'
    onNo: skip
    answers: yes-no   # yes-no-or-value (default): a number said or keyed fills as said
```

With `yes-no`, at the offer:

- the slot offered takes no value from the turn: "no, text my cell, 555 555 0199" is a no, and the number is not taken (the model is still asked the slot's question, as at a default offer, so the engine can tell a value was said);
- a value said with no clear yes ("text 555 555 0199 instead") is a no as well, so `onNo` says what follows (`ask`: the slot's own question, which takes the number as always; `skip`: the slot is left empty), and the `offer` row's `answer` is `no`;
- on the keypad, a 1 alone is yes and a 2 alone is no. Each key is held, and the keys are one answer once they stop (`KEY_WAIT_MS` after the last, default 2 s) or when `#` ends them; anything else (another key, a number keyed in full) asks the offer again once, a turn on its ladder, and nothing is recorded of the keys, so no key of a keyed number answers the next question;
- the other slots of the form still listen as always ("yes, and it's about an order");
- the line's options are yes and no, as before.

A proposal from the facts takes the same choice as `offerAnswers` beside `offer: facts` ([below](#proposing-a-value-from-a-lookup-offer-facts)). The default changes nothing: an app that sets neither is as it was.

**Refusing an offer: `App.callerOffer`.** A landline cannot take a text. The app's code may refuse an offer with `callerOffer(ctx, slot)`, called only when an offer is about to be made (the form would ask the slot, and the call has a number that fits it), once per slot per form. False makes no offer, and the slot goes on as `ifNone` says. It may read the facts (a line type the call-start lookup found), or call a gated tool through `ctx.callTool` (a line-type lookup, its param held to the caller's number by the `callerNumber` rule) and keep the answer in the facts. One that throws makes no offer, as false does: what it wrote to the facts is put back, the side effects it queued are dropped, and nothing of the error is kept. Without it, every offer is made. With [`textConsent`](#consent-to-text-for-the-whole-call-textconsent) it is also called at the greeting, with no form open, for the covered slots in turn until one is allowed, and again at each covered slot after a grant, before the slot is filled from it. The engine does not remember its answers: a hook that calls a tool keeps the answer in the facts and reads it there the next time, as the example below could (the texting fixture's keeps the line type).

```ts
export const code: AppCode = {
  // ...
  callerOffer(ctx, slot) {
    if (slot !== 'textTo') return true;
    const caller = callerOf(ctx.s);
    if (caller === null) return false;
    const { decision, value } = ctx.callTool({ tool: 'lineType', params: { callerNumber: caller.number } });
    return decision.verdict === 'ALLOW' && (value as { lineType?: string } | null)?.lineType === 'mobile';
  },
};
```

**Sending the text.** The app's own tool sends it, from the form's completion, with the slot's value as its param, and only when the slot holds one. Hold that param with the `callerNumber` rule ([3.3](03-policy-and-identity.md#33-the-built-in-rules)): `callerNumber: { field: textTo }` sends only to the caller's own number; `else: confirmed` sends to a number the caller confirmed at the summary too.

**What is recorded: the `offer` row.** Every offer the caller settles, a callback number's, a text's, a proposal's ([below](#proposing-a-value-from-a-lookup-offer-facts)), writes one row to the audit, in the day's hash chain, so `pnpm audit:verify` covers it:

```
type: offer
detail: { slot: textTo, source: caller-number | facts, promptId: offer_textTo,
          said: "Can I text you updates at the number you're calling from, ending in 0142?",
          answer: yes | no | other | none | consent, by: speech | keypad | null, last4: "0142", locale: en-US }
```

(`last4` is the number's; a proposal from the facts has none.)

`said` is the line as it was said, since the prompt manifest may change later. `answer` is `yes` (the number offered), `no` (a no with no number of the caller's own; at an offer that takes a yes or a no only, a number with no clear yes too), `other` (a number of their own, said or keyed, with or without a no), `none` (no answer before the ladder left the offer; `by` is then null) or `consent` (no offer was asked: the caller granted consent to text for the whole call, and `promptId` and `said` are that question's; `by` is null: [below](#consent-to-text-for-the-whole-call-textconsent)). An offer asked again is not settled yet, and one dropped unanswered by a switch to another task or a handoff writes no row. A caller who had not finished ([13.8](13-channels.md#138-a-caller-who-had-not-finished-and-how-a-word-is-said)) can settle one offer twice, "yes" and then "yes, and it's about an order" joined: the fragment's row stays, and the joined turn's row follows it, so the last row for a slot in a call is the answer. The text tool's own row (its gate row, with the slot's param masked) follows when the form completes.

**Consent is the owner's question.** Whether a spoken yes on this line is consent to be texted, under the TCPA or any other law, is a legal question for the line's owner, and the answer differs between informational and marketing texts. The engine records what was asked, in the words said, and what was answered. It does not decide that the answer is consent, and it sends nothing on its own.

Testing it: a corpus line at the offer has `confirm` `yes`, `no` or `unanswered` as for a callback number; write one for each answer a caller gives there, "that's my landline" among them. The engine's own fixture is `packages/dialogwright/src/testing/texting`; its `variant.ts` builds the `answers: yes-no` variants.

#### Consent to text for the whole call: `textConsent`

A line that texts helpful links at several moments of a call can ask once, up front, rather than at each moment:

```yaml
# app.yaml
textConsent:
  covers: [textTo, reminderTo]   # slots that offer the caller's number (callerNumber), which the consent stands in for
```

```yaml
# prompts.yaml (every locale)
greeting_offer:
  text: Thanks for calling Example Requests.
  interruptible: true
consent_texts:
  text: Can I text you helpful links during this call, at the number ending in {last4}?
  interruptible: true
greet_after_offer:
  text: What can I help you with today?
  interruptible: true
```

- **When it is asked.** Once, on a call, right after the greeting's line (`greeting_offer`), in place of the open question, when the session kept the caller's number, for the first slot in `covers` that can take it (its `countryCode`, `length` and `mask`) and that the app's `callerOffer` hook allows (asked for each in turn, at the greeting, with no form open); with none, it is not asked. Never on a chat, and not on a call whose number is withheld, foreign or refused: each slot then asks its own offer as without it. Only one question follows the greeting, in this order: the caller-ID question (identity.yaml's `callerId` with `ask: greeting`), then consent, then a proposal at the greeting (`offerAt: greeting`). One not asked at the greeting is asked where it would be anyway: a proposal at its slot, identity when it is needed; consent not asked at the greeting is not asked, and each slot asks its own offer.
- **A yes** (or the keypad's 1, alone: keys are held and taken as one answer, as at an offer that takes a yes or a no only) is the grant: `greet_after_offer` asks the open question, or a request said with the yes goes on. From then on, each slot it covers, when its form would offer the caller's number, is filled with that number, confirmed, with no question (the `callerOffer` hook is still asked for it, so a slot it refuses is not filled), and the form goes on: the form's checks run on the value, and its summary reads it back whole, as after a yes to the slot's own offer. The gate's `callerNumber` rule passes it as the caller's own number. A slot reopened at the summary ("the text number is wrong") is asked its own question, not filled again; a later form fills it again.
- **A yes that names another number** ("yes, text 555 555 0199") is no grant to the number the question named: it is asked once more, and if the answer is still not a plain yes or no, consent is unknown (`granted: null`) and each slot asks its own offer. A yes that names the caller's own number is a yes.
- **A no**, a number with no yes, or the keypad's 2, declines it, and each slot asks its own offer, accepted or declined as always (its `onNo` and `ifNone` as written).
- **A request said instead, or no answer** (asked once more, then the open question): consent is unknown, not asked again, and each slot asks its own offer.
- **Recorded every time it is granted.** The answer is a `consent` row in the audit's hash chain:

  ```
  type: consent
  detail: { scope: call, granted: true | false | null, promptId: consent_texts,
            said: "Can I text you helpful links during this call, at the number ending in 0142?",
            last4: "0142", by: speech | keypad | null, locale: en-US }
  ```

  and each slot filled from the grant writes an `offer` row with `answer: consent`, the consent question's line as `said`. A yes at a slot's own offer is recorded by its `offer` row, as always.
- **Reading it.** App code reads the answer with `textConsentOf(s)` (from `'dialogwright'`): `granted`, `declined`, `unknown`, or null when it was never asked. A caller who later says "stop texting me" is the app's to handle, with an intent of its own; the engine does not withdraw the grant.

The consent is a yes or no question: a value said with it is not taken (as `answers: yes-no`). Whether a yes on this line is consent under any law is the line's owner's question, as for a single text offer ([above](#a-text-offer-onno-and-ifnone)). `pnpm check` refuses a slot in `covers` that is not one or does not offer the caller's number, needs `greeting_offer`, `consent_texts` (saying `{last4}` and nothing else) and `greet_after_offer` in every locale, and warns when no form asks a slot `covers` names.

Testing it: a corpus line at the consent question is in the `no_form` context with `confirm` and no `prompted`, seeded as a call asks it: from the seed's number (`testing.seed.callerNumber`), its call-start lookup, and the slot a call would choose: write a yes, a yes with a request, a no, a yes that names another number and a request with neither. An app that turns `textConsent` on changes the request the model is sent on the turns at the consent question (its pending question is in the turn state), so a recorded cassette misses there until it is recorded again; `answers: yes-no` alone sends the model what a default offer sends. The engine's fixture is the consent variant of `packages/dialogwright/src/testing/texting` (`variant.ts`: two numbers to text, both covered).

### Proposing a value from a lookup: `offer: facts`

The call-start lookup ([The number the caller is calling from](02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber)) may find something the caller would otherwise have to say: the street on the account for the number calling, say. Any slot can propose it as a yes or no in place of its question:

```yaml
# slots.yaml
place:
  type: text
  what: the street address where the problem is
  say: null
  redact: none
  offer: facts    # propose a value from the facts in place of ask_place
```

```yaml
# prompts.yaml (every locale)
offer_place:
  text: I see an account for the number you're calling from. Is this about {place}?
  interruptible: true
```

```ts
// src/app.ts, the facts: keep what the lookup found, and propose it
facts: {
  initial: () => ({}),
  clone: (f) => ({ ...f }),
  fromCallerLookup(f, value) {
    const street = (value as { serviceAddress?: unknown } | null)?.serviceAddress;
    if (typeof street === 'string') (f as Facts).serviceAddress = street;
  },
  offers: (f) => ((f as Facts).serviceAddress ? { place: { value: (f as Facts).serviceAddress!, display: (f as Facts).serviceAddress! } } : {}),
},
```

When the form would ask `place` and `facts.offers` has a candidate for it, the line says `offer_place` in place of `ask_place`, with the candidate's display as `{place}`, the only variable it is given. By default it is made at the slot, inside the form (`offerAt: slot`), so the caller has said why they called before anything looked up is said back; `offerAt: greeting` makes it at the greeting instead ([below](#at-the-greeting-offerat-greeting)). The offer is the slot's read-back, with the slot still empty, and the caller answers it as they answer a callback number's ([A callback number](#a-callback-number-callernumber)):

| The caller | What happens |
|---|---|
| A yes ("yes") | The slot holds the value, confirmed, and the form goes on. What else the yes said ("yes, and nothing works at all") fills the form's other slots. |
| A no | `ask_place`, with no attempt counted. |
| Another value, with the no or without it ("no, I'm at my mother's, 7 Birch Lane") | It fills as said, and the form goes on. |
| Silence, or words that answer neither | The offer again; each counts a turn, and the slot's ladder (its keypad rung, or `ask_place_retry`) comes as it would. |

A proposal whose line asks only a yes or no question ("Are you calling about the account ending in 1234?") takes `offerAnswers: yes-no` beside `offer: facts`: another value said at it is not taken, and with no clear yes it is a no (`ask_place`); on the keypad 1 is yes and 2 is no; at the greeting, a value said is a no and the open question follows. The default, `yes-no-or-value`, is the table above ([Yes or no only](#yes-or-no-only-answers)).

It is offered once per slot per form: a slot reopened at the summary ("the address is wrong") is asked, never proposed again. With no candidate (the lookup found nothing, was refused or failed, a withheld number, a chat, a value already said with the request) the slot is asked as always.

The facts need not come from the call-start lookup. `facts.offers` reads whatever the session's facts hold when the slot is asked: the call-start lookup's, what a form's entry call loaded once the caller was verified (`onEntry`), or what a hook put there. A form whose entry call needs identity and loads the account (its street, its last order) can propose from it for a later slot, and an app with no `callerNumber` lookup at all can propose. The engine's fixture is the later-facts variant of `packages/dialogwright/src/testing/proposals` (`variant.ts`).

What it promises, and what it does not:

- **A yes fills that slot and nothing else.** It is a slot's confirmation, never verification: the principal, the identity level and the identity attempts do not change, and an action that needs identity still asks for the factors. `pnpm check` refuses `offer: facts` on an identity factor, beside `callerNumber` on one slot, and on a slot redacted by its length (`redact: length`, a statement whose words are never said back; a text slot that proposes takes `say: null` and `redact: none`, as the example does).
- **One that throws proposes nothing.** A `facts.offers` that throws leaves the slot to be asked as always, and nothing of the error is kept.
- **What it says is the app's call.** A proposal from the call-start lookup's facts is said to whoever is holding, or forging, the number, before they prove anything: only what the lookup's level 0 action returns can be there. The usual advice is the least that works (a street to propose, rather than a balance, a claim or a name), naming the record no more than the line needs ("I see an account", rather than whose). A proposal from facts loaded after identity is said to a verified caller.
- **The model is told what the line said.** The pending read-back in its turn state is the display, before the caller has proven anything, and nothing else of the facts; the slot is empty in it until the yes. So the display is sent to the model as it is said to the caller: return nothing from the lookup you would not have said. An app that turns `offer: facts` on changes the request on the offer turns, so a recorded cassette misses there until it is recorded again; an app that does not is unchanged.
- **The summary still reads it back** before anything is written.

Every settled proposal writes an `offer` row to the audit, as the caller's number's does, with `source: facts` and no `last4`. Its `said` writes the proposed value as the slot's value is recorded (its `redact`, else policy.yaml's `audit:`), so a slot masked by its length shows only that there.

`pnpm check` needs `facts.offers` in the code, and `offer_<slot>` in every locale saying `{<slot>}` and nothing else. It does not need a call-start lookup: the facts may be loaded later.

#### At the greeting: `offerAt: greeting`

```yaml
# slots.yaml
place:
  type: text
  what: the street address where the problem is
  say: null
  redact: none
  offer: facts
  offerAt: greeting   # slot (the default) or greeting
```

```yaml
# prompts.yaml (every locale)
greeting_offer:
  text: Thanks for calling Example Service Desk.
  interruptible: true
greet_after_offer:
  text: What can I help you with today?
  interruptible: true
```

On a call, after the call-start lookup, the first slot in slots.yaml order with `offerAt: greeting` that some form asks and that `facts.offers` has a candidate for is proposed at once: `greeting_offer` (the greeting without its open question) and then `offer_place`, in place of the greeting and its "How can I help?". One greeting proposal per call. With no candidate, a chat (no number was looked up) or no such slot, the greeting is as always, and the slot proposes at the slot as `offerAt: slot` does, where the facts have a candidate by then. An app whose identity.yaml asks the caller-ID question at the greeting (`callerId` with `ask: greeting`) opens on that instead, on a call with a match, and the proposal is made at its slot ([A caller-ID match as the identifier](03-policy-and-identity.md#a-caller-id-match-as-the-identifier-callerid)).

| The caller | What happens |
|---|---|
| A yes ("yes") | The slot holds the value, confirmed, and `greet_after_offer` asks the open question. The value is kept on the call for whichever form uses the slot, even after another form first, and that form does not ask it. |
| A yes with a request ("yes, I'd like to report a problem") | The slot is filled, and the request goes on as the opening request: its form opens with the slot filled. |
| A no, with or without a request | Nothing is filled; the request goes on, or `greet_after_offer` asks the open question. The slot is asked, not proposed, in its form. |
| A value of the caller's own, with a no or without one ("no, I'm at my mother's, 7 Birch Lane") | It fills the slot as said, whatever the slot's `listen` (it answered the question asked), and `greet_after_offer` asks the open question, or the request goes on. The form does not ask it. |
| A request with neither, an informational question, a choice between two | The proposal is dropped, not repeated, and the turn goes on as the opening turn it is. |
| Silence, or words that answer neither | The proposal once more, then `greet_after_offer`; no attempt is counted. |

A priority intent ([Must never wait](02-the-files-one-by-one.md#must-never-wait-priority)) takes the turn before the proposal's answer is read, as it takes any turn: "yes, and there's water coming through the ceiling" opens the priority form, and the yes is not kept (the slot is asked, not proposed, in its form).

The `offer` row records a yes, a no, a value of the caller's own (`other`) and a proposal dropped unanswered by silence (`none`); one dropped by a request writes none, as at the slot. Once the first form that has the slot closes, a later form may propose at the slot again. On the debug table, the turn's request read again shows as `opening:` rows beside the turn's own, never credited with deciding it. `pnpm check` needs `offer: facts` beside `offerAt`, and `greeting_offer` and `greet_after_offer` in every locale; app.yaml's `prompts.greetings.offer` names another line for `greeting_offer`. It warns of `offerAt: greeting` with no `callerNumber` lookup, since nothing has loaded the facts by the greeting then.

Testing it: a corpus line at the greeting's proposal is in the `no_form` context, `prompted` the slot, with `confirm` (`yes`, `no` or `unanswered`, and the `intent` of a request said with it), seeded with the slot's placeholder proposed after the greeting's line: write a yes, a yes with a request, a no, a no with another value and a request with neither. The engine's fixture is the greeting variant of `packages/dialogwright/src/testing/proposals` (`variant.ts`).

The greeting's own variables (`{facts.<key>}` in a greeting line) are not built yet: prompt variables are plain names.

Testing it: a corpus line at the offer is in the form's context, `prompted` the slot, with `confirm` (`yes`, `no` or `unanswered`), seeded with the slot's placeholder proposed; write a yes, a bare no, a no with another value, another value alone and words that answer neither. A scripted call from a number on file (`"callerNumber"`), one not on file, a withheld one and the chat. Replay stands in a number with the last four the frame log kept, so key the lookup's fixture by those. The engine's own fixture is `packages/dialogwright/src/testing/proposals`.

### When a slot runs out: `attempts` and `onMaxAttempts`

A slot is asked until it is answered or runs out of attempts. Every slot, library or code, may say how many failed answers it takes, what each re-ask says, and what happens when it runs out. None of it is required: a slot that says none of it is asked as it always was, and goes to a person when it runs out.

```yaml
accountId:
  type: digits
  noun: account
  length: 8
  keypad: true
  attempts: 4                    # 1 to 10; default the engine's MAX_ATTEMPTS (3)
  onMaxAttempts: { then: handoff, reason: account-lookup }
referral:
  type: choice
  options: { friend: a friend, online: online, other: somewhere else }
  attempts: 2
  onMaxAttempts: { say: referral_skipped, then: skip }
planType:
  type: choice
  options: { basic: the basic plan, plus: the plus plan }
  onMaxAttempts: { say: plan_help, then: form, form: plan_help }
```

**The ladder.** With `attempts: N`, failures 1 to N-2 re-ask the question, failure N-1 is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad (otherwise another re-ask), and failure N runs `onMaxAttempts`. `attempts: 3` is the ladder every slot had before; `attempts: 1` runs the outcome at the first failure; `attempts: 2` goes to the keypad rung at the first. A slot without its own `attempts` follows the run's `MAX_ATTEMPTS` (`--threshold MAX_ATTEMPTS=4`), as it always has. The intent's ladder and the one-time code's are not slots and keep theirs.

**What counts as a failure.** A missed answer, a silence, a key that is no answer, and a read-back left unanswered each walk the ladder one step. A no to the slot's own read-back is one step too for a library slot (its `readBackNo: ask`); a slot written in code that reads back with no `readBackNo` goes straight to its keypad rung on the first no, as it always has. Every way a slot runs out takes the same outcome, and a second no to the slot's read-back runs it at once (the read-back's own count of two stays). An offer of the caller's number with `onNo: skip` that runs out leaves the slot empty whatever `onMaxAttempts` says ([A text offer](#a-text-offer-onno-and-ifnone)); with no `onNo: skip`, the slot's ladder goes on to its outcome.

**What each re-ask says.** Every line is optional and falls back as before:

| The turn | Says, the first the app has |
| --- | --- |
| A missed answer at failure k | `ask_<slot>_retry<k>` (`ask_<slot>_retry2` is the second re-ask), `ask_<slot>_retry` |
| A silence at failure k | `ask_<slot>_noinput<k>`, `ask_<slot>_noinput`, else `no_input` then `ask_<slot>`; at the keypad rung of a slot that takes no keys, on a channel with a keypad, `no_input` then its retry line (`ask_<slot>_retry<k>`, else `ask_<slot>_retry`) |
| The keypad rung | `ask_<slot>_dtmf`, as always |

A `_noinput` line is the whole turn ("Sorry, I didn't hear anything. What's your account number?"): it takes the place of both the `no_input` line and the question. A slot holding part of a value (a date pending its day) is asked for the rest, whatever numbered lines there are. A line the slot's own reason gives (a `retryPromptId`, "That's not a date we have") still wins over a numbered retry. Each line is said as written, with no variables.

**What follows** (`onMaxAttempts`, the same outcome a form's check takes, [Checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)):

| `onMaxAttempts` | What the caller hears, and what follows |
| --- | --- |
| `handoff` (the default) | `handoff_max_attempts`, and a person. |
| `{ then: handoff, reason: <reason> }` | `say` if given, then `handoff_<reason>` (in piece 2, the transfer target too). |
| `skip`, `{ say, then: skip }` | `say` if given; the slot is left empty and declined, and the form goes on to its next question. The completion sees no value. |
| `{ say, then: end }` | `say` (required), and the call ends, the app's `goodbye` line after it (`goodbye: false`: on `say` alone, for a line that says goodbye itself); with a request queued, `say` is said word for word and the call goes on to it, the slot asked afresh there, so keep a goodbye out of `say` unless no request can be queued. |
| `{ say, then: anything-else }` | `say` (required); the form closes uncompleted, and the call goes on to a queued request, or "anything else?". An identity factor asked at the greeting (callerId `ask: greeting`) sets identity aside and asks the open question (`greet_after_offer`) instead. |
| `{ say, then: form, form: <form> }` | `say` if given; the form closes uncompleted and `<form>` is entered, as a `next` enters it: the slots both forms list are kept, the rest emptied, and `bridge_next` says the new form's label before its first question. An internal form an outcome enters is reached, as one a `next` names is, and so is one an identity factor's outcome enters. |

**What `pnpm check` holds you to.** It refuses only a broken app: a `form` that is not in forms.yaml, or that lists the slot itself (it would be asked there again, and run out there again); a `say` or a handoff line missing from prompts.yaml in any locale; `end` or `anything-else` with no `say`; `reason` without `then: handoff`; `skip` on an identity factor (verification could never finish) or on a slot its form's summary names as `{<slot>}` (read it back from a line of its own when it is filled, as for [a text offer](#a-text-offer-onno-and-ifnone)); and `attempts` outside 1 to 10. It warns, never refuses, of a form's check that reads a slot that may be skipped (the check runs only once every slot it reads holds a value, so it never runs then); of a numbered line the ladder never reaches (a re-ask is failure 1 to N-1); of forms that send each other round in a loop by their outcomes and `next` (it may be meant, where each pass reads values the caller can change); and of an identity factor whose outcome enters a form that needs identity (the caller, still not verified, would be asked the factor again there).

**A loop within one turn.** Forms whose outcomes send each other back (a check in each that refuses the same value, a form with no slots whose `next` leads straight back) would go round for ever on one turn. The engine sends such a call to a person instead (`needs-human`) the moment a form it has already left or entered by a move on that turn is entered again, and the trace says which form closed the loop (`formLoop`).

**What is recorded.** The trace has the `slot_exhausted` event, `{ slot, attempts, outcome }`, on the turn a slot with retries of its own runs out; the console says "attempt k of N" with the slot's own N; the app map draws each `onMaxAttempts` that is not the default handoff beside its slot (an identity factor's under "When an identity factor runs out"). A handoff's audit and trace are as they always were, with the reason it was given. Nothing is added to the session.

Testing it: a corpus line with the slot `prompted` and no label for it is a miss; a scripted call says it as many times as the slot's attempts, then expects the outcome (a `form` outcome's next question, a skipped slot's next, or the end line). The engine's own fixture is `packages/dialogwright/src/testing/screened`: a town it cannot make out goes to the office's call (`then: form`), whose call time is skipped after two tries.

### A slot asked only of some callers: `askedOf`

Some questions are for some callers only. A broker asking what a client's plan covers has to say which client; a member asking about their own plan does not. `askedOf` lists the callers a slot is asked of: principal kinds as identity.yaml names them (the subject kind, or a delegate kind), or a delegate kind and one of its roles joined by a dot (`broker.office_admin`):

```yaml
# slots.yaml
clientId:
  type: digits
  noun: member ID
  length: 8
  group: [4, 4]
  askedOf: [broker]
```

For any other caller the slot is no part of its forms: it is not asked, its question is not sent to the model (inside a form or outside one), the change question at a summary does not offer it, and the form completes without it. A caller not yet verified is anonymous, which may not be listed, so a slot that names any kind is asked of no one until they have proven who they are or signed in. It changes nothing for an app whose slots name none (decided 2026-10-16, Harbor findings item 5).

What the slot's value is for is the app's: a form that answers from the knowledge base reads its answer about the subject that slot names, for a caller who is not one (forms.yaml `answers.subject`, [12.5](12-the-knowledge-base.md#125-answers-through-the-gate)); a form's check (`checks:`) sends it to the gate as soon as it is said, so a delegate hears at once that a member is not one they act for; a hook reads it from the session. The gate decides, as always: the slot only lets the caller say whom they mean.

`pnpm check` refuses a kind or a role identity.yaml does not have, `askedOf` in an app without identity.yaml, and `askedOf` on an identity factor (every caller proves who they are the same way). The app map says whom each such slot is asked of. Testing it: a delegate's corpus line at the opening question (`as`), and scripted calls signed in as each kind, the slot asked of one and not of the other.

### Thresholds

Compare the model's numbers against `ctx.thresholds`, by name, never against a number written in the slot. Thresholds can then be overridden for a run (`--threshold SLOT_DETECT=0.7`) and tuned by the sweep, and every slot moves together. The slot thresholds (their defaults are in `core/thresholds.ts`):

| Threshold | Default | What it is for |
|---|---|---|
| `SLOT_DETECT` | 0.6 | A yes-or-no detection question: is a value said at all, was it said whole. |
| `SLOT_CHOICE_CONFIRM` | 0.45 | The least a picked label needs to be taken at all. |
| `SLOT_CHOICE_FILL` | 0.55 | Enough to take a picked label silently; between the two, take it and read it back. |
| `SLOT_CHOICE_MARGIN` | 0.15 | Two labels closer than this are asked about (`disambiguate`). |
| `SLOT_HELP` | 0.6 | A help answer ("I don't know it") to take as one. |
| `KB_TOPIC_MARGIN` | 0.15 | Two knowledge-base topics closer than this are asked about (a `topic` slot's `disambiguate`). |
| `NAME_BARE_SPAN` | 0.7 | A bare name (a `name` slot's `bareAnswer`): the name span's least probability. |
| `NAME_BARE_GIVEN` | 0.2 | A bare name: the least the yes-or-no that a name was given may read; under it, a no. |
| `SUMMARY_WORDS_CHANGED` | 0.6 | At a form's summary, a `text` slot's `changed` question: at this or more, a yes that also adds to or changes the slot's words adds the turn's words after them, exactly as said (read again where the action's `confirmed` rule holds the write to what the summary said). |

An app's own thresholds go in app.yaml (`thresholds:`, the clinic's `PROVIDER_UNSURE`), and the engine adds them to `ctx.thresholds` on every turn. A unit test's `testSlotContext` has only the engine's, so the clinic reads its own through a helper that falls back to the registered app's value (`clinicThreshold` in `apps/clinic/src/domain/thresholds.ts`).

A slot that names a threshold in its options (a library `choice` slot's `hedge.threshold` or `help.threshold`, the one a `fillAt` or `minConfidence` selects) lists the names in `thresholds`, and a name that is neither one of the engine's nor one under `thresholds:` in app.yaml is refused when the app is defined, `pnpm check` included, with the closest name as the fix. A misspelt name would otherwise be a threshold no probability ever meets, so the slot would quietly never fill:

```
slots.yaml:87:16  provider.hedge.threshold  slot "provider" names the threshold "PROVIDER_UNSURR", which is neither one of the engine's thresholds nor one the app names  ->  rename it to "PROVIDER_UNSURE", or add "PROVIDER_UNSURR" under thresholds in app.yaml
```

Set `detect: true` when the slot's fill rests on a yes-or-no detection question, as the card's does (`cardGiven`). It changes what the trace and the console show, not what fills: the slot's row (`slot:<id>`) is shown against `SLOT_DETECT` instead of `SLOT_CHOICE_CONFIRM`. The comparison that decides is the one in your `fill`.

### Worked example: the library card

The library's `check_loans` form asks for a library card number and says which book on the card is due back first. Everything it took:

- `intents.yaml`: the `check_loans` intent, `kind: form`.
- `forms.yaml`: `check_loans` with `slots: [card]`, `summaryPromptId: null` and `hooks: [complete]`.
- `policy.yaml`: a `listLoans` action with `level: 0` and `rules: [identity]`.
- `prompts.yaml` and `locale/es/prompts.yaml`: `ask_card`, `ask_card_retry`, `ask_card_dtmf` (the keypad rung), `ack_card` (`by-confidence`), `ask_card_length` (the `retryPromptId`), and the form's `next_due`, `no_loans` and `no_card`.
- `app.ts`: the slot, the `listLoans` tool and the form's `complete`.

The slot, from `packages/dialogwright/src/define/fixture/app.ts`. It is a library `digits` slot, so its questions, fill, keypad, display and the lines it declares come from the type, and its options say what the hand-written slot in "Values no list holds", below, did:

```ts
export const cardSlot = defineSlot('card', {
  type: 'digits',
  noun: 'library card',               // "Does the caller state a library card number ..."
  length: 8,                          // exactly eight digits; a wrong length is invalid, reason "length"
  keypad: true,                       // dtmf length 8; needs ask_card_dtmf
  confirm: 'by-confidence',           // spokenConfirm; needs ack_card
  readBack: 'below-fill',             // ack_card only when the span's probability is under SLOT_CHOICE_FILL
  minConfidence: 'SLOT_CHOICE_CONFIRM', // under it: invalid, reason "low_confidence"
  lengthRetryPromptId: 'ask_card_length',
});
```

In a folder app the same options go in `slots.yaml` (`card: { type: digits, noun: library card, ... }`). The defaults give the rest: `questionIds` (`cardGiven`, `cardSpan`, `cardComplete`), `detect: true`, `redact: last4`, `handoff: last4`, the display as the digits, and `prompts` (`ask_card_length`, `ack_card` given `{card}`, `ask_card_dtmf`). The options are in `packages/dialogwright/src/slots/digits/README.md`.

The tool takes the value under the slot's own name, so the gate event, the trace and the audit record `card=...0417`:

```ts
  listLoans: {
    run(call, sys) {
      const { loans: onFile } = sys as LibrarySystems;
      const card = call.params.card ?? '';
      const loans = Object.hasOwn(onFile, card) ? onFile[card]! : null;
      return { value: loans, summary: loans ? `${loans.length} loans` : 'no card' };
    },
  },
```

What a caller hears, from the tests: "Sure, I can help you check your loans. What's your library card number?", then for a confident answer "On card 55520417, A Quiet Orchard is due back next, on Friday, September 25.", and for a less certain one "That's card 55531290." in front of the answer. Seven digits get "A library card number has eight digits. Please say all eight, one at a time."; a second miss gets "Please enter your eight digit library card number on the keypad."; eight keys then fill the slot.

### The clinic's slots, by pattern

All five are library slots, configured in `apps/clinic/slots.yaml` with the clinic's own wording:

| Pattern | Library type |
|---|---|
| A choice from a list, with close names asked about (`disambiguate`), a hedged name read back, help lines for "I don't know the name", and a one-digit keypad | `choice`: the provider |
| A value no list holds: detected, picked as a span, turned into digits and checked, keyed as eight digits, recorded and handed over by its last four | `digits`: the clinic's billing ID (`accountId`) |
| A date from parts (mode, month, day, weekday, a span of days), resolved against today; a span is a partial with a prompt and variables; keypad MMDD | `date`: the appointment day |
| A date of birth: month and day without the year is a partial (`ask_dob_year`), masked to the year, keypad MMDDYYYY; one said only in numbers is read from its digits as the keypad reads them, and asked again with an example (`ask_dob_example`) when they read no one day | `birthdate` |
| The caller's own name, picked from word spans with every provider's name left out of the candidates; no keypad | `name` |

The hand-written slots these replaced are kept, frozen, in `apps/clinic/src/testing/oracles/`, and used only by the clinic's grid tests (`src/shadow.test.ts`), which compare each library slot with its oracle over large grids of answers. The oracles are not app code, and a test fails if any non-test file imports one.

### When no type fits: a slot in code

The rest of this section is for a slot no library type covers: a value with its own shape, such as a code with letters, or a pairing of two values. In `slots.yaml` it is `{ type: code }`, written as a `SlotSpec` in `code.slots.<id>`. If the same shape would serve other apps, consider contributing it as a type instead (see "Your own slot type", below, and [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-slot-type)).

The types are in `packages/dialogwright/src/core/slots/types.ts` and are exported by `'dialogwright'`. Everything the library types do, they do by building one of these, so reading a type's code (`packages/dialogwright/src/slots/text/` is the plainest) is the best way to learn the contract.

### The contract

```ts
interface SlotSpec {
  id: SlotId;
  spokenConfirm: 'always' | 'by-confidence' | 'summary';
  questionIds?: readonly string[];
  prompts?: readonly SlotPrompt[]; // { id, why, vars? }
  thresholds?: readonly string[]; // the thresholds the slot's options name
  questions(ctx: SlotContext): QuestionMap;
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  dtmf?: { length: number; parse(digits: string, ctx: SlotContext): SlotCandidate | null };
  display(value: string, locale?: string, todayIso?: string): string;
  redact?: 'last4' | 'mask' | 'length';
  handoff?: 'last4' | 'verified';
  valueKind?: 'date';
  detect?: boolean;
  partialPromptId?: string;
  partialVars?(window: SlotPartial, locale?: string): Record<string, string>;
}
```

(Shortened: the comments are in the file.) `questions(ctx)` returns the questions the slot adds to the turn, by question id. There are three question types (`jev/types.ts`), and each has its answer type and a reader:

| Question | Answer | Read it with |
|---|---|---|
| `{ type: 'noul', instructions, criteria?: { true?, false? } }`: yes or no | `{ type: 'noul', noul }`, the probability of yes | `noulValue(answers, id)`, which is 0 when the answer is missing |
| `{ type: 'choice', instructions, criteria: { <label>: <description or null> } }`: one label of several | `{ type: 'choice', choice, probabilities, confidence }`: the top label, every label's probability, the top one's | `isChoice(a)`, then `a.probabilities[a.choice]`; `rankProbabilities` for the top two |
| `{ type: 'score', instructions, levels: [{ label, description }] }`: ordered levels, lowest first | `{ type: 'score', score, probabilities, confidence }`: the expected level (1-based, may be fractional) | `isScore(a)` |

No slot in the repository uses a score question; the engine's own frustration question is one. A choice question offers a `none` label, so the model has an answer when the words name nothing.

Some rules about questions:

- **Ids are shared.** Every slot's questions and the engine's own go into one map for the turn, so no two may share an id: a turn on which a slot asks an id the engine asks (`ENGINE_QUESTION_IDS`, such as `urgency`) or another slot asks throws. Start each id with the slot's id (`cardGiven`, `cardSpan`), and list them in `questionIds` (the library's slots do): then a collision is refused when the app is defined, `pnpm check` included, rather than on the turn that meets it, and the slot may ask no id it has not listed. A slot that lists none is still tried when the app is defined: `validateApp` (and so `defineApp`, `registerApp` and `pnpm check`) calls its `questions()` on a few made-up turns (no words and words with numbers and a date in them; asked or not; with and without a value on file and a pending partial; in each of the app's locales) and refuses an id the engine asks, an id another slot declares or asks, and, for a slot that lists its ids, one it leaves out. A try that throws is skipped, never a failure, and a question asked only in a state those turns do not reach is still caught on its turn. This is a change: a hand-written slot asking the engine's or another slot's id was once merged over it without a word, and then refused only on the turn that asked it; now the app is refused when it is defined. The console groups questions under a slot by that prefix (app.yaml `console.questionPrefixes` names others) and shows an id ending in `Given` against the detection threshold (`console.detectQuestions` names others).
- **The words are the request.** `instructions` and the criteria are sent to the model as written. Changing them changes what a recorded cassette holds.
- **Every slot listens on every turn** (see above). `fill` must return `absent` when the words say nothing about its slot.
- **`fill` only reads.** It returns an outcome and changes nothing, neither `ctx` nor anything of its own: the engine may call it more than once on a turn with the same answers (at a form's summary it reads the turn's new values before the fill, for app.yaml `changeSlotWithValue`), so the same answers and context must give the same outcome each time.

`ctx` (a `SlotContext`) is what the slot sees of the turn:

| Field | What it is |
|---|---|
| `text` | The caller's words this turn. |
| `candidateSpans`, `candidateWordSpans` | The runs of the caller's words a span question can offer: number-ish and word-ish (see "Values no list holds"). |
| `todayIso` | Today, for dates. |
| `thresholds` | The engine's thresholds and the app's own, by name. |
| `window` | This slot's pending partial value, or null (see "Partial values"). |
| `current` | This slot's value already on file, or null (null during a correction at the summary, but for a yes to it, which accepts what is on file in every slot but the detail it names to change). |
| `summary` | `true` when the caller is answering the read-back of a form's summary that holds this slot (a `text` slot asks its `changed` question only then); absent otherwise. |
| `records` | The app's records a slot may choose among (`App.facts.forSlots`), opaque to the engine; empty when the app has none. |
| `sources` | The app's records by name (`App.facts.forSlots` returning `{ sources: { parcels: [...], orders: [...] } }`), for a slot that names the list it chooses from (a `record` slot's `from`), so two such slots each read their own. Absent when the app names none. |
| `prompted` | Whether the last prompt asked for this slot. |
| `locale` | The language the session speaks, for an app that declares locales (section 8); absent otherwise. A slot that formats its value for the language reads it here. |
| `nominated` | The knowledge-base topics the app's retriever nominated for this turn's words, best first, for a slot that reads them (`nominates: true`, a `topic` slot). Present only on a turn retrieval ran for (an app with knowledge, words, and such a slot listening); absent otherwise. |

`fill(answers, ctx)` returns a `SlotOutcome`. Each kind, when to return it, and what the engine then does:

| Outcome | Return it when | What the engine does |
|---|---|---|
| `{ kind: 'absent' }` | The words say nothing about this slot. | Nothing. If no slot made progress this turn, it counts as a missed answer to the question that was asked (the retry ladder below). |
| `{ kind: 'filled', value, display, confidence, confirm }` | The words give a value you accept. | Stores `value` and `display` on the slot and clears any pending partial. What it says next depends on `spokenConfirm` (below); `confirm` (`'none'` or `'implicit'`) matters only for `by-confidence`. `confidence` is recorded in the trace's row for the slot; the engine decides nothing with it. |
| `{ kind: 'disambiguate', a, b }` | Two candidates are too close to call (`a` and `b` are `{ value, display }`). | Asks `disambiguate_<slot>` with `{a}` and `{b}` set to the two displays. The slot stays empty, and the caller's answer is read by the same slot's questions on the next turn (the model also sees the two displays as `node.options`). Only the first slot that disambiguates in a turn is asked about. |
| `{ kind: 'window', window, confidence }` | The words give part of the value (a month and day without the year). | Keeps the partial on the slot and asks for the rest (see "Partial values"). |
| `{ kind: 'invalid', reason, raw, retryPromptId? }` | The words were meant as this value but cannot be it (seven digits for an eight-digit number, a birthday in the future). | Stores nothing, and the turn is a missed answer. `retryPromptId`, when set, is said at the first rung in place of `ask_<slot>_retry`, for a reason the generic retry would misdescribe. `reason` shows in the trace's row as `invalid:<reason>`. The engine reads `raw` only for a date-valued slot (see "Partial values"). |
| `{ kind: 'help', promptId }` | The caller says whether they know the value without saying it ("I don't know the doctor's name"). | Says `promptId` in place of the question, and the attempt count does not move. Only for the slot that was just asked, and each help prompt only once until the slot is emptied; anywhere else it counts as `absent`. |

The retry ladder. A missed answer adds one to the slot's attempts. With `MAX_ATTEMPTS` at its default of 3: the first miss re-asks with `ask_<slot>_retry` (or the outcome's `retryPromptId`, or the partial prompt when a partial is pending); the second asks for the keypad with `ask_<slot>_dtmf` when the slot has `dtmf` and the channel has a keypad, and re-asks with the retry line otherwise; the third hands the call to a person (`max-attempts`). Silence counts as a miss too, but its first re-ask is the plain `ask_<slot>` after "I didn't hear anything". A turn whose frustration the line acknowledges, with no value in it ("this is ridiculous"), is no miss: the acknowledgement, then `ask_<slot>` again, nothing counted (app.yaml's `frustration.miss`, [02](02-the-files-one-by-one.md#appyaml)).

For every slot a form or identity.yaml names, `check` requires `ask_<slot>`, `ask_<slot>_retry` and the lines below that the spec's fields call for. It cannot see the prompts a `fill` returns, so declare them in the spec's `prompts` (`disambiguate_<slot>` with `vars: ['a', 'b']`, a `retryPromptId`, a help `promptId`; the library's card declares `ask_card_length`): `check` then requires each in every locale, and refuses a line that uses a variable the slot does not declare for it.

### Values no list holds

An order number, a code, a card number: the model cannot choose it from a list, and it is never asked to write it. Instead, the code finds every run of the caller's words that could be the value, the model judges which one it is, and the code turns that run into the value and checks it. The value is then always something the caller said, and the code, not the model, decides whether it is valid. The library's `digits` type works this way (the clinic's billing ID, `accountId`, and the library's card are slots of it), and this section shows the steps as a hand-written slot takes them, for a value the type does not fit:

1. **Candidates, in code.** `ctx.candidateSpans` is every run of one to ten words of the caller's text that holds a digit or a number word, shortest first, at most 120, in the tokenized form (lower case, no punctuation): "it's 5552 0417" gives `5552`, `0417`, `5552 0417` and the longer runs around them. For words rather than numbers (a name), `ctx.candidateWordSpans` is every run of one to four words with no number word that does not start or end with a filler word ("my", "is", "the"), at most 320. Both functions are exported, for tests.
2. **Judgment, by the model.** A yes-or-no question asks whether a value is said at all; a choice question offers the spans as its labels (with `null` criteria, since each span describes itself) and `none`; a second yes-or-no question asks whether it was said whole.
3. **Normalisation and checking, in code.** `spokenToDigits(span)` turns "five five five two zero four one seven" or "5552 0417" into `55520417`, and `matchesMask(digits, /^\d{8}$/)` checks its shape. Anything wrong is `invalid`, with its reason.

What is not on the ballot cannot be chosen, so narrow the candidates rather than arguing in the instructions. The clinic's name slot (a library `name` slot, with its `exclude` list, in `apps/clinic/slots.yaml`) leaves out every span that holds a provider's name, so a caller correcting the doctor is never taken as giving their own name. It also checks that the chosen span is one it offered on this turn, since an answer recorded against other words can name a span the turn never offered.

The questions and fill of such a slot written by hand, as the library's card had them before the `digits` type (the type's default wording is a little different: it says "either as digits or as spoken number words", and its span question names number words like "forty-four" and modifiers like "double"):

```ts
  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a library card number';
    return {
      cardGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state a library card number, as digits or as spoken number words?',
      },
      cardSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the library card number the caller states? ...',
        criteria,
      },
      cardComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states a library card number, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'cardGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    if (noulValue(answers, 'cardComplete') < t.SLOT_DETECT) return { kind: 'invalid', reason: 'incomplete', raw: '' };
    const span = answers.cardSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const p = span.probabilities[span.choice] ?? span.confidence;
    if (p < t.SLOT_CHOICE_CONFIRM) return { kind: 'invalid', reason: 'low_confidence', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, CARD_MASK)) return { kind: 'invalid', reason: 'length', raw: digits, retryPromptId: 'ask_card_length' };
    return { kind: 'filled', value: digits, display: digits, confidence: p, confirm: p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit' };
  },
```

The order matters. Not said is `absent`, so a turn about something else leaves the card alone. Said but trailed off, or said but no span is it, is `invalid`: the caller tried, and the turn is a miss. The digits are checked last, and a wrong length gets its own re-ask ("A library card number has eight digits. Please say all eight, one at a time.") rather than the generic one.

### The keypad

`dtmf: { length, parse }` gives the slot a keypad rung. While the slot is the question the caller was last asked, keys are collected until there are `length` of them, then `parse(digits, ctx)` returns `{ value, display }`, or null for keys that are not a value. A keyed value counts as confirmed: it is not acknowledged or read back, whatever `spokenConfirm` says. A null is a missed answer on the ladder. Keys are taken whenever the slot was the last thing asked, not only at the keypad rung, and `parse` gets a context with no words (`text` is empty, and there is no pending partial). Written by hand, the card's was:

```ts
  dtmf: {
    length: 8,
    parse: (digits) => (matchesMask(digits, CARD_MASK) ? { value: digits, display: digits } : null),
  },
```

A slot with `dtmf` needs `ask_<slot>_dtmf`, the line that asks for the keys ("Please enter your eight digit library card number on the keypad."). Without `dtmf`, the keypad rung is one more spoken retry, and so it is on a chat, which has no keypad. The clinic's keypad shapes: the date as MMDD (`length: 4`), the date of birth as MMDDYYYY (`length: 8`), the provider as one digit.

### Sensitive values

`redact` says how the slot's value is masked wherever it leaves the turn:

| `redact` | Shows as | For |
|---|---|---|
| `last4` | `...0417`; a value of four digits or fewer, whose last four would be all of it, as `••••` | An identifier (the card, the clinic's billing ID, `accountId`). |
| `mask` | `••/••/1975`, the year alone; a tool param as `•` | A date of birth (the clinic's `dob`). |
| `length` | `<38 chars>` | The caller's own words, such as a free-text note. The slot's display is a stand-in ("your description") and is kept; the live console keeps the words. The engine's testkit has one (`missingNote`). On a `digits` slot, a short secret (a PIN, the last four of an identity number): `<4 chars>`, its display too and on the live console as well, since its display is the number (a slot in code says so with `statement: false`). |

Where it applies: a tool call's param with the same name as the slot, as the gate event, the trace and the audit log record it; and the trace's and the console's copies of the slot (its value and display, the slots in the turn state the model was given, a pending read-back, a prompt's variables named after the slot, a handoff's collected slots). What our own lines said of it is masked too: the trace's say actions, the console's spoken line, the frame log's outbound text frames and the part of a line an interruption heard have each redacted slot's value, display and digits (however a voice line spaces or groups them) replaced by its masked form. A pending partial of a redacted slot keeps its shape with its numeric parts zeroed. The console shows a passage's `applies` (whom it answered) only as `audit:` in policy.yaml declares each fact. So name the tool param and the prompt variable that carry the value exactly as the slot: the library's `listLoans` takes `card`, and its lines say `{card}`.

A short secret, such as a four-digit PIN or the last four of an identity number, takes `redact: length` on its `digits` slot. It is recorded by how many digits it has wherever it leaves the turn, its display and the live console included; its keys are masked as they are keyed (the frame log, the console and the trace show `•` for each, as for an identity factor's); and a transfer hands over only its real length (`<4 chars>`), whatever `handoff.data` sends, `as-is` included. Under `last4` its last four would be all of it, so the engine records a value of four digits or fewer as `••••` (four bullets, whatever its length) wherever `last4` would show its last four: a slot, a tool call's param, a handoff's `last4`, a passage's `applies`, a caller number on the console and in the trace, and a principal's id in the audit and the gate's lines. For a slot the digits are counted, so `MBR1234` (seven characters, four digits) is `••••` too; a tool param or an id counts characters. Longer values are shown by their last four as before. One exception: the audit's `offer` and `consent` rows keep `last4` as the line said it to the caller (`{last4}`), so a caller number of four digits or fewer is in them whole, as the caller heard it. `pnpm check` warns of a `digits` slot redacted by `last4` that can be four digits or fewer (by its `length`, or a `mask` that lets it), and points to `length`; it never refuses one.

What `redact` does not cover is the caller's words. The transcript (the speech event, the turn's text, and the questions the model was asked, whose span labels are the caller's words) is kept in the trace as said, so a trace is sensitive. The audit log holds only the masked calls. The model itself sees each slot's display in its turn state.

`handoff` says what a transfer to a person hands over for the slot (`HandoffDecision.slots`). Without it, the slot's display. `last4`: the last four digits. `verified`: only whether the caller was verified (`verified` or `not verified`), never the value, which needs an identity.yaml. Only filled slots are handed over, and a form's slots are emptied when it completes, unless app.yaml's `carrySlots` names them. What the transfer then sends on to the channel is app.yaml's `handoff.data` ([app.yaml](02-the-files-one-by-one.md#appyaml)): by default an identity factor is left out, a slot with a `redact` setting goes masked as the trace masks it, and any other slot goes as its `handoff` setting says. So `redact` also masks what a transfer sends, unless app.yaml names the slot `as-is`.

### Partial values

A slot that can hear part of a value returns `{ kind: 'window', window, confidence }`. `window` is a `SlotPartial`: `{ kind: <the slot's word for it>, ...parts }`, each part a string or a number. The engine keeps it on the slot, which stays empty, and asks for the rest:

- `partialPromptId` names the line that asks for the rest (the clinic's date of birth: `ask_dob_year`, "And what year?"). Without it, the slot's own `ask_<slot>`. `check` requires it.
- `partialVars(window)` gives that line its variables, wherever it is asked. The clinic's date turns "next week" into `{ window: 'next week' }` for `date_narrow_window`, "{window}. Which day works for you?".
- On the next turn, `ctx.window` is the pending partial, so `fill` can complete it: the clinic's `dob` takes the pending month and day when the caller says only the year, and its `date` reads a bare weekday inside the pending span.
- A partial never replaces a filled value mid-form (only a correction at the summary does). The same partial said again is not progress, so the turn is a missed answer, and the open rung re-asks the partial line rather than the retry.

`valueKind: 'date'` says the value is a calendar day (an ISO date). Every slot reads every turn, so "June fourteenth" said at the birthday question would also give the appointment date. The engine settles it: when the slot that was asked and another date-valued slot hear the same month and day on one turn, the other one's fill or partial is dropped. It reads the day from a fill's value, an `invalid` outcome's `raw`, or a partial's numeric `month` and `day` parts. So a date slot's partial that holds a day names it with numeric `month` and `day` (the clinic's `dob`), and one that holds no single day uses other parts (the date's window keeps `start`, `end` and `label` as strings).

### spokenConfirm

How a spoken value is confirmed. A keyed value never is.

| `spokenConfirm` | What happens to a spoken fill | Lines it needs |
|---|---|---|
| `summary` | Nothing is said for it: the form's summary (`summaryPromptId`) reads it back with the rest. The fill's `confirm` is not read. In a form with no summary, nothing reads it back at all. | none |
| `by-confidence` | The fill's `confirm` decides. `'none'`: taken silently. `'implicit'`: taken, and `ack_<slot>` is said in front of the next line with `{<slot>}` set to the display ("That's card 55520417."). The value stands without a yes. | `ack_<slot>` |
| `always` | The value is read back with `confirm_<slot>` (`{<slot>}` set to the display) and counts only after a yes; the form's checks wait for it. A no goes straight to the keypad (`ask_<slot>_dtmf`), and a second no to a person; an unanswered read-back walks the ladder. With `readBackNo: 'ask'`, a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), counted as one attempt on the slot's own ladder (`ask_<slot>_dtmf` at its keypad rung where the slot has `dtmf` and the channel a keypad); the slot's nos are counted apart, and a second goes to a person; a value the no itself gives ("no, I own it") is taken. The unanswered ladder's keypad rung asks `ask_<slot>_retry` for a slot with no `dtmf`. A code slot without it is unchanged: a summary's yes that gives it a new value goes to the checks and the completion, as before. | `confirm_<slot>`; `ask_<slot>_dtmf` unless `readBackNo: 'ask'` |

`confirmValues` (optional) lists values read back as an `always` slot's are, while every other value follows `spokenConfirm`: `confirmValues: ['rent']` reads "rent" back and leaves "own" to the summary. It needs `confirm_<slot>`, and `ask_<slot>_dtmf` unless `readBackNo: 'ask'`.

Without `readBackNo: 'ask'`, `ask_<slot>_dtmf` is required for `always` even without `dtmf`, so give such a slot a keypad rung: otherwise a declined read-back asks for keys the slot cannot take. A library slot is configured in slots.yaml instead: every type takes `confirm: always`, a `choice` slot also takes `confirmValues: [<option>, ...]`, and each sets `readBackNo: 'ask'`, so none needs a keypad line for it ([docs/slots](../slots/README.md)). A slot confirmed at its read-back is not asked again at the summary's yes, and a check reading it does not read it back again.

### display

`display(value, locale)` is how the line says a value: "55520417" for the card, "Dr. Patel" for a provider, "Tuesday, September 22" for a date ("martes, 22 de septiembre" in a Spanish call). `locale` is the session's (`ctx.locale` in `fill` and `dtmf.parse`), which only an app that declares locales has; format en-US exactly as with no locale. `todayIso` is the call's day (`ctx.todayIso`), for a display that says a value by how it stands to today, as the library's date says the year of a day not in this year's ("Friday, January 8, 2027"); a display that does not need it ignores it. The engine calls it only to say a value held again after a switch of language, with the turn's day: what a line says, what the console shows and what the model sees is the `display` your `fill`, `dtmf.parse` or `disambiguate` candidate returned, stored on the slot. Write one formatter, make it the spec's `display`, and use it in all three, so they agree (the library's `bookSlot` and `branchSlot`, both `choice` slots, and the clinic's date do). The library's card is said digit by digit because app.yaml's `voice.spokenDigits` rule spells `card ` followed by digits for text to speech, so its lines say "card {card}".

### Your own slot type

A slot you write for one app can be a `SlotSpec` in `code.slots`. A shape you will use more than once, or want others to use, is better as a slot type: a function from validated options to a `SlotSpec`, named in `slots.yaml` like the built-in ones. An app registers its own types with `code.slotTypes`:

```ts
import { registerSlotType } from 'dialogwright';
import { defineSlotType } from 'dialogwright/slot-kit'; // the helpers a slot type is written with

export const plateType = defineSlotType({
  type: 'plate',                 // what slots.yaml writes after "type:"
  options: plateOptions,         // a z.strictObject, every option with .describe(...)
  build: (id, options) => ({ id, ...,
    questionIds: [`${id}Given`], // every question id it may ask
    prompts: [],                 // every line it may lead to, beyond ask_<slot> and ask_<slot>_retry
  }),
  examples: plateExamples,       // configurations with starter utterances
});

export const code: AppCode = { slotTypes: registerSlotType(plateType), /* ... */ };
```

A name a built-in type has, and `code`, are refused. The contract a type must keep, and how to write one, are in [the library's README](../../packages/dialogwright/src/slots/README.md) and in CONTRIBUTING's "Adding a slot type".

**The conformance kit** proves a type keeps that contract, over its examples, with no model and no keys. In the type's test file:

```ts
import { describe, it } from 'vitest';
import { runSlotConformance } from 'dialogwright/testing';
import { plateType } from './plate';

runSlotConformance(plateType, { describe, it });
```

It checks en-US and es unless you pass `locales` (`locales: ['en-US']` for a type that speaks only English). It checks that the type builds, refuses unknown options, declares every question id and keeps them its own (never the engine's, and different for a second slot) in every state it tries (a value on file, a partial pending, a Sunday, a leap day, the last day of a year), says nothing when it hears nothing, never throws on malformed answers, reads its thresholds by name (scaling every probability and every threshold by one factor must change nothing) and only the ones it declares or the engine has, treats a number exactly at a threshold as meeting it, formats its display the same in the fill, the keypad and every locale and as each example pins it there, declares every line it can lead to with only the variables the engine gives that line, gives ISO dates when its values are dates, and gives the outcome each example utterance expects. A type that passes can run in an app. A check that fails says which example, which check and every problem it found.

### Porting a slot to a library type

If you wrote a slot by hand before a library type covered it, move it onto the type without changing what callers hear. The shadow harness, in `dialogwright/testing`, runs the library slot beside the hand-written one and fails on any difference:

1. Keep the hand-written slot as the app's slot. Build the library slot with `defineSlot` from the options you mean to use (its question wording as literals, so the text does not move).
2. In a test, `shadowSlot(handWritten, librarySlot)` returns a slot that behaves as the hand-written one and, on every call, also runs the library one and compares the questions (as the model's request keys them), the `fill` outcomes, the keypad results, `display` and `partialVars`. Drive it over a large grid of answers, around every threshold, so branches no recorded call reaches are covered. `createShadowReport()` collects differences instead of throwing.
3. For a whole run, `withShadowSlots(app, [librarySlot], { mode: 'report', report })` does the same inside the regression and the recorded replay, and `shadowFromEnv(app, [librarySlot])` in a regression launcher turns it on when `DIALOGWRIGHT_SHADOW` is set (`1` or `throw` to fail on the first difference, `report` to list them all at the end).
4. When nothing differs, switch the app to the library slot and move the hand-written file to a test-only folder (the clinic's is `src/testing/oracles/`) with a header saying it is a frozen copy, used only by the grid tests, never edited. Keep a test that fails if any non-test file imports from it.

### Testing a slot

A library type's own tests (the conformance kit and its unit tests) cover its parsing, so a slot built from one needs no `fill` tests of its own; test the app's use of it (your options and wording, and the whole call). Of the five steps below, step 1 is only for a slot written in code; the others apply to every slot.

1. **Unit tests of `fill`.** Write the model's answers out with `choice`, `noul` and `score`, build a context with `testSlotContext(text)` (all exported by `'dialogwright'`; the context uses today 2026-09-18 and the default thresholds), and assert the outcome. Test every branch: absent on unrelated words, each `invalid` reason, the fill, and `dtmf.parse` with good and bad keys. From the library's test:

   ```ts
   it('is invalid, with its own re-ask, when the digits are not eight', () => {
     expect(cardSlot.fill(heard('five five five two zero four one'), ctx('five five five two zero four one'))).toEqual({
       kind: 'invalid', reason: 'length', raw: '5552041', retryPromptId: 'ask_card_length',
     });
   });
   ```

2. **Whole calls.** `resolveTurn` (the engine's turn), `newSession`, `spokenText` and the event helpers drive a call one turn at a time with written-out answers, so you can assert the lines heard, the gate events (with the masked param) and the keypad path. The library's are in `packages/dialogwright/src/define/cardSlot.test.ts`; the clinic's are in `apps/clinic/src/index.test.ts`, with their helpers in `src/testing/turns.ts`.
3. **The corpus and the scenarios.** In an app with fixtures, add labelled lines to `fixtures/corpus.jsonl` with the slot's labels, in the shape the app's testing hooks read. Two of the clinic's, one opening a form and one answering the birthday question inside it:

   ```json
   {"id":"cn-09","text":"Cancel my appointment, I was born June fourteenth nineteen seventy five","intent":"cancel","context":"no_form","slots":{"dob":{"month":"june","day":"14","year":"nineteen seventy five"}}}
   {"id":"db-03","text":"the fourteenth of June, 1975","intent":"none","context":"schedule_new","prompted":"dob","slots":{"dob":{"month":"june","day":"14","year":"1975"}}}
   ```

   Add scripted calls to `fixtures/scenarios/*.json` for the paths: spoken, keyed (a `{"dtmf": "06141975"}` step), and a miss. The app's `testing` hooks (`apps/clinic/src/domain/testing.ts`) tell the stubs how to answer the new questions: `labeled.spans` for a span question (the label is checked to be a span the question offers), `labeled.noul` and `labeled.choice` for the rest, `quietNoul` for a yes-or-no the words do not bear on, `heuristics` for the keyword stub, `checkCorpusSlots` to reject a label no question could pick, and `seed.placeholders` for a corpus line spoken inside a form.
4. **The regressions.** The stub regression then shows each new line as `+ corpus <id>: new` and any changed outcome as a difference. Read each one; a changed outcome is a finding to explain before the baseline is updated, never something to overwrite. Note that a new slot changes the model's request on every turn: its questions are asked wherever it listens, and every slot is in the turn state. So the recorded replay misses on every turn until the cassette is recorded again, which calls the paid model and is a deliberate step (the clinic's README, "Recording the cassette").
5. **`pnpm check`** (or `pnpm check <folder>`) says which of the slot's lines are missing, in every locale, and why the engine says each. Taking `ask_card_dtmf` and `ack_card` out of the library gives:

   ```
   prompts.yaml:2:1  prompts  prompt "ask_card_dtmf" is missing from prompts.yaml; the engine says it when it asks for the slot "card" on the keypad after spoken answers missed (its slot spec has dtmf)  ->  add "ask_card_dtmf:" with its text and interruptible to prompts.yaml
   prompts.yaml:2:1  prompts  prompt "ack_card" is missing from prompts.yaml; the engine says it when it acknowledges a value it heard for the slot "card" (its slot spec's spokenConfirm is "by-confidence")  ->  add "ack_card:" with its text and interruptible to prompts.yaml
   ```

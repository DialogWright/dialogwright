# Policy card: Example Wheel Works

*Generated from `agent.yaml`'s actions by `pnpm policy:card`: do not edit it by hand. Change the file, write the card again, and review the diff. A test fails when this page and the file disagree.*

## How the gate decides

- A model leads the conversation, but it acts only through the actions below, and every action goes through the gate. Each decision, allowed or refused, is written to the audit.
- Anything not listed under Actions is refused.
- Every action is open to a caller nobody has proven (level 0): this app has no identity. The number a caller calls from may recognise a known account; it is never proof of who is speaking.
- The rules of an action run in the order shown, and the first one that fails decides.
- Every change is read back in the business's fixed words with exactly the values it will run with. The caller's answer is read as a yes or a no by the decision model (not the agent model), and the change runs only on a clear yes (the gate's `confirmed` rule, over all of the change's params, runs last). A lookup is never confirmed.
- One confirmation at a time: a call made while a read-back waits for its answer is not run, and is no refusal of its action (it counts toward no limit below).
- Anything but a clear yes runs nothing: the agent model is told that nothing was changed and what the caller said.
- A follow-on action runs only after its parent ran on the caller's yes, with the values read back there, through the gate with its own confirmation hash; it has no read-back of its own.
- After 3 refusals of the same action on a call (`limits.refusalsPerAction`), the agent model is told to offer the caller a person rather than try again.
- `end_call` is the runtime's own action, offered to the model on every call: it says the closing line and ends the call, and changes nothing.

## What a model is sent and what is recorded

- The agent model is sent, in full: the caller's words, its own replies, the fixed lines said, the arguments of its own action calls, each read-back as it was said (the caller's own values among it), and what each action returned, as the action returned it. Nothing checks an action's result: there is no closed-form check on a converse action's reply, so an action returns only what the model may see. This app has no identity factors to withhold.
- The caller's number reaches the agent model only by its last four digits, so it can say them; the whole number goes only to the actions' code (a phone param the model writes as `caller` is resolved by the runtime).
- Only the reason the gate refused a call is scrubbed before the agent model is told it: any value of a param that is recorded hidden is replaced by its recorded form. The reason a call's values were not valid for their types, and the words an action failed with, go to the agent model as written.
- The trace and the audit record each action's params as its `audit` says, hidden (`•`) where it says nothing (see each action's table below). Only the audit records an action's result, as the model is sent it, with the values of hidden params replaced and cut to 600 characters; the trace records whether it ran (and the words it failed with, those values replaced), not what it returned.
- The caller's own words, typed or spoken, are kept as they said them in the trace and the frame log, as in the scripted mode.

## Actions

| Action | Kind | Offered to the model | Rules | Follow-on actions |
| --- | --- | --- | --- | --- |
| `recognise_caller` | lookup | yes | none | none |
| `check_availability` | lookup | yes | none | none |
| `send_request` | change | yes | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes)` | `send_photo_request`, `notify_shop_request` |
| `send_photo_request` | change | no: follows `send_request` | `oneOf(textOk: yes)`, `confirmed(callbackNumber, textOk)` | none |
| `notify_shop_request` | change | no: follows `send_request` | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes)` | none |
| `book_dealer` | change | yes | `confirmed(account, cars, vehicles, slot)` | `notify_shop_booking` |
| `notify_shop_booking` | change | no: follows `book_dealer` | `confirmed(account, cars, vehicles, slot)` | none |
| `leave_callback` | change | yes | `confirmed(name, callbackNumber, about, notes)` | none |

### `recognise_caller`: a lookup

The dealership account the number calling is on file for, if any: call it before book_dealer, whose account must be one it returned. A number on file recognises an account; it does not prove who is speaking.

Rules, in the order they run:

- none: a lookup reads and returns a result; it is open to every caller

### `check_availability`: a lookup

The drop-off windows with room on a day, each with how many cars it can still take (its room). The only source of what is free.

Rules, in the order they run:

- none: a lookup reads and returns a result; it is open to every caller

| Param | Type | Recorded |
| --- | --- | --- |
| `day` | date | as it is |

### `send_request`: a change

Send the shop a customer's repair request with the drop-off window they picked, for anyone who is not a dealership account. Ask whether we may text them at their number before calling it. Call it as soon as you have every detail: the line then reads the request back to the customer and sends it on their yes, so it is not in until this is called and confirmed.

Read back before it runs, in these words: "Here's your request: {name}, your {vehicle}, damage: {damage}, on {wheels} of its wheels, finish: {finish}, dropping off {slot}. We'll reach you on {callbackNumber}, and texts there are OK: {textOk}.[ A note for the shop: {notes}.] Is that right?" (a part in square brackets is said only when its value is given)

Rules, in the order they run:

- the caller's yes to a read-back of name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes

After the caller's yes it is followed by `send_photo_request` and `notify_shop_request`, each through the gate.

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text (one line, at most 120 characters) | hidden (`•`) |
| `vehicle` | text (one line, at most 120 characters) | as it is |
| `wheels` | choice (one, two, three, four) | as it is |
| `damage` | text (one line, at most 120 characters) | as it is |
| `finish` | choice (diamond cut, painted, not sure) | as it is |
| `slot` | slot from `check_availability` | as it is |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |
| `notes` | text (one line, at most 120 characters) | as it is |

### `send_photo_request`: a change

Follows send_request on the customer's yes, only with their yes to texts too (the runtime runs it; the model is never offered it).

Never offered to the model, and it has no read-back of its own: it runs after the caller's yes to `send_request`, whose confirmation stands in for it, with the values read back there.

Rules, in the order they run:

- textOk must be one of yes (refused as no-consent)
- the caller's yes to the read-back of `send_request` (its values for callbackNumber, textOk are the ones read back there)

| Param | Type | Recorded |
| --- | --- | --- |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |

### `notify_shop_request`: a change

Follows send_request on the customer's yes, texting the shop a summary (the runtime runs it; the model is never offered it).

Never offered to the model, and it has no read-back of its own: it runs after the caller's yes to `send_request`, whose confirmation stands in for it, with the values read back there.

Rules, in the order they run:

- the caller's yes to the read-back of `send_request` (its values for name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes are the ones read back there)

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text (one line, at most 120 characters) | hidden (`•`) |
| `vehicle` | text (one line, at most 120 characters) | as it is |
| `wheels` | choice (one, two, three, four) | as it is |
| `damage` | text (one line, at most 120 characters) | as it is |
| `finish` | choice (diamond cut, painted, not sure) | as it is |
| `slot` | slot from `check_availability` | as it is |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |
| `notes` | text (one line, at most 120 characters) | as it is |

### `book_dealer`: a change

Book a dealership account's cars straight into a drop-off window, only for the account the caller's number is on file for; anyone else sends a request instead.

Read back before it runs, in these words: "So that's {account}, {cars} in all: {vehicles}, dropping off {slot}. Shall we book it?"

Rules, in the order they run:

- the caller's yes to a read-back of account, cars, vehicles, slot

After the caller's yes it is followed by `notify_shop_booking`, each through the gate.

| Param | Type | Recorded |
| --- | --- | --- |
| `account` | slot from `recognise_caller` | as it is |
| `cars` | choice (one, two, three) | as it is |
| `vehicles` | text (one line, at most 240 characters) | as it is |
| `slot` | slot from `check_availability` | as it is |

### `notify_shop_booking`: a change

Follows book_dealer on the caller's yes, texting the shop a summary (the runtime runs it; the model is never offered it).

Never offered to the model, and it has no read-back of its own: it runs after the caller's yes to `book_dealer`, whose confirmation stands in for it, with the values read back there.

Rules, in the order they run:

- the caller's yes to the read-back of `book_dealer` (its values for account, cars, vehicles, slot are the ones read back there)

| Param | Type | Recorded |
| --- | --- | --- |
| `account` | slot from `recognise_caller` | as it is |
| `cars` | choice (one, two, three) | as it is |
| `vehicles` | text (one line, at most 240 characters) | as it is |
| `slot` | slot from `check_availability` | as it is |

### `leave_callback`: a change

Leave the shop a note to call the customer back, for someone who wants to speak with a person.

Read back before it runs, in these words: "We'll have someone from the shop call {name} back on {callbackNumber} about {about}.[ A note for the shop: {notes}.] Is that right?" (a part in square brackets is said only when its value is given)

Rules, in the order they run:

- the caller's yes to a read-back of name, callbackNumber, about, notes

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text (one line, at most 120 characters) | hidden (`•`) |
| `callbackNumber` | phone | by its last four |
| `about` | text (one line, at most 120 characters) | as it is |
| `notes` | text (one line, at most 120 characters) | as it is |

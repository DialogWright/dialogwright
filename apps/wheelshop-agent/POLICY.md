# Policy card: Example Wheel Works

*Generated from `agent.yaml`'s actions by `pnpm policy:card`: do not edit it by hand. Change the file, write the card again, and review the diff. A test fails when this page and the file disagree.*

## How the gate decides

- A model leads the conversation, but it acts only through the actions below, and every action goes through the gate. Each decision, allowed or refused, is written to the audit.
- Anything not listed under Actions is refused.
- Every action is open to a caller nobody has proven (level 0): this app has no identity. The number a caller calls from may recognise a dealership account; it is never proof of who is speaking.
- The rules of an action run in the order shown, and the first one that fails decides.
- Every change is read back in the business's fixed words with exactly the values it will run with, and runs only once the caller has said yes to that read-back (the gate's `confirmed` rule, over all of the change's params, runs last). A lookup is never confirmed. The follow-on actions of a change run after that yes with no read-back of their own, each through the gate with the same values.
- `end_call` is the runtime's own action, offered to the model on every call: it says the closing line and ends the call, and changes nothing.

## What a model is sent and what is recorded

- The conversation is sent to the agent model: the caller's words, its own replies and the fixed lines said. Identity factors are never sent (this app has none).
- The results of the actions the model calls are sent to it, each held to its action's check in a closed form.
- A value an action's `audit` hides (`mask`, `length` or `secret`) is masked, once understood, in what the model is sent.
- The caller's number is given to the model by its last four digits, so it can say them; the whole number goes only to the actions' code.
- The audit, the trace and the console record each action's params as its `audit` says, by default hidden (`•`): see each action's table below.

## Actions

| Action | Kind | Offered to the model | Rules | Follow-on actions |
| --- | --- | --- | --- | --- |
| `recognise_caller` | lookup | yes | none | none |
| `check_availability` | lookup | yes | none | none |
| `send_request` | change | yes | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk)` | `send_photo_request`, `notify_shop_request` |
| `send_photo_request` | change | no: follows `send_request` | `oneOf(textOk: yes)`, `confirmed(callbackNumber, textOk)` | none |
| `notify_shop_request` | change | no: follows `send_request` | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk)` | none |
| `book_dealer` | change | yes | `confirmed(account, cars, vehicles, slot)` | `notify_shop_booking` |
| `notify_shop_booking` | change | no: follows `book_dealer` | `confirmed(account, cars, vehicles, slot)` | none |
| `leave_callback` | change | yes | `confirmed(name, callbackNumber, about)` | none |

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

Read back before it runs, in these words: "Here's your request: {name}, your {vehicle}, damage: {damage}, on {wheels} of its wheels, finish: {finish}, dropping off {slot}. We'll reach you on {callbackNumber}, and texts there are OK: {textOk}. Is that right?"

Rules, in the order they run:

- the caller's yes to a read-back of name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk

After the caller's yes it is followed by `send_photo_request` and `notify_shop_request`, each through the gate.

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text | hidden (`•`) |
| `vehicle` | text | as it is |
| `wheels` | choice (one, two, three, four) | as it is |
| `damage` | text | as it is |
| `finish` | choice (diamond cut, painted, not sure) | as it is |
| `slot` | slot from `check_availability` | as it is |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |

### `send_photo_request`: a change

Follows send_request on the customer's yes, only with their yes to texts too (the runtime runs it; the model is never offered it).

Never offered to the model: it runs after the caller's yes to `send_request`, with the values read back there.

Read back before it runs, in these words: "We'll text {callbackNumber} asking for a photo of the damage. Is that right?"

Rules, in the order they run:

- textOk must be one of yes (refused as no-consent)
- the caller's yes to a read-back of callbackNumber, textOk

| Param | Type | Recorded |
| --- | --- | --- |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |

### `notify_shop_request`: a change

Follows send_request on the customer's yes, texting the shop a summary (the runtime runs it; the model is never offered it).

Never offered to the model: it runs after the caller's yes to `send_request`, with the values read back there.

Read back before it runs, in these words: "We'll text the shop a summary of the request from {name}. Is that right?"

Rules, in the order they run:

- the caller's yes to a read-back of name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text | hidden (`•`) |
| `vehicle` | text | as it is |
| `wheels` | choice (one, two, three, four) | as it is |
| `damage` | text | as it is |
| `finish` | choice (diamond cut, painted, not sure) | as it is |
| `slot` | slot from `check_availability` | as it is |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |

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
| `vehicles` | text | as it is |
| `slot` | slot from `check_availability` | as it is |

### `notify_shop_booking`: a change

Follows book_dealer on the caller's yes, texting the shop a summary (the runtime runs it; the model is never offered it).

Never offered to the model: it runs after the caller's yes to `book_dealer`, with the values read back there.

Read back before it runs, in these words: "We'll text the shop a summary of the booking for {account}. Is that right?"

Rules, in the order they run:

- the caller's yes to a read-back of account, cars, vehicles, slot

| Param | Type | Recorded |
| --- | --- | --- |
| `account` | slot from `recognise_caller` | as it is |
| `cars` | choice (one, two, three) | as it is |
| `vehicles` | text | as it is |
| `slot` | slot from `check_availability` | as it is |

### `leave_callback`: a change

Leave the shop a note to call the customer back, for someone who wants to speak with a person.

Read back before it runs, in these words: "We'll have someone from the shop call {name} back on {callbackNumber} about {about}. Is that right?"

Rules, in the order they run:

- the caller's yes to a read-back of name, callbackNumber, about

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text | hidden (`•`) |
| `callbackNumber` | phone | by its last four |
| `about` | text | as it is |

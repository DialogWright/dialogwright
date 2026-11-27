# Policy card: Example Wheel Works

*Generated from `agent.yaml`'s actions by `pnpm policy:card`: do not edit it by hand. Change the file, write the card again, and review the diff. A test fails when this page and the file disagree.*

## How the gate decides

- A model leads the conversation, but it acts only through the actions below, and every action goes through the gate. Each decision, allowed or refused, is written to the audit.
- Anything not listed under Actions is refused.
- Every action is open to a caller nobody has proven (level 0): this app has no identity. The number a caller calls from may recognise a known account; it is never proof of who is speaking.
- The rules of an action run in the order shown, and the first one that fails decides.
- Every change is read back in the business's fixed words with exactly the values it will run with. The caller's answer is read as a yes or a no by the decision model (not the agent model), and the change runs only on a clear yes (the gate's `confirmed` rule, over all of the change's params, runs last). A lookup is never confirmed.
- Where a change gives a short read-back (`readBackChange`), a correction after a full read-back the caller heard and did not confirm is read back by its changed values alone, in the business's own phrases (shown with each action below): the caller heard every other value in that full read-back, and a yes confirms every value, as the gate's `confirmed` rule over all of the change's params requires.
- On a call (`readBacks.holdAfterCut`: on), once the caller has spoken over a read-back of a change before hearing it (cut in before 85% of it, or spoke as it began), every later read-back of that change is said whole and cannot be talked over (the agent model's words before it can be), until the change is confirmed, withdrawn or its journey no longer offers it; its first read-back can always be talked over. Speech that began before a held read-back finished playing is ignored, recorded by its length only, never its words, and where the carrier cuts the reply all the same (an interrupt, over the read-back or the words before it), it counts as cut in on and the yes after it confirms nothing. Where a change gives a brief read-back (`readBackBrief`, shown with each action below), a held read-back says it, naming every value the full one names, and a correction's short read-back is held too; the yes to either confirms them all. A chat is unchanged.
- One confirmation at a time: a call made while a read-back waits for its answer is not run, and is no refusal of its action (it counts toward no limit below).
- Anything but a clear yes runs nothing: the agent model is told that nothing was changed and what the caller said.
- A clear no that says nothing of what should be different (read by the decision model) is answered by `lines.notConfirmed`, word for word ("No problem. What would you like to change, or would you rather cancel the request?"), and the agent model is told the line asked; it answers what the caller says next.
- A follow-on action runs only after its parent ran on the caller's yes, with the values read back there, through the gate with its own confirmation hash; it has no read-back of its own.
- After 3 refusals of the same action on a call (`limits.refusalsPerAction`), the agent model is told to offer the caller a person rather than try again.
- On a call (`silence`: after 9 s, 1 re-prompt), when the caller says nothing for 9 s once the line's last reply has played, the agent model is told so and answers it (where it fails, `lines.silence`, word for word: "Are you still there? Take your time, we can carry on whenever you're ready."); after 1 such in a row, one more ends the call with `lines.silenceEnd`, word for word ("It sounds like now isn't a good time, so we'll let you go. Call us back any time."), audited as `converse_end` by `silence`, a change not confirmed included (it was never done). Where the line answers a silence, a read-back waiting for the caller's yes no longer waits: it is not confirmed, no refusal of it is counted, and their yes needs it read back again. Any speech of the caller's starts the count again. A chat has no silence wait.
- `end_call` is the runtime's own action, offered to the model on every call: it ends the call on the model's own goodbye (the closing line where the model writes none), and changes nothing. The first `end_call` after a read-back the caller did not confirm (turned down, spoken over or not read) is refused and audited, and the call goes on: a goodbye written with it has been said, and the agent model is told the change was never done and to ask whether the caller still wants it, unless they have said they do not. Any later `end_call` in that turn is refused too, and the caller's next turn decides: there, the next `end_call` ends the call. No change is kept where the decision model reads that the caller withdrew it (in their answer to the read-back, or on a later turn), or once the journey no longer offers its action.
- `transfer_call` is the runtime's own action, offered to the agent model only on a call (never in a chat) and only while the business is open by `business.open` (`transfer.whenClosed`: callback): while it is closed the agent model is not offered it. It puts the caller through to a person at agent.yaml's transfer number (`transfer.number`), and changes nothing: the agent model's own words written with it are said first, `lines.transfer`, word for word ("One moment, we'll put you through to the shop.") where it writes none, then the call goes to the number (audited as `converse_end` by `transfer_call`, and the call's end as `call_ended` with the reason `transfer`, by `request`). It takes no params: nothing the model writes reaches the carrier, and nothing of the call (no summary, no values) is passed to the person. The unsent rule refuses it as it refuses `end_call`: the first after a read-back the caller did not confirm is refused and audited, and the agent model is told to ask whether the caller still wants the change. Called where it is not offered, it is refused as not offered and audited.
- A call the agent model has failed past `limits.failuresPerCall` is put through to the same number only where `transfer_call` would be offered at that moment (the same rule: on a call, while the business is open): `lines.handoff`, then the transfer line, its `call_ended` the reason `transfer`, by `handoff`. Otherwise it ends as a handoff with no transfer number does (`call_ended` the reason `handoff`): `lines.handoff`, then on a call the closing line, and nothing is said of putting the caller through.

## What a model is sent and what is recorded

- The agent model is sent, in full: the caller's words, its own replies, the fixed lines said, the arguments of its own action calls, each read-back as it was said (the caller's own values among it), and what each action returned, as the action returned it. Nothing checks an action's result: there is no closed-form check on a converse action's reply, so an action returns only what the model may see. This app has no identity factors to withhold.
- The decision model (not the agent model) is sent each read-back as it was said, the caller's own words in answer to it and the business's day (today's date, in words), to read a yes or a no, whether the caller says what should be different, and whether they withdraw it. While a change the caller did not confirm is kept, each later caller turn's words, the line's last reply and what the change is for (its action's `about`, never its values) are also sent, to read whether the caller no longer wants it. The check after speaking is off (agent.yaml `checks.claims.mode: off`): the decision model is sent no reply of the agent model.
- For routing among the journeys, the decision model is also sent each caller turn's words, the line's last reply before them (the read-back waiting for its answer, where one is), and the trigger (`when`) of each journey open to the caller (the journey in progress and one set aside among them).
- In a finished journey's after phase, the decision model is also sent the finished journey's goal. A turn whose yes runs its read-back is not routed.
- In a journey in progress, the decision model is also asked whether the caller's turn has anything to do with the task (`fits`).
- At the root, where the line has said something, the decision model is also asked whether the caller's turn answers what the line last asked (`answers`).
- At the root, a turn is unclear only when none is the top reading and the turn does not answer what the line last asked; a journey starts from the root only at `routing.startAt`.
- In a journey, a turn is unclear when it does not fit, is no question and moves to no other journey at `routing.switchAt`. The line then guides the caller instead of guessing.
- On the second unclear turn in a row the agent model is also sent the business's reason for the line (`business.line`), where it has one.
- In a journey in progress, the agent model is also sent the trigger (`when`) of each other journey open to the caller (not the one set aside), so it can say what else the line does and ask whether to switch.
- The agent model is told, on every request, whether the business is open now (from `business.open`, in the business's time zone) and when it closes or next opens. The agent model is told never to promise a callback for a time the business information does not give, the opening time included.
- A call that starts while the business is closed hears `lines.greetingAfterHours`, word for word, in place of the greeting (and of a journey's): "Thanks for calling Example Wheel Works. We can price a repair, set up a drop-off, or take a note for the shop to call you back; the shop itself is closed right now. How can we help?", and in the web chat "Thanks for messaging Example Wheel Works. We can price a repair, set up a drop-off, or take a note for the shop to call you back; the shop itself is closed right now. How can we help?"
- The caller's number reaches the agent model only by its last four digits, so it can say them; the whole number goes only to the actions' code (a phone param the model writes as `caller` is resolved by the runtime).
- Only the reason the gate refused a call is scrubbed before the agent model is told it: any value of a param that is recorded hidden is replaced by its recorded form. The reason a call's values were not valid for their types, and the words an action failed with, go to the agent model as written.
- The trace and the audit record each action's params as its `audit` says, hidden (`•`) where it says nothing (see each action's table below). Only the audit records an action's result, as the model is sent it, with the values of hidden params replaced and cut to 600 characters; the trace records whether it ran (and the words it failed with, those values replaced), not what it returned.
- The caller's own words, typed or spoken, are kept as they said them in the trace and the frame log, as in the scripted mode.

## Journeys

- Each caller turn, the decision model reads which journey (task) the caller wants now. The agent model is offered only the actions of the journey it is in (or the root's), and an action of another journey is refused as not offered, audited and not counted as a refusal of the action.
- The root offers no actions and has its own instructions.
- An unclear turn (see above) is answered with guidance, never a guess. While it is answered, only the lookups are offered to the agent model, so change actions are withheld: none is offered, and one called anyway is refused as not offered and audited. A turn that answers a read-back is never unclear: the caller is following the line, so the journey's actions stay offered and a correction can be read back again. The count of unclear turns in a row starts again on any turn that is not unclear. On the third in a row the line says `lines.unclear`, word for word ("Sorry, this line can only help with a wheel repair or a callback. Call us back any time.", and in the web chat "Sorry, this chat can only help with a wheel repair or a callback. Get in touch any time."), and the call ends (audited as `converse_end` by `unclear`).

### `request`

- Trigger: The caller wants a wheel repaired (they describe damage to their wheels, or ask whether it can be fixed), a price, to bring a car in, or someone from the shop to call them.
- Open only where the number calling is on no account.
- Actions: `check_availability`, `send_request` and `leave_callback`
- Never done: no action ends it, so it stays in progress after each change runs on the caller's yes.

### `dealer_booking`

- Trigger: The caller wants to book cars in for repair, or someone from the shop to call them.
- Open only where the number calling is on an account. Starts the call there.
- Actions: `recognise_caller`, `check_availability`, `book_dealer` and `leave_callback`
- Greeting, said word for word where it starts the call: "Example Wheel Works, hi. Booking some cars in today?"
- Done when `book_dealer` runs on the caller's yes.

## Actions

| Action | Kind | Offered to the model | Journeys | Rules | Follow-on actions |
| --- | --- | --- | --- | --- | --- |
| `recognise_caller` | lookup | yes | `dealer_booking` | none | none |
| `check_availability` | lookup | yes | `request`, `dealer_booking` | none | none |
| `send_request` | change | yes | `request` | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes)` | `send_photo_request`, `notify_shop_request` |
| `send_photo_request` | change | no: follows `send_request` | none | `oneOf(textOk: yes)`, `confirmed(callbackNumber, textOk)` | none |
| `notify_shop_request` | change | no: follows `send_request` | none | `confirmed(name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes)` | none |
| `book_dealer` | change | yes | `dealer_booking` | `confirmed(account, cars, vehicles, slot)` | `notify_shop_booking` |
| `notify_shop_booking` | change | no: follows `book_dealer` | none | `confirmed(account, cars, vehicles, slot)` | none |
| `leave_callback` | change | yes | `request`, `dealer_booking` | `confirmed(name, callbackNumber, about, notes)` | none |

### `recognise_caller`: a lookup

The dealership account the number calling is on file for, if any: call it before book_dealer, whose account must be one it returned. A number on file recognises an account; it does not prove who is speaking.

Rules, in the order they run:

- none: a lookup reads and returns a result; it is open to every caller

### `check_availability`: a lookup

The drop-off windows on a day: each with room has its id and how many cars it can still take (its room); each without says why (full, or its drop-off time has passed today), as does a day the shop is closed. The only source of what is free.

Rules, in the order they run:

- none: a lookup reads and returns a result; it is open to every caller

| Param | Type | Recorded |
| --- | --- | --- |
| `day` | date | as it is |

### `send_request`: a change

Send the shop a customer's repair request with the drop-off window they picked, for anyone who is not a dealership account. Ask whether we may text them at their number before calling it. Call it as soon as you have every detail, the drop-off window among them once the customer has heard its day, date and drop-off time from you and accepted it: the request is then read back to the customer and sent on their yes, so it is not in until this is called and confirmed.

Read back before it runs, in these words: "So that's a request for {name}: your {vehicle}, with {finish}, and work on {wheels} of its wheels for {damage}. That's for {slot}. We'll reach you on {callbackNumber}, and you said {textOk} to texts there.[ We'll also pass on: {notes}.] Did I get that right?" (a part in square brackets is said only when its value is given)

A correction is read back by its changed values alone, after the caller heard the full read-back and did not confirm it, in these words: "Got it, {changes}. Is everything else right?", {changes} the phrase of each param changed, in this order, joined by commas and the last two by "and":

| Param | Phrase |
| --- | --- |
| `name` | "the name {name}" |
| `vehicle` | "your {vehicle}" |
| `wheels` | "work on {wheels} of its wheels" |
| `damage` | "{damage}" |
| `finish` | "{finish}" |
| `slot` | "{slot}" |
| `callbackNumber` | "we'll reach you on {callbackNumber}" |
| `textOk` | "{textOk} to texts there" |
| `notes` | "we'll also pass on: {notes}" |

Read back in full instead where a value was cleared, or the values are the same as the last read-back (the caller asked to hear it all). The yes to a short read-back confirms every value, as the yes to the full one does.

Said again held, after the caller spoke over it before hearing it, in these words: "That's {name}, your {vehicle}, for {slot}: {finish}, and work on {wheels} of its wheels for {damage}. We'll reach you on {callbackNumber}, and {textOk} to texts.[ And the note: {notes}.] Is that right?" (a part in square brackets is said only when its value is given)

Rules, in the order they run:

- the caller's yes to a read-back of name, vehicle, wheels, damage, finish, slot, callbackNumber, textOk, notes

After the caller's yes it is followed by `send_photo_request` and `notify_shop_request`, each through the gate.

| Param | Type | Recorded |
| --- | --- | --- |
| `name` | text (one line, at most 120 characters) | hidden (`•`) |
| `vehicle` | text (one line, at most 120 characters) | as it is |
| `wheels` | choice (one, two, three, all four) | as it is |
| `damage` | text (one line, at most 120 characters) | as it is |
| `finish` | choice (the bright metal finish, the painted finish, the mixed metal finish, a finish the shop will check) | as it is |
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
| `wheels` | choice (one, two, three, all four) | as it is |
| `damage` | text (one line, at most 120 characters) | as it is |
| `finish` | choice (the bright metal finish, the painted finish, the mixed metal finish, a finish the shop will check) | as it is |
| `slot` | slot from `check_availability` | as it is |
| `callbackNumber` | phone | by its last four |
| `textOk` | choice (yes, no) | as it is |
| `notes` | text (one line, at most 120 characters) | as it is |

### `book_dealer`: a change

Book a dealership account's cars straight into a drop-off window, only for the account the caller's number is on file for; anyone else sends a request instead.

Read back before it runs, in these words: "So that's {account}, {cars} in all: {vehicles}, for {slot}. Shall we book it?"

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

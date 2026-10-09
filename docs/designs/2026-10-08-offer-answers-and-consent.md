# An offer's answers, required offers, and consent for the whole call (design)

Date: 2026-10-08. Status: decided (decisions 6, 7 and 8 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), built on the `offer-consent` branch (see "As built"). Engine: DialogWright local `main`.

## At a glance

Three building blocks, all off by default or matching today:

1. **The answers an offer takes.** Every offer (the caller's number, a proposal from the facts) takes `answers: yes-no-or-value`, which is today's behaviour and the default, or `answers: yes-no`.
   - "Shall I look up your account from the number you're calling from, or just tell me the account number?" takes yes, no or digits.
   - "Are you calling about the account ending in 1234?" takes only yes or no. A value said there isn't taken; it counts as a no. On the keypad, 1 is yes and 2 is no.
2. **A required offer.** An offer whose value the call needs, such as the number to send a one-time code to, uses the defaults: `onNo: ask` and `ifNone: ask`. A no asks the slot's own question, and the slot's ladder ends at a person. Nothing new is needed in the engine. The docs and the skill name it ("a required offer"), and a scripted call pins it. An optional offer, such as a reminder text, sets `onNo: skip`.
3. **Consent to text for the whole call.** An app may ask once, after the greeting:

   > "Can I text you helpful links during this call, at the number ending in 0142?"

   - **Granted:** every text moment the consent covers uses the caller's number without asking again.
   - **Declined or unanswered:** each moment asks its own offer, as today.
   - **Recorded:** every grant (the call-wide one, and each one at a moment) gets an audit row.

Clinic, utility, the testkit and the fixtures are unchanged unless they opt in.

## 1. `answers`

```yaml
slots:
  textTo:
    type: digits
    callerNumber: { countryCode: '1', onNo: skip, ifNone: skip, answers: yes-no }
  place:
    type: text
    offer: facts
    offerAnswers: yes-no
```

- On a `callerNumber` offer, the key goes inside `callerNumber`. On `offer: facts` it is `offerAnswers`. Both default to `yes-no-or-value`.
- **With `yes-no`**, at the offer:
  - the offered slot doesn't listen, so no value is taken from that turn;
  - a turn with a value and no clear yes counts as a no, so it follows `onNo`, and the audit `answer` is `no`;
  - the keypad maps 1 to yes and 2 to no;
  - other slots of the form still listen as today.
- **With `yes-no-or-value`**, nothing changes from today. "No, use 555 555 0199" and a bare number fill as said, with `answer: other`.
- The prompt lists only yes and no as its options, as today. Only what the engine accepts changes.

## 2. Required offers

- No engine change. A test fixture scenario, a required callback number for a code where the caller says no, then gives a number, pins that the defaults make an offer required.
- The authoring guide gets a short "Required or optional" paragraph under the text offer section. The skill states when each fits.

## 3. Call-wide text consent

```yaml
# app.yaml
textConsent:
  covers: [textTo, reminderTo]     # callerNumber slots this consent stands in for
```

- **Asked:** once, on a call (speech), right after the greeting, with `consent_texts` (with `{last4}`).
  - It is asked only when the caller's number is kept (not withheld or foreign) and `App.callerOffer` allows the first covered slot.
  - It is never asked on chat.
  - It reuses the greeting proposal's machinery: the yes, no, request and silence handling, and the `greet_after_offer` line.
- **Only one question follows the greeting.** The order is:
  1. caller ID identification (`callerId.ask: greeting`);
  2. then text consent;
  3. then a greeting proposal.

  Any of these not asked at the greeting is asked where it would be asked anyway: the slot, or when identity is needed.
- **Yes:** `s.textConsent = 'granted'`, and the audit row `consent { scope: 'call', granted: true, last4, promptId, said }`. Then, at each covered slot:
  - the slot fills with the caller's number, confirmed, with no question;
  - an `offer` row with `answer: 'consent'` records that the call-wide grant was used;
  - the `callerNumber` policy rule passes as for a yes.
- **No:** `s.textConsent = 'declined'`, and `consent { scope: 'call', granted: false }`. Each covered slot asks its own offer.
- **A request or silence:** consent is unknown and isn't asked again. Each slot asks its own offer. The audit `consent` row has `granted: null`.
- **A yes at a moment's own offer** is recorded by its `offer` row, as today: every grant is recorded.
- **A caller who later says "stop texting me"** is not handled by the engine; that is an app intent. The session field is readable by app code (`textConsentOf(s)`) for apps that need it.
- **`pnpm check`:**
  - each `covers` slot must have `callerNumber`;
  - `consent_texts` is required when `textConsent` is set;
  - a warning if no covered slot's form can be reached.

## 4. Tests

- **`answers: yes-no` on the texting fixture (a variant):**
  - a value said at the offer is a no;
  - the keypad 1 and 2;
  - the default is unchanged.
- **Required offer:** the callback fixture's default offer, where a no asks the slot (already covered); add one scenario where the slot is required for the form's completion.
- **Call-wide consent (a texting variant with two covered slots):**
  - granted, both slots filled without a question, two `offer` rows with `answer: consent`, one `consent` row;
  - declined, each slot asks;
  - a request instead;
  - withheld number, not asked;
  - chat, not asked;
  - with a greeting proposal configured, consent wins and the proposal moves to its slot.
- **`pnpm check`:** the three cases above.

## As built

Where the build differs from the design above, or fills in what it left open:

- **How `yes-no` stops the slot taking a value.** The slot offered is left out of what the turn fills (`fia.ts slotsToFill`, while the offer is pending; the no's own fill leaves it out by name), not out of what the model is asked: its question is still sent at the offer, so the request at a `yes-no` offer is the same as at a default one, and the engine can tell a value from a plain yes or no. "A value" is what the slot's fill would read as a new value (`fia.ts valuesGiven`): a number of the wrong shape is not one, and words that answer neither ask the offer again, as before. `callerNumber.ts yesNoOffer` is the one predicate.
- **Keys are one answer.** Each key is a turn of its own, so a number keyed at the offer would otherwise decline on its first key and answer the next question with the rest. At an offer that takes a yes or a no only, and at the consent question, the keys are held (`Session.dtmfBuffer`, as a digits slot holds a partial number; `turn.ts keyBurstPending`) and settled when they stop or on `#` (`settleKeys`): a 1 alone is a yes, a 2 alone a no, anything else asks the offer again once, a turn on its ladder, with nothing recorded of the keys. "When they stop" reuses the no-input wait's silence turn: after a key held there the server runs it `KEY_WAIT_MS` (default 2000, at least 300: under it the keys of a number keyed by hand could each settle alone) after the last key rather than a whole `NO_INPUT_MS` later, whether or not the no-input wait is on. Words that come while keys are held drop the keys before the model's request is built, so it is not told of them (`asr.dtmf`), and they are not settled after. The server drops `#` and `*` as before, but passes a `#` on as a turn when it ends held keys, decided in the call's queue after the key turns before it; replay decides the same from its session. A settle on the silence turn is recorded `by: keypad` (`OfferSettled.keyed`).
- **At the greeting.** A proposal with `offerAnswers: yes-no` at the greeting takes a value said as a no: nothing is filled into the slot from that turn (`TurnIO.kept`), and the request said with it goes on, or `greet_after_offer` asks the open question.
- **`offerAnswers` beside `callerNumber`.** It is refused there, with the fix to write `answers` inside `callerNumber`, and refused without `offer: facts`.
- **The required offer's scripted call.** The callback fixture already had "a no, then a number" (`offer-no-then-said`). The new one, `offer-required-no-then-nothing`, is a no and then nothing said: the slot's ladder ends at a person and the form never reaches its summary, which is what makes the defaults a required offer.
- **The consent question's state.** It is pending as the first covered slot's read-back `at: greeting` with `consent: true` (`Session.pendingConfirmation`), so it reuses the greeting proposal's machinery as designed, and the trace masks its value by that slot's `redact`. Its yes fills nothing. The model is told it as `target: consent`, by the last four only.
- **A value said at the consent question is a no.** Consent is a yes or no question, so it takes `yes-no`'s rule: "text me at 555 555 0199 instead" declines it, and that number is not taken. The keypad's 1 and 2 grant and decline it.
- **Which slot the question is for.** The first slot in `covers` that takes the caller's number and that the app's `callerOffer` allows, asked for each in turn at the greeting, with no form open; with none, consent is not asked. The harness seeds a corpus line at the question the same way (`turn.ts askTextConsent`), from `testing.seed.callerNumber` and the call-start lookup.
- **The hook at each covered slot.** A grant does not skip the app's `callerOffer`: it is asked at each covered slot before the slot is filled, as for an offer, so the app still decides per slot (a slot it refuses goes on as its `ifNone` says). The engine does not remember its answers; an app memoizes in the facts (the texting fixture's hook keeps the line type, so the gated lookup is not made twice). The texting fixture's hook now offers any number it texts only for a mobile; it has one text slot, so its calls are unchanged.
- **A yes that names another number.** "Yes, text 555 555 0199" at the consent question is not a grant to the number the question named: it is asked once more (the greeting proposal's ladder), and still not a plain yes or no it is unknown (`granted: null`). A yes naming the caller's own number is a yes.
- **What a consent fill writes.** The `offer` row for a slot filled from the grant has `answer: consent`, `promptId: consent_texts`, the consent line as `said` and its `locale`, both as they were when the caller said yes (kept on `Session.textConsent`, `{ answer, said, locale }`, so a call that moves to another language records the line the caller heard), and `by: null`, since nothing was asked on that turn. Two covered slots filled on one turn write two rows (`TurnOut.consented`). The form's checks run on the value at once, as on any fill.
- **The consent row** is `consent { scope: call, granted, promptId, said, last4, by, locale }`; `by` is null for a silence. It is written before the turn's offer rows.
- **`textConsentOf(s)`** returns `granted`, `declined`, `unknown`, or null when it was never asked. `Session.textConsent` (`{ answer, said, locale }`) is optional and plain JSON, absent for every app without it, so `SESSION_SCHEMA` is unchanged, as for the earlier optional fields.
- **Recording.** `answers: yes-no` sends the model what a default offer sends. An app that turns `textConsent` on changes the request on the turns at the consent question, so a recorded cassette misses there until it is recorded again.
- **`pnpm check`.** Besides the three cases designed: a slot in `covers` that is not one, `greeting_offer` and `greet_after_offer` (the greeting's machinery), and a `consent_texts` that must say `{last4}` and nothing else, so a grant is always to a number the caller heard named (the safer choice, as for a proposal's line). Every form has an intent, so "a form that can be reached" is a form that asks the slot.
- **Corpus lines** at the consent question are `no_form` with `confirm` and no `prompted`; the harness seeds the first covered slot's placeholder as the number asked about (`runner.ts seedTextConsent`).
- **Tests.** The texting fixture's variants are in `src/testing/texting/variant.ts` (`YES_NO`, `YES_NO_ASKS`, `CONSENT`, `CONSENT_AND_PROPOSAL`, `CONSENT_SPANISH`, `CONSENT_TWO_FORMS`, and the codes that refuse a slot); the fixture's calls are unchanged (its seed gains the number a seeded consent question is asked for). The server's handling of keys is in `server/keyBurst.test.ts`. The consent variant adds a second number to text, `alertTo`, in the same form, both covered.


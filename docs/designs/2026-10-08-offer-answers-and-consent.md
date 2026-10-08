# An offer's answers, required offers, and consent for the whole call (design)

Date: 2026-10-08. Status: decided (decisions 6, 7 and 8 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), being built. Engine: DialogWright local `main`.

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

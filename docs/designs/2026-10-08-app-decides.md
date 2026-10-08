# The app decides: proposals anywhere, checks that need identity (design)

Date: 2026-10-08. Status: decided (decisions 2, 3, 9 and 10 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), built on the `app-decides` branch, except the greeting variables (see "As built"). Engine: DialogWright local `main`.

## At a glance

Several `pnpm check` refusals and engine limits from 2026-10-07 encode a business judgement rather than a broken app. Each one becomes an option or a warning. The safe behaviour stays the default, and the app changes it in its own files, where a reviewer can see it.

| Today | After |
|---|---|
| A proposal (`offer: facts`) is made only when its slot is asked, never at the greeting. | `offerAt: slot` (default) or `offerAt: greeting` on the slot. The greeting may also render the facts as variables. |
| `offer: facts` is refused unless app.yaml has a caller lookup. | Allowed: facts loaded after identity (an entry call, a hook) can be proposed. The refusal goes. |
| A check action above the form's proven level is refused, and a `STEP_UP` from a check goes to a person. | A warning. At runtime a check's `STEP_UP` asks for identity as any gated call does, then the check runs again. |
| A check may not read an identity factor slot. | A warning. An age check on the birthdate is legitimate. |
| Docs and comments say the lookup "must return only what may be said before identity". | Advice, not a rule: the app decides what its lookup returns and what its lines say. The framework does not filter it. |

Caller ID as an identity factor (the remaining "never identity" refusals) is item 3 of the build order and has its own design.

**Backwards compatible.** No existing app relies on a refusal it no longer gets. An app with a check above its proven level would have failed `pnpm check` before, so none exists. The default `offerAt` is `slot`. Clinic, utility, the testkit and the fixtures are unchanged.

## 1. Proposals at the greeting

```yaml
slots:
  account:
    type: digits
    offer: facts
    offerAt: greeting
```

- At call start, after the lookup, the greeting is said as today. If a slot with `offerAt: greeting` has a proposal (`facts.offers` returns one), the engine asks `offer_<slot>` instead of the open "How can I help?" question, with the same variables as a proposal at the slot.
- **Yes:** the slot holds the value, confirmed, and the engine asks the open question (`greet_after_offer`, a new prompt with a default). The value is kept for the form that uses the slot, as a value said outside a form is kept for a slot that listens anywhere.
- **Yes with a request** ("yes, I want to pay my bill"): the slot is filled and the request goes on as an opening request.
- **No:** nothing is filled. The `offered` audit row records the no, and the engine asks the open question. The slot is asked normally when its form needs it, and is not proposed again in that form.
- **A request with no yes or no:** treated as the opening request. The proposal is dropped, not repeated.
- One greeting proposal per call: the first `offerAt: greeting` slot in slots.yaml order that has a proposal.
- **The greeting's own variables:** the greeting prompts may use `{facts.<key>}` for any string fact the lookup returned. A missing fact makes the greeting fall back to its no-facts variant, so a line never says "Welcome back, ." `pnpm check` refuses a greeting variable that names no declared fact key, where the app declares them. Otherwise it gives a warning that the variable can't be verified.

## 2. Proposals from facts loaded later

- The `crossLink` refusal "...app.yaml has no callerNumber with a lookup, so nothing looks the caller up to propose from" is removed. `facts.offers` is still required: that refusal is wiring, not a judgement.
- Docs: `offer: facts` proposes from whatever the session's facts hold when the slot is asked. That can be the call-start lookup, a form's entry call (after identity) or a hook.
- Test: a fixture form whose entry call loads facts after identity, then proposes a value for a later slot from them.

## 3. Checks that need identity

- The level refusal in `checkProblems` becomes a warning in `checkWarnings`: "check X needs identity level N, which the form's entry does not prove first; the caller will be asked to verify when the check runs".
- At runtime, a `STEP_UP` from a check starts identity, as a `STEP_UP` from any gated call does. When identity reaches the level, the check runs again from `continueForm`. A failed or abandoned verification follows the identity ladder's own ending. A reason in `on` named `step-up` is not supported: identity is the engine's.
- The identity-factor refusal becomes a warning: "check X reads Y, an identity factor; it holds a value only once the caller has given it during verification".

## 4. Docs

- The authoring guide:
  - `offerAt`;
  - greeting variables;
  - proposals from later facts;
  - checks above the proven level;
  - checks on identity factors;
  - the lookup advice reworded.
- Comments in core/app/types.ts.
- The create-app skill gets a line on each, under its pattern sections. Item 7 covers the rest.

## As built

Where the build differs from the design above, or fills in what it left open:

- **The greeting line before a proposal.** An app's greeting line usually ends on its open question ("How can I help?"), so it cannot also come before a proposal. A call that opens on a proposal says a new line, `greeting_offer` (the greeting without the question), then `offer_<slot>`. `pnpm check` needs `greeting_offer` and `greet_after_offer` for an app with an `offerAt: greeting` slot. There are no default prompts in the engine, so neither has one.
- **Calls only.** A greeting proposal is made only on a channel with speech. A chat has no number, so no call-start lookup, and its greeting is as always; the slot proposes at the slot there.
- **A slot some form asks.** Only an `offerAt: greeting` slot that some form lists is proposed at the greeting.
- **At the slot as well.** An `offerAt: greeting` slot with no candidate at call start (or not the first) proposes at the slot as `offerAt: slot` does, where the facts have a candidate by then.
- **How the value survives into the form.** A yes fills the session's slot, confirmed. A form's slots are emptied only when that form closes, so the value stays through any form without the slot, and the first form that has it does not ask it. On the yes turn, the request said with the yes opens its form without filling the slot again from the same words. `Session.greetingOffered` keeps the slot from being proposed again until the first form that has it closes.
- **The request in the same breath.** The confirmation gate decides a yes or a no first. The turn's words are then read again as an opening turn (the gates once more, from the same answers, with the proposal settled). A request goes on as one. With none, what the words gave the call's own slots is kept, as on any turn that opens no form, and `greet_after_offer` is asked.
- **Unanswered.** A silence or words that answer neither ask the proposal once more, then `greet_after_offer`, with no attempt counted on the slot or the intent. A proposal dropped that way writes an `offer` row with `none`. One dropped by a request, an informational question or a choice between two writes none, as at the slot.
- **The read-back asks for no slot.** The pending read-back is marked `at: greeting`, and its prompt's target is `intent`, so no slot treats the answer as one to its own question and a key pressed there answers nothing.
- **Greeting variables deferred.** `{facts.<key>}` in a greeting line is not built. Prompt variables are plain names (`segments.ts` VAR, `\{(\w+)\}`), and a dotted name would touch clip segmentation, the variable checks and the translation checks, with no declared fact keys to check against. It is left for its own design.
- **A check's STEP_UP.** `lifecycle.ts stepUp` is the entry call's step-up, shared: `turn.ts stopForm` calls it for a check's STEP_UP in an app with identity. The step-up keeps the check's action with no params (it is never made again as it stands). `ensureEntry` goes on with a pending step-up before it asks whether the form is entered, so a check's step-up continues there, and once the caller is verified the form loop runs the check again (a check that has not passed is not in `Session.checked`). Factors already in hand and matching verify at once, and the form loop goes on.
- **A check on an identity factor.** The factor need not be one of the form's slots (`validateApp` takes it), and a check's `confirm` never reads a factor back.


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

- **The greeting line before a proposal.** An app's greeting line usually ends on its open question ("How can I help?"), so it cannot also come before a proposal. A call that opens on a proposal says a new line, `greeting_offer` (the greeting without the question; app.yaml's `prompts.greetings.offer` names another), then `offer_<slot>`. `pnpm check` needs it and `greet_after_offer` for an app with an `offerAt: greeting` slot. There are no default prompts in the engine, so neither has one. `pnpm check` warns of `offerAt: greeting` with no `callerNumber` lookup.
- **Calls only.** A greeting proposal is made only on a channel with speech. A chat has no number, so no call-start lookup, and its greeting is as always; the slot proposes at the slot there.
- **A slot some form asks.** Only an `offerAt: greeting` slot that some form lists is proposed at the greeting.
- **At the slot as well.** An `offerAt: greeting` slot with no candidate at call start (or not the first) proposes at the slot as `offerAt: slot` does, where the facts have a candidate by then.
- **How the value survives into the form.** A yes fills the session's slot, confirmed. A form's slots are emptied only when that form closes, so the value stays through any form without the slot, and the first form that has it does not ask it. On the yes turn, the request said with the yes opens its form without filling the slot again from the same words. `Session.greetingOffered` keeps the slot from being proposed again until the first form that has it closes.
- **The request in the same breath.** The confirmation gate decides a yes or a no first. The turn's words are then read again as an opening turn (the gates once more, from the same answers, with the proposal settled). A request goes on as one. With none, what the words gave the call's own slots is kept, as on any turn that opens no form, and `greet_after_offer` is asked.
- **A value of the caller's own.** "No, it's 14 Birch Lane", or the address with neither a yes nor a no, answered the question asked: it fills the slot, whatever its `listen`, the offer row says `other`, and the form does not ask it.
- **A priority intent wins.** The gates' priority reading overrides the yes, as it overrides any verdict: the priority form opens, and the yes is not kept.
- **The debug table.** The request read again shows as `opening:<gate>` rows beside the turn's own, never credited with deciding it.
- **Corpus lines.** A line at the greeting's proposal is `no_form` with `prompted` the slot and `confirm`; the harness seeds the slot's placeholder proposed after the greeting's line (`runner.ts seedGreetingOffer`), so a recorded case replays the yes, the no and the request.
- **Unanswered.** A silence or words that answer neither ask the proposal once more, then `greet_after_offer`, with no attempt counted on the slot or the intent. A proposal dropped that way writes an `offer` row with `none`. One dropped by a request, an informational question or a choice between two writes none, as at the slot.
- **The read-back asks for no slot.** The pending read-back is marked `at: greeting`, and its prompt's target is `intent`, so no slot treats the answer as one to its own question and a key pressed there answers nothing.
- **Greeting variables deferred.** `{facts.<key>}` in a greeting line is not built. Prompt variables are plain names (`segments.ts` VAR, `\{(\w+)\}`), and a dotted name would touch clip segmentation, the variable checks and the translation checks, with no declared fact keys to check against. It is left for its own design.
- **A check's STEP_UP.** `lifecycle.ts stepUp` is the entry call's step-up, shared: `turn.ts stopForm` calls it for a check's STEP_UP in an app with identity. The step-up keeps the check's action with no params (it is never made again as it stands). `ensureEntry` goes on with a pending step-up before it asks whether the form is entered, so a check's step-up continues there, and once the caller is verified the form loop runs the check again (a check that has not passed is not in `Session.checked`). Factors already in hand and matching verify at once, and the form loop goes on.
- **A check on an identity factor.** It never lets the form complete unrun. As soon as it waits on nothing but the factor (`runChecks` returns `identity`), identity is asked for, to level 1, through the same step-up, and the check runs once the factor is given. Where no factor is taken (a web chat, whose callers sign in; a caller verified some other way), the form goes to a person (`form_stopped`, no reason): signing in fills no factor, so the check could never run. The factor need not be one of the form's slots (`validateApp` takes it), and a check's `confirm` never reads a factor back.
- **A check with no level** is still refused: an action with no level needs the highest, so a forgotten `level: 0` would make every caller verify part-way. Only a level written out above what the entry proves is a warning.
- **A STEP_UP to a level the caller has.** A rule of the app's own that says STEP_UP whatever the level would loop on the code: a check's STEP_UP for a caller already at the level goes to a person, as before (`turn.ts checkStepUp`). An entry call's is unchanged.
- **Abandoned.** A step-up never answered walks the factor's ladder to a person; a switch to another form drops the step-up and the form.


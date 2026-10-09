# Sub-forms (`next:`) and when a form's slots listen (design)

Date: 2026-10-08. Status: decided (decision 12 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), being built. Engine: DialogWright local `main`. Earlier sketch: [2026-10-07-qualify-then-collect.md](2026-10-07-qualify-then-collect.md), section 6.

## At a glance

Two building blocks:

1. **`next:` and internal forms.** A form may name the form that follows it when it completes. A form marked `internal: true` is not an intent: the model, the keypad and the queue never see it. It is reached only by a `next:`, and it has a `label` of its own. Slots that both forms list carry across with their values and confirmations, so a screener's answers are never asked again in the booking. The engine moves to the next form itself, and app code never writes the queue.
2. **`listenBeforeEntered: true | false` on a form.** It sets whether the form's slots fill from what the caller says before the form opens: on the opening turn, which is today's `up-front`, or anywhere. The default is `true` for a form that is an intent, which is today's behaviour, and `false` for an internal form. A slot's own `listen` still overrides it. With `false`, a value said early is asked again in the form; the maintainer accepted that.

Clinic, utility, the testkit and the fixtures set neither option, so they behave as today.

## 1. YAML

```yaml
forms:
  screen_home:
    slots: [problem, ownership, town]
    summaryPromptId: null
    checks: [...]
    hooks: []                       # with next, no complete hook is needed
    calls: []
    next: book_visit
  book_visit:
    internal: true
    label: book your free inspection
    slots: [problem, ownership, town, address, name, phone, day, timeOfDay]
    summaryPromptId: confirm_book_visit
    hooks: [confirmedParams, complete]
    calls: [bookVisit]
    # listenBeforeEntered: false is the default for an internal form
```

## 2. `next:`

- When a form with `next` completes as `said` (or completes with no complete hook, which `next` allows), the engine:
  1. records the completion as today;
  2. closes the form, keeping every slot the next form also lists, with its value, display, confirmation and agreed state;
  3. enters the next form at once, ahead of anything queued, with `bridge_next` using the next form's label;
  4. carries on with `continueForm`.

  A form that is first entered by `next` doesn't speak an `ack_intent`. The bridge line takes its place.
- A completion of `end`, `refused`, `reconfirm` or `decision` doesn't follow `next`, and neither does a check refusal: the form ends as written.
- Requests the caller queued earlier wait until the chain of `next` forms is done.
- **`pnpm check` refuses:**
  - a `next` to a form that doesn't exist;
  - a cycle of `next`;
  - an internal form no `next` reaches;
  - an internal form with an intent in intents.yaml;
  - an internal form with no `label`;
  - a form with neither `complete` (nor `answers`) nor `next`.
- **Not refused:** a `next` to a form that is also an intent. A booking can be reached both ways; the app decides.
- The keypad menu and `secondIntent` list only intents, so internal forms are left out of both.
- A priority intent or a switch to another request during the chain leaves it, as it leaves any form. The internal form is not queued, so it isn't resumed. The skill says to keep chains short.

## 3. Labels

- `formLabel(app, form)` replaces `intentLabel` wherever a form id is labelled: the bridge, the ack, the queue ack, stopForm, and the active form label sent to the model. It uses the intent's label when there is one, and the form's `label` otherwise. Nothing changes for apps whose forms are all intents.
- The app map draws an internal form under the form that leads to it ("after screen_home"), with no intent node.
- The `form-without-intent` warning skips internal forms.

## 4. `listenBeforeEntered`

- **The rule for a slot's listening:**
  - The slot's own `listen`, when set, decides as today.
  - Otherwise, if every form that lists the slot has `listenBeforeEntered: false`, the slot behaves as `listen: form`: it fills only inside a form that lists it, and never on the turn that opens that form.
  - Otherwise it is `up-front`, as today.
- A slot shared by a root form and an internal form therefore still listens up front, because the root form allows it. That is the expected case: a qualifying answer said on the opener is kept.
- **Identity factors and carried slots** keep their own rules. `listenOf` already returns null for a factor and `call` for a carried slot.
- `pnpm check` gives a warning when a slot's `listen` contradicts the forms that list it (a `listen: anywhere` slot in forms that all say `false`), so the designer sees it.

## 5. What's recorded

- The completion row of the first form as today, then the bridge.
- The second form's own rows.
- A completion row has `next: <form>` when it moved on.

## 6. Tests

- **A screened variant:**
  - `screen_home` (qualifying, checks, no summary) with `next: book_visit` (internal);
  - one breath that qualifies then books, with the shared slots not asked again;
  - a refusal at the screen, with no move on;
  - a queued request waits until after the booking;
  - a priority intent mid-booking;
  - `bridge_next` with the internal label;
  - the model's intent question has no `book_visit` criterion.
- **`listenBeforeEntered`:**
  - an intent form with `false`: a value said on the opener is asked again;
  - an internal form's slot said on the opener: not kept (it lists only internal forms);
  - a slot shared with a root form: kept;
  - a slot `listen` override.
- **`pnpm check`:** each refusal and the warning.
- **The app map and policy card goldens** of the existing fixtures are unchanged. The variant gets a page test.

## 7. Docs

- The authoring guide: forms.yaml keys; "Every form id must also be a form intent" becomes "unless it is internal"; "Where a slot listens" gets the form switch; the gaps it mentions (a queued form loses a value said on the opener) now point to `next`.
- The create-app skill: "Qualify before you collect" mentions `next` for a booking after several screeners, and says that one form with checks is still the first choice.

## As built (2026-10-08)

Built on the `sub-forms` branch as above, with these differences and choices:

- **What's recorded.** There was no completion row to add `next` to: a completion is recorded only by `completed` in the session, the trace and the end frame. The move is a new audit row, `form_next { form, next }`, written only when a form goes on, one per move (`TurnOut.movedOn` is a list: a middle form already full moves on on the same turn). Each sits after the gate rows before its move and before the next form's, by the count of gate events at the move (as the caller-ID match's rows are placed). A form moved through on the same turn has its bridge dropped, so one bridge is said. Apps without `next` write no new row.
- **The chain is one task.** In a form reached by `next`, the forms it was reached through on this call (`Session.reachedThrough`, the path actually taken) count as the form in hand: in the adding share (`addedIntent`), in what may replace it (`other`), in the priority row's `in_form`, and in `enqueue`. Naming the screen the caller came through again inside the booking neither queues nor restarts it, and "yes, and something urgent too" queues the urgent request. A first build used every form that could lead to the booking (statically, transitively), which stopped a switch or a queue to another screener into the same booking, and to the screens of a booking that is also an intent asked for directly; the path taken has neither problem. For a form entered any other way the set is the open form alone, so an app without `next` reads exactly as before.
- **Earlier checks hold.** The session keeps `reachedThrough`, the forms the open one was reached through on this call, in order (a new optional field, named apart from the principal's and the policy subject's `via`: absent otherwise, cleared by `setForm` and `closeForm`, no schema bump, as earlier optional fields). `checksOf` runs, before the form's own, every check of those forms that reads only slots the open form lists and that it does not list itself, with the earlier form's outcomes: a town changed at the booking's summary gets the screen's out-of-area line. The path taken is used, not every form that could lead there, so a second screener's checks never apply to the first screener's caller. A check's read-back and the model's view of it find these checks too.
- **A switch inside the chain.** A switch to another screener opens it with the answers the call already holds (a switch empties nothing, as for any form), so it may complete at once and go on to the booking again, now reached through it.
- **Checks carry.** The passes of every check that runs in the next form (its own and the earlier ones that hold) carry across, each with the hash of what it passed with (`Session.checked`). The gate is not asked again about a value it already allowed, and a value changed later runs the check again, since the hash no longer matches. A check the next form reads with other slots hashes differently, so it runs. The next form's `checksPassed` is said only if one of its checks is still to pass. Every check's read-back nos go with the first form.
- **A refusal on the move.** When a check refuses on the turn the chain moved, `endByCheck` drops the moved-through forms' entering lines and their `checksPassed` as well as the bridge: only the refusal is heard.
- **check's safety warning** (a rule a check holds that the write does not) compares a form's checks with the writes of the form and the forms after it, so a screen with `calls: []` is covered by its booking's write.
- **What else carries.** For the kept slots: the value, display, confirmation and agreed value; their read-back nos go (setForm already drops them). A greeting proposal for a kept slot stays spent. The next form's entry call runs as for any form entered, and `facts.onFormClosed` still runs for the form that closed.
- **No complete hook.** defineApp gives a form with `next` and no `complete` hook a `said` completion with the turn's lines. `FormDef.complete` stays required in the TypeScript contract, so an app written in code writes `(c) => ({ kind: 'said', acks: c.acks })`.
- **One refusal added.** `check` also refuses a `label` on a form that is not internal: a form intent's label is in intents.yaml, so the key would do nothing. The missing-label refusal is the schema's, at the form's `internal` key. The "neither complete, answers nor next" refusal keeps its old text and fix, so existing messages are unchanged.
- **`validateApp`** (an app written in TypeScript) refuses the same five: an unknown `next`, a loop, an internal form no `next` reaches, one with an intent, one with no label.
- **Listening.** A slot listed by no form listens up front, as before. The warning is for a slot's own `listen` (`up-front`, `anywhere` or `call`), and for a slot app.yaml's `carrySlots` names, when every form that lists it says `false`.
- **Labels.** `formLabel` throws for a form with neither an intent nor a label (refused at definition, so never at run time). The console's NOW panel names an internal form by its label when `console.formLabels` does not name it; for an app without internal forms the console's labels are exactly as before. `formWords` (the app map and the policy card) reads an internal form's label after the console's and the intent's.
- **App map.** An internal form is drawn right after the form that leads to it, its first node "After screen_home: ..." in place of the intent. A form with `next` gets a "Then, at once" node, and its row in the intents table ends "then goes on to ...". Existing fixtures' pages are unchanged.
- **Fixture.** The two-form variant is `NEXT` in `src/testing/screened/variant.ts` (with `over` to stack variants); its app map is the golden `src/testing/screened/APP-MAP.next.md`, compared by `pages.test.ts`. Tests: `src/core/subForms.test.ts` (the runtime, the listening, the chain as one task, two moves on a turn, a refusal on the move, the earlier checks, a session round trip mid-chain, and chat) and `src/define/subForms.test.ts` (check, validateApp, the warning, the console labels).

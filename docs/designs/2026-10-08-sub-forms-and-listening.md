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

# Confirming any answer, or only certain values (design)

Date: 2026-10-08. Status: decided (decision 1 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), being built. Engine: DialogWright local `main` (3343141). Source: the foundation repair trial, where a misheard "I rent" would end the call with no read-back.

## At a glance

Two building blocks, both off by default:

1. **A slot reads back when the app says so.** Every library slot type takes `confirm: always` (a yes/no read-back as soon as it fills), as well as `summary` and `by-confidence` where they already exist. A choice slot also takes `confirmValues: [rent]`: those values are read back at once, and the others follow the slot's `confirm` mode. "Confirm `rent`, not `own`" is one line in slots.yaml.
2. **A check's refusal can read back first.** A check outcome takes `confirm: <promptId>`. Before the refusal acts, the engine asks that yes/no line ("Just to check, you're renting the home?"). On a yes the refusal acts as written. On a no, the check's `with` slots are emptied and asked again, and the check runs again when they fill. The read-back is skipped when every slot in `with` is already confirmed, for example after a summary yes or an `always` read-back. This covers refusals that can't be written as a list of values, such as a rule over several slots or a rule of the app's own.

The app decides what is confirmed; the engine supplies the mechanism. The create-app skill says when: an answer that ends the call or turns a caller away is confirmed first.

**Backwards compatible.** No existing app sets either option, so clinic, utility, the testkit and the `testing/screened` scenarios are unchanged: no new model question on their sessions and no golden change. Only the generated JSON schemas and docs change.

## 1. Today

- `SlotSpec.spokenConfirm` is `always | by-confidence | summary` (core/slots/types.ts). Library choice, digits and date slots expose `confirm: summary | by-confidence` in slots.yaml. Text, name, record, topic and birthdate are fixed at `summary`. `always` is reachable only from a code slot.
- An `always` slot that has filled but isn't confirmed stops `continueForm` until its read-back is answered (`confirm_<slot>`, yes/no in gate 6). A yes confirms it. A no goes to `ask_<slot>_dtmf`, and a second no hands off.
- Form checks run in `continueForm` on the turn their slots fill, after any `always` read-back. For a `summary` or `by-confidence` slot, which is every slot in the trial app, a check runs on an unconfirmed value. The authoring guide says checks never run "on an unsettled value", which holds only for `always` slots and is corrected by this change.

## 2. The slot options

```yaml
slots:
  ownership:
    type: choice
    options: { own: "I own it", rent: "I rent" }
    confirmValues: [rent]        # read "rent" back at once; "own" waits for the summary
  phone:
    type: digits
    confirm: always              # read back as soon as it fills
```

- `confirm: always` is added to the library types that lack it. It needs a `confirm_<slot>` prompt, which renders with the slot's display as `{<slot>}`, as the summary does. `pnpm check` asks for it.
- `confirmValues` (choice only) lists option keys. Each must be a key of `options`, which `pnpm check` verifies. When the slot fills with one of them, it reads back as an `always` slot would; any other value follows `confirm`. A `confirm_<slot>` prompt is required when `confirmValues` is set.
- **A no** to a library slot's read-back empties the slot and asks it again: `ack_declined`, then `ask_<slot>` (the keypad form `ask_<slot>_dtmf` when the app has one and the slot takes keys). A second no follows the existing ladder to a person. A code slot's existing `always` behaviour is unchanged.
- A keyed value is confirmed already, as today. A slot confirmed at its read-back is not asked again at the summary's yes.

## 3. The check option

```yaml
checks:
  - action: checkOwner
    with: [ownership]
    on:
      not-owner: { confirm: check_renting, say: decline_renter, then: end }
```

- `confirm` names a yes/no prompt that renders with the form's slot displays, as `say` does. It is allowed with every `then`.
- On a refusal with `confirm` and any `with` slot unconfirmed, the form pauses on the read-back. The pending confirmation targets the check and records the action and reason. The read-back is not counted as the form's end, and no `form_stopped` row is written yet.
- **Yes:** the `with` slots are marked confirmed and the refusal acts as written: `say`, then `then`. The `form_stopped` row gets `confirmed: true`.
- **No:** the `with` slots are emptied, and so is the check's `checked` entry. The engine says `ack_declined`, and the form asks the first emptied slot. When they fill again the check runs again, and its read-back is asked again only if it refuses again.
- **No clear answer:** the existing confirmation ladder applies (re-ask, then a person). The refusal never acts on silence.
- A refusal at completion, after the summary's yes, has every slot confirmed, so it acts directly. The read-back is never asked twice for one value.

## 4. What's recorded

- Each read-back answer is a gate-6 decision in the trace, like any confirmation.
- `form_stopped` gains `confirmed: true` when a read-back preceded it.
- A no to a check's read-back adds the audit row `check_reconfirmed { form, action, reason }`, so an auditor can see that a caller corrected the deciding answer.

## 5. Tests

- Unit tests on a variant of `testing/screened`:
  - ownership with `confirmValues: [rent]`;
  - the area check with `confirm`.
- Scenarios to cover:
  - a renter is read back and ends;
  - a misheard renter says no and is asked again, then qualifies;
  - "own" is not read back;
  - a check read-back yes ends the call;
  - a check read-back no re-asks the town and passes;
  - a refusal after the summary's yes is not read back;
  - silence at the read-back follows the ladder.
- The existing `testing/screened` scenarios stay as they are.
- `pnpm check` cases: a `confirmValues` key that isn't an option; a missing `confirm_<slot>` prompt; a check `confirm` prompt that doesn't exist.

## 6. Docs

- The authoring guide:
  - slots.yaml `confirm` and `confirmValues` for each type;
  - the check `confirm` option;
  - the corrected timing sentence;
  - the spokenConfirm table.
- The choice slot README and the generated slot docs.
- The skill's "Qualify before you collect" pattern: read back the answer that ends the call. Item 7 of the build order covers the rest of the skill.

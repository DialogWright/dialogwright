# Per-slot retries: the build (flow building blocks, piece 1)

Date: 2026-10-09. Status: **build plan; being built.** Source: [2026-10-08-flow-building-blocks.md](2026-10-08-flow-building-blocks.md), section 6, and the maintainer's decisions at its end. Pieces 2 (`callData` with transfer targets and data) and 3 (`routes.yaml` with `hours` and `onStart`) get their own build notes when this one is merged, since piece 3 reuses the outcome this one introduces.

## What a slot gets

Every slot, library or code, may say how many times it is asked, what each retry says, and what happens when it runs out. None of it is required, and an app that writes none of it behaves exactly as today, byte for byte, in its stub and recorded regressions.

```text
# slots.yaml
accountId:
  type: digits
  attempts: 4                  # default: the engine's MAX_ATTEMPTS (3)
  onMaxAttempts: skip          # handoff (default) | skip | an outcome, below
referral:
  type: choice
  options: [...]
  onMaxAttempts: { say: referral_skipped, then: skip }
planType:
  type: choice
  options: [...]
  onMaxAttempts: { say: plan_help, then: form, form: plan_help }
memberId:
  type: digits
  onMaxAttempts: { then: handoff, reason: member-lookup }
```

## Decisions

1. **The ladder, per slot.** With `attempts: N`, failures 1 to N-2 re-ask (the retry line), failure N-1 is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad, else a re-ask, and failure N runs `onMaxAttempts`. `attempts: 3` is today's ladder. `attempts: 1` runs `onMaxAttempts` at the first failure; `attempts: 2` goes to the keypad rung at the first. Allowed: 1 to 10.
2. **Every way a slot runs out takes the same outcome.** Misses, silences, an unanswered read-back, and the second no to a read-back (the read-back's own count of two stays as it is) all end in the slot's `onMaxAttempts`. A caller-number offer that runs out keeps its own `onNo` and `ifNone`; the identity code's ladder and the intent's ladder are not slots and do not change.
3. **Retry lines per attempt, all optional, falling back as today.**
   - A miss at failure k says `ask_<slot>_retry<k>` if prompts.yaml has it, else `ask_<slot>_retry` (today's line). `ask_<slot>_retry2` is the second re-ask.
   - A silence at failure k says `ask_<slot>_noinput<k>`, else `ask_<slot>_noinput`, else today's `no_input` line followed by `ask_<slot>`. A `_noinput` line is the whole turn ("Sorry, I didn't hear anything. What's your account number?"): it replaces both.
   - The keypad rung says `ask_<slot>_dtmf`, as today.
   - The design's `_nomatch` name is not added: `ask_<slot>_retry` already is the line for a missed answer, and a second name for it would only be a choice to get wrong.
4. **`onMaxAttempts` is a check's outcome shape, extended.** The short forms are `handoff` (the default, today's behaviour, reason `max-attempts`) and `skip`. The long form is `{ say?, then, reason?, form? }`:
   - `then: handoff`: to a person, with `reason` naming the handoff (its line `handoff_<reason>`, and in piece 2 the transfer target); default `max-attempts`.
   - `then: skip`: the slot is declined (`SlotState.declined`, as a skipped caller-number offer is): empty, answered, and the form goes on. `say` is optional.
   - `then: end`: `say` (required) and the call ends, as a check's `end`.
   - `then: anything-else`: `say` (required), the form is left uncompleted, and "anything else?" is asked, as a check's.
   - `then: form`: the form is left uncompleted and `form` is entered, as a `next:` is: the slots both forms list are kept. `say` is optional and is said before the form's own line.
5. **Checks take `then: form` too.** The maintainer's decision keeps "after a slot fills" with form checks, so a check's outcome may now go to another form the same way. One executor runs both.
6. **What `pnpm check` says.** These are refusals of a broken app, never of a business choice:
   - `form` names a form that exists, and not the form the slot is in;
   - `say` names a prompt in prompts.yaml (every locale);
   - `end` and `anything-else` name a `say`;
   - `reason` only with `then: handoff`;
   - `skip` (or `then: skip`) is refused on an identity factor (verification could never finish), and on a slot named in its form's summary line (the existing rule for a slot that may be left empty);
   - a warning, not a refusal, where a check's `with` reads a slot that may be skipped (the check would never run), and for a numbered retry line the slot's `attempts` never reaches.
7. **Records.** The trace has a `slot_exhausted` event `{ slot, attempts, outcome }`, the console shows "attempt k of N" with the slot's own N, and the app map draws each `onMaxAttempts` that is not `handoff`. A handoff's audit and trace are as today, with the reason it was given. No session field is added, so `SESSION_SCHEMA` stays; if the build needs one, it bumps it.
8. **Where it lives.** The keys are common slot keys (beside `listen`, `confirm`, `callerNumber`), so every library type takes them and a code slot sets them on its `SlotSpec`. The ladder reads them through one helper (the slot's attempts, falling back to `MAX_ATTEMPTS`), and every place a slot now hands off for running out calls one function that runs the slot's outcome.

## Tasks

Each task is test first: a failing test, the code, the test passing, a commit. The engine tests build small apps in code or from the fixtures, as the existing `core/*.test.ts` do.

1. **Schema and spec.** The keys in the slot schema (`define/schema/slots.ts`), `SlotSpec` (`core/slots/types.ts`), the shared outcome type and its validator (extending `CHECK_THEN` in `define/schema/forms.ts`, so a check's outcome and a slot's are one type). Regenerate the JSON Schemas. Tests: the schema accepts each form above and refuses `then: end` with no `say`, `reason` without `handoff`, `attempts: 0` and `11`.
2. **The ladder.** `retryStep` takes the slot's maximum; `failAttempt`, `reaskConfirmation`'s slot path, `askOnLadder` and the read-back decline's jump to the keypad rung all read it. Tests: `attempts: 1`, `2`, `4` and the default walk the rungs above, with and without a keypad rung, with and without a keypad on the channel.
3. **The retry lines.** The fallback chains for a miss and a silence. Tests: each chain with every link present and absent; the keypad rung unchanged; a window re-ask unchanged.
4. **The outcome.** One function that runs a slot's `onMaxAttempts` at every point a slot runs out (the list in decision 2), and the check executor moved onto the same code with `then: form` added. Tests: each outcome from a miss, a silence and a second read-back no; `skip` goes on to the next slot and the completion sees no value; `form` keeps the shared slots; `end` and `anything-else` say their line; a check with `then: form`; a `handoff` with a reason says `handoff_<reason>`.
5. **`pnpm check` and `validateApp`.** Every rule in decision 6, with a test for each refusal and warning (`define/check.test.ts`).
6. **Records.** The trace event, the console's attempt line, the app map's edges. Tests beside each (the trace and app-map tests that exist).
7. **A fixture that uses it.** An existing tiny app folder under `src/testing/` takes a slot with `attempts` and a `skip`, and another with `then: form`, with corpus lines and scripted calls for each, and its read-back pages regenerated and read as a change. No recording is needed: no model request changes.
8. **Docs.** The guide's slots.yaml section and a subsection on retries; the slot docs' common keys (regenerate `docs/slots`); the create-app skill's `options.md` (by the need: "a detail that is nice to have", "a caller who cannot give it"), its worksheet's Decisions table and `patterns.md`; the flow building blocks design marked as building.

## Done when

`pnpm check`, `pnpm -r typecheck`, `pnpm -r test`, the testkit's regression, and the clinic's and the utility's stub and recorded regressions are all green, the clinic's and the utility's unchanged, and the work is fast-forwarded onto local `main`.

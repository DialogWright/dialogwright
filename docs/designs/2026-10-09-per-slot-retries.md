# Per-slot retries: the build (flow building blocks, piece 1)

Date: 2026-10-09. Status: **built** (the decisions made while building it are under [As built](#as-built), at the end). Source: [2026-10-08-flow-building-blocks.md](2026-10-08-flow-building-blocks.md), section 6, and the maintainer's decisions at its end. Pieces 2 (`callData` with transfer targets and data) and 3 (`routes.yaml` with `hours` and `onStart`) get their own build notes when this one is merged, since piece 3 reuses the outcome this one introduces.

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

## As built

Where the build had to choose, it chose the option that keeps an app that uses none of the keys exactly as it was, and refuses only what is broken.

1. **`form` never names a form that lists the slot.** A slot may be in several forms, and its outcome is the same in each, so "not the form the slot is in" is read as "not any form that lists it": that form would ask it again and run out there again. `pnpm check` and validateApp refuse it.
2. **What becomes of the slot that ran out.** `handoff` and `end` leave it as it was, so a handoff hands over exactly what it did before. `skip` empties it and marks it declined, keeping its attempts. `anything-else` and `form` empty it, attempts and all, so a slot kept past the form (an identity factor, a carried slot) is asked afresh later rather than running out at its first miss.
3. **Entering a form by an outcome.** After `say`, the form entered is bridged into with `bridge_next` and its label, as `next` does, and the slots both forms list are kept. Unlike `next`, nothing of the form left carries: it did not complete, so its checks' passes are not the new form's and the new form is reached through nothing (`Session.reachedThrough`). A check's `form_stopped` audit row names the form entered as `next`. An internal form an outcome enters is reached, for validateApp, `pnpm check` and the app map ("After `book_visit` (an outcome)").
4. **The short forms are `handoff` and `skip` only.** `end`, `anything-else` and `form` need a line or a form, so they are written out; `onMaxAttempts: end` is refused with the long form as its fix.
5. **The trace's slot_exhausted event** is the record's `slotExhausted` field (a trace record is one turn), written only for a slot with retries of its own (`attempts` or `onMaxAttempts`), so every other app's trace is as it was. The console's attempt line reads the slot's own N from the console metadata (`ConsoleMeta.slotAttempts`).
6. **The retry lines.** A numbered line may start at 1 (`ask_<slot>_retry1`, the first re-ask). At the keypad rung of a slot that takes no keys, on a channel with a keypad, a missed answer takes the numbered retry line too, and a silence there falls back to what it said before, `no_input` then the retry line (`ask_<slot>_retry<k>` where there is one, else `ask_<slot>_retry`). On a chat the keypad rung is a re-ask, and a silence there falls back to `no_input` then `ask_<slot>`. A slot's own reason for a miss (`retryPromptId`) still wins over a numbered line, a window is still asked for its rest, and the caller-ID match question is still asked again as it was. An unanswered read-back that falls back to a re-ask takes the retry line for its failure.
7. **The warning for a check that reads a slot that may be skipped** covers a slot whose `callerNumber` skips (`onNo` or `ifNone: skip`) as well as `onMaxAttempts`.
8. **The app map** draws a handoff that has its own `reason` or `say` too, since it goes somewhere the default does not; only the bare default is left undrawn.
9. **A slot asked with no form open** (an identity factor at the greeting) that runs out with `skip` or `anything-else` sets identity aside and asks the open question (item 13); with `form`, the form is entered. `skip` on a factor is refused anyway.
10. **Where it lives.** The outcome constants (`OUTCOME_THEN`, `CHECK_THEN`, the short forms, the attempts range) are in `core/slots/types.ts`, so the engine's validateApp needs nothing from `define/`; the zod schemas in `define/schema/outcome.ts` read them. The executor is `actOn` in `core/turn.ts`, with `slotRunsOut` for a slot and `endByCheck` for a check; `core/outcome.ts` has the slot's attempts, its outcome, the retry lines and the ending an outcome makes.
11. **The fixture.** The screened fixture's town, when it cannot be made out, goes to an internal form, the office's call (`then: form`), whose call time is nice to have (`attempts: 2`, skipped). It has no stub baseline (`fixtures/expected`), so its two new scripted calls are held to their own expectations only, and no baseline was written or edited.
12. **A loop of moves within one turn** (review fixes). Outcomes may send forms back to each other (a check in each refusing the same value, a form with no slots whose `next` leads straight back), which would go round for ever on one turn. The engine keeps the forms a turn has left or entered by a move (`next`, or `then: form`); one entered again on that turn sends the call to a person (`needs-human`), and the trace's `formLoop` names the form and the form it came from. `pnpm check` warns (never refuses: a loop through checks that read different values on each pass may be meant) of every loop of moves that goes by at least one outcome (`moveCycles`, beside `nextCycles`, which still refuses a loop of `next` alone).
13. **An identity factor's outcome is identity's** (review fixes). No form lists a factor, so an internal form its `then: form` enters is reached through identity: validateApp, `pnpm check` and the app map count it (`factorsEnteringByOutcome`), and the map draws the factors that do not hand off in a section of their own. A factor asked at the greeting that runs out with `anything-else` (or `skip`, which `pnpm check` refuses on a factor) sets identity aside as closing a form does (the step-up gone, a caller-ID match in use back to unused) and asks the open question, `greet_after_offer`, as the greeting's proposal does when set aside. `pnpm check` warns of a factor whose outcome enters a form that needs identity (its entry's purpose, its calls' or its checks' levels), where the caller would be asked the factor again.
14. **`end` with a request queued** empties the slot, as `anything-else` does, so a slot kept past the form is asked afresh by the request.
15. **The Outcome type** is a union on `then`, so `form` is there exactly for `then: form` (and `reason` only for `handoff`); an outcome read from YAML is made into one at the boundary (`outcomeFrom`). Each slot's `onMaxAttempts` by id is built by one helper (`slotOutcomesOf`).
16. **The fixture's scripted calls** assert the lines said (`town_unclear`, `bridge_next`, `call_time_any`), not only the final decision. A check's `then: form` has no scripted call in the fixture: its area check's outcome is the fixture's existing out-of-area call, so the unit tests (core/retries.test.ts) cover it.


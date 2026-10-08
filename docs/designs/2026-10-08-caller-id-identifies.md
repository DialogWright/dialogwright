# Caller ID as an identifier (design)

Date: 2026-10-08. Status: decided (decision 4 of [2026-10-08-decisions.md](2026-10-08-decisions.md)), being built on a fixture. Engine: DialogWright local `main`. Earlier design: [2026-10-07-caller-id-for-apps.md](2026-10-07-caller-id-for-apps.md), section 3, which sketched caller ID as a *factor*. This design follows the maintainer's model instead: caller ID as the *identifier*, with a knowledge factor that verifies.

## At a glance

A very common IVR pattern: the number calling matches one account, so the caller isn't asked for the account number. They are asked only to verify it:

> "I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account."

- The app declares it in identity.yaml, on level 1: which factors the caller-ID match **stands in for** (the identifier, such as `accountId`) and which are still **asked** (the knowledge factor, such as `dob`).
- The call-start lookup, already built (`app.yaml callerNumber: { use: hint, lookup }`), finds the account. A new facts hook hands the engine the matched identifier. The caller never hears it, and the trace never shows more of it than the normal flow's identifier shows.
- When identity is needed, the engine asks the caller-ID question instead of the first factor. The verify tool gets the matched identifier and the factor the caller gave, exactly as if the caller had said both. The gate, the attempts rule and the verify tool are unchanged.
- **Fallback:**
  - "Different account", a no, or a failed verification: the normal ladder (`ask_accountId`).
  - A failed verification counts one attempt, as today.
  - The match is not offered again on that call.
- **The level:** a caller-ID verification reaches level 1, as the factors it replaces do. Level 2 still needs the one-time code. The app decides which forms accept level 1, through their purposes as today, and can tell the two routes apart: the principal records `via: caller-id`, which the audit row shows.

Off by default. Clinic, utility, the testkit and every existing fixture are unchanged.

## 1. identity.yaml

```yaml
levels:
  1:
    name: verified
    factors: [accountId, dob]
    verify: verifyCustomer
    callerId:
      identifies: [accountId]     # filled from the caller-ID match, never asked
      ask: on-need                # on-need (default) | greeting
```

- `identifies` lists factors of this level. The remaining factors (`dob`) are what the caller is asked. `pnpm check` refuses `identifies` covering every factor: then the match alone would verify, and the app should not reach that by accident. An app that really wants caller ID alone can write a verify tool that ignores a factor. That is visible in its code, and the docs say so.
- `ask: on-need` asks when a gated call first needs level 1 (a `STEP_UP`). `ask: greeting` asks right after the greeting, before the open question:
  - a factor given verifies, and the open question follows;
  - "different account" falls back to the normal ladder at once;
  - an opening request instead keeps the match for when identity is needed, and the request goes on.
- Requires app.yaml `callerNumber: { use: hint, lookup }` and the facts hook below. Both are wiring, refused by `pnpm check` when missing.

## 2. The facts hook

```ts
facts: {
  fromCallerLookup(facts, value) { ... },          // as today
  callerMatch(facts) { return facts.accountId ? { accountId: facts.accountId } : null; },
}
```

- `callerMatch` returns the values for every `identifies` factor, or null for no single match. It is the app's call: a number shared by two accounts returns null, and the normal ladder runs.
- The engine never says these values and never puts them in a prompt variable. They reach the verify tool's params, where policy `redact:` applies as it does to a spoken account number.

## 3. The flow

1. **Identity needed** (`nextFactor` with an anonymous caller):
   - if a match exists and hasn't been declined or failed, the engine asks `identity_caller_match`, with the remaining factors' questions in mind;
   - otherwise it asks the first factor, as today.
2. **The caller gives the factor:** the factor slot fills.
   - The engine writes the `identifies` slots from the match, marked as filled by caller ID, not as said.
   - `verifyFactors` runs unchanged. On success the principal is set with `via: 'caller-id'`, and the ack is `identity_verified`.
3. **"Different account" or no:** the match is set aside for the call. The engine asks the first factor (`ask_accountId`), with an optional `identity_caller_declined` line before it.
4. **A failed verification:**
   - `identityAttempts.factors` goes up by one, and every factor slot is emptied, as today;
   - the match is set aside;
   - the engine asks the first factor with `failedPromptId` (or `identity_failed`). The caller may be a family member on a shared phone; the normal ladder lets them identify their own account.
5. **No clear answer:** the slot's own no-input/no-match ladder, as for any factor.

Recognising "different account": a yes/no-like answer at the caller-ID question. A no, "different account" or "that's not me" all count. The engine adds one model question only for apps that set `callerId`. It doesn't change requests for any other app.

## 4. What's recorded

- The audit row `identity_caller_match { outcome: offered | verified | declined | failed }`. It never holds the identifier, only the caller number's last four, as the audit's `callerNumber` setting says.
- The verify call is a gate event as today.
- `call_started` and later rows show the principal's level. The principal's `via` is in the identity row.
- Session: `callerMatch: 'unused' | 'offered' | 'declined' | 'failed' | 'verified'`. The identifier itself stays in the app's facts.

## 5. What changes in the docs

- The "caller ID is never identity" sentences (authoring guide around 135, 690, 1219 and 2467; the comments in core/session.ts, core/app/types.ts and define/schema/app.ts; gate/callerNumber.ts) become: "never identity on its own; an app may let a caller-ID match identify an account, with a knowledge factor that verifies it (identity.yaml `callerId`)".
- The slot-level refusals stay as they are: `callerNumber` and `offer: facts` on an identity factor. They are about offering a value for the caller to say yes to, which is not verification. This design doesn't offer the identifier; it fills it silently and verifies with a factor.
- The create-app skill: when to use it, and that it is asked before the account number.

## 6. Tests

- A new fixture, `testing/recognized`, modelled on `testing/proposals`:
  - accounts with phone numbers;
  - `findAccountByPhone` returning the account id into facts;
  - `verifyCustomer` with an audit hook.
- Scenarios:
  - a match then the right date of birth: verified, `via: caller-id`;
  - a match, then "different account", then the normal ladder;
  - a match, then the wrong date of birth: one attempt, then the normal ladder;
  - no match: the normal ladder;
  - a withheld number: the normal ladder;
  - `ask: greeting` with a factor, and with a request instead;
  - a shared number (`callerMatch` returns null);
  - level 2 still needs the code.
- `pnpm check`:
  - `identifies` naming a slot that isn't a factor;
  - `identifies` covering every factor;
  - `callerId` without the caller lookup;
  - `callerId` without `callerMatch`.

## As built

Built on branch `caller-identifies` with the fixture `packages/dialogwright/src/testing/recognized`. Where the build differs from the design above, or settles what it left open:

- **Session.** `callerMatch` is absent until the match is first used, which is "unused": a session of any other app is as it was. Its values are `offered` (asked, or in use), `declined`, `failed` and `verified`. The step-up the greeting asks for is `stepUp: { call: <the verify tool>, need: 1, at: 'greeting' }`, with no form open.
- **Recognising "different account".** One yes-or-no question, `callerMatchDeclined`, read at the confirmation's no threshold (`CONFIRM_NO`). It is asked only while the match is in use and the prompt asked for a factor the match leaves to ask: at `identity_caller_match`, and at that factor's own retry lines. No other app's requests change, and this app's change nowhere else. The fixture stub reads `confirm: no` as a yes to it. Beside it, the identified factors' own questions are asked, and their answers are filled only on a turn that turns the match down (the match is set aside first): "different account, it's 5550 5678" keeps the number and asks the date of birth.
- **What listens.** While the match is in use, the identified factors (`accountId`) do not fill (fia.ts activeSlots), so a date of birth said as digits is never taken for the account number; they are asked about only beside the decline question, above. Once the match is set aside, every factor listens again.
- **When the match goes away.** `offered` never outlives the match: `nextFactor` resets it to unused when `callerMatch` now finds none (the app's facts changed, or the caller said an identifier of their own), and a step-up that ends without verifying (`setForm`, `closeForm`) resets it too, as the greeting path does. Whether the check ran with the match (the principal's `via`, the `verified` and `failed` rows) is read from the slots it filled (`by: 'caller-id'`), not from the state. Before this, a match offered and then lost (a form switch, an `onFormClosed` that cleared the facts) left the account number muted while the engine asked for it.
- **Filling the identifier.** The identified slots are filled just before the check, on the turn the last asked factor fills, with a value and no display (`SlotState.by: 'caller-id'`): no line, prompt variable or model request carries the identifier, and a language switch does not give it one. The trace and the console mask the value as the slot's `redact` says. A failed check empties them, `by` with them.
- **Two cases the design left open.** An identifier the caller says themselves before the question ("my account is ...") is verified as said: the match does not replace it. A knowledge factor said on the way in ("check my request, my birthday is ...") is checked with the match, and nothing is asked: the `offered` row is then not written, only `verified` (or `failed`).
- **The retry ladder.** A silence asks `identity_caller_match` again; a missed answer walks the asked factor's own ladder (`ask_dob_retry`, the keypad). The match stands at the retry.
- **The principal.** `Party.via?: 'caller-id'` (gate/types.ts), set by the engine when the match took part; a verify tool that returns `via` itself is not believed (it is dropped).
- **The audit row.** `identity_caller_match { outcome, callerNumber }`, where `callerNumber` is the number calling as policy.yaml's `audit: callerNumber` says (`last4`: `...0142`; `keep` whole; left out for `secret`), and by its last four where the policy says nothing (never reached by a valid app: check and validateApp require the lookup's param to be declared). Each row sits where its step happened among the turn's gate rows (TurnOut.callerMatch carries `at`, the gate events before it): `declined` before them, `offered` after the step-up, `verified` and `failed` after the check and its own row, before the retry probe a failure leads to.
- **Handoff.** A handoff before the caller is verified (the attempts already spent, a verify tool that fails) leaves the factors filled `by: 'caller-id'` out of the handoff's slots: they came from the number, not from the caller.
- **The greeting.** `ask: greeting` reuses the greeting proposal's lines: `greeting_offer` (or app.yaml's `prompts.greetings.offer`) before `identity_caller_match`, and `greet_after_offer` after the caller is verified. A request said instead (a form, an informational question, a choice of two) ends identity at the greeting and resets the match to unused, so it is asked again when identity is needed. "Different account" at the greeting asks every factor at once, with no form open. With both `ask: greeting` and a slot's `offerAt: greeting`, the caller-ID question wins at the greeting and the proposal is made at its slot.
- **Checks.** `pnpm check` (and `defineApp`) refuses `identifies` naming a slot that is not a factor of level 1, covering every factor, `callerId` without app.yaml's `callerNumber.lookup`, and without `facts.callerMatch`; it requires `identity_caller_match` (given no variables), and with `ask: greeting` the two greeting lines. `validateApp` holds an app written in code to the same.
- **The policy card** says the second route to level 1 in the identity section and adds its edge to the ladder diagram, only for an app with `callerId`.
- **Corpus.** A line at the question is in a form's context (or `no_form` with `ask: greeting`), `prompted` the first factor the match leaves to ask, with `confirm: no` ("different account") or `unanswered` (the factor, or anything else); `yes` is refused. It is seeded on a call from the new `testing.seed.callerNumber`, whose call-start lookup the seed makes through the gate.
- **Corpus for a recorded run.** Lines at the question for a date, a filler "no wait, it's April ..." with the right date, "different account", "that's not me", "no, that's not me", "different account, it's 5550 5678", "I don't know my birthday", words that answer neither, and a request instead (`change: replacing`), each with its stub outcome asserted. Nothing is recorded yet.
- **The fixture.** `testing/recognized` has a report (level 0) and the status (level 1). Its accounts include two on one number, so `callerMatch` returns null for it. The greeting and one-time code cases are variants (`variant.ts`); level 2 is checked on the code variant. The scenarios are a match then the right date, then "different account", then a wrong date; a number not on file; a withheld number; a shared number; and a report, which needs no identity.

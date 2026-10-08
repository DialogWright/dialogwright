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

# Example Power & Light: design worksheet

## The paragraph

> Build a phone and chat assistant for Example Power & Light, a small electric utility. Callers can report a power outage at their address (no verification needed, but they confirm the address and what they are seeing before we file it), hear their current balance and due date (they must verify with their account number and date of birth), and set up a payment arrangement that splits their balance into installments (this needs a one-time code sent to their phone; the first payment date must be within 30 days, and the arrangement can't exceed what they owe). Property managers who manage several accounts can check balances for their buildings and report outages for them, but a payment arrangement for a tenant's account must be handed to a person. Callers can also ask for the outage map website and office hours. Anyone can ask for a person at any time.

## Intents

| Intent id | Kind (form, informational, control) | What the caller wants | Example phrasings (five or more, terse ones included) |
|---|---|---|---|
| `report_outage` | form | report a power outage at an address | "I want to report a power outage", "my power is out", "outage", "no power", "the lights are out at 12 Birch Lane", "I think the power might be off on our street" |
| `check_balance` | form | hear the current balance and due date | "what do I owe", "balance", "how much is my bill", "when is my bill due", "what's the balance on account 5550 1234" |
| `set_up_plan` | form | split the balance into installments | "I'd like a payment arrangement", "payment plan", "can I pay in installments", "split it into three", "I can't pay it all at once" |
| `outage_map` | informational | the outage map website | "where is the outage map", "map", "is there a website with outages", "outage map", "can I see outages online" |
| `office_hours` | informational | office hours | "when are you open", "hours", "office hours", "what time does the office close", "are you open Saturday" |
| `agent` | control | a person, at any time | "a person", "representative", "operator", "can I talk to someone", "agent" |
| `repeat_prompt` | control | hear that again | "say that again", "repeat", "what was that" |
| `done`, `other`, `none` | control | as the scaffold has them | |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Asked when | Keypad? | Sensitive? |
|---|---|---|---|---|---|---|
| `report_outage` | the street address | `place` | `text`: `what: the street address where the power problem is`, `say: null` (read back as said), `redact: none` | always | no | not masked: `say: null` needs `redact: none` |
| `report_outage` | what they are seeing | `symptom` | `choice`: `no_power`, `partial`, `flicker`, `wire_down` | always | yes | no |
| `check_balance` | which account | `account` | `digits`: length 8 | delegates only (a subject's is filled from the verified principal) | yes | last4 |
| `set_up_plan` | how many installments | `count` | `choice`: `two`, `three`, `four`, `six` | always | yes | no |
| `set_up_plan` | the first payment date | `firstDate` | `date`: `range: future` | always | yes | no |
| (identity) | account number | `accountId` | `digits`: length 8 | step-up | yes | last4 |
| (identity) | date of birth | `dob` | `birthdate` | step-up | yes | masked |

## Actions

| Tool | Reads | Writes | Params (exactly what it sends) | Level | Rules, in order |
|---|---|---|---|---|---|
| `reportOutage` | nothing | an outage ticket | the confirmed list: `accountId` (''), `place`, `symptom`, `count` (''), `firstDate` (''), `total` ('') | 0 | `identity`, `role(manager allow)`, `confirmed` |
| `readBalance` | the account | nothing | `accountId` | 1 | `identity`, `role(manager allow)`, `scope(accountId)` |
| `findAccount` | the account | nothing | `accountId` | 1 (the plan's entry call has the purpose `set_up_plan`, level 2) | `identity`, `scope(accountId)` |
| `setUpPlan` | the account | a payment arrangement | the confirmed list, `place` and `symptom` '' | 2 | `identity`, `role(manager person)`, `scope(accountId)`, `confirmed`, `limit(total 0.01..amountDue(accountId))`, `dateInRange(firstDate notBefore today)`, `custom first-date-within-30-days` |
| `verifyCustomer` | accounts | nothing | `accountId`, `dob` | 0 | `attempts` |
| `sendCode` | the account's phone | texts a code | `accountId` | 1 | `identity`, `role(manager refuse)`, `scope(accountId)` |
| `verifyCode` | the code | nothing | (the code) | 1 | `identity`, `attempts` |

## Who may do what

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate `property_manager`, role `manager` |
|---|---|---|---|---|
| `reportOutage` | allowed | allowed | allowed | allowed |
| `readBalance` | after verifying to level 1 | allowed, own account only | allowed, own account only | allowed for the accounts they manage; refused (scope) for others |
| `setUpPlan` | after verifying to level 2 | after keying the code | allowed, own account, within bounds | a person (`handoff_role_person`) |
| `sendCode` | after verifying to level 1 | own account only | own account only | refused (`role`): a manager never texts a code to a tenant |

## Verification (identity.yaml)

- Subject kind: `customer`.
- Level 1: factors `accountId, dob`, checked by `verifyCustomer`.
- Level 2: a one-time code of 6 digits (default), sent by `sendCode` to the phone on the account, checked by `verifyCode`.
- Tries at each check before a person: 3 (default).
- On a chat: subjects sign in through the portal, proving level 2 (`signIn`).
- Delegates: `property_manager` with role `manager`. They reach the app signed in on a chat (`portal`).

## Confirmed writes

| Action | Read back as (the summary line) | Values the caller confirms |
|---|---|---|
| `reportOutage` | "You're reporting {symptom}, at this address: {place}. Shall I file that?" | `place`, `symptom` |
| `setUpPlan` | "That's {total} in {count} payments, the first on {firstDate}. Shall I set that up?" | `accountId`, `count`, `firstDate`, `total` |

The app's one list of confirmed fields: `accountId, place, symptom, count, firstDate, total`.

## Bounds

| Action | Field | Bound | Where it comes from | Rule | Verdict and reason |
|---|---|---|---|---|---|
| `setUpPlan` | `total` | at least 0.01, at most the amount due | `amountDue(accountId)` lookup over the account | `limit` | BLOCK, `limit` |
| `setUpPlan` | `firstDate` | not before today | the call's day | `dateInRange` | BLOCK, `date-range` |
| `setUpPlan` | `firstDate` | no later than 30 days after today | the call's day (gate facts) | `custom: first-date-within-30-days` | BLOCK, `date-range` |

## Informational answers

| Intent | The fixed line |
|---|---|
| `outage_map` | "You can see current outages and restoration times on our outage map at example.com slash outages." |
| `office_hours` | "Our customer office is open Monday through Friday, eight in the morning to five in the evening. Outages can be reported any time, day or night." |

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time (phone or chat, in or out of a form) | `live-agent` | `handoff_live_agent` |
| Verification fails 3 times, or the one-time code fails 3 times | `identity` | `handoff_identity` |
| A property manager asks for a payment arrangement | `role-person` | `handoff_role_person` |
| A gate decision that needs a person (no block line) | `needs-human` | `handoff_needs_human` |

## Choices the paragraph left open

- Installment counts: two, three, four or six (a `choice`), since there is no money or free-count slot type. The installments split the whole balance; the total read back is the balance on the account.
- The arrangement total is the whole current balance (computed, not asked), and `limit` holds it to the amount due.
- What the caller is seeing: four options (no power at all, part of the home out, flickering or dim lights, a wire down).
- Outage reports need no account and no verification; a property manager files them the same way (allowed).
- Code length 6, three tries, the framework's defaults.
- Accounts are eight digits (`5550 1234`), read in two groups of four; every slot that can be keyed has `keypad: true`.
- The keypad menu offers the three forms (1, 2, 3) and a person (0). The outage map and office hours are not on it (see Gaps).
- A property manager is refused `sendCode` (role rule): a manager never steps up, so a code to a tenant's phone has no use and could alarm the tenant. Found reading the policy matrix.
- Over-answers: a caller may say the address and what they see in one breath, or the count and the first day; the forms skip what is filled.
- A property manager's balance check names the account (`account` slot); the scope rule limits them to the accounts they manage.

## Gaps

| What | The framework | What I did | Cost |
|---|---|---|---|
| An address | no address slot type | `text` with `say: null`; the read-back quotes the caller's words | none (pattern known) |
| First payment within 30 days | `dateInRange` has no "today plus N" bound | `notBefore: today` and a custom rule | small |
| One confirmed list per app | outage and plan share one list | union of fields, '' for the ones a write lacks | small |
| Delegates on the phone | delegates only on a signed-in chat | property managers use the chat | none |
| The address read back | `pnpm check` refuses `say: null` with the default `redact: length`; patterns.md does not mention it | `redact: none` on `place`: the address is in the trace and the audit as said | a few minutes |
| An address said with the request | a `text` slot keeps the whole turn | the read-back quotes the whole sentence ("the power is out at 22 Alder Street and nothing works"); the caller still confirms it | none; a real address type would fix it |
| Informational intents on the keypad menu | `pnpm check` accepts them, but `handleDtmf` in the engine ignores a menu key that is not a form or `agent` (the caller hears nothing) | left the outage map and hours off the menu | a scenario and some reading of turn.ts |
| Nothing owed on the account | a bound refuses only when the write is tried, after the summary; `limit` cannot stop the form before its questions for a subject | the summary reads "$0.00 in three payments" and the gate then refuses with `plan_amount_outside` | a clumsy call for that one caller |
| A delegate's answers inside a form | corpus lines inside a form cannot carry `as`, so they are seeded with a customer | the `account` answers run as a customer in the corpus; the manager's path is covered by scripted calls with `as` | none |
| The framework's own test of policy.matrix folders | `packages/dialogwright/src/define/matrixCommand.test.ts` lists the workspace's matrix folders exactly, so a new app's `policy.matrix` fails it | left failing (the framework is out of bounds); recorded in docs/trials/2026-10-03-utility.md | `pnpm -r test` is red until the framework test is changed |

## Baseline edits

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| | | | |

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [x] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [x] Every slot has at least five answers in the corpus, every summary at least four.
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); each bound is tested at its edges; every custom rule is a `defineRule` with examples the tests run.
- [x] Scripted calls cover each form, each principal (anonymous, each level, each delegate role), the step-up, failed verification, each refusal, each handoff, keypad entry and each informational answer.
- [x] `identity.yaml` matches the paragraph: who must verify, with what, the code only where a level 2 action needs it, the tries.
- [x] The policy read back (`policy.matrix`, and the policy card if there is one) matches "Who may do what" above, cell by cell.
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`.
- [x] Nothing private or real: invented names and streets, 555 numbers, `example.com` addresses.
- [x] `pnpm check` ok; this app's, the clinic's and the testkit's regressions match their baselines. `pnpm verify` is not green: one framework test (`matrixCommand.test.ts`) lists the workspace's matrix folders and fails with this app's `policy.matrix` (see Gaps). The app's own tests and type check are green.
- [x] The baseline was made once with `regress --update`, read entry by entry, and every later edit is under "Baseline edits".
- [x] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and how it is built, and keeps the scaffold's recording steps; `CLAUDE.md` still matches the folder.
- [x] The gaps above are written up.

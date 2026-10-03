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
| `setUpPlan` | the account | a payment arrangement | the confirmed list, `place` and `symptom` '' | 2 | `identity`, `role(manager person)`, `scope(accountId)`, `confirmed`, `limit(total 0.01..amountDue(accountId))`, `dateInRange(firstDate today..today+30)` |
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
| `setUpPlan` | `firstDate` | not before today, and no later than 30 days after today | the call's day (`notBefore: today`, `notAfter: today+30`) | `dateInRange` | BLOCK, `date-range` |

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
- The keypad menu offers the three forms (1, 2, 3), the outage map (4), the office hours (5) and a person (0). A key for an answer plays its line and offers the menu again. (The trial left 4 and 5 off while the engine ignored such a key; see Gaps.)
- A property manager is refused `sendCode` (role rule): a manager never steps up, so a code to a tenant's phone has no use and could alarm the tenant. Found reading the policy matrix.
- Over-answers: a caller may say the address and what they see in one breath, or the count and the first day; the forms skip what is filled.
- A property manager's balance check names the account (`account` slot); the scope rule limits them to the accounts they manage.

## Gaps

| What | The framework | What I did | Cost |
|---|---|---|---|
| An address | no address slot type | `text` with `say: null`; the read-back quotes the caller's words | none (pattern known) |
| First payment within 30 days | `dateInRange` had no "today plus N" bound when the app was built | first a custom rule (`first-date-within-30-days`); now `notAfter: today+30`, and the custom rule is gone (after the trial) | small; closed |
| One confirmed list per app | outage and plan share one list | union of fields, '' for the ones a write lacks | small |
| Delegates on the phone | delegates only on a signed-in chat | property managers use the chat | none |
| The address read back | `pnpm check` refuses `say: null` with the default `redact: length`; patterns.md does not mention it | `redact: none` on `place`: the address is in the trace and the audit as said | a few minutes |
| An address said with the request | a `text` slot keeps the whole turn | the read-back quotes the whole sentence ("the power is out at 22 Alder Street and nothing works"); the caller still confirms it | none; a real address type would fix it |
| Informational intents on the keypad menu | when the app was built, `handleDtmf` in the engine ignored a menu key that was not a form or `agent` (the caller heard nothing) | first left the outage map and hours off the menu; the engine now plays the line, so they are back as 4 and 5 (after the trial), with scripted calls for each | a scenario and some reading of turn.ts; closed |
| Nothing owed on the account | a bound refuses only when the write is tried, after the summary; `limit` cannot stop the form before its questions for a subject | the summary reads "$0.00 in three payments" and the gate then refuses with `plan_amount_outside` | a clumsy call for that one caller |
| A delegate's answers inside a form | corpus lines inside a form cannot carry `as`, so they are seeded with a customer | the `account` answers run as a customer in the corpus; the manager's path is covered by scripted calls with `as` | none |
| The framework's own test of policy.matrix folders | `packages/dialogwright/src/define/matrixCommand.test.ts` listed the workspace's matrix folders exactly, so a new app's `policy.matrix` failed it | left failing during the trial (the framework was out of bounds); the test now asserts it contains the framework's folders, as the card and map tests do | `pnpm -r test` was red until then; closed |

## The paragraph, by scripted call

Every requirement of the paragraph, and the scripted calls in `fixtures/scenarios/core.json` that hold it (the edges of each bound are also in `src/app.test.ts`).

| Requirement | Scripted calls |
|---|---|
| An outage report with no verification, the address and what they see confirmed before it is filed | `outage-anonymous`, `outage-up-front`, `outage-symptom-keypad`, `outage-change-address`, `outage-declined` (a no is not filed), `keypad-menu-outage` |
| The balance and due date, after the account number and date of birth | `balance-by-phone`, `balance-account-up-front`, `balance-keypad`, `balance-wrong-birth-date-three-times`; on the chat, `balance-chat-sign-in`, `balance-chat-typed-account` |
| A payment arrangement after a one-time code | `plan-by-phone`, `plan-values-up-front`, `plan-keypad`, `plan-after-balance`, `plan-change-date`, `plan-wrong-code-three-times`; on the chat, `plan-chat-sign-in` |
| The first payment within thirty days | `plan-thirty-days-on` (the last day allowed), `plan-first-date-too-late` (refused) |
| Not more than what is owed | `plan-nothing-owed` (refused by `limit`); the total is the balance, so a call cannot ask for more, and the edges (`240.00`, `240.01`) are unit tests |
| Property managers: balances for their buildings | `balance-by-a-manager`, `balance-by-a-manager-asked`, `balance-by-a-manager-keypad`, `balance-by-a-manager-not-theirs` (refused) |
| Property managers: outages for their buildings | `outage-by-a-manager` |
| Property managers: an arrangement goes to a person | `plan-by-a-manager` |
| The outage map and the office hours | `outage-map`, `office-hours`, `keypad-menu-outage-map`, `keypad-menu-office-hours-then-balance` |
| A person at any time | at the start: `asks-for-a-person`; on the keypad menu: `person-keypad-menu`; inside a form: `asks-for-a-person-in-outage`, `asks-for-a-person-in-plan`; while verifying: `person-while-verifying`; at the code prompt: `person-at-code-prompt`; at a summary: `person-at-outage-summary`, `person-at-plan-summary`; a manager on the chat: `manager-asks-for-a-person` |

## The policy card read back

`POLICY.md` (`pnpm policy:card apps/utility`) and `APP-MAP.md` (`pnpm app:diagram apps/utility`), read line by line against the paragraph (after the trial). No line of the policy needed a change; what the reading found:

| Sentence of the paragraph | What the card or the map says | Finding |
|---|---|---|
| Report an outage, no verification, confirm the address and what they see | `reportOutage`: level 0, anonymous; the caller confirms "account, address, what they see, installments, first payment and total" | Matches. The confirmed list names the arrangement's fields too, since the app has one list (Gaps); an outage sends them empty, so the caller confirms only the address and what they see. |
| Balance and due date, after the account number and date of birth | Level 1 "their account and date of birth", checked by `verifyCustomer`; `readBalance` at level 1, own account | Matches. The card first said "dob": the factor slots now have console labels (`Account number`, `Date of birth`), which the card uses. |
| An arrangement needs a one-time code sent to their phone | Level 2 "a 6-digit one-time code sent to the contact on file"; `set_up_plan` needs it before any action | Matches; `sendCode` texts the phone on the account (the card's wording is the framework's). |
| The first payment within 30 days | "on or after today and no later than 30 days from today" | Matches (`dateInRange`, `today+30`). |
| Not more than what they owe | "at least 0.01 and at most what `amountDue(accountId)` gives" | Matches. |
| Property managers check balances for their buildings | manager: "read the balance and due date" goes ahead; "the account must be the caller's own, or one they act for" | Matches. |
| ...and report outages for them | manager: "file an outage report" goes ahead | Matches. An outage report names an address, not an account, so there is no scope rule: a manager may report any address, as an anonymous caller may. |
| A tenant's arrangement goes to a person | manager: "set up a payment arrangement" goes to a person (role-person), rule 2, before scope | Matches. The role rule runs before scope, so the request goes to a person before the manager names an account (the form asks nothing first). |
| (not in the paragraph) | manager: "text a one-time code" refused | The choice under "Choices the paragraph left open". |
| The outage map and office hours | the app map: two informational intents, keys 4 and 5 | Matches; the card has no policy for them (they call no action). |
| A person at any time | the app map: `agent` and key 0 | Matches; covered by the scripted calls `asks-for-a-person*`, `person-*` and `manager-asks-for-a-person`. |
| | Defaults: "account by its last four" | Two slots are account numbers (the factor `accountId` and the manager's `account`), each with the noun `account`. The card first listed the redaction twice; it now says an identical entry once. |

The forms now declare `calls`, so the app map draws each form to its actions and their rules, and its "Dangling references" checks every action is reached.

## Baseline edits

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `pl-02` | `slots.place` | the old street name -> `200 Heron Row` | The invented street was renamed in the fixture data, the corpus line and two scripted calls; the read-back is the caller's words, so the baseline follows them. |
| corpus `ag-10` to `ag-13`; scenarios `person-keypad-menu`, `person-while-verifying`, `person-at-code-prompt`, `person-at-outage-summary`, `person-at-plan-summary`, `keypad-menu-outage-map`, `keypad-menu-office-hours-then-balance` | (new entries) | none -> the stub's outcome | Added after the trial: a person asked for at each place a caller can be (the keypad menu, while verifying, at the code prompt, at each summary) and the two answers' keys. Only these entries were added, each read in its transcript (`regress --scenario`, `--corpus`) before it went in: every person request is `handoff live-agent` at the caller's level then, the map's and the hours' keys play their line and give the menu back, and the hours key is followed by the balance on the keypad. No existing entry changed. |

Changes that needed no edit: the thirty-day bound moved from the custom rule `first-date-within-30-days` to `dateInRange` (`notAfter: today+30`). The rule that decides `plan-first-date-too-late` is now `dateInRange` (its line reads `firstDate after today+30 2026-10-18`), with the same verdict, reason (`date-range`) and line (`plan_date_outside`); the baseline records the outcome, not the deciding rule, so it did not change. `policy.matrix` was written again for it: the rule list of `setUpPlan` and the custom rules section changed, and no verdict did.

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [x] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [x] Every slot has at least five answers in the corpus, every summary at least four.
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); each bound is tested at its edges; every custom rule is a `defineRule` with examples the tests run (the app has none now: the thirty days are `dateInRange`'s `today+30`).
- [x] Scripted calls cover each form, each principal (anonymous, each level, each delegate role), the step-up, failed verification, each refusal, each handoff, keypad entry and each informational answer.
- [x] `identity.yaml` matches the paragraph: who must verify, with what, the code only where a level 2 action needs it, the tries.
- [x] The policy read back (`policy.matrix`, `POLICY.md` and `APP-MAP.md`) matches "Who may do what" above, cell by cell ("The policy card read back").
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`.
- [x] Nothing private or real: invented names and streets, 555 numbers, `example.com` addresses.
- [x] `pnpm check` ok; `pnpm -r typecheck` and `pnpm -r test` green; this app's, the clinic's and the testkit's regressions match their baselines (the framework test that failed during the trial is fixed; see Gaps).
- [x] The baseline was made once with `regress --update`, read entry by entry, and every later edit is under "Baseline edits".
- [x] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and how it is built, and keeps the scaffold's recording steps; `CLAUDE.md` still matches the folder.
- [x] The gaps above are written up.

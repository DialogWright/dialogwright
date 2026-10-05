# Example Power & Light: design worksheet

## The paragraph

> Build a phone and chat assistant for Example Power & Light, a small electric utility. Callers can report a power outage at their address (no verification needed, but they confirm the address and what they are seeing before we file it), hear their current balance and due date (they must verify with their account number and date of birth), and set up a payment arrangement that splits their balance into installments (this needs a one-time code sent to their phone; the first payment date must be within 30 days, and the arrangement can't exceed what they owe). Property managers who manage several accounts can check balances for their buildings and report outages for them, but a payment arrangement for a tenant's account must be handed to a person. Callers can also ask for the outage map website and office hours. Anyone can ask for a person at any time.

The knowledge base (Phase 6, added after the trial):

> Callers can also ask general questions (outage credits, ways to pay, budget billing, help with winter bills, disconnection and reconnection, starting or stopping service, rates, late charges, disputing a bill) and hear an answer approved by a person, drawn from Example Power & Light's own help pages and two PDF notices, word for word. A verified customer who asks about outage credits also hears the last outage on record for their own account. A question nothing approved answers, or an answer not in force that day, is said to be unavailable and a person is offered. The outage map and the office hours become approved answers too.

## Intents

| Intent id | Kind (form, informational, control) | What the caller wants | Example phrasings (five or more, terse ones included) |
|---|---|---|---|
| `report_outage` | form | report a power outage at an address | "I want to report a power outage", "my power is out", "outage", "no power", "the lights are out at 12 Birch Lane", "I think the power might be off on our street" |
| `check_balance` | form | hear the current balance and due date | "what do I owe", "balance", "how much is my bill", "when is my bill due", "what's the balance on account 5550 1234" |
| `set_up_plan` | form | split the balance into installments | "I'd like a payment arrangement", "payment plan", "can I pay in installments", "split it into three", "I can't pay it all at once" |
| `outage_map` | informational | the outage map website | "where is the outage map", "map", "is there a website with outages", "outage map", "can I see outages online" |
| `office_hours` | informational | office hours | "when are you open", "hours", "office hours", "what time does the office close", "are you open Saturday" |
| `ask_question` | form | a general question, answered from the knowledge base | "how do outage credits work", "what is budget billing", "is there a fee if I pay late", "I'm moving next month, how do I stop my service", "I want to dispute a charge", "I have a question" |
| `agent` | control | a person, at any time | "a person", "representative", "operator", "can I talk to someone", "agent" |
| `repeat_prompt` | control | hear that again | "say that again", "repeat", "what was that" |
| `done` | control | the caller is finished: the call ends with the goodbye (the answer to "anything else?") | "that's all", "I don't need anything else", "nothing else", "no thank you, I'm all set", "nope, that's it", "I'm good, thanks" |
| `other`, `none` | control | as the scaffold has them | |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Asked when | Keypad? | Sensitive? |
|---|---|---|---|---|---|---|
| `report_outage` | the street address | `place` | `text`: `what: the street address where the power problem is`, `say: null` (read back as said), `redact: none` | always | no | not masked: `say: null` needs `redact: none` |
| `report_outage` | what they are seeing | `symptom` | `choice`: `no_power`, `partial`, `flicker`, `wire_down` | always | yes | no |
| `check_balance` | which account | `account` | `digits`: length 8 | delegates only (a subject's is filled from the verified principal) | yes | last4 |
| `set_up_plan` | how many installments | `count` | `choice`: `two`, `three`, `four`, `six` | always | yes | no |
| `set_up_plan` | the first payment date | `firstDate` | `date`: `range: future` | always | yes | no |
| `ask_question` | which topic of the knowledge base | `subject` | `topic` (the defaults: only a nominated topic fills, two close ones are asked about) | when the words did not name one | no | no |
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
| `sendCode` | the account's phone | texts a code | `accountId` | 1 | `identity`, `scope(accountId)` (the engine refuses any party who is not the customer first) |
| `verifyCode` | the code | nothing | (the code) | 1 | `identity`, `attempts` |
| `answerQuestion` | the knowledge base (the passage in force today) | nothing | `topic` | 0 | `identity` |
| `getOutageHistory` | the account's last outage | nothing | `accountId` (the verified customer's own, '' for anyone else), `topic`; fields `lastOutageDay`, `lastOutageHours` | 1 | `identity`, `scope(accountId)` |

## Who may do what

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate `property_manager`, role `manager` |
|---|---|---|---|---|
| `reportOutage` | allowed | allowed | allowed | allowed |
| `readBalance` | after verifying to level 1 | allowed, own account only | allowed, own account only | allowed for the accounts they manage; refused (scope) for others |
| `setUpPlan` | after verifying to level 2 | after keying the code | allowed, own account, within bounds | a person (`handoff_role_person`) |
| `sendCode` | after verifying to level 1 | own account only | own account only | refused (`not-subject`, by the engine): a manager never texts a code to a tenant |
| `answerQuestion` | allowed | allowed | allowed | allowed |
| `getOutageHistory` | refused (a step-up the answer does not ask for: the line is left out) | own account only | own account only | refused (`scope`): the knowledge read names no account for anyone but a customer, so the line is left out |

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

Both are passages of the knowledge base (`passage:` in intents.yaml, said through `kb_answer`), approved like every other answer, with no retrieval and no gate. Before a person approved them they were drafts in `kb/pending`, and the app did not build (see "The knowledge base").

| Intent | The passage | Its source |
|---|---|---|
| `outage_map` | `outage-map`: "You can see current outages and estimated restoration times on our outage map, at example dot com slash outages. It's updated every 15 minutes." | the outage map page, "Where to find the map" |
| `office_hours` | `office-hours`: "Our customer office is open Monday through Friday, eight in the morning to five in the evening, and closed on weekends and holidays. You can report an outage any time, day or night." | the office hours page, "Customer office" |

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time (phone or chat, in or out of a form) | `live-agent` | `handoff_live_agent` |
| Verification fails 3 times, or the one-time code fails 3 times | `identity` | `handoff_identity` |
| A property manager asks for a payment arrangement | `role-person` | `handoff_role_person` |
| A gate decision that needs a person (no block line) | `needs-human` | `handoff_needs_human` |
| A question with no answer that may be said today: the caller says yes to the offer (`kb_unavailable`, then `offer_transfer`, once a call) | `frustrated` (the engine's reason for any accepted offer; see Gaps) | `handoff_frustrated` |

## Choices the paragraph left open

- Installment counts: two, three, four or six (a `choice`), since there is no money or free-count slot type. The installments split the whole balance; the total read back is the balance on the account.
- The arrangement total is the whole current balance (computed, not asked), and `limit` holds it to the amount due.
- What the caller is seeing: four options (no power at all, part of the home out, flickering or dim lights, a wire down).
- Outage reports need no account and no verification; a property manager files them the same way (allowed).
- Code length 6, three tries, the framework's defaults.
- Accounts are eight digits (`5550 1234`), read in two groups of four; every slot that can be keyed has `keypad: true`.
- The keypad menu offers the three forms (1, 2, 3), the outage map (4), the office hours (5) and a person (0). A key for an answer plays its line and offers the menu again. (The trial left 4 and 5 off while the engine ignored such a key; see Gaps.)
- A property manager is refused `sendCode`: a manager never steps up, so a code to a tenant's phone has no use and could alarm the tenant. Found reading the policy matrix. The engine now refuses every identity tool to any party who is not the customer (`not-subject`), so the app writes no rule for it.
- Over-answers: a caller may say the address and what they see in one breath, or the count and the first day; the forms skip what is filled.
- A property manager's balance check names the account (`account` slot); the scope rule limits them to the accounts they manage.
- The knowledge base answers every caller the same way (`kb/kb.yaml` has no `applies` domain): the answers are the utility's published policy, not anything of the caller's. The one thing of the caller's said is the outage credit's account line, read through its own gated action.
- The account line is for a verified customer only: `getOutageHistory` is level 1 with `scope(accountId)`, and the knowledge read sends the subject's id only for a customer (`kbCallParams`), so an anonymous caller (a step-up the answer does not ask for) and a property manager (scope) hear the answer without it. Asking an anonymous caller to verify just to hear the line was judged not worth the friction.
- Answers are at most 300 characters (`maxAnswerChars`), one or two short sentences, and spoken words for addresses ("example dot com slash outages").
- Every draft is in force from 2026-01-01, open-ended, except the Winter Warmth credit, in force from 2026-10-01 as its page says. The stub regression's day (2026-09-18) falls before that, so the approved knowledge base still shows the unavailable path in the regression (`question-not-in-force*`, `aq-05`), while `pnpm check` (today) has a passage in force for every topic. No passage has an end date, so `pnpm check` cannot start failing on a later day by itself.
- Two corpus lines labelled `other` before the knowledge base are questions it now answers: "I want to dispute a charge" (`bill_dispute`) and "I'd like to cancel my service" (`start_stop_service`). They moved to `aq-15` and `aq-16`, and two new `other` lines keep that intent at eight.
- Three more `other` lines are general questions as the real model reads them (the first recording): "I want to start new service at a new home" (`start_stop_service`, answered), "do you sell solar panels" and "is my gas bill separate" (no topic, so the topic is asked for, as "do you install solar panels" is). They moved to `aq-17` to `aq-19`. `other` has five lines until the cassette is next recorded: a new corpus line is a cassette miss until its words are recorded, so the three lines that bring it back to eight wait for that recording.
- What is recorded of each value a call carries is declared, not assumed. The account number is recorded by its last four and the date of birth hidden, as their slots say. The outage address is recorded as said (`redact: none` on `place`, and `place: keep` under `audit` in policy.yaml). The trade-off: the trace and the audit hold the address a caller spoke, so anyone who reads them learns where an outage was reported from, and a caller who volunteers more than an address (a name, a remark) has it kept too; the read-back needs the words as said, and the address is where the crew goes, so it was kept as it was. An app that holds addresses to be private would mask it (`length`, or `last4`) and read a confirmation back from the form's own state instead. The symptom, the count, the first date and the total are choices, a day and an amount, recorded as they are.

## Gaps

| What | The framework | What I did | Cost |
|---|---|---|---|
| An address | no address slot type | `text` with `say: null`; the read-back quotes the caller's words | none (pattern known) |
| First payment within 30 days | `dateInRange` had no "today plus N" bound when the app was built | first a custom rule (`first-date-within-30-days`); now `notAfter: today+30`, and the custom rule is gone (after the trial) | small; closed |
| One confirmed list per app | outage and plan share one list | union of fields, '' for the ones a write lacks | small |
| Delegates on the phone | delegates only on a signed-in chat | property managers use the chat | none |
| The address read back | `pnpm check` refuses `say: null` with the default `redact: length`; patterns.md does not mention it | `redact: none` on `place`: the address is in the trace and the audit as said | a few minutes |
| An address said with the request | a `text` slot keeps the whole turn | the read-back quotes the whole sentence ("the power is out at 22 Alder Street and nothing works"); the caller still confirms it | none; the `text` type's `pick` option now picks out "22 Alder Street" (code proposes the parts, the model chooses one, the value is copied as said). Not turned on here: it changes what the model is sent, so it waits for the maintainer to record the cassette again (README, "Picking the address out of the words") |
| Informational intents on the keypad menu | when the app was built, `handleDtmf` in the engine ignored a menu key that was not a form or `agent` (the caller heard nothing) | first left the outage map and hours off the menu; the engine now plays the line, so they are back as 4 and 5 (after the trial), with scripted calls for each | a scenario and some reading of turn.ts; closed |
| Nothing owed on the account | a bound refuses only when the write is tried, after the summary; `limit` cannot stop the form before its questions for a subject | the summary reads "$0.00 in three payments" and the gate then refuses with `plan_amount_outside` | a clumsy call for that one caller |
| A delegate's answers inside a form | corpus lines inside a form cannot carry `as`, so they are seeded with a customer | the `account` answers run as a customer in the corpus; the manager's path is covered by scripted calls with `as` | none |
| A form's `answers:` and an intent's `passage:` before approval | `defineApp` refuses an intent that names a passage not in `kb/passages`, and a draft in `kb/pending` is not one | the two intents name `office-hours` and `outage-map`, still drafts, so the app does not build until a person approves them: before approval `pnpm check` lists 14 problems (the two intents and the twelve topics), and the app's tests and regression cannot run | resolved 2026-10-04: a person approved all twelve, and check, the tests and the regression pass; no workaround in the app (a draft must never be said) |
| An accepted offer of a person after an unavailable answer | the engine records any accepted transfer offer as `frustrated` | left as it is: the caller hears `handoff_frustrated` ("Let me get you to someone who can help."), which reads fine, but the handoff's reason is not why the person was offered | a misleading reason in the trace and the console for these calls |
| The app map's intents table | it called an informational intent that says a passage "a line that does not exist: dangling" | fixed in the engine (`testing/appMap.ts`): the row says the passage | small; closed |
| A question the knowledge base does not cover | the topic question answers `none`, so the form asks its slot | the first ask is "What would you like to know?", which reads oddly right after the caller asked; the retry lists what it can answer | small; a `none` line of its own would help |
| The framework's own test of policy.matrix folders | `packages/dialogwright/src/define/matrixCommand.test.ts` listed the workspace's matrix folders exactly, so a new app's `policy.matrix` failed it | left failing during the trial (the framework was out of bounds); the test now asserts it contains the framework's folders, as the card and map tests do | `pnpm -r test` was red until then; closed |
| A topic named on the opener, then an informational answer (first recording) | on a turn with no form, the engine filled every slot the words answer, including the `ask_question` form's topic, and an informational answer left it filled | fixed in the engine: a turn that opens no form keeps only the call's slots (the identity factors and carried slots), so "where is the outage map", then "I have a question", asks what the caller wants to know (`src/fixtures.test.ts`, on the stub) | none now; closed |
| A day in an office-hours question (first recording, `oh-05`) | the same over-answer: "are you open on Saturday" filled `firstDate` with 2026-09-19 | a `knownGap` at first; the line is now labelled with the Saturday the model reads, the same engine fix drops it, and the `knownGap` is removed (`src/fixtures.test.ts` also starts an arrangement after it: no first date) | none now; closed |
| The balance form's `account` during a customer's step-up (first recording) | the form's slot, meant for a property manager, is asked beside the `accountId` factor in the same words, so a spoken number fills both | labelled as the model reads it; harmless to the gate (`accountIdOf` reads the verified customer's id). `onEntry` filled the slot from the verified customer only when it was empty, so the console could show the number said; it now sets it for a customer whatever it held (`src/app.test.ts`, "the balance form's account") | none now; closed |
| A slot filled again with the value it holds (first recording, `fd-04`) | `fillSlots` counted it as progress, so the prompted slot's retry ladder did not move (the window and summary cases already guarded against this) | a `knownGap` at first; fixed in the engine (a fill that leaves the value as it was is not progress), and the `knownGap` removed: "whenever works" at the first-date prompt now takes the retry, as labelled | none now; closed |
| A caller who is done at "anything else?" (a live call) | the scaffold declared no `done`, so neither did this app (the row above once said "as the scaffold has them"), and nothing checked it | after an outage report the caller said "that's all", then "I don't need anything else", and heard the no-match line each time, then the keypad menu. `done` is added, with eight corpus lines and `outage-then-done`; `pnpm check` now refuses an app that asks "anything else?" without it, and the scaffold declares it | two wasted turns and a menu for a caller who was finished; closed |
| An informational intent the model is unsure of (first recording, `om-07`) | an informational answer needed 0.6 and had no confirm band below it, as a form has | the engine now gives it the form's band (0.4 to 0.6: "Just to check, do you want to hear where the outage map is?", said on a yes); the `knownGap` pins that confirmation instead of `nomatch_open` | one yes before the answer; the criteria naming restoration times would answer it outright (a re-recording) |

## The paragraph, by scripted call

Every requirement of the paragraph, and the scripted calls in `fixtures/scenarios/core.json` that hold it (the edges of each bound are also in `src/app.test.ts`).

| Requirement | Scripted calls |
|---|---|
| An outage report with no verification, the address and what they see confirmed before it is filed | `outage-anonymous`, `outage-up-front`, `outage-symptom-keypad`, `outage-change-address`, `outage-declined` (a no is not filed), `keypad-menu-outage` |
| A caller who is finished hears the goodbye | `outage-then-done` ("that's all" after an outage report); corpus `dn-01` to `dn-08` |
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
| (not in the paragraph) | manager: "text a one-time code" refused (by the engine) | The choice under "Choices the paragraph left open". |
| The outage map and office hours | the app map: two informational intents, keys 4 and 5 | Matches; the card has no policy for them (they call no action). |
| A person at any time | the app map: `agent` and key 0 | Matches; covered by the scripted calls `asks-for-a-person*`, `person-*` and `manager-asks-for-a-person`. |
| | Defaults: "account by its last four" | Two slots are account numbers (the factor `accountId` and the manager's `account`), each with the noun `account`. The card first listed the redaction twice; it now says an identical entry once. |

The forms now declare `calls`, so the app map draws each form to its actions and their rules, and its "Dangling references" checks every action is reached.

## The knowledge base

Built with the authoring pipeline, as an author would: documents in, drafts out, a person approves.

### Sources (`docs-src/`, read into `kb/sources` by `pnpm kb:ingest`)

Fictional documents written for this app; every name, number and policy is invented.

| Document | File | Sections | What it says |
|---|---|---|---|
| Outage credits | `docs-src/website/outage-credits.html` | 5 | 25 dollars after 24 hours out in a row, 10 more per further 12 hours up to 75, exclusions, who to call |
| Outage map | `docs-src/website/outage-map.html` | 3 | the map at www.example.com/outages, updated every 15 minutes; estimates; reporting what is not on it |
| Payment options and plans | `docs-src/website/payment-options.html` | 3 | ways to pay with no fee, automatic payments, payment arrangements |
| Budget billing | `docs-src/website/budget-billing.html` | 3 | equal monthly payments reviewed every six months, who can enroll, the yearly settling up |
| Seasonal assistance programs | `docs-src/website/assistance-programs.html` | 4 | the Winter Warmth credit (up to 300 dollars, effective October 1, 2026), Summer Cooling help, how to apply |
| Disconnection and reconnection | `docs-src/website/disconnection-and-reconnection.html` | 3 | 10 days' written notice and a call 2 days before, when there is no disconnection, reconnection within 24 hours and its 30 dollar fee |
| Start, stop or move service | `docs-src/website/start-stop-service.html` | 3 | 3 business days' notice, the final bill within 10 days, deposits, moving within the area |
| Office hours and contact | `docs-src/website/office-hours.html` | 3 | the customer office (Monday to Friday, 8 to 5), Customer Service by phone, mail |
| Residential Rate Schedule R-1 | `docs-src/documents/rate-schedule.pdf` (2 pages) | 7 | 12 dollars a month plus 14.2 cents a kilowatt-hour, summer use, the 1.5 percent late payment charge, minimum bill, taxes |
| Your Rights as a Residential Customer | `docs-src/documents/customer-rights-notice.pdf` (2 pages) | 5 | disputing a bill within 30 days, medical certificates, appeals, privacy |

The PDFs were made with pdf-lib by a script outside the repository (not a dependency); `kb:ingest` reads their headings from the larger type and records each section's page. Sections no passage cites (exclusions, deposits, medical certificates, and so on) stay in the sources: `pnpm kb:refresh` lists them, and they are what `kb:draft --source` would draft from next.

### Topics and drafts

Twelve topics (`kb/topics.yaml`), each with one draft in `kb/pending`, written by hand in the format `kb:draft` writes and handed through its pipeline (`draftKb` with a drafter that calls no model, so every draft passed `draftProblems`: the excerpt in its section word for word, the answer within 300 characters with no braces, a known topic, no repeated answer). `drafted.by` says so: `assistant (drafted by hand in the drafter's format, no model call)`.

| Topic | Title | Draft | Source section | In force from |
|---|---|---|---|---|
| `outage_credit` | Outage credits (account line) | `outage-credit` | outage-credits, `who-receives-a-credit` | 2026-01-01 |
| `outage_map` | The outage map | `outage-map` | outage-map, `where-to-find-the-map` | 2026-01-01 |
| `office_hours` | Office hours | `office-hours` | office-hours, `customer-office` | 2026-01-01 |
| `payment_options` | Ways to pay a bill | `payment-options` | payment-options, `ways-to-pay` | 2026-01-01 |
| `budget_billing` | Budget billing | `budget-billing` | budget-billing, `how-budget-billing-works` | 2026-01-01 |
| `seasonal_assistance` | Help paying winter heating bills | `seasonal-assistance` | assistance-programs, `winter-warmth-credit` | 2026-10-01 |
| `disconnection` | Notice before a disconnection | `disconnection` | disconnection-and-reconnection, `before-a-disconnection` | 2026-01-01 |
| `reconnection` | Getting service reconnected | `reconnection` | disconnection-and-reconnection, `reconnecting-service` | 2026-01-01 |
| `start_stop_service` | Starting or stopping service | `start-stop-service` | start-stop-service, `starting-or-stopping-service` | 2026-01-01 |
| `residential_rates` | Residential electricity rates | `residential-rates` | rate-schedule, `monthly-rate` (page 1) | 2026-01-01 |
| `late_fees` | Late payment charges | `late-fees` | rate-schedule, `late-payment-charge` (page 2) | 2026-01-01 |
| `bill_dispute` | Disputing a bill | `bill-dispute` | customer-rights-notice, `disputing-a-bill` (page 1) | 2026-01-01 |

**All twelve are passages now**, approved by a person in `kb:review` on 2026-10-04 (README.md, "Reviewing the knowledge base"). Only a person approves a passage (`kb:approve` refuses any other `--by`), so the branch that added them ended with the drafts waiting for review. The stub baseline is the approved state: it was checked against a scratch copy of the repository with every draft approved by a fictional reviewer (never committed), where check, the tests and the regression all pass.

### The account line

`outage_credit` says, after its answer, "The last outage on record for your account was on {lastOutageDay}, and it lasted {lastOutageHours} hours.", read through `getOutageHistory` (level 1, `scope(accountId)`, its two fields declared). The approval hash covers this line, so changing it after approval withholds the passage until it is approved again.

### Retrieval

Hybrid (keywords and potion-base-8M), cap 8, the model's floor (0.3), from `pnpm kb:bakeoff apps/utility --paraphrases apps/utility/fixtures/kb/paraphrases.yaml --sweep` on 74 paraphrases of the 12 topics (none of them a title, keyword or example question) and 8 lines about nothing:

| Retriever | Recall at 8 | Top 1 | Topics offered | On a line about nothing |
|---|---|---|---|---|
| keyword | 83.8% | 48.6% | 3.81 | 0.50 |
| dense (potion-base-8M, floor 0.3) | 95.9% | 62.2% | 6.08 | 1.50 |
| hybrid (the default) | 97.3% | 59.5% | 6.31 | 1.50 |

The sweep: a floor of 0.35 cuts the topics offered on a line about nothing to 0.63 but recall to 95%, right at the target, so the default floor stays. `src/kb.test.ts` holds recall at 95% or more (and every topic at 80% or more). Every corpus line labelled with a topic is nominated by the keyword retriever too, so the stub regression gives the same outcomes on a machine without the model.

### Requirements, by scripted call

| Requirement | Scripted calls (and corpus lines) |
|---|---|
| A general question answered word for word from an approved passage | `question-outage-credit`, `question-late-charge` (from the rate schedule PDF), `question-rights-notice` (from the rights notice PDF); corpus `aq-01` to `aq-16` |
| The question asked for first, then the topic | `question-asked-for`; corpus `aq-12`, `sq-01` to `sq-05` |
| A verified customer hears their last outage after the outage credit answer | `question-outage-credit-verified` (by phone, after verifying), `question-outage-credit-chat` (signed in); corpus `sq-01` |
| Anyone else hears the answer without it | anonymous: `question-outage-credit` (`getOutageHistory:STEP_UP`, the line left out); a property manager: `question-by-a-manager` (`getOutageHistory:BLOCK`); corpus `aq-14` |
| No answer in force: the unavailable line and a person offered, once | `question-not-in-force` (the Winter Warmth passage is not in force on the regression's day), `question-not-in-force-declined`, `question-not-in-force-accepted`; corpus `aq-05`, `ft-01`, `ft-02` |
| A question the knowledge base does not cover | `question-none` (the topic question answers none, twice: the retry lists what it can answer); corpus `aq-13`, `sq-04` |
| The outage map and the office hours, now passages | `outage-map`, `office-hours`, `keypad-menu-outage-map`, `keypad-menu-office-hours-then-balance` (keys 4 and 5 unchanged) |

## Baseline edits

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `pl-02` | `slots.place` | the old street name -> `200 Heron Row` | The invented street was renamed in the fixture data, the corpus line and two scripted calls; the read-back is the caller's words, so the baseline follows them. |
| corpus `ag-10` to `ag-13`; scenarios `person-keypad-menu`, `person-while-verifying`, `person-at-code-prompt`, `person-at-outage-summary`, `person-at-plan-summary`, `keypad-menu-outage-map`, `keypad-menu-office-hours-then-balance` | (new entries) | none -> the stub's outcome | Added after the trial: a person asked for at each place a caller can be (the keypad menu, while verifying, at the code prompt, at each summary) and the two answers' keys. Only these entries were added, each read in its transcript (`regress --scenario`, `--corpus`) before it went in: every person request is `handoff live-agent` at the caller's level then, the map's and the hours' keys play their line and give the menu back, and the hours key is followed by the balance on the keypad. No existing entry changed. |

| every corpus line and scripted call | `slots` | the slot map without `subject` -> with `"subject": null` after `firstDate` | The knowledge form's topic slot is a slot of the app, and the outcome lists every slot. No entry's other fields changed with it. |
| corpus `om-01` to `om-08`, `oh-01` to `oh-08`; scenarios `outage-map`, `office-hours`, `keypad-menu-outage-map`, `keypad-menu-office-hours-then-balance` | `acks` | `outage_map` / `office_hours` -> `kb_answer` | The two answers are passages now, said through `kb_answer`. The words are the drafts' (the scripted calls' `text` expectations still hold: "example dot com slash outages", "Monday through Friday"). |
| corpus `ot-04`, `ot-07` | (removed) | the stub's `other` outcome -> none | Relabelled as questions the knowledge base answers and renamed `aq-15`, `aq-16` (see "Choices"). |
| corpus `aq-01` to `aq-16`, `sq-01` to `sq-05`, `ft-01`, `ft-02`, `ot-09`, `ot-10`; scenarios `question-outage-credit`, `question-outage-credit-verified`, `question-outage-credit-chat`, `question-by-a-manager`, `question-asked-for`, `question-late-charge`, `question-rights-notice`, `question-not-in-force`, `question-not-in-force-declined`, `question-not-in-force-accepted`, `question-none` | (new entries) | none -> the stub's outcome in the approved state | Each read in its transcript (`regress --scenario`, `--corpus`) in a scratch copy with every draft approved by a fictional reviewer, then copied in by hand. The answers are said (`kb_answer`), except: `aq-05` and the `question-not-in-force*` calls (the Winter Warmth passage is not in force on 2026-09-18: `kb_unavailable`, then `offer_transfer`); `aq-12`, `aq-13` (`ask_subject`) and `sq-04`, `question-none` (`ask_subject_retry`); `ft-01` (a declined offer goes back to `ask_subject`) and `ft-02`, `question-not-in-force-accepted` (a person, reason `frustrated`: see Gaps). The `gate` field is the last gate event: `getOutageHistory:STEP_UP` for an anonymous caller, `:ALLOW` for a verified customer, `:BLOCK` for a property manager. |
| corpus `ro-01`, `ro-03`, `ro-04`; scenario `asks-for-a-person-in-outage` | `slots.symptom` | `null` -> `"no_power"` | The first recording (`jev-1.13.0`): "I want to report a power outage", "no power" and "my power is out" say what the caller sees, and the model fills `symptom` with `no_power`. The lines now carry the label (`labels.symptom`); the scripted call starts with the first of them. |
| corpus `co-05` | `promptId`, `slots.symptom` | `ask_symptom`, `null` -> `confirm_report_outage`, `"flicker"` | First recording: "not quite, it's flickering rather than out" at the outage summary names the new value, so the model fills it and the summary is read again rather than the symptom asked for. Labelled `symptom: flicker`. |
| corpus `cb-05`, `id-01`, `id-02`, `id-03`; scenario `balance-wrong-birth-date-three-times` | `slots.account` | `null` -> the account number said | First recording: a spoken account number answers the balance form's `account` question as well as the `accountId` factor (both are eight-digit `account` slots, asked in the same words). Labelled `accountGiven`/`accountSpan`/`accountComplete` as well. For a customer the slot is not read (`accountIdOf` reads the verified principal); see Gaps. |
| corpus `ch-01`; scenario `balance-chat-typed-account` | corpus: `promptId`, `acks`, `verdict`, `form`, `slots`, `gate`; scenario: `slots.account` | corpus: `ask_dob`, route to `check_balance` -> `nomatch_open`, `intent_failed`, no slots; scenario: `null` -> `"55501234"` | First recording: "my account number is 55501234" on its own asks for nothing (the model reads `none` 0.98), so the line is relabelled `intent: none`. In the chat call it is said inside the balance form, where it fills `account` (a typed number is never a factor); labelled with the `account` answers too. |
| corpus `sp-06` | `promptId`, `acks`, `form`, `gate` | `confirm_intent_explicit` -> `ask_accountId`, `ack_intent`, `set_up_plan`, `findAccount:STEP_UP` | First recording: "I can't pay it all at once" has none of the hedging words the engine's `intentTentative` question asks about (maybe, I guess, I think), and the model reads it plainly (0.03). The `tentative` label was dropped: the request is routed and acknowledged. |
| corpus `om-01` to `om-05`, `oh-01` to `oh-07`; scenarios `outage-map`, `office-hours` | `slots.subject` | `null` -> `"outage_map"` / `"office_hours"` | First recording: the words name the knowledge base's topic, which retrieval nominates on the opener, so the model fills the topic slot as the answer is said. Labelled `subjectTopic`. The slot stays filled after the answer; see Gaps. |
| corpus `ot-01`, `ot-02`, `ot-06` | (removed) | the stub's `other` outcome -> none | First recording: relabelled `ask_question`, as the model reads them, and renamed `aq-17` to `aq-19` (see "Choices"). |
| corpus `aq-17`, `aq-18`, `aq-19` | (new entries) | none -> the stub's outcome | "I want to start new service at a new home" (`start_stop_service`: answered, `anything_else`), "do you sell solar panels" and "is my gas bill separate" (no topic: `ask_subject`, as `aq-13`). Each read in its transcript (`regress --corpus`); the stub's outcome and the replay's are the same. |
| corpus `ns-03` | `decidedGate`, `verdict` | `intent`, `intent_failed` -> `intelligible`, `nomatch` | First recording: "um" is the filler sound the `intelligible` question names, so the turn is a no-match before the intent is read (the same `nomatch_open`). Labelled `intelligible` 0.3 and tagged `unintelligible`, as the clinic's "um" is. |
| corpus `ns-06` | `decision`, `promptId`, `decidedGate`, `verdict` | `prompt nomatch_open`, `intent`, `intent_failed` -> `ignore`, `null`, `addressedToSystem`, `ignore` | First recording: "hang on a second" may be said to the line or to someone in the room; the model reads it at 0.5, below the 0.65 gate, and the line waits for the caller instead of saying the no-match prompt over them. That is the better answer to "hang on", so the line is labelled `addressedToSystem` 0.5 (tagged `hold`). |
| corpus `om-01` to `om-05`, `oh-01` to `oh-07`; scenarios `outage-map`, `office-hours` | `slots.subject` | `"outage_map"` / `"office_hours"` -> `null` | The engine fix for the topic kept after an informational answer (see Gaps): a turn that opens no form keeps only the call's slots, so the topic the words name is no longer left filled after the answer. The answer said, the prompt and every other field are unchanged. The recorded replay shows the same. |
| corpus `oh-05` | (label) | `labels` gain `firstDateMode: weekday`, `firstDateWeekday: saturday` | Not a baseline edit: the first recording reads the Saturday as a first payment day (1.0), so the stub now hears it too and the line shows that the engine drops it (its `firstDate` stays `null` in the baseline). The `knownGap` that pinned the stray date is removed. |
| corpus `dn-01` to `dn-08`; scenario `outage-then-done` | (new entries) | none -> the stub's outcome | The `done` intent. Seven lines at "anything else?" (context `anything_else`, seeded by `testing.seed.anythingElse` as after an outage report, with the seed's level 2 customer) and one at the opening question, among them the live call's "that's all" and "I don't need anything else"; the scripted call files an outage report, then says "that's all". Each is `complete goodbye` through the intent gate (`route`); the scripted call's last gate event is `reportOutage:ALLOW`. Each read in its transcript (`regress --corpus`, `--scenario`). No existing entry changed. |

Before approval the app did not build, so these entries could not be checked until a person approved the drafts; after approval (2026-10-04) the regression says `no changes`, as it did in the scratch copy.

Changes that needed no edit: the thirty-day bound moved from the custom rule `first-date-within-30-days` to `dateInRange` (`notAfter: today+30`). The rule that decides `plan-first-date-too-late` is now `dateInRange` (its line reads `firstDate after today+30 2026-10-18`), with the same verdict, reason (`date-range`) and line (`plan_date_outside`); the baseline records the outcome, not the deciding rule, so it did not change. `policy.matrix` was written again for it: the rule list of `setUpPlan` and the custom rules section changed, and no verdict did.

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [ ] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call. `other` has five since the first recording moved three lines to `ask_question` ("Choices"); three new lines wait for the next recording.
- [x] Every slot has at least five answers in the corpus, every summary at least four.
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); each bound is tested at its edges; every custom rule is a `defineRule` with examples the tests run (the app has none now: the thirty days are `dateInRange`'s `today+30`).
- [x] Scripted calls cover each form, each principal (anonymous, each level, each delegate role), the step-up, failed verification, each refusal, each handoff, keypad entry and each informational answer.
- [x] `identity.yaml` matches the paragraph: who must verify, with what, the code only where a level 2 action needs it, the tries.
- [x] The policy read back (`policy.matrix`, `POLICY.md` and `APP-MAP.md`) matches "Who may do what" above, cell by cell ("The policy card read back").
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`.
- [x] Nothing private or real: invented names and streets, 555 numbers, `example.com` addresses.
- [x] `pnpm check` ok; `pnpm -r typecheck` and `pnpm -r test` green; this app's, the clinic's and the testkit's regressions match their baselines (the framework test that failed during the trial is fixed; see Gaps).
- [x] The baseline was made once with `regress --update`, read entry by entry, and every later edit is under "Baseline edits".
- [x] `.github/workflows/ci.yml` runs this app's regression and replays its cassette (`--client recorded`: no misses, every difference a known gap); `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and how it is built, and keeps the scaffold's recording steps; `CLAUDE.md` still matches the folder.
- [x] The gaps above are written up.
- [x] The knowledge base's drafts are approved by a person in `pnpm kb:review apps/utility` (README.md, "Reviewing the knowledge base"); then `pnpm check`, this app's tests and its regression pass.

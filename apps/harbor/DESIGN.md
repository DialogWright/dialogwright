# Harbor Mutual: design worksheet

## The paragraph

> Harbor Mutual sells accident insurance: two plans, Accident Advantage and Accident Advantage Plus, each described in a certificate of coverage for its plan year. Members call the member line, or chat on the website after signing in to the member portal, to do three things: check on a claim they already filed, ask what their plan covers, and report a new claim. Callers verify with their eight-digit member ID and their date of birth; checking a claim or reporting a new one also needs a six-digit code we text to the phone on file, which we only ever refer to by its last four digits, and a code said out loud is never accepted (we send a new one and ask them to key it in). Claim numbers are four digits; a member with one claim does not have to pick it. Coverage questions are answered from the member's own plan certificate, word for word, never made up, and for some benefits we add how many of them the member has used this year. To report a claim we need the kind of loss (an accident injury, a hospital stay, or a covered diagnosis), the date it happened, and a short description in their own words; we read the claim back and file it only after they say yes, and the loss date can't be in the future or outside their coverage. Once a claim is filed, our claims intake service triages it and tells us which documents we need; we tell the member, and text them a link to upload them, but we never repeat anything that service says except the documents we have approved wording for. Insurance brokers also use the chat, signed in through the broker portal, for the members their office is agent of record for: a broker never sees a claim's diagnosis or the member's statement, a service rep may not file a claim, and an office administrator's filing goes to a claims specialist. Anyone can ask for a person at any time; after three failed verification attempts we transfer to a person; and a member who sounds frustrated about a claim is offered one. Callers can use the keypad: 1 for a claim's status, 2 for coverage, 3 to report a claim, 0 for a person.

The business name, Harbor Mutual, was given with the paragraph. The app is a rebuild, in the current formats, of an earlier Harbor written in code against an early version of the framework: its intents, slots, policy, spoken lines, fixture data, corpus phrasings, scripted calls and knowledge base are the content taken here. On the way, its first member is Jordan Ellis, born 1984-08-21, and every phone number is a whole 555 number (+1 555 555 01xx).

## Intents

| Intent id | Kind | What the caller wants | Example phrasings |
|---|---|---|---|
| `claim_status` | form | the status of a claim already filed | "what's the status of my claim", "has my claim been paid yet", "claim status", "claim", "can you check on claim 4702", "i'm calling about the claim for my er visit" |
| `coverage` | form (knowledge) | what their plan covers, from their own plan's certificate; a broker, what a client's plan covers | "is physical therapy covered", "does my plan pay for an ambulance", "coverage", "benefits question", "i broke my arm skiing, does that pay anything", "how long do i have to file a claim" |
| `report_claim` | form | report a new accident injury, hospital stay or diagnosis | "i need to file a claim", "new claim", "file a claim", "i broke my wrist yesterday and need to file a claim", "i slipped on the ice last saturday and hurt my back" |
| `capabilities` | informational | what the line is and can do (asking whether it is a person is this, not a request for one: the maintainer's decision, 2026-10-16) | "what can you do", "are you a robot", "am i talking to a real person", "what are my options", "help", "how does this work" |
| `agent` | control | a person, at any time | "a person", "representative", "operator", "agent", "can i speak to someone", "let me speak to a specialist" |
| `repeat_prompt` | control | the last line again | "can you repeat that", "say that again", "come again", "repeat", "what did you say" |
| `done` | control | nothing more | "no, that's all", "no thanks", "i'm all set", "nothing else", "goodbye" |
| `other`, `none` | control | the scaffold's: a request the line does not handle; no request | "can i change my address", "do you sell car insurance"; "hello", "okay" |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Keypad? | Sensitive? |
|---|---|---|---|---|---|
| (identity, level 1) | member ID | `memberId` | `digits`: noun member ID, length 8, group 4+4 | yes | `last4` (the default) |
| (identity, level 1) | date of birth | `dob` | `birthdate`: `notThisDate` the date of an accident or claim | yes (MMDDYYYY) | `mask` (the year only) |
| (identity, level 2) | the one-time code | none: identity.yaml's `otp`, 6 digits | keyed only | yes | never recorded |
| `claim_status` | which claim | `claimSelect` | `record`: from the facts' `claims` (listClaims), key `number`, `\d{4}`, labelPrefix `claim_`, a spoken four-digit number offered too; one claim filled by `onEntry` | yes (4 keys) | no (a claim number) |
| `coverage` (brokers only) | which client | `clientId` | `digits`: noun member ID, length 8, group 4+4, `askedOf: [broker]` | no (chat only) | `last4` (the default) |
| `coverage` | the coverage question | `coverageTopic` | `topic`: kb.yaml's cap (8) | no | no |
| `report_claim` | the kind of loss | `lossType` | `choice`: accident_injury, hospital_stay, diagnosis, in keypad order | yes (1, 2, 3) | no |
| `report_claim` | when it happened | `lossDate` | `date`: range past (a day to come never resolves), context and exclude sentences | yes (MMDD) | no |
| `report_claim` | what happened, in their words | `lossDescription` | `text`: say "your description", maxLength 500, `commands: { listen: [agent] }` | no | `length` (the default) |

## Decisions

| # | Question | Answer, and the option it leads to |
|---|---|---|
| 1 | Does any answer rule the caller out before the rest is collected? | No. The loss date's bounds are held at the write, after the read-back (row 2, and Bounds). |
| 2 | Does an answer end the call or turn the caller away? | A loss date outside the member's coverage sends the call to a specialist at the write. The summary reads the date back first, so it is heard before it acts; no separate read-back (`confirm`) was added. |
| 3 | Several roads to one booking? | No. |
| 4 | Details for a later step in the first sentence? | Yes: "I broke my wrist yesterday and need to file a claim" gives the kind of loss, the day and the description. They are in the same form as the request, so the defaults keep them (`listen: up-front`). A claim named up front is kept when it is a number; named by what it was for, it cannot be matched before the claims are listed (Gaps). |
| 5 | Who must prove who they are, and for what? | Checking a claim and reporting one: level 2 (the member ID and date of birth, then the code), asked before the form's questions: listClaims is level 2, and report_claim has a purpose at level 2 (its entry, getCoverage, is level 1). Coverage: level 1, as the answer is the member's own plan's: the form's entry call (getCoverage) verifies the caller before the topic is answered. The factors are the paragraph's. |
| 5b | Does the caller act on something of theirs? | Yes, their claims: a `record` slot over the list listClaims returns (`facts.forSlots`, source `claims`), `scope: { record: claim }` with `ownerOf` from the claims system. One claim: filled in `onEntry`. |
| 6 | Will callers phone from the number on their account? | Not used: the paragraph says callers verify with the member ID and date of birth. No `callerId`. |
| 7 | Look the caller up by number? | No. |
| 8 | A callback number? | No. |
| 9 | Will the line text the caller? | Yes, twice, and always to the phone on file, never to a number from the call: the one-time code (identity's `sendCode`) and the upload link (`sendUploadLink`, to the claim's member). So no `callerNumber` offer and no `callerNumber` rule: the number is the member's record. |
| 10 | Text at more than one moment? | No consent question: the paragraph says nothing of one, and both texts go to the number on file. |
| 10b | Data the call comes with? | No. |
| 11 | Something that must never wait? | No emergency. `lossDescription` is a `text` slot without `pick`, so by default its turn is the description, whole; the paragraph says anyone can ask for a person at any time, so `commands: { listen: [agent] }` (scripted: agent-while-dictating). |
| 12 | What should the person taking a transfer see? | `handoff.data.unconfirmed: mark`, and the member ID by its last four (`send: { memberId: masked }`) so the specialist can find the member; the other factors are left out (the default). |
| 13 | Half-understood caller, corrections, silence after "anything else?" | The defaults. |
| 13b | Nice-to-have details? | None: the engine's ladder (three tries, then a person). |
| 13c | Routes? | None: no hours, notices or groups in the paragraph. |
| 13d | More than one language? | No: en-US only. |
| 14 | The phone line itself? | No. |
| (not in the worksheet) | A member who sounds frustrated about a claim is offered a person | The engine's frustration ladder (`ack_frustration`, `offer_transfer`, `handoff_frustrated`), limited to the claim forms by app.yaml's `frustration: { forms: [claim_status, report_claim] }` (since 2026-10-16): in them, in a coverage question set aside from one, and at the opening question when the words ask about a claim; a frustrated coverage question alone is not answered for its tone (fr-04). Scripted: frustration-offered-a-person, frustration-offer-accepted, frustration-offer-declined. |
| (not in the worksheet) | The claims intake service | A tool, `triageClaim`, whose reply is held by `check` (replyShape) to the approved document codes, a yes or no for fast-track and a whole number of days from 1 to 30, called `failSoft` from the report's completion: a reply that fails, or no reply, is "an adjuster will be in touch". Its `fields` rule says exactly what it is sent. The lines say only the approved document lines (`doc_<code>`), the days and the fast-track line. See the skill trial notes for why not a `ServiceDef`. |

## Actions

| Tool | Reads | Writes | Params | Level | Rules, in order |
|---|---|---|---|---|---|
| `verifyMember` | members | nothing | `memberId, dob` | 0 | `attempts` |
| `sendCode` | the member's phone on file | a text | `memberId` | 1 | `identity`, `scope(memberId)` |
| `verifyCode` | the code (the engine's verifier) | nothing | none | 1 | `identity`, `attempts` |
| `getCoverage` | the member's plan and coverage dates | nothing | `memberId` | 1 | `identity`, `scope(memberId)` |
| `searchPolicy` | the knowledge base, for the member's plan (`kbAnswerTool`) | nothing | `memberId, topic` | 1 | `identity`, `scope(memberId)` |
| `isClient` | nothing (a form's check: the gate answers, no tool runs) | nothing | `clientId` | 0 | `identity`, `scope(clientId)` |
| `getUsage` | the member's use of a benefit this year | nothing | `memberId, topic` | 1 | `identity`, `scope(memberId)` |
| `listClaims` | the member's claims | nothing | `memberId` | 2 | `identity`, `scope(memberId)` |
| `getClaim` | one claim | nothing | `claim` | 2 | `identity`, `scope(record claim)` |
| `createClaim` | coverage dates (the gate's lookup) | a new claim (idempotent) | `memberId, lossType, lossDate, lossDescription` | 2 | `identity`, `role`, `scope(memberId)`, `confirmed`, `dateInRange(lossDate)` |
| `triageClaim` | the claims intake service | nothing | `claim, lossType, lossDate, lossDescription` | 2 | `identity`, `scope(record claim)`, `fields` |
| `sendUploadLink` | the claim's member's phone on file | a text (idempotent) | `claim` | 2 | `identity`, `scope(record claim)` |

Every tool whose reply a line says, or a call is made from, has a `check`: the verified principal's id (8 digits), the phone's last four, the plan and coverage dates, the usage count, every claim field a line says (number as 4 digits, the service from the services list, dates, status from the statuses, amount, days, the missing document as a document code), and the triage. The one free-text field a line says is the member's first name and last initial on a broker's status line (`text`, said in its own place), and the verified member's first name (the engine's own check); the adversarial suite lists the latter as "said in its place".

## What is recorded

| Param | Slot, with its redact setting (or "not a slot") | Recorded as | Why |
|---|---|---|---|
| `memberId` | `memberId`: `last4` | the slot's | an identifier |
| `dob` | `dob`: `mask` | the slot's | an identity factor |
| `lossDescription` | `lossDescription`: `length` | the slot's | the member's own words: never kept as said |
| `claim` | not a slot (the claim number the slot or the write gave) | `keep` | a four-digit claim number, no secret; the specialist reads it back |
| `topic` | not a slot (the topic id) | `keep` | which topic was answered |
| `clientId` | `clientId`: `last4` | the slot's | a member ID a broker names |
| `lossType` | `lossType`: a choice, no redact | `keep` | one of three |
| `lossDate` | `lossDate`: a date, no redact | `keep` | a day |

The policy card's "What is recorded" table says the same (read at step 7).

## Who may do what

| Action | Anonymous | Member, level 1 | Member, level 2 | Broker `service_rep` | Broker `office_admin` |
|---|---|---|---|---|---|
| `getCoverage`, `searchPolicy`, `getUsage` | after verifying to level 1 | allowed, own | allowed, own | `searchPolicy` for their office's clients only: the form asks which client (`clientId`), and the answer is that member's plan's; `getUsage` allowed with `used` withheld (no usage line); `getCoverage` never called for a broker (no entry call) | the same |
| `isClient` | refused (no scope) | own member ID only (never asked: a member has no client slot) | the same | their office's clients only (`coverage_not_client` otherwise) | the same |
| `listClaims` | after verifying to level 2 | after the code | allowed, own | their office's clients | their office's clients |
| `getClaim` | after verifying to level 2 | after the code | allowed, own claims | their office's clients' claims, diagnosis and statement withheld | the same |
| `createClaim` | after verifying to level 2 | after the code | allowed: read back and confirmed; a loss after today refused; outside the coverage dates a person | refused (`claim_blocked_role`) | a person, a claims specialist (`broker-filing`) |
| `triageClaim`, `sendUploadLink` | after verifying to level 2 | after the code | allowed, own claim | allowed for a client's claim (never reached: a broker files nothing) | the same |
| `verifyMember`, `sendCode`, `verifyCode` | allowed (`sendCode`, `verifyCode` after level 1) | allowed | allowed | refused (`not-subject`, the engine's) | refused |

## Verification (identity.yaml)

- Subject kind: `member`.
- Level 1: factors `memberId, dob`, checked by `verifyMember`.
- Level 2: a one-time code of 6 digits, sent by `sendCode` to the phone on file (the line says its last four, `{phoneLast4}`), checked by `verifyCode`. A code said aloud is masked and never taken: the engine texts a new one and asks for the keypad (`otp_spoken_reissued`).
- Tries at each check before a person: 3.
- On the chat: members sign in through the member portal, proving level 2 (`signIn: { level: 2 }`).
- Delegates: `broker` with roles `service_rep, office_admin`, signed in on the chat through the broker portal (`portal.delegates`, `principals.delegatePrincipal`, and `principals.fromClaims` for a broker portal token that names `broker_id`).

## Confirmed writes

| Action | Read back as | Values the caller confirms |
|---|---|---|
| `createClaim` | "Let me make sure I have this right. You're reporting {lossType} on {lossDate}, and I have your description. Shall I file the claim?" | `memberId, lossType, lossDate, lossDescription` |

The app's one list of confirmed fields: `memberId, lossType, lossDate, lossDescription`. The description is confirmed by its stand-in ("your description"): the words are not read back (the earlier Harbor's choice, kept).

## Bounds

| Action | Field | Bound | Where it comes from | Rule | Verdict and reason |
|---|---|---|---|---|---|
| `createClaim` | `lossDate` | not after today | the call's day | `dateInRange` (`notAfter: today`) | BLOCK, `loss-date-future` (line `loss_date_future`) |
| `createClaim` | `lossDate` | inside the member's coverage window | `coverageWindow(memberId)`: the member's record, held to the caller by the `scope` rule before it | `dateInRange` (`within`, `verdicts: { outsideWindow: NEEDS_HUMAN }`) | NEEDS_HUMAN, `coverage` (line `handoff_coverage`) |
| `createClaim` | `lossDate` | a date | | `dateInRange` (invalid) | BLOCK, `not-a-date` (a person: no line) |

The earlier Harbor held these in a rule of its own (R4: a loss date that is not a date or is after today refused; outside the coverage window, or no coverage on file, a person). The built-in `dateInRange` says exactly that, a lookup that gives no window included, so it is no custom rule (the skill: a rule of your own only when no built-in rule fits). R4's examples are the edge tests in `src/app.test.ts` ("the bounds and the roles, at their edges") and the policy matrix's named calls (`covered`, `beforeCoverage`, `tomorrow`). In the dialog the date slot (`range: past`) never gives a day to come, so "tomorrow" is asked again by the slot (report-future-date-asked-again), and the gate's `notAfter: today` holds the write whatever the code sends.

## Informational answers

| Intent | The fixed line |
|---|---|
| `capabilities` | "I'm an automated assistant, but you can talk to me naturally. I can tell you the status of a claim, answer questions about what your plan covers, and take a report of a new claim." (since 2026-10-16: it says first what the line is, in the maintainer's words, since "am i talking to a real person" is answered here) |

## Knowledge

| The question callers ask | Topic id | The section of each plan's certificate | Same answer for every caller? | A line from the caller's own data after it |
|---|---|---|---|---|
| "is physical therapy covered" | `physical_therapy` | 4.3 Outpatient rehabilitation | no: by `plan`, read from the member's record by `searchPolicy`'s `facts` | `getUsage`: `used` ("You've used {used} of them this year.") |
| "does my plan cover the emergency room" | `emergency_room` | 3.1 Emergency treatment | by `plan` | none |
| "does my plan pay for an ambulance" | `ambulance` | 3.2 Ambulance services | by `plan` | none |
| "what do I get for a hospital stay" | `hospital_stay` | 3.5 Hospital confinement | by `plan` | none |
| "what does my plan pay if I break a bone" | `fracture` | 3.6 Fracture schedule | by `plan` | none |
| "how much do you pay for an x-ray" | `imaging` | 3.7 Diagnostic imaging | by `plan` | none |
| "is urgent care covered" | `urgent_care` | 3.3 Urgent care treatment | by `plan` | none |
| "how many follow up visits do I get" | `follow_up` | 4.1 Follow-up treatment | by `plan` | `getUsage`: `used` |
| "I chipped a tooth, is that covered" | `dental_injury` | 3.8 Dental injury | by `plan` | none |
| "are sports injuries covered" | `sports_injury` | 5.2 Recreational and sports activity | by `plan` | none |
| "does my plan cover a pre-existing condition" | `pre_existing` | 6.1 Pre-existing condition limitation | by `plan` | none |
| "are prescriptions covered" | `prescriptions` | 7.4 Exclusions | by `plan` | none |
| "am I covered if I get hurt in Europe" | `travel` | 2.3 Territory | by `plan` | none |
| "how long do I have to file a claim" | `filing_deadline` | 8.1 Claim filing | by `plan` | none |

Who approved: every passage's approval names Compliance Review (owner Benefits Content), and each was then confirmed in review by the maintainer (the log's `from: passage` lines of 2026-10-04).

| Document | Where it is | Ingested as |
|---|---|---|
| Accident Advantage Certificate of Coverage, plan year 2026 | carried over from the earlier Harbor | `kb/sources/accident-advantage-certificate-2026.yaml` |
| Accident Advantage Plus Certificate of Coverage, plan year 2026 | the same | `kb/sources/accident-advantage-plus-certificate-2026.yaml` |
| Accident Advantage Plus Certificate of Coverage, plan year 2025 | the same | `kb/sources/accident-advantage-plus-certificate-2025.yaml` |

**How it came here.** The earlier Harbor's `kb/` folder (kb.yaml, topics.yaml, 29 passages, 3 sources, approvals.jsonl of 87 lines) was copied whole and byte for byte, but for: the `# yaml-language-server` first line of every YAML file (its relative path to the schemas); the header comments of `kb.yaml` and `topics.yaml`, which named the earlier app's own files (comments only); `kb.yaml`'s `retrieval` (below); and `topics.yaml`'s new example questions (`asks`, three for each topic), which retrieval reads and no approval covers (an approval covers a topic's title and account line, not its keywords or example questions). No passage's text, approval block or line of `approvals.jsonl` was changed: `cmp` finds the log identical to the earlier one. Each passage's comment that named the earlier app's migration script now says only that the passage was carried over from the earlier Harbor (a comment is outside what an approval covers: `kb:status` showed all 29 fresh after the change).

**State** (`pnpm kb:status apps/harbor`): `apps/harbor/kb: 29 passages (29 approved and fresh, 0 stale, 0 unapproved), 0 pending drafts`, then `every passage is approved and fresh, and nothing waits for review`. So all 29 are in force as far as approval goes, none is withheld, none awaits approval, and nothing is in `kb/pending/`. By their dates, 28 answer today: `pt-plus-2025` (Accident Advantage Plus, physical therapy, plan year 2025) ended 2025-12-31 and is kept for history, so each topic has one passage per plan on the regression's day. Each passage's last line in the log is the maintainer's confirmation in review (`from: passage`), after the migration lines, so `kb:status` marks none as migrated, and `pnpm check` has no approval finding.

**Retrieval.** The engine's hybrid retrieval with the static embedder (`retrieval.embedder: potion-base-8M`), its vectors in `kb/.index/potion-base-8M.json` (`pnpm kb:index apps/harbor`, committed). The paraphrase set is `fixtures/kb/paraphrases.yaml`: 112 paraphrases, 8 for each of the 14 topics, none a title, keyword or example question, and 8 lines about nothing (`none:`). From `pnpm kb:bakeoff apps/harbor --paraphrases apps/harbor/fixtures/kb/paraphrases.yaml --sweep`:

- With the topics as copied (no example questions) and the earlier cap of 4: hybrid recall 84.8% at the model's floor (0.3); at cap 4 the sweep reached 94% only with every topic offered on a line about nothing (floor 0).
- With three example questions per topic: at cap 4 the sweep tops out at 88%; at cap 8, floor 0.35 gives 96% with 1.13 topics on average for a line about nothing (floor 0.45: 92% and none; floor 0.3: 97% and 2.13).
- Chosen: `cap: 8`, `floor: 0.35`. The bake-off at those settings: keyword 86.6%, static 94.6%, **hybrid 95.5% recall at the cap, 65.2% top-1, 7.02 candidates, 1.13 on none**. Weakest topic: travel, 6 of 8 (a country named with no travel word: "Mexico", "Japan"). The topic slot's own `cap: 4` (the earlier Harbor's) was dropped, so the question offers what retrieval nominates.
- `src/kb.test.ts` holds the hybrid recall at 95% or more, at most 1.5 topics for a line about nothing and every topic at 75% or more; it runs where the model is in the cache (CI restores it).

**The corpus and scripted calls** for the knowledge form were written at step 5 with the rest, since every passage was already approved (step 6b's "after the person approves").

**Answers worded for the member's question** (the maintainer's decision of 2026-10-16, [docs/designs/2026-10-16-kb-summaries.md](../../docs/designs/2026-10-16-kb-summaries.md)). Both switches are set: `coverage_answer` frames its `{answer}` as a span worded from the answer (`generate: { answer: { from: answer, goal: "Answer the member's question from their plan's passage, in a sentence or two." } }`, no `words`, so its budget is the passage's word count and a quarter more (ten more at least)), and four topics are marked `risk: low` in `kb/topics.yaml`. Every other topic is regulated (the default), and its passage is said word for word, as before. The four, chosen by the builder:

| Topic | Why it may be worded | What the judge must hold |
|---|---|---|
| `sports_injury` | it describes which activities are covered (amateur sports, school and league play) and which are not (playing professionally): a member's question names one activity ("my kid playing football at school"), and the answer is yes or no for it | the professional exclusion, where the question could be professional play |
| `prescriptions` | it says what the plan does not cover and where such costs usually are: no benefit amount | the "not covered" itself |
| `travel` | it describes where the plan covers accidents (anywhere) and the currency paid: a member asks about one place | "in US dollars" kept as a fact, never a promise of an amount |
| `filing_deadline` | how long a member has to file, and what happens after: the design's own example of an answer an insurer may not regulate, a deadline rather than a dollar term | the 180 days, and that payment after them is not guaranteed |

Left regulated: every topic whose answer is a benefit's dollar amount or a limit on one (physical therapy, emergency room, ambulance, hospital stay, fractures, imaging, urgent care, follow-up visits, dental injury), and pre-existing conditions (an exclusion with two twelve-month terms, which a wording could easily shift). The account line (the member's usage, on physical therapy and follow-up visits, both regulated) would stay word for word after a wording anyway. The approvals cover the passages and their sources, not a topic's risk: `pnpm kb:status apps/harbor` showed all 29 passages approved and fresh after the change.

The model that words them is the secretary's (style.yaml `model: openrouter, google/gemini-3.1-flash-lite-preview`); the hold line is `kb_hold` ("One moment while I gather that information."), said before an answer whose wording is not ready within a line's budget. On the stubs, the fake renderer words an answer from the passage's sentences that bear on the question and every sentence with a figure, a name or a limit (`prescriptions` asked as "do you pay for prescriptions" is said as its first sentence; the other three, as asked in the corpus, come back whole and are said unchanged); the real wording is measured on the next recording (Recordings).

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time (the start, the keypad's 0 from the greeting or after the menu, while verifying, at the code prompt, in each form, while describing what happened, at the read-back) | `live-agent` | `handoff_live_agent` |
| Verification fails 3 times (the factors, or the code) | `identity` | `handoff_identity` |
| A frustrated caller accepts the offer, or the ladder's last rung | `frustrated` | `handoff_frustrated` |
| An office admin files a claim | `broker-filing` | `handoff_broker_filing` |
| A loss date outside the member's coverage dates | `coverage` | `handoff_coverage` |
| A loss date that is not a date (never from the dialog) | `needs-human` | `handoff_needs_human` |
| A slot runs out of tries | `max-attempts` | `handoff_max_attempts` |
| A tool's reply fails its check (not the triage, which is called `failSoft`) | `result-unchecked` | `handoff_result_unchecked` |

## Choices the paragraph left open

- **The keypad from the greeting on** (`menuListens: greeting`): the paragraph says callers can use the keypad, not when, so a key pressed at the greeting is taken; the menu is still offered after two misses.
- **A loss date outside the coverage goes to a claims specialist** (NEEDS_HUMAN), not a refusal: the earlier Harbor's design; a date the dialog heard wrong, or a coverage record that is wrong, is for a person to sort out.
- **The upload link is texted only when the intake service answered**: with no triage there are no documents to name, and the member hears that an adjuster will be in touch. A reply with any code Harbor has no approved line for fails its check whole (the earlier Harbor dropped such codes and kept the rest): the stricter reading of "we never repeat anything that service says except the documents we have approved wording for".
- **The intake service is sent the description** (`fields: [claim, lossType, lossDate, lossDescription]`), as in the earlier Harbor: it triages from it.
- **The usage line** after physical therapy and follow-up visits only (the topics that count visits), as in the earlier Harbor.
- **A broker's coverage question** (since 2026-10-16, the maintainer's decision): the broker is asked which client (`clientId`, asked of brokers only), the gate checks at once that the office is the member's agent of record (`isClient`, a form's check; `coverage_not_client` otherwise), and the answer is that member's plan's, word for word (`answers.subject`). The usage line is left out for a broker (`redact: broker: getUsage: [used]`): it says the member had the treatment, and it speaks to the member ("You've used ..."). The coverage lines that said "your" to a member now read for either (`ask_coverageTopic` "What's your coverage question?", its retry and `coverage_unavailable` say "the plan information"; the intent's label is "check coverage"), and the broker greeting names the coverage task. `coverage_broker` is gone.
- **The lines** are the earlier Harbor's, word for word, where the line still exists. Changed: the document lines are worded for a member and a broker alike ("The discharge summary ..." for "your discharge summary ..."); the intake result is said as lines of their own (`intake_documents_texted`, then each `doc_<code>`, then `intake_adjuster`) rather than one line with a `{documents}` list built in code; a claim waiting on a document says it by its approved line (the claims system's `missing` is now a document code, not free text); the broker's status lines are lines of their own (`claim_status_*_broker`) rather than a `{whose}` variable; `offer_transfer` ends "or keep going" (the knowledge base's unavailable offer uses it too). New: `coverage_broker` (removed 2026-10-16, when brokers' coverage questions were answered), `handoff_coverage`, `handoff_result_unchecked`, `claim_upload`, `claim_upload_broker`. The chat greetings: the earlier `greeting_member_chat` is `greeting_chat`, `greeting_member_chat_signed_in` is `greeting_chat_signed_in`, and the earlier broker greeting is `greeting_chat_delegate`.
- **A fourth member**, Sam Porter (72046185, coverage 2025-06-01 to 2026-05-31, claim 4690), so the policy matrix has a member out of every caller's scope (the earlier data had none: each member was the subject or a client of the one office) and the end of a coverage window is tested.
- **Claim 4720's missing document** is the discharge summary (the earlier data said "the urgent care visit notes", free text).
- **The phones** are +1 555 555 0101 to 0104.
- **The topics' example questions** (`asks`) were added for retrieval (Knowledge).
- **A paid claim's amount** is said in whole dollars ("300 dollars") when it has no cents.

## Gaps

| What | The framework | What I did | Cost |
|---|---|---|---|
| ~~A member who sounds frustrated "about a claim" is offered a person~~ | Closed 2026-10-16: app.yaml's `frustration.forms` | The claim forms | none |
| Brokers sign in through "the broker portal", members through "the member portal": two portals on one chat | One web chat per app takes tokens from one identity provider (`CHAT_JWKS_URL`, `CHAT_ISSUER`); `principals.fromClaims` reads a token's claims | `fromClaims` takes a token naming `broker_id` as that broker, any other as a member (`sub`): it assumes both portals sign in through one identity provider. Two providers would need two apps or a host file | the assumption, written here; the demo portal (`src/portal.ts`, `HARBOR_DEMO_PORTAL=on`, 2026-10-16) is that one provider, both portals on one sign-in page |
| ~~A broker's coverage question about a client~~ | Closed 2026-10-16: a slot's `askedOf` and forms.yaml `answers.subject` | `clientId` asked of brokers, the `isClient` check, the answer for that member | none |
| A knowledge form that needs identity | The engine's knowledge completion turns a `STEP_UP` into a person (`c.refusal`), so the form verifies first with an `entry` call at the answer's level; `AppCode.forms` typed `complete` as required, though an answering form has none (since fixed: `FormHooks` makes it optional, forms.yaml's schema still requiring it of a form that neither answers nor goes on) | `entry` (getCoverage, level 1) and `principalEntry` on the coverage form, the cast `as unknown as AppCode['forms'][string]` since removed | ten minutes |
| A claim named by what it was for before the caller is verified ("the claim for my ER visit") | The record slot matches labels over the records in the facts, loaded by the entry call after verification; at the opening there are none, only a number said | Let it ask: the member names it again after the code (cs-04 and cs-16 at the opening; a number said up front is kept) | one more question |
| The intake service's triage | The guide and patterns document a tool with a `check`; a downstream service (`ServiceDef`, `onServiceResult`, `testing.serviceAnswers`) exists in the API and the testkit but has no guide section or pattern | A tool, `triageClaim`, checked by `replyShape`, called `failSoft` from the completion | it runs inside the filing turn: a slow service delays the line, where a service would answer on a turn of its own |
| A future loss date "asked again" | The date slot with `range: past` never resolves a day to come; the gate's bound refuses a write | The slot asks again (its retry line); the gate's `loss_date_future` line is said only to a write the code sends with such a day, which the dialog never does | none |
| A miss at the description's question | With `commands: ignore` (the default for a `text` slot without `pick`) whatever is said there is the description | No miss line in the corpus for `lossDescription` (corpus.md asks for one for every slot) | none |

**Corpus lines the real model reads otherwise** (`knownGap`, as tagged now: the first two recordings, jev-1.13.0, 2026-10-16, with the tags the second recording and the 2026-10-16 decisions took off removed; each reason in `fixtures/corpus.jsonl` carries the numbers). A stub run still holds each to its label. A line marked "reworded" should read as labelled on the next recording, and lose its tag then.

| Line | What the caller says | What the caller hears instead | Whose |
|---|---|---|---|
| cs-14 | "claim" | "you'd like to check on a claim. Is that right?": one more yes or no | the model's (a single word) |
| lt-07 | "they admitted me overnight", at the kind-of-loss question | the description question is skipped (the words kept as the description too); the date is asked next, nothing filed without a yes | the model's (Recording 2) |

## Baseline edits

The first baseline was made once (`regress --update`: `recorded 173 corpus outcomes and 76 scenario outcomes`) and read entry by entry against this worksheet: the next prompt, the gate's action and verdict, the slots, the level. Findings were fixed in the app or the scripted calls' expectations before it (a repeat request ends at `decision: replay`; a declined frustration offer goes back to the open question). Until the first recording there was no hand edit: the document lines' wording changed after the baseline, but the baseline holds line ids, not words, and the one scripted call that names the words was updated. The edits since are below, each written from `regress --corpus <id> --json` (never `--update`).

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| every entry naming the first member (76 corpus, 47 scenario) | `slots.memberId`, a member ID said | the earlier Harbor's number -> `42716358` (`4271 6358` grouped, spoken digit by digit likewise), in the data, the corpus, the scripted calls and the baseline together | the earlier Harbor's member number is tied to a real person, so it may not appear in the public repository; an invented value for an invented one, the outcomes unchanged (`regress`: no changes) |
| corpus `cs-13` ("i got a letter about my claim and i don't understand it") | `promptId`, `acks`, `form`, `gate` | `confirm_intent_explicit`, `[]`, null, null -> `ask_memberId`, `["ack_intent"]`, `claim_status`, `listClaims:STEP_UP` | first recording, bucket 1: the label's `tentative: true` was wrong. The caller is plainly asking about their claim (claim_status 0.96, intentTentative 0.03), and the claim's status is where a letter about it is explained; the flag is dropped, so the stub routes it as the model does. cv-18 and rc-09 still test the tentative path |
| corpus `rc-02` ("i want to report an accident") | `slots.lossType` | null -> `accident_injury` | first recording, bucket 1: the kind of loss was said and not labelled (lossType accident_injury 0.78). On an accident insurer's line "an accident" is an accident injury (the option's `means`), and the summary reads it back; labelled `lossType: accident_injury` |

| corpus `cr-09` | the line (not the baseline) | `change: adding` and its `knownGap` dropped | the maintainer's decision of 2026-10-16 (findings item 1): a question at the read-back is answered as an aside whatever intentChange reads, so the line is labelled as the model reads it (answering) and the stub takes the new path; its baseline outcome is unchanged (the 180-day answer, then the read-back) |
| corpus `cp-06` | the line (not the baseline) | its `knownGap` dropped | the decision on findings item 6: asking whether one is talking to a person is the capabilities intent; its baseline already held that outcome (the capabilities line), so no edit |
| corpus `cp-09`, `fr-04`, `br-09` to `br-12`, `db-09` to `db-17` | new entries | none -> the stub's outcome, from `regress --corpus <id> --json` | new lines for the 2026-10-16 decisions (below), each outcome read against what the decision says before it was added |
| every corpus and scenario entry with `slots` (174 corpus, 75 scenario) | `slots` | `"clientId": null` added after `dob` | the new slot `clientId` (asked of brokers only): every outcome lists every slot, so each gains the key, null; a script checked that each entry differed from its fresh outcome by that key alone, and wrote only those |
| corpus `br-06` ("does margaret's plan cover physical therapy", as priya) | `promptId`, `acks`, `form`, `slots`, `gate` | `anything_else`, `[ack_intent, coverage_broker]`, null, `searchPolicy:BLOCK` -> `ask_clientId`, `[ack_intent]`, `coverage` (topic physical_therapy kept), null | the decision on findings item 5: a broker is asked which client, then answered for that member's plan |
| scenario `broker-coverage` | its steps, expectation and outcome | the `coverage_broker` refusal -> Margaret's member ID said at the client question, and the answer for her plan (`isClient` ALLOW, `searchPolicy` ALLOW, `getUsage` ALLOW with `used` withheld: no usage line) | the same decision; `broker-coverage-client-up-front` and `broker-coverage-not-a-client` are new |
| corpus `db-10` ("eight two one eight four") | `promptId`, `acks`, `slots.dob`, `principalLevel`, `gate` | `ask_otp`, `[identity_verified]`, `1984-08-21`, 1, `sendCode:ALLOW` -> `ask_dob_example`, `[]`, null, 0, null | the maintainer's decision of 2026-10-16 on dates of birth said as numbers (below): five digits in a run divide only where the keypad would not (8/21/84, or 8/2/1984 with a nine missed), so the run is not read, whatever the labels say, and the caller hears the example line. Its label keeps the true date |
| corpus `db-04`, `db-10`, `db-13`, `db-17` | the lines (not the baseline) | their `knownGap` dropped; db-04 tagged `dob_as_numbers` with the others | the same decision: on the answers recorded in Recording 3, each now ends at its baseline (db-04, db-13 and db-17 read as August 21st, 1984 from their digits; db-10 the example line), checked by replaying that recording on the new code |
| corpus `db-18` to `db-24`, scenarios `dob-numbers-example`, `dob-numbers-example-then-said` | new entries | none -> the stub's outcome, from `regress --corpus <id> --json` and `regress --scenario <id> --json`, written by hand | the same decision, each outcome read against it before it was added: six digits and digits as an ASR writes them read (db-18, db-21), a month name with digits the model's (db-22), a month and day alone the partial (db-23, `ask_dob_year`), a run split where the keypad would not, two readings and no such day the example (db-19, db-20, db-24); the call hears the example, then says the date the example's way and is verified |
| corpus `cv-20` ("do you pay for prescriptions"), scenarios `coverage-answer-worded`, `coverage-answer-hold-line`, `member-chat-answer-hold-line` | new entries | none -> the stub's outcome (`regress --update` after a run whose only differences were these four, each `new`; the rest `no changes`) | answers worded for the question (2026-10-16, Knowledge): a prescriptions answer worded (the passage's first sentence, said generated), and the same with the renderer slow (`renderDelayMs` 2200 on the phone, 3500 in a chat), so the hold line is said first; each outcome read against the decision before it was added (the next prompt `anything_else`, `searchPolicy` ALLOW). Their `text` expectations name only what a real model's wording cannot change (the fixed lines, the hold line), so a recorded replay holds them whatever the model words; the stub's wording is read in the transcript (`regress --scenario coverage-answer-worded`: "line coverage_answer: generated") |
| corpus `cv-21`, `cv-22`, scenarios `coverage-again-no-ack`, `coverage-three-questions`, `coverage-then-claim-next-wording`, `three-requests-third-wording`, `claim-again-no-ack`, `member-chat-coverage-again` | new entries | none -> the stub's outcome, from `regress --corpus <id> --json` and `regress --scenario <id> --json`, written by hand | the acknowledgements of 2026-10-17 (Recordings, below), each outcome read against the decision before it was added: a coverage question after another, and a claim after a claim, end on the answer with no `ack_intent` in `acks` (by phone and in the member chat); a claim after a coverage question opens with `ack_intent.v2` ("Happy to help you check on a claim."), a report after both with `ack_intent.v3` ("Of course, let's report a new claim."). With the options set and before these were added, the run printed `no changes`: no scripted call's last turn starts a second request, so no entry already there changed |

## Recordings

The command, the owner's to run at the repository root, with the key in `apps/harbor/.env` (`pnpm configure --app harbor --mode model` writes it):

```sh
pnpm --filter @dialogwright/example-harbor regress --client record --threshold JEV_TIMEOUT_MS=15000
```

### Recording 1: jev-1.13.0, 2026-10-16

`fixtures/recorded/jev-1.13.0.jsonl`, 433 requests, $0.0727. The adversarial suite: `53/53 cases hold, 20 not run` (18 are the stub's fooled-perception cases, not run under a model by design; 2 have no text to replace): no finding.

Before triage (the replay, as recorded):

```text
corpus     161/173 outcomes match expected
scenarios   74/76 pass expectation,  73/76 match expected
to triage: 12 untagged corpus differences, 2 failing scripted calls, 1 passing scripted call that differs from the baseline, 0 cassette misses
```

After the fixes that change no request, before the rewording (the replay of the same recording):

```text
corpus     163/173 outcomes match expected
scenarios   74/76 pass expectation,  73/76 match expected
known gaps  10/10 drifted (allowed)
to triage: 0 untagged corpus differences, 2 failing scripted calls, 1 passing scripted call that differs from the baseline, 2 cassette misses
```

The 2 misses are identity-three-fails' later turns, after its opener changed (bucket 3, below): a call's later requests carry its history, so they were never recorded. After the rewording every request changed, as expected (`299 cassette misses`), until the next recording. The stub regression: `no changes`, `173/173`, `76/76`, `adversarial 71/71 cases hold, 2 not run`.

**Bucket 1, the label was wrong** (labels fixed, baseline edited by hand, logged under Baseline edits):

- cs-13 "i got a letter about my claim and i don't understand it": labelled `tentative`; the model reads a plain claim_status request (0.96, intentTentative 0.03) and routes it. The flag is dropped.
- rc-02 "i want to report an accident": the model fills the kind of loss, accident_injury 0.78, which the label left out. Labelled.

**Bucket 2, the model misread a borderline line** (tagged `knownGap`; the table under Gaps has each one's caller impact): cs-14, cp-07, sel-10, lt-04, cr-06, cr-09, db-04, cp-06, ot-02, ot-07.

**Bucket 3, a scripted call broke on an incidental step:**

- identity-three-fails opened with "claim" (claim_status 0.50, none 0.34, so the request was checked with a yes or no), and its member ID and dates of birth were then said to that question: three answers that were not a yes or no, and a person for `max-attempts`, never reaching verification. The call tests three failed verifications, so its opener is now "claim status" (cs-08's words, read claim_status 1.00); its expectation is unchanged and the stub's outcome did not move. Its later turns miss until the next recording (a keypad "1" opener was tried and missed sooner).

**Scripted calls for the owner to decide** (not tagged: a scripted call's `knownGap` is the owner's acceptance):

| Call | What the caller says | What the model reads | What the caller hears | Safe? |
|---|---|---|---|---|
| report-aside-at-summary (failing) | "wait, how long do i have to file a claim", at the read-back | intent coverage 1.00, but intentChange answering 0.78 (adding 0.17): taken as the read-back's answer, unanswered (numbers from cr-09, the same words in the same place) | the summary again, word for word, and not the 180-day answer; the claim is filed only on a yes | I judge it safe (nothing is done without a yes), but the question is lost. If accepted, its outcome is `{"acks":[],"decidedGate":"confirmation","verdict":"confirm_unanswered","gate":"getCoverage:ALLOW"}` |
| report-yes-but-friday (passing, differs) | "yes, but it was on friday", at the read-back | the date corrected rightly (lossDateWeekday friday 1.00, changeSlot lossDate 0.95), but lossDescriptionChanged 0.71 (numbers from cr-06) | the summary again with Friday, September 11; the description becomes "got hurt. yes, but it was on friday", which the caller never hears (a stand-in) and would be filed | I judge it safe for the caller (a yes is still needed, the date is right), but the filed description carries the correction's words. Reworded for the next recording (`text.changed`); if it still shows, its outcome is the `slots` above |

Both may read otherwise after the rewording, so the owner decides on the next recording's numbers.

**For the owner:**

| Entry | What the caller says | What the model reads (numbers) | What the caller hears | Whose fix | Candidate |
|---|---|---|---|---|---|
| report-aside-at-summary, cr-09 | a question about the task in hand, at its read-back | coverage 1.00, intentChange answering 0.78 | the read-back again, the question unanswered | the engine's (`intentChange`'s answering criterion takes "anything that is not a request for a different task"; a question about the same task is read as an answer) | a knowledge intent read at INTENT_ROUTE or more at a read-back answered as an aside whatever intentChange says, or the criterion's wording |
| report-yes-but-friday, cr-06 | a yes with a correction of another value, at the read-back | lossDescriptionChanged 0.71 beside changeSlot lossDate 0.95 | nothing wrong is heard; the description silently gains the correction's words | the engine's (the text type's `changed` question says "The caller was read back {what}", untrue when the summary says the slot by its stand-in, as the type does by default; and the words are added even when the turn's change is another slot's) | the default `changed` question worded for a stand-in, or no addition when a changeSlot reading explains the turn. The app now says its own (`text.changed`) |
| cp-06 | "am i talking to a real person" | wantsHuman 0.94, intent agent 0.59 over capabilities 0.41 | put through to a person | the owner's: a label the paragraph does not settle (capabilities' criteria name "whether it is a robot or a person", but the caller may be asking for one) | label it `agent` (bucket 1, a baseline edit) if being put through is right; otherwise it stays tagged |
| db-04 | "eight twenty one eighty four" | dobDay 1 0.32 against 21 0.29, dobYear eighty four 0.25 | the date of birth asked again, with the year | the engine's (the birthdate type's month, day and year questions on a run of numbers) | none needed now: one try, and the keypad |
| adversarial off-scope/open/unanswerable/correct/en (a model reading, fails nothing) | "what was the score of the game last night", at the greeting | ignored as not said to the line (the run prints no numbers) | nothing; the no-input timer asks again | the engine's (`addressedToSystem`) | none: listed as step 9 asks |
| the rewording below | | | | one re-record | |

**The rewording, all at once** (every request changes; the stub regression is unchanged):

- `intents.yaml`, `other`: from "A request the insurance line does not handle" to the same with examples (buying insurance or another kind of insurance, changing or cancelling a plan, adding or removing someone on a plan, a bill or a payment, changing contact details): ot-02 and ot-07 read as coverage (0.54, 0.63) because the criterion named nothing the line does not handle.
- `intents.yaml`, `coverage`: adds "Asking to buy, change or cancel insurance, or to add someone to a plan, is not" (ot-02, ot-07).
- `slots.yaml`, `claimSelect`'s instructions: a claim may be named "by when it was beside the others (the latest one, the older one)" (sel-10: none 0.60, claim_4702 0.34 for "the most recent one").
- `slots.yaml`, `lossDescription`'s instructions: "only the kind of claim with nothing more about what happened (I got hurt, I had an accident, I was in the hospital), is not" (lt-04: lossDescriptionGiven 0.61 for "i got hurt" at the kind-of-loss question).
- `slots.yaml`, `lossDescription`'s `text.changed` (new): the read-back's own question, saying that the kind of claim and the date were read back and the description was not, and asking whether the caller adds something new about what happened besides agreeing or correcting the kind of claim or the date (cr-06, report-yes-but-friday: 0.71).

**A re-record is needed**: one, for the rewording above, with the same command; it records identity-three-fails' new opener too. The first cost $0.07. Then `pnpm --filter @dialogwright/example-harbor cassette:trim`, the replay and the app's tests, and the new recording triaged the same way: each `knownGap now matches` tag removed (expected for sel-10, lt-04, cr-06, ot-02, ot-07 if the rewording works), any line the new wording made borderline tagged, and the two calls above brought back to the owner with the new numbers.

### Recording 2: jev-1.13.0, 2026-10-16, after the rewording

Recorded with the same command (436 requests, $0.0744), then trimmed (`cassette:trim`: 607 answers, kept the 304 a regression run asks for). The replay:

- before the tags were brought up to date: `to triage: 1 untagged corpus difference, 1 failing scripted call, 0 passing scripted calls that differ from the baseline, 0 cassette misses`, corpus 168/173, scenarios 75/76;
- after: `to triage: 0 untagged corpus differences, 1 failing scripted call, 0 passing scripted calls that differ from the baseline, 0 cassette misses`; adversarial `53/53 cases hold, 20 not run` (18 the stub's fooled-perception cases, which a model does not run; 2 with no text to replace).

What changed:

- **The rewording worked for six lines**, whose tags came off (`knownGap now matches`): sel-10 ("the most recent one"), lt-04 ("i got hurt"), cr-06 ("yes, but it was on friday": the description no longer gains the words), cp-07 ("help"), ot-02 ("do you sell car insurance"), ot-07 ("can i add my spouse to the plan"). report-yes-but-friday now matches its baseline.
- **One new borderline line, tagged** (bucket 2): lt-07, "they admitted me overnight" at the kind-of-loss question: lossType hospital_stay 1.00 and lossDescriptionGiven 0.65 (bar 0.6), so the words are kept as the description too and its question is skipped; the caller is asked the date next, and nothing is filed without a yes.
- **Still tagged, as before:** cs-14, cr-09, db-04, cp-06.
- **Still failing, for the owner:** report-aside-at-summary (the engine's intentChange gap above, numbers unchanged). It is not tagged: whether its end is acceptable is the owner's to say. Until then the recorded replay is not in CI (a failing call would turn it red); once the owner decides, add `pnpm --filter @dialogwright/example-harbor regress --client recorded` after the stub step.
- **cp-06 still waits for the owner's label** ("am i talking to a real person": put through to a person, or told what the line is).

### The maintainer's decisions of 2026-10-16 (built on the branch `engine-decisions`, before the next recording)

The findings ([docs/designs/2026-10-16-harbor-findings.md](../../docs/designs/2026-10-16-harbor-findings.md)) were decided; what each changed here:

- **Item 1, a question at the read-back.** The engine now answers a knowledge or informational question at a summary, read at `INTENT_ROUTE` or more, as an aside whatever intentChange reads (app.yaml `questionAtSummary`, default `aside`; Harbor keeps the default). cr-09 loses its tag and its `change: adding`; report-aside-at-summary is expected to pass on the next recording.
- **Item 6, "am I talking to a real person".** The engine's `wantsHuman` question now says the caller is talking to an automated line and that asking whether one is talking to a person is not asking for one. Harbor: the capabilities line begins "I'm an automated assistant, but you can talk to me naturally."; the agent intent's criteria say the same; cp-06 loses its tag; cp-09 ("is this a real person or a machine") is new.
- **Item 2, the text type's `changed` question.** The default now says how the summary said the words (by the stand-in here) and that correcting another detail is no change to them: what Harbor's own `text.changed` said, so it is removed. The next recording measures the default on cr-06 and report-yes-but-friday.
- **Item 3, frustration about a claim.** `frustration: { forms: [claim_status, report_claim] }` in app.yaml; fr-04 (a frustrated coverage question at the opening) is not answered for its tone. The three frustration calls are unchanged.
- **Item 5, a broker's coverage question.** `clientId` (asked of brokers only), the `isClient` check, `answers.subject: clientId`, `getUsage`'s `used` withheld from brokers, `coverage_broker` gone, the coverage lines worded for either caller.
- **Item 7, dates of birth as numbers.** db-09 to db-17, labelled with the true date (August 21st, 1984), in several shapes ("oh eight twenty one nineteen eighty four", "eight two one eight four", "august twenty first eighty four", "zero eight two one one nine eight four", "eight slash twenty one slash eighty four", ...), tagged `dob_as_numbers`. The birthdate type is unchanged: the next recording measures them (db-04 keeps its tag until then).

**The policy read back, read as a change in what the agent may do** (`policy.matrix`, `POLICY.md`, `APP-MAP.md`, regenerated with `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram`):

- A new action, `isClient` (a form's check: the gate answers, nothing runs), at level 0 with `identity` and `scope(clientId)`. The matrix: a broker of either role (and an unlisted or roleless broker, as the scope rule reads only the office) is allowed for an in-scope member and refused (`scope`) for any other; a member is allowed only for their own member ID (and is never asked for a client, so never sends one); anonymous callers and other parties are refused. It is level 0 so that it never starts a verification: the scope rule alone refuses anyone whose scope does not hold the member. No caller gains anything here that `searchPolicy` did not already allow: `searchPolicy`'s rows are unchanged (a broker in scope was already allowed by the gate); what changed is that the dialog now names the client, so a broker's coverage question reaches it.
- `getUsage`'s `used` is withheld from brokers (POLICY.md "What is withheld"): a broker hears the coverage answer without how many of the benefit the member used. Nothing else is withheld or released.
- POLICY.md's "What is recorded" gains `clientId` by its last four; the roles table lists the new check among what every role may do.
- APP-MAP.md: the coverage form asks for the client's member ID of brokers only, then the topic, and checks `isClient`; the intent's label is "check coverage"; the capabilities line is the new one.

**A re-record is needed** for every app (the engine's `wantsHuman` and text `changed` questions changed every request), Harbor's with the same command as before. Until then the recorded replay misses, as expected.

### Recording 3: jev-1.13.0, 2026-10-16, after the engine's decisions

Every app recorded again after the maintainer's decisions of 2026-10-16 (a question at a read-back answered as an aside; the wants-a-person question reworded; the text type's changed question; frustration limited to the claim forms; a client named by a broker), with the render cassettes replayed (`--render recorded`). Harbor: 458 requests, $0.0807; trimmed to the 324 answers a run asks for. The replay: `to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses`, and it now runs in CI.

- **report-aside-at-summary passes**: the filing deadline asked at the claim's read-back is answered, then the read-back asked again (the aside, findings item 1).
- **cp-06 and cp-09** ("am i talking to a real person", "is this a real person or a machine") hear that the line is automated and what it can do.
- **lt-07 and db-04** keep their tags, their pinned slots given `clientId` (the broker's new slot).
- **Dates of birth as runs of numbers** (findings item 7, measured): of the ten lines (db-04, db-09 to db-17), six are heard (a month name, "nineteen", "the twenty first of", slashes, or "it's ... nineteen eighty four") and four are not, each tagged with its numbers:
  - db-04 "eight twenty one eighty four", db-10 "eight two one eight four", db-17 "oh eight two one eighty four": no date heard (the month read as january or october, the day as 1), so the caller is asked again and may key it;
  - db-13 "zero eight two one one nine eight four": heard as **January 1, 1984**, so verification fails and uses one of the three tries. A run of single digits is where the birthdate type misreads; a candidate for the maintainer (the type's month and day questions on a run of digits, or keying offered first after a miss).

### Answers worded for the question (2026-10-16, on the branch `kb-answers`, before the next recording)

**The policy read back, read as a change in what the agent may do** (`policy.matrix`, `POLICY.md`, `APP-MAP.md`, regenerated with `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram`):

- `POLICY.md` gains "Lines a model words": `coverage_answer` may have its passage worded for the member's question on `sports_injury`, `prescriptions`, `travel` and `filing_deadline` only, with its goal and its budget (the passage's word count and a quarter more (ten more at least)); what the model is sent (the goal, the sentence, the passage, the question) and never sent (the usage line, a record, another passage, the transcript); the checks, the judge at 0.5, the passage word for word on any failure, and the hold line. Its header now names `prompts.yaml` and `forms.yaml` among what it is read from. Nothing the agent may do changed: no action, rule, scope, withholding or record; what changed is how four answers may be said, and the card says so.
- `policy.matrix` and `APP-MAP.md`: unchanged (no action, rule or form changed; the map draws no line's wording).

**A re-record is needed for Harbor**, the maintainer's step: a turn that says a `risk: low` answer now asks the decision model to screen the member's question again and to judge the wording (`renderAnswerDrift`), and the render model to word it, none of which the cassettes hold; and the four new entries' turns are new requests. Until then Harbor's recorded replay misses on them (each such answer is said word for word: the screen's miss is a `content-flagged` fallback, the render's a `cassette-miss`), so it must not run in CI before the recording. The commands, at the repository root:

```sh
# the render model, recording the answers' wordings (and the decision model's turns with them)
pnpm --filter @dialogwright/example-harbor regress --client record --threshold JEV_TIMEOUT_MS=15000
# then the replay that CI runs
pnpm --filter @dialogwright/example-harbor regress --client recorded
# the render model compared, from the recording
pnpm render:bakeoff apps/harbor --models openrouter:google/gemini-3.1-flash-lite-preview --replay
```

### Recording 4: jev-1.13.0 and gemini-3.1-flash-lite-preview, 2026-10-16, answers worded

The first recording with worded answers (the decision model and the render model, OpenRouter): 466 requests, $0.0824 for the decision model; the render model's seven wordings cost well under a cent. Replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- **Generated lines**: 7 tried; 1 said as a new wording, 4 came back as the passage's own words (said as the passage), 2 refused by the judge (drift), so the passage was said. Wording latency p50 about 1 s, p95 3.5 to 4.4 s: the hold line is for exactly that tail.
- **What it said**, beside the passage: the filing deadline, "You have 180 days from the accident to file a claim. We may still review it after that, but payment is not guaranteed." (passage: "...After that we may still review it, but payment isn't guaranteed."); prescriptions, "Prescriptions aren't covered by this plan; they're usually covered by your medical insurance." The one the judge refused turned "usually covered by your medical insurance" into advice to check with one's provider.
- **Harbor's passages are short** (one or two spoken sentences), so there is little to summarize: worded answers show their value on longer passages, which Harbor does not have. New passages are drafts a person approves (kb:review, kb:approve): the maintainer's.

**The judge on Harbor's 28 labelled answer cases** (`pnpm render:judge-eval --cases apps/harbor/fixtures/judge/answers.jsonl`, recorded into `fixtures/judge/recorded/`): Jev answers in 120 ms at p50 (177 ms p95). With the data checks, it catches 14 of the 16 unfaithful wordings (88%) and refuses 1 of the 12 faithful (8%) at the engine's 0.5. The two it lets by are exclusions dropped on low-risk topics: sports injuries 0.45 and prescriptions 0.35. On the four low-risk topics alone, no faithful wording scores above 0.27 and no unfaithful one below 0.35, so Harbor sets `judge.refuseAt: 0.3` (style.yaml): every unfaithful wording on a low-risk topic refused, no faithful one, on these cases. A small set: more cases (and a dropped exclusion on each low-risk topic) before a real line goes live.

**The word budget**: the passage's word count and a quarter more (ten more at least). At the passage's exact count, two faithful rewordings one word longer fell back; with the room, the data checks refuse no faithful case, and the two added promises the exact count used to catch are caught by the judge (0.97, 0.96).

### Dates of birth said as numbers (2026-10-16, on the branch `dob-numbers`, before the next recording)

The maintainer's decision on findings item 7 ("Recorded"): the birthdate type reads a date said only in numbers at its question from the digits, as the keypad reads them, in place of the model's month and day (`readNumbers`, on by default), and a run of numbers it cannot read one way is asked again with an example (`numbersExample`, on by default; [the type's page](../../docs/slots/birthdate.md#a-date-said-in-numbers) says exactly what is read). Harbor keeps both defaults and words the line:

- `ask_dob_example`: "Sorry, I didn't catch that date. You can say it like August twenty-first, nineteen eighty-four, or key in the eight digits." (the keypad is taken whenever the date of birth is asked).
- The questions the model is sent are unchanged, so the cassette of Recording 3 still answers every existing line: replayed on the new code, db-04 "eight twenty one eighty four", db-13 "zero eight two one one nine eight four" and db-17 "oh eight two one eighty four" verify as August 21st, 1984 (db-13 was heard as January 1st, 1984 and used a try), and db-10 "eight two one eight four" hears the example line; their `knownGap` tags are gone (Baseline edits). Of the ten measured lines, the six heard before are unchanged (db-09, db-12 now read from the digits, to the same day; db-11, db-14, db-15, db-16 have words in them and stay the model's).
- New: db-18 to db-24 and the two scripted calls `dob-numbers-example` and `dob-numbers-example-then-said`, the last an ambiguous run that hears the example and is then said the example's way.

**A re-record is needed for Harbor**, the maintainer's step: the seven new lines and the two new calls are requests the cassette does not hold (the replay: `to triage: 7 untagged corpus differences, 2 failing scripted calls, 0 passing scripted calls that differ from the baseline, 10 cassette misses`, every one of them a new line or call; each falls to `system_slow_dtmf_hint` on its miss). Until then Harbor's recorded replay must not run in CI.

### Recording 5: jev-1.13.0, 2026-10-16, dates of birth said as numbers

After the birthdate type learned to read a date said only in numbers (the keypad's way) and to ask with an example when it cannot: 480 requests, $0.0847, the generated lines replayed (`--render recorded`). Replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- The ten lines measured in Recording 3 now: db-04, db-13 and db-17 verify as August 21, 1984 from their digits (db-13 had been heard as January 1, 1984); db-10 ("eight two one eight four", which the keypad would not split that way) hears the example line.
- The new lines (db-18 to db-24) and both new calls hold on the real model, but for one: db-22 "august two one eighty four" names a month, so the model reads it (august 0.91, day 21 0.62), and it reads the year as "two one eighty four" 0.49; the caller is asked again. Tagged (bucket 2), safe.

### Recording 6: jev-1.13.0 and gemini-3.1-flash-lite-preview, 2026-10-17, the fuller passages

After the maintainer approved the four low-risk topics' fuller passages (version 2026.2, drawn from each plan's member guide, 60 to 80 words each; `kb:approve`, 2026-10-17): 480 requests, $0.0849; trimmed to the 344 answers a run asks for. Replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- **Generated lines**: 7 tried, 4 said as a new wording, 3 refused by the judge (drift), so the passage was said. Wording latency p50 837 ms, p95 4.3 s.
- **What a worded answer sounds like now**, for the question asked:
  - "how long do i have to file a claim", from the 80-word filing passage: "You have 180 days from the date of your accident to tell us about a claim."
  - "do you pay for prescriptions", by phone: "One moment while I gather that information. Prescription drugs and medications are not covered by this plan, even if prescribed for an injury from a covered accident. You should use your major medical plan card at the pharmacy for those costs."
  - the same in the member chat, its own wording, after the same hold line.
- **The hold line** is said where the wording ran past a line's budgets (1.4 s by voice), before the answer, on the phone and in the chat.
- Against the short passages (Recording 4) the model mostly said the passage back (4 of 7); against the fuller ones it words every answer it is asked for, focused on the question, and the judge, at Harbor's 0.3, refuses the rest.

### Acknowledgements and the answer's goal (2026-10-17, on the branch `ack-rotation`, before the next recording)

The maintainer's live call of 2026-10-17: a caller asked three coverage questions back to back, and each answer began "Sure, I can help you check coverage.", which sounds automated. The maintainer's decision: only the first time for the same request, and a handful of wordings of the same kind, said in turn, as the call moves to another request. Both are engine options with today's behaviour as the default ([the guide](../../docs/guide/02-the-files-one-by-one.md#the-acknowledgement-of-a-request)); Harbor sets both:

- app.yaml `ackIntent: { repeat: skip }`: a request the call has already acknowledged (a second coverage question, a second claim) goes straight to its answer or its first question.
- prompts.yaml `ack_intent`'s `variants`, said in turn after its text, by how many acknowledgements the call has said (never at random): "Sure, I can help you {intentLabel}.", "Happy to help you {intentLabel}.", "Of course, let's {intentLabel}.", "All right, let's {intentLabel}.". Each was read with the three labels a request is acknowledged by ("check on a claim", "check coverage", "report a new claim"). The trace and the baseline name the wording said: `ack_intent`, `ack_intent.v2`, `ack_intent.v3`, `ack_intent.v4`.

The same call's filing-deadline answer, "You have 180 days from the date of your accident to file a claim.", was refused by the drift judge (at Harbor's 0.3) and the passage was said instead: the wording left out the passage's condition that a claim sent later may still be reviewed, but payment isn't guaranteed. The judge was right, so it stays at 0.3; what changed is the goal of `coverage_answer`'s `{answer}` span, which asked only for "a sentence or two". It now says what the answer must keep: "Answer the member's question from their plan's passage, in a sentence or two, keeping anything the passage says that changes the answer." A goal, not a procedure: the model is given what the answer is for and the full context, never instructions for its words. POLICY.md lists the new goal.

Both change the requests a recording makes (the turns after a second request, and every worded answer's request and its judge's), so Harbor must be recorded again; until then its replay misses those requests.

### Recording 7: jev-1.13.0 and gemini-3.1-flash-lite-preview, 2026-10-17, acknowledgements and the answer's goal

After the acknowledgement options (said once a call per request, `ackIntent.repeat: skip`, and four wordings in turn) and the answer's new goal ("..., keeping anything the passage says that changes the answer"), from the maintainer's live call of 2026-10-17: 507 requests, $0.0899; trimmed. Replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- **Worded answers**: 11 tried, 10 said as a new wording, 1 fell back (a figure or name not in the passage). Before the goal changed: 4 of 7 (Recording 6). Latency p50 840 ms, p95 4.1 s.
- **The filing deadline**, the answer the live call heard refused twice: now worded with its condition, for example "You have 180 days from the date of your accident to tell us about a claim. Claims sent after that time may still be reviewed, but payment is not guaranteed, so it is best to file as soon as you can."
- **The judge on the live call's two wordings**, added to `fixtures/judge/answers.jsonl` and recorded: the one that drops the condition scores 0.44 (refused at Harbor's 0.3; the engine's 0.5 would have let it by), the one that keeps it 0.08. On all 30 cases at 0.5: 14 of 17 unfaithful caught, 1 of 13 faithful refused.

### Recording 8: jev-1.13.0, 2026-10-17, the topic's "none" at a read-back

On two live calls (2026-10-17), "Wait. How long do I have the file?" (the recognizer's "the file" for "to file"), asked at a claim's read-back, opened the coverage aside but did not fill its topic: the topic question, asked as the aside's follow-up, read filing_deadline 0.52 against none 0.48, and on the earlier call 0.47 against 0.53, under the 0.55 the topic fills at, so the caller heard "What's your coverage question?" and had to ask again. A clean wording read 0.98 to 1.00 everywhere. A reading near 0.5 is a question problem (guide 17.4): the topic's `none` said "Asks about none of these, or asks nothing about coverage", and at a claim's read-back a question about filing can read as being about the claim rather than coverage. It now says "Asks about none of these topics".

Recorded (509 requests, $0.0901) with the live words as a corpus line at the read-back (cr-10, tagged `live_asr`): filing_deadline 0.83 against none 0.17, and the deadline answered with the read-back after it. Replay: `0 untagged, 0 failing, 0 differing, 0 misses`. Baseline: cr-10 added by hand (from `regress --corpus cr-10 --json`).

## Skill trial notes

Each place the skill, the guide, patterns.md, options.md or the framework was unclear, wrong, missing something or cost a wrong turn, with what I did.

1. **Step 3's order of replacement does not work file by file.** It says to replace `app.yaml` first and run `pnpm check` after each piece; `app.yaml`'s `console.formLabels`, `slotLabels` and `handoff.data.send` name forms and slots that do not exist yet, so the first check reports ten problems about files not yet written. Every file names the others (forms name slots and actions, the policy names tools, the lines name slots), so I wrote them all and then iterated on `pnpm check`, two rounds. Suggest: slots, then intents and forms, then policy and identity, then the code, then app.yaml's labels and the lines; or say that check is green only once all are in.
2. **The scaffold's `accountIdOf` reads the factor slot; patterns.md ("Verification") reads the principal.** On the chat a signed-in member has no factor slot, so the slot version would send an empty member ID. Easy to miss when replacing the example; I followed patterns.md (`memberIdOf`). The template could do as the pattern says.
3. **Step 6b comes too late for an app whose main task is a knowledge form.** `pnpm check` refuses a `topic` slot and an `answers` form when there is no `kb/` folder, so the folder had to be in at step 3, not after the baseline. Step 6b also assumes drafts written now; for passages already approved elsewhere (carried over with their log), only the guide's 12.8 says anything (a migration's `from: migration` lines), and the skill does not mention it.
4. **A knowledge form that needs identity is not in patterns.md.** "A knowledge form" shows an answer at level 0. With the resolving action at level 1 and no entry call, the engine's completion would send a caller not yet verified to a person (`c.refusal` on a `STEP_UP`). An `entry` call at the answer's level fixes it, but `AppCode.forms` then needs a cast, since it types `complete` as required (Gaps). Worth a paragraph, and a type fix.
5. **The custom rule the brief named is a built-in.** The earlier Harbor's R4 (a loss date not a date or after today refused; outside the coverage window, or no coverage, a person) is exactly `dateInRange` with `notAfter: today`, `within: coverageWindow(memberId)`, `reasons` and `verdicts`. The skill says a custom rule only when no built-in fits, so I wrote the built-in and turned R4's examples into edge tests. If the maintainer wants a `defineRule` example in an app, R4 is not one.
6. **No row for a frustrated caller.** The paragraph's "a member who sounds frustrated ... is offered one" has no row in options.md or in the worksheet's decisions; it is the engine's ladder with three lines the scaffold already writes. I found it by searching the guide. A row ("A frustrated caller is offered a person: built in; its lines; it cannot be limited to one task") would answer it.
7. **A downstream service: tool or `ServiceDef`?** The guide and patterns describe only a tool with a `check`; `ServiceDef`, `onServiceResult` and `testing.serviceAnswers` are in the types, the testkit and chapter 15's hostile replies, with no section saying when to use one. I used a tool, with `failSoft` from the completion, so that a reply that fails its check is "no answer" rather than a person after the claim is filed; `failSoft` from a form's completion is documented only in the type's comment (the guide shows it in the start hook).
8. **The policy matrix's named calls must carry exactly the confirmed fields.** I first gave `calls.createClaim` the whole `values` object; the extra keys made every row "BLOCK confirmation", silently, with no named call shown passing. patterns.md says a row where every caller is refused for one reason is a sign the calls are missing; it could add that a named call for an action with a `confirmed` list carries those fields and no others.
9. **The matrix needs a member out of every caller's scope.** The data had none (each member was the subject or a client of the one office), so the grid's `outOfScope` record read as unknown. The type's comment mentions a `lookups` override for this; patterns.md does not. I added a fourth fictional member.
10. **The regression does not say why an adversarial case is "not run".** `adversarial 71/71 cases hold, 2 not run` gives no ids; the reasons are in the report's notes, which `regress` never prints. A throwaway script with `formatAdversarialReport(report, { notes: true })` found them (`hostile-reply/verifyCode/field` and `hostile-reply/getUsage/field`: replies with no text to replace). A `--notes` flag, or the not-run ids printed, would do.
11. **"Every other test" before the baseline includes the read-back tests, which fail until step 7.** Step 6 says the type check, every other test and no failing scripted call must be clean before `--update`; the scaffold's read-back tests fail from the first policy change until the pages are written at step 7. I made the baseline with only those three (and the baseline comparison) red.
12. **A miss for every slot cannot be written for a dictated `text` slot.** corpus.md asks for five answers per slot, one that misses; with `commands: ignore`, whatever is said at the question is the description.
13. **The repeat request's scripted call ends at `decision: replay`**, with no `promptId`; corpus.md's list of decisions does not name `replay`.
14. **The topics carried no example questions**, and recall at the earlier cap was 85%. Adding `asks` (which no approval covers) lifted it to 95.5% at cap 8. Step 6b could say that example questions are the first lever, before the floor and the cap.
15. **The corpus's `offer_transfer` context**: seeded through `testing.offerTransferForm` (here the coverage form), a yes there ends at `handoff_frustrated`, while the guide (12.5) says a yes to the knowledge base's unavailable offer is a `live-agent` handoff. Which offer the seed makes is not said; I kept the lines (ft-01, ft-02) and note it here.
16. **The docs index.** The root CLAUDE.md says to keep `docs/README.md` accurate when something is added; the skill's final checklist does not mention it. I added the app there.
17. **The app map draws a form's entry call under its summary** (report_claim's `getCoverage` appears as called after the read-back): `calls` has no way to say which call is the entry. Cosmetic.

The triage of the first recording (step 9 and triage.md):

18. **A bucket-3 fix to a spoken step is not free.** triage.md suggests opening a call that reached its form through a borderline opener "with one of the form's plain corpus lines", and its order puts scripted calls' steps among the fixes that change no request, each checked for `0 misses`. But a call's later requests carry what was said before, so every later turn of identity-three-fails missed once "claim" became "claim status" (2 misses), and a keypad opener ("1") missed from its first spoken turn. Only the stub can check such a fix; the guide could say that changing a step (spoken or keyed) re-keys the call's later turns and waits for the re-record, and that the `0 misses` check holds for labels, tags and code only.
19. **`--scenario <id>` prints no readings.** Under `--client recorded`, `--corpus <id>` shows every question's answer, but `--scenario <id>` shows the turns and the diff, no numbers (nor does `--json`, nor `--adversarial <id>` for a "model reading" case). For the two scripted calls I quoted the corpus lines with the same words in the same place (cr-06, cr-09); triage.md implies the call's numbers are there.
20. **The question itself is not printed.** "After a live call" step 4 says the whole question is printed by `regress --client recorded --corpus <id>`; it prints the questions' ids and answers only. The text type's `changed` question is in docs/slots/text.md, but the engine's own (`intentChange`, `wantsHuman`) are only in `core/questions.ts`, which an app author should not need to open. Nor are the bars printed: to say which threshold a reading missed I read `core/thresholds.ts`.
21. **A passing scripted call that differs has no bucket.** The summary counts it ("1 passing scripted call that differs from the baseline"), but triage.md's buckets cover corpus lines and failing calls; its only allowances are `cosmeticDrift` (the gate and verdict alone) and a `knownGap` the owner accepts. The guide could say that such a call goes to the owner like a failing one (report-yes-but-friday: the slots differ).
22. **The `model reading, adversarial` line** is in step 9 ("list it for the owner") but not in triage.md's table of what the run prints.
23. **A slot difference's `knownGap` outcome carries the whole `slots` object**, since the pin is laid over the baseline's outcome a field at a time; the examples show only flat fields.
24. **When to commit the cassette.** Step 9 says to commit it with the triage; triage.md does not say when. Committed before the rewording it replays as triaged (2 misses, from bucket 3); after the rewording it misses everywhere until the re-record. I committed the cassette, the labels, the tags and the scripted call first, then the rewording on its own, so the first commit is the triage checked on the recording.
25. **What worked**: the three buckets fitted every entry; bucket 1's "the stub's `~` lines are exactly the ones you meant" held to the field (cs-13 and rc-02 showed the model's own diff on the stub), so the hand edits were mechanical; `knownGap` tags on the corpus took the untagged count from 12 to 0 with no miss.

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [x] Every decision has its answer, each option it led to is built, and each option's pattern's **Test** calls are scripted (a read-back answered no, with a value and with "yes, but"; the step-up; a code said aloud; a frustrated caller's offer accepted and declined).
- [x] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [x] Every slot has at least five answers in the corpus, every summary at least four (but a miss for `lossDescription`: Gaps).
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); each bound is tested at its edges; there is no custom rule (the loss date's bounds are the built-in `dateInRange`).
- [x] Scripted calls cover each form, each principal (anonymous, level 1, level 2, each broker role), the step-up, failed verification (the factors and the code), each refusal (scope for a member and a broker, the role, the coverage dates), each handoff (a person from the start, the keypad from the greeting and after the menu, inside each form, while verifying, at the code prompt, while describing, at the summary; by role; by the coverage rule; frustrated), keypad entry (member ID, date of birth, claim, kind of loss, date of loss, the code) and the informational answer.
- [x] `identity.yaml` matches the paragraph: the member ID and date of birth, the code only where a level 2 action needs it (claims), three tries.
- [x] The policy read back (`policy.matrix`, `POLICY.md`, `APP-MAP.md`) matches "Who may do what" above, cell by cell, and the card matches the paragraph line by line; each is tested.
- [x] Every tool lists its `params`, every param has a row under "What is recorded", and the card's table says what the row does; nothing a person said in their own words is kept (the description by its length).
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`, or is a passage a person approved.
- [x] Every tool whose reply a line says, or a call is made from, checks it; app.yaml says `testing: { adversarial: on }`, and the regression's line is `adversarial 71/71 cases hold, 2 not run` with no `FAIL adversarial`.
- [x] The knowledge base: every topic has keywords, example questions, a source section and an approved passage per plan; I approved none and wrote no approval, hash or approvals line; paraphrases (8 a topic) and the recall test are written; no model key is in any file.
- [x] Nothing private or real: invented names, 555 numbers.
- [x] `pnpm check` ok; `pnpm verify` green; every app's regression and the testkit's say `no changes`.
- [x] The baseline was made once with `regress --update` and read entry by entry; no later edit.
- [x] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and keeps the scaffold's recording steps; `CLAUDE.md` matches the folder.
- [x] The gaps above are written up.

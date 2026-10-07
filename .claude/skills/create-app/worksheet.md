# The design worksheet

Copy everything below the line into `apps/<name>/DESIGN.md` (draft it in your scratch space first: `pnpm create-app` refuses a folder that exists) and fill it in. It is the app's design, the record of every choice the paragraph did not make for you, and the checklist you finish with. Keep it current as the app changes, and commit it with the app. Replace each `<...>`; delete the example rows.

---

# <Display name>: design worksheet

## The paragraph

> <the description, word for word>

## Intents

| Intent id | Kind (form, informational, control) | What the caller wants | Example phrasings (five or more, terse ones included) |
|---|---|---|---|
| `<intent>` | form | <one line> | "<full sentence>", "<another>", "<fragment>", "<one word>", "<with a value in it>" |
| `agent` | control | a person, at any time | "<...>" |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Asked when | Keypad? | Sensitive? |
|---|---|---|---|---|---|---|
| `<form>` | <what it is> | `<slotId>` | `<type>`: <options> | <always, or only for some callers> | <yes: `keypad: true`> | <masked by default?> |

## Actions

| Tool | Reads | Writes | Params (exactly what it sends: `params` in code) | Level | Rules, in order |
|---|---|---|---|---|---|
| `<tool>` | <records> | <nothing, or what> | `<a>, <b>` | <0, 1, 2> | `identity`, ... |

## What is recorded

One row per param any tool lists. A param named after a slot with a redact setting is recorded as the slot says; every other is declared under `audit:` in `policy.yaml` (`last4`, `mask`, `length`, `secret`, `keep`). Say why for any value kept as it is that a person said in their own words.

| Param | Slot, with its redact setting (or "not a slot") | Recorded as (`audit`, or the slot's) | Why |
|---|---|---|---|
| `<a>` | `<slotId>`: `last4` | the slot's | an identifier |
| `<b>` | not a slot | `keep` | <a choice from a short list> |

## Who may do what

One row per action, one column per kind of principal. Each cell: allowed, refused, a person, or "after verifying to level N".

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate `<kind>`, role `<role>` |
|---|---|---|---|---|
| `<tool>` | | | | |

## Verification (identity.yaml)

- Subject kind: `<kind>`.
- Level 1: factors `<slot>, <slot>`, checked by `<verifyTool>`.
- Level 2 (only if an action needs it): a one-time code of `<n>` digits, sent by `<sendTool>`, checked by `<codeTool>`.
- Tries at each check before a person: `<n>` (default 3).
- On a chat (if the app has one): subjects sign in through the portal, proving level `<the top level>` (`signIn`).
- Delegates: `<kind>` with roles `<role>, <role>`. How they reach the app: signed in on a chat (`portal`).

## Confirmed writes

| Action | Read back as (the summary line) | Values the caller confirms |
|---|---|---|
| `<tool>` | "<line with {vars}>" | `<field>, <field>` |

The app's one list of confirmed fields (every `confirmed` rule names it, in this order): `<field>, <field>, ...`.

## Bounds

| Action | Field | Bound | Where it comes from | Rule (`limit`, `dateInRange`, `custom`) | Verdict and reason |
|---|---|---|---|---|---|
| `<tool>` | `<param>` | <not before today> | <the call's day> | `dateInRange` | BLOCK, `date-range` |

## Informational answers

| Intent | The fixed line |
|---|---|
| `<intent>` | "<line>" |

## Knowledge

Delete this section when no caller asks a general question that a document answers. A knowledge base says what people approved, word for word; an assistant drafts at most, and only a person approves.

| The question callers ask | Topic id | The document and section that answers it | Same answer for every caller? (else the fact it depends on, and the system it is read from) | A line from the caller's own data after it (tool, fields) | Who approves (a person, and their team) |
|---|---|---|---|---|---|
| "<what are your hours>" | `<opening_hours>` | `<patron-guide>`, section `<1.1>` | <yes, or: depends on `<card>`, read by `<tool>`> | <none, or `<getFees>`: `<balance>`> | <name, team> |

| Document | Where it is (a folder, a file, an address the paragraph names) | Ingested as (`kb/sources/<doc>.yaml`) |
|---|---|---|
| <Patron guide> | `<docs/patron-guide.pdf>` | `<patron-guide>` |

Drafts awaiting approval, and who has been asked (the commands are `pnpm kb:review apps/<name>` and `pnpm kb:approve <id...> --by "<their name>"`):

- <draft id: awaiting <person>>

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time | `live-agent` | `handoff_live_agent` |
| Verification fails <n> times | `identity` | `handoff_identity` |
| <a role, a bound, a rule> | `<reason>` | `handoff_<reason>` |

## Choices the paragraph left open

- <what you chose, and why>

## Gaps

What the paragraph asks that the framework does not do, or does differently; what you did instead; what it cost.

| What | The framework | What I did | Cost |
|---|---|---|---|
| | | | |

## Baseline edits

Every hand edit to `fixtures/expected/*.json` after the first `regress --update`: the entry, the field, and why the new value is right. A new corpus line or scripted call is an edit too: list the new entries and what you read to accept them.

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| | | | |

## Recordings

Filled in once the owner has recorded the app (step 9 of the create-app skill, and its `triage.md`). One block per recording.

- Recording <n>, <date>, model `<model>`: corpus <matching>/<total>, scripted calls <passing>/<total>; `to triage: <N> untagged differences, <M> failing scripted calls, <K> misses`.
- Labels fixed (the model was right): `<id>`, ... (each also under "Baseline edits").
- Tagged `knownGap` (the label is the truth): `<id>`: <the model's numbers>; <what the caller hears>.
- Scripted calls changed on an incidental line: `<id>`: <the step, before and after>.
- Checked on this recording without a new one: <code, policy or flag changes, and what the replay showed>.
- For the owner: <each engine gap or open question, with its numbers and caller impact, and any scripted call left failing because of it>.

## Final checklist

- [ ] Every sentence of the paragraph is a row above, and every row is built.
- [ ] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [ ] Every slot has at least five answers in the corpus, every summary at least four.
- [ ] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); each bound is tested at its edges; every custom rule is a `defineRule` with examples the tests run.
- [ ] Scripted calls cover each form, each principal (anonymous, each level, each delegate role), the step-up, failed verification, each refusal, each handoff (a person on request from each place a caller can be: the start, the keypad menu, inside a form, while verifying, at the code prompt, at each summary), keypad entry and each informational answer (spoken, and its key if it has one).
- [ ] `identity.yaml` matches the paragraph: who must verify, with what, the code only where a level 2 action needs it, the tries.
- [ ] The policy read back (`policy.matrix`, the policy card `POLICY.md` and the app map `APP-MAP.md`) matches "Who may do what" above, cell by cell, and the card matches the paragraph line by line; each is tested (`expectPolicyMatrix`, `expectPolicyCard`, `expectAppMap`).
- [ ] Every tool lists its `params`, every param has a row under "What is recorded", and the card's "What is recorded" table says what the row does; nothing a person said in their own words is kept without a reason written there.
- [ ] No tool decides who may do what; every line a caller hears is in `prompts.yaml`, or is a passage a person approved.
- [ ] If there is a knowledge base: every knowledge row has a topic with keywords and example questions, a source section and a passage; each passage was approved by a person (you approved none, and wrote no `approval`, hash or approvals line) or is listed above as awaiting one; paraphrases (eight or more a topic) and the recall test are written; no model key is in any file.
- [ ] Nothing private or real: invented names and streets, 555 numbers, `example.com` addresses.
- [ ] `pnpm check` ok (with a knowledge base awaiting approval, its approval findings are the only ones left, and the worksheet says so); `pnpm verify` green; every app's regression (this one's, the clinic's and every other under apps/) and the testkit's say `no changes`.
- [ ] The baseline was made once with `regress --update`, read entry by entry, and every later edit is under "Baseline edits".
- [ ] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [ ] `README.md` says what the app does and how it is built, and keeps the scaffold's recording steps; `CLAUDE.md` still matches the folder.
- [ ] The gaps above are written up.

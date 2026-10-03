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

| Tool | Reads | Writes | Params (exactly what it sends) | Level | Rules, in order |
|---|---|---|---|---|---|
| `<tool>` | <records> | <nothing, or what> | `<a>, <b>` | <0, 1, 2> | `identity`, ... |

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

Every hand edit to `fixtures/expected/*.json` after the first `regress --update`: the entry, the field, and why the new value is right.

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| | | | |

## Final checklist

- [ ] Every sentence of the paragraph is a row above, and every row is built.
- [ ] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [ ] Every slot has at least five answers in the corpus, every summary at least four.
- [ ] Every action has a policy entry and a test that asks the gate about each kind of principal and each bound; every custom rule has a test of its own.
- [ ] Scripted calls cover each form, each principal (anonymous, each level, each delegate role), the step-up, failed verification, each refusal, each handoff, keypad entry and each informational answer.
- [ ] `identity.yaml` matches the paragraph: who must verify, with what, the code only where a level 2 action needs it, the tries.
- [ ] The policy read back (the card, or `policy.yaml` with the gate-event golden) matches "Who may do what" above, cell by cell.
- [ ] No tool decides who may do what; every line a caller hears is in `prompts.yaml`.
- [ ] Nothing private or real: invented names and streets, 555 numbers, `example.com` addresses.
- [ ] `pnpm check` ok; `pnpm verify` green; this app's `regress` says `no changes`; the clinic's and the testkit's regressions say `no changes`.
- [ ] The baseline was made once with `regress --update`, read entry by entry, and every later edit is under "Baseline edits".
- [ ] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [ ] `README.md` says what the app does and how it is built, and keeps the scaffold's recording steps; `CLAUDE.md` still matches the folder.
- [ ] The gaps above are written up.

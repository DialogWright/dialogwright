# Policy card: Example Callbacks

*Generated from `policy.yaml` and `identity.yaml` by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*

| File | Config hash |
| --- | --- |
| `policy.yaml` | `7f952fa6bf0ba9e0afd6ea4bf5f3b91590ece16b2b44fc371d8d84e29b591321` |
| `identity.yaml` | none: this app verifies no one |

The hash is a SHA-256 of the file's content (comments and layout do not change it); every call's audit record carries the hashes it ran under.

## Defaults

- Anything not listed under Actions is refused.
- The rules of an action run in the order shown, and the first one that fails decides.
- Identifiers in decision lines appear by their last four characters (`...1234`), never in full; a value recorded hidden, by length or never shows not even those.
- In traces and the audit a caller's values are recorded as they are said, except: phone by its last four.

## Identity

This app verifies no one. Every caller stays anonymous (level 0), so every action is at level 0.

```mermaid
flowchart LR
  L0("Level 0<br/>anonymous<br/>no one is verified")
```

## Who is served and who acts for them

No one is verified, so the app has no subjects and no one acts for them.

## What is recorded

What the record of a call keeps of each value the action is sent, where the action's call is recorded: the gate's decision, the trace, the console and the audit. A value is recorded as its slot says or as policy.yaml's `audit` declares, and `check` refuses one that neither covers. Where a rule's line, the action's summary, its own audit rows, the side effects it queues (as recorded) or a downstream service's row for the answer repeat a value that is hidden, shortened or never recorded, it is masked there too.

| Action | Value | Recorded |
| --- | --- | --- |
| Set up a callback (`requestCallback`) | name (`caller`) | by its length only |
| Set up a callback (`requestCallback`) | phone (`phone`) | by its last four characters |
| Set up a callback (`requestCallback`) | about (`reason`) | as it is |

The slots these values come from are recorded by their own redact setting (slots.yaml) wherever a call's slots are: the trace's slots, the variables of the lines that say them (a read-back among them), a handoff's data and the console. Where that is not what the table says:

- Kept whole there, since the slot has no redact setting (policy.yaml's `audit` masks the value only in the action's call and the side effects it queues): name (`caller`). A redact setting on the slot masks it there too.

## Actions

One row per action the agent may take. Anything else is refused.

| Action | Level | The gate checks, in order |
| --- | --- | --- |
| **Set up a callback**<br/>`requestCallback` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: name, phone and about |

### Actions by level, with their rules and what each role gets

```mermaid
flowchart LR
  subgraph lv0["Level 0: anonymous"]
    a_requestCallback["Set up a callback<br/>identity · confirmed"]
  end
```

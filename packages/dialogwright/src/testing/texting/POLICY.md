# Policy card: Example Requests

*Generated from `policy.yaml` and `identity.yaml` by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*

| File | Config hash |
| --- | --- |
| `policy.yaml` | `35f23593bc5e108214eafbbcc048595947ec6c6e3a1aa31862ff06c6e4abea00` |
| `identity.yaml` | none: this app verifies no one |

The hash is a SHA-256 of the file's content (comments and layout do not change it); every call's audit record carries the hashes it ran under.

## Defaults

- Anything not listed under Actions is refused.
- The rules of an action run in the order shown, and the first one that fails decides.
- Identifiers in decision lines appear by their last four characters (`...1234`), never in full; a value recorded hidden, by length or never shows not even those.
- In traces and the audit a caller's values are recorded as they are said, except: mobile number by its last four.

## Identity

This app verifies no one. Every caller stays anonymous (level 0), so every action is at level 0.

```mermaid
flowchart LR
  L0("Level 0<br/>anonymous<br/>no one is verified")
```

## Who is served and who acts for them

No one is verified, so the app has no subjects and no one acts for them.

## What is recorded

What the record of a call keeps of each value the action is sent: the gate's decision, the trace, the console and the audit. A value is recorded as its slot says or as policy.yaml's `audit` declares, and `check` refuses one that neither covers. Where a rule's line, the action's summary, its own audit rows, the side effects it queues (as recorded) or a downstream service's row for the answer repeat a value that is hidden, shortened or never recorded, it is masked there too.

| Action | Value | Recorded |
| --- | --- | --- |
| Look up the line type of the number calling (`findCallerByPhone`) | caller number (`callerNumber`) | by its last four characters |
| Check whether the number calling is a mobile (`lineType`) | caller number (`callerNumber`) | by its last four characters |
| Open a request (`openRequest`) | about (`topic`) | as it is |
| Open a request (`openRequest`) | mobile number (`textTo`) | by its last four characters |
| Text updates about a request (`sendUpdates`) | about (`topic`) | as it is |
| Text updates about a request (`sendUpdates`) | mobile number (`textTo`) | by its last four characters |

## Actions

One row per action the agent may take. Anything else is refused.

| Action | Level | The gate checks, in order |
| --- | --- | --- |
| **Look up the line type of the number calling**<br/>`findCallerByPhone` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. caller number must be the number the caller is calling from: any other is refused (`not-caller-number`), as is any number on a call with no caller's number (`no-caller-number`), and a missing number is refused. Caller ID is a hint, never proof of who is calling |
| **Check whether the number calling is a mobile**<br/>`lineType` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. caller number must be the number the caller is calling from: any other is refused (`not-caller-number`), as is any number on a call with no caller's number (`no-caller-number`), and a missing number is refused. Caller ID is a hint, never proof of who is calling |
| **Open a request**<br/>`openRequest` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: about and mobile number |
| **Text updates about a request**<br/>`sendUpdates` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. mobile number (`textTo`) must be the number the caller is calling from, or a number the caller heard read back at the summary and said yes to: any other is refused (`not-caller-number`, or `no-caller-number` on a call with no number), and a missing number is refused. Caller ID is a hint, never proof of who is calling<br/>3. the caller must confirm exactly these values at the read-back, and nothing else is sent: about and mobile number |

### Actions by level, with their rules and what each role gets

```mermaid
flowchart LR
  subgraph lv0["Level 0: anonymous"]
    a_findCallerByPhone["Look up the line type of the number calling<br/>identity · callerNumber callerNumber"]
    a_lineType["Check whether the number calling is a mobile<br/>identity · callerNumber callerNumber"]
    a_openRequest["Open a request<br/>identity · confirmed"]
    a_sendUpdates["Text updates about a request<br/>identity · callerNumber textTo · confirmed"]
  end
```

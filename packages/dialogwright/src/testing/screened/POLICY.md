# Policy card: Example Home Visits

*Generated from `policy.yaml` and `identity.yaml` by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*

| File | Config hash |
| --- | --- |
| `policy.yaml` | `e07efd46e6d03f8978d524aeceaac98c1ab8885fb8ff9c68c43f8f766ac515ba` |
| `identity.yaml` | none: this app verifies no one |

The hash is a SHA-256 of the file's content (comments and layout do not change it); every call's audit record carries the hashes it ran under.

## Defaults

- Anything not listed under Actions is refused.
- The rules of an action run in the order shown, and the first one that fails decides.
- Identifiers in decision lines appear by their last four characters (`...1234`), never in full; a value recorded hidden, by length or never shows not even those.

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
| Send something urgent to the office (`checkUrgency`) | how urgent (`howUrgent`) | as it is |
| Check the caller owns the home (`checkOwner`) | owns or rents (`ownership`) | as it is |
| Check the home is in the area (`checkArea`) | town (`town`) | as it is |
| Book a free visit (`bookVisit`) | problem (`problem`) | as it is |
| Book a free visit (`bookVisit`) | owns or rents (`ownership`) | as it is |
| Book a free visit (`bookVisit`) | town (`town`) | as it is |
| Book a free visit (`bookVisit`) | how urgent (`howUrgent`) | as it is |
| Book a free visit (`bookVisit`) | day (`visitDay`) | as it is |
| Book a free visit (`bookVisit`) | time of day (`timeOfDay`) | as it is |

## Actions

One row per action the agent may take. Anything else is refused.

| Action | Level | The gate checks, in order |
| --- | --- | --- |
| **Send something urgent to the office**<br/>`checkUrgency`<br/>a form's check: the gate answers, nothing runs | 0 anonymous | 1. any caller may ask, verified or not<br/>2. how urgent must not be right away (`urgent`): that goes to a person (`urgent`), and a missing value is refused |
| **Check the caller owns the home**<br/>`checkOwner`<br/>a form's check: the gate answers, nothing runs | 0 anonymous | 1. any caller may ask, verified or not<br/>2. owns or rents (`ownership`) must be you own it (`own`): anything else is refused (`not-owner`), and a missing value is refused |
| **Check the home is in the area**<br/>`checkArea`<br/>a form's check: the gate answers, nothing runs | 0 anonymous | 1. any caller may ask, verified or not<br/>2. town must be one of Millbrook, Cedar Falls, Ashford or Riverton: any other is refused (`out-of-area`), and a missing value is refused |
| **Book a free visit**<br/>`bookVisit` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. how urgent must not be right away (`urgent`): that goes to a person (`urgent`), and a missing value is refused<br/>3. owns or rents (`ownership`) must be you own it (`own`): anything else is refused (`not-owner`), and a missing value is refused<br/>4. town must be one of Millbrook, Cedar Falls, Ashford or Riverton: any other is refused (`out-of-area`), and a missing value is refused<br/>5. the caller must confirm exactly these values at the read-back, and nothing else is sent: problem, owns or rents, town, how urgent, day and time of day |

### Actions by level, with their rules and what each role gets

```mermaid
flowchart LR
  subgraph lv0["Level 0: anonymous"]
    a_checkUrgency["Send something urgent to the office<br/>identity · noneOf howUrgent"]
    a_checkOwner["Check the caller owns the home<br/>identity · oneOf ownership"]
    a_checkArea["Check the home is in the area<br/>identity · oneOf town"]
    a_bookVisit["Book a free visit<br/>identity · noneOf howUrgent · oneOf ownership · oneOf town · confirmed"]
  end
```

# Policy card: Example Family Practice

*Generated from `policy.yaml` and `identity.yaml` by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*

| File | Config hash |
| --- | --- |
| `policy.yaml` | `cd3dd0f08ee66b15a767b1f376c8ddec45c5b63e012cee5d08e35b74079ba92e` |
| `identity.yaml` | none: this app verifies no one |

The hash is a SHA-256 of the file's content (comments and layout do not change it); every call's audit record carries the hashes it ran under.

## Defaults

- Anything not listed under Actions is refused.
- The rules of an action run in the order shown, and the first one that fails decides.
- Identifiers in decision lines appear by their last four characters (`...1234`), never in full.
- In traces and the audit a caller's values are recorded as they are said, except: date of birth hidden (a year is kept); member ID by its last four.

## Identity

This app verifies no one. Every caller stays anonymous (level 0), so every action is at level 0.

```mermaid
flowchart LR
  L0("Level 0<br/>anonymous<br/>no one is verified")
```

## Who is served and who acts for them

No one is verified, so the app has no subjects and no one acts for them.

## Actions

One row per action the agent may take. Anything else is refused.

| Action | Level | The gate checks, in order |
| --- | --- | --- |
| **Find an appointment**<br/>`findAppointment` | 0 anonymous | 1. any caller may ask, verified or not |
| **List open times**<br/>`listOpenings` | 0 anonymous | 1. any caller may ask, verified or not |
| **Book an appointment**<br/>`bookAppointment` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: name, date of birth, provider, day and time |
| **Move an appointment**<br/>`moveAppointment` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: name, date of birth, provider, day and time |
| **Cancel an appointment**<br/>`cancelAppointment` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: name, date of birth, provider, day and time |

### Actions by level, with their rules and what each role gets

```mermaid
flowchart LR
  subgraph lv0["Level 0: anonymous"]
    a_findAppointment["Find an appointment<br/>identity"]
    a_listOpenings["List open times<br/>identity"]
    a_bookAppointment["Book an appointment<br/>identity · confirmed"]
    a_moveAppointment["Move an appointment<br/>identity · confirmed"]
    a_cancelAppointment["Cancel an appointment<br/>identity · confirmed"]
  end
```

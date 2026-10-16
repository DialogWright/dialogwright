# App map: Harbor Mutual

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `claim_status` | form | check on a claim | opens the form, which asks for claim |
| `coverage` | form | check coverage | opens the form, which asks for member ID (of broker only), coverage topic |
| `report_claim` | form | report a new claim | opens the form, which asks for kind of loss, date of loss, what happened |
| `capabilities` | informational | hear what I can do | says "I'm an automated assistant, but you can talk to me naturally. I can tell you the status..." and goes back to the question |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_claim_status["check on a claim<br/>form claim_status"]
  menu -->|"press 1, from the greeting"| i_claim_status
  i_coverage["check coverage<br/>form coverage"]
  menu -->|"press 2, from the greeting"| i_coverage
  i_report_claim["report a new claim<br/>form report_claim"]
  menu -->|"press 3, from the greeting"| i_report_claim
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0, from the greeting"| i_agent
  ask("Asked in words, outside the menu")
  i_capabilities["hear what I can do<br/>informational"]
  p_capabilities[/"line capabilities"/]
  i_capabilities --> p_capabilities
  ask --> i_capabilities
```

## Claim status

Intent `claim_status` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>claim_status<br/>check on a claim")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_claimSelect["claimSelect<br/>type: record"]
  end
  intent --> slots
  a_listClaims["List the member's claims<br/>level 2: confirmed by code"]
  slots -->|"calls"| a_listClaims
  r_listClaims(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_listClaims --> r_listClaims
  a_getClaim["Read a claim<br/>level 2: confirmed by code"]
  slots -->|"calls"| a_getClaim
  r_getClaim(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getClaim --> r_getClaim
```

## Coverage question

Intent `coverage` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>coverage<br/>check coverage")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_clientId["clientId<br/>type: digits<br/>asked of broker only"]
    s_coverageTopic["coverageTopic<br/>type: topic"]
  end
  intent --> slots
  c_isClient{{"Check<br/>check that a member is a client of the caller's office<br/>level 0: anonymous<br/>scope: say coverage_not_client, anything-else"}}
  s_clientId -.->|"checked"| c_isClient
  r_isClient(["Rules, in order<br/>1. identity<br/>2. scope"])
  c_isClient --> r_isClient
  a_getCoverage["Read the member's coverage<br/>level 1: verified"]
  slots -->|"calls"| a_getCoverage
  r_getCoverage(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getCoverage --> r_getCoverage
  a_searchPolicy["Answer from the member's plan<br/>level 1: verified"]
  slots -->|"calls"| a_searchPolicy
  r_searchPolicy(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_searchPolicy --> r_searchPolicy
  a_getUsage["Read the member's use of a benefit<br/>level 1: verified"]
  slots -->|"calls"| a_getUsage
  r_getUsage(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getUsage --> r_getUsage
```

## Report a claim

Intent `report_claim` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>report_claim<br/>report a new claim")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_lossType["lossType<br/>type: choice"]
    s_lossDate["lossDate<br/>type: date"]
    s_lossDescription["lossDescription<br/>type: text"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_report"/]
  slots --> summary
  a_getCoverage["Read the member's coverage<br/>level 1: verified"]
  summary -->|"calls"| a_getCoverage
  r_getCoverage(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getCoverage --> r_getCoverage
  a_createClaim["File a claim<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_createClaim
  r_createClaim(["Rules, in order<br/>1. identity<br/>2. role<br/>3. scope<br/>4. confirmed<br/>5. dateInRange lossDate"])
  a_createClaim --> r_createClaim
  a_triageClaim["Hand a filed claim to the claims intake service<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_triageClaim
  r_triageClaim(["Rules, in order<br/>1. identity<br/>2. scope<br/>3. fields"])
  a_triageClaim --> r_triageClaim
  a_sendUploadLink["Text a link to upload documents<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_sendUploadLink
  r_sendUploadLink(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_sendUploadLink --> r_sendUploadLink
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

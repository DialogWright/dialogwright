# App map: Example Service Line

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `report_problem` | form | report a problem | opens the form, which asks for problem, danger |
| `check_status` | form | check on a request | opens the form, which asks for nothing |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_report_problem["report a problem<br/>form report_problem"]
  menu -->|"press 1"| i_report_problem
  i_check_status["check on a request<br/>form check_status"]
  menu -->|"press 2"| i_check_status
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Report a problem

Intent `report_problem` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>report_problem<br/>report a problem")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_problem["problem<br/>type: choice"]
    s_severity["severity<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_report_problem"/]
  slots --> summary
  a_reportProblem["Report a problem<br/>level 0: anonymous"]
  summary -->|"calls"| a_reportProblem
  r_reportProblem(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_reportProblem --> r_reportProblem
```

## Check on a request

Intent `check_status` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>check_status<br/>check on a request")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    none["no slots"]
  end
  intent --> slots
  a_findAccount["Look up the account<br/>level 1: verified"]
  slots -->|"calls"| a_findAccount
  r_findAccount(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_findAccount --> r_findAccount
  a_readStatus["Read the status of the latest request on the account<br/>level 1: verified"]
  slots -->|"calls"| a_readStatus
  r_readStatus(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_readStatus --> r_readStatus
```

## Payment plan

After a route (afterIdentity): the internal form `payment_plan`, its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  after("After<br/>a route, afterIdentity")
  after --> slots
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    none["no slots"]
  end
  summary[/"Summary read back for a yes<br/>confirm_payment_plan"/]
  slots --> summary
  a_setUpPlan["Set up a payment plan<br/>level 1: verified"]
  summary -->|"calls"| a_setUpPlan
  r_setUpPlan(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_setUpPlan --> r_setUpPlan
```

## Routes

What the call does at its start, once the caller is verified, and after a form: the rules at each point are tried in order, the first whose conditions all hold is taken, and the else last. What the caller says still decides every other turn.

The start hook runs first, as every call starts, and calls `lookupNotices`.

### At the start of a call

```mermaid
flowchart TD
  p_start("The call starts<br/>after the start hook, before the greeting")
  w_start_0{"the hours are closed"}
  p_start --> w_start_0
  o_start_0[["say closed_now, end"]]
  w_start_0 -->|"yes"| o_start_0
  w_start_1{"vip holds (in code)"}
  w_start_0 -->|"no"| w_start_1
  o_start_1[["handoff vip"]]
  w_start_1 -->|"yes"| o_start_1
  w_start_2{"fact outage is true"}
  w_start_1 -->|"no"| w_start_2
  o_start_2[["say outage_notice, continue: the greeting"]]
  w_start_2 -->|"yes"| o_start_2
  w_start_3{"the number called is SPANISH_LINE"}
  w_start_2 -->|"no"| w_start_3
  o_start_3[["locale es, then go on"]]
  w_start_3 -->|"yes"| o_start_3
  o_start_4[["else<br/>continue: the greeting"]]
  w_start_3 -->|"no"| o_start_4
```

### Once the caller is verified

```mermaid
flowchart TD
  p_identity("The caller is verified<br/>once, after the identity step's line")
  w_identity_0{"fact account.pastDue is true"}
  p_identity --> w_identity_0
  o_identity_0[["say past_due_first, form payment_plan"]]
  w_identity_0 -->|"yes"| o_identity_0
  o_identity_1[["else<br/>continue: the form that asked for it"]]
  w_identity_0 -->|"no"| o_identity_1
```

### After Report a problem

```mermaid
flowchart TD
  p_after_report_problem("report_problem completes<br/>before its next")
  w_after_report_problem_0{"slot severity is danger"}
  p_after_report_problem --> w_after_report_problem_0
  o_after_report_problem_0[["handoff emergency"]]
  w_after_report_problem_0 -->|"yes"| o_after_report_problem_0
  o_after_report_problem_1[["else<br/>continue: its next, else anything else?"]]
  w_after_report_problem_0 -->|"no"| o_after_report_problem_1
```

## Where a handoff goes

The transfer targets, tried in order: the first whose conditions all hold is taken, else the default. Each dials the number or SIP address in its environment variable; the headers go only to a SIP address, the chat data only on a web chat.

```mermaid
flowchart TD
  handoff("A handoff<br/>its reason, the form, the call data")
  w_0{"the billing hours are closed"}
  handoff --> w_0
  t_0[["AFTER_HOURS_DESK"]]
  w_0 -->|"yes"| t_0
  w_1{"the reason is vip"}
  w_0 -->|"no"| w_1
  t_1[["VIP_DESK"]]
  w_1 -->|"yes"| t_1
  fallback[["default MAIN_LINE"]]
  w_1 -->|"no"| fallback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

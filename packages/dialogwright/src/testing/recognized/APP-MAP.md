# App map: Example Account Line

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `report_problem` | form | report a problem | opens the form, which asks for problem |
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

## Dangling references

- no form reaches the action `findAccountByPhone`, and the identity flow does not call it

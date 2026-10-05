# App map: Example Power & Light

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `report_outage` | form | report an outage | opens the form, which asks for address, what they see |
| `check_balance` | form | check a balance | opens the form, which asks for account |
| `set_up_plan` | form | set up a payment arrangement | opens the form, which asks for installments, first payment |
| `ask_question` | form | answer a question | opens the form, which asks for question topic |
| `outage_map` | informational | hear where the outage map is | says the passage outage-map from the knowledge base and goes back to the question |
| `office_hours` | informational | hear the office hours | says the passage office-hours from the knowledge base and goes back to the question |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_report_outage["report an outage<br/>form report_outage"]
  menu -->|"press 1"| i_report_outage
  i_check_balance["check a balance<br/>form check_balance"]
  menu -->|"press 2"| i_check_balance
  i_set_up_plan["set up a payment arrangement<br/>form set_up_plan"]
  menu -->|"press 3"| i_set_up_plan
  i_outage_map["hear where the outage map is<br/>informational"]
  p_outage_map[/"passage outage-map"/]
  i_outage_map --> p_outage_map
  menu -->|"press 4"| i_outage_map
  i_office_hours["hear the office hours<br/>informational"]
  p_office_hours[/"passage office-hours"/]
  i_office_hours --> p_office_hours
  menu -->|"press 5"| i_office_hours
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Report an outage

Intent `report_outage` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>report_outage<br/>report an outage")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_place["place<br/>type: text"]
    s_symptom["symptom<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_report_outage"/]
  slots --> summary
  a_reportOutage["File an outage report<br/>level 0: anonymous"]
  summary -->|"calls"| a_reportOutage
  r_reportOutage(["Rules, in order<br/>1. identity<br/>2. role<br/>3. confirmed"])
  a_reportOutage --> r_reportOutage
```

## Check a balance

Intent `check_balance` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>check_balance<br/>check a balance")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_account["account<br/>type: digits"]
  end
  intent --> slots
  a_findAccount["Look up the account<br/>level 1: verified"]
  slots -->|"calls"| a_findAccount
  r_findAccount(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_findAccount --> r_findAccount
  a_readBalance["Read the balance and due date<br/>level 1: verified"]
  slots -->|"calls"| a_readBalance
  r_readBalance(["Rules, in order<br/>1. identity<br/>2. role<br/>3. scope"])
  a_readBalance --> r_readBalance
```

## Set up a payment arrangement

Intent `set_up_plan` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>set_up_plan<br/>set up a payment arrangement")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_count["count<br/>type: choice"]
    s_firstDate["firstDate<br/>type: date"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_set_up_plan"/]
  slots --> summary
  a_findAccount["Look up the account<br/>level 1: verified"]
  summary -->|"calls"| a_findAccount
  r_findAccount(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_findAccount --> r_findAccount
  a_setUpPlan["Set up a payment arrangement<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_setUpPlan
  r_setUpPlan(["Rules, in order<br/>1. identity<br/>2. role<br/>3. scope<br/>4. confirmed<br/>5. limit total<br/>6. dateInRange firstDate"])
  a_setUpPlan --> r_setUpPlan
```

## Answer a question

Intent `ask_question` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>ask_question<br/>answer a question")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_subject["subject<br/>type: topic"]
  end
  intent --> slots
  a_answerQuestion["Answer a question from the knowledge base<br/>level 0: anonymous"]
  slots -->|"calls"| a_answerQuestion
  r_answerQuestion(["Rules, in order<br/>1. identity"])
  a_answerQuestion --> r_answerQuestion
  a_getOutageHistory["Read the last outage on the account<br/>level 1: verified"]
  slots -->|"calls"| a_getOutageHistory
  r_getOutageHistory(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getOutageHistory --> r_getOutageHistory
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

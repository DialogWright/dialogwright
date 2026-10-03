# App map: Example Family Practice

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `schedule_new` | form | schedule a new appointment | opens the form, which asks for name, date of birth, provider, day |
| `reschedule` | form | reschedule your appointment | opens the form, which asks for name, date of birth, provider, day |
| `cancel` | form | cancel your appointment | opens the form, which asks for name, date of birth, provider |
| `confirm_appointment` | form | confirm your appointment | opens the form, which asks for name, date of birth, provider |
| `billing` | form | talk to billing | opens the form, which asks for member ID |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `capabilities` | informational | hear what I can do | says "I can help you schedule, reschedule, cancel, or confirm an appointment, or connect you ..." and goes back to the question |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_schedule_new["schedule a new appointment<br/>form schedule_new"]
  menu -->|"press 1"| i_schedule_new
  i_reschedule["reschedule your appointment<br/>form reschedule"]
  menu -->|"press 2"| i_reschedule
  i_cancel["cancel your appointment<br/>form cancel"]
  menu -->|"press 3"| i_cancel
  i_confirm_appointment["confirm your appointment<br/>form confirm_appointment"]
  menu -->|"press 4"| i_confirm_appointment
  i_billing["talk to billing<br/>form billing"]
  menu -->|"press 5"| i_billing
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
  ask("Asked in words, outside the menu")
  i_capabilities["hear what I can do<br/>informational"]
  p_capabilities[/"line capabilities"/]
  i_capabilities --> p_capabilities
  ask --> i_capabilities
```

## Schedule an appointment

Intent `schedule_new` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>schedule_new<br/>schedule a new appointment")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_name["name<br/>type: name"]
    s_dob["dob<br/>type: birthdate"]
    s_provider["provider<br/>type: choice"]
    s_date["date<br/>type: date"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_schedule"/]
  slots --> summary
  a_listOpenings["List open times<br/>level 0: anonymous"]
  summary -->|"calls"| a_listOpenings
  r_listOpenings(["Rules, in order<br/>1. identity"])
  a_listOpenings --> r_listOpenings
  a_bookAppointment["Book an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_bookAppointment
  r_bookAppointment(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_bookAppointment --> r_bookAppointment
```

## Reschedule an appointment

Intent `reschedule` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>reschedule<br/>reschedule your appointment")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_name["name<br/>type: name"]
    s_dob["dob<br/>type: birthdate"]
    s_provider["provider<br/>type: choice"]
    s_date["date<br/>type: date"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_reschedule"/]
  slots --> summary
  a_findAppointment["Find an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_findAppointment
  r_findAppointment(["Rules, in order<br/>1. identity"])
  a_findAppointment --> r_findAppointment
  a_listOpenings["List open times<br/>level 0: anonymous"]
  summary -->|"calls"| a_listOpenings
  r_listOpenings(["Rules, in order<br/>1. identity"])
  a_listOpenings --> r_listOpenings
  a_moveAppointment["Move an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_moveAppointment
  r_moveAppointment(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_moveAppointment --> r_moveAppointment
```

## Cancel an appointment

Intent `cancel` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>cancel<br/>cancel your appointment")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_name["name<br/>type: name"]
    s_dob["dob<br/>type: birthdate"]
    s_provider["provider<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_cancel"/]
  slots --> summary
  a_findAppointment["Find an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_findAppointment
  r_findAppointment(["Rules, in order<br/>1. identity"])
  a_findAppointment --> r_findAppointment
  a_cancelAppointment["Cancel an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_cancelAppointment
  r_cancelAppointment(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_cancelAppointment --> r_cancelAppointment
```

## Confirm an appointment

Intent `confirm_appointment` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>confirm_appointment<br/>confirm your appointment")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_name["name<br/>type: name"]
    s_dob["dob<br/>type: birthdate"]
    s_provider["provider<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_appointment_details"/]
  slots --> summary
  a_findAppointment["Find an appointment<br/>level 0: anonymous"]
  summary -->|"calls"| a_findAppointment
  r_findAppointment(["Rules, in order<br/>1. identity"])
  a_findAppointment --> r_findAppointment
```

## Billing

Intent `billing` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>billing<br/>talk to billing")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_memberId["memberId<br/>type: digits"]
  end
  intent --> slots
  done["Completes without calling an action"]
  slots --> done
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

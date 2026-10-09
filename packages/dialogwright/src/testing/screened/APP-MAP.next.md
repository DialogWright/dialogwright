# App map: Example Home Visits

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `screen_home` | form | book a free visit | opens the form, which asks for problem, owns or rents, town, then goes on to Book a visit (book_visit) |
| `urgent` | form | get help right away | opens the form, which asks for nothing |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_screen_home["book a free visit<br/>form screen_home"]
  menu -->|"press 1"| i_screen_home
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Book a free visit

Intent `screen_home` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>screen_home<br/>book a free visit")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_problem["problem<br/>type: choice"]
    s_ownership["ownership<br/>type: choice"]
    s_town["town<br/>type: choice"]
  end
  intent --> slots
  c_checkOwner{{"Check<br/>check the caller owns the home<br/>level 0: anonymous<br/>not-owner: say decline_renter, end"}}
  s_ownership -.->|"checked"| c_checkOwner
  r_checkOwner(["Rules, in order<br/>1. identity<br/>2. oneOf ownership"])
  c_checkOwner --> r_checkOwner
  c_checkArea{{"Check<br/>check the home is in the area<br/>level 0: anonymous<br/>out-of-area: say decline_out_of_area, end"}}
  s_town -.->|"checked"| c_checkArea
  r_checkArea(["Rules, in order<br/>1. identity<br/>2. oneOf town"])
  c_checkArea --> r_checkArea
  passed[/"Said once every check has passed<br/>visit_qualifies"/]
  c_checkOwner -.->|"passes"| passed
  c_checkArea -.->|"passes"| passed
  done["Completes without calling an action"]
  slots --> done
  next[["Then, at once<br/>book_visit: Book a visit"]]
  done -->|"completes"| next
```

## Book a visit

After `screen_home`: the internal form `book_visit`, its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  after("After<br/>screen_home: book a free visit")
  after --> slots
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_problem["problem<br/>type: choice"]
    s_ownership["ownership<br/>type: choice"]
    s_town["town<br/>type: choice"]
    s_howUrgent["howUrgent<br/>type: choice"]
    s_visitDay["visitDay<br/>type: choice"]
    s_timeOfDay["timeOfDay<br/>type: choice"]
  end
  summary[/"Summary read back for a yes<br/>confirm_book_visit"/]
  slots --> summary
  c_checkUrgency{{"Check<br/>send something urgent to the office<br/>level 0: anonymous<br/>urgent: handoff urgent"}}
  s_howUrgent -.->|"checked"| c_checkUrgency
  r_checkUrgency(["Rules, in order<br/>1. identity<br/>2. noneOf howUrgent"])
  c_checkUrgency --> r_checkUrgency
  c_checkOwner{{"Check<br/>check the caller owns the home<br/>level 0: anonymous<br/>not-owner: say decline_renter, end"}}
  s_ownership -.->|"checked"| c_checkOwner
  r_checkOwner(["Rules, in order<br/>1. identity<br/>2. oneOf ownership"])
  c_checkOwner --> r_checkOwner
  a_bookVisit["Book a free visit<br/>level 0: anonymous"]
  summary -->|"calls"| a_bookVisit
  r_bookVisit(["Rules, in order<br/>1. identity<br/>2. noneOf howUrgent<br/>3. oneOf ownership<br/>4. oneOf town<br/>5. confirmed"])
  a_bookVisit --> r_bookVisit
```

## Something urgent

Intent `urgent` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>urgent<br/>get help right away")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    none["no slots"]
  end
  intent --> slots
  done["Completes without calling an action"]
  slots --> done
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

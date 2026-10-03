# App map: {{display}}

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `book_service` | form | book a service | opens the form, which asks for service |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_book_service["book a service<br/>form book_service"]
  menu -->|"press 1"| i_book_service
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Book a service

Intent `book_service` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>book_service<br/>book a service")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_service["service<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_book_service"/]
  slots --> summary
  a_bookService["Book a service<br/>level 0: anonymous"]
  summary -->|"calls"| a_bookService
  r_bookService(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_bookService --> r_bookService
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

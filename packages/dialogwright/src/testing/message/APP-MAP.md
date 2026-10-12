# App map: Example Office

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `take_message` | form | take a message | opens the form, which asks for for, from, phone, message |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_take_message["take a message<br/>form take_message"]
  menu -->|"press 1"| i_take_message
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Take a message

Intent `take_message` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>take_message<br/>take a message")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_recipient["recipient<br/>type: choice"]
    s_caller["caller<br/>type: name"]
    s_phone["phone<br/>type: digits"]
    s_message["message<br/>type: text"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_take_message"/]
  slots --> summary
  a_leaveMessage["Pass a message on<br/>level 0: anonymous"]
  summary -->|"calls"| a_leaveMessage
  r_leaveMessage(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_leaveMessage --> r_leaveMessage
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

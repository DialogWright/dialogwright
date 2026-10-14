# App map: Example Front Desk

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `take_message` | form | leave a message | opens the form, which asks for recipient, caller, phone, message |
| `urgent` | form | reach the studio's main line | opens the form, which asks for nothing |
| `studio_hours` | informational | hear the studio's hours | says "The studio is open weekdays, nine to five." and goes back to the question |
| `studio_address` | informational | hear the studio's address | says "The studio is at 418 Juniper Lane, Suite 2, in Example City." and goes back to the question |
| `whereabouts` | informational | ask where someone is | says "I'm not able to say where anyone is or when they're in, but I'm happy to take a message..." and goes back to the question |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_take_message["leave a message<br/>form take_message"]
  menu -->|"press 1"| i_take_message
  i_studio_hours["hear the studio's hours<br/>informational"]
  p_studio_hours[/"line studio_hours"/]
  i_studio_hours --> p_studio_hours
  menu -->|"press 2"| i_studio_hours
  i_studio_address["hear the studio's address<br/>informational"]
  p_studio_address[/"line studio_address"/]
  i_studio_address --> p_studio_address
  menu -->|"press 3"| i_studio_address
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
  ask("Asked in words, outside the menu")
  i_whereabouts["ask where someone is<br/>informational"]
  p_whereabouts[/"line no_whereabouts"/]
  i_whereabouts --> p_whereabouts
  ask --> i_whereabouts
```

## Take a message

Intent `take_message` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>take_message<br/>leave a message")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_recipient["recipient<br/>type: choice"]
    s_caller["caller<br/>type: name"]
    s_phone["phone<br/>type: digits"]
    s_message["message<br/>type: text"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_take_message"/]
  slots --> summary
  a_leaveMessage["Deliver a message to the studio's inbox<br/>level 0: anonymous"]
  summary -->|"calls"| a_leaveMessage
  r_leaveMessage(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_leaveMessage --> r_leaveMessage
```

## Urgent, to the main line

Intent `urgent` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>urgent<br/>reach the studio's main line")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    none["no slots"]
  end
  intent --> slots
  done["Completes without calling an action<br/>its complete hook decides what follows, in code: a line, the end or a handoff"]
  slots --> done
```

## Where a handoff goes

The transfer targets, tried in order: the first whose conditions all hold is taken, else the default. Each dials the number or SIP address in its environment variable; the headers go only to a SIP address, the chat data only on a web chat.

```mermaid
flowchart TD
  handoff("A handoff<br/>its reason, the form, the call data")
  fallback[["default STUDIO_MAIN_LINE"]]
  handoff --> fallback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

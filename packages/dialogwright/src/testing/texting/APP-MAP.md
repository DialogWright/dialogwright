# App map: Example Requests

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `open_request` | form | open a request | opens the form, which asks for about, mobile number |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_open_request["open a request<br/>form open_request"]
  menu -->|"press 1"| i_open_request
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Open a request

Intent `open_request` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>open_request<br/>open a request")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_topic["topic<br/>type: choice"]
    s_textTo["textTo<br/>type: digits"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_open_request"/]
  slots --> summary
  a_openRequest["Open a request<br/>level 0: anonymous"]
  summary -->|"calls"| a_openRequest
  r_openRequest(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_openRequest --> r_openRequest
  a_sendUpdates["Text updates about a request<br/>level 0: anonymous"]
  summary -->|"calls"| a_sendUpdates
  r_sendUpdates(["Rules, in order<br/>1. identity<br/>2. callerNumber textTo<br/>3. confirmed"])
  a_sendUpdates --> r_sendUpdates
  a_lineType["Check whether the number calling is a mobile<br/>level 0: anonymous"]
  summary -->|"calls"| a_lineType
  r_lineType(["Rules, in order<br/>1. identity<br/>2. callerNumber callerNumber"])
  a_lineType --> r_lineType
```

## Dangling references

- no form reaches the action `findCallerByPhone`, and the identity flow does not call it

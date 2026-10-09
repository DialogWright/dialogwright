# App map: Example Callbacks

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `request_callback` | form | set up a callback | opens the form, which asks for name, phone, about |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_request_callback["set up a callback<br/>form request_callback"]
  menu -->|"press 1"| i_request_callback
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
```

## Request a callback

Intent `request_callback` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>request_callback<br/>set up a callback")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_caller["caller<br/>type: name"]
    s_phone["phone<br/>type: digits"]
    s_reason["reason<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_request_callback"/]
  slots --> summary
  a_requestCallback["Set up a callback<br/>level 0: anonymous"]
  summary -->|"calls"| a_requestCallback
  r_requestCallback(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_requestCallback --> r_requestCallback
```

## Where a handoff goes

The transfer targets, tried in order: the first whose conditions all hold is taken, else the default. Each dials the number or SIP address in its environment variable; the headers go only to a SIP address, the chat data only on a web chat.

```mermaid
flowchart TD
  handoff("A handoff<br/>its reason, the form, the call data")
  w_0{"callData queue is priority"}
  handoff --> w_0
  t_0[["PRIORITY_LINE<br/>headers X-Account-Ref, X-Reason, X-Form, X-About, X-Source, X-Queue<br/>chat reason, page"]]
  w_0 -->|"yes"| t_0
  w_1{"the form is request_callback and the reason is max-attempts"}
  w_0 -->|"no"| w_1
  t_1[["CALLBACK_DESK<br/>headers X-Account-Ref, X-Reason, X-Form, X-About, X-Source<br/>chat reason, page"]]
  w_1 -->|"yes"| t_1
  w_2{"the reason is security"}
  w_1 -->|"no"| w_2
  t_2[["SECURITY_DESK<br/>headers X-Account-Ref, X-Reason, X-Form, X-About, X-Source, X-Priority<br/>chat reason, page"]]
  w_2 -->|"yes"| t_2
  fallback[["default MAIN_LINE<br/>headers X-Account-Ref, X-Reason, X-Form, X-About, X-Source<br/>chat reason, page"]]
  w_2 -->|"no"| fallback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

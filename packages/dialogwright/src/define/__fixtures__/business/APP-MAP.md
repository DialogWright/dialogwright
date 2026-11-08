# App map: Example Library

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `request` | form | place a hold | opens the form, which asks for patron name, title, copies, format, day, window, callback number |
| `booking` | form | book the study room | opens the form, which asks for people, day, window |
| `callback` | form | leave a callback note | opens the form, which asks for callback number |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
```

## Place a hold

Intent `request` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>request<br/>place a hold")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_request_patronName["request_patronName<br/>type: name"]
    s_request_title["request_title<br/>type: text"]
    s_request_copies["request_copies<br/>type: choice"]
    s_request_format["request_format<br/>type: choice"]
    s_request_day["request_day<br/>type: date"]
    s_request_window["request_window<br/>type: choice"]
    s_request_callbackNumber["request_callbackNumber<br/>type: digits"]
  end
  x_request_format>"When it runs out<br/>skip"]
  s_request_format -.->|"runs out"| x_request_format
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_request"/]
  slots --> summary
  a_placeHold["Place the hold<br/>level 0: anonymous"]
  summary -->|"calls"| a_placeHold
  r_placeHold(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_placeHold --> r_placeHold
  a_notifyDesk["Tell the desk of the hold<br/>level 0: anonymous"]
  summary -->|"calls"| a_notifyDesk
  r_notifyDesk(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_notifyDesk --> r_notifyDesk
```

## Book the study room

Intent `booking` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>booking<br/>book the study room")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_booking_people["booking_people<br/>type: choice"]
    s_booking_day["booking_day<br/>type: date"]
    s_booking_window["booking_window<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_booking"/]
  slots --> summary
  a_bookRoom["Book the study room<br/>level 1: recognized by the number calling"]
  summary -->|"calls"| a_bookRoom
  r_bookRoom(["Rules, in order<br/>1. identity<br/>2. scope<br/>3. confirmed"])
  a_bookRoom --> r_bookRoom
  a_roomAvailability["Read the study room's free windows near a day<br/>level 1: recognized by the number calling"]
  summary -->|"calls"| a_roomAvailability
  r_roomAvailability(["Rules, in order<br/>1. identity"])
  a_roomAvailability --> r_roomAvailability
```

## Leave a callback note

Intent `callback` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>callback<br/>leave a callback note")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_callback_callbackNumber["callback_callbackNumber<br/>type: digits"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_callback"/]
  slots --> summary
  a_noteCallback["Leave the desk a callback note<br/>level 0: anonymous"]
  summary -->|"calls"| a_noteCallback
  r_noteCallback(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_noteCallback --> r_noteCallback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

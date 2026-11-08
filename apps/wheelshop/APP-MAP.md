# App map: Example Wheel Works

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `request` | form | send Sam a request | opens the form, which asks for caller name, vehicle, wheels, damage, diamond cut, day, window, callback number |
| `booking` | form | book cars in | opens the form, which asks for cars, vehicles, day, window |
| `callback` | form | leave Sam a callback note | opens the form, which asks for callback number |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
```

## Send Sam a request

Intent `request` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>request<br/>send Sam a request")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_request_callerName["request_callerName<br/>type: name"]
    s_request_vehicle["request_vehicle<br/>type: text"]
    s_request_wheels["request_wheels<br/>type: choice"]
    s_request_damage["request_damage<br/>type: text"]
    s_request_diamondCut["request_diamondCut<br/>type: choice"]
    s_request_day["request_day<br/>type: date"]
    s_request_window["request_window<br/>type: choice"]
    s_request_callbackNumber["request_callbackNumber<br/>type: digits"]
  end
  x_request_diamondCut>"When it runs out<br/>skip"]
  s_request_diamondCut -.->|"runs out"| x_request_diamondCut
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_request"/]
  slots --> summary
  a_request["Send Sam the request<br/>level 0: anonymous"]
  summary -->|"calls"| a_request
  r_request(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_request --> r_request
  a_send_photo_link["Text the caller a link to send Sam a photo of the damage<br/>level 0: anonymous"]
  summary -->|"calls"| a_send_photo_link
  r_send_photo_link(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_send_photo_link --> r_send_photo_link
  a_notify_owner_request["Text Sam a summary of the request<br/>level 0: anonymous"]
  summary -->|"calls"| a_notify_owner_request
  r_notify_owner_request(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_notify_owner_request --> r_notify_owner_request
  a_availability["Read the free drop-off windows on a day<br/>level 0: anonymous"]
  summary -->|"calls"| a_availability
  r_availability(["Rules, in order<br/>1. identity"])
  a_availability --> r_availability
```

## Book cars in

Intent `booking` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>booking<br/>book cars in")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_booking_cars["booking_cars<br/>type: choice"]
    s_booking_vehicles["booking_vehicles<br/>type: text"]
    s_booking_day["booking_day<br/>type: date"]
    s_booking_window["booking_window<br/>type: choice"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_booking"/]
  slots --> summary
  a_book["Book the cars into the drop-off window<br/>level 1: recognized by the number calling"]
  summary -->|"calls"| a_book
  r_book(["Rules, in order<br/>1. identity<br/>2. scope<br/>3. confirmed"])
  a_book --> r_book
  a_notify_owner_booking["Text Sam a summary of the booking<br/>level 1: recognized by the number calling"]
  summary -->|"calls"| a_notify_owner_booking
  r_notify_owner_booking(["Rules, in order<br/>1. identity<br/>2. scope<br/>3. confirmed"])
  a_notify_owner_booking --> r_notify_owner_booking
  a_availability["Read the free drop-off windows on a day<br/>level 0: anonymous"]
  summary -->|"calls"| a_availability
  r_availability(["Rules, in order<br/>1. identity"])
  a_availability --> r_availability
```

## Leave Sam a callback note

Intent `callback` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>callback<br/>leave Sam a callback note")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_callback_callbackNumber["callback_callbackNumber<br/>type: digits"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>readback_callback"/]
  slots --> summary
  a_callback["Leave Sam a callback note<br/>level 0: anonymous"]
  summary -->|"calls"| a_callback
  r_callback(["Rules, in order<br/>1. identity<br/>2. confirmed"])
  a_callback --> r_callback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

# App map: Example Parcels

*Generated from the app's configuration by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the configuration disagree.*

**This is the structure of the app, not a script for a call.** The dialog is mixed-initiative: a caller may give details in any order, change their mind, answer two questions at once or ask for two things in a row, and the engine follows. The map shows what is connected to what.

## What a caller can ask for

| Intent | Kind | Said as | What happens |
| --- | --- | --- | --- |
| `track_parcel` | form | track a parcel | opens the form, which asks for parcel |
| `delivery_window` | form | book a delivery window | opens the form, which asks for delivery day, time of day |
| `report_missing` | form | report a missing parcel | opens the form, which asks for description, due date |
| `agent` | control | speak with someone | handled by the engine |
| `repeat_prompt` | control | hear that again | handled by the engine |
| `capabilities` | informational | hear what I can do | says "I'm the Example Parcels assistant. I can tell you where a parcel is, check a delivery w..." and goes back to the question |
| `done` | control | finish up | handled by the engine |
| `other` | control | something else | handled by the engine |
| `none` | control | nothing | handled by the engine |

## The keypad menu and the lines that are only said

```mermaid
flowchart LR
  menu("Keypad menu")
  i_track_parcel["track a parcel<br/>form track_parcel"]
  menu -->|"press 1"| i_track_parcel
  i_delivery_window["book a delivery window<br/>form delivery_window"]
  menu -->|"press 2"| i_delivery_window
  i_report_missing["report a missing parcel<br/>form report_missing"]
  menu -->|"press 3"| i_report_missing
  i_agent["speak with someone<br/>control"]
  menu -->|"press 0"| i_agent
  ask("Asked in words, outside the menu")
  i_capabilities["hear what I can do<br/>informational"]
  p_capabilities[/"line capabilities"/]
  i_capabilities --> p_capabilities
  ask --> i_capabilities
```

## Track a parcel

Intent `track_parcel` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>track_parcel<br/>track a parcel")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_parcelSelect["parcelSelect<br/>type: record"]
  end
  intent --> slots
  a_listParcels["List the customer's parcels<br/>level 2: confirmed by code"]
  slots -->|"calls"| a_listParcels
  r_listParcels(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_listParcels --> r_listParcels
  a_getParcel["Read a parcel<br/>level 2: confirmed by code"]
  slots -->|"calls"| a_getParcel
  r_getParcel(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getParcel --> r_getParcel
```

## Delivery window

Intent `delivery_window` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>delivery_window<br/>book a delivery window")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_deliveryDay["deliveryDay<br/>type: date"]
    s_deliveryPart["deliveryPart<br/>type: choice"]
  end
  intent --> slots
  a_getAccount["Read the customer's account<br/>level 1: verified"]
  slots -->|"calls"| a_getAccount
  r_getAccount(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getAccount --> r_getAccount
  a_getWindows["Read the delivery windows<br/>level 1: verified"]
  slots -->|"calls"| a_getWindows
  r_getWindows(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getWindows --> r_getWindows
```

## Report a missing parcel

Intent `report_missing` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>report_missing<br/>report a missing parcel")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_missingNote["missingNote<br/>type: text"]
    s_expectedDate["expectedDate<br/>type: date"]
  end
  intent --> slots
  summary[/"Summary read back for a yes<br/>confirm_report"/]
  slots --> summary
  a_getAccount["Read the customer's account<br/>level 1: verified"]
  summary -->|"calls"| a_getAccount
  r_getAccount(["Rules, in order<br/>1. identity<br/>2. scope"])
  a_getAccount --> r_getAccount
  a_createReport["Report a missing parcel<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_createReport
  r_createReport(["Rules, in order<br/>1. identity<br/>2. role<br/>3. scope<br/>4. confirmed<br/>5. custom R8"])
  a_createReport --> r_createReport
  a_notifyDepot["Tell the depot about a report<br/>level 2: confirmed by code"]
  summary -->|"calls"| a_notifyDepot
  r_notifyDepot(["Rules, in order<br/>1. identity<br/>2. scope<br/>3. fields"])
  a_notifyDepot --> r_notifyDepot
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

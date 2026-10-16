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
| `whereabouts` | form | find out whether someone's in | opens the form, which asks for recipient |
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

## Is someone in

Intent `whereabouts` to its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  intent("Intent<br/>whereabouts<br/>find out whether someone's in")
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_recipient["recipient<br/>type: choice"]
  end
  intent --> slots
  a_personStatus["Read whether Riley, Sam or Jordan is in, from the studio's calendar<br/>level 0: anonymous"]
  slots -->|"calls"| a_personStatus
  r_personStatus(["Rules, in order<br/>1. identity<br/>2. oneOf person"])
  a_personStatus --> r_personStatus
```

## Put through or a message

After a route (after whereabouts): the internal form `reach_person`, its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  after("After<br/>a route, after whereabouts")
  after --> slots
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_recipient["recipient<br/>type: choice"]
    s_reachHow["reachHow<br/>type: choice"]
  end
  done["Completes without calling an action<br/>its complete hook decides what follows, in code: a line, the end or a handoff"]
  slots --> done
```

## Offer a message

After a route (after whereabouts): the internal form `offer_message`, its slots, the summary, the action and its rules.

```mermaid
flowchart LR
  after("After<br/>a route, after whereabouts")
  after --> slots
  subgraph slots["Slots, in the order they are asked (a caller may give them in any order)"]
    s_recipient["recipient<br/>type: choice"]
    s_leaveMessage["leaveMessage<br/>type: choice"]
  end
  done["Completes without calling an action<br/>its complete hook decides what follows, in code: a line, the end or a handoff"]
  slots --> done
```

## Routes

What the call does at its start, once the caller is verified, and after a form: the rules at each point are tried in order, the first whose conditions all hold is taken, and the else last. What the caller says still decides every other turn.

### After Is someone in

```mermaid
flowchart TD
  p_after_whereabouts("whereabouts completes<br/>before its next")
  w_after_whereabouts_0{"fact presence is available"}
  p_after_whereabouts --> w_after_whereabouts_0
  o_after_whereabouts_0[["form reach_person"]]
  w_after_whereabouts_0 -->|"yes"| o_after_whereabouts_0
  o_after_whereabouts_1[["else<br/>form offer_message"]]
  w_after_whereabouts_0 -->|"no"| o_after_whereabouts_1
```

### After Put through or a message

```mermaid
flowchart TD
  p_after_reach_person("reach_person completes<br/>before its next")
  w_after_reach_person_0{"slot reachHow is message"}
  p_after_reach_person --> w_after_reach_person_0
  o_after_reach_person_0[["form take_message"]]
  w_after_reach_person_0 -->|"yes"| o_after_reach_person_0
  o_after_reach_person_1[["else<br/>say no_problem, anything-else"]]
  w_after_reach_person_0 -->|"no"| o_after_reach_person_1
```

### After Offer a message

```mermaid
flowchart TD
  p_after_offer_message("offer_message completes<br/>before its next")
  w_after_offer_message_0{"slot leaveMessage is leave"}
  p_after_offer_message --> w_after_offer_message_0
  o_after_offer_message_0[["form take_message"]]
  w_after_offer_message_0 -->|"yes"| o_after_offer_message_0
  o_after_offer_message_1[["else<br/>say no_problem, anything-else"]]
  w_after_offer_message_0 -->|"no"| o_after_offer_message_1
```

## Where a handoff goes

The transfer targets, tried in order: the first whose conditions all hold is taken, else the default. Each dials the number or SIP address in its environment variable; the headers go only to a SIP address, the chat data only on a web chat.

```mermaid
flowchart TD
  handoff("A handoff<br/>its reason, the form, the call data")
  w_0{"the reason is put-through and slot recipient is riley"}
  handoff --> w_0
  t_0[["RILEY_LINE"]]
  w_0 -->|"yes"| t_0
  w_1{"the reason is put-through and slot recipient is sam"}
  w_0 -->|"no"| w_1
  t_1[["SAM_LINE"]]
  w_1 -->|"yes"| t_1
  w_2{"the reason is put-through and slot recipient is jordan"}
  w_1 -->|"no"| w_2
  t_2[["JORDAN_LINE"]]
  w_2 -->|"yes"| t_2
  fallback[["default STUDIO_MAIN_LINE"]]
  w_2 -->|"no"| fallback
```

## Dangling references

None: every intent reaches a form or a line, and every action is reached by a form or the identity flow.

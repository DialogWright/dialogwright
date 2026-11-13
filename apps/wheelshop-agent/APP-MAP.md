# App map: Example Wheel Works

*Generated from the app's `agent.yaml` by `pnpm app:diagram`: do not edit it by hand. A test fails when this page and the file disagree.*

**This is the structure of the app, not a script for a call.** A model holds the conversation and chooses which action to call; the map shows what each action takes, what runs after a confirmed change, and where a value must come from.

## What the agent can do

| Action | Kind | Takes | Value from |
| --- | --- | --- | --- |
| `recognise_caller` | lookup | nothing | the caller |
| `check_availability` | lookup | `day` | the caller |
| `send_request` | change | `name`, `vehicle`, `wheels`, `damage`, `finish`, `slot`, `callbackNumber`, `textOk`, `notes` | `check_availability` |
| `send_photo_request` | change, a follow-on | `callbackNumber`, `textOk` | the caller |
| `notify_shop_request` | change, a follow-on | `name`, `vehicle`, `wheels`, `damage`, `finish`, `slot`, `callbackNumber`, `textOk`, `notes` | `check_availability` |
| `book_dealer` | change | `account`, `cars`, `vehicles`, `slot` | `recognise_caller`, `check_availability` |
| `notify_shop_booking` | change, a follow-on | `account`, `cars`, `vehicles`, `slot` | `recognise_caller`, `check_availability` |
| `leave_callback` | change | `name`, `callbackNumber`, `about`, `notes` | the caller |

## Actions, follow-ons and sources

```mermaid
flowchart LR
  subgraph sources["Sources"]
    src_calendar["calendar<br/>fake: 5 days<br/>windows: morning, afternoon"]
    src_accounts["accounts<br/>3 recognised by the number calling"]
  end
  a_recognise_caller["recognise_caller<br/>lookup"]
  a_check_availability["check_availability<br/>lookup"]
  a_send_request[["send_request<br/>change: read back, then yes"]]
  a_send_photo_request[["send_photo_request<br/>change (follow-on)"]]
  a_notify_shop_request[["notify_shop_request<br/>change (follow-on)"]]
  a_book_dealer[["book_dealer<br/>change: read back, then yes"]]
  a_notify_shop_booking[["notify_shop_booking<br/>change (follow-on)"]]
  a_leave_callback[["leave_callback<br/>change: read back, then yes"]]
  a_end_call("end_call<br/>ends the call")
  a_check_availability -->|slot| a_send_request
  a_send_request ==>|"then, after the yes"| a_send_photo_request
  a_send_request ==>|"then, after the yes"| a_notify_shop_request
  a_check_availability -->|slot| a_notify_shop_request
  a_recognise_caller -->|account| a_book_dealer
  a_check_availability -->|slot| a_book_dealer
  a_book_dealer ==>|"then, after the yes"| a_notify_shop_booking
  a_recognise_caller -->|account| a_notify_shop_booking
  a_check_availability -->|slot| a_notify_shop_booking
```

A thin arrow is a value the lookup returned: the param must be one of its results on this call. A thick arrow is a follow-on action, run after the caller's yes with the values read back.

## Journeys

Each caller turn, the decision model reads which journey the caller wants; the agent model is offered only that journey's actions (or the root's).

```mermaid
flowchart LR
  root(["Root"])
  subgraph journeys["Journeys"]
    j_request["request<br/>The caller wants a wheel repaired, a price, to bring a car in, or someone from the shop to call them."]
    j_dealer_booking["dealer_booking<br/>The caller wants to book cars in for repair, or someone from the shop to call them."]
  end
  a_recognise_caller["recognise_caller"]
  a_check_availability["check_availability"]
  a_send_request[["send_request"]]
  a_send_photo_request[["send_photo_request"]]
  a_notify_shop_request[["notify_shop_request"]]
  a_book_dealer[["book_dealer"]]
  a_notify_shop_booking[["notify_shop_booking"]]
  a_leave_callback[["leave_callback"]]
  root --> j_request
  root --> j_dealer_booking
  j_request --> a_check_availability
  j_request --> a_send_request
  j_request --> a_leave_callback
  j_dealer_booking --> a_recognise_caller
  j_dealer_booking --> a_check_availability
  j_dealer_booking --> a_book_dealer
  j_dealer_booking --> a_leave_callback
  a_send_request ==>|"then, after the yes"| a_send_photo_request
  a_send_request ==>|"then, after the yes"| a_notify_shop_request
  a_book_dealer ==>|"then, after the yes"| a_notify_shop_booking
```

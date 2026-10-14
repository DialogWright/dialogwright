# Policy card: Example Front Desk

*Generated from `policy.yaml` and `identity.yaml`, and the lines a model words from `prompts.yaml` and `forms.yaml`, by `pnpm policy:card`: do not edit it by hand. Change the files, write the card again, and review the diff. A test fails when this page and the files disagree.*

| File | Config hash |
| --- | --- |
| `policy.yaml` | `ec0e8e09422933c03ff52ca886d776f7fb7a45380dd27b14b0ca65f22a2950c8` |
| `identity.yaml` | none: this app verifies no one |

The hash is a SHA-256 of the file's content (comments and layout do not change it); every call's audit record carries the hashes it ran under.

## Defaults

- Anything not listed under Actions is refused.
- The rules of an action run in the order shown, and the first one that fails decides.
- Identifiers in decision lines appear by their last four characters (`...1234`), never in full; a value recorded hidden, by length or never shows not even those.
- In traces and the audit a caller's values are recorded as they are said, except: phone by its last four.

## Identity

This app verifies no one. Every caller stays anonymous (level 0), so every action is at level 0.

```mermaid
flowchart LR
  L0("Level 0<br/>anonymous<br/>no one is verified")
```

## Who is served and who acts for them

No one is verified, so the app has no subjects and no one acts for them.

## What is recorded

What the record of a call keeps of each value the action is sent: the gate's decision, the trace, the console and the audit. A value is recorded as its slot says or as policy.yaml's `audit` declares, and `check` refuses one that neither covers. Where a rule's line, the action's summary, its own audit rows, the side effects it queues (as recorded) or a downstream service's row for the answer repeat a value that is hidden, shortened or never recorded, it is masked there too.

| Action | Value | Recorded |
| --- | --- | --- |
| Deliver a message to the studio's inbox (`leaveMessage`) | recipient (`recipient`) | as it is |
| Deliver a message to the studio's inbox (`leaveMessage`) | caller (`caller`) | by its length only |
| Deliver a message to the studio's inbox (`leaveMessage`) | phone (`phone`) | by its last four characters |
| Deliver a message to the studio's inbox (`leaveMessage`) | message (`message`) | by its length only |

## Lines a model words

These lines are fixed, but for the spans named (the framed form): a model words each span from the content it names, and nothing else of the line, whose fixed words say whose words the span gives. Each span is checked before anyone hears it: it asks nothing; it names no other value of the line's own items in their place; it adds no negation and drops none from its content; it speaks as no one its content does not (the agent's own words, or words to the listener); it keeps to its word budget and avoids the phrases style.yaml lists; it names no number, amount, date or capitalized word its content does not; and the decision model, given the span, its goal and its content, finds it a faithful summary. The content is screened for an injection again before a span is worded from it. When a check fails, the model is slow or errs, or the caller's words were flagged, the span is its content, word for word. The model is sent only the span's goal, its content (the caller's words, quoted), its word budget, the style, the channel and the language: never the line around it, an identity factor, a value the records hide whole, the transcript, or anything a tool returned. Every other line is said word for word.

| Line | Fixed text | Span | Goal | Generated | Worded from | Sent whole, though recorded masked | Words |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `confirm_take_message` | Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said: {summary}. Shall I pass it on? | `{summary}` | Summarize the caller's message briefly, in their own terms, as a receptionist reading it back. | the first time it is said | `{message}`, a value the caller confirms | nothing | 20 |

Prescribed lines (`prescribed: true`): always said word for word, never generated.

| Line | Text |
| --- | --- |
| `handoff_frustrated` | Let me put you through to the studio's main line. |
| `handoff_live_agent` | One moment while I put you through to the studio's main line. |
| `handoff_max_attempts` | Let me put you through to the studio's main line to help with that. |
| `handoff_needs_human` | This one needs a person. Let me put you through to the studio's main line. |
| `handoff_security` | Let me put you through to the studio's main line. |
| `handoff_system_failure` | I'm having trouble right now. Let me put you through to the studio's main line. |
| `handoff_urgent` | I'll put you straight through to the studio's main line. |
| `message_taken` | Your message is on its way to {recipient}. Thanks for calling Example Front Desk. |

## Actions

One row per action the agent may take. Anything else is refused.

| Action | Level | The gate checks, in order |
| --- | --- | --- |
| **Deliver a message to the studio's inbox**<br/>`leaveMessage` | 0 anonymous | 1. any caller may ask, verified or not<br/>2. the caller must confirm exactly these values at the read-back, and nothing else is sent: recipient, caller, phone and message (the read-back is generated and may summarize message; the values confirmed and sent are the ones kept, word for word, and the caller may ask to hear them so) |

### Actions by level, with their rules and what each role gets

```mermaid
flowchart LR
  subgraph lv0["Level 0: anonymous"]
    a_leaveMessage["Deliver a message to the studio's inbox<br/>identity · confirmed"]
  end
```

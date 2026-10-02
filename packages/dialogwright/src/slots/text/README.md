# `text`

The caller's own words, kept as said: a description of a problem, a note for a courier, a reason for a request.

One yes-or-no question asks whether the caller gives the text. When the model says yes (at `SLOT_DETECT` or above), the value is the caller's words on that turn, trimmed and cut to `maxLength`. The model never writes or rewrites the value. A summary reads the slot back by a stand-in (`say`, "your description"), and by default the words leave the turn (the trace, a tool call's param of the same name) as their length only.

Reach for it for a value no list holds and no code can check. For a number, a date, a name or a choice from a list, use the type made for it: those check what they hear.

## Options

<!-- slot-docs:options -->

The slot is fixed to `spokenConfirm: summary` and `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`.

## The question

With `what: a description of the problem` on the slot `problem`, the question is `problemGiven`:

> Read asr.text. Does the caller give a description of the problem? A request alone is not a description of the problem.

With `instructions`, its words follow, after a space.

## Examples

The starter examples, listed below, are four configurations with starter utterances: the defaults, a courier note with its own stand-in and length, a slot keeping its recorded wording and id (`text.given`, `ids.given`), and a phrase shown as said. In an app's `slots.yaml`:

```yaml
courierNote:
  type: text
  what: a note for the courier
  instructions: Count where to leave the parcel and how to reach the door.
  say: your note
```

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- The value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence.
- In another locale the stand-in can be that locale's: `locale/<tag>/slots.yaml` gives `say: <stand-in>` for the slot. The words themselves are the caller's, in whatever language they spoke. A slot whose display is the words (`say: null`) takes none.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

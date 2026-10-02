# `text`

The caller's own words, kept as said: a description of a problem, a note for a courier, a reason for a request.

One yes-or-no question asks whether the caller gives the text. When the model says yes (at `SLOT_DETECT` or above), the value is the caller's words on that turn, trimmed and cut to `maxLength`. The model never writes or rewrites the value. A summary reads the slot back by a stand-in (`say`, "your description"), and by default the words leave the turn (the trace, a tool call's param of the same name) as their length only.

Reach for it for a value no list holds and no code can check. For a number, a date, a name or a choice from a list, use the type made for it: those check what they hear.

## Options

| Option | Default | What it does |
|---|---|---|
| `what` | none | What the caller gives, as a noun phrase the default question names ("a description of the problem"). Needed unless `text.given` gives the whole question. |
| `instructions` | none | More guidance for the model, added after the default question ("Count it even when it comes with a request."). |
| `maxLength` | 500 | The most characters of the caller's words the value keeps. |
| `say` | `your description` | The display: what a line, the console and the model's turn state show in place of the words. `null` shows the words themselves, and then needs `redact: none`. |
| `keep` | `first-unless-prompted` | When a value is on file: `first-unless-prompted` replaces it only when the slot was just asked for (a later aside never overwrites it); `first` never replaces it. A correction at the summary replaces it either way. |
| `redact` | `length` | `length`: the words leave the turn as their length only ("<38 chars>"), and the stand-in display is kept. `none`: as they are. |
| `text` | none | `text.given`: the question in its own words, sent to the model exactly as written, in place of the default. One line. |
| `ids` | none | `ids.given`: the question's id in place of `<slot>Given`, to keep the id an existing slot was recorded with. |

The slot is fixed to `spokenConfirm: summary` and `detect: true`, has no keypad rung, and says no line beyond its `ask_<slot>` and `ask_<slot>_retry`.

## The question

With `what: a description of the problem` on the slot `problem`, the question is `problemGiven`:

> Read asr.text. Does the caller give a description of the problem? A request alone is not a description of the problem.

With `instructions`, its words follow, after a space.

## Examples

`examples.yaml` beside this file has four configurations with starter utterances: the defaults, a courier note with its own stand-in and length, a slot keeping its recorded wording and id (`text.given`, `ids.given`), and a phrase shown as said. In an app's `slots.yaml`:

```yaml
courierNote:
  type: text
  what: a note for the courier
  instructions: Count where to leave the parcel and how to reach the door.
  say: your note
```

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot. That is why `keep` defaults to `first-unless-prompted`: "and ring the bell" said later must not replace the note.
- The value is the whole turn's words, not the part that is the note. If the caller says "yes, leave it by the gate", the value is that sentence.
- Run its checks with `pnpm --filter dialogwright test slots/text`.

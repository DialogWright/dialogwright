# A system asked between a form's questions, and a value asked again

Date: 2026-10-18. Status: **built on main (framework gaps met while building a booking line on a scheduling API, the maintainer's standing decision that such gaps become framework fixes).**

## The problem

A booking line on a scheduling system asks, in order: which service, the zip code where the work is done, the day, the time, and the caller's details. Two of those answers need the system at once, before the next question:

- **The zip code.** An area the business does not serve should be said before the caller is asked anything else. The service area lives in the scheduling system (its owners edit it there), so this is a lookup, not a `check: true` action the gate decides from the app's own lookups.
- **The day.** The times to offer are that day's openings for that service at that zip, which only the system knows. The next question names them ("On Saturday I have times from 8:30 to 3. What time works?"), and a day with none is said, and the day asked again.

And one answer from the system, at the end, sends the caller back a step: **the time was taken** between the read-back and the yes. The system offers the next times; the line says so and asks the time again, keeping everything else.

What the engine has: a form's `checks` run part-way, but through the gate alone (no tool); `entry` runs once, before the form's questions; `next` chains forms, each a bridge line ("Now, let's ...") and at most two in a chain; `complete` runs once the form is confirmed, and can say a line, end, refuse, hand off or read the summary again (`reconfirm`), but cannot ask a slot again. A record slot's display, which the read-back says, is its key.

## The decision

### 1. `afterSlot`: a hook between a form's questions

```ts
forms: {
  book: {
    // Runs once for each value a slot of the form is given (and again when it changes), after the
    // form's checks and before the next question.
    afterSlot(c) {
      if (c.slot === 'zip') { /* coverage: out of the area, a line and a person */ }
      if (c.slot === 'day') { /* openings that day: kept for the time slot, said; none, the day again */ }
      return null;
    },
  },
},
```

It is given what a completion is given (the session, the turn, `callTool` through the gate, the turn's acknowledgements, `refusal`) and the slot, and returns what a completion returns, or null to go on:

| It returns | What follows |
|---|---|
| `null`, or `{ kind: 'said', acks }` | the form goes on: the acks are said before the next question |
| `{ kind: 'again', slots, acks }` | those slots are emptied, the acks said, and the first of them asked again (no attempt counted: the caller answered; the system said no) |
| `{ kind: 'end', promptId, vars, acks }` | the call ends on that line, the form not completed |
| `{ kind: 'decision', decision }` | that decision (a handoff) |
| a refusal (`c.refusal(decision)`) | the gate's line or a person, the form closed |

It runs where the checks do: as the form goes on to its next question (`continueForm`), and first thing again at completion, so a zip corrected at the read-back is looked up again before the booking is made. A slot is looked at once for each value: the session keeps the value each slot was last seen with (`Session.slotsSeen`), dropped when the form closes, as the checks' passes are. forms.yaml lists the hook (`hooks: [afterSlot, ...]`), as it lists every hook, and its actions in `calls`.

A hook's calls are policy's like any other: the gate decides each one. What the hook decides is what a system's answer means for the conversation (an area not served is a person; a day with no openings is the day again), as a completion decides what a booking's answer means.

### 2. `again`: a completion that asks a slot again

`{ kind: 'again', slots: ['opening'], acks: [{ promptId: 'opening_taken', vars: {} }] }` from `complete` empties those slots and goes back into the form: the first empty slot is asked, then the summary is read again. The hook keeps the system's alternatives in the facts for the slot first.

### 3. A record slot's display

`display` on a record slot is a template over the record's fields, as `label` is: `display: "{label}"` makes the read-back say "Saturday, October 24 at 10:30 AM" where the key is `1030`. Without it the display is the key, as before.

## What it costs

Nothing for an app without the hook or the option: no field on its sessions, no change to its turns. The trace and the audit see the hook's calls as gate events, as any call's.

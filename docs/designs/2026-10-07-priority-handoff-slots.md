# Stale values in a priority intent's handoff (design)

Date: 2026-10-07. Status: proposal for the maintainer to decide. Engine: DialogWright local `main` (65b2244). Source: the foundation repair trial's DESIGN.md ("An emergency never waits", under Choices) and its stub baseline, at the tag `trial/foundation-repair-run1`.

## At a glance

**The recommendation.** Two parts, both off by default.

1. **A priority switch corrects what the call holds, from its own words.** The turn that switches was planned with the old form open (or with none open), so the model was asked about every slot that turn listens for, and its answers are in hand. With the option on, the engine fills those slots from the answers as a correction, then enters the priority form. "Wait, water is coming through the wall right now", said at the read-back, sets `howUrgent` to "happening right now" before the handoff. No new question.
2. **The handoff can say which values the caller confirmed.** A new `handoff.data.unconfirmed`: `send` (the default, as today), `mark` (the data names the values never confirmed) or `omit` (they are not sent). The console's packet marks them too.

Clearing the old form's slots on a switch is rejected: an emergency is when the office most needs the name, the number and the address.

**Backwards compatible.** No app in the repository has a priority intent, and none sets `unconfirmed`. Clinic, utility and the testkit change nothing. Opting in to part 1 changes no model request on the switching turn. It changes later requests only when the priority form goes on to ask something, and then the app records again. Part 2 changes no request.

**Decide these (each has a recommended default):**

1. **Part 1 on by default for priority intents?** Recommended: off, as `priority: { correctsForm: true }`, with the create-app skill's priority pattern turning it on. Alternative: on for every priority intent (no shipped app has one, so nothing would move).
2. **`unconfirmed: mark` as the skill's default for new apps?** Recommended: yes. The engine's default stays `send`.
3. **What "confirmed" means in the handoff.** Recommended: the slot's own `confirmed` flag, or a value the caller said yes to at a summary and that has not changed since. The second needs a small optional session field, `agreed`, written only for an app that sets the option.
4. **The handoff audit row names the unconfirmed slot ids** when `mark` is set, so the handoff note can say so. Recommended: yes, ids only.
5. **Names**: `correctsForm`, `unconfirmed: send | mark | omit`, the data key `unconfirmed`. Recommended as written.

## 1. The problem

The trial marks `emergency` as `priority: true`, and its form hands off at once. A caller works through the booking to the read-back, then says "wait, water is coming through the wall right now". The priority intent takes the turn and the call goes to the office, as it should. But the office's data still says `howUrgent: getting worse`, the answer the caller gave ten turns earlier.

The stub baseline shows it. `emergency-at-the-summary` ends in `handoff`, reason `emergency`, form `emergency`, with all ten slots filled and `howUrgent` "worsening". `emergency-while-booking` is the same with four. The builder noticed and wrote it down as a choice: "The handoff carries the slots as they were ... the handoff's reason, `emergency`, is what the office acts on."

Two things are wrong in that data:

- **A value the caller's own words just contradicted.** "Coming through the wall right now" is the `emergency` option of `howUrgent` almost word for word.
- **Values never agreed shown as if they were.** At the read-back none of the ten was confirmed: the caller interrupted the summary. The office sees a phone number and an address with nothing to say the caller never said yes to them. A misheard digit looks the same as a checked one.

## 2. Why, in the engine

- **The switch.** gates.ts row 10 (`priorityIntent`) replaces the settled verdict with `{ kind: 'route', intent, confirm: 'none' }`. `handleVerdict`, case `route` (core/turn.ts), calls `enterForm`.
- **The old form is left, not closed.** `enterForm` calls `setForm` (core/session.ts), which clears the pending confirmation and the step-up but no slot. `closeForm` is never called for the form left. The turn test "files nothing the caller walked away from" pins this for a replacing switch: the abandoned report's `expectedDate` stays on the session, unconfirmed.
- **This turn's answers for the old form are dropped.** The turn was planned with `schedule_inspection` open, so `activeSlots` (core/fia.ts) put `howUrgent`'s question in the request. But `enterForm` fills after `setForm`, from the new form's slots, and `emergency` has none.
- **The handoff takes every filled slot of the app.** `handoff()` (core/decision.ts) copies each slot with a value, whatever form it belongs to, as its display (or `last4`, or `verified`). `handoffDataSlots` (handoff/data.ts) then applies `handoff.data`: identity factors left out, redacted slots masked. `transferAction` (prompts/render.ts) puts the result in the end frame's `slots` (channel/relay/frames.ts `endFrame`). The console's `packetOf` (server/dashboard/view.js) prints `key: value` lines.
- **Nothing says what was confirmed.** `SlotState.confirmed` exists, but the handoff does not read it, and the audit's `handoff` row has only the reason, `completed` and `queued` (core/audit.ts).

## 3. Options

### A. Clear what the priority form does not use

On a priority switch, empty the old form's slots (or keep only a list the priority intent names). Simple. But the emergency office then calls back with no number, no name and no address, which is worse than one stale answer. A per-intent keep list is a workaround an app can already approximate with `handoff.data.slots` (app-wide, so the warranty handoff loses the same slots).

### B. Mark what was confirmed

The handoff data says which values the caller never confirmed. Honest, and general: it also covers "get me a person" at a read-back, and any switch away from a half-filled form. It does not fix the contradicted value. The office would see "howUrgent: getting worse (not confirmed)".

### C. Let the switching words correct the form left, plus B

Before entering the priority form, fill the old form's slots from this turn's answers, as a correction. The contradicted value is replaced with what the caller just said. B then labels everything that is still only heard.

A variant of C: the priority intent sets values itself, `priority: { sets: { howUrgent: emergency } }`. Deterministic, but it ties an intent to a slot's options in YAML, and it repeats what the slot's own option already reads from the words. Not recommended.

## 4. Recommendation: C, with B

### 4.1 Part 1: `correctsForm`

```yaml
intents:
  emergency:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: { correctsForm: true }    # threshold: PRIORITY_INTENT, as with `true`
```

- In `handleVerdict`, case `route`: when the intent is a priority intent with `correctsForm` and it is not the open form, fill before `enterForm`. With a form open, `correctingFill(s, answers, ctx, s.form)` (turn.ts): the same answers read with `correcting: true`, so a new value replaces an old one, and a value said again unchanged is no change. With no form open ("anything else?"), the call's own slots, `slotsToFill(s)` (fia.ts: carried, `anywhere` and identity factors), read the same way. That is what this turn would have kept had it opened no form.
- What the fill would say is dropped: its acks (an `ack_<slot>` before the handoff line is noise) and any disambiguation (there is no question to ask on the way out). Its fill events join the turn's events, so the debug table's slot rows show the change.
- The old form is still left, not closed and not completed. Nothing in it is confirmed by this.
- An informational priority intent needs nothing: the `inform` case already fills the open form's slots from the turn.
- Only priority intents. A replacing switch to an ordinary form often goes on to ask questions, and its words ("track my parcel from Tuesday instead") may not be about the form left.

### 4.2 Part 2: `handoff.data.unconfirmed`

```yaml
handoff:
  data:
    unconfirmed: mark      # send (default) | mark | omit
```

- A filled slot is **confirmed** when its `confirmed` flag is set (a `confirm_<slot>` yes, a keyed value, or a fill the slot accepts with no read-back), or when `s.agreed` holds that same value. Otherwise it is **unconfirmed**.
- `s.agreed` (optional, by slot id, the value agreed) is written when a form that has a summary completes on the caller's yes (`finishForm` with `completed`, and `endOnCompletion`, turn.ts), for each filled slot of the form, and only when the app sets `mark` or `omit`. A carried name or birth date counts as confirmed in a later form this way, and a value corrected after the yes does not. Absent for every other app, as `locale` is absent for an app without locales.
- The slot `confirmed` flag is not changed to make this work. Today a summary yes leaves it false on a carried slot, and it is in the turn state the model sees (core/state.ts), so changing it would change every app's requests.
- `HandoffDecision` gains `unconfirmed: SlotId[]` only when the option is `mark` or `omit`. With `omit`, `handoffDataSlots` leaves those slots out. With `mark`, `endFrame` adds `unconfirmed: [ids]` beside `slots`. The carrier posts the data back, and server/http.ts reads only `reasonCode` from it, so the callback path is unchanged.
- The console's packet prints a marked value as `howUrgent: happening right now (not confirmed)`.
- With `mark`, the audit's `handoff` row gains `unconfirmed` (ids, never values), and `handoffFacts` (handoff/facts.ts) passes it to the note, whose "Next:" line can say what to check with the caller.

### 4.3 The trial's call, with both

| | Caller | Engine | Office receives |
|---|---|---|---|
| 11 | "Wait, water is coming through the wall right now." | `priorityIntent` act:emergency; `correctsForm`: `howUrgent` = emergency; enter `emergency`; handoff | reason `emergency`; `howUrgent: happening right now`, and the other nine as heard; `unconfirmed`: all ten |

The same caller, after a yes to the summary and a booking made, who then says "and now water's coming in" at "anything else?": in the trial's two-form app the four qualifying slots are carried (`listen: call`), so `howUrgent` is corrected from the call's slots and marked unconfirmed (it changed after the yes), while the other three are confirmed by `s.agreed`. In the one-form app of the checks design nothing is carried, the booking's slots were emptied at its close, and the handoff has no slot values at all.

## 5. Backwards compatibility

- No app in the repository has a priority intent (`priority` appears only in engine tests), so part 1 never runs for clinic, utility or the testkit.
- No app sets `unconfirmed`. `HandoffDecision`, the end frame, the session (no `agreed`), the trace records, the audit rows and the console are unchanged for them. Their handoff goldens and the testkit's scenarios do not move.
- Model requests. Part 1 runs after the switching turn's request was made, from its answers, so that request is unchanged. A priority form that hands off ends the call, so no later request exists. One that asks questions carries the corrected display in later turn states, so that app records again. Part 2 runs at the handoff, after the last request.
- Changed on purpose: the generated `intents` and `app` schemas and the schema snapshot. An app outside this repository takes the engine with a version bump.
- The trial app, when run again with both: its stub baseline changes for `emergency-at-the-summary` and `emergency-while-booking` (the slot values in the handoff), and its cassette replays with no misses.

## 6. Validation (`pnpm check`)

- `correctsForm` only inside a `priority` object, and only on a form intent. On an informational one, a warning: it has nothing to correct.
- `unconfirmed` is one of `send`, `mark`, `omit`. A warning with `slots: none` (nothing is sent to mark), and a note that a chat's transfer sends no slots whatever this says.

## 7. Docs and the create-app skill

- **Guide, "Must never wait: `priority`".** The object form with `correctsForm`, and what the handoff carries after a priority switch: every filled slot of the call, the form left included.
- **Guide, app.yaml `handoff`.** `data.unconfirmed`, the rule for "confirmed", and the console's mark. The settings table in section 13 gains the row.
- **patterns.md, "Something that must never wait".** Use `priority: { correctsForm: true }`. Set `handoff.data.unconfirmed: mark`. Delete the trial's choice note ("the handoff carries the slots as they were"), since it is no longer true.
- **worksheet.md.** In "What goes to a person": "What should the person see about details the caller never confirmed?"
- **corpus.md.** A priority line at a form's read-back that also contradicts a slot, with its expected handoff values.

## 8. Tests

- Turn tests (core): a priority switch at a read-back corrects a contradicted slot and leaves the others; no acks or disambiguation from the correction; the old form is not completed; without `correctsForm`, today's behaviour; an informational priority intent unchanged; a non-priority replacing switch unchanged.
- `handoff()`: confirmed by flag, by a keyed value, by `s.agreed`; unconfirmed at a pending summary and after a correction made since the yes; absent `unconfirmed`, and no `agreed` written, without the option.
- Part 1 with no form open: a carried slot corrected at "anything else?".
- handoff/data.ts: `omit` drops, `mark` keeps and lists; identity factors still left out first.
- frames, render and the console view: the end frame's `unconfirmed` key only with `mark`; `packetOf` marks; `parseHandoff` unaffected.
- Audit: the `handoff` row's `unconfirmed` only with `mark`; the note's facts carry it.
- Scenario: a fixture app with a priority intent and a booking form, an emergency at the read-back, with the handoff data checked.

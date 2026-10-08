# Keeping a value said on the opener for a later form (design)

Date: 2026-10-07. Status: proposal for the maintainer to decide. Engine: DialogWright local `main` (65b2244). Source: the foundation repair trial, `docs/trials/2026-10-06-foundation-repair.md` entry 9, and its app at the tag `trial/foundation-repair-run1`. Read with the form checks design, `2026-10-07-qualify-then-collect.md`.

## At a glance

**The recommendation.** Build nothing in the engine now. Form checks turn the trial's two forms into one, and on the turn that opens a form every slot of that form listens. So "book me in for a Saturday morning" said on the opener fills `day` and `timeOfDay`, with no new option. Document the one-form pattern, rewrite the known gap so it points at checks, and pin the behaviour with a scripted call. Two narrower cases remain: a second request named in the same breath, and a form reached by a later `next:` link. Neither has evidence yet. Their designs are sketched below so they can be built when a trial meets one.

**Backwards compatible.** Nothing changes for clinic, utility or the testkit: no code, no schema, no model request, no golden.

**Decide these (each has a recommended default):**

1. **Build a general mechanism now?** Recommended: no. Close trial entry 9 with form checks and docs. Alternative: option A or B below now.
2. **When internal forms and `next:` are built**, should a form with `next: <form>` keep values said for that next form? Recommended: yes, as part of that change (option B, tied to `next:`), not as a separate option.
3. **A second request named in the same breath** ("reschedule my visit, and book one for a Saturday"): recommended not now. Add it to the known gaps with a scripted call that pins today's behaviour, and build option C below when a trial or a user meets it.
4. **The name `anywhere`.** Recommended: keep it. The guide already says it does not reach across forms on the turn one opens. Renaming it breaks every app that uses it for little gain.

## 1. The problem

The trial's caller opens with "book me in for a Saturday morning". The line's first form, `book_inspection`, asks the problem, ownership, town and urgency. The day and the time belong to the second form, `schedule_inspection`. The opener opens the first form, and the Saturday and the morning are lost. The booking form asks for them again.

The builder tried `listen: anywhere` on both slots, since the guide described it as keeping a value said outside a form. It does not keep one said on the turn that opens another form. The builder reverted it and pinned the repeat with the scripted call `day-and-time-up-front-asked-again`. Its steps open with "book me in for a Saturday morning", answer every other question, and end at `ask_day` in `schedule_inspection`, with `day` and `timeOfDay` null in the baseline.

The cost is one question asked twice. The waste is larger than it looks: the model was asked about the day and the time on the opener, answered, and the answers were thrown away.

## 2. Why, in the engine

- **The opener asks every slot.** Outside a form, `activeSlots` (core/fia.ts) returns every slot but those with `listen: form`. So the opener's request to the model carries the questions of `day` and `timeOfDay`, and the answer map holds their answers.
- **The turn that opens a form fills only that form.** `enterForm` (core/turn.ts) calls `setForm` first, then fills from `slotsToFill(s)`. Inside a form, `slotsToFill` is `activeSlots`, which is that form's slots (plus the identity factors for an anonymous caller). The other answers are dropped.
- **`anywhere` and `call` act only outside a form.** `slotsToFill` reads `listenOf` only in its outside-form branch, which serves a turn that opens no form (an informational answer, a declined transfer). The type's own comment on `SlotListen` (core/slots/types.ts) says so: "a turn that opens a form without it keeps nothing for it".
- **The limit is deliberate.** Before values were tied to the form a turn enters, the utility's `oh-05` filled `firstDate` from "are you open on Saturday", and the payment form later read that Saturday back as the caller's answer (docs/known-gaps.md). A value said for no form, kept and read back later, is worse than a question asked twice.
- **The same drop happens on a queued request.** On a route with a second intent (`verdict.queue`), `enterForm` queues it and fills only the first form. When `finishForm` bridges into the queued form, it calls `continueForm` with no fill at all. What the caller said for the second task on the opener is lost the same way.

The docs already say all of this. The guide's "Where a slot listens" calls it a known gap, and patterns.md lists "A value said with the request for a different form is lost".

## 3. Where the cases stand after form checks

With checks, the trial's line is one form: `book_inspection` with all ten slots, the qualifying ones first, checks between (checks design, 4.1 and 5.3). The opener enters that form, and `enterForm`'s own fill takes the day and the time. Nothing else is needed. The checks design already notes that this closes entry 9 for the shape.

What remains:

| Case | Example | After checks | Evidence |
|---|---|---|---|
| Qualify, then book | "book me in for a Saturday morning" | solved: one form | trial entry 9 |
| A second request in the same breath | "move my visit to Friday, and book one at my mother's house on a Saturday" | lost: only the first form fills | none yet |
| A form reached by `next:` (internal forms, not built) | a screener leading to a shared booking form | not applicable until `next:` exists | checks design, open question 3 |
| A value for a form the caller asks for much later | "I'll want a Saturday" said, then "anything else?" asked twice | lost, as it should be: nothing ties it to a task | none |

## 4. Options

### A. Make a slot keep a value said on the turn that opens another form

In `enterForm`, after the form's own fill, also fill the slots outside the form that keep a value said anywhere, from the same answers. The answers are already in hand, so the opener's request is unchanged.

- It cannot be the meaning of `anywhere` or `call` without changing apps. The clinic carries `name`, `dob` and `memberId` (`carrySlots`, which is `listen: call`). Under A, a name said on an opener that opens a form without it would now be kept, and a later form would skip its question. So A needs a new value, say `listen: ahead`, off unless a slot sets it.
- A kept value outlives the turn. Every slot's display is in the turn state (core/state.ts), so every later request of a call that kept one changes. An app that opts in records again.
- It brings back the `oh-05` risk for the slots marked: a value said for no task, read back later as an answer. The summary would catch it, but only in a form that has one.

### B. A form keeps what it hears for the form it leads to

A form names the slots it keeps for another, or keeps them implicitly when it has `next: <form>`. On its turns, including the one that enters it, the slots of the next form listen and keep their values. The next form uses them and empties them as it closes. If the call never reaches it, they are emptied with the first form.

- Scoped to a pair the author wrote down, so nothing is kept for a task the caller never asked for.
- Natural only with `next:`. Without internal forms, the second form is reached by app code writing `s.queued`, which the checks design forbids.
- Same request change as A on later turns, for the app that uses it.

### C. Fill ahead for a queued form

On a route with a second intent, the routing turn also fills the queued form's slots that the first form does not have. They are kept until the queued form is entered, or emptied when the call ends or the request is dropped.

- Fixes the queued case only. That case has a clear owner for each value: the caller named both tasks.
- An app option (`queue: { fillsAhead: true }` in app.yaml), off by default. With it, the turn state after the opener shows the kept values, so requests change and the app records again.
- A value that both forms have goes to the first form, as today, and the queued form asks again or takes it as carried.

### D. Not needed after checks: document the one-form pattern

Close entry 9 with checks. Keep A as rejected, B for when `next:` is built, and C for when the queued case is met.

## 5. Recommendation: D, with B and C sketched

The trial's case was a symptom of the two-form workaround. Form checks remove the workaround, and once the form is one form, `enterForm`'s existing fill (turn.ts, the `specs` line: `slotsToFill(s)` after `setForm`) already keeps every value said for it, `listen: form` slots aside by design. A general mechanism now would add a listen mode or an app option, change requests for whoever uses it, and reopen the risk `oh-05` closed, for cases no trial has shown.

When internal forms land, do B as part of `next:`. A screener that leads to a booking form should keep the booking's day, because the author has said the one leads to the other. Do C only when a trial or a user meets the queued case. Both stay off unless an app writes the option.

## 6. Backwards compatibility

- D changes no code. Clinic, utility and the testkit replay their cassettes unchanged, and no golden moves.
- When B is built, it runs only for a form with `next:`, which no app has. When C is built, it runs only with `queue.fillsAhead`. Neither changes a request of an app that does not opt in.
- Opting in to B or C changes the turn state of later turns (a kept value's display), so that app's model requests change and it records again. The opener's own request does not change: its questions were already asked.

## 7. Validation (`pnpm check`)

D adds nothing. For later:

- B: every slot a form keeps for its `next:` form is a slot of that form and not of the first form (otherwise the first form fills it anyway). A warning when the next form has no summary: a kept value would be used unread.
- C: `queue.fillsAhead` is a boolean. A warning when no form intent can be queued (no app has two form intents).

## 8. Docs and the create-app skill

- **patterns.md, "Known gaps".** Rewrite "A value said with the request for a different form is lost": with form checks, a qualify-then-book line is one form, and a day said on the opener fills. What is still lost: a detail for a second task named in the same breath. Workaround: let the queued form ask again, and pin it with a scripted call.
- **patterns.md, "Qualify before you collect"** (from the checks design): one line saying the one form is also what keeps the caller's up-front details.
- **worksheet.md.** A question: "Do callers often give details for a later step in their first sentence? Put those slots in the same form as the step they open."
- **corpus.md.** For each form, one opener that over-answers slots late in the form ("book me in for a Saturday morning").
- **Authoring guide, "Where a slot listens".** Keep the `anywhere` bullet's statement of the limit, and add that a line which qualifies before it books is one form with checks, so this is not met there.

## 9. Tests

- In the checks PR's fixture app (checks design, section 10): a turn test where the opener names the day and the time, and the form never asks them. A scripted call `day-and-time-up-front-kept` replaces `day-and-time-up-front-asked-again` when the trial is run again.
- In the testkit: a turn test that pins today's queued case (two tasks in one breath, the second's detail asked again), so a later change to it shows as a deliberate diff.
- No cassette is recorded for D.

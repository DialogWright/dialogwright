# Qualify, then collect: ending a form part-way on an answer (design)

Date: 2026-10-07. Status: proposal for the maintainer to decide. Engine: DialogWright local `main` (65b2244). Source: the foundation repair trial, `docs/trials/2026-10-06-foundation-repair.md` entries 2 and 3, and its app at the tag `trial/foundation-repair-run1`.

## At a glance

**The recommendation.** Add **form checks**: a list in forms.yaml of gated actions, each with the slots it reads. A check runs through the policy gate as soon as its slots are filled, and again whenever one of them changes. Its refusal ends the form with a line and an ending declared in YAML (`end`, `anything-else` or `handoff`). The check is an action in policy.yaml, so the rule that refuses is the same rule the booking applies at completion, written once and named in both. With checks, a qualify-then-collect line is **one form**: qualifying slots first, then the booking slots, one summary over all of them. No second form, no intent nobody says, no app write to `s.queued`. Internal forms and a `next:` link are not needed for this and are left for later.

**Backwards compatible.** Clinic, utility and the testkit change nothing: no new model question, no new criteria, no new session field on their sessions, no new probe purpose, no golden change. Only the generated JSON schemas change. An app that adopts checks changes its own requests only through the restructure (one form instead of two, one intent fewer), so it records again.

**Decide these (each has a recommended default):**

1. **Check actions without a tool.** Recommended: `check: true` on an action in policy.yaml; the gate decides and nothing runs. Alternative: keep "every action has a tool" and make the author write a no-op tool. (Section 4.2)
2. **Built-in `oneOf` and `noneOf` rules**, so "the town is one of these four" needs no TypeScript. Recommended: yes, as a separate small change. (Section 4.3)
3. **Internal forms and `next:`** (a form that is not an intent, reached only from another form). Recommended: not now. Note the design (section 6) and forbid writing `s.queued` in patterns.md. Build it when a second app needs one booking form after several screeners.
4. **A misheard "I rent" ends the call.** Recommended for v1: nothing new; the slot's own thresholds and corpus decide, and the trial re-run will show whether misreads happen. Alternative: `confirm: true` on an outcome, which reads the deciding answer back before it ends the call. (Section 5.7)
5. **Names**: `checks`, `with`, `on`, `then: end | anything-else | handoff`, `checksPassed`. Recommended as written; easy to change before docs.

Defaults this design picks and he may overrule: the engine drops the `ack_intent` line when a check ends the form on the turn the form was entered (5.1); `checksPassed` is said once per form, never again after a correction (5.6); a `STEP_UP` from a check goes to a person, and `pnpm check` refuses a check action above the form's proven level (5.8).

## 1. The problem in one paragraph

A foundation repair line asks four qualifying questions (the problem, owner or renter, which town, how urgent). A renter or a home outside the service area should hear "we can't help" and the call should end, before the caller gives a name, a number, an address and a day. Today a gate refusal comes only from a form's entry call (before any slot) or from its completion. So the trial built two forms: `book_inspection` asked the four and its completion called `checkHome`; on ALLOW the app code put `schedule_inspection` at the head of `s.queued`, a field the engine owns, and the engine bridged into it with `bridge_next`. Every form must be a `kind: form` intent, so `schedule_inspection` became an intent few callers say. It cost corpus lines, scripted calls, and a path (`schedule-by-name-renter`) on which a renter was refused only at the summary. Qualify-then-collect is the shape of most lead and intake lines, and of eligibility checks generally ("are you 18 or over", "is this a business account").

## 2. Where it fits in the engine today

- `continueForm` (core/turn.ts) runs after every turn that changed slots: disambiguation, slot read-back, `ensureEntry` (the entry call), then `nextPrompt`. Every fill passes through it: speech, the keypad, an informational answer that also filled, a correction at the summary. The one exception: a yes with a correction goes straight to `completeForm`.
- `callTool` (core/lifecycle.ts) is the only way to a tool: the gate decides, the decision is recorded, and only on ALLOW does a tool run. `PROBES` shows the gate can already be asked without running one.
- Inside a form every slot listens on every turn (core/fia.ts `activeSlots`). Priority intents (gates.ts row 10) take the turn before any fill.

## 3. Options

### Need 1: end a form part-way on an answer

**A. A stop on a slot value, in forms.yaml.** `stops: { ownership: { rent: decline_renter } }`. The engine ends the form when the slot takes that value. Simplest to write and to read. But the policy is then written twice: once here, once in the booking action's rules (which must still refuse a renter at completion). The refusal is not a gate decision, so it is not in the audit's gate rows, the policy card or the matrix, and compliance does not own it. It also only works for equality on one choice.

**B. Gated checks, in forms.yaml, deciding through policy.yaml (recommended).** A form lists checks. Each names an action and the slots it sends. When those slots are all filled, the engine calls the action through the gate. ALLOW lets the form go on. A refusal is mapped by its reason to a line and an ending, in YAML. The rules live in policy.yaml with every other rule, run by the same gate, recorded the same way, shown on the card and in the matrix. The booking action names the same rules, so the completion still refuses what the check refused (defence in depth), and a rule is written once.

**C. A code hook when a slot fills** (`onFilled(ctx, slot): Completion | null`). Most flexible: the hook calls the gate and returns any Completion. But it is TypeScript for a common shape, each app writes its own mapping, and nothing in YAML says when the form can end. It could come later as an escape hatch; checks do not need it.

A variant of B was considered and rejected: run the **booking action's own rules** mid-form, each rule only once the params it reads are filled. No new action, but it needs every custom rule to declare what it reads, a write action would appear refused in the audit while nothing was written, and an `identity` or `confirmed` rule mid-form has no clear meaning.

### Need 2: a form that leads to another without its own intent

**X. Internal forms and `next:`.** A form marked `internal: true` with a `label`, not in intents.yaml, never offered to the model or the keypad; a form-level `next: <form>` (or a `Completion` of kind `next`) bridges into it on completion. Keeps forms reusable: one booking form after several screeners. Costs: a bridge line between the two, carried slots (`listen: call`) for the qualifying answers, two summaries or one that reads slots from another form, and a second set of hooks.

**Y. One form, qualifying slots first, checks between (recommended).** With checks (B), the trial's two forms are one. The slots stay together, one summary reads everything back, there is no bridge line and no carried slot, and the model sees one intent. A form's slot list is a YAML list and its hooks are shared functions, so "reuse" across screeners costs one list per form. This also closes trial entry 9: "book me in for a Saturday morning" said on the opener now fills `day` and `timeOfDay`, because they are slots of the form the turn opens.

**Recommendation: B with Y.** Leave X for when an app needs it (open question 3).

## 4. The design

### 4.1 forms.yaml

```yaml
forms:
  book_inspection:
    slots: [problem, ownership, town, howUrgent, address, name, phone, heardFrom, day, timeOfDay]
    summaryPromptId: confirm_book_inspection
    hooks: [onSummaryRead, confirmedParams, complete]
    calls: [findOpening, bookInspection]
    checks:
      - action: checkUrgency
        with: [howUrgent]
        on:
          emergency: { then: handoff }
      - action: checkOwner
        with: [ownership]
        on:
          not-owner: { say: decline_renter, then: end }
      - action: checkArea
        with: [town]
        on:
          out-of-area: { say: decline_out_of_area, then: end }
    checksPassed: home_qualifies
```

- `checks` is a list, run in the order written. `action` is an action in policy.yaml. `with` lists slots of this form; each is sent as the param of the same name, its value as the slot holds it (the convention the identity factors already use). A check is **ready** when every slot in `with` holds a value.
- `on` maps a gate reason to an outcome. `then: end`: say the line, then the call ends (as a `Completion` of kind `end`: the goodbye follows, and with a request queued the call goes on to it instead). `then: anything-else`: say the line, close the form uncounted, and carry on (the next queued request, or "anything else?"), as `refused` does. `then: handoff`: to a person, `handoff_<reason>`; `reason:` names another; `say` is optional and comes before the handoff line.
- A reason `on` does not list gets what `c.refusal` gives today: a BLOCK with a `blockPromptId` line says it and carries on; anything else goes to a person (`needs-human`).
- `checksPassed` (optional) is a line said once, on the turn every check of the form has passed. Every line a check says renders with the form's slot displays as variables, as the summary does, so `home_qualifies` can say `{town}`.
- Check actions are reached by the form through `checks`; `calls` does not list them. The app map draws them.

### 4.2 policy.yaml: check actions

```yaml
actions:
  checkUrgency:
    say: send an emergency to the office
    check: true
    level: 0
    rules: [identity, { custom: emergency-to-office }]
  checkOwner:
    say: check the caller owns the home
    check: true
    level: 0
    rules: [identity, { custom: homeowners-only }]
  checkArea:
    say: check the home is in the service area
    check: true
    level: 0
    rules: [identity, { custom: in-service-area }]
  bookInspection:
    say: book a free inspection
    level: 0
    rules:
      - identity
      - custom: emergency-to-office
      - custom: homeowners-only
      - custom: in-service-area
      - confirmed: [problem, howUrgent, ownership, town, address, name, phone, heardFrom, day, timeOfDay, visitDate]
      - dateInRange: { field: visitDate, notBefore: today+1 }
```

`check: true` says the action is a question to the gate only: it has no tool, and an ALLOW runs nothing (`callTool` returns `value: null` and records the gate event with no `tool_result` row). It is not a probe purpose, so the matrix's purpose axis and every app's matrix golden stay as they are; a check action is printed as an ordinary action, only in apps that have one. The three rules are the trial's `defineRule`s, unchanged: written once, named in a check and in the booking.

One check with all three slots (`action: checkHome, with: [howUrgent, ownership, town]`) also works and keeps one action, as the trial had. It runs only when all three are filled, so a renter is asked the town and the urgency first. One check per answer refuses on the turn the answer is given; the patterns page should show both and say why.

### 4.3 Optional: `oneOf` and `noneOf` (open question 2)

The trial's "one of a list" gap (DESIGN.md, Gaps) needed three custom rules. Two built-ins would make the whole line YAML:

```yaml
  checkArea:
    say: check the home is in the service area
    check: true
    level: 0
    rules:
      - oneOf: { field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }
  checkUrgency:
    say: send an emergency to the office
    check: true
    level: 0
    rules:
      - noneOf: { field: howUrgent, values: [emergency], reason: emergency, verdict: NEEDS_HUMAN }
```

They fail closed like every rule: a missing or empty field refuses. `verdict` is BLOCK by default, or NEEDS_HUMAN. The policy card says them in words ("the town is Millbrook, Cedar Falls, Ashford or Riverton"). Repeating the line in `bookInspection` is two short lines; a top-level `rules:` map that names a rule once for many actions is a possible follow-up, not part of this.

### 4.4 When a check runs, in the turn

1. The turn fills slots as today (`fillSlots`, `correctingFill`, the keypad).
2. `continueForm`: a disambiguation and a slot read-back come first, so a check never runs on an unsettled value. Then `ensureEntry` (the entry call). Then **the checks**: each ready check whose params differ from the ones it last passed with is called through the gate, in the order written. The first refusal ends the turn with its outcome. Then `nextPrompt` as today.
3. `completeForm` runs the checks first too, before the `complete` hook. A yes that changed a checked value ("yes, but I rent") is caught by the check, with its own line, and the write is never attempted.
4. The params a check passed with are kept on the session (`s.checked`, by action: a hash of its params). The field is optional, absent until a form with checks runs one, and cleared by `setForm` and `closeForm`, so a session of an app without checks is the same shape as today. An unchanged yes calls no gate at all. A slot reopened and given the same value does not re-run its check.

### 4.5 What the trace, the console and the audit show

- Each check that runs is a gate event like any call: the action, the call as recorded (masked by `audit:` and slot `redact` as usual), the verdict, the reason, and each rule's compared line ("ownership rent: not the owner"). The trace and the console's audit list show it as they show an entry call.
- A check that ends the form adds one audit row, `form_stopped { form, action, reason, then }`, before `call_ended` or `handoff`. The form is not added to `completed`.
- No new row in the perception debug table: a check is not a perception gate. The console's NOW panel shows "stopped: checkOwner, not-owner" on the form, from the new row.

## 5. Behaviour, turn by turn (the trial app, rewritten)

Lines are the trial's or invented in its style. "Gate" is the recorded gate event.

### 5.1 The renter

| | Caller | Engine | Agent says |
|---|---|---|---|
| 1 | | greeting | "Thanks for calling Example Foundation Repair. How can I help?" |
| 2 | "There's water in my basement." | route `book_inspection`; `problem` = water; no check ready | "Sure, I can help you look into that and set up a free inspection. Do you own the home, or rent it?" |
| 3 | "I rent it." | `ownership` = rent; `checkUrgency` not ready; `checkOwner` ready. Gate: BLOCK not-owner. `on.not-owner`: end | "Thank you for calling. Our inspections are for homeowners, so I'm sorry we can't help with a rented home, but the owner is welcome to call us." then the goodbye |

Two questions. The town, the urgency and every booking slot are never asked. Audit: one gate row (BLOCK), `form_stopped`, `call_ended`. If the caller said "I'm renting and there's water in the basement" on turn 2, the check refuses on that same turn; since the form was entered on that turn, the engine drops its `ack_intent` ("Sure, I can help you...") so the caller does not hear yes and no in one breath.

### 5.2 The caller outside the area

| | Caller | Engine | Agent says |
|---|---|---|---|
| 2 | "There's a crack in my foundation." | route; `problem` = cracks | "Sure, I can help... Do you own the home, or rent it?" |
| 3 | "Yes, I own it." | `checkOwner` ALLOW (recorded, kept in `s.checked`) | "Which town is the home in?" |
| 4 | "Lakeview." | `town` = elsewhere; `checkArea`: BLOCK out-of-area; end | "Thank you for calling. We only work in Millbrook, Cedar Falls, Ashford and Riverton, so I'm sorry we can't help with a home outside them." then the goodbye |

### 5.3 Everything in one breath

Turn 2: "I own a house in Riverton, there's water coming into the basement and it's getting worse. Can someone come out on a Saturday morning?"

All ten slots listen from the first turn of the form, so this fills `problem`, `ownership`, `town`, `howUrgent`, `day` and `timeOfDay`. The three checks are ready and run in order: three gate events, all ALLOW. Every check has now passed, so `checksPassed` is said. "Sure, I can help you look into that and set up a free inspection. Good news, we work in Riverton, and the inspection is free. What's the address of the home?" The day and time are not asked again (trial entry 9 closed for this shape).

The same breath with one disqualifying answer: "I rent a place in Ashford, there's water seeping in and it's getting worse." `checkUrgency` ALLOW, `checkOwner` BLOCK not-owner: the renter line, the call ends, and `checkArea` never runs. The order of `checks` decides which line a caller with two reasons hears; put the one the business cares about most first (here the emergency, then ownership).

### 5.4 An emergency in the middle of qualifying

At "Which town is the home in?" the caller says "Oh no, water is pouring in right now."

- Usually the priority intent takes it (gates.ts, `priorityIntent` row `act:emergency:over:intentChange`): the form is left, the `emergency` form hands off, "That sounds urgent. I'm putting you through to our office right now." Checks play no part: the route comes before any fill. The handoff data carries what was collected (problem, ownership).
- If the priority reading is below its threshold, `howUrgent` still listens on every turn and fills `emergency`. `checkUrgency` is ready: NEEDS_HUMAN emergency, `on.emergency: { then: handoff }`, the same line on the same turn. The trial put the urgency question last so an emergency said in answer to it would reach the office; with checks the question order is free.

### 5.5 A correction at the summary

The summary: "Let me make sure I have that right. A free inspection for water in the basement at 12 Oak Hollow Road in Cedar Falls, on Monday the 21st in the morning, for Jordan Avery, and we'll call 317 555 0142 if anything changes. Shall I book it?"

- "No, wait, it's my landlord's house. I rent." The no carries a correction: `ownership` = rent, `continueForm`, `checkOwner` re-runs (its param changed): BLOCK, the renter line, the call ends. The confirmation was never armed and no write was attempted.
- "No, it's in Ashford." `checkArea` re-runs: ALLOW. Nothing extra is said (`checksPassed` is said once per form). The summary is read again with Ashford.
- "Yes, but I'm renting." The yes path goes to `completeForm`, which runs the checks first: `checkOwner` BLOCK, the renter line. Without that step the booking's own rules would still refuse it at the write, but with the engine's generic refusal rather than the check's line.
- "The town is wrong." The change question reopens `town`; the answer refills it and the check re-runs as above.

### 5.6 Carried slots and other forms

A check runs on whatever fills its slots, including a value carried from an earlier form (`carrySlots`, `listen: call`). A form entered with `ownership` already carried as rent refuses on the turn it is entered, before its first question. `s.checked` is per form, so a second form re-runs its own checks once (cheap, and recorded).

### 5.7 Partial and misheard answers

A check never runs on part of what it needs: `with` must all be filled, and the rules fail closed, so a missing param could only refuse. A value the model misreads ("my mom owns it, I'm helping her" read as rent) ends the call on a wrong answer. Today's tools for that are the slot's option wording (the trial's `own` option already says "or is calling for the owner"), `spokenConfirm: always` on the slot (which asks every caller), and corpus lines. Open question 4 asks whether to add `confirm: true` on an outcome: read the deciding slot back ("Just to check, you rent the home?") only when its check refuses, and reopen the slot on a no.

### 5.8 Identity, entry calls, priority intents, the confirmed rule

- Checks run after the entry call, so identity a form needs is proven first. A check action above level 0 is allowed only when the form's entry call already proves that level (`pnpm check`). At run time a `STEP_UP` from a check fails closed to a person.
- A check action may not list `confirmed` (nothing is confirmed mid-form), and `pnpm check` refuses one that does.
- Priority intents, the agent intent, a held partial and the injection screen all decide before fills, so before checks. Nothing about them changes.

## 6. Need 2, sketched for later (open question 3)

If an app later needs one booking form after several screeners:

```yaml
forms:
  waterproofing_screen:
    slots: [problem, ownership, town]
    summaryPromptId: null
    checks: [...]
    next: book_visit              # on completion (kind said), bridged into with bridge_next
    hooks: []                     # with next, no complete hook is needed
  book_visit:
    internal: true                # not an intent: never offered to the model, the keypad or the queue
    label: book your free inspection
    slots: [problem, ownership, town, address, name, phone, day, timeOfDay]
    ...
```

The engine owns the queue write; `pnpm check` refuses an internal form no `next` reaches, and a `next` to a form that is an intent. Until then patterns.md says never write `s.queued` from app code.

## 7. The trial app with checks

What changes against `trial/foundation-repair-run1`:

- **forms.yaml**: `book_inspection` and `schedule_inspection` become the one form in 4.1 (its summary is the old `confirm_schedule_inspection`, renamed). `emergency` and `warranty` stay.
- **intents.yaml**: `schedule_inspection` goes. `book_inspection` loses "asks to book or schedule... (a request to schedule is book_inspection's)" hedging; a request to schedule is simply this intent. The heuristics drop the schedule regex.
- **slots.yaml**: `listen: call` comes off the four qualifying slots (one form needs no carry).
- **policy.yaml**: `checkHome` becomes the three check actions in 4.2 (or 4.3 with the built-ins); `bookInspection` unchanged.
- **prompts.yaml**: unchanged lines (`home_qualifies`, `decline_renter`, `decline_out_of_area`, `handoff_emergency`); `bridge_next` is no longer heard on this line.
- **src/app.ts**: `completeQualify`, `homeParams`, the `checkHome` tool and the `s.queued.unshift` go. `turnAway` shrinks to `c.refusal`, since the check handles every reason it mapped before the write. `completeBooking`, `onSummaryRead`, `toOffice` and the three rules stay.
- **Fixtures**: the `schedule_inspection` corpus lines and the `schedule-by-name-renter` scripted call go; scripted calls for 5.1 to 5.5 come in; the baseline and the cassette are recorded again (the intents and the form's slot questions change).
- **The policy matrix**: `calls` for each check action (`checkOwner: { owner: { ownership: own }, renter: { ownership: rent } }`, and so on).

Counts: 3 forms (from 4), 10 intents (from 11), no engine field written by the app.

## 8. Backwards compatibility

- An app with no `checks` runs exactly the same code path: the check step finds nothing to do.
- Model requests: checks ask the model nothing. No question, criterion or caller field changes, so clinic, utility and the testkit replay their committed cassettes with no misses. Proof in the PR: each app's regress replay, zero misses, and `questions.snapshot.test.ts` unchanged.
- Sessions: `s.checked` is optional and absent unless a check ran, as `locale` is absent for an app without locales. The session round-trip tests and the testkit goldens are unchanged.
- Gate: `check: true`, `oneOf` and `noneOf` are new and optional. No new probe purpose, so `GRID_PROBES`, the matrix header and every app's `policy.matrix` golden are unchanged.
- Changed on purpose: the generated `schemas/*.json` and the schema snapshot. An app outside this repository takes the engine with a version bump and nothing else.
- For an app that uses checks, the model is asked something different only because of how the app is restructured: one form instead of two means one intent fewer in the intent question, and all the form's slot questions from its first turn. A new app built with checks from the start has nothing to re-record.

## 9. Validation (`pnpm check`)

Each with the file and the fix, as `check` already words its messages:

- `action` is an action in policy.yaml with `check: true`; a `check: true` action has no tool in the code, and is named by some form's `checks` (else it is unreached).
- Every `with` slot is one of the form's slots, not an identity factor slot, and appears once.
- Every `on` key is a reason the action can give: a built-in rule's reason, a `reasons:` override, or a reason one of a custom rule's examples expects. Otherwise a warning: the key can never match.
- `then` is one of the three; `say` is required for `end` and `anything-else`; each `say` and `checksPassed` line, and `handoff_<reason>` for a handoff, is in prompts.yaml in every locale.
- A check action lists no `confirmed` rule, and its level is 0 or at most what the form's entry call proves.
- A warning when a check action's rules are not also named by an action the form's hooks call (`calls`): the write would not hold what the check held.

## 10. Docs, skill, tests

**Docs.** The authoring guide's forms.yaml section gains `checks` and `checksPassed`, and section 3 gains `check: true` (and `oneOf`, `noneOf` if decided), with the two YAML blocks above (the doc block tests parse them). "Every form id must also be a form intent" stays true. The guide's turn walkthrough says where checks run.

**Skill.** patterns.md gains **"Qualify before you collect"**: the paragraph shape ("if they rent or are outside the area, say we can't help"), the one-form YAML of 4.1 and 4.2, one check per answer against one for the group, the order of checks, the defence-in-depth rule in the write, and "never write `s.queued`". worksheet.md gains the question "Does any answer rule the caller out before you collect the rest?". The known gap "a value said with the request for a different form is lost" says that one form with checks avoids it for this shape. corpus.md: a line per refusal at each point (asked, volunteered early, in one breath, at the summary).

**Tests.**

- Unit (core): readiness, the param hash, re-run only on change, order and first refusal, each `then`, the default for an unlisted reason, `checksPassed` once, `s.checked` cleared on close and switch, a tool-less ALLOW records with no `tool_result`.
- Unit (define): the schema, each `pnpm check` problem above, the policy card and app map for check actions, `oneOf` and `noneOf` with the gate's fail-closed cases.
- Turn (`turn.test.ts` on a small fixture app): 5.1 to 5.6, the keypad fill, the ack dropped on the entering turn, a carried value refused on entry, `STEP_UP` to a person.
- Scenario: a fixture app in the engine (the testkit or a new small "screened booking" fixture) with scripted calls for the renter, the out-of-area caller, one breath, the emergency both ways, and each summary correction; and the regress replays of clinic and utility unchanged.

## 11. Rough size

One new engine module (the check step, about 150 lines), small changes to `continueForm`, `completeForm`, `enterForm`, `callTool`, the session, the audit, the schema, defineApp and the checker, and the card, matrix and app map. `oneOf`/`noneOf` are a separate change of similar size to `limit`. Docs and the pattern, then the trial run again from the paragraph.

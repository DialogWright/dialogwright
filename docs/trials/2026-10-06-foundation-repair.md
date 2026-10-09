# Trial: the foundation repair line, from a paragraph to two recordings

Builder: an AI coding assistant (Claude Opus 5.5 in Claude Code) with no context from the people or sessions that built the framework, on the branch `trial/foundation-repair`. Instruction: "I want to build an IVR", then one paragraph; it followed the create-app skill (`.claude/skills/create-app/SKILL.md`). Unlike the first two trials, this one went past the green app: the owner recorded the app against the real decision model twice, and the builder triaged each recording. The company is fictional (Example Foundation Repair). The app was built on a local branch and is not committed to main (kept as the local tag `trial/foundation-repair-run1`): it is built around gaps this trial found, and the trial will be run again from scratch once they are fixed. The log is the evidence; commit hashes and file paths below refer to that tag.

## The paragraph

> We're a foundation repair and basement waterproofing company. Most people who call are homeowners with a problem: water in the basement, cracks in the foundation or basement walls, a wall that's bowing or leaning, a damp or musty crawl space or mold, concrete that's sunk or cracked like a driveway, patio or garage floor, or they want an egress window put in. The phone line's job is to find out what's going on and book a free inspection with one of our project specialists. It should find out what the problem is and how urgent it is, whether they own the home, the property address, and whether it's in our service area. We cover Millbrook, Cedar Falls, Ashford and Riverton. Get their name and a good callback number, ask how they heard about us, and offer a free estimate on a weekday or a Saturday, morning or afternoon. If water is pouring in right now, a wall looks like it's giving way, or they're an existing customer calling about a warranty, put them through to the office. Never quote a price or tell them what the fix will be over the phone; that's what the inspection is for. If they're outside our area or renting, thank them politely and let them know we can't help.

Its shape differs from the first two trials' on purpose: no verification at all, a caller qualified before anything is collected (an early "no" for a renter or a home outside the area), an emergency that must reach a person at once, and a booking whose day the line finds rather than the caller names.

## The trial in numbers

| | |
|---|---|
| Time to a green app | the scaffold at 16:54 (its files' time), the app committed at 17:11 (`b5e155e`); the reading and the worksheet came before the scaffold, and their start was not recorded |
| The app | 4 forms, 11 intents, 10 slots, 3 actions, 3 rules of its own; 173 corpus lines and 53 scripted calls at first |
| First stub regression | 46 of 50 scripted calls (the 4 failures: 1 the app's, 3 the builder's expectations or wording) |
| Framework source read because the docs were not enough | `core/app/types.ts` (FormDef, Completion, PolicyMatrix), `core/turn.ts` (completeForm, finishForm), `core/lifecycle.ts` (ensureEntry, the probes), `core/fia.ts` (where a slot listens), `core/gates.ts` (the in-form switch), `core/questions.ts` (intentChange), `harness-text/regressDiff.ts` (what a scripted call may drift on), `gate/defineRule.ts` |
| First recording | corpus 157/173, scripted calls 43/53 against the stub; 7 cents |
| After its triage | corpus 159/173 plus 14 tagged gaps; scripted calls 48/53 |
| Second recording (after criteria changes and the engine's priority intents) | corpus 163/174 plus 11 tagged gaps; scripted calls 53/54; 7 cents |
| The finding that mattered most | an emergency said in the middle of a form waited two questions, and one said half aside was ignored; the engine gained priority intents (`2d3271e`) the same afternoon |

## Log

Each entry: what the builder was doing, what it expected, what happened, what it cost, how it got past it, and the cause. "Worked well" marks what did. The **Fix:** lines are for the maintainer; three were fixed during the trial and say so.

### Building the app

1. Read the skill, worksheet.md, patterns.md, corpus.md, the slot types' README and pages, and the authoring guide's sections 1 to 3, 6 and 7. Worked well: the skill's order, and patterns.md as a near recipe for most of the app. The guide is too long to read in one call (it was paged by its headings). Cost: small. Cause: docs (known).
   **Fix:** open.
2. The paragraph wants a renter or a home outside the area told "we can't help" as soon as that is known, not after giving a name, a number and a day. Expected a way for a form to end part-way on an answer (a gate check when a slot fills, or a completion that leads to another form). There is none: a refusal comes only from an entry call, made before any slot, or from the completion. Read `core/app/types.ts`, `core/turn.ts`, `core/lifecycle.ts` and `core/decision.ts` to be sure, then built two forms in a row: the qualifying form's completion asks the gate (`checkHome`) and, when the home qualifies, puts the booking form at the head of the session's queue (`s.queued.unshift(...)`, `src/app.ts`), which the engine bridges into with `bridge_next`. The app writes a session field the engine owns. Cost: the largest of the build, most of it reading engine source. Cause: framework, and skill (no pattern for qualify-then-collect, a common shape for a phone line).
   **Fix:** open.
3. A consequence of entry 2: every form must be a `kind: form` intent, so the booking form is an intent the model is offered (`schedule_inspection`), which few callers say first. A caller who asked for it directly skipped the qualifying form, so its criteria were later narrowed to a caller who says they already qualified, and a request to schedule became the qualifying form's. Cost: small, plus corpus lines for an intent that exists for the engine. Cause: framework.
   **Fix:** open.
4. Designing the emergency: read `core/gates.ts` and saw that inside a form a request for another form is acted on only when the change question reads "replacing", and wondered whether "water is pouring in right now", said at "Do you own the home?", would read that way. Hedged: an `emergency` intent, a slot answer `howUrgent: emergency` held by a gate rule, and the urgency question last of the four, so an emergency said in answer to it reaches the office on that turn. The recording (entry 17) showed the doubt was right. Cause: framework.
   **Fix:** `2d3271e`: priority intents (`priority: true`), acted on the turn they are said, over the question in hand, a pending confirmation and side speech.
5. `pnpm create-app foundation-repair --display "Example Foundation Repair"`. Worked well: a green app in about a second, with next steps.
   **Fix:** no fix needed.
6. `pnpm check` refused the slot id `urgency`: it is one of the engine's own question ids (the urgency score). The message said so and how to fix it. Worked well (the message); the id was renamed `howUrgent`. A list of the reserved ids in the skill would have saved the rename. Cost: a minute. Cause: skill (minor).
   **Fix:** open.
7. First stub regression: 46 of 50 scripted calls. One failure was the app's: `weekdayIndex` counts Monday as 0, and the builder assumed Sunday (the function's comment says so; nothing an app reads first does). One was an expectation: "say that again" ends in `decision: replay`, which corpus.md's list of decisions does not name. Two were the next entry. Worked well: `regress --scenario <id>` made each failure plain in seconds. Cause: the builder's, and docs (minor).
   **Fix:** open.
8. A transcript showed "Goodbye. Goodbye.": a completion of kind `end` is followed by the engine's goodbye, and the decline lines said "Goodbye." themselves. The scaffold's own `service_booked` line ends "Goodbye." with an `end` completion, so the template probably says it twice too (not checked). Cost: a minute. Cause: scaffold and docs.
   **Fix:** open.
9. "Book me in for a Saturday morning" said on the opener lost the day and the time: the turn opens the qualifying form, which does not ask them. Tried `listen: anywhere` on both slots, which the docs describe as keeping a value said outside a form; it does not keep one said on the turn that opens another form (`core/fia.ts`, `slotsToFill`). Reverted; the day is asked again in the booking form (a scripted call pins it). Cost: a few minutes. Cause: docs, or framework.
   **Fix:** open.
10. The first policy matrix said `checkHome`: "every caller BLOCK not-owner". Plausible enough to accept: the grid builds an action's call from its subject param and its confirmed or fields list, and `checkHome` has neither, so it sent no answers and the rules failed closed. Found `calls` (named param sets per action) on `PolicyMatrix` in `core/app/types.ts`; with them the matrix shows every reason the paragraph gives (qualifies, emergency, renter, outside the area, a visit today). Worked well once set: the matrix is the clearest reading of the policy. Cost: a few minutes, and a near miss. Cause: skill (patterns.md does not mention `calls`).
    **Fix:** open.
11. The scaffold's test expects `runRuleExamples(app)` to equal `[]`, patterns.md shows it returning the list of examples, and the order is each example in every action, not each action's examples. Cost: a minute. Cause: docs (minor).
    **Fix:** open.
12. Made the baseline once and read it entry by entry as a table. Found one thing to change: an emergency caller heard "Sure, I can help you reach the office right away." before "That sounds urgent. I'm putting you through to our office right now." The no-slot handoff forms now drop the acknowledgement; the regression showed exactly the 28 entries expected, which were edited by hand and logged. Worked well: reading the baseline as a table, and a diff that named exactly the entries changed. Cause: skill (the no-slot handoff shape could say to drop the acknowledgement).
    **Fix:** open.
13. The framework's wording test refused "claim" (one industry's word) in a corpus line and in the worksheet. Reworded. Cost: a test run. Cause: framework test.
    **Fix:** `fce64a3`: the test refuses only the one name and em dashes.
14. `pnpm check`, `pnpm verify` and every regression green; the regression added to CI; committed (`b5e155e`).

### Handing over the recording

15. The skill says never to record, so the builder handed the owner the command, without loading the key: the scaffold's README loads `.env` in the app's folder (step 1) and records at the repository root (step 2), and the builder kept only step 2. The owner's first run sourced another app's `.env`, which failed on its line 11 (`command not found: tokens-played`): a value a shell cannot read as written, in a file that the README tells people to source. The owner's other session gave the right command: `(set -a && . apps/<name>/.env && set +a && pnpm --filter <package> regress --client record --threshold JEV_TIMEOUT_MS=15000)`. Cost: a run. Cause: skill and scaffold README (two steps in two folders), and possibly `pnpm configure` (a `.env` that is not shell-safe; not examined, since the file holds keys).
    **Fix:** open.

### The first recording

16. First recording (`d29c1a0`): corpus 157/173, scripted calls 43/53. The skill has no step for what to do next. The procedure was assembled from the clinic's README ("Known gaps"), [docs/known-gaps.md](../known-gaps.md) and `harness-text/regressDiff.ts`: three buckets (the label was wrong; the model reads a borderline line otherwise; a scripted call whose path an incidental line changed), and that a scripted call has no allowance but `cosmeticDrift`, so a call that tests a real gap stays failing. To see why a line drifted, the builder read the cassette's JSON with Python: nothing prints a line's model answers. And a recorded run with mostly allowed differences still exits 1, with the allowed and the unallowed interleaved. Cost: the largest of the trial after entry 2. Cause: skill (no triage step) and tooling.
    **Fix:** open.
17. What it found. Two labels were wrong (the model was right). Fourteen lines were read otherwise than meant, tagged with their caller impact. The keypad-menu calls opened with "um", which the model ignores, so the menu was never offered; they now open with two silences, which count as misses with no model call. The two that mattered: "actually, water is pouring in right now", said at the ownership question, read emergency 0.91 but "answering" 0.77, so the form asked two more questions before the office; "hold on, the wall just started giving way", said while booking, read as not addressed to the line (0.52) and was ignored. Neither was the app's to fix: the change question's wording is the engine's. Worked well: `knownGap` tags with a reason and a pinned outcome, and the stub and the recording side by side. Cause: framework.
    **Fix:** `2d3271e` (the emergency); `93a3b0a` (the skill: a keypad call opens with "okay"; this trial used silences, which no recording can change).
18. The owner asked for the app's own fixes. The criteria of four intents were reworded (`1d2c627`), which changes every request (every turn carries the intents' criteria), so the cassette could no longer replay at all. When priority intents landed, the flag changes no request, and could have been checked on the existing recording at once; it was checked only by restoring the pre-change `intents.yaml` for a replay (`c68e1fe`). The order matters: check what changes no request (code, the engine's options) on the recording you have, then reword, then record again. Cause: skill (no order given).
    **Fix:** open.
19. Two baseline entries added by hand for a new line and call (the skill's "in the shape of its neighbours"): nothing prints one entry's outcome, so the builder wrote a throwaway script over `runAll`, which first failed with "no app registered" until it imported the app's test setup. Cost: a few minutes. Cause: tooling.
    **Fix:** open.

### The second recording

20. Second recording (`642cdd1`): corpus 163/174 plus 11 tagged, scripted calls 53/54. Five gaps closed (the run said `knownGap now matches` for each). The emergency on the turn it is said everywhere: 0.91 to 0.95 mid-form, 0.89 to 0.90 half aside, 0.93 to 0.94 at the read-back, and no other line read emergency at 0.5 or more. One new borderline line, a cost of the reworded criteria. Worked well: `knownGap now matches`, and the cost (seven cents a recording).
    **Fix:** no fix needed.
21. Three tooling gaps the second triage met. Recording appends, so the first recording's 275 answers stayed in the cassette though no replay reads them, and the builder found no command to prune them: it looked for a flag in `regress.ts`. The engine has had one since its first commit, `cassetteTrimMain` (`harness-text/cassetteTrim.ts`, exported by `dialogwright`): it replays the whole run from the cassette and keeps only the answers it asks for, writing nothing if a request misses. No app, template, doc or skill mentions it; the owner pointed to it, and the app now has `pnpm cassette:trim` (`src/cassetteTrim.ts`): 552 answers, 277 kept, and the replay after it unchanged with no misses. Two borderline lines gave a different outcome from the first recording ("um", "ready to book the day"), and a tag pins only one, so each re-recording re-pins lines that did not really change. And, as in entry 16, the run's output had to be filtered by hand to see what needed a decision. Cause: tooling (the pins and the summary), and docs and scaffold (the trim exists but nothing says so).
    **Fix:** open; the app's own launcher for the trim is in this trial's last commit.

## What worked well

- `pnpm create-app`: a green app in a second, whose comments explain each hook.
- `pnpm check`: every message said what was wrong and the fix, including the reserved slot id.
- `regress --scenario <id>` and `--corpus <id>`: every failure understood from its transcript in under a minute.
- The policy matrix, once its calls were named: it reads the paragraph's rules back (an emergency to the office whoever calls, a renter refused, a visit today refused) in a form a reviewer can check cell by cell.
- The stub and the recording side by side, with `knownGap` tags and `knownGap now matches`: the triage was concrete, every difference sorted into a bucket with numbers.
- The turnaround on the one finding that mattered: the emergency was found in the first recording, the engine gained priority intents, and the second recording confirmed it, in about forty minutes of the afternoon.

## Summary of stumbles by cause

| Cause | Entries | Notes |
|---|---|---|
| Framework | 2, 3, 4, 9, 17 | two forms and a session field written by the app (2, 3); the emergency (4, 17, fixed); `listen` on the opener (9, or docs) |
| Skill | 2, 6, 10, 12, 15, 16, 18 | no qualify-then-collect pattern; reserved ids; `calls` in the matrix; the no-slot handoff's acknowledgement; the recording command; no triage step; the order of fixes |
| Tooling (regress and the cassette) | 16, 19, 21 | a line's model answers, one entry's outcome, pins of one outcome, a summary of what needs a decision; the trim exists but no app or doc names it |
| Docs | 1, 7, 8, 9, 11 | the guide's length; `replay`; the goodbye after `end`; `listen: anywhere`; `runRuleExamples` |
| Scaffold | 8, 15 | `service_booked`'s goodbye (unchecked); the README's two-folder recording steps |
| Framework test | 13 | fixed |

## The changes that would help most

1. **Qualify, then collect.** A way for a form to end on an answer, or for a completion to lead to another form, with a pattern in patterns.md. Every phone line that screens before it books meets entry 2, and the workaround writes engine state from app code.
2. **A step in the skill for after the first recording.** The command to hand the owner, whole and copyable, `.env` included; the three buckets; that a scripted call has no allowance but `cosmeticDrift`; and the order: check what changes no request on the recording you have, then reword, then record once.
3. **Recording tooling.** A last line that counts the untagged differences and the failing calls; a way to print a line's model answers (`regress --corpus <id>` against the cassette, with the probabilities); one entry's outcome as JSON, for a baseline entry added by hand; the cassette trim in the scaffold (a `cassette:trim` script beside `regress`) and in the recording steps, since it exists and nothing names it; and a tag that allows any of a few outcomes for a line that flips.

Smaller: `calls` for the policy matrix in patterns.md (entry 10); drop the acknowledgement in the no-slot handoff shape (entry 12); the goodbye after an `end` completion, in the docs and possibly the scaffold (entry 8); what `listen: anywhere` keeps (entry 9); a list of the engine's reserved slot ids (entry 6); a `.env` the README's `source` can read (entry 15).


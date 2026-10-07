# Triage a recording

The owner has recorded the app against the real decision model (step 9 of the skill), and the cassette is in `apps/<name>/fixtures/recorded/<model>.jsonl`. This page is what you do with it: read the run, sort every difference into one of three buckets, fix what is the app's in the right order, and bring the rest to the owner. You never record, and you never handle the key. Replaying the cassette calls nothing and costs nothing, so replay as often as you need.

## Read the run

At the repository root:

```sh
pnpm --filter @dialogwright/example-<name> regress --client recorded
```

It replays the model's answers from the cassette and compares each outcome with the stub baseline (`fixtures/expected/*.json`), which is the labels' truth. What it prints:

| Line | What it means |
|---|---|
| `~ corpus <id>.<field>: <before> -> <after>` | The model read the line otherwise than its label, on that field. |
| `... (allowed: knownGap: <reason>)` | A difference a tag already allows: the line shows the outcome its `knownGap` pins. |
| `... (knownGap pins <value>)` | A tagged line that now gives yet another outcome: a finding, as for an untagged one. |
| `knownGap now matches: <id>` | A tagged line the model now reads as labelled: the tag can go. |
| `FAIL scenario <id>: ...` | A scripted call that did not reach what it expects. |
| `... (allowed: cosmeticDrift)` | A scripted call marked `cosmeticDrift` that reached the same end by another gate. |
| a cassette miss | A request the cassette does not hold: what the model is sent has changed since the recording. |

The last line counts what is left to decide:

```text
to triage: 3 untagged corpus differences, 2 failing scripted calls, 1 passing scripted call that differs from the baseline, 0 cassette misses
```

A recorded run with differences exits 1 even when most of them are allowed, so read that line, not the exit code. You are done when the untagged differences are 0, the failing scripted calls are only the ones you report to the owner (below), and the misses are 0.

To see why one entry differs, ask for it by id. Never read the cassette's JSON by hand:

```sh
pnpm --filter @dialogwright/example-<name> regress --client recorded --corpus <id>      # the line's turn and the model's answers, with their probabilities
pnpm --filter @dialogwright/example-<name> regress --client recorded --scenario <id>    # the call turn by turn
pnpm --filter @dialogwright/example-<name> regress --corpus <id> --json                 # one entry's outcome as JSON, in the baseline's shape
```

`--corpus <id>` shows each question the model was asked and its answer (the intent's probabilities, `addressedToSystem`, each slot's questions), so you can say in numbers why a line went the way it did: "emergency 0.91, but the change question read answering 0.77". `--json` gives the outcome to paste when you add or edit a baseline entry by hand.

## The three buckets

Every untagged difference and every failing scripted call goes into exactly one.

**1. The label was wrong, and the model is right.** The line says what the model heard, and your label said something else ("I rent it, but my landlord said to call" is labelled `own`). Fix the label in `fixtures/corpus.jsonl`. The stub's outcome for that line changes with it, so the stub regression shows `~` lines for that entry: check they are exactly the ones you meant, edit the entry in `fixtures/expected/corpus.json` by hand to the new values (`regress --corpus <id> --json` prints them), and log the edit under "Baseline edits" in `DESIGN.md` with the reason. Never `--update`.

**2. The model misread a borderline line, and the label is the truth.** The caller meant what the label says, and the model reads it otherwise, or on the edge of a threshold. Keep the label, and tag the line with a `knownGap`: the reason, with the model's numbers and what the caller hears because of it, and the outcome fields the model gives instead:

```json
{"id":"ag-02","text":"Agent","intent":"agent","context":"no_form","knownGap":{"reason":"a single word: addressedToSystem 0.60 on the 0.65 gate, so the turn is ignored; the caller asks again","outcome":{"decidedGate":"intent"}}}
```

A line that gives one outcome on one recording and another on the next (a reading close to a threshold) lists each it may give, under `outcomes`, so a re-recording does not re-pin a line that did not really change:

```json
"knownGap":{"reason":"...","outcomes":[{"decidedGate":"addressedToSystem"},{"decidedGate":"intent","promptId":"ask_problem"}]}
```

A stub run ignores the tag and still holds the line to its label. List each tagged line in the worksheet's Gaps, with its caller impact.

**3. A scripted call broke on an incidental line.** The call tests something else (the keypad menu, a refusal, a handoff), and a step on the way there read otherwise. Change the incidental step, not the expectation. The common one: a keypad-menu call that opens with words the model may ignore as not addressed to the line, so the menu is never offered. Open it with silences instead (`{ "silence": true }`, [patterns.md](patterns.md#keypad-entry)): a silence is a miss with no model call, so no recording can change it. Other cases: a call that reaches a form through a borderline opener can open with one of the form's plain corpus lines. If the call's outcome in the stub baseline moves, edit its entry in `fixtures/expected/scenarios.json` by hand and log it.

**A scripted call has no allowance but `cosmeticDrift`.** There is no `knownGap` for a call: the only thing a recorded call may differ in is which gate decided and its verdict, and only when the call says `"cosmeticDrift": true`. So a call whose real subject is a gap (an emergency said mid-form that the model reads as an answer) stays failing. Do not reword its steps or move its expectation to make it pass: it is the evidence, and you report it to the owner.

## The order of the fixes

Every request the model is sent carries the intents' criteria, the slots' questions and the lines just played, so a change to those words re-keys the whole cassette: after it, the replay misses everywhere and checks nothing. So:

1. **First, everything that changes no request, checked on the recording you have.** Code (a hook, a completion, a custom rule), the policy, a flag the engine reads without sending it (an intent's `priority: true`, say), a scripted call's silences and keys, a label in the corpus (bucket 1), a `knownGap` tag (bucket 2). After each, replay: `0 misses` on the "to triage" line says the change sent nothing new, and the run shows what it did against the real model's answers. Get every one of these right before the next step: this is the only time they can be checked on a real recording for free.
2. **Then reword, all at once.** The intents' criteria, a slot's `what`, the app's `wording`: everything you want to change about what the model is asked, in one change. The stub regression must still be green (the stub reads labels, not criteria). The replay will now miss: that is expected.
3. **Then ask for one re-record.** Hand the owner the same command as before (step 9), whole, and say what changed and why. One recording for all the rewording, not one for each.
4. **Then trim the cassette**, once the new recording is in: `pnpm --filter @dialogwright/example-<name> cassette:trim`. Recording appends, so the first recording's answers stay in the file though no replay reads them. The trim replays the whole run from the cassette and keeps only the answers it uses, and writes nothing if a request misses. Replay again: the run should be the same, with 0 misses. Then run the app's own tests (`pnpm --filter @dialogwright/example-<name> test`): the trim keeps what one whole `regress` replay asks for, so a test that replays the cassette another way (another screen mode, a shadow or round-trip test) can need an answer it dropped. If one fails, restore the file (`git checkout -- fixtures/recorded`) and keep the untrimmed cassette.
5. **Triage the new recording the same way.** Remove each tag the run says `knownGap now matches` for; a line a new criteria wording made borderline is a new entry for bucket 2.

## What to bring to the owner

Some findings are not yours to fix: the app cannot change the engine (you never edit `packages/dialogwright`), and the owner decides what the line should do. Bring them as a short table, after the app's own fixes are in:

| Entry | What the caller says | What the model reads (numbers) | What the caller hears | Whose fix | Candidate |
|---|---|---|---|---|---|
| `emergency-mid-form` | "actually, water is pouring in right now", at the ownership question | emergency 0.91, change question answering 0.77 | two more questions before the office | the engine's (the change question's wording) | act on an emergency the turn it is said |

- **An engine gap**: the decision is the engine's (a threshold, a gate, the wording of one of its own questions, what a slot keeps). Give the numbers and the caller impact; the scripted call that shows it stays failing until the engine changes.
- **A label the paragraph does not settle**: does "power outage" alone mean no power? The owner says what is true; you then label it so, and it falls in bucket 1 or 2.
- **A rewording that needs a recording**: what you would change, what it should fix, and that it costs one re-record.
- **The cost**: a recording of an app this size has cost a few cents; say how many re-records your fixes need, so the owner can plan them.

Write the triage in the worksheet's "Recordings" section: the run's numbers before and after, each bucket's entries, and what is waiting on the owner.

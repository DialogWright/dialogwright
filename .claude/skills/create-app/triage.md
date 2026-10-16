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
| `... (allowed: knownGap: <reason>)` | A difference a tag already allows: the line (or the scripted call) shows the outcome its `knownGap` pins. |
| `... (knownGap pins <value>)` | A tagged line that now gives yet another outcome: a finding, as for an untagged one. |
| `knownGap now matches: <id>` | A tagged line the model now reads as labelled: the tag can go (`knownGap now matches: scenario <id>` for a scripted call). |
| `FAIL scenario <id>: ...` | A scripted call that did not reach what it expects. |
| `... (allowed: cosmeticDrift)` | A scripted call marked `cosmeticDrift` that reached the same end by another gate. |
| a cassette miss | A request the cassette does not hold: what the model is sent has changed since the recording. |
| `model reading, adversarial <id>: ...` | The model read an injection or an off-scope request of the adversarial suite otherwise than a correct model would. It fails nothing: list it for the owner. |

The last line counts what is left to decide:

```text
to triage: 3 untagged corpus differences, 2 failing scripted calls, 1 passing scripted call that differs from the baseline, 0 cassette misses
```

A recorded run with differences exits 1 even when most of them are allowed, so read that line, not the exit code. You are done when the untagged differences are 0, the failing scripted calls are only the ones you report to the owner (below), and the misses are 0.

To see why one entry differs, ask for it by id. Never read the cassette's JSON by hand:

```sh
pnpm --filter @dialogwright/example-<name> regress --client recorded --corpus <id>      # the line's turn and the model's answers, with their probabilities
pnpm --filter @dialogwright/example-<name> regress --client recorded --scenario <id>    # the call turn by turn, without the model's answers
pnpm --filter @dialogwright/example-<name> regress --corpus <id> --json                 # one entry's outcome as JSON, in the baseline's shape
```

`--corpus <id>` shows each question the model was asked and its answer (the intent's probabilities, `addressedToSystem`, each slot's questions), so you can say in numbers why a line went the way it did: "emergency 0.91, but the change question read answering 0.77". `--json` gives the outcome to paste when you add or edit a baseline entry by hand. `--scenario <id>` prints the turns and the differences but no numbers (nor does `--json`): for a step's, run `--corpus <id>` on the corpus line with the same words, said in the same place. Neither prints a question's words or the bar a reading missed ("After a live call", step 4, says where they are).

## The three buckets

Every untagged difference and every failing scripted call goes into exactly one.

**1. The label was wrong, and the model is right.** The line says what the model heard, and your label said something else ("it's my mum's house, but I live there too" is labelled `business`). Fix the label in `fixtures/corpus.jsonl`. The stub's outcome for that line changes with it, so the stub regression shows `~` lines for that entry: check they are exactly the ones you meant, edit the entry in `fixtures/expected/corpus.json` by hand to the new values (`regress --corpus <id> --json` prints them), and log the edit under "Baseline edits" in `DESIGN.md` with the reason. Never `--update`.

**2. The model misread a borderline line, and the label is the truth.** The caller meant what the label says, and the model reads it otherwise, or on the edge of a threshold. Keep the label, and tag the line with a `knownGap`: the reason, with the model's numbers and what the caller hears because of it, and the outcome fields the model gives instead:

```json
{"id":"ag-02","text":"Agent","intent":"agent","context":"no_form","knownGap":{"reason":"a single word: addressedToSystem 0.60 on the 0.65 gate, so the turn is ignored; the caller asks again","outcome":{"decidedGate":"intent"}}}
```

A line that gives one outcome on one recording and another on the next (a reading close to a threshold) lists each it may give, under `outcomes`, so a re-recording does not re-pin a line that did not really change:

```json
"knownGap":{"reason":"...","outcomes":[{"decidedGate":"addressedToSystem"},{"decidedGate":"intent","promptId":"ask_problem"}]}
```

A stub run ignores the tag and still holds the line to its label. List each tagged line in the worksheet's Gaps, with its caller impact.

**3. A scripted call broke on an incidental line.** The call tests something else (the keypad menu, a refusal, a handoff), and a step on the way there read otherwise. Change the incidental step, not the expectation. The common one: a keypad-menu call that opens with words the model may ignore as not addressed to the line, so the menu is never offered. Open it with silences instead (`{ "silence": true }`, [patterns.md](patterns.md#keypad-entry)): a silence is a miss with no model call, so no recording can change it. Other cases: a call that reaches a form through a borderline opener can open with one of the form's plain corpus lines. A changed step re-keys the call's later turns (below), so only the stub checks it until the next recording. If the call's outcome in the stub baseline moves, edit its entry in `fixtures/expected/scenarios.json` by hand and log it.

**A scripted call's allowances: `cosmeticDrift`, and a `knownGap` the owner accepted.** A recorded call may differ in which gate decided and its verdict when it says `"cosmeticDrift": true`. A call the model ends elsewhere can carry a `knownGap`, in a corpus line's shape, but only when the owner has accepted that end as safe (the request checked with one more yes or no, say): bring it to the owner with the model's numbers and what the caller hears, and tag it once they agree:

```json
"knownGap":{"reason":"\"sure, okay\" read at 0.55, so the request is checked with a yes or no first: one more question, safe","outcome":{"promptId":"confirm_intent_explicit","acks":[],"form":null}}
```

The outcome is the fields of the call's end that differ from the baseline's (`regress --client recorded --scenario <id>` prints them as `~` lines); a replay that ends exactly there is not a failing call, and any other end still fails. Each field is laid over the baseline's outcome whole, so a difference in one slot pins the whole `slots` object, every slot as the model left it (`"outcome":{"slots":{...}}`), not the one slot alone. A stub run ignores the tag. A call whose real subject is a gap that is not safe (an emergency said mid-form that the model reads as an answer) is never tagged: it stays failing. Do not reword its steps or move its expectation to make it pass: it is the evidence, and you report it to the owner.

**A passing scripted call that differs from the baseline** (the "to triage" line counts it) reached what it expects, but by another way or with other values (its slots, say). Sort it as a failing one: a bucket where the difference is the app's to fix, else to the owner, and a `knownGap` only once they accept its end as safe.

## The order of the fixes

Every request the model is sent carries the intents' criteria, the slots' questions and the lines just played, so a change to those words re-keys the whole cassette: after it, the replay misses everywhere and checks nothing. So:

1. **First, everything that changes no request, checked on the recording you have.** Code (a hook, a completion, a custom rule), the policy, a flag the engine reads without sending it (an intent's `priority: true`, say), a label in the corpus (bucket 1), a `knownGap` tag (bucket 2). After each, replay: `0 misses` on the "to triage" line says the change sent nothing new, and the run shows what it did against the real model's answers. Get every one of these right before the next step: this is the only time they can be checked on a real recording for free. A changed step of a scripted call (spoken, keyed or a silence: bucket 3) is not among them: each later request of the call carries the turns before it, so its later spoken turns miss until the re-record, and only the stub checks the change. The `0 misses` check holds for the others only. Then commit the cassette with these fixes, so the commit is the triage checked on the recording.
2. **Then reword, all at once.** The intents' criteria, a slot's `what`, the app's `wording`: everything you want to change about what the model is asked, in one change, and a commit of its own. The stub regression must still be green (the stub reads labels, not criteria). The replay will now miss: that is expected.
3. **Then ask for one re-record.** Hand the owner the same command as before (step 9), whole, and say what changed and why. One recording for all the rewording, not one for each.
4. **Then trim the cassette**, once the new recording is in: `pnpm --filter @dialogwright/example-<name> cassette:trim`. Recording appends, so the first recording's answers stay in the file though no replay reads them. The trim replays the whole run from the cassette and keeps only the answers it uses, and writes nothing if a request misses. Replay again: the run should be the same, with 0 misses. Then run the app's own tests (`pnpm --filter @dialogwright/example-<name> test`): the trim keeps what one whole `regress` replay asks for, so a test that replays the cassette another way (another screen mode, a shadow or round-trip test) can need an answer it dropped. If one fails, restore the file (`git checkout -- fixtures/recorded`) and keep the untrimmed cassette.
5. **Triage the new recording the same way.** Remove each tag the run says `knownGap now matches` for; a line a new criteria wording made borderline is a new entry for bucket 2.

## What to bring to the owner

Some findings are not yours to fix: the app cannot change the engine (you never edit `packages/dialogwright`), and the owner decides what the line should do. Bring them as a short table, after the app's own fixes are in:

| Entry | What the caller says | What the model reads (numbers) | What the caller hears | Whose fix | Candidate |
|---|---|---|---|---|---|
| `emergency-mid-form` | "actually, I can smell gas right now", at the street question | emergency 0.91, change question answering 0.77 | two more questions before the emergency line | the engine's (the change question's wording) | act on an emergency the turn it is said |

- **An engine gap**: the decision is the engine's (a threshold, a gate, the wording of one of its own questions, what a slot keeps). Give the numbers and the caller impact; the scripted call that shows it stays failing until the engine changes.
- **A label the paragraph does not settle**: does "power outage" alone mean no power? The owner says what is true; you then label it so, and it falls in bucket 1 or 2.
- **A rewording that needs a recording**: what you would change, what it should fix, and that it costs one re-record.
- **The cost**: a recording of an app this size has cost a few cents; say how many re-records your fixes need, so the owner can plan them.

Write the triage in the worksheet's "Recordings" section: the run's numbers before and after, each bucket's entries, and what is waiting on the owner.

## After a live call

A live call finds what no recording does: a message the carrier splits in two, a trailing "thanks" that tips a reading under its bar, a bare "yes" read as a message, a read-back talked over mid-number. The owner makes the calls; you work from what they share (the call's trace and frame log, or what the console shows). The method is [chapter 17 of the guide](../../../docs/guide/17-tuning-with-live-calls.md), in these steps:

1. **Keep the words readable.** An app whose records keep no caller's words (a `text` slot's `redact: length-summarized`) cannot be tuned from its traces. Suggest the owner tunes on a private copy outside the repository with that slot's `redact: none` and its param declared under policy.yaml's `audit` (`message: keep`; `pnpm check` asks for it, with the fix). Leave the shipped app's records as the owner chose them ([17.2](../../../docs/guide/17-tuning-with-live-calls.md#172-keep-the-callers-words-visible-while-tuning)).
2. **Find the turn.** The call's trace is `<TRACE_DIR>/<call>.jsonl` and its frame log `<call>.frames.jsonl` (a Telnyx call's `v3:...` id is the file `v3_...`). On the console's replay, step to the turn and open the perception panel's **Show all**: which question decided, at what reading, against which bar. The slot the line asked for is always shown open ([17.3](../../../docs/guide/17-tuning-with-live-calls.md#173-read-a-call-in-the-console)).
3. **Make it a test.** Write the turn as a corpus line or a scripted call, with the live reading as the line's `answers` where the stub would read it otherwise (`"answers": {"messageGiven": {"noul": 0.6}}`). Its expected entry is written by hand from `regress --corpus <id> --json` (or `--scenario <id> --json`) and logged under "Baseline edits"; never `--update` once the app is recorded. The new entry is not in the recording yet: its replay misses until the next one.
4. **Suspect the question first.** A plain line read near 0.5 is a coin toss: read the whole question it was asked (the engine's template and the app's `what`, `instructions` or criteria) for two rules that pull apart. `regress --client recorded --corpus <id>` prints each question's id and answer, not its words: a slot type's question is on its page, under "The question" ([docs/slots/](../../../docs/slots/README.md)); the engine's own (`intentChange`, `wantsHuman`, ...) are in `packages/dialogwright/src/core/questions.ts`, and the bars in `core/thresholds.ts` beside it. Word it for the common case, not the rare one ([17.4](../../../docs/guide/17-tuning-with-live-calls.md#174-a-score-near-05-is-a-coin-toss-suspect-the-question-first)). A question of the engine's own is the owner's to take further (the table above), not yours to edit.
5. **Fix in the order above**: what sends nothing new first, checked on the recording there is; then every rewording at once, on a branch.
6. **Hand over one recording** (step 9's command), then triage it as this page says. A branch whose recorded run is red stays local: CI replays the committed recordings. A cassette miss is never tagged.
7. **Write it down** in the worksheet's "Recordings": the call, what it showed (with the readings), the fix, and what the next recording should show.

# Knowledge-base answers in generated wording

Date: 2026-10-16. Status: **a proposal for the maintainer's decision; nothing built.** It changes a rule in CLAUDE.md, so it is decided before anything is built.

## The problem

A knowledge base's answer is a passage a person approved, said word for word. That is what makes it safe, and it is also what makes it stiff. The passage is written once for every caller who asks about its topic, so:

- it answers the topic, not the question: a caller who asks "does it cover the ambulance if I hurt myself skiing?" hears the whole ambulance passage, and has to find the yes in it;
- it is as long as its fullest case: a passage that must cover the limits, the exclusions and how to file is long to hear on a phone, though the caller asked one thing;
- it sounds read out, next to lines that a form may now word for the moment (Phase 9).

Harbor Mutual, rebuilt on 2026-10-16, is the app this shows best: 14 topics, 29 passages over two plans and two plan years, answered from the member's own plan.

## What exists

- **Passages and approval** (the guide's section 12): each passage is approved by a person against its source; a passage whose text or source changes is withheld until it is approved again.
- **`risk` on a topic** (`kb/topics.yaml`): `regulated` (the default) or `low`. Its schema already says what it is for: "low: a later release may let an app answer the long tail in generated wording grounded in approved passages". Nothing reads it yet.
- **Generated wording** (Phase 9, the guide's section 16): a line is generated only where the app asks; a framed line keeps its fixed words and generates only a span (`generate: { <span>: { from, goal, words } }`); code checks data and shape (every value word for word, no figure or capitalized name it was not given, the word budget, style.yaml's `avoid`); the drift judge (the decision model) decides meaning; the fixed text is said whenever a check fails or the model is slow; `prescribed: true` keeps a line exact; the policy card lists every generated and prescribed line; `render:judge-eval` measures the judge on labelled cases.

So nearly every piece is there. What a summary of a passage needs is a span whose source is the answer rather than the caller's words, and the judge holding it to the passage.

## The proposal

**An answer may be worded for the caller's question, from its approved passage, where the app asks for it and the topic allows it. Both must hold.**

1. **The topic allows it.** Only a topic marked `risk: low` may have its answer worded. `regulated` (the default) keeps today's behaviour exactly. Which topics are low risk is the app designer's call, never the framework's (an insurer may decide coverage amounts are regulated and the filing deadline is not).
2. **The line asks for it.** The answer line becomes a framed line whose span is the answer, generated from the passage:

   ```yaml
   coverage_answer:
     text: "{answer}"
     generate:
       answer:
         from: answer        # the approved passage, as resolved for this caller
         goal: Answer the member's question from their plan's passage, in a sentence or two.
         words: 40
   ```

   `from: answer` is new: today `from` names a slot (the caller's words). Here it names the passage the knowledge completion resolved, with the caller's question beside it.

3. **What the model is given.** The goal, the passage (the approved text, as it would be said), the caller's question in their words, and the sentence with its blank. Never a procedure for the words ([CLAUDE.md](../../CLAUDE.md): a generating or judging model is given the goal and the full context). Nothing else: no record, no other passage, no transcript.
4. **What holds it to the passage.**
   - The checks that exist, with the passage as what was given: every figure in the wording must be in the passage (an amount, a day count, a limit), and every capitalized name (a plan, a document); the word budget; style.yaml's `avoid`.
   - The drift judge, given the goal, the passage, the question and the wording, answers whether the wording says only what the passage says for this question: nothing added, no condition, limit or exclusion that changes the answer left out, nothing turned around. Its cutoff is style.yaml's `judge.refuseAt`, as for a span.
5. **The fallback** is the passage word for word, whenever a check fails, the judge refuses, the model errs or is slow, or the topic is regulated. The caller always hears either the approved passage or a wording the checks and the judge passed.
6. **The record.** The knowledge record (`TurnOut.kb`) keeps the passage's id, version and approval hash as today, and says whether the passage or a wording of it was said; the trace and the console show the wording beside the passage, as a framed line's span is shown today.
7. **The policy card** lists every topic whose answer may be worded, with the line and its goal, beside the generated and prescribed lines it already lists, so a reviewer sees what a model may word.
8. **The account line** ("You've used {used} of them this year.") stays a fixed line after the answer: it is the caller's own data, and Phase 9's rule that a model is never sent a value the records hide holds.

## What it does not do

- **A model never writes a passage.** Approval stays a person's, of the passage; drafting still only proposes into `kb/pending`, never read at run time.
- **No answer without a passage.** A question no topic answers still hears the unavailable line and is offered a person. Answering the long tail (a question near a topic but not its own) from approved passages is a later step, measured on its own, if this one holds.
- **Not two passages at once.** Two-part questions stay where they are (one topic a turn).

## The rule it changes

CLAUDE.md today: "A knowledge base's answers are fixed text, said word for word. A model never writes or rewrites one: it may only choose which topic a caller asked about (the `topic` slot), and a drafting tool may only propose a passage into `kb/pending`, which is never read at run time."

Proposed: "A knowledge base's answers are approved passages, said word for word, unless the app marks the topic `risk: low` and the answer line generates from the answer (`from: answer`): then a model may word the approved passage for the caller's question, held to it by the checks and the drift judge, and the passage is said whenever one fails. A model never writes a passage: it may only choose which topic a caller asked about (the `topic` slot), word an approved passage where the app allows it, and a drafting tool may only propose a passage into `kb/pending`, which is never read at run time."

## Measuring it

- **The judge first.** Labelled cases for `render:judge-eval`: for each of Harbor's passages, wordings that are faithful (shorter, focused on a question, in other words) and wordings that are not (a wrong figure, a dropped exclusion, a condition turned around, a limit made unlimited, a promise the passage does not make, the other plan's figure). The judge's catch rate on the unfaithful and its refusal rate on the faithful decide whether this ships, and at which `refuseAt`.
- **Then the app.** Harbor with a few topics marked low, recorded with the render model the maintainer chooses (`render:bakeoff`), its latency against the call's budget (900 ms for the wording, 500 ms for the judge), and `RENDER_SHARE` splitting calls between the passage and its wording so Insights compares them.

## Build, if decided

1. `from: answer` on a framed span (the schema, `pnpm check`: only on a knowledge form's answer line, only where some topic is `risk: low`), and `risk` read at the turn.
2. The span's request and checks with the passage as what was given; the judge's question with the passage in the caller's words' place.
3. The record, the trace, the console and the policy card.
4. The judge's labelled cases and their evaluation; then Harbor's topics, its recording and its bake-off.

## For the maintainer

1. The rule change above: yes, or a different wording.
2. Both switches (the topic's `risk: low` and the line's `generate`), or one.
3. Worded for the question, or only shortened (the same answer for every caller, a shorter one).
4. Which of Harbor's topics would be the first low-risk ones.

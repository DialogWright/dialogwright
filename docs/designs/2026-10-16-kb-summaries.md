# Knowledge-base answers in generated wording

Date: 2026-10-16. Status: **decided (the maintainer, 2026-10-16); built on the branch `kb-answers` (As built, below), the recordings the maintainer's.** It changes a rule in CLAUDE.md; the maintainer approved the change.

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

## Decided (the maintainer, 2026-10-16)

- **Yes**, with both switches: a topic marked `risk: low`, and the answer line generated from the answer. `regulated`, the default, keeps today's behaviour.
- **Worded for the caller's question**, from the approved passage: only what the passage says for that question.
- **The checks as proposed**, and the passage word for word whenever one fails.
- **Room for long passages.** A longer passage needs more words and more time to summarize. The span's word budget is sized to the passage, so a long passage's answer is never cut to fit a short budget, and the wording is given time to finish. When it runs past the call's normal budget for a line, the caller first hears a hold line ("One moment while I gather that information."), then the answer (or the passage word for word, if it is still not ready by the longer limit or a check fails).
- **A few of Harbor's topics** are marked low risk first, chosen by the builder and listed in Harbor's worksheet.
- **CLAUDE.md** takes the proposed rule.

## As built (2026-10-16, branch `kb-answers`)

1. **The two switches.** `from: answer` on a framed span (`render/config.ts` `KB_ANSWER_SOURCE`, `answerSpanOf`), read only on a form's answer line (`answers.answer`, default `kb_answer`) as its `{answer}` itself; `risk` read at the turn from `kb/topics.yaml` (`render/turn.ts` `planAnswer`). `pnpm check` refuses `from: answer` on any other line, as a span not named `{answer}`, with `speaks` or `names`, and on a prescribed line (the framed line's existing refusal); it warns, never refuses, where no topic is `risk: low` (or the app has no `kb/`). A regulated topic's turn says the passage byte for byte (its render line `skipped: regulated`); an app whose answer line is not framed has no render step at all, and its turns, traces and requests are as they were.
2. **The question.** The caller's question is the words the topic slot was filled from, kept on the slot (`SlotState.heard`, `core/fia.ts` `keepHeard`) only for the topic slot of a form whose answer line words its answer (`App.generated.answerSlots`), and never from words said at a sensitive question (the code, an identity factor, a slot the records mask). It is optional and absent for every other app, so `SESSION_SCHEMA` is unchanged; a call saved before it has no question, and its answer is the passage word for word (`skipped: no-question`), as is an informational intent's passage. The knowledge completion gives the answer line two engine variables beside `{answer}`, only where the line words its answer: the account line alone (`answerAccountLine`) and the question (`answerQuestion`); none in an app whose caller's words go to a model only to summarize a masked slot (`redact: length-summarized`). The question is screened again for an injection before it is sent, as collected content is.
3. **The act** is a span's (`SpanAct` with `answer: { question }`): the goal, the sentence, the passage as its content under `answer`, the budget, the style, the channel, the language; instructions of its own (`ANSWER_INSTRUCTIONS`): the context and the goal, no procedure. The account line is spliced after the wording word for word (`prompts/render.ts` `framedVars`), so the line said is the wording, then the account line, as it is the passage, then the account line.
4. **The checks** (`render/checks.ts` `checkAnswer`), with the passage as what was given: empty; format (markup, a link, a line break, longer than 600 characters or the passage, whichever is more); frame; question; the budget; `avoid`; no figure and no capitalized word the passage does not have. More than one sentence is allowed (the passage may have them), and the closing stop is kept where the answer ends its line (`cleanAnswer`). A wording that is the passage's own words is said as the passage, no judge asked (`unchanged`). **The judge** is `renderAnswerDrift`, given the goal, the wording heard in its line, the passage and the question, refusing at style.yaml's `judge.refuseAt`. The stub's (`stubAnswerDrift`) refuses a figure or a name of its own, words of its own, or a figure of the passage left out; it reads no grammar.
5. **The record.** The trace's knowledge record says `said: passage | worded` on a turn whose answer line words its answer; its render line has `answer: { passageId, topic }`, `fixed` the passage and `said` the wording; the audit has `kb_worded` (the prompt, the passage's id, version and approval's short hash) when a wording was said, `render_fallback` (with the span) when one fell back. The console's call detail shows the wording with "approved passage <id>" and the passage beside it, and the source card says how the passage was said. The policy card has a table of its own for answer lines: the line, the span, the goal, the budget and the topics marked low.
6. **Room for long passages.** The budget defaults to the passage's word count and a quarter more (ten more at least) (`GeneratedSpan.sizedToPassage`, `answerWordBudget`: the stub judge-eval showed two faithful rewordings a word longer than their passage falling back at the passage's exact count, and the maintainer had asked for room); the app may set `words`. The time: `RENDER_ANSWER_TIMEOUT_VOICE_MS` and `_CHAT_MS` (defaults 4000 and 6000; never less than a line's two budgets together), the answer's wording and checks together from when the turn's rendering began. The answer runs beside the turn's other lines; once those are settled and the line's own budgets (wording and checks, 1.4 s on a call) have passed with the answer not done, the hold line (`kb_hold`, else `DEFAULT_HOLD_TEXT`, "One moment while I gather that information.") is put before it. It is said only in a language the app gives it in (a locale's own `kb_hold`, or the engine's words in English); in another, no hold line, and the answer has a line's budget only, so no caller waits in silence (`pnpm check` warns of such a language).

**The mechanism for the hold line: early lines within the turn.** A turn may hand a channel lines before it ends (`RunOptions.early`, `render/turn.ts` `EarlyLines`): the lines before the answer and the hold line, with the turn's result so far. The voice adapter sends them at once as frames (each carrier's `last` rules applied to that batch: on Telnyx, whose reply ends at its first `last: true`, the hold line carries it, and the answer's batch ends on its own), and the chat socket shows them as `say` messages; the turn's run says how many it handed (`TurnRun.early`), and the channel sends the rest when the turn ends. Chosen over the downstream-service path (a pending effect whose answer runs as the call's next turn) because the hold is a rendering matter decided after the core, not a decision: the core's turn, its session, its audit and its gate calls are one turn as before, nothing new is saved with the call, and a channel that cannot say lines early (the harness, the HTTP chat, the frame-log replay) says the hold line in its place with the rest, so a scripted call hears exactly what a caller hears, in order. It is deterministic in tests (a fake renderer with `delayMs`, a scripted call's `renderDelayMs`, a render client the test releases). Only fixed lines go early (a line already worded is said with the turn, so nothing the frame log masks is sent before the turn's record exists), never a reply that may be held for a caller who had not finished, and never with nothing to send to. A restart while the answer is worded: the session from before the turn is the one saved (as for any turn in progress), so the call resumes at the question before it; the caller has heard the hold line and nothing else of the turn, and asks again. `SESSION_SCHEMA` is unchanged. To confirm on a live call: on Telnyx, that the answer's batch after the hold line's `last: true` is said (as a re-ask after silence is), and that a hold line cut short is said again (`RESAY_CUT_LINES` watches both batches).

7. **Tests**: `render/config.test.ts` (the switches in check), `render/answerChecks.test.ts` (the act, `checkAnswer`, the judge's state, the stub's judge, the fake), `render/answer.test.ts` (the switch matrix, the question kept and never from a sensitive question, each check and the judge refusing, the hold line on a call and in a chat, early and not, the engine's words, the passage after the long limit, the record, the card, runTurn's trace and early count), `server/answerHold.e2e.test.ts` (Twilio's and Telnyx's relays and the chat socket: the hold line out while the answer is held, then the answer), the adversarial suite's answer cases (`wording/answer/figure`, `/turned`, `/promise`, with a blind judge shown to let the turned one by), `render:judge-eval`'s answer cases, the console's view.
8. **Measuring it.** `render:judge-eval` reads answer cases (`speaks: answer`, the passage as `content`, the `question`, the wording as `span`); Harbor's 28 are `apps/harbor/fixtures/judge/answers.jsonl` (12 faithful: shorter, focused, other words; 16 unfaithful: a wrong figure, figures swapped, a dropped exclusion, a condition turned around, a limit made unlimited, an added promise, the other plan's figure, the question's assumption answered), outside the engine (its vocabulary is an insurer's). Before any recording, on the stubs: the data checks catch 7 of the 16 unfaithful (the figures and names not in the passage), and refuse 2 of the 12 faithful, each a rewording one word longer than its passage (the budget is the passage's own count: a margin above it is the maintainer's call, measured here). The judge's numbers wait on its recording.
9. **Harbor.** Four topics low (sports injuries, prescriptions, travel, the filing deadline: descriptive answers, not a benefit's amount; its DESIGN.md "Knowledge" gives each), `coverage_answer` framed with the goal "Answer the member's question from their plan's passage, in a sentence or two.", `kb_hold`, style.yaml naming the secretary's model; one corpus line and three scripted calls (a worded answer, the hold line on the phone and in a chat), their baseline entries logged. The policy card gained its answer section; the matrix and the map are unchanged.

**What was not done here, the maintainer's:** the recordings. Harbor's decision model must be recorded again (each low-risk answer now screens the question again and asks the answer judge, and the new lines are new requests), its render model recorded for the first time (`regress --client record`), the bake-off tabled from that recording, and the judge recorded on the answer cases (`pnpm render:judge-eval --cases apps/harbor/fixtures/judge/answers.jsonl`). No other app's requests changed: the clinic's, the utility's and the secretary's recorded replays are as they were.

## Measured (2026-10-16)

Harbor recorded with worded answers (Jev and Gemini 3.1 Flash-Lite through OpenRouter), and the judge evaluated on 28 labelled answer cases from Harbor's passages:

- **The judge**: with the data checks, 14 of 16 unfaithful wordings caught (88%), 1 of 12 faithful refused (8%), at 0.5; Jev answers at 120 ms p50. The two missed are exclusions dropped (0.45, 0.35), both on low-risk topics; on those topics a cutoff of 0.3 separates every faithful case (at most 0.27) from every unfaithful one (at least 0.35), and Harbor sets `judge.refuseAt: 0.3`. A dropped exclusion is the judge's weak family: more cases before a real deployment.
- **The budget**: the passage's exact count refused two faithful rewordings a word longer, so the default is the passage's word count and a quarter more (ten more at least); what may be said stays the checks' and the judge's.
- **The wording**: on Harbor's short passages the render model mostly restates the passage (4 of 7), says a new wording once, and the judge refuses 2. Latency p50 about 1 s, p95 3.5 to 4.4 s: the hold line covers the tail. The feature's value is on longer passages, which Harbor does not have.

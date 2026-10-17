# Knowledge-base answers from approved documents

Date: 2026-10-17. Status: **a proposal, for the maintainer's decision.** It changes a rule in CLAUDE.md (below); nothing is built.

## The problem

A knowledge base answers from passages: a person writes each one from a section of a source document, and approves it against that section. That is what makes an answer safe to say, and it is also the cost: every question callers ask needs a topic and a passage before it can be answered. An app with a lot of information and nothing regulated in it (a library's policies, a product's manuals, an office's how-tos, a member guide's general sections) would rather let callers ask about anything in its documents, and have the line search them and answer from what it finds. That is what a generative agent does: it retrieves chunks of documents and a model writes an answer from them.

The maintainer (2026-10-17): this is a third kind of knowledge, beside the two Harbor Mutual already has:

| Kind | What the caller hears | When a check fails | Built |
|---|---|---|---|
| **Regulated** (a topic, the default) | the approved passage, word for word | (nothing is generated) | yes |
| **Low risk** (`risk: low`) | the approved passage worded for the question | the passage, word for word | yes (2026-10-16) |
| **Documents** (this proposal) | an answer worded from the approved documents' sections | the app's choice: no prescribed fallback exists | no |

The third is the lowest risk: content not important enough to write a passage or a fallback for. It fills in around the other two, answering what no topic does; where a topic answers, the topic's passage wins.

## What exists

- **Sources** (`kb/sources/<document>.yaml`, the guide's section 12): a document by section, with its provenance; `pnpm kb:ingest` reads documents and websites into them, `kb:refresh` reads them again. Each section has a hash; a passage's approval holds its section's hash, so a changed word makes the passage stale.
- **Retrieval** on the app's own machine: keywords and the static embedder (`potion-base-8M`), cap and floor chosen offline with `kb:bakeoff --sweep` on paraphrases. Today it nominates topics.
- **The topic question** asks which of the nominated topics the caller asks about, a question none of them answers (`unanswered`), or nothing yet (`none`); a question nothing answers is the slot's miss, said as its retry line (2026-10-17).
- **Worded answers** (`from: answer`, the 2026-10-16 design): the render model words a passage for the question; code checks figures (every figure in the passage), the word budget and the sentences; the answer judge (`renderAnswerDrift`) holds the wording to what the passage says for that question; the passage is said on any failure; past a line's budget the hold line (`kb_hold`) is said first, and the answer has `RENDER_ANSWER_TIMEOUT_*_MS` (4000 by voice, 6000 in a chat).
- **Rotating lines**: `variants:` on `ack_intent` (2026-10-17), said in turn by how many times the call has said the line, never at random, so a replay says the same.
- **Gaps**: `kb:gaps` and the console rank what callers asked that nothing answered.

So the pieces are there: retrieval, a choice by the decision model, wording checked against a source, a hold line, rotating lines and gaps. What is missing is a unit of approval coarser than a passage, retrieval over sections, and a fallback when there is no passage to fall back on.

## The proposal

### 1. A person approves documents, not passages

A source document may be approved **for summarizing**: once, by a person, after reading it (`pnpm kb:approve --document <doc> --by "<name>"`, or the review page). The approval holds the document's hash, in the document and as a line of `kb/approvals.jsonl` (`from: document`), as a passage's does. A document whose text changes after its approval is withheld whole until a person approves it again; `kb:status` lists it with its fix, and `pnpm check` warns of it. So "only what a person approved reaches a caller" stays true, at the cost of a few minutes per document rather than a passage per question. A document never approved is never searched for an answer.

Two limits keep the third kind out of the first two's ground:

- **A section a regulated passage cites is not summarized.** That section's content is what the app decided must be said exactly; its passage speaks for it. (A section a low-risk passage cites is not summarized either: its passage answers it, with a prescribed fallback.) The documents fill in around the topics, never over them.
- **A section may be left out** by the author (`summarize: false` on the section), for what is in a document but should not be said (an internal note, a figure that changes by plan).

An approved document may say whom it applies to (`applies`, as a passage does: Harbor's two member guides, one per plan), read from the system of record by code, never from what the caller said.

### 2. Retrieval nominates sections too

With approved documents, `kb:index` also embeds their sections (their heading and text), and retrieval nominates sections beside topics, by the same keywords and meaning, with a cap and a floor of their own, chosen offline on paraphrases (`kb:bakeoff` gains the sections). Topics come first: a section is a candidate only for a turn whose topic question reads `unanswered` or found nothing.

### 3. The decision model chooses the sections; it never writes

On a turn that nominates sections, the request asks, beside the topic question, one yes-or-no per nominated section: "does this section say what the caller asked?" (each section by its heading and its opening words). Asked in the same request as the topic question, so the turn costs no second round trip; the sections it holds at the bar (a threshold of its own, `KB_SECTION_ANSWERS`) are the answer's sources, at most a few. None: the caller asked something the documents do not answer, and hears the not-found line (5). A topic the topic question fills always wins over the sections.

### 4. The answer is worded from those sections, checked against them

The form's answer line generates its span from the chosen sections (`generate: { answer: { from: sections, goal } }`), as a low-risk answer does from its passage, with the same checks, held to the sections:

- every figure in the answer is in the sections; its word budget the app's (`words`, default 60), since there is no passage to size it by;
- the answer judge, asked whether the answer says anything the sections do not say for that question (its question unchanged but for "the sections" in place of "the passage"), at style.yaml's `judge.refuseAt`;
- collected content screened again, as every generated line is.

The sections are sent to the render model whole, as a passage is: they are approved content, not the caller's. The trace keeps which document and sections answered, by id, so `kb:gaps`, the console and an audit row (`kb_answer`, `from: documents`) say what was said from where.

**A second attempt, where the app asks for it.** When the judge refuses a wording, the line may ask the model once more (`retry: 1`), given the same goal and context and told only that its first wording was judged to say more than the sections do for this question (never a procedure for the words), within what is left of the budget, and the judge asked again. A second draw against a judge that is a judgement, not a guarantee, raises the chance an unfaithful wording passes, so `render:judge-eval` measures it (both draws, on the same cases) before it may be on by default; until then it is off. The same option would serve a low-risk answer's line.

### 5. When nothing is found, or a check fails: the app's choice

There is no passage to fall back on. What the caller hears is the app's:

- **`onFail: not-found`** (the default): the not-found reply (below), as for a question nothing answers. The caller may ask again.
- **`onFail: handoff`**: to a person, with what was asked (`handoff.data`).
- **`onFail: opening`**: the first sentences of the best section, word for word, framed ("Here's what our guide says: ..."). The section is approved text, so this is the third kind's nearest thing to a prescribed fallback.

Whether a not-found counts as a try is the app's too. Today a question nothing answers counts (the topic slot's ladder: three in a row end with a person). An app that wants callers to ask as much as they like sets `unanswered: { counts: false }`; one that wants a limit keeps the count or sets its own (`unanswered: { after: 3, then: handoff }`). A turn that says nothing about what the caller wants (`none`) counts as it does now. **Recommended default: a question nothing answers does not count** (the knowledge base lacked it; the caller did not fail), with no limit, and `none` counts. This changes today's counting for every app with a topic slot, so it is the maintainer's to decide.

**The not-found reply, in two parts, so it never sounds read out:**

- **The not-found line**, with variants said in turn: "I couldn't find anything on that.", "I'm not seeing anything about that in what I have.", "That's not something I have information on." (`kb_not_found`, `variants:`).
- **The guide to what can be asked** ("I can tell you about things like physical therapy, hospital stays, or fractures."), said the first time a call hears a not-found, and again only after `remind` not-founds in a row (default 2): a caller who has heard it is not told again each time, but one who keeps asking outside the knowledge base is.

The slot's question follows ("What would you like to know?"). The topic slot's single retry line (`ask_<slot>_retry`) stays the default for an app without the two lines; with them, the engine says the two in its place.

### 6. While it takes a while: rotating hold lines

Search, wording and judging an answer from sections takes longer than a passage (more text to read, a judge, perhaps a second draw). The maintainer: build the time into the design.

- The answer from documents has a budget of its own (`RENDER_DOCUMENTS_TIMEOUT_VOICE_MS`, `_CHAT_MS`; proposed 6000 and 8000, set from the measured p95), each channel's on its own.
- **The hold line rotates**: `kb_hold` with variants ("One moment while I look that up.", "I'm just looking through the documents.", "Let me check on that for you."), said in turn across the call, never at random.
- **Only when it is taking a while**: past a line's budget (900 ms by voice), as today, never on a quick answer.
- **A second hold line past a longer wait** (`kb_hold_more`, with its own variants: "Still looking, thanks for waiting."), past half the answer's budget, so a long wait is never silence. A second early line within one turn is new for the channels (today a turn hands them one early batch); the build checks it on both carriers, as the first was.

### 7. Where it is set

- `kb.yaml`: `documents: { summarize: on }` (off by default: an app without it is unchanged), the sections' `cap` and `floor`.
- A source: its document approval, `applies`, a section's `summarize: false`.
- `prompts.yaml`: the documents' answer line (`generate: { answer: { from: sections, goal, words, retry } }`), `kb_not_found` and its variants, `kb_guide`, `kb_hold` and `kb_hold_more` with variants (`variants:` opened to any fixed line).
- The topic slot: `unanswered: { counts, after, then, remind }`; the answer line's `onFail`.
- The policy card lists the approved documents, the sections left out, and the line generated from them, as it lists every generated line.

## What it does not do

- **No answer from a document no one approved,** and none from a section a passage speaks for.
- **No wording of a regulated topic**: the passage wins wherever a topic answers.
- **No action from an answer**: a document's content is said, never acted on; tools and the gate are unchanged.
- **No guarantee**: the judge is a judgement, measured; an app that cannot accept that marks the content as a topic.
- **No search of the web or a live system** at call time: the documents are the app's, approved and indexed before the call.

## The rule it changes

CLAUDE.md says: "A knowledge base's answers are approved passages, said word for word, unless the app marks the topic `risk: low` and the answer line generates from the answer (`from: answer`) ... A model never writes a passage". Proposed:

> A knowledge base's answers are approved passages, said word for word, unless the app marks the topic `risk: low` and the answer line generates from the answer (`from: answer`): then a model may word the approved passage for the caller's question, held to it by the checks and the drift judge, and the passage is said whenever one fails. An app may also answer from documents a person approved for summarizing (`documents: { summarize: on }`, `from: sections`): where no topic answers, the decision model chooses the sections that say what the caller asked, a model words the answer from them, held to them by the same checks and judge, and when a check fails the app's `onFail` says what is said; a section a passage cites is never summarized. A model never writes a passage, and never answers from a document no one approved.

And in "Approvals are by people only": a document's approval is a person's, as a passage's is, through `kb:approve` at their terminal or the review page; never an assistant's.

## Measuring it

Before it is on in an example app:

- **Retrieval over sections**: paraphrases of questions the documents answer, and of questions they do not; recall at the cap, and how many sections a question about nothing nominates (`kb:bakeoff`).
- **The section question**: the decision model on labelled cases, a question and its candidate sections, which say what was asked (a new family in `render:judge-eval`, or a corpus of its own).
- **The answer judge on sections**: faithful answers, and unfaithful ones (a figure from another section, a condition dropped, a claim added, an answer to a neighbouring question, a section's rule stated for the wrong case), with and without the second attempt.
- **Latency**: wording and judging, p50 and p95, to set the budgets and the second hold line's moment.
- **Cost**: tokens in and out per answer; a month of the examples' recordings with the current model cost about 2 cents in all.

## Build, if decided

1. Document approval: the source's approval, the log line, `kb:approve --document`, the review page, staleness, `kb:status`, `pnpm check`.
2. Sections in the index and in retrieval; `kb:bakeoff` over sections; the sections a passage cites, and `summarize: false`, left out.
3. The section question in the turn's request; `KB_SECTION_ANSWERS`.
4. `from: sections` on an answer line: the checks, the judge, the trace and the audit row; `retry`.
5. The not-found reply, the guide line and its `remind`; `unanswered: { counts, after, then }`; `onFail`.
6. `variants:` on any fixed line; `kb_hold` rotating; `kb_hold_more` and the second early batch on both carriers.
7. Harbor Mutual as the example: a fuller member guide (invented, as its documents are), approved for summarizing, with sections no topic covers (updating your address, using the app, the wellness benefit, who to call for what), its corpus, scripted calls, judge cases and paraphrases. The other apps unchanged.
8. The guide's section 12, the topic slot's page, the policy card, CLAUDE.md, the site.

## For the maintainer

1. **The rule change** above, and its wording.
2. **The default for counting a question nothing answers**: recommended, it does not count (no limit), `none` counts; or keep today's count.
3. **`onFail`'s default**: recommended `not-found`.
4. **The second attempt**: built off, turned on by default only if the measurement shows the false passes do not rise; or off for good.
5. **The section question in the same request** (no second round trip, a larger request on such turns), or a second request only when the topic question reads unanswered (smaller requests, slower answers): recommended the same request.
6. **Harbor Mutual as the example**, with a fuller member guide.

# Follow-up questions, read with the caller's earlier one

Date: 2026-10-19. Status: **decided (the maintainer, 2026-10-19); built on main, off by default.**

## The problem

Each question was read on its own. After "What's my deductible?", the follow-up "what about out of network?" was retrieved, read and worded with no idea it was about the deductible. Commercial assistants handle follow-ups, most by asking a model to rewrite each one as a question that stands alone: a second model call on every turn, and generated text the rest of the turn then depends on.

## The decision

Context, never a second call:

1. **The earlier question is kept.** After an answer from the knowledge base, the session keeps the caller's question (the topic slot's heard words; never words said at a sensitive question): `Session.kbEarlier`, absent in an app that does not read follow-ups.
2. **Two rankings, merged.** The next question's sections are found for its words alone and for the earlier question with its words, twice as deep, and merged by reciprocal rank fusion (`mergeRanked`). One more local embedding, no model.
3. **The decision model reads with it, in the same request.** The turn state carries `earlierQuestion`, and each section's question becomes "Read asr.text and earlierQuestion, the caller's earlier question on this call. Would this section of the {document} answer the caller's question, read with their earlier one where it continues it?" Whether the turn is a follow-up is the model's judgment within the reading it already makes: no rule of the engine's decides it.
4. **The wording, the drift judge and the lines picker are given it** (`answer.earlier`), with instructions that name it, so the answer and its check are about what the follow-up continues.
5. **Off by default** (kb.yaml `documents.followUps: on`): without it, or without an earlier question, every request is word for word what it was, and every recording replays.

## Measured before it was built

`pnpm kb:bakeoff --sections <file> --follow-ups <file>` on a 123-page benefit booklet: 42 follow-ups written against it, and its 121 single paraphrases each run after unrelated earlier questions (484 runs).

| Search | Follow-ups found (in the 6 offered) | Single questions after an unrelated one |
|---|---|---|
| The words alone (before) | 61.9% | 96.7% |
| The earlier question and the words, joined | 100% | 77.3% |
| Both, merged (the decision) | 95.2% | 96.7% |
| Merged, the words weighted 1.2 | 78.6% | 97.5% |

Joining finds every follow-up and costs a fifth of the questions that stand alone; merging keeps them where they were. On the same booklet by keywords and meaning (hybrid), the single questions fell a little (93.4% to 92.6%; by keywords alone 83.5% to 80.0%): each app measures its own before turning it on.

## Not now

A follow-up after a not-found reply (the turn's words are not kept there yet); a question that continues one asked two or more questions before; follow-ups for topics answered by passages alone (their retrieval reads the words alone).

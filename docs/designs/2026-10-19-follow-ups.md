# Follow-up questions, read with the caller's earlier one

Date: 2026-10-19. Status: **decided (the maintainer, 2026-10-19); built on main, off by default.**

## The problem

Each question was read on its own. After "What's my deductible?", the follow-up "what about out of network?" was retrieved, read and worded with no idea it was about the deductible. Commercial assistants handle follow-ups, most by asking a model to rewrite each one as a question that stands alone: a second model call on every turn, and generated text the rest of the turn then depends on.

## The decision

Context, never a second call:

1. **The earlier question is kept.** After an answer from the knowledge base, or the not-found reply (a caller who then says it another way), the session keeps the caller's question (the topic slot's heard words; never words said at a sensitive question): `Session.kbEarlier`, absent in an app that does not read follow-ups.
2. **Three rankings, merged.** The next question's sections are found for its words alone and for the earlier question with its words, twice as deep; and the sections that answered the earlier question with those directly under each, closest to the follow-up's own words first (a live call: "how much does it cost?" after an answer from a plan's continuation section, its dues a section under it that neither search found). Merged by reciprocal rank fusion (`mergeRanked`). Two more local embeddings, no model.
3. **The decision model reads with it, in the same request.** The turn state carries `earlierQuestion`, and each section's question becomes "Read asr.text, the caller's question. Would this section of the {document} answer it? Only where asr.text cannot be understood on its own (as "what about for a family?" cannot), read it as continuing earlierQuestion, the caller's earlier question on this call." Whether the turn is a follow-up is the model's judgment within the reading it already makes: no rule of the engine's decides it. The question is the caller's own first, the earlier one only for what cannot stand alone (measured below: a wording that asked the model to read the two together cost the questions that stand alone).
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

## Measured with the decision model

The booklet's demo, recorded against the decision model: the 42 follow-ups as calls of two questions, and 24 calls of an unrelated question then one that stands alone (each the second turn's answer: its sections, or the not-found reply).

| | Off | On, "read with their earlier one" | On, the caller's question first (the decision) |
|---|---|---|---|
| Follow-ups answered from a right section | 21 of 42 | 33 | **34** |
| Follow-ups found nothing | 7 | 5 | **2** |
| Follow-ups answered from another section | 14 | 4 | 6 |
| Questions on their own answered from a right section | 18 of 24 | **8** | **18** |
| Questions on their own found nothing | 4 | 11 | 4 |

With the earlier answer's sections and those under them as a third ranking (added after a live call), against the decision model: 38 of 43 follow-ups answered from a right section (the live one among them), none found nothing, and the 24 calls of questions on their own gave the same answers (18 right). By the bake-off, 97.7% of follow-ups found (93.0% without it), questions on their own 96.5% (one run in 484 fewer).

The first wording asked the model to read the two questions together, and every section's reading of a question that stands alone fell (0.15 to 0.4 lower): the second turn of 10 of 24 calls found nothing. Reading the caller's question first, and the earlier one only where the question cannot be understood without it, kept those questions exactly where they were (the same answers on 24 of 24) and answered more follow-ups. Retrieval took 3 ms more on such a turn (median 7 ms, on a laptop), the decision model's request the same (median 120 ms either way): no second request.

## Not now

A question that continues one asked two or more questions before; follow-ups for topics answered by passages alone (their retrieval reads the words alone).

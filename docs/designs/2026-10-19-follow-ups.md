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

## Later the same day: a bare word

A live chat's "diabetes", right after an answer about an MRI, was read as continuing the MRI question (the diabetes section at 0.16), and a bare follow-up ("cost" after continuing coverage) fared no better: the question told the model to read the caller's words as continuing the earlier question "only where they cannot be understood on its own", and a single word reads as not understood on its own. The question now says what a caller's words may be, a whole question or only the name of what they want to know ("a single word, such as "parking", asks about it"), and that the name of something new stands alone. Retrieval already offered the right sections (16 of 16 bare new subjects, 10 of 10 bare follow-ups with the earlier question): the reading was the loss. Measured against the decision model on the booklet's demo, 93 calls of two questions each:

| | Bare new subjects (16) | Bare follow-ups (10) | Follow-ups (43) | Questions after unrelated ones (24) |
|---|---|---|---|---|
| Before | 6 right, 2 wrong | 4, 0 | 37, 5 | 21, 0 |
| A first rewording ("only where it refers back to it") | 7, 1 | 4, 0 | 39, 4 | 18, 2 |
| The decision | 11, 1 | 3, 2 | 38, 4 | 21, 1 |

Five more right answers for one more wrong; the bare follow-ups it now gets wrong ("cost" after continuing coverage read as the out-of-pocket maximum) are the next to measure. Half the misses before were the same few: a bare word read as about the earlier subject, every section below 0.45.

## 2026-10-20: a new question's places kept

A long live chat answered several questions from its fallback lines (the document's own lines) the first time and with a worded answer when asked again. Asked first, each came right after an unrelated question, and the merged candidates were mostly the earlier subject's: two of the three rankings (the earlier question with the new words, and the earlier answer's sections) speak for it, so with six places a question on urgent care after one on prescriptions was offered both pharmacy sections and not the urgent care centers', hearing aids after acupuncture the acupuncture sections and not the hearing aids', physical therapy after a hospital stay the inpatient section and not physical therapy's. The model worded from what it was given, and the judge refused it or a check found a figure the sections did not have. Asked again, the earlier question was the same one, and every place spoke for it.

A follow-up's candidates are now offered beside the question's own, never in their place: every section the question finds alone, then at most half the cap more from the merged rankings. Measured by meaning on the booklet's demo (follow-ups found among the sections offered; questions on their own read after an unrelated earlier question with the two sections a live answer keeps; the five live first asks):

| | Follow-ups (43) | On their own after an unrelated one (501) | Sections offered | Live first asks (5) |
|---|---|---|---|---|
| Follow-ups off | 26 | 97.6% | 5.9 | 5 |
| Merged (before) | 42 | 94.4% | 6.0 | 4 |
| Its own, and two beside them | 40 | 97.8% | 7.7 | 5 |
| **Its own, and three beside them (the decision)** | **42** | **98.0%** | **8.1** | **5** |
| Its own four, and two from the merge | 40 | 96.0% | 6.0 | 5 |

It costs about two more sections for the decision model to read on a turn after an earlier question. Two of the five first asks had the right section all along and were refused for their wording (an answer adding advice the sections did not give, "so that's your best bet"; a claim form's website they did not name): the judge was right, and the fallback said the right lines.


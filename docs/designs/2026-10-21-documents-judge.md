# The documents judge, taken apart (2026-10-21)

An answer worded from approved documents is held to them by the checks and by the documents drift judge:
one yes-or-no asked of the decision model, whether the wording says anything other than what the sections
say for the question. This note records what taking that one question apart found, what was built, and a
recommendation that was measured and not built.

Everything here was measured on an insurance demo's knowledge base (a 123-page benefit booklet), on 134
labelled answers (79 faithful, 55 unfaithful: each case the caller's question, the sections a call would
give, and a wording), in the layout a call gives the sections now, and end to end on 40 questions asked
three times each with retry: 2.

## What the one question folds together

The drift question's refusal criteria list every way a wording can fail. Asked as separate questions:

| Part | Separates faithful from unfaithful (AUC) |
|---|---|
| Says something the sections do not (a score) | 0.90 |
| Changes what they say | 0.90 |
| Leaves out a condition that bears on the answer | 0.86 |
| Answers as though the sections said what the question assumes | 0.86 |
| Answers another question than the one asked | 0.53 |

The last read 0.82 to 0.93 on 10 of the 12 faithful answers the drift judge refused: "Is a visit covered?"
answered with what the caller pays reads as answering another question. It tells faithful from unfaithful
no better than chance, and the one question folds it into every verdict.

## What was built

- **`judge.documentsAsk`** (style.yaml): `drift` (the default), `added` (the score alone) or `both` (the
  two in one request, refused where both reach their cutoffs, or the drift reading alone reaches
  `documentsDriftAloneAt`, 0.75). `added` alone refuses faithful answers drift passes ("yes, it is
  covered" where a section says benefits are available), so end to end it gained nothing; `both` did.
- **`judge.compareFigures`**: an app's question about each figure ("who pays {figure}?"), asked of the
  wording alone, in a request of its own beside the judge's, and of each source line that gives the figure,
  with the same options; refused where the picks differ. Asked whether a wording says of a figure what its
  line says, the decision model calls them the same when the figure and the sentence look alike ("covered
  at 20%" beside "your payment: 20%"); read apart, it reads each as it is. The question is the app's, as
  what a figure is about is the app's domain.

| Judge | Faithful refused (of 79) | Unfaithful caught (of 55) | End to end, fell back (of 120) |
|---|---|---|---|
| drift | 12 | 43 | 13 |
| both | 2 | 41 | 7 to 9 |
| both + who pays | 2 | 44 | 7 |

## What the decision model does not catch

Eleven unfaithful answers pass every reading: a figure or a condition moved to another row, column or
service (a non-network maximum said of both columns, "not covered" said of every supply where the sections
say it of the longer ones), a procedure the sections never name, "covered at 20%" read as saying nothing
of who pays, and a dropped condition. Questions tried for them and set aside: broad yes-or-no questions of
who, scope and row (who reads high on everything; scope and row do not fire on these); a per-figure
yes-or-no of agreement with its line (yes when they look alike); "does this hold in every case or some?"
(ambiguous on faithful answers); and, with each row's cells parsed, "does the wording give {figure} for
{row}, {column}?" (right on the moved figures, but sibling rows with like names, a program's primary care
visit beside an office visit, read as high on faithful answers; no cutoff separates them).

## Recommendation, measured and not built: a reasoning model as a second judge

Asked the drift question with its criteria and the same state, a reasoning model catches most of them:

| Judge | Faithful refused | Unfaithful caught | Time, typical / slowest tenth | Cost an answer |
|---|---|---|---|---|
| both + who pays (the decision model) | 2 | 44 | about 0.1 s | the decision model's |
| Claude Haiku 5.5, reasoning, at 0.7 | 3 | 49 | 2.9 / 4.0 s | about $0.0004 |
| Claude Sonnet 5.5, reasoning, at 0.5 | 3 | 53 | 2.8 / 3.9 s | about $0.005 |
| Claude Haiku 5.5, no reasoning, at 0.7 | 11 | 45 | 1.3 / 1.8 s | about $0.0002 |

So the hard family is catchable, at about 3 seconds and many times the cost of every answer; without
reasoning the gain is gone. That is the trade the engine is built against: typed questions to a fast
decision model, with code comparing the readings, did most of the work for a fraction of the time and
money. Where an app needs the rest, three shapes were considered: a second judge only where the decision
model is unsure (a drift reading between about 0.3 and 0.75), a reasoning judge on chat only (where a
wait of seconds is acceptable), or answers to the common questions worded and judged ahead of time and said
at once when one matches. Each makes a model other than the decision model a judge, a change to the
design, for the maintainer.

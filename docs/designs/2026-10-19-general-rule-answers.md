# Answers from the general rule: what a document says about the kind of thing asked

Date: 2026-10-19. Status: **proposed; measured 2026-10-19 (below): the proposal revised, a decision for the maintainer.**

## The problem

On a live chat over a 123-page benefit booklet, a caller asked about a hysterectomy, gall bladder surgery, a broken wrist and two drugs by name, and heard the not-found reply each time. None of them is named in the booklet, but what it says about each kind of care is there: surgery in a hospital or a surgery center, emergency care, drugs by tier. Retrieval offered those sections every time (a bake-off of the live questions: the general section in the six offered for 9 of 11). The decision model, asked of each "Would this section answer the caller's question?", said no, and by its words rightly: the section does not say a hysterectomy is covered. Gall bladder surgery read 0.52 against the 0.55 bar.

A person at the plan would answer: "The booklet doesn't list that by name, but here's what it says about outpatient surgery." Today the engine can only say that it found nothing.

The same reading caused a wrong answer. Asked about open-heart surgery, the model read the outpatient surgery section at 0.58 (its text says "surgery") and the inpatient section, which prices a hospital stay and never says "surgery", at 0.35. The caller heard the outpatient cost. The judge passed it (0.13): the answer was faithful to the section it was given, just not the right section.

## The proposal

A second reading, only when nothing answers:

1. **Only on a turn that would say the not-found reply.** When no section reads yes at `KB_SECTION_ANSWERS`, the sections offered on that turn are asked one more yes-or-no each, in a second request: does this section say what applies to the kind of thing the caller asks about, though it does not name it? (Library example: "can I print a 3D model?" and the printing section.) Questions the knowledge base already answers send exactly the same request as today, so their answers and their timing stay as they are. A not-found turn takes one more request (about 150 ms on a laptop).
2. **An answer of its own kind, under a fixed frame.** The sections read yes at a bar of their own (`KB_SECTION_GENERAL`), best first, at most two (perhaps three: surgery is priced by setting and by surgeon), answer under the app's own line, `kb_documents_general`, for example: "Your {document} doesn't name that. Here's what it says about {heading}: {answer}". The frame is said word for word, so the caller always hears that this is the general rule, not a yes. The span is worded from the sections like any answer from documents. Its goal is the caller's question and the sections, and its context is the frame sentence, so the model knows it is stating the general terms. No procedure is written into the instructions.
3. **The same checks and judge.** The documents drift judge is given the frame sentence and the caller's words. An answer that says the named thing is covered adds content the sections do not have, which is unfaithful by its existing criteria. When a check fails, `onFail` applies as it does today (the lines under their heading, inside the frame).
4. **Off by default** (kb.yaml `documents.general: on`). Without it, every request and reply is what it is today. What the frame says, and whether to follow it with a fixed line ("Exclusions and prior authorization can apply; call us to confirm."), is the app's decision.

The open-heart case gets better too: with nothing over the first bar, the inpatient, outpatient and physician sections would all read yes on the second question, and the answer would give each setting's terms rather than one setting's alone.

## Risks

- **Exclusions.** A general rule can apply to something the document excludes elsewhere (cosmetic surgery, under a general exclusions section). The frame never says "covered", but a caller may take the terms to mean it. The measurement includes excluded things as controls, and an app can add a closing line.
- **Questions with no general rule** (cell phone plans, a diet plan) must still hear the not-found reply. A second question that says yes too easily would turn real misses into confident answers about something else.
- **The judge.** Two answers on 10-19 passed it while being wrong in meaning: "your plan covers 20%" where the booklet says you pay 20%, and a 90-day mail-order price given without saying it was mail order. General answers would rely on the judge more, so the booklet's own labelled judge cases come first (below).

## Measured before it is built

1. **The booklet's judge cases** (`pnpm render:judge-eval`, `speaks: answer` cases in the demo's own file): today's inversions and unlabelled table rows among them. This sets `documentsRefuseAt` for this booklet instead of the cutoff carried over from another app's 40 cases.
2. **A general-rule set** (`fixtures/kb/general.yaml`): questions naming things the booklet does not name, each with the sections that hold the general rule; excluded things; and questions the booklet does not cover at all. Measured against the decision model, with the second question worded and its bar swept. Reported: general answers from a right section, from another section, and false answers on the controls (the target is none).
3. **Unchanged where it should be:** the paraphrase, held-out and follow-up sets give the same answers (by construction the first request is the same; the run confirms it), and a not-found turn's added time is measured on the Mac Mini that runs the demo.

## Measured, 2026-10-19 (evening)

On the same booklet's demo, against the decision model: 311 turns over seven sets (121 paraphrases and 8 questions about nothing, 31 held out, 11 from live chats, 57 sparse questions and 5 about nothing, 29 about what the booklet never names, 6 about what it excludes, 43 follow-ups). Three variants: today's yes-or-no at the section floor 0.65 (A), the same at 0.60 (B), and a three-way question in its place at 0.60 (C): does the section answer what the caller asks about *by name*, say what applies to *the kind of thing* it is without naming it, or *neither*. C was asked with the exact turn state the decision model was sent on B's turn.

**The premise was half wrong.** Lowering the floor to 0.60 (which finds the general section for 86% of the unnamed questions rather than 69%, `kb:bakeoff --sweep`) does not leave them unanswered: the yes-or-no question says yes to the outpatient surgery section for knee arthroscopy, cataract surgery, tonsillectomy, an appendectomy, gall bladder and open heart surgery. Of the 29 unnamed questions, 19 are answered from a right section, **unframed**, as though the booklet named the procedure. The problem is the frame more than the finding.

| | paraphrases (129) | held out (31) | sparse (62) | unnamed (29) | follow-ups (43) |
|---|---|---|---|---|---|
| A: yes-or-no, floor 0.65 | 106 right, 7 wrong | 26, 1 | 48, 3 | 16, 2 (all unframed) | 37, 6 |
| B: yes-or-no, floor 0.60 | 107, 6 | 26, 1 | 49, 3 | 19, 1 (all unframed) | 37, 6 |
| C: three-way in its place | 101, 16 | 23, 7 | 42, 12 | 21 (19 framed), 7 | 37, 5 |
| B, framed where C reads *by name* below 0.3 | 107, 6 | 26, 1 | 49, 3 | 19 (11 framed), 1 | 37, 6 |
| B, framed, and *kind* at 0.7 or more answering what B found nothing for | 109, 9 | 26, 4 | 49, 5 | 24 (16 framed), 3 | 37, 6 |

(Right and wrong count every answer, framed or not; the rest are not-found replies.) Replacing the yes-or-no loses: the three-way reading answers questions the booklet does name less surely, and its *kind* says yes too readily. Used only to decide the frame of what the yes-or-no already chose, it adds no wrong answer anywhere; used also to answer what the yes-or-no found nothing for, it adds wrong framed answers in every set (1 to 3) for a few right ones, at every bar tried (0.6 to 0.9). The frame's bar trades unnamed answers framed against named ones framed by mistake: below 0.3, 12 of 20 and 10 of 238; below 0.5, 15 and 22; below 0.6, 17 and 33.

**Revised proposal.** (1) Every answer from sections opens with what it is from, the first chosen section's heading in the app's fixed line ("Here's what your benefit booklet says about outpatient surgery: {answer}"): true whether or not the booklet names what was asked, so a caller always hears which rule they are getting, at no cost. (2) Optionally, where the decision model reads the chosen section as naming what was asked below a bar the app sets, the line says so first ("Your benefit booklet doesn't name that."), from a three-way reading asked of the chosen sections alone. (3) No answer from a section the yes-or-no did not choose. (4) The floor goes to 0.60 with (1). The judge still misses an answer said as though the section named the procedure (0 of 2 in its cases), so (1) is the guard, not the judge.


## Not now

Naming the caller's own word in the frame ("doesn't name a hysterectomy"): that would put the caller's words in a fixed line, which the rules allow only as a framed span. A hint list of procedures per section in `kb/sections.yaml` would help retrieval, but procedures have no end, so it can't be the answer to this.

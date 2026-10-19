# Answers from the general rule: what a document says about the kind of thing asked

Date: 2026-10-19. Status: **proposed; to be measured before it is built.**

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

## Not now

Naming the caller's own word in the frame ("doesn't name a hysterectomy"): that would put the caller's words in a fixed line, which the rules allow only as a framed span. A hint list of procedures per section in `kb/sections.yaml` would help retrieval, but procedures have no end, so it can't be the answer to this.

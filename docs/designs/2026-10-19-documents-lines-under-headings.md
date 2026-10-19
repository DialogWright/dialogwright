# Lines from documents said under their heading

Date: 2026-10-19. Status: **decided (the maintainer, 2026-10-19); built on main.**

## The problem

An answer from documents that cannot be worded may say the lines of its sections that answer the question, word for word (forms.yaml `answers.documents.onFail: lines`). On a live chat a caller asked what a generic prescription costs. The decision model chose two sections, a mail-order pharmacy table and a retail pharmacy table, the mail-order one first. The worded answer mixed the two tables and the judge refused it, rightly. The fallback then said one row, "Tier 1 drugs: $20/prescription", which is the mail-order price for a 31 to 90 day supply. It was said without its table's name or the caption over its rows, so it sounded like the price of every generic prescription. Three things went wrong:

1. **The second section was never offered.** The decision model is asked about at most 40 lines. The first section ran long (the import had joined the next headings' text to it), so all 40 went to it, and the retail table, which holds the right row, was left out.
2. **A row was said without what it is a row of.** The section's heading was not said, and neither was the caption its rows sit under.
3. **The picker read each line on its own,** with nothing to tell it which table a row came from.

## The decision

- **The lines are shared.** The 40 lines are dealt to the chosen sections one at a time, in their order. A long section can no longer crowd out the next, and room a short one does not use goes to the others (`sectionLinesOf`).
- **The picker reads each line under its heading.** Its state is the sections, each with its heading and its numbered lines, rather than one flat list. Its question asks it to read a line under its heading and the lines before it, and counts a caption over rows that answer (which supply, place, plan or period they are for) as a line those rows need. It still chooses among the document's own lines, never wording.
- **The chosen lines are said under their heading.** Each section's chosen lines follow its heading, said once as a sentence of its own: "Here's what our guide says: Printing and copies. Printing in color: 50 cents a page." The heading counts toward the word budget. A section with no heading is said as before.
- **The headings travel with the lines.** The ack carries `answerLineHeadings`, one heading per line, beside `answerLines`, and the knowledge answer carries its sections (`KbAnswer.sections`, each a heading and its sentences) in place of a flat list of lines.

## The import, separately

The run-on section came from `kb:ingest`. The booklet's summary of benefits is set at 10 pt and the booklet itself at 11 pt. The summary's bold 10 pt headings ("Prior Authorization", "Notes") were judged against 11 pt and read as text. On a page set smaller than the document's body, a bold line at that page's own body size is now a heading too, on three conditions, each of which kept a wrong cut out on the same booklet:

- it starts at the page's left margin (a box's caption in the second column does not);
- no other line is within a line's height of it (a label's value on the label's baseline is not a heading);
- text of its own follows it (a plan's name or a date set in bold over a summary stays text).

On that booklet this gives four new sections, the deductibles, the out-of-pocket maximum, prior authorization and the notes, each with its figures under it, and changes nothing else. The utility app's PDFs import exactly as before.

## Later the same day: the worded answer under its headings too

A live chat's generic-drug answer gave a 31-90-day price, a row of the mail service table, as a network pharmacy's. The wording model and the documents judge were given the sections' text without their headings, so neither could tell the two pharmacy tables apart. Each section now goes to them under its heading after those it is under (`Heading: text`, `KbSection.path`). On the booklet's 61 labelled answers (`pnpm render:judge-eval`), the judge at 0.5 caught 22 of 32 unfaithful answers with headings and 20 without; the two it now catches are that mail service price, and it refused none of the 29 faithful answers either way.

# Table readers: one format, several readers, measured on labelled documents

Date: 2026-10-20. Status: **step 1 built** (the format, the filling, the checker, the scorer, today's reader moved onto them); step 2 (a reader from a table's drawn borders) and step 3 (a model that reads the page) to come, each measured.

## Why

`kb:ingest` read a benefits booklet's tables well after the heading-over-columns change (2026-10-19), and we asked whether that holds for other documents. Eight public PDFs with tables were gathered: six Summaries of Benefits and Coverage from six publishers (the federal template's "What You Will Pay" grid, laid out six ways) and two utility rate schedules. Today's reader got almost none of their tables right: it builds a row from one printed line and finds columns from the gaps between text, and these grids wrap every cell over several lines and draw their cells with borders. It was tuned to one layout.

Swapping in a reader tuned to another layout (borders) would repeat that. What is general is the table itself, so the readers can change.

## The design

`packages/kb-author/src/extract/tables/`:

1. **A grid** (`grid.ts`): a reader proposes each table as its columns' edges, its rows' edges, how many of its first rows are its heading, and its cells over several columns or rows. A reader never says what a cell holds.
2. **Filling** (`grid.ts`, `fillGrid`): each of the page's runs goes in the cell its anchor (its middle, a third of its size above its baseline) is in, a cell's runs joined top to bottom. The words are always the page's own, whoever found the table: a model proposing a grid can never write a word.
3. **The checker** (`check.ts`): how well a table was read, from the page alone: text inside its box left out of its cells; text across a column's edge; rows whose first cell holds a blank line's break (rows run together); cells holding two runs side by side a gutter apart (two columns read as one); rows with nothing in their first cell. A score from 0 to 1; under 0.8 is weak, and `kb:ingest` notes it under the document for the author to read against the page. When readers disagree, the better score wins (step 2).
4. **Saying the rows** (`assemble.ts`): the column headings, a heading over several columns said around their cells, a group's row as a heading, a list of terms; unchanged from before, now reading cells.
5. **Labelled documents and a scorer** (`labels.ts`, `score.ts`, `kb:tables`): a person writes each table's heading rows and rows cell by cell in `<name>.tables.yaml` beside the document; `kb:tables` scores the readers on them (cells, whole rows and headings right, ignoring case and spacing), puts the checker's score beside each, and lists labelled words the page's text lacks (a slip in the labels).

Today's reader (`alignment.ts`, by where the text is) now proposes grids. On the eleven PDFs we have (the eight, the booklet and the utility app's two), the sections read are the same as before but for two headings over several columns, which it used to drop: one now kept where it belongs ("Limitations, Exceptions, & Other Important Information" where a column was headed "Information"), one now said with the column it sits over. No app's knowledge base changes.

## Measured (the eight documents, fifteen tables labelled, 390 cells)

| | Today's reader |
|---|---|
| Cells right | 32 of 390 (8%) |
| Whole rows | 1 of 101 |
| Headings | 11 of 74 |
| Tables not found at all | 7 of 15 |
| Found and read badly, called weak by the checker | 6 of 8 |

The labels' every word is in its page's text. The checker's blind spot that remains: a column whose evenly spaced rows are read as one cell (a list of years beside their rates), which has no break and nothing side by side.

On the booklet, the checker calls two tables weak, and both are misread today: a numbered list item read as a table's row, and a table of decision times split in two so that some rows lost their times (in the knowledge base as ingested). Neither was seen before.

## Next

- **Step 2, a reader from borders.** Each of these grids is drawn: the pages carry hundreds of path operations each, the cells' rules. A reader that takes the rules from pdf.js's operator list proposes the grid they draw; filling, checking and saying the rows are as they are. Measured with `kb:tables` against today's 8%, and where both readers find a table, the checker's better score is taken.
- **Step 3, a model that reads the page**, for the tables neither reader reads (no borders, two columns of prose): given the page's image and its runs, it proposes a grid; the filling keeps the words the page's own. Run by the author with their own key, once per document (cached by its hash), never on a call or in CI; measured on the same labels, and possibly an off-the-shelf table-structure model beside it.
- The labelled set grows each time a document breaks. It lives outside the repository for now (its documents are other publishers'); the format and the scorer are here.

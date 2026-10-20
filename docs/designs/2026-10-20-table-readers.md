# Table readers: one format, several readers, measured on labelled documents

Date: 2026-10-20. Status: **steps 1 to 3 built and measured** (the format, the filling, the checker, the scorer; the alignment reader moved onto them, then a reader from a table's drawn borders); step 3 (a model that reads the page) to come, measured the same way.

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

## Step 2: a reader from borders

`tables/rules.ts` takes the lines a page draws from pdf.js's operator list (already read for the fonts' weights): thin filled rectangles along their length (a word processor's borders) and straight stroked pieces, through the transform in force. A larger filled shape is not a rule: the first version took a shading's edges and cut every cell in two, because these documents fill a box behind each line of a cell's text. `tables/borders.ts` makes a table of each set of crossing rules: edges where the rules are, one cell where no rule parts two places (a heading over two columns, a label over three rows), the text beyond rules drawn only inside a table its outer columns (a style with no frame), a top row over every column its caption, the first all-bold rows its heading. Where both readers find a table, the checker's better score is read, the borders' on a tie.

| On the eight documents | Alignment only (step 1) | With borders (step 2) |
|---|---|---|
| Cells right | 32 of 390 (8%) | 247 of 390 (63%) |
| Whole rows | 1 of 101 | 67 of 101 |
| Headings | 11 of 74 | 59 of 74 |
| Tables found | 8 of 15 | 15 of 15 |

Twelve of the fifteen tables are read 90% right or better, ten of them perfectly. The three that are not: a rate table ruled only at its outline, with its tiers, seasons and years aligned inside it (two tables), and a block of rates with no rules at all. Their rows are 1.2 times their text apart, closer than the alignment reader's row gap, so neither reader can tell them apart, and a rule that splits short aligned lines into rows also split wrapped prose in the benefit summaries. They are step 3's. The checker now calls two of the three weak (a label stacking short lines beside another cell's: several rows read as one; and two columns' text side by side, weighed double) and none of the twelve read well.

The alignment reader also changed: two of its tables that share lines are read once, together (one ended early and the next reached back into it). Before, both were read, so the booklet said several tables twice, once without their headings, and one table of decision times lost the times on its last rows. On the booklet, every line that changes from step 1 is a fix: the duplicates gone, the decision times whole, four numbered items that were said as their number alone said with their text. The claims table, drawn with inner rules only, reads as before through the border reader. The checker still calls two of the booklet's tables weak, both misread before and after (a numbered item read as a table's row; one row of a table of programs swallowing several services and a heading). The utility app's two documents read exactly as before.

## Step 3: a model that reads where the tables are

`tables/model.ts` asks a model where a page's tables are, given the page as text: each baseline's runs with where they start and end, their size and weight, and the lines the page draws (no image: nothing to render, and the positions are what a grid needs). It answers each table's column and row edges, heading rows and cells over several columns or rows, as JSON; code checks the grid and fills it from the page's own runs, so a model can misplace an edge but never change a word. Where its table and another reader's hold the same lines, the checker's better score is read (drawn lines first on a tie, then the model, then the alignment).

Measured on the same fifteen tables with `kb:tables --model`:

| | Cells right | Whole rows | Headings | The 14 pages cost |
|---|---|---|---|---|
| Borders and alignment (step 2) | 247 of 390 (63%) | 67 of 101 | 59 of 74 | nothing |
| With Claude Sonnet 5.5 (OpenRouter) | 387 (99%) | 98 | 68 | $0.35 |
| With Claude Haiku 5.5 (OpenRouter) | 387 (99%) | 98 | 69 | $0.04 |
| With Gemini 3.8 Flash (OpenRouter) | 253 (65%) | 70 | 59 | $0.33 |

The model read the three tables neither reader could (the rate table ruled only at its outline: 98 of 98 cells; its vintages beside their rates: 38 of 38; the rates with no rules at all: 9 of 9). Alone, Haiku read 377 cells and Sonnet 387; with the others and the checker choosing, both 387. A model that reasons needs room to: Sonnet spent 4,000 tokens thinking about the rate table before it answered, so a page may take 16,000. Gemini 3.8 Flash ran out of even those on that page. In no run did the checker call a table read well weak; with Gemini, it called both tables Gemini read badly weak.

## Next

- **The model reader in `kb:ingest`**, opt-in (`--tables <provider:model>`), on the pages where a reader finds a table, its grids kept beside the knowledge base so a re-import with no key reads the same.

- The labelled set grows each time a document breaks. It lives outside the repository for now (its documents are other publishers'); the format and the scorer are here.

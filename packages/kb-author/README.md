# @dialogwright/kb-author

Builds a DialogWright knowledge base from documents. This package is for authoring only: an app never imports it, and the runtime package (`dialogwright`) carries none of its dependencies.

It reads the sources: a folder of PDF, DOCX, HTML, Markdown and text files, or a website crawled politely to a link depth. Each document becomes `kb/sources/<doc>.yaml`, its text by section with where it came from, which is what a passage is approved against. Drafting passages from the sources, reviewing them and refreshing the sources follow in the same package.

## Ingesting

```sh
pnpm kb:ingest <folder | file | url> [--dir <app folder>] [--dry-run] [--json]
pnpm kb:ingest https://example.org/help/ --dir apps/my-app --depth 2 [--include '/help/**'] [--include '*.pdf'] [--max-pages 50] [--rate 1000] [--allow-host docs.example.org]
```

`--dir` is the app folder (or its `kb/` folder); without it, the folder the command is run in, when that is an app folder. Relative paths are from where you run it. It prints one line per document, `added`, `changed` (with each section added `+`, changed `~` or removed `-`) or `unchanged`, then what it skipped and why. `--dry-run` writes nothing; `--json` prints the report as JSON. Exit codes: 0 done, 1 a problem, 2 a command line not understood.

## What a source file holds

```yaml
# yaml-language-server: $schema=../../../../packages/dialogwright/schemas/kb-source.schema.json
document: Example Town Library Patron Guide
provenance:
  file: docs/patron-guide.pdf
  retrieved: 2026-10-03
sections:
  intro:
    text: This guide explains how to use the branches of the Example Town Library.
    page: 1
  opening-hours:
    heading: Opening hours
    text: All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday.
    page: 1
  renewing-items:
    heading: Renewing items
    text: |-
      Most items can be renewed twice, online or at any branch desk, unless another patron has placed a hold on them.

      Items borrowed from another library through the interlibrary service cannot be renewed.
    page: 2
    lastPage: 3
```

- **Provenance** is the document's URL, or its file's path from the app folder, and the day it was read. A section keeps its heading, and a PDF's section records the page it starts on (`page`) and, when it runs on, the page it ends on (`lastPage`). Pages are provenance: no approval hashes them, but a section that moves to another page is reported as changed (`its pages only`) so the file says where it is now.
- **Section ids** are the slugs of the heading path (`late-fees`, `shifts/training`), so they read as the document's outline and stay put when a section is added elsewhere. Text before the first heading is `intro`; a document with no headings is one section, `text`. A PDF's ids are by heading too, so a section that moves to another page keeps its id; a PDF with no headings is cut by page (`p1`, `p2`). Two sections with one id are told apart in order (`services`, `services-2`).
- **The title heading** (the first heading, when no other is at its level or above) names the document and starts no section. A DOCX Title paragraph or Markdown front matter `title:` names it instead.
- **Text** keeps its paragraphs (a blank line between them, list items and table rows one to a line) with whitespace collapsed inside each. Approvals hash it with whitespace collapsed, so a re-wrapped paragraph is not a change and a changed word is.

## The formats

| Format | Read with | Sections |
| --- | --- | --- |
| HTML (`.html`, `.htm`) | linkedom (no browser, no scripts run); the content is the page's `<main>` or one `<article>`, else what Mozilla Readability picks, else the body; navigation, asides, footers, forms and media are dropped | at h1 to h3 |
| PDF (`.pdf`) | unpdf (pdf.js for servers, pure JavaScript); lines from positioned text, headings by font size (15% over the body size), paragraphs by vertical gaps | at headings, each with its pages; by page when there are none |
| DOCX (`.docx`) | mammoth to HTML by paragraph style, then the HTML path | at Heading 1 to 3 |
| Markdown (`.md`, `.markdown`) | a light reader: ATX and setext headings, lists, fenced code; inline markup stripped to its words | at `#` to `###` |
| Text (`.txt`) | paragraphs between blank lines | one section |

A folder is read recursively in name order. Hidden entries and `node_modules` are passed over, links are not followed, and any other file is listed as skipped. A scanned PDF has no text layer and is skipped with a note that it needs OCR first.

## The crawler

- It stays on the start page's host (and any `--allow-host`); a link elsewhere is listed, never fetched.
- It reads each host's robots.txt first: the groups for `dialogwright-kb` (or `dialogwright-kb-ingest`) when there are any, otherwise `*`; Allow and Disallow by longest match, Allow winning a tie, with `*` and `$`. A robots.txt that is not there (4xx) allows everything; one the server cannot give (5xx, no answer) stops the host being crawled. It honors a Crawl-delay up to 30 seconds, `<meta name="robots">` and `X-Robots-Tag` noindex and nofollow, and `rel="nofollow"` links.
- One request at a time, at least `--rate` ms apart to a host (default 1000, at least 100), and at most `--max-pages` pages and documents (default 50).
- `--depth` is how many links from the start page (default 1; 0 reads the start page alone), breadth first. It follows only `<a href>` links to http(s) URLs, canonical (the fragment dropped), and fetches each URL once, so links that go round are read once.
- It fetches pages and documents (PDF, DOCX); a link to an image, a stylesheet, an archive and the like is not fetched, and a response of another type is dropped unread. `--include` globs over the URL path narrow what is fetched beyond the start page (`/help/**`; `*.pdf` matches the last segment).
- It follows a redirect (up to 5) only where a link could go. No cookies, credentials or forms; responses over 20 MB or 30 seconds are dropped. Its User-Agent is `dialogwright-kb-ingest/<version> (+https://github.com/DialogWright/dialogwright)`.

A crawled page's id is the slug of its URL path (`/services/hours.html` is `services-hours`, `/` is `index`), with its host first when it is not the start's.

## Determinism and re-ingesting

The same input gives the same bytes: sections in document order, keys in a fixed order, no line folding, nothing from the clock but the date. A document whose title, provenance and sections (ids, order, headings, and text hashes) are unchanged is not rewritten, so its file and its `retrieved` date stay as they were; a changed document is written with today's date. A document keeps its id from run to run by its provenance; a new one whose slug another document has takes the slug with its extension (`faq-md`), then a number. A source file with other provenance, or none (written by hand), is never overwritten. Sources from the same folder or host that a run did not read are listed as not read this time and left as they are.

## Dependencies

| Package | Licence | Unpacked | Used for |
| --- | --- | --- | --- |
| `unpdf` | MIT (bundles pdf.js, Apache-2.0) | 2.1 MB | PDF text, no native code |
| `mammoth` | BSD-2-Clause | 1.7 MB | DOCX to HTML |
| `linkedom` | ISC | 0.9 MB | HTML parsing without a browser |
| `@mozilla/readability` | Apache-2.0 | 0.15 MB | the content of a page that does not mark it |
| `yaml` | ISC | (shared with dialogwright) | writing the source files |

Their own dependencies are MIT, ISC, BSD-2-Clause, BSD-3-Clause, `MIT AND Zlib` (pako) and `MIT OR GPL-3.0-or-later` (jszip, used under MIT).

## Tests

`pnpm --filter @dialogwright/kb-author test`. The fixtures under `src/__fixtures__` are fictional: a folder (a three-page patron guide PDF with headings, a two-page notice PDF without, a volunteer handbook DOCX, HTML, Markdown and text) and a small website with a robots.txt, served by a local `node:http` server on 127.0.0.1. Nothing reaches the network: the crawler's fetch in the tests refuses any other host, and its clock is fake, so the rate limit is tested without waiting.

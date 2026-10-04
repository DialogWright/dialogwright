# @dialogwright/kb-author

Builds a DialogWright knowledge base from documents. This package is for authoring only: an app never imports it, and the runtime package (`dialogwright`) carries none of its dependencies.

It is a pipeline of five commands:

1. **`pnpm kb:ingest`** reads the sources: a folder of PDF, DOCX, HTML, Markdown and text files, or a website crawled politely to a link depth. Each document becomes `kb/sources/<doc>.yaml`, its text by section with where it came from, which is what a passage is approved against.
2. **`pnpm kb:draft`** gives the sections to a drafter (Claude, with your own key; a fake in tests), checks every draft it proposes, and writes those that pass to `kb/pending`, which is never said.
3. **`pnpm kb:review`** serves a review page on this machine, where a person approves, edits then approves, or rejects each draft, and accepts or merges each topic a draft proposes.
4. **`pnpm kb:refresh`** reads every source again; a passage whose section changed is withheld until a person approves it again in the review page.
5. **`pnpm kb:gaps`** reads the traces of real calls and ranks what callers asked that the knowledge base did not answer, with the fix for each, so the next round of drafting and review starts from what callers needed.

## Ingesting

```sh
pnpm kb:ingest <folder | file | url> [--dir <app folder>] [--dry-run] [--json]
pnpm kb:ingest https://example.org/help/ --dir apps/my-app --depth 2 [--include '/help/**'] [--include '*.pdf'] [--max-pages 50] [--rate 1000] [--allow-host docs.example.org] [--allow-private]
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

A folder is read recursively in name order. Hidden entries and `node_modules` are passed over, links are not followed, and any other file is listed as skipped. A scanned PDF has no text layer and is skipped with a note that it needs OCR first. A file over 50 MB is not read. A DOCX is a zip, so its zip is checked before it is opened: its entries may hold at most 50 MB uncompressed in all and number at most 10,000, and each is inflated with its output capped at the size it declares, so a zip bomb, or an entry that holds more than it says, is refused unread. A PDF of more than 500 pages is refused before a page is read, and pdf.js opens every PDF with code evaluation off (`isEvalSupported: false`; the pdf.js it bundles evaluates nothing at all).

## The crawler

- It stays on the start page's host (and any `--allow-host`); a link elsewhere is listed, never fetched.
- It reads each host's robots.txt first: the groups for `dialogwright-kb` (or `dialogwright-kb-ingest`) when there are any, otherwise `*`; Allow and Disallow by longest match, Allow winning a tie, with `*` and `$`. A robots.txt that is not there (4xx) allows everything; one the server cannot give (5xx, no answer) stops the host being crawled. It honors a Crawl-delay up to 30 seconds, `<meta name="robots">` and `X-Robots-Tag` noindex and nofollow, and `rel="nofollow"` links.
- One request at a time, at least `--rate` ms apart to a host (default 1000, at least 100), and at most `--max-pages` pages and documents (default 50).
- `--depth` is how many links from the start page (default 1; 0 reads the start page alone), breadth first. It follows only `<a href>` links to http(s) URLs, canonical (the fragment dropped), and fetches each URL once, so links that go round are read once.
- It fetches pages and documents (PDF, DOCX); a link to an image, a stylesheet, an archive and the like is not fetched, and a response of another type is dropped unread. `--include` globs over the URL path narrow what is fetched beyond the start page (`/help/**`; `*.pdf` matches the last segment).
- It follows a redirect (up to 5) only where a link could go: on the hosts it may read, and allowed by robots.txt. robots.txt's own redirects are followed the same way, one hop at a time, each checked; one off the host leaves that host uncrawled. No cookies, credentials or forms; responses over 20 MB or 30 seconds are dropped.
- It reads only public addresses. Every host is resolved before each request and refused when any of its addresses is loopback, private (RFC 1918), link-local (169.254.0.0/16, where cloud metadata services answer, and fe80::/10), unspecified, shared (carrier-grade NAT, 100.64.0.0/10), unique local (fc00::/7), multicast or reserved, or an IPv6 address that carries one of these (IPv4-mapped `::ffff:127.0.0.1`, NAT64, 6to4). The connection is made to the address that was checked (the socket's lookup is pinned to it), so a second DNS answer cannot move it. `--allow-private` lifts the check, for a site on your own network; a start page on a private address is refused without it, before anything is asked of it. Its User-Agent is `dialogwright-kb-ingest/<version> (+https://github.com/DialogWright/dialogwright)`.

A crawled page's id is the slug of its URL path (`/services/hours.html` is `services-hours`, `/` is `index`), with its host first when it is not the start's.

A crawled page's provenance keeps the crawl's settings (`crawl: { start, depth, include, allowHosts, maxPages, rateMs }`, those given), so `kb:refresh` crawls the same way.

## Drafting

```sh
pnpm kb:draft [app folder] [--source <doc>]... [--topic-hint "<what to cover>"]... [--model <id>] [--all] [--dry-run] [--json]
```

A drafter is pluggable: `{ id, draft({ source, existingTopics, locale, maxAnswerChars, applies, topicHints }): Promise<Draft[]> }`, where a `Draft` is `{ topic, answer, excerpt, section, applies?, effective? }` and `topic` is a topic id `topics.yaml` has, or a new topic proposed as `{ id, title, keywords?, asks? }`. kb:draft gives it, document by document, the sections nothing cites yet (no passage, pending draft or rejected draft; `--all` for every section), with the knowledge base's topics (and those already proposed), its language, `maxAnswerChars` and `applies`.

- **The Claude drafter** (`ClaudeDrafter`) calls the Messages API with Node's fetch (no SDK), asking for JSON held to a schema (structured outputs). Its default model is `claude-haiku-4-5`; `--model` takes another (`claude-sonnet-5-5`). The prompt asks for one or two short spoken sentences within `maxAnswerChars`, each with the words of its section that support it copied exactly, no variables, and nothing the document does not say. A long document is sent in parts of whole sections. The key is read from `ANTHROPIC_API_KEY` when a request is made (kb:draft loads `.env` from where it is run when the variable is not set), sent only in the `x-api-key` header, and never logged or written; an error from the API is reported without it. Drafted passages record `drafted.by: kb:draft claude <model>`.
- **It never runs in CI**: kb:draft refuses when `CI` is set. No test makes a real call; the one live test is skipped unless `ANTHROPIC_API_KEY` is set and `DIALOGWRIGHT_LIVE_DRAFT=1`.
- **Every draft is checked** before it is written, and a draft that fails is reported with why and never written:

| Check | Refused as |
| --- | --- |
| the section is in the source | `section "9.9" is not a section of kb/sources/patron-guide.yaml` |
| the excerpt is there, word for word (whitespace aside) | `its excerpt is not in kb/sources/patron-guide.yaml section "3.1" word for word` |
| the excerpt is long enough to hold the answer to: at least 4 words and 20 characters | `its excerpt "overdue" is too short to hold the answer to: quote at least 4 words and 20 characters of the section` |
| every number in the answer (an amount, a time, a date, a count in figures) is in the excerpt, compared as numbers (`$5.00` is `5`, `9:00` is `9`, `1,000` is `1000`; the excerpt's `sixty` or `twenty-five` count) | `its excerpt does not say 50, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes` |
| the answer is short | `its answer is 487 characters, over the 400 kb.yaml allows (maxAnswerChars): a spoken answer is one or two short sentences` |
| the answer is fixed text | `its answer has a brace: an answer is fixed text, said word for word, with no variables` |
| the topic is an id, and a new one has a title | `its topic "room_hire" is not in kb/topics.yaml, and it proposes no title for a new one` |
| applies and dates are ones kb.yaml allows | `its applies gives card "senior", which kb.yaml's applies does not list for card (adult, junior)` |
| it is not a repeat | `it repeats the answer of the passage "opening-hours"` |

- A draft that passes is written to `kb/pending/<id>.yaml` (its id from its topic and applies, made distinct), in dialogwright's draft format: the passage's fields, `effective.from` the day it was drafted unless the source gives dates, and `drafted: { by, on, excerpt }`. A topic it proposes is added to `kb/pending/topics.yaml` (topics.yaml's format), never to `topics.yaml`; `pnpm check` and the engine never read either.

## Reviewing

```sh
pnpm kb:review [app folder] [--port N] [--traces <path|glob>]...
```

It starts a small server and prints its URL. The page lists the proposed topics, the drafts waiting and the passages withheld (their source changed, they were edited, or never approved). A draft is shown beside its source section with its excerpt marked; a passage withheld after its source changed, beside a word diff of the section as it was approved against the section now. The page asks each browser once who is reviewing (a person's name, which kb:approve's own check holds to, and the team that owns the content), then offers:

- **Approve**: dialogwright's kb:approve itself (`--by` the reviewer, `--owner` the team for a draft; a passage keeps its owner).
- **Edit, then approve**: the answer, `applies`, the dates, and a draft's excerpt. The edit is checked as kb:draft checks a draft, and the excerpt must still be in the section word for word; a refused edit or approval leaves the file as it was.
- **Reject** (a draft): it moves to `kb/rejected/<id>.yaml` with `rejected: { by, on, reason }`, a record kept in the repository; kb:draft passes over the sections a rejected draft cites.
- **A proposed topic**: accept it into `topics.yaml` with its title as you write it (a topic's title is said to callers: the topic question offers it, so the page asks you to review it; at most 80 characters, no braces), renamed if you give another id (the drafts that name it follow), or merge it into a topic `topics.yaml` has (its drafts re-pointed). A draft of a proposed topic is approved after its topic. When `kb.yaml` names an embedder, run `pnpm kb:index` after accepting topics.
- **The Gaps tab** (`/gaps`, linked in the header): the ranked list `kb:gaps` prints (below), read from the traces each time it is opened (`--traces` as for kb:gaps; by default `$TRACE_DIR`, else the app's `traces/`, else `./traces`). Each group links from its fixes to where they are done: a stale passage to its withheld page (while it is withheld), a topic to its page (the topic's keywords and asks, its passages with their state, and the drafts that answer it), and "draft from" to a page listing every sample of the callers' words and the sections nothing cites that read as relevant, with the `pnpm kb:draft` command to draft from them (the page runs nothing; drafting uses your key on your command line). It shows the callers' words as the traces recorded them, behind the same token.

Its access, and why it is not in the operator console: the console has no access control until Phase 8, and its tunnel carries the public's requests, so the review page is a separate local server instead.

- It listens on 127.0.0.1 alone (a free port unless `--port`) and answers only a loopback peer whose `Host` is that address and port (so a page elsewhere cannot reach it through a name that resolves to 127.0.0.1).
- A random 32-byte token, new each time it starts, is in the URL it prints. Every request, reading or writing, must carry it (the `token` query parameter, a form's `token` field, or an `x-review-token` header), compared in constant time; without it the answer is 403. A change must be a form POST, and from the page itself when the browser sends an Origin.
- Who is reviewing is kept per browser. Once a request has shown the token, the page sets a session cookie: a random id signed with a key made when the server starts, `HttpOnly`, `SameSite=Strict`, named for its port (`dw-review-<port>`). The reviewer's name and team, and the outcome of their last change, belong to that session alone; another browser with the token is asked who it is, and a cookie whose signature does not hold starts a new session.
- What a reviewer saw is what they approve. Every form that changes a draft, a passage or a topic carries a hash of what its page showed when it was opened (the draft's or passage's file as it is on disk with its source section's text, or the proposed topic), and the change is refused when the file or the section changed since: "changed since you opened it: reload the page and review it again".
- Every id in its URLs names a draft, a passage or a topic, checked against the knowledge base's id patterns before anything is read; each file an action reads, writes or moves must be in `kb/pending`, `kb/rejected`, `kb/passages` or `kb/locale/<tag>/passages` (its real path, links followed). The reviewer form comes back only to a path of the page's own.
- Its pages load nothing from anywhere else (a Content-Security-Policy with a nonce for its one style and one script), are not cached, send no Referer and cannot be framed. They read without JavaScript, and the actions are plain forms (the script only asks before a reject). Every field has a label, there is a skip link, and the diff and the excerpt are announced to a screen reader.

**The approved text, for the diff.** An approval hashes its section's text; to show what changed, kb:approve now also keeps that text in its `kb/approvals.jsonl` line (`sourceText`). The review page takes the last line for the passage whose `sourceHash` is the passage's approval's and whose text hashes to it, so the text is the one approved, checked by its hash, from a log that is only appended to and is committed with the knowledge base. A passage approved before this has no text kept, and the page says to read the source's git history instead.

## Refreshing

```sh
pnpm kb:refresh [app folder] [--allow-private] [--dry-run] [--json]
```

It reads every source in `kb/sources` again from its provenance: a file from the app folder, a crawled page through its crawl (once per crawl, with the settings recorded), a page with no crawl recorded on its own. A source file is text anyone with the repository can edit, so what it names is held to bounds: a file is read only when its real path (links followed) is a file inside the app folder, and a `../` path, an absolute path, a link out of the folder or a folder is refused and reported as failed; a URL is read only when it is http(s), through the crawler, so a host on a private network is refused unless `--allow-private`. Before it asks any website it prints the hosts the sources name (`kb:refresh: asking library.example (the hosts the sources were read from)`). It writes the documents that changed, and nothing else, then reports:

```
kb:refresh kb: 2 reads (1 document): 0 added, 1 changed, 0 unchanged
  changed   faq: ~ borrowing/lost-cards
  not read  patron-guide: its file patron-guide.pdf is not there (the source is left as it is)
withheld, their section changed (1): callers are not given them until a person approves them again
  lost-cards  lost_cards  kb/sources/faq.yaml section "borrowing/lost-cards"
sections no passage or draft cites (4): draft them with pnpm kb:draft --source faq
  faq: intro, borrowing, borrowing/how-long-can-i-keep-a-book, borrowing/returns
next: pnpm kb:review shows each withheld passage beside what changed in its section
```

A passage whose section changed is withheld by the engine itself (its approval's `sourceHash` no longer matches); one whose section is gone is withheld and listed apart, to point at the section that says it now or delete. A source written by hand, or whose file is gone, is left as it is. Exit codes: 0 done, 1 a source that could not be read again because of an error, 2 a command line not understood.

## Finding gaps

```sh
pnpm kb:gaps [app folder] [--traces <path|glob>]... [--since YYYY-MM-DD] [--samples N] [--out <file>] [--json]
```

It reads the trace files of real calls and ranks what callers asked that the knowledge base did not answer. `--traces` names a trace file, a folder of them (its `.jsonl` files, not the `.frames.jsonl` logs beside them) or a glob (`traces/*.jsonl`, `runs/**` with `**` for any depth); repeat it for several. Without it, the folder a server (or the text harness) writes to: `$TRACE_DIR` when set, else the app folder's `traces/`, else `./traces`. `--since` keeps turns from that day on, `--samples` is how many of the callers' words each group shows (default 3), `--out` writes the report to a file, `--json` prints JSON for tools. Exit codes: 0 a report (gaps or none), 1 a problem (the knowledge base does not load, no trace files found), 2 a command line not understood.

**What counts as a gap**, turn by turn (a turn is at most one; the collector is `src/gaps/collect.ts`):

| Kind | Detected as | Fix |
| --- | --- | --- |
| answered none | The topic slot's question was asked (retrieval nominated topics) and the model answered `none`, or chose a topic that the slot did not fill (below its threshold: no slot holds it, no gated call or knowledge record names it, and it is not a disambiguation). Left out when the call went on to ask another slot's question. | Add the way callers put it to the nearest topic's `asks` and `keywords` when it has a passage; write a passage for it when it has none |
| asked, nothing nominated | Retrieval ran (a topic slot was listening) and nominated nothing, on words that look like a question: they end in `?` (or start with `¿`), start with a question word (`what`, `how`, `can`, `qué`, `cuándo` and the like, `QUESTION_WORDS`), or the model's intent was `other` or an informational intent of the app's `intents.yaml`. Left out when the caller was answering a one-time code, a yes or no, or another slot's question. A retrieval that failed (`error`, `invalid`, `late`) nominated nothing for another reason: counted in the report, never a gap. | Draft from a source section that reads as relevant, or write a topic and passage; add keywords and asks to the keyword-nearest topic when there is one |
| unavailable | The resolving tool answered `no passage (<reason>)` in a gate event, or the turn's knowledge record is not fresh, or the unavailable line was said: `stale` (its source section changed), `not-in-force` (no passage for these callers on the day), `no-translation` (the caller's language has none, `localeFallback: none`), `no-facts` (the system of record had none for the caller), and rarely `unknown-topic`, `ambiguous`, `no-answer`. The words are those that asked (an earlier turn's, when this one is a "yes" or the topic's name). | Re-approve the stale passage; write a passage in force for the topic; add a translation; check the system of record for `no-facts` |
| close call | The slot asked the caller which of two topics they meant (a `disambiguate_<slot>` prompt on a turn that asked the topic question): the two topics are the question's two best answers. | Add keywords and asks to both topics that tell them apart |

A quarantined turn (the injection screen) is never a gap and its words are never read. Words with a masked value are never shown: a turn on which an identity slot took a masked value (its last four, its year, its length: the marks the trace writer leaves), or whose gated call or decision carries one, is counted but its words are withheld (the report says how many). Every other turn's words are the trace's recorded text, as it is: the traces hold what callers said, so keep a gaps report as private as they are.

**Grouping and ranking.** A gap falls in the group of its nearest topic: the topic retrieval nominated first; for an asked-with-nothing-nominated turn, the topic the keyword retriever (the engine's `KeywordRetriever`) scores best on the words, else "no near topic"; for an unavailable turn, the passage's own topic. Groups are ranked by how many gaps they hold, then how recently the latest happened, then the topic id, so the same traces give the same report. Each group shows how its gaps divide, up to N distinct samples of the callers' words (newest first), the fix for each kind it holds, and, where a passage would help, the source sections nothing cites that read as relevant: the keyword retriever scored over the sections' headings and text, held to sections that match at least a third of the meaningful words (four letters or more) of what callers said and the topic's title and keywords, so one shared word does not make a section relevant to a long question. A topic the knowledge base does not have is named as such.

```
# Knowledge gaps

kb: 11 gaps in 4 groups, from 27 turns in 13 calls (13 trace files, 2026-10-01 to 2026-10-03).

By kind: 3 answered none, 3 asked with no topic nominated, 4 unavailable, 1 close call.

## 1. Late fees (late_fees): 6 gaps

3 answered none, 2 unavailable (stale 1, no translation 1), 1 close call. Latest 2026-10-02.

Callers said:
- `what do I owe for an overdue book` (answered none, 2026-10-02)
- `is there a fine for returning a book late` (answered none, 2026-10-02)
- `cuánto cuesta una multa` (unavailable: no translation, 2026-10-02)

Fix:
- If topic "Late fees (late_fees)" should answer these, add the way callers put it to its asks and keywords in kb/topics.yaml; ... (3)
- Tell "Late fees (late_fees)" and "Renewing a library card (card_renewal)" apart: add the words that set each one apart ...
- Add a translation of topic "Late fees (late_fees)"'s passage for es (kb/locale/<tag>/passages, ...)
- Re-approve passage "late-fees-adult": its source section changed, so callers are not given it (pnpm kb:review shows what changed).
```

The JSON (`--json`) is the same report as data: `{ kb, since, traces: { files, turns, calls, from, to, skipped, retrievalFailed }, gaps, byKind, groups: [{ key, topic, title, known, near, count, latest, kinds, reasons, withheld, samples, fixes, draftFrom }] }`, each fix `{ id, kind, text, count, passage?, topics?, locale? }` with `id` one of `add-keywords`, `write-passage`, `draft-from-section`, `re-approve`, `add-translation`, `check-facts`, `fix-topic`, `fix-overlap`, `check-tool`.

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

Drafting, reviewing, refreshing and finding gaps add none: the Claude drafter uses Node's fetch, and the review page Node's http and crypto.

## Tests

`pnpm --filter @dialogwright/kb-author test`. The fixtures under `src/__fixtures__` are fictional: a folder (a three-page patron guide PDF with headings, a two-page notice PDF without, a volunteer handbook DOCX, HTML, Markdown and text) and a small website with a robots.txt, served by a local `node:http` server on 127.0.0.1. Nothing reaches the network: the crawler's fetch in the tests refuses any other host, and its clock is fake, so the rate limit is tested without waiting. The pipeline's test (`src/pipeline.test.ts`) runs it end to end on dialogwright's own library app with the fake drafter: a PDF ingested, drafted (good drafts written, a bad excerpt, an over-long answer, a variable and a repeat refused), reviewed over HTTP with the token (a name given, topics accepted and merged, a draft approved, one edited then approved, one rejected), and the approved passages said on a call by the app's knowledge completion; then a source changed, refreshed, its passage withheld, the diff shown, approved again and said. The Claude drafter's request is tested against a mocked fetch. The gaps tests (`src/gaps/gaps.test.ts`) run scripted calls to a scratch copy of dialogwright's library fixture app through `runTurn` with a scripted model client and the engine's own trace writer (`src/__fixtures__/gapCalls.ts`), so the trace records they read are real: each gap kind, the grouping and ranking, the masked words withheld, the Markdown and JSON reports, the command and the review page's Gaps tab (the token required).

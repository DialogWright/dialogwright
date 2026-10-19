# Where a knowledge answer comes from, on a chat

Date: 2026-10-19. Status: **decided (the maintainer, 2026-10-19); built on main.**

## The problem

An answer from a knowledge base is drawn from approved passages or approved sections of documents, and the engine records which (the knowledge record, the trace, the audit). The person reading it on a chat could not see that. Commercial assistants show a citation under an answer; a reader trusts an answer they can check, and a reviewer can see at a glance which section it came from.

## The decision

- **An option, off by default.** app.yaml's `chat: { sources: on }`.
- **What it shows.** Under an answer from the knowledge base, on a chat only, where its words come from: each document's title, the section's heading (in the glossary's words, as answers say them) and the page it starts on, where the document has pages. "Source: Benefit Booklet · Emergency Services · p. 32"; several joined by "; ".
- **Which sources.** An answer worded from sections cites every section it was drawn from. One said as the lines of its sections (`onFail: lines`) cites only the sections whose lines it said. An approved passage cites the section it was drawn from. A line that says no answer (not found, unavailable, a stale passage) cites nothing.
- **Where it is decided.** The core, from the turn's knowledge record, on the line that says the answer (its `{answer}`), only on a channel that shows words (`core/sources.ts`). The renderer keeps the sources when it words the line again, and narrows them on a lines fallback.
- **The wire.** A chat `say` gains `sources` (`{ document, section?, page? }`), absent everywhere else, so the wire stays version 1. The widget shows them as text, in its own words (`source`, `sources`, `page` in `strings`).

## Not now

Spoken sources on a call ("from your benefit booklet's emergency section"): a line can already say it in its frame. A link to the document itself: the server does not serve source files.

# A line formatted on a chat

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18); built on main.**

## The problem

A line has one text, said on a call and shown on a chat alike. A chat can show more than a call can say: a list of three services reads as a wall of text when it is one spoken sentence ("A light clean is ..., a standard clean adds ..., a deep clean adds ..."), where a chat could show three items with their names in bold. A booking line met it: its services line, fine on a call, was the one hard-to-read reply on its chat page. Hosted agents show formatted replies, and some a site's own interface for them; the first step is formatting.

## The decision

A line in prompts.yaml may give its words on a chat, `chat:`, beside its `text`:

```yaml
services_info:
  text: We come to you. A light clean is an exterior hand wash and dry, ... A deep clean adds shampooed seats and carpets, ...
  chat: |
    We come to you. Here's what each clean includes:
    - **Light clean**: an exterior hand wash and dry, the wheels, the windows and a quick vacuum inside.
    - **Deep clean**: everything in a standard clean, plus shampooed seats and carpets, the door jambs, and dressed tires.
  interruptible: true
```

- **Where.** On a channel that shows words (a session without speech: the web chat) the line is its chat version; everywhere else (a call) its `text`, so no formatting is ever spoken. A line without one is its `text` on a chat too, as before. A locale gives its own (a locale's line without one shows that locale's `text`).
- **What it may hold.** A small subset of Markdown: paragraphs (a blank line between them; a single newline is a line break), lists (`- ` or `* ` for bullets, `1. ` for numbers), `**bold**` and `*italic*` (or `_italic_` at a word's edge), and a backslash before a character to show it as it is. No headings, links, code, tables, quotes, HTML or nested lists: `pnpm check` names each, with its fix.
- **Values.** It is given what its line's `text` is given: the text's variables, and any other the code that says the line gives (an `onSummaryRead`'s `vars`: a field the list shows that the spoken sentence words its own way). One it names and is not given shows the line's `text`, plain, rather than fail the turn; `pnpm check` warns of a variable the text does not name, since it cannot see what the code gives. The template is parsed first and each variable filled after, as a run of plain text in its place's style, so a value (a caller's name, a system's reply) never becomes formatting, whatever it holds.
- **Fixed lines only.** Not on a generated line (`mode: generative`, `generate`, a form's `wording: generative`): a generated line is worded from its text, and its fallback is its text, on every channel. Not on a line with `variants` (said in turn). `pnpm check` and validateApp refuse each.
- **The wire.** The line's `Say` carries the version's blocks (`rich`: paragraphs and lists of runs, each run text with `bold` or `italic`, or a line break), and its parts the same words as plain text. A chat `say` message keeps `text` (those plain words: for a client that reads only `text`, a screen reader's fallback, the trace and the console) and adds `rich` where the line has a chat version. A client that does not know `rich` is unchanged, so the wire stays version 1. The words are never sent as markup: a client builds elements and text nodes from the tree.
- **The widget** draws `rich` in its panel, and exports `renderRich` (`DialogWright.renderRich` on a page) for a site's own interface over `createChatClient`. A block or a run it does not know is left out; with nothing left it shows `text`.
- **What a later turn reasons about** (`lastPromptText`, the line just played as the decision model is told it) is the plain words of what was shown.
- **The policy card** lists every line with a chat version, what a call says beside what a chat shows, a prescribed one marked: a regulated line's chat words are the app's too.

## Not now

Lines a model words stay plain (a summary, a knowledge answer). A repeat ("say that again") shows the line's plain words. Buttons for a question with fixed answers (a choice slot's options), and interfaces of a site's own beyond formatting, are the next step, with this tree as their shape.

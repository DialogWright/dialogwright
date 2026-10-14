# Example Front Desk

A fictional phone line that answers for a small design studio when no one can pick up, and the example app for **generated wording done safely**: a read-back that summarizes what the caller said, the way a receptionist would, while every other word the caller hears is fixed. Built with the [create-app skill](../../.claude/skills/create-app/SKILL.md) from the paragraph in [DESIGN.md](DESIGN.md), which is also its design worksheet. Read it beside [the clinic](../clinic/README.md): the clinic is the app to learn the folder from, and this one adds a framed line. Every name, number and the address in it is made up (the 555 range, `example.com`).

A caller can:

- **leave a message** for Riley Moreno, Sam Okafor or Jordan Lee, or for anyone at the studio: their name, a number to call back (on a phone call the line offers the number they are calling from), and the message in their own words. The desk reads it back briefly ("Thanks, I'll make sure Riley Moreno gets your message: Alex Rivera, on 555 555 0142, called and said, in short, the logo files are ready for review. Shall I pass it on?"), and a yes delivers it to the studio's inbox (a stub) and ends the call;
- **say it's urgent, or ask for a person**, at any point, even in the middle of a message, and be put through to the studio's main line;
- **ask for the hours** (weekdays, nine to five) **or the address** (an invented street), by voice or on the keypad;
- **ask whether someone is in**: the desk never says where anyone is or when they are in, and offers to take a message instead.

Nobody verifies who they are: the one action is at level 0, held only to what the caller said yes to.

## The read-back: one generated span in a fixed line

The read-back is a **framed line** ([guide, 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)), `confirm_take_message` in [prompts.yaml](prompts.yaml):

```yaml
confirm_take_message:
  text: "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said, in short, {summary}. Shall I pass it on?"
  exactText: "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said: {summary}. Shall I pass it on?"
  generate:
    summary:
      from: message
      goal: Summarize the caller's message briefly, in their own terms, as a receptionist reading it back.
      words: 20
  summarizesConfirmed: true
  when:
    situations: [first-ask]
```

- **Only `{summary}` is generated.** Every other word is the app's: who the message is for, who called, the number, "called and said, in short," and the question. The model never sees them. It is sent only the span's goal, the caller's message (quoted, as data), the word budget and the style ([style.yaml](style.yaml)). The frame says whose words follow, so whatever the model writes is heard as what the caller said, never as something the studio promises.
- **It is checked before anyone hears it**: against the caller's words alone, by shape (no question, no figure, date or name the message does not have, its word budget, and the rest the [policy card](POLICY.md) lists under "Lines a model words", in the engine's own words) and by the decision model's judgement that it is a faithful summary ([guide, 16.6](../../docs/guide/16-generated-wording.md#166-the-checks-and-the-fallback)). The message is screened for an injection again first. Any failure, a slow model or an error, and the span is the caller's message, word for word.
- **Two frames, each true of what it frames.** `text`, with "in short", is said only when the summary was generated. Whenever the span is the caller's message word for word (no model set up, a check that fails, a slow model, a read-back after a no, a repeat, a later reading), the line is `exactText`, "called and said:", so "in short" is never said before the caller's exact words. `exactText` has no "Thanks,": it often follows "Here it is exactly as I took it down."
- **The message itself is never changed.** The `message` slot keeps the words as said, the caller's yes covers exactly what the slots hold, and the inbox gets the message word for word, whatever the summary said.
- **"That's not right" reads back the exact words.** A no to the read-back says "Here it is exactly as I took it down." and the line again with the message whole (forms.yaml's `summary: { onNo: read-back }`). The caller can then say yes, or "no, let me say it again" to give the message again; a read-back after the first is always word for word (`when: first-ask`), and so is asking to hear it again.
- **Every other line is said word for word.** The lines that say what was done and the handoff lines are also marked `prescribed: true`, so they can never be generated. [POLICY.md](POLICY.md), the policy card, lists the generated span and every prescribed line for a reviewer.

## An app that keeps no caller words: `redact: length-summarized`

The message slot is `redact: length-summarized` ([guide, 16.3 and 16.5](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)), and this app is its demo, deliberately. The message is kept in the session for the call (the read-back says it, the span is worded from it, the inbox is sent it) and sent whole to the render model only to word the span. Everywhere it is recorded, it is kept by its length. In short, the records keep **every turn's words and the message by their length; the caller's name as given, the number by its last four**. The consequences, all intended:

- **No caller's words, as said, in the records.** The message may come on any turn (in one breath with the request, as a correction), so every caller's words, on every turn, are kept by their length in the trace, on the console and in the frame log; our lines that say the message or its summary are kept with that part by its length. The server says so at start.
- **The caller's name is kept as given.** The `caller` slot (a `name`, no redact) is in the trace's slot state, on the console, in the read-back's values and in the handoff data, whole: the read-back says it, and the person on the main line needs it. Only the action's param is recorded by its length in the audit (policy.yaml's `audit: caller: length`). The callback number is kept by its last four everywhere it is recorded.
- **Its calls cannot be replayed** from a frame log (`--replay` refuses, saying why), and **`pnpm kb:gaps` finds no caller questions** in its traces (the app has no knowledge base anyway).
- **The audit** records the message by its length (so policy.yaml declares no `audit` for it), and **a handoff** hands it over by its length, whatever app.yaml's `handoff.data` says: the person on the main line does not get the message from the transfer.
- The recognizer and the decision model still hear every caller's words, as for every app.

The action's params are recorded as policy.yaml and the slots say: the person as it is, the callback number by its last four, the caller's name and the message by their length. The policy card lists the message as "sent whole to the render model to summarize; masked in the records".

## The folder

```
app.yaml        who the app is, the handoff data, where a transfer goes (STUDIO_MAIN_LINE)
intents.yaml    the message, urgent (must never wait), the hours, the address, "is Riley in?", and the keypad menu
forms.yaml      the message form (with its read-back) and the urgent form (straight to a person)
slots.yaml      recipient (a choice), caller (a name), phone (digits, offering the caller's number), message (text, as said, kept by its length in every record)
prompts.yaml    every line a caller can hear: all fixed, but the span inside the read-back
style.yaml      how the span sounds: a persona and phrases to avoid
policy.yaml     the one action, a message delivered, held to what the caller said yes to
policy.matrix   what the gate decides, for every kind of caller (generated)
POLICY.md       the policy card: the policy, the generated span and the prescribed lines in plain English (generated)
APP-MAP.md      the app map: intents, forms, slots, actions and where a handoff goes, as diagrams (generated)
DESIGN.md       the design worksheet: the paragraph, every choice and every gap found
src/app.ts      the tool (a stub inbox) and the form hooks, joined to the folder by defineApp
src/data.ts     the fixture data behind the stub (each person's inbox, at example.com)
fixtures/       the corpus, the scripted calls and the stub baseline
```

## Try it with no keys

Run these at the repository root. Nothing here needs a key: the stub decision model answers from the labels in `fixtures/corpus.jsonl`, and the span is worded by the engine's fake renderer (the message's first clause), with every check run on it. So a one-clause message comes back as itself, said unchanged with the exact-words frame ("called and said: ..."); a longer one is "summarized" to its first clause with the "in short" frame, unless that leaves out a clause that says "no" or sets a condition (`omitted`), and the exact words are said instead.

```sh
pnpm --filter @dialogwright/example-secretary regress                       # every corpus line and scripted call: "no changes", then a summary
pnpm --filter @dialogwright/example-secretary regress --scenario message-read-back-corrected   # one call, turn by turn: the summary, a no, the exact words, the message again
pnpm --filter @dialogwright/example-secretary regress --scenario urgent-at-the-read-back-with-a-correction
pnpm --filter @dialogwright/example-secretary cli --client heuristic        # a text console that understands by keywords
```

A scripted call's transcript shows each line the caller hears, and under the read-back whether the span was generated or why it was said exact (`line confirm_take_message: generated; fixed "..."`, `fixed, said unchanged` when the wording was the message itself, `fixed, fell back (omitted)` and the like when a check refused it, `fixed (exact)` after a no, `fixed (when)` on a later reading). The run's last line counts the generated lines: how many were tried, said generated, said unchanged and fell back, and why.

To try the web chat and the console on this computer, `pnpm configure --app secretary` (choose "on this computer"; it asks for the studio's main line, `STUDIO_MAIN_LINE`, where every handoff goes: a 555 number such as +15555550100 is fine on a laptop, or give it as `--number STUDIO_MAIN_LINE=+15555550100`), then `pnpm start --app secretary`.

On a real line, `STUDIO_MAIN_LINE` must ring a person: never the number that forwards to this desk when no one picks up, or an urgent caller is put straight back to the desk.

## Commands

```sh
pnpm check                                                     # every app folder: YAML, schemas, cross-links to the code, prompts, corpus
pnpm --filter @dialogwright/example-secretary typecheck
pnpm --filter @dialogwright/example-secretary test
pnpm --filter @dialogwright/example-secretary regress            # --scenario <id>, --corpus <id>, --adversarial <id>: one, turn by turn
pnpm policy:matrix apps/secretary && pnpm policy:card apps/secretary && pnpm app:diagram apps/secretary   # after a change to the policy, the forms, the tools or the generated span
```

The regression also runs the adversarial suite (app.yaml's `testing: { adversarial: on }`), with its wording family for this app's span: a message that tries to be stated as the studio's own (a refund, a waived fee), a "not" dropped from the message, the message summarized as for one of the other people, and a renderer that writes into the frame. Each falls back to the caller's words, and the frame is always said as written. It prints `adversarial N/N cases hold`; a `FAIL adversarial` line is a finding about the app, never a case to loosen.

## The fixtures and the baseline

- `fixtures/corpus.jsonl`: 128 labelled lines, at least eight for every intent and five for every slot, four or more for the read-back, and the answers to the offer of the caller's number.
- `fixtures/scenarios/`: 52 scripted calls, each with the outcome it expects. `messages.json`: the read-back summarized, accepted, refused (the exact words), refused twice ("What should I change?") and the message said again or read back there, corrected (the message said again), repeated, the recipient and the number corrected, "anyone" (and "I'm not sure who"), the callback offer accepted, declined, answered with another number, a withheld number, keys, the chat, and the boundary with urgent ("it's not urgent, but ...", "call me back as soon as possible"). `handoffs.json`: urgent at the start, mid-message and at the read-back with a correction; a person asked for at the start, mid-message, at the read-back and on the keypad menu. `answers.json`: the hours and the address spoken and keyed, "is Riley in?" (then "yes please" to the offer of a message), a quote or a meeting taken as a message, a request the desk does not handle, an answer mid-message, and a caller who is done.
- `fixtures/expected/`: the stub's outcome for every line and call, made once and reviewed (DESIGN.md, "Baseline edits"). Never regenerate it: a changed output is a finding to explain.

## Recording against the real models

The stub answers from the labels, and the fake renderer stands in for the model that words the span. **Before recording, read "Known limits" in [DESIGN.md](DESIGN.md#known-limits)**: a two-breath message, and the lines the first recording should watch. A recording holds two models' answers, recorded once and replayed offline: the decision model's (which reads what callers say, and judges each span faithful) and the render model's (which words the span). Recording calls two paid APIs (a few cents for an app this size), so it is a deliberate step for the app's owner, never part of CI and never an assistant's.

1. **The decision model's key** goes in this folder's `.env` (git-ignored): at the repository root, `pnpm configure --app secretary --mode model` asks for the model and its key and writes the file; or copy `.env.example` to `.env` here and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or another provider's with `JEV_PROVIDER`: `.env.example` lists them).
2. **The render model's key** (`ANTHROPIC_API_KEY` for `RENDER_PROVIDER=anthropic`, `OPENROUTER_API_KEY` for `openrouter`) may live in a file of your own, kept outside the repository. `ENV_FILE` names several settings files, separated by commas, read in turn ([guide, 14](../../docs/guide/14-running-it.md)), so the two are read together with no shell `source`. The provider, the model and the budgets are not secrets, and a variable on the command line wins over the files.
3. **Record**, at the repository root, with the default render model (a current Claude Haiku on Anthropic, [guide, 16.7](../../docs/guide/16-generated-wording.md#167-running-it)):

   ```sh
   ENV_FILE=apps/secretary/.env,<your render.env> RENDER_PROVIDER=anthropic RENDER_TIMEOUT_MS=15000 RENDER_CHECK_TIMEOUT_MS=15000 pnpm --filter @dialogwright/example-secretary regress --client record --threshold JEV_TIMEOUT_MS=15000
   ```

   Without `RENDER_PROVIDER` it records no span and every read-back is the exact-words frame. The longer budgets keep a slow answer from being recorded as a timeout. It appends the decision model's answers to `fixtures/recorded/<model>.jsonl` and the spans to `fixtures/recorded/render/<model>.jsonl`, and never touches the baseline.
4. **Replay** offline, as often as you like: `pnpm --filter @dialogwright/example-secretary regress --client recorded` (with `RENDER_PROVIDER` and `RENDER_MODEL` as recorded, if not Anthropic's default). It runs every check again on every recorded span. Its last line counts what is left to decide (`to triage: ...`), and the generated-lines line how many spans were said and why any fell back; the create-app skill's [triage page](../../.claude/skills/create-app/triage.md) has the procedure.
5. After a second recording, `pnpm --filter @dialogwright/example-secretary cassette:trim`; then commit the cassettes. They hold the corpus text, the model's answers and the spans, never a key.

A change to the words in the YAML (criteria, labels, prompts, the span's goal) changes what a model is sent, so the replay reports each changed request as a cassette miss until it is recorded again.

### Which render model

Which model words the span is a measurement on this app's own lines ([guide, 16.12](../../docs/guide/16-generated-wording.md#1612-choosing-a-model)): `pnpm render:bakeoff` runs the corpus and the scripted calls once per model, each wording every span, the decision model's answers and its drift check the same for each, and prints one table (said generated, fell back and why, wording time against a call's 700 ms, cost):

```sh
ENV_FILE=apps/secretary/.env,<your render.env> pnpm render:bakeoff apps/secretary --fresh --models anthropic:claude-haiku-5-5,openrouter:google/gemini-2.5-flash-lite
pnpm render:bakeoff apps/secretary --replay --by-line --models anthropic:claude-haiku-5-5,openrouter:google/gemini-2.5-flash-lite   # the same table again, from the cassettes, with no key
```

On the engine's message fixture, Gemini 2.5 Flash-Lite through OpenRouter was the only model both accurate and inside a call's 700 ms, while Claude Haiku 5.5 was accurate but usually over that budget (well inside a chat's 1,500 ms). Whether the default model stays is pending this app's comparison. To make a model the app's, set `RENDER_PROVIDER` and `RENDER_MODEL` (and `RENDER_THINKING`, if any) in the app's settings and record the app once.

## Running it

`pnpm --filter @dialogwright/example-secretary serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN`, `HANDOFF_NUMBER` and `STUDIO_MAIN_LINE` (the studio's main line, where every handoff goes; a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise. With `RENDER_PROVIDER` and its key set, the read-back's summary is generated; without, the read-back is the exact-words frame with the message word for word. The server says at start that its frame log and trace keep no caller words. At the repository root, `pnpm configure --app secretary` writes this folder's `.env`, `pnpm diagnose --app secretary` says what is missing, and `pnpm start --app secretary` runs the server with it.

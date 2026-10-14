# Example Front Desk

A fictional phone line that answers for a small design studio when no one can pick up, and the example app for **generated wording done safely**: a read-back that summarizes what the caller said, the way a receptionist would, while every other word the caller hears is fixed. Built with the [create-app skill](../../.claude/skills/create-app/SKILL.md) from the paragraph in [DESIGN.md](DESIGN.md), which is also its design worksheet. Read it beside [the clinic](../clinic/README.md): the clinic is the app to learn the folder from, and this one adds a framed line. Every name, number and the address in it is made up (the 555 range, `example.com`).

A caller can:

- **leave a message** for Riley Moreno, Sam Okafor or Jordan Lee, or for anyone at the studio: their name, a number to call back (on a phone call the line offers the number they are calling from), and the message in their own words. The desk reads it back briefly ("Thanks, I'll make sure Riley Moreno gets your message: Alex Rivera, on 555 555 0142, called and said: the logo files are ready for review. Shall I pass it on?"), and a yes delivers it to the studio's inbox (a stub) and ends the call;
- **say it's urgent, or ask for a person**, at any point, even in the middle of a message, and be put through to the studio's main line;
- **ask for the hours** (weekdays, nine to five) **or the address** (an invented street), by voice or on the keypad;
- **ask whether someone is in**: the desk never says where anyone is or when they are in, and offers to take a message instead.

Nobody verifies who they are: the one action is at level 0, held only to what the caller said yes to.

## The read-back: one generated span in a fixed line

The read-back is a **framed line** ([guide, 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)), `confirm_take_message` in [prompts.yaml](prompts.yaml):

```yaml
confirm_take_message:
  text: "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said: {summary}. Shall I pass it on?"
  generate:
    summary:
      from: message
      goal: Summarize the caller's message briefly, in their own terms, as a receptionist reading it back.
      words: 20
  summarizesConfirmed: true
  when:
    situations: [first-ask]
```

- **Only `{summary}` is generated.** Every other word is the app's: who the message is for, who called, the number, "called and said:" and the question. The model never sees them. It is sent only the span's goal, the caller's message (quoted, as data), the word budget and the style ([style.yaml](style.yaml)). The frame says whose words follow, so whatever the model writes is heard as what the caller said, never as something the studio promises.
- **It is checked before anyone hears it** ([guide, 16.6](../../docs/guide/16-generated-wording.md#166-the-checks-and-the-fallback)): it asks no question; it names none of the other people the message could be for; it adds no "not" and drops none; it speaks as no "I", "we" or "you" the caller did not use; it keeps to 20 words; it names no figure, date or capitalized word the message does not have; and the decision model judges it a faithful summary of the caller's words. The message is screened for an injection again first. Any failure, a slow model or an error, and the span is the caller's message, word for word.
- **The message itself is never changed.** The `message` slot keeps the words as said, the caller's yes covers exactly what the slots hold, and the inbox gets the message word for word, whatever the summary said.
- **"That's not right" reads back the exact words.** A no to the read-back says "Here it is exactly as I took it down." and the line again with the message whole (forms.yaml's `summary: { onNo: read-back }`). The caller can then say yes, or "no, let me say it again" to give the message again; a read-back after the first is always word for word (`when: first-ask`), and so is asking to hear it again.
- **Every other line is said word for word.** The lines that say what was done and the handoff lines are also marked `prescribed: true`, so they can never be generated. [POLICY.md](POLICY.md), the policy card, lists the generated span and every prescribed line for a reviewer.

The records keep the action's values as policy.yaml says: the person as it is, the callback number by its last four, and the caller's name and the message by their length only. The slot keeps the message as said (it must, to read it back), so the trace has it: see "What is recorded" in [DESIGN.md](DESIGN.md).

## The folder

```
app.yaml        who the app is, the handoff data, where a transfer goes (STUDIO_MAIN_LINE)
intents.yaml    the message, urgent (must never wait), the hours, the address, "is Riley in?", and the keypad menu
forms.yaml      the message form (with its read-back) and the urgent form (straight to a person)
slots.yaml      recipient (a choice), caller (a name), phone (digits, offering the caller's number), message (text, as said)
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

Run these at the repository root. Nothing here needs a key: the stub decision model answers from the labels in `fixtures/corpus.jsonl`, and the span is worded by the engine's fake renderer (the message's first few words), with every check run on it.

```sh
pnpm --filter @dialogwright/example-secretary regress                       # every corpus line and scripted call: "no changes", then a summary
pnpm --filter @dialogwright/example-secretary regress --scenario message-read-back-corrected   # one call, turn by turn: the summary, a no, the exact words, the message again
pnpm --filter @dialogwright/example-secretary regress --scenario urgent-at-the-read-back-with-a-correction
pnpm --filter @dialogwright/example-secretary cli --client heuristic        # a text console that understands by keywords
```

A scripted call's transcript shows each line the caller hears, and under the read-back whether the span was generated or why it was said exact (`line confirm_take_message: generated; fixed "..."`, `fixed (exact)` after a no, `fixed (when)` on a later reading). The run's last line counts the generated lines: how many were tried, said generated and fell back, and why.

To try the web chat and the console on this computer, `pnpm configure --app secretary` (choose "on this computer"), then add `STUDIO_MAIN_LINE=+15555550100` to `apps/secretary/.env` (a 555 number is fine on a laptop: `pnpm configure` does not ask for a transfer target, and the server will not start without it; `pnpm diagnose --app secretary` says so), and `pnpm start --app secretary`.

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

- `fixtures/corpus.jsonl`: 117 labelled lines, at least eight for every intent and five for every slot, four or more for the read-back, and the answers to the offer of the caller's number.
- `fixtures/scenarios/`: 39 scripted calls, each with the outcome it expects. `messages.json`: the read-back summarized, accepted, refused (the exact words), corrected (the message said again), repeated, the recipient and the number corrected, "anyone", the callback offer accepted, declined, answered with another number, a withheld number, keys, the chat. `handoffs.json`: urgent at the start, mid-message and at the read-back with a correction; a person asked for at the start, mid-message, at the read-back and on the keypad menu. `answers.json`: the hours and the address spoken and keyed, "is Riley in?", an answer mid-message, and a caller who is done.
- `fixtures/expected/`: the stub's outcome for every line and call, made once and reviewed (DESIGN.md, "Baseline edits"). Never regenerate it: a changed output is a finding to explain.

## Recording against the real models

The stub answers from the labels, and the fake renderer stands in for the model that words the span. A recording holds two models' answers, recorded once and replayed offline: the decision model's (which reads what callers say, and judges each span faithful) and the render model's (which words the span). Recording calls two paid APIs (a few cents for an app this size), so it is a deliberate step for the app's owner, never part of CI and never an assistant's.

1. **The decision model's key** goes in this folder's `.env` (git-ignored): at the repository root, `pnpm configure --app secretary --mode model` asks for the model and its key and writes the file; or copy `.env.example` to `.env` here and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or another provider's with `JEV_PROVIDER`: `.env.example` lists them).
2. **The render model**: `RENDER_PROVIDER` (`anthropic` or `openrouter`), its key (`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`), and `RENDER_MODEL` if not the default, a current Claude Haiku ([guide, 16.7](../../docs/guide/16-generated-wording.md#167-running-it)). Without `RENDER_PROVIDER`, a recording records no span and every read-back is said exact. `regress` reads one settings file: this folder's `.env`, or the file `ENV_FILE=<path>` names instead. So either add the three render lines to this folder's `.env`, or keep both keys in a file of your own and name it with `ENV_FILE`. A variable already in the environment wins over the file, so the provider and the model may be given on the command line; a key never is.
3. **Record**, at the repository root, with one command (with the render settings in this folder's `.env`):

   ```sh
   RENDER_TIMEOUT_MS=15000 RENDER_CHECK_TIMEOUT_MS=15000 pnpm --filter @dialogwright/example-secretary regress --client record --threshold JEV_TIMEOUT_MS=15000
   ```

   or, with both keys in a file of your own, `ENV_FILE=<your file> RENDER_PROVIDER=anthropic RENDER_TIMEOUT_MS=15000 RENDER_CHECK_TIMEOUT_MS=15000 pnpm --filter ...` and the rest as above. The longer budgets keep a slow answer from being recorded as a timeout. It appends the decision model's answers to `fixtures/recorded/<model>.jsonl` and the spans to `fixtures/recorded/render/<model>.jsonl`, and never touches the baseline.
4. **Replay** offline, as often as you like: `pnpm --filter @dialogwright/example-secretary regress --client recorded` (with `RENDER_PROVIDER` and `RENDER_MODEL` as recorded, if not Anthropic's default). It runs every check again on every recorded span. Its last line counts what is left to decide (`to triage: ...`), and the generated-lines line how many spans were said and why any fell back; the create-app skill's [triage page](../../.claude/skills/create-app/triage.md) has the procedure.
5. After a second recording, `pnpm --filter @dialogwright/example-secretary cassette:trim`; then commit the cassettes. They hold the corpus text, the model's answers and the spans, never a key.

A change to the words in the YAML (criteria, labels, prompts, the span's goal) changes what a model is sent, so the replay reports each changed request as a cassette miss until it is recorded again.

## Running it

`pnpm --filter @dialogwright/example-secretary serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN`, `HANDOFF_NUMBER` and `STUDIO_MAIN_LINE` (the studio's main line, where every handoff goes; a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise. With `RENDER_PROVIDER` and its key set, the read-back's summary is generated; without, the read-back says the message word for word. At the repository root, `pnpm configure --app secretary` writes this folder's `.env`, `pnpm diagnose --app secretary` says what is missing, and `pnpm start --app secretary` runs the server with it.

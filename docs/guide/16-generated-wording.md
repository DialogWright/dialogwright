# 16. Generated wording

Every line an app says is fixed unless the app asks otherwise. Generated wording lets an app have chosen lines worded by a model for the moment (acknowledging what the caller just said, warmer when they are frustrated, a short summary of a message rather than the whole of it), held to the line's meaning and data by checks, with the fixed line said whenever a check fails or the model is slow. The core has decided before a line is worded: generated wording changes how a line is said, never what is decided, asked, refused or done. The design and the maintainer's decisions are [designs/2026-10-13-phase9-generated-wording.md](../designs/2026-10-13-phase9-generated-wording.md); the engine's part is `packages/dialogwright/src/render/`.

An app that marks no line generated never meets any of this: its turns, traces, audit rows, model requests, cassettes and policy card are exactly as they were.

## 16.1 When to use it, and when not

Which lines may be generated is the app's choice, never the framework's. Some uses:

- **A warmer re-ask.** A question asked again after a miss is where a fixed line sounds most like a machine. Generate it only then: `when: { situations: [re-ask] }`.
- **An acknowledgement that fits.** "Thanks, and what's the best number to call you back on?" after a name, rather than the same line every time.
- **Reading back a summary of what was collected.** A secretary reads back the gist of a message, not every word; the exact message is still what is kept, and read word for word when the caller asks (16.3).
- **An entirely generated experience.** A form's switch (`wording: generative`) generates every one of its lines, and an app may set it on every form.

What a line must say exactly (a legal notice, a disclosure, a figure the caller relies on, a keypad instruction) is the designer's to keep fixed. Mark such a line `prescribed: true`: it is said word for word whatever a form says, and `pnpm check` refuses `mode: generative` on it. The framework does not decide what is regulated; the policy card (16.8) lists every generated line and every prescribed one, so a reviewer sees exactly which lines a model words. A knowledge base's answers stay word for word ([12](12-the-knowledge-base.md)): a line that says one (it names `{answer}`) is never generated, `pnpm check` refuses `mode: generative` on it, and a form's switch leaves it fixed.

## 16.2 Turning it on

On a line, in prompts.yaml:

```yaml
# prompts.yaml, under prompts:
  ask_outageStart:
    text: When did the power go out?
    interruptible: true
    mode: generative
    goal: Ask when the outage started; briefly acknowledge what they just said.
    when:
      situations: [re-ask, frustrated]
      channels: [voice]
```

- `mode: generative` generates the line; it needs a `goal`, what the line must do, which the model is told. The `text` stays: it is the meaning the wording is held to, the fallback, and what a repeat of the line says.
- `when` (optional) limits where it is generated; everywhere else the fixed line is said. `situations`, any of: `first-ask` (the line has not been said before on this call), `re-ask` (it has: asked again after a miss, a no or a change), `after-correction` (on this turn the caller changed a value they had given, or said no to a read-back), `frustrated` (the caller has been frustrated on this call). `channels`: `voice`, `chat`. Both parts must hold.
- `prescribed: true` keeps the line word for word, always.
- `mode: fixed` keeps one line of a generated form fixed.

On a form, in forms.yaml:

```yaml
forms:
  take_message:
    slots: [recipient, caller, phone, message]
    summaryPromptId: confirm_take_message
    hooks: [confirmedParams, complete]
    calls: [leaveMessage]
    wording: generative
```

`wording: generative` generates the form's lines: each of its slots' questions (`ask_<slot>` and every `ask_<slot>_<anything>`: its retry, no-input and partial lines), their read-backs (`confirm_<slot>` and its variants) and its summary, unless a line says `mode: fixed` or is prescribed. A line with no `goal` of its own is worded to say what its fixed text says. A form line that names an identifier (16.5), or says a knowledge base's answer, stays fixed.

## 16.3 Generating from what was collected (the secretary pattern)

A line can be generated from content the call holds: the line's variables named in `from` hold content the model may summarize rather than repeat. The message fixture (`packages/dialogwright/src/testing/message/`) reads back a message this way:

```yaml
# prompts.yaml, under prompts:
  confirm_take_message:
    text: "For {recipient}, from {caller}, call back on {phone}. Your message: {message}. Shall I pass it on?"
    interruptible: true
    mode: generative
    goal: Read back who the message is for, who it is from and the number to call, then a short summary of the message in your own words, and ask whether to pass it on.
    from: [message]
    when:
      situations: [first-ask]
```

- `{recipient}`, `{caller}` and `{phone}` are data items: the generated line must say each word for word. `{message}` is content: the model may summarize it, and its words count as allowed source for the checks (16.6).
- The exact content is always kept. The slot holds the message as the caller said it, the summary's yes arms exactly what the slots hold, and the tool is sent the message word for word, whatever a line said of it.
- Reading it back word for word is always there. A caller who asks to hear it again ("can you read that back word for word", the `repeat_prompt` intent) hears the fixed line, which reads the message whole: a repeat always says a line's fixed text. With `when: { situations: [first-ask] }`, every later reading of the summary (after a no, after a change) is the fixed line too. The fixture's `ask_change` line offers it: "Tell me what to change, or say read it back to hear your message word for word."

## 16.4 style.yaml

How a generated line sounds, optional, beside the other files:

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/style.schema.json
persona: a warm, brief office receptionist
words:
  voice: 40
  chat: 50
avoid:
  - unfortunately
  - I apologize for the inconvenience
```

`persona` is told to the model (default: a calm, plain-spoken agent). `words` is the most words a generated line may use on each channel (default 25 on a call, 40 in a chat): a longer one is not said. `avoid` lists phrases the model is told to avoid, and a line that uses one anyway is not said. It is read only by an app that generates a line.

## 16.5 What a model is sent

A speech act, never the conversation: what the line is for in its decision (an acknowledgement, the question, the line a call ends on, the handoff line), the goal, the fixed line as it would be said, whether it asks a question, the data items it must carry (display values), the collected content it may summarize (`from`), the caller's words on this turn quoted as data, how frustrated the caller has been (none, some, high), the situations, the channel, the call's language and the style. Never the transcript, never a tool's result, never the prompt id.

Never an identifier either: a line that names an identity factor (an account number, a date of birth) or a slot hidden whole in the records (a slot's `redact: mask` or `length`) is not generated; `pnpm check` refuses `mode: generative` on one, and a form's switch leaves it fixed. A slot recorded by its last four (a callback number) is a data item a line may carry, as its fixed text does. The caller's words are not quoted after a question whose words are sensitive (the code, an identity factor, a slot with a `redact` setting).

A turn whose words the injection screen flagged, or did not read (it failed), generates nothing: every line of it is said fixed, and nothing of it is sent to the model.

## 16.6 The checks, and the fallback

Every generated line is checked before anyone hears it. The first that fails is recorded, and the fixed line is said:

| Reason | What failed |
|---|---|
| `empty` | the model said nothing |
| `format` | markup, a link, braces, a line break, or more than 600 characters |
| `words` | more words than the channel's budget (style.yaml) |
| `question` | a line whose fixed text asks must end in exactly one question; one that does not ask must ask none |
| `avoid` | a phrase style.yaml lists |
| `items` | a data item left out (each word for word, letter case aside) |
| `foreign` | a number, an amount, a date word or a name that is in none of what the line was given (the fixed line, the goal, the items, the content, the caller's words) |
| `drift` | the decision model, asked one yes-or-no question about the line alone (`renderDrift`: does it do anything beyond its goal?), said yes |
| `timeout` | the line, checks included, was not ready within the turn's budget |
| `error` | the model's request failed |
| `cassette-miss` | a replay had no recording of the line |
| `drift-error` | the drift check could not be asked |

Each fallback is a `render_fallback` row in the audit (the prompt and the reason) and is in the trace. The checks bound a line's shape against what it was given; they do not trust the model. The drift check is the one that reads meaning, and it is the decision model's, not the renderer's.

## 16.7 Running it

| Setting | What it is | Default |
|---|---|---|
| `RENDER_PROVIDER` | `openrouter` (any model OpenRouter serves) or `anthropic` | unset: no line is generated, every line is said fixed, and the server says so at start |
| `RENDER_MODEL` | the model id | a current Claude Haiku: `claude-haiku-5-5` on Anthropic, `anthropic/claude-haiku-5.5` on OpenRouter |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | the provider's key, from its own variable, never a flag; never logged, never in a trace | none |
| `RENDER_SHARE` | the share of calls (0 to 100) served generated; the rest are served fixed | `100` |
| `RENDER_TIMEOUT_MS` | how long a turn waits for its generated lines, checks included; one value sets both channels | `700` on a call, `1500` in a chat |
| `RENDER_PRICE_INPUT_PER_MTOK`, `RENDER_PRICE_OUTPUT_PER_MTOK` | the model's price in dollars a million tokens, for the cost | the default model's: 0.10 and 0.50 |

The Anthropic adapter calls the Messages API with thinking off (a line, at most 200 tokens); a model that cannot turn thinking off is not one for a 700 ms line. OpenRouter is called through its chat completions endpoint. Both are plain `fetch`, the key only in a header. One model call per generated line, started once the core has decided; a turn's lines are worded at once, under one budget, and a late wording is dropped. On a host of several apps, each app reads its own settings. `pnpm diagnose` says which model words an app's lines (with its key's variable, never the key), the share and the budget, or that every line is said fixed, without asking the model anything.

## 16.8 Measuring it

The point is to find out whether it helps, so it is measured:

- **The call's group.** `RENDER_SHARE` chooses each call's group, generated or fixed, from its id (the same call is always in the same group), recorded on its first trace record and as a `render_group` audit row.
- **The trace.** Each turn that says a line the app generates has a `render` record: each such line's mode, its fixed text, the wording said or why it fell back (and the wording a check refused, for whoever reads the trace), how long it took and what it cost. The actions hold the words as said; the decision, the session's last line and what the decision model is told was asked are the fixed lines, so the decision model's requests (and their cassettes) are the same whatever was worded.
- **The console's call detail** shows under each agent line each line the app generates: generated, with the fixed line it stands for beside it, or fixed and why.
- **Insights** compares the calls served generated with those served fixed (containment, re-asks a call, the share with a frustrated caller, call length, and the models' cost a call), lists each generated line's fallback rate and latency, and counts what the lines cost, in the cost with the decision model's.
- **The policy card** (`POLICY.md`) lists every line a model words, with its fixed text, its goal, where it is generated, the data it carries word for word and what it may summarize, and every prescribed line.

## 16.9 Testing it

No test and no CI run calls a model. The stub regression words an app's generated lines with the fake renderer (`FakeRenderClient`, from `'dialogwright/testing'`): a short acknowledgement before the fixed line where the moment calls for one, and for a line from collected content, each content value cut to its first few words. It runs every check on every line, the drift check asked of the stub, and prints a line with how many were tried, said generated and fell back, and why. `--render fixed` says every line fixed.

`--client recorded` replays the render cassette (`fixtures/recorded/render/<model>.jsonl`, keyed by the act and its line) and runs every check again on every recorded line; a line with no recording falls back as `cassette-miss`. `--client record` records real generations with the author's key: the maintainer's step, never a test's.

The adversarial suite (chapter 15) adds a `wording` family for an app that generates lines: an injection where a generated question answers it, the screen catching it (nothing is put to the renderer) or fooled along with the renderer, which echoes the words into its line (never said); and renderers that write instructions, or an amount and a number, before every line (never said, and each call ends as with a well-behaved renderer).

## 16.10 Languages

A line is generated in the call's language. In another locale it is generated only where that locale's prompts.yaml gives the line its own `goal`; without one, the locale's fixed line is said. `mode`, `prescribed`, `when` and `from` are read from prompts.yaml, for every locale.

## 16.11 Cost and latency

Each generated line is one call to a small model, and one decision-model question for its drift check. Both are counted: the line's tokens and cost in the trace's `render`, the drift check's in the record's own usage, and both in Insights' cost. Latency is the line's wording and checks, within the turn's budget; Insights shows it per line.

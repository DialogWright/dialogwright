# Phase 9, generated wording (opt-in): design, for review

Date: 2026-10-13. Status: **decided (the maintainer, 2026-10-13); built (see As built at the end).** The decisions at the end replace the proposals above where they differ. Source: [design.md section 5](../design.md#5-generated-wording) and the roadmap's Phase 9 ("the model chooses the words, never the content, and the difference is measured"). The maintainer, 2026-10-02: keep generated wording as an option to try and measure, per prompt or per state, with the prompt and the data items it must carry, and the fixed line as its fallback; not a headline feature.

## At a glance

Every line an app says is fixed today. Phase 9 lets an author mark a prompt `mode: generative`: a fast model rephrases it for the moment (acknowledging what the caller just said, matching their tone), under checks that hold it to the line's meaning and data, with the fixed line said whenever a check fails or the model is slow. Nothing decides differently: the core has decided before the renderer runs. And because the point is to find out whether it helps, the console measures it: a share of calls can be served fixed and a share generated, and Insights compares them.

## What an author writes

```text
# prompts.yaml
ask_outageStart:
  mode: generative
  text: "When did the power go out?"            # the fixed line: the meaning and the fallback
  goal: "Ask when the outage started; briefly acknowledge what they just said."
balance_answer:
  text: "Your balance is {amount}, due {dueDate}."   # fixed, as every line is today

# style.yaml (new, optional)
persona: "a calm, plain-spoken service agent"
words: { voice: 25, chat: 40 }                   # the most a generated line may use
avoid: ["unfortunately", "I apologize for the inconvenience"]
```

## Decisions proposed

1. **Opt-in per prompt**, `mode: generative` with a `goal`; the `text` stays required, is the fallback, and is what every test and the stub regression say. An app with no generative prompt is byte for byte as today.
2. **What may never be generated** (refused by `pnpm check`): a line the policy names (`say:` of an action and the handoff lines), identity and one-time-code lines, a knowledge-base answer (said word for word, always), a read-back of a value (`confirm_<slot>`), a line holding an amount, a date or an identifier the gate decided on unless the app marks it allowed, and any line in an app whose policy marks prompts `regulated: true`. This keeps CLAUDE.md's rule: a model never writes a regulated line.
3. **The model gets a speech act, not the conversation**: the act (ask, acknowledge, re-ask and why, offer a person), the goal, the fixed line, the data items it must carry (display values only), the caller's last words quoted as data, their frustration level, the channel, the call's language and `style.yaml`. Never identifiers, never the transcript, never tool results.
4. **Checks before anyone hears it** (each failure falls back to the fixed line and the audit records `render_fallback` with the reason): every required item present; no other number, date, amount or name except the items or the caller's own words; within the word budget, and an ask ends in exactly one question; a yes/no check by the decision model, "does this do anything beyond the goal?"; never on a turn the injection screen flagged.
5. **Latency**: one model call per generated line, started as soon as the core has decided, with a per-turn budget (`RENDER_TIMEOUT_MS`, default 700 on voice, 1500 on chat); past it the fixed line is said and the late text is dropped. Measured and shown per prompt.
6. **The model**: any provider through one small adapter, chosen like the decision model (`RENDER_PROVIDER`, `RENDER_MODEL`, the author's own key); the default a small, fast model (a current Claude Haiku). Never called in CI or a test: cassettes record generations keyed by act and context, and the regression re-runs every check on every recorded line and reports the fallback rate.
7. **Measured, not assumed**: `RENDER_SHARE` (default 100 when any prompt is generative, settable to e.g. 50) serves that share of calls generated and the rest fixed, by call; Insights compares the two groups: containment, re-asks, frustration, call length, cost, and the fallback rate and latency per prompt. The console's call detail shows each line's mode and, for a generated one, the fixed line beside it.
8. **Languages**: generated in the call's language; a locale without the prompt's `goal` says the fixed line.

## Questions for the maintainer

1. Is the never-generated list (decision 2) right, or should some of it be the app's choice (for example a read-back)?
2. The default model: a current Claude Haiku through the Anthropic API with the author's key, or provider-neutral from the start (OpenRouter and compatible endpoints, as the decision model already is)?
3. Should the measuring split (`RENDER_SHARE`) be in the first build, or later once there is something to compare?
4. Per prompt only, or also per state (a form's prompts generated only in some states, such as after a re-ask)?

## Decisions (the maintainer, 2026-10-13)

1. **Which lines may be generated is the app's choice, never the framework's.** The default is prescribed text; a line is generated only where the app explicitly asks for it, and an app may choose a mostly or entirely generated experience. What is regulated is the app designer's call, not the framework's: a prompt the designer marks prescriptive (`prescribed: true`) is never generated, whatever a form or state setting says, and `pnpm check` refuses `mode: generative` on it. The framework's list in proposal 2 becomes guidance in the skill, not a refusal. The policy card lists every generated line, so a reviewer sees exactly which lines a model words. CLAUDE.md's rule changes to say this.
2. **Generating from what was collected.** Beside rephrasing a prompt, an app may have a line generated from content the call holds: the maintainer's example is a secretary app that takes a message and reads back a summary of it, as a real secretary would, and, if the caller pushes back, offers to read the exact stored note word for word; another is summarizing a long transaction. The input is named by the app (slots, a stored note), the exact content is always kept, and reading it back word for word is always available as the fallback.
3. **Providers: OpenRouter and Anthropic from the start**, with the author's own keys (`RENDER_PROVIDER=openrouter|anthropic`, `RENDER_MODEL`, the key from its own variable, never a flag). OpenRouter gives access to every model, which also lets the maintainer compare decision models there.
4. **`RENDER_SHARE` is available; unset, generative prompts are generated for every call (100).**
5. **How finely an app chooses** (all three, app's choice): per prompt (`mode: generative`); per prompt and situation (`when:` first ask, re-ask, after a correction, a frustrated caller, a channel); and per form (a form's switch makes its prompts generative unless a prompt says otherwise or is prescribed).

## As built

Built on the branch `phase9-render`, from the decisions above. Where the proposals and the decisions left a point open, or a point could not be built as written, this is what was chosen; each is the maintainer's to confirm.

1. **Where it runs.** The generative renderer runs in `runTurn`, after the core has resolved the turn and before the audit is chained: it replaces the words of the lines the app generates in the turn's actions and adds its audit rows; the decision, the session and its fixed lines stand. The session keeps the fixed line as the line last said (`lastPromptText`): the decision model is told the fixed line was asked, so its requests (and their cassettes) are the same whatever was worded, and a repeat (`repeat_prompt`) says the fixed line. That is also what makes "read it back word for word" always available for a line generated from collected content.
2. **Situations.** `first-ask`: the line has not been said before on this call, read from the session's history of the lines it said (a decision's own line; an acknowledgement is always taken as a first ask); `re-ask`: it has. `after-correction`: on this turn a value the caller had given changed, or the caller said no to a read-back. `frustrated`: the caller has been frustrated on this call. `when` takes `situations` and `channels`, both of which must hold.
3. **A form's lines**, for its switch, are fixed from the files, so the policy card can list them: each of its slots' questions (`ask_<slot>` and `ask_<slot>_<anything>`), their read-backs (`confirm_<slot>` and its variants), and its summary. A line its switch generates with no goal of its own is worded "to say what the fixed line says, in words that fit this moment".
4. **Never sent to a model**, whatever the app marks: an identifier, as an identity factor slot or a slot hidden whole in the records (`redact: mask` or `length`); a slot recorded by its last four (a callback number) is a data item a line may carry, as its fixed line does, since reading back the number is what such a line is for (the proposal said "never identifiers"; this draws the line at what proves who the caller is and what the records hide whole). A knowledge base's answer (a line that names `{answer}`) is never generated, as the decision on knowledge base answers keeps them. The caller's words are not quoted after a sensitive question (the code, an identity factor, any slot with a `redact`). `pnpm check` refuses `mode: generative` on such a line; a form's switch leaves it fixed; the renderer skips it.
5. **The screen.** A turn with words is generated only once the injection screen has read them and not flagged them: a turn it flagged, or could not read (it failed open), says every line fixed and sends nothing.
6. **The checks** are the design's, with two added: `format` (markup, a link, braces, a line break, more than 600 characters) and `avoid` (a phrase style.yaml lists, which the proposal sent to the model only). "Ends in exactly one question" is held against the fixed text: a line whose fixed text asks must end in exactly one question; one that does not ask must ask none. The drift check is one yes-or-no question (`renderDrift`) on a request of its own to the run's decision model client, whose state is the line, its goal and its fixed text alone; it fires at 0.5 (a constant, `DRIFT_FIRE`, not yet a threshold an app sets). Its usage is the decision model's, in the record's own usage. The stub answers it from the words the line adds to its fixed text and goal.
7. **The budget** is one per turn and covers the wording and the checks of every line of the turn, worded at once. `RENDER_TIMEOUT_MS` sets both channels' budget when it is given; unset, 700 ms on a call and 1500 in a chat.
8. **The share.** `RENDER_SHARE` chooses a call's group from a hash of its session id, so nothing is added to the saved session (no `SESSION_SCHEMA` change) and a call resumed after a restart stays in its group (unless the share itself was changed in between). The group is on the call's first trace record and in a `render_group` audit row after `call_started`, and on every record that says a generated line.
9. **The providers.** `RENDER_PROVIDER` unset means no line is generated (no default provider: nothing costs money unless asked for); the server says so at start and `pnpm diagnose` warns. The key is the provider's own variable (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`), with no `RENDER_API_KEY` of its own. The Anthropic adapter sends `thinking: { type: "disabled" }` with 200 tokens at most; the default models are `claude-haiku-5-5` (Anthropic) and `anthropic/claude-haiku-5.5` (OpenRouter's id for it, not yet confirmed against OpenRouter's list: set `RENDER_MODEL` if it differs). The price for the cost is `RENDER_PRICE_INPUT_PER_MTOK` and `RENDER_PRICE_OUTPUT_PER_MTOK`, defaulting to Claude Haiku 5.5's.
10. **Generating from what was collected** is built generally, with no new intent or offer of its own: `from` names the content variables (summarized, and allowed as a source of the checks' numbers and names), the fixed line reads the content word for word, `when: { situations: [first-ask] }` makes every later reading the fixed line, and a repeat says the fixed line. The fixture's own `ask_change` line offers the word-for-word reading. On a call, a second bare no at a summary goes on to the keypad confirmation, as it always has, so the re-read after a no is shown on a chat; the repeat ("can you read that back word for word") works on both.
11. **Prescribed lines** give an app an `App.generated` (and its policy card a section) even when it generates nothing, so a reviewer sees which lines are fixed by the designer.
12. **Regression.** The stub regression words lines with the fake renderer (deterministic, no model) for an app that generates lines (the proposal had the stub say the fixed text; the fake exercises every check instead, and `--render fixed` says every line fixed). `--client recorded` replays the render cassette (`fixtures/recorded/render/<model>.jsonl`, the model RENDER_PROVIDER and RENDER_MODEL name, else Anthropic's default) and re-runs every check; a miss falls back as `cassette-miss` and is counted, not failed. A run prints the lines tried, said generated and fallen back, with the reasons. The baseline's outcomes do not depend on the wording.
13. **The adversarial suite** has a family of its own, `wording`, only for an app that generates lines, with two properties, `not-generated` and `render-held`; every other case runs with the regression's renderer.
14. **Insights** keeps its figures' version (3): the generated-wording figures are an optional part of an hour's figures, absent in every file written before and for every app that generates nothing.
15. **Not built.** Generated knowledge-base answers for `risk: low` topics (the roadmap's Phase 6 leftover) stay out: a knowledge base's answers stay word for word. Recording generations with a real model (`regress --client record`, with the maintainer's keys) is the maintainer's step; no test, CI run or script calls a model.


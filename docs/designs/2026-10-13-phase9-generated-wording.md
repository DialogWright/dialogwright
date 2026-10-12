# Phase 9, generated wording (opt-in): design, for review

Date: 2026-10-13. Status: **proposal for the maintainer to review; nothing here is built.** Source: [design.md section 5](../design.md#5-generated-wording) and the roadmap's Phase 9 ("the model chooses the words, never the content, and the difference is measured"). The maintainer, 2026-10-02: keep generated wording as an option to try and measure, per prompt or per state, with the prompt and the data items it must carry, and the fixed line as its fallback; not a headline feature.

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

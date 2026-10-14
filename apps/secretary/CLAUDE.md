# Example Front Desk: notes for AI coding assistants

Example Front Desk is a DialogWright example app: a fictional design studio's phone line that takes a message for one of three people (or anyone), with a name and a callback number, and reads it back as a **framed line**: the line fixed, and only a short summary of the caller's message generated inside it. It is the example of generated wording; the clinic is the example of the folder. Read the repository's root `CLAUDE.md` first for the rules, then this folder's `README.md` and `DESIGN.md` (the worksheet: the paragraph, every choice and the gaps), and the authoring guide's [section 16](../../docs/guide/16-generated-wording.md) before changing the read-back.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`, `style.yaml`: what the app says, hears and collects, and how the one generated span sounds. Slots are library types named in `slots.yaml`.
- `prompts.yaml`'s `confirm_take_message` is the only line with anything generated (`generate: { summary: { from: message, ... } }`). Every other line is said word for word; the handoff lines and `message_taken` are `prescribed: true`.
- `policy.yaml`: the one action, `leaveMessage` (level 0, `confirmed` on recipient, caller, phone and message), and how each param is recorded.
- `policy.matrix`, `POLICY.md` and `APP-MAP.md`: the policy read back, generated; `src/app.test.ts` fails when one differs from what the app generates.
- `src/app.ts`: the tool (a stub inbox, idempotent, with a reply `check`) and the hooks (`take_message`: deliver and end; `urgent`: hand off to the main line). `src/data.ts`: each person's inbox, at example.com.
- `fixtures/`: `corpus.jsonl`, `scenarios/` (`messages.json`, `handoffs.json`, `answers.json`) and `expected/` (the stub baseline, made once and reviewed).

## Commands

Run these at the repository root.

```sh
pnpm check
pnpm --filter @dialogwright/example-secretary typecheck
pnpm --filter @dialogwright/example-secretary test
pnpm --filter @dialogwright/example-secretary regress                      # "no changes", then the summary, the adversarial suite and the generated lines
pnpm --filter @dialogwright/example-secretary regress --scenario <id>      # one scripted call, turn by turn (--corpus <id>, --adversarial <id>)
pnpm policy:matrix apps/secretary && pnpm policy:card apps/secretary && pnpm app:diagram apps/secretary   # after a policy, form, tool or span change; read each diff
```

## Rules for this app

- Keep the generated part to the span. Do not mark another line `mode: generative` or the form `wording: generative`: the paragraph says every other line is said word for word. Changing the span's goal, its word budget or the frame changes what the policy card says and what a model is sent: write the card again, and a recording is needed again.
- The frame must read true whether the span is a summary or the caller's exact words ("called and said:", never "in short" or "summarized"): the exact words are what a no, a repeat, a later reading and every fallback say.
- The message slot keeps the caller's words (`say: null`, `redact: none`); the tool is sent them word for word. Never deliver the summary.
- Never put policy in tool code; never record (`regress --client record` is the owner's step, with the owner's keys); never put a key in a file; never regenerate the baseline, a snapshot or a page of the read back to make something pass. A `FAIL adversarial` case is a finding to fix in the app.
- Fictional data only: invented names, the 555 range, example.com.
- `policy.yaml` belongs to compliance. Change it only when asked to, with the reason in the commit message, and expect review.

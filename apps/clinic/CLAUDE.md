# Example Family Practice (the clinic): notes for AI coding assistants

The clinic is the example app to learn from: the appointment line of a small, fictional clinic. A caller schedules, reschedules, cancels or confirms an appointment with one of eight providers, or is put through to billing with their member ID. It verifies no one (there is no `identity.yaml`, every action is at level 0). Read the repository's root `CLAUDE.md` first for the rules, and `README.md` here for how the app is built. Every name, date and number in it is made up.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the line says, hears and collects. All five slots are library types configured in `slots.yaml`; the provider roster is the `provider` slot's options.
- `policy.yaml`: what the agent may do, action by action: the level and the rules the gate runs before each. Every tool has an action, and the three writes carry a `confirmed` rule over who, with whom and when.
- `src/app.ts`: `defineApp` joins the folder with the code. The code is in `src/domain/` (the tools and the directory behind them, the form hooks, the scheduling, the facts, the testing hooks) and `src/testing/oracles/` (the hand-written slots the library slots are compared against).
- `fixtures/`: `corpus.jsonl` (labelled utterances), `scenarios/core.json` (scripted calls), `expected/` (the stub baseline) and `recorded/` (the cassette of the real decision model's answers).

## Commands

Run these at the repository root.

```sh
pnpm check                                                          # every app folder, this one included
pnpm --filter @dialogwright/example-clinic typecheck
pnpm --filter @dialogwright/example-clinic test
pnpm --filter @dialogwright/example-clinic regress                  # the stub regression: expects "no changes"
pnpm --filter @dialogwright/example-clinic regress --client recorded   # the replay of the recorded cassette
pnpm --filter @dialogwright/example-clinic cli --client heuristic --today 2026-09-18   # a text console, no keys
```

## Before committing

Run `pnpm check`, the clinic's typecheck and tests, `regress` (expects `no changes`) and `regress --client recorded` (expects exit 0, no cassette misses, and the six known gaps), then the root checks (`pnpm verify` and the testkit's regression). A change to the words in the YAML (a criterion, a label, a line, a question a slot sends) re-keys the cassette, so the replay then reports cassette misses until the cassette is recorded again; that is a finding to raise, not something to paper over.

- Never regenerate the baseline (`regress --update`) or a snapshot to make something pass: a changed output is a finding to explain.
- Never run `regress --client record`: recording calls a paid API and is a deliberate step for the owner of the app.

## Compliance owns `policy.yaml`

`policy.yaml` is the clinic's action policy: the level and the rules of every action. Change it only when asked to, with the reason in the commit message, and expect review. There is no `identity.yaml`: the clinic verifies no one, and a higher level than 0 needs one (`defineApp` refuses it without).

## Rules for this app

- Never put policy in tool code. Tools do the work; the gate decides, from `policy.yaml`, whether they may run.
- Never let a model write a regulated line. Every line a caller hears is in `prompts.yaml`, word for word.
- An app imports only from `'dialogwright'`; a test checks it.
- The clinic is the app new ones are modeled on. Start a new app with `pnpm create-app`, not by copying this folder.

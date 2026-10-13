# Example Family Practice (the clinic): notes for AI coding assistants

The clinic is the example app to learn from: the appointment line of a small, fictional clinic. A caller schedules, reschedules, cancels or confirms an appointment with one of eight providers, is put through to billing, or asks a general question about the practice, answered from a small knowledge base. It verifies no one (there is no `identity.yaml`, every action is at level 0). Read the repository's root `CLAUDE.md` first for the rules, and `README.md` here for how the app is built. Every name, date and number in it is made up.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the line says, hears and collects. All six slots are library types configured in `slots.yaml`; the provider roster is the `provider` slot's options, and `subject` is the `topic` slot a general question is asked through.
- `kb/`: the knowledge base ([guide 12](../../docs/guide/12-the-knowledge-base.md)): `kb.yaml` (the resolving action `answerQuestion`, retrieval by keywords alone), `topics.yaml` (five topics), `sources/visitor-information.yaml` (read by `pnpm kb:ingest` from `docs-src/visitor-information.md`, the fictional visitor page), `passages/` (approved by a person), `pending/` (drafts, never said) and `approvals.jsonl` (appended to by `kb:approve` only). README.md, "The knowledge base", says how it was built and how to review it.
- `policy.yaml`: what the agent may do, action by action: the level and the rules the gate runs before each. Every tool has an action, and the three writes carry a `confirmed` rule over who, with whom and when.
- `src/app.ts`: `defineApp` joins the folder with the code. The code is in `src/domain/` (the tools and the directory behind them, the form hooks, the scheduling, the facts, the testing hooks) and `src/testing/oracles/` (the hand-written slots the library slots are compared against).
- `fixtures/`: `corpus.jsonl` (labelled utterances), `scenarios/core.json` (scripted calls), `expected/` (the stub baseline), `recorded/` (the cassette of the real decision model's answers) and `kb/paraphrases.yaml` (callers' own words for each knowledge topic, which `src/kb.test.ts` holds retrieval's recall to).

## Commands

Run these at the repository root.

```sh
pnpm check                                                          # every app folder, this one included
pnpm --filter @dialogwright/example-clinic typecheck
pnpm --filter @dialogwright/example-clinic test
pnpm --filter @dialogwright/example-clinic regress                  # the stub regression: expects "no changes"
pnpm --filter @dialogwright/example-clinic regress --adversarial <id>  # one case of the adversarial suite, turn by turn
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
- Every line a caller hears is in `prompts.yaml`, said word for word: this app generates none. A line is generated only where an app asks for it (`mode: generative`, a form's `wording: generative`), and never one marked `prescribed: true` ([guide 16](../../docs/guide/16-generated-wording.md)).
- The regression runs the adversarial suite (app.yaml's `testing: { adversarial: on }`): a `FAIL adversarial` case is a finding to fix in the app (a tool's `check` of its reply, the policy, a hook) or the engine, never by changing the case or turning the suite off. Every tool whose reply a line says checks it (`check`). Until the next recording, the recorded replay lists the suite's cases as not yet recorded.
- An app imports only from `'dialogwright'`; a test checks it.
- A knowledge answer is an approved passage, said word for word: never write or reword one to make a check pass. Only a person approves (`pnpm kb:approve` at their terminal, or `pnpm kb:review`): never run either, never write an `approval` or a hash, never edit `kb/approvals.jsonl`. A draft goes to `kb/pending` (in `kb:draft`'s format, its excerpt word for word from its section) and is never said; `kb:draft` itself calls a model with the author's key and is not run here. A topic with no approved passage in force makes `pnpm check` fail and the caller hears `kb_unavailable`.
- Retrieval is by keywords alone, so the regression runs the same with no model downloaded. After changing a topic's title, keywords or asks, run `pnpm kb:bakeoff apps/clinic --paraphrases apps/clinic/fixtures/kb/paraphrases.yaml` and keep the paraphrases out of the topics' own words (`src/kb.test.ts` checks both). A topic's title is spoken and covered by its passages' approval: renaming one withholds them until a person approves them again.
- The clinic is the app new ones are modeled on. Start a new app with `pnpm create-app`, not by copying this folder.

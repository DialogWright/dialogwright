# {{display}}

A DialogWright app, scaffolded by `pnpm create-app`. It starts as a one-form example: a caller books a service (a repair, an inspection or an installation), hears it read back, and says yes. {{#identity}}Before the booking the caller verifies with an account number and a date of birth. {{/identity}}Replace the example with your own intents, forms, slots and tools; `pnpm check` says what is left to do after each change. Every name, date and number in it is made up.

## The folder

```
app.yaml        who the app is and how it presents itself
intents.yaml    what a caller can ask for, and the keypad menu
forms.yaml      each form's slots, its summary prompt and the hooks it has
prompts.yaml    every line a caller can hear
policy.yaml     what the agent may do, action by action: the level and the rules the gate runs before each
{{#identity}}
identity.yaml   how a caller proves who they are: the factors, the verify tool, how many tries
{{/identity}}
slots.yaml      every slot, in the order the engine works through them
policy.matrix   what the gate decides, for every action and every kind of caller (generated)
POLICY.md       the policy card: the policy in plain English, with its diagrams (generated)
APP-MAP.md      the app map: intents, forms, slots, actions and rules as diagrams (generated)
src/app.ts      the code: the tools and the form hooks, joined to the folder by defineApp
src/data.ts     the fixture data behind the stub tool
fixtures/       the corpus, the scripted calls and the stub baseline
```

What is data is YAML, and what runs is TypeScript. Policy is never in a tool: the gate decides, from `policy.yaml`, whether a tool may run. The guide to every file is [docs/authoring-an-app.md]({{root}}/docs/authoring-an-app.md), and the slot types are in [docs/slots]({{root}}/docs/slots/README.md).

## Commands

Run these at the repository root.

```sh
pnpm check                                          # every app folder: YAML, schemas, cross-links to the code, prompts, corpus
pnpm --filter @dialogwright/example-{{name}} typecheck
pnpm --filter @dialogwright/example-{{name}} test
pnpm --filter @dialogwright/example-{{name}} regress   # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-{{name}} regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
pnpm --filter @dialogwright/example-{{name}} cli --client heuristic   # a text console, with no keys
```

The three generated pages are the policy read back: compliance reads them, and `src/app.test.ts` fails when one is not what the app generates. They ship matching the example. After a change to the policy, the forms or the tools, write them again with `pnpm policy:matrix apps/{{name}}`, `pnpm policy:card apps/{{name}}` and `pnpm app:diagram apps/{{name}}`, read each diff as a change in what the agent may do, and commit them with the change.

Nothing here needs an API key. The engine's stub clients stand in for the decision model, answering from the labels in `fixtures/corpus.jsonl`.

## The fixtures and the baseline

- `fixtures/corpus.jsonl`: one labelled utterance per line. Every intent needs examples (`pnpm check` says which are missing), including terse ones, and each line says what the stub model should answer for it.
  The side-speech line (`ns-02`) carries `"answers":{"addressedToSystem":{"noul":0.15}}`: it sets the stub's answer to one of the engine's own yes-or-no questions, whether the words were meant for the agent, and `noul` is the probability of yes (the engine's name for a yes-or-no answer, not a typo). At 0.15 the turn is ignored as speech to someone else. The field is described in the create-app skill's `corpus.md`.
- `fixtures/scenarios/core.json`: scripted calls, each with the outcome it expects. Every spoken step of a scripted call must also be in the corpus, so the stub can answer it: the regression refuses to run one that is not, and names it.
- `fixtures/expected/`: the baseline, the stub's outcome for every corpus line and scripted call. The regression run compares against it and prints `no changes`.

The baseline that came with this folder is the example's. When your own app is built, make its first baseline once, with `regress --update`, and read the whole diff against what you expect. From then on, never regenerate it: a changed output is a finding to explain, not noise to overwrite.

## Recording against the real model

The stub answers from the corpus labels. A cassette holds the real decision model's answers, recorded once and replayed offline, so a run shows how a real model does on this app's calls. Recording calls the paid perception API, so it is a deliberate local step and never part of CI.

1. Copy `.env.example` to `.env` in this folder (it is git-ignored) and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or a key from OpenRouter or the Vercel AI Gateway, or a compatible endpoint's, with `JEV_PROVIDER`: `.env.example` lists them). The launchers do not read `.env` themselves, so load it into your shell: `set -a && source .env && set +a`.
2. At the repository root: `pnpm --filter @dialogwright/example-{{name}} regress --client record --threshold JEV_TIMEOUT_MS=15000`. It appends each answer to `fixtures/recorded/<model>.jsonl` and aborts after three consecutive client errors. The diff against the stub baseline shows where the real model reads a line differently from its label; that is expected, and it never rewrites the baseline.
3. Check the replay offline, with the key unset: `pnpm --filter @dialogwright/example-{{name}} regress --client recorded`. A line the model reads differently from its label stays the truth in the corpus and gets a `knownGap` with its reason (see "Known gaps" in the [clinic's README]({{root}}/apps/clinic/README.md)).
4. Commit the cassette. It holds only the corpus text and the model's answers to it.

A change to the words in the YAML (criteria, labels, prompts, the questions a slot sends) changes what the model is sent, so the replay reports each changed request as a cassette miss until the cassette is recorded again.

## Running it

`pnpm --filter @dialogwright/example-{{name}} serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise.

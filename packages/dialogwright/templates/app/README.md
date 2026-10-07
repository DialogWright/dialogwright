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
  The `done` lines (`dn-01` to `dn-05`) are said at "anything else?" (context `anything_else`, seeded by `testing.seed.anythingElse` in `src/app.ts`): that is where a caller says they are finished, and `done` ends the call with the goodbye. Keep `done` and its lines when you replace the example: `pnpm check` refuses an app that asks "anything else?" without it.
- `fixtures/scenarios/core.json`: scripted calls, each with the outcome it expects. Every spoken step of a scripted call must also be in the corpus, so the stub can answer it: the regression refuses to run one that is not, and names it.
- `fixtures/expected/`: the baseline, the stub's outcome for every corpus line and scripted call. The regression run compares against it and prints `no changes`.

The baseline that came with this folder is the example's. When your own app is built, make its first baseline once, with `regress --update`, and read the whole diff against what you expect. From then on, never regenerate it: a changed output is a finding to explain, not noise to overwrite.

## Recording against the real model

The stub answers from the corpus labels. A cassette holds the real decision model's answers, recorded once and replayed offline, so a run shows how a real model does on this app's calls. Recording calls the paid perception API (a few cents for an app this size), so it is a deliberate local step for the app's owner, and never part of CI.

1. Put the key in this folder's `.env` (it is git-ignored). At the repository root, `pnpm configure --app {{name}}` asks for it and writes the file; or copy `.env.example` to `.env` here and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or a key from OpenRouter or the Vercel AI Gateway, or a compatible endpoint's, with `JEV_PROVIDER`: `.env.example` lists them). `regress` reads this folder's `.env` itself: there is nothing to load into the shell.
2. Record, at the repository root, with this one command:

   ```sh
   pnpm --filter @dialogwright/example-{{name}} regress --client record --threshold JEV_TIMEOUT_MS=15000
   ```

   It appends each answer to `fixtures/recorded/<model>.jsonl` and aborts after three consecutive client errors. The diff against the stub baseline shows where the real model reads a line differently from its label; that is expected, and it never rewrites the baseline.
3. Replay it offline, as often as you like: `pnpm --filter @dialogwright/example-{{name}} regress --client recorded`. It calls nothing and costs nothing. Its last line counts what is left to decide: `to triage: N untagged corpus differences, M failing scripted calls, K passing scripted calls that differ from the baseline, J cassette misses`. A line the model reads differently from its label stays the truth in the corpus and gets a `knownGap` with its reason (see "Known gaps" in the [clinic's README]({{root}}/apps/clinic/README.md)); the create-app skill's [triage page]({{root}}/.claude/skills/create-app/triage.md) has the whole procedure.
4. After a second recording, trim the cassette: `pnpm --filter @dialogwright/example-{{name}} cassette:trim`. Recording appends, so the first recording's answers stay in the file though no replay reads them; the trim replays the whole run from the cassette and keeps only the answers it uses, and writes nothing if a request misses.
5. Commit the cassette. It holds only the corpus text and the model's answers to it.

A change to the words in the YAML (criteria, labels, prompts, the questions a slot sends) changes what the model is sent, so the replay reports each changed request as a cassette miss until the cassette is recorded again. A change to code, to the policy, or to a scripted call's silences and keys sends nothing new: check it on the recording you have before asking for another.

## Running it

`pnpm --filter @dialogwright/example-{{name}} serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise. It reads a settings file when `ENV_FILE=<path>` names one, such as this folder's `.env`; a variable already in the environment wins over the file. At the repository root, `pnpm configure --app {{name}}` asks and writes this folder's `.env` (mode 600), and `pnpm start --app {{name}}` runs the server with it, through a quick tunnel when `PUBLIC_HOST` is unset.

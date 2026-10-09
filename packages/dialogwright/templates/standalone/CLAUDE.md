# {{display}}: notes for AI coding assistants

{{display}} is a DialogWright app in a project of its own: a voice and chat agent whose dialog and policy are YAML and whose tools and form hooks are TypeScript, on the `dialogwright` package installed in `node_modules`. It starts as a one-form example (book a service); the example is what you replace.

Read before changing anything:

- The authoring guide, [node_modules/dialogwright/docs/guide/](node_modules/dialogwright/docs/guide/README.md): the folder, each file with an example, policy and identity, what stays in TypeScript, the check's messages, locales, the knowledge base, the channels and running it. The slot types are in [node_modules/dialogwright/docs/slots/](node_modules/dialogwright/docs/slots/README.md).
- To build the app from a description (a paragraph of what callers can do), follow the create-app skill, [.claude/skills/create-app/SKILL.md](.claude/skills/create-app/SKILL.md): a worksheet, the mapping onto slot types, policy and identity, the corpus and scenarios, and the checks until green. This folder is already scaffolded: skip the skill's scaffold step and work in this folder, where the skill says `apps/<name>`.
- `node_modules/dialogwright/README.md`: what the package carries. Never edit anything under `node_modules`.

## The three roles

1. **The perceiver.** A fast decision model reads what the caller said and answers typed questions: yes or no, which of these options, what value was given. It returns judgments, not generated text.
2. **The core.** Deterministic code owns the dialog and the form-filling. It decides what happens next from the model's judgments and the current state.
3. **The gate.** Every action goes through a policy gate that checks identity level, scope, confirmation and attempt limits. Every decision, allowed or refused, is written to a hash-chained audit log.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the app says, hears and collects. Slots are library types named in `slots.yaml`; write a slot in code only when none fits.
- `policy.yaml`: what the agent may do, action by action (the level and the rules the gate runs before each). Every tool in `src/app.ts` needs an action, and an action not listed is refused.
{{#identity}}
- `identity.yaml`: how a caller proves who they are (the factors, the verify tool and the number of tries).
{{/identity}}
- `policy.matrix`, `POLICY.md` and `APP-MAP.md`: the policy read back, generated from the folder and the code (what the gate decides for every action and every kind of caller, the policy in plain English, and the app as diagrams). They ship matching the example; `src/app.test.ts` fails when one differs from what the app generates.
- `src/app.ts`: the tools and the form hooks, joined to the folder by `defineApp`, and `testing.policyMatrix`, the callers and accounts the matrix crosses. `src/data.ts`: the fixture data behind the stub tool.
- `fixtures/`: `corpus.jsonl` (labelled utterances, every intent has some), `scenarios/` (scripted calls) and `expected/` (the stub baseline). A corpus line's `answers` field (`"answers":{"addressedToSystem":{"noul":0.15}}` on the side-speech line) sets the stub's answer to one of the engine's own questions; `noul` is a yes-or-no answer's probability of yes. See `.claude/skills/create-app/corpus.md`.

## Commands

Run these in this folder. Where the skill or the guide runs a command at the repository root (`pnpm <command>`), run `npx dialogwright <command>` here; where it runs one of the app's own scripts through pnpm with the app's package name, run `npm run <script>` here (and `npx dialogwright regress` for the regression).

```sh
npx dialogwright check                    # the folder against its schemas, the code, the prompts and the corpus
npm run typecheck
npm test
npx dialogwright regress                  # the stub regression: prints "no changes", then a summary
npx dialogwright regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
npx dialogwright regress --adversarial <id>  # one case of the adversarial suite, turn by turn
```

The check prints one line per problem, `file:line:column  path  message  ->  fix`. Act on the fix text.

After a change to `policy.yaml`{{#identity}}, `identity.yaml`{{/identity}}, the forms or the tools, write the read back again and read each diff as a change in what the agent may do:

```sh
npx dialogwright policy:matrix
npx dialogwright policy:card
npx dialogwright app:diagram
```

## Before committing

Run the check, the type check, the tests and the regression. Never regenerate the baseline, a snapshot or a page of the read back to make something pass: a changed output is a finding to explain. The one exception is this app's first baseline, made once with `regress --update` and reviewed in full. Never run `regress --client record`: recording calls a paid API and is for the owner of the app to do.

## Rules for this app

- Never put policy in tool code. Tools do the work; the gate decides, from `policy.yaml`, whether they may run.
- Never let a model write a regulated line. Every line a caller hears is in `prompts.yaml`, word for word. A knowledge base's answers are fixed text too, approved by a person (never by you: never run `kb:approve`, and never edit `kb/approvals.jsonl`).
- Import only from `'dialogwright'`, `'dialogwright/testing'` (tests), `'dialogwright/slot-kit'` (a slot type of your own) and `'dialogwright/policy'`. Nothing else of the package is supported.
- Every YAML file starts with `# yaml-language-server: $schema=node_modules/dialogwright/schemas/<kind>.schema.json`: keep the line when you add a file.
- Every tool lists the `params` its calls carry, and `policy.yaml` declares under `audit` how each is recorded. A rule of your own is written with `defineRule`, with an example the gate allows and one it refuses.
- The regression runs the adversarial suite (app.yaml's `testing: { adversarial: on }`; keep it on). A `FAIL adversarial` case is a finding: fix the app (a tool's `check` of its reply, the policy, a hook), never the case, and never turn the suite off to pass.
- Every tool whose reply a line says, or a call is made from, checks the reply (`check`, written with `replyShape`): a downstream system's reply is not trusted.
- Fictional data only: invented names, the 555 phone range.
- Never commit a key, and never put one in a file other than the git-ignored `.env`.
{{^identity}}
- `policy.yaml` belongs to compliance. Change it only when asked to, with the reason in the commit message, and expect review; commit `policy.matrix`, `POLICY.md` and `APP-MAP.md` with it.
{{/identity}}
{{#identity}}
- `policy.yaml` and `identity.yaml` belong to compliance. Change them only when asked to, with the reason in the commit message, and expect review; commit `policy.matrix`, `POLICY.md` and `APP-MAP.md` with them.
{{/identity}}

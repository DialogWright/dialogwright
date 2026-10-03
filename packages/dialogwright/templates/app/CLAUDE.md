# {{display}}: notes for AI coding assistants

{{display}} is a DialogWright app: a voice and chat agent whose dialog and policy are YAML and whose tools and form hooks are TypeScript. Read the repository's root `CLAUDE.md` first for the rules, and [docs/authoring-an-app.md]({{root}}/docs/authoring-an-app.md) before changing the folder. This app starts as a one-form example (book a service); the example is what you replace.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the app says, hears and collects. Slots are library types named in `slots.yaml` (see `{{root}}/docs/slots/`); write a slot in code only when none fits.
- `policy.yaml`: what the agent may do, action by action (the level and the rules the gate runs before each). Every tool in `src/app.ts` needs an action, and an action not listed is refused.
{{#identity}}
- `identity.yaml`: how a caller proves who they are (the factors, the verify tool and the number of tries).
{{/identity}}
- `policy.matrix`, `POLICY.md` and `APP-MAP.md`: the policy read back, generated from the folder and the code (what the gate decides for every action and every kind of caller, the policy in plain English, and the app as diagrams). They ship matching the example; `src/app.test.ts` fails when one differs from what the app generates.
- `src/app.ts`: the tools and the form hooks, joined to the folder by `defineApp`, and `testing.policyMatrix`, the callers and accounts the matrix crosses. `src/data.ts`: the fixture data behind the stub tool.
- `fixtures/`: `corpus.jsonl` (labelled utterances, every intent has some), `scenarios/` (scripted calls) and `expected/` (the stub baseline). A corpus line's `answers` field (`"answers":{"addressedToSystem":{"noul":0.15}}` on the side-speech line) sets the stub's answer to one of the engine's own questions; `noul` is a yes-or-no answer's probability of yes. See `.claude/skills/create-app/corpus.md`.

## Commands

Run these at the repository root.

```sh
pnpm check                                                # the folder against its schemas, the code, the prompts and the corpus
pnpm --filter @dialogwright/example-{{name}} typecheck
pnpm --filter @dialogwright/example-{{name}} test
pnpm --filter @dialogwright/example-{{name}} regress      # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-{{name}} regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`. Act on the fix text.

After a change to `policy.yaml`{{#identity}}, `identity.yaml`{{/identity}}, the forms or the tools, write the read back again and read each diff as a change in what the agent may do (the folder may be given by its path from the repository root):

```sh
pnpm policy:matrix apps/{{name}}
pnpm policy:card apps/{{name}}
pnpm app:diagram apps/{{name}}
```

## Before committing

Run `pnpm check`, then this app's typecheck, tests and `regress`, then the root checks (`pnpm verify` and the other apps' regressions). Never regenerate the baseline, a snapshot or a page of the read back to make something pass: a changed output is a finding to explain. The one exception is this app's first baseline, made once with `regress --update` and reviewed in full. Never run `regress --client record`: recording calls a paid API and is for the owner of the app to do.

## Rules for this app

- Never put policy in tool code. Tools do the work; the gate decides, from `policy.yaml`, whether they may run.
- Never let a model write a regulated line. Every line a caller hears is in `prompts.yaml`, word for word.
- Fictional data only: invented names, the 555 phone range.
{{^identity}}
- `policy.yaml` belongs to compliance. Change it only when asked to, with the reason in the commit message, and expect review.
{{/identity}}
{{#identity}}
- `policy.yaml` and `identity.yaml` belong to compliance. Change them only when asked to, with the reason in the commit message, and expect review.
{{/identity}}

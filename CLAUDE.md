# DialogWright: notes for AI coding assistants

DialogWright is a TypeScript framework for voice and chat agents that act safely. Read this before changing anything.

## The three roles

1. **The perceiver.** A fast decision model reads what the caller said and answers typed questions: yes or no, which of these options, what value was given. It returns judgments, not generated text.
2. **The core.** Deterministic code owns the dialog and the form-filling. It decides what happens next from the model's judgments and the current state.
3. **The gate.** Every action goes through a policy gate that checks identity level, scope, confirmation and attempt limits. Every decision, allowed or refused, is written to a hash-chained audit log.

Apps are defined against the `App` contract and plug into the engine. The engine knows nothing about any particular app.

An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales), TypeScript for what runs (slots, tools, form hooks, custom rules), joined by `defineApp`. To build or change one, read [docs/authoring-an-app.md](docs/authoring-an-app.md) first.

To start a new app, run `pnpm create-app <name>` (add `--identity` for one that verifies callers): it writes a small app under `apps/<name>` that passes `pnpm check`, its tests and its stub regression as created, with its own `CLAUDE.md`. To build an app from a description (a paragraph of what callers can do), follow the create-app skill, [.claude/skills/create-app/SKILL.md](.claude/skills/create-app/SKILL.md): a worksheet, the mapping onto slot types, policy and identity, the scaffold, the corpus and scenarios, and the checks until green. Each app has its own `CLAUDE.md`: read it before changing that app.

## Layout

- `packages/dialogwright`: the engine. Its `testkit` is the engine's own test fixture, not a template for apps.
- `packages/dialogwright/schemas/*.schema.json`: the JSON Schemas of the app folder's YAML files. They are generated from the zod schemas in `packages/dialogwright/src/define/schema/`; never edit them by hand. Run `pnpm --filter dialogwright schemas` after changing a zod schema (a test fails when they are stale).
- `packages/dialogwright/src/slots/`: the slot library, one folder per slot type (options schema, questions, fill, display, tests, examples, README). `docs/slots/*.md` are generated from it; never edit them by hand.
- `apps/*`: example apps. `apps/clinic` is the one to learn from. Each is a folder (app.yaml, intents.yaml, forms.yaml, prompts.yaml, policy.yaml, optional identity.yaml and locale/) with its code in `src/app.ts`, and a `CLAUDE.md` of its own.
- `packages/dialogwright/templates/`: the files `pnpm create-app` copies (`app/`, and `app-identity/` for what `--identity` changes). Edit them as real files; a test scaffolds both and runs check, typecheck, the app's tests and its regression.
- `packages/dialogwright/src/define/fixture/`: a tiny app folder (a library, with a Spanish locale) that the engine's own tests build.
- `.claude/skills/create-app/`: the create-app skill (`SKILL.md`), its worksheet template, its patterns and its corpus guide. A test checks its links and its vocabulary.
- `assets/brand`: logo and icons.

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm verify        # typecheck and test together
pnpm check         # every app folder under apps/: YAML, schemas, cross-links to the code, prompts, corpus
pnpm create-app <name> [--identity] [--dir <path>] [--display <text>]   # a new app from the template, linked into the workspace
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
pnpm --filter @dialogwright/example-clinic regress --scenario <id>   # one scripted call, turn by turn (also --corpus <id>; any app's regress)
pnpm --filter dialogwright schemas   # regenerate the JSON Schemas after a schema change
pnpm policy:matrix [dir...]   # write policy.matrix, the reviewed golden of what the gate decides (deliberate; tests compare it, CI never writes it)
pnpm policy:card [dir...]     # write POLICY.md, the policy in plain English with its diagrams (the same)
pnpm app:diagram [dir...]     # write APP-MAP.md, the app's intents, forms, slots, actions and rules as Mermaid diagrams (the same)
pnpm --filter dialogwright exec tsx src/define/cli.ts policy:convert <absolute folder>   # policy.yaml and identity.yaml from the old table shape to the current one (also: --from-tables <module>)
pnpm --filter dialogwright slot-docs   # regenerate docs/slots/*.md after a slot type's options, README or examples change
pnpm --filter dialogwright test slots/<type>   # a slot type's tests, including the conformance kit
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`, and exits 1 when there is any. Act on the fix text.

## Rules

- Never put policy in tool code. Tools do work; the gate decides whether they may run.
- Never let a model write a regulated line. A model chooses among approved lines; it does not compose them.
- The engine never imports an app.
- An app imports only from `'dialogwright'` (src/index.ts), the supported API, and from its three other entries: `'dialogwright/testing'` (its tests: the shadow harness, the slot conformance kit, the gate-event goldens, the gate grid and the shadow gate, with the one id map from the legacy evaluator's ids to the rules' names), `'dialogwright/slot-kit'` (the helpers a slot type is written with) and `'dialogwright/policy'` (policy.yaml and identity.yaml for an app that is not a folder: `definePolicy`, `defineIdentity`; the compilers; the gate (`compiledPolicyOf`, the named rules the lifecycle runs, and the legacy `evaluateCall`, the shadow gate's reference) and the types its tables and rules are written in). The `dialogwright/<dir>/<file>` subpaths are internals; when an app needs one, export it from the root instead.
- No real personal data anywhere: use the 555 phone range and invented names.
- Run `pnpm check`, `pnpm verify` (the type check and the tests) and both regressions (the testkit's and the clinic's) before committing. `pnpm check` is the one that catches an app folder and its code disagreeing.
- Every YAML file of an app starts with `# yaml-language-server: $schema=<relative path>/packages/dialogwright/schemas/<kind>.schema.json`, so an editor completes and checks it. Keep the line when you add a file.
- Rules are recorded by name (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`; a custom rule by its own id; `unlisted` for an action the policy does not list) in decisions, gate events, the trace, the console and the audit. Ask a decision whether a rule passed with `passed(decision, 'role')` (`'dialogwright/policy'`), never by an id string. The legacy ids `R0` to `R7` live only in the tables' `rulesFor` (and the legacy evaluator, the shadow gate's reference, whose ids the shadow maps to the names in one place: `nameOfLegacyId` in testing/gateGrid.ts) and in audit files written before 2026-10-03; an app's own rule may take none of them.
- A form's `hooks:` list in forms.yaml must name exactly the hooks the code writes for it, and every tool has an action in policy.yaml. Policy lives in policy.yaml and the gate, never in a tool.
- Most slots are configuration: an app names a library type in `slots.yaml` (see `docs/slots/README.md`). Write a slot in code only when no type fits. When you add or change a slot type, follow "Adding a slot type" in CONTRIBUTING.md: run its conformance kit (`pnpm --filter dialogwright test slots/<type>`), regenerate the schemas (`pnpm --filter dialogwright schemas`) and the pages (`pnpm --filter dialogwright slot-docs`), and commit the results; tests fail when they are stale. Edit a type's `README.md`, never the generated page.
- Keep `packages/dialogwright` free of any one industry's vocabulary: its code, comments, tests and fixtures use neutral words (caller, subject, record, request, appointment, loan). Words that belong to one app's domain stay in that app. The same goes for names, dates of birth and numbers: invented, 555 range.
- Never regenerate a regression baseline or snapshot to make a test pass. A changed output is a finding to explain, not noise to overwrite.

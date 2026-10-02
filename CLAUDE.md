# DialogWright: notes for AI coding assistants

DialogWright is a TypeScript framework for voice and chat agents that act safely. Read this before changing anything.

## The three roles

1. **The perceiver.** A fast decision model reads what the caller said and answers typed questions: yes or no, which of these options, what value was given. It returns judgments, not generated text.
2. **The core.** Deterministic code owns the dialog and the form-filling. It decides what happens next from the model's judgments and the current state.
3. **The gate.** Every action goes through a policy gate that checks identity level, scope, confirmation and attempt limits. Every decision, allowed or refused, is written to a hash-chained audit log.

Apps are defined against the `App` contract and plug into the engine. The engine knows nothing about any particular app.

An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales), TypeScript for what runs (slots, tools, form hooks, custom rules), joined by `defineApp`. To build or change one, read [docs/authoring-an-app.md](docs/authoring-an-app.md) first.

## Layout

- `packages/dialogwright`: the engine. Its `testkit` is the engine's own test fixture, not a template for apps.
- `packages/dialogwright/schemas/*.schema.json`: the JSON Schemas of the app folder's YAML files. They are generated from the zod schemas in `packages/dialogwright/src/define/schema/`; never edit them by hand. Run `pnpm --filter dialogwright schemas` after changing a zod schema (a test fails when they are stale).
- `apps/*`: example apps. `apps/clinic` is the one to learn from. Each is a folder (app.yaml, intents.yaml, forms.yaml, prompts.yaml, policy.yaml, optional identity.yaml and locale/) with its code in `src/app.ts`.
- `packages/dialogwright/src/define/fixture/`: a tiny app folder (a library, with a Spanish locale) that the engine's own tests build.
- `assets/brand`: logo and icons.

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm verify        # typecheck and test together
pnpm check         # every app folder under apps/: YAML, schemas, cross-links to the code, prompts, corpus
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
pnpm --filter dialogwright schemas   # regenerate the JSON Schemas after a schema change
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`, and exits 1 when there is any. Act on the fix text.

## Rules

- Never put policy in tool code. Tools do work; the gate decides whether they may run.
- Never let a model write a regulated line. A model chooses among approved lines; it does not compose them.
- The engine never imports an app.
- An app imports only from `'dialogwright'` (src/index.ts), the supported API. The `dialogwright/<dir>/<file>` subpaths are internals; when an app needs one, export it from the root instead.
- No real personal data anywhere: use the 555 phone range and invented names.
- Run `pnpm check`, `pnpm verify` (the type check and the tests) and both regressions (the testkit's and the clinic's) before committing. `pnpm check` is the one that catches an app folder and its code disagreeing.
- Every YAML file of an app starts with `# yaml-language-server: $schema=<relative path>/packages/dialogwright/schemas/<kind>.schema.json`, so an editor completes and checks it. Keep the line when you add a file.
- A form's `hooks:` list in forms.yaml must name exactly the hooks the code writes for it, and every tool has a row in policy.yaml. Policy lives in policy.yaml and the gate, never in a tool.
- Keep `packages/dialogwright` free of any one industry's vocabulary: its code, comments, tests and fixtures use neutral words (caller, subject, record, request, appointment, loan). Words that belong to one app's domain stay in that app. The same goes for names, dates of birth and numbers: invented, 555 range.
- Never regenerate a regression baseline or snapshot to make a test pass. A changed output is a finding to explain, not noise to overwrite.

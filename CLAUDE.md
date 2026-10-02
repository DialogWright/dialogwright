# DialogWright: notes for AI coding assistants

DialogWright is a TypeScript framework for voice and chat agents that act safely. Read this before changing anything.

## The three roles

1. **The perceiver.** A fast decision model reads what the caller said and answers typed questions: yes or no, which of these options, what value was given. It returns judgments, not generated text.
2. **The core.** Deterministic code owns the dialog and the form-filling. It decides what happens next from the model's judgments and the current state.
3. **The gate.** Every action goes through a policy gate that checks identity level, scope, confirmation and attempt limits. Every decision, allowed or refused, is written to a hash-chained audit log.

Apps are defined against the `App` contract and plug into the engine. The engine knows nothing about any particular app.

## Layout

- `packages/dialogwright`: the engine. Its `testkit` is the engine's own test fixture, not a template for apps.
- `apps/*`: example apps. `apps/clinic` is the one to learn from.
- `assets/brand`: logo and icons.

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
```

## Rules

- Never put policy in tool code. Tools do work; the gate decides whether they may run.
- Never let a model write a regulated line. A model chooses among approved lines; it does not compose them.
- The engine never imports an app.
- An app imports only from `'dialogwright'` (src/index.ts), the supported API. The `dialogwright/<dir>/<file>` subpaths are internals; when an app needs one, export it from the root instead.
- No real personal data anywhere: use the 555 phone range and invented names.
- Run the type check, the tests and both regressions (the testkit's and the clinic's) before committing.
- Never regenerate a regression baseline or snapshot to make a test pass. A changed output is a finding to explain, not noise to overwrite.

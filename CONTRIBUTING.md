# Contributing to DialogWright

Pull requests are welcome. Thank you for helping.

## Build and test

Node 22.19 or later and pnpm are required.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm --filter dialogwright regress:testkit
```

`pnpm verify` runs the type check and the tests together, and `pnpm check` checks every app folder (its YAML against the schemas and the cross-references, and against the app's code). Run all of the above before you open a pull request.

## Rules

- The engine imports no app. Apps depend on the engine, never the other way around.
- No private data or real personal information in code, tests or fixtures. Use the 555 phone range and invented names.
- Policy belongs in the gate, never in tool code. A tool does its job; the gate decides whether it may run.
- A model never writes a regulated line. It only chooses among approved ones.
- Do not regenerate a regression baseline or snapshot to make a test pass. If output changed, understand why first.

## Pull requests

On your first pull request, CLA Assistant will ask you to sign the [Individual Contributor License Agreement](docs/CLA.md) with your GitHub account; it takes a minute and covers all your future contributions. The agreement lets the project keep offering your work under Apache-2.0 and under other terms in the future, while you keep your copyright. If you contribute for a company, open an issue about a corporate agreement first.

Keep changes focused, and say what changed and why.

## Be kind

Be respectful and constructive in issues, reviews and discussions. Assume good faith.

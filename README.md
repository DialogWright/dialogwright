<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/dialogwright-logo-dark.svg">
    <img src="assets/brand/dialogwright-logo.svg" alt="DialogWright" width="420">
  </picture>
</p>

DialogWright is an open-source TypeScript framework for voice and chat agents that act safely. A fast decision model reads what the caller said and answers typed questions (judgments, not generated text). Deterministic code decides what happens next. Every action goes through a policy gate that enforces identity levels, scope, confirmation and attempt limits, and every decision is recorded in a hash-chained audit log. An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales) and TypeScript for what runs (slots, tools, hooks), joined by `defineApp`, so the same engine can run a clinic, a utility company or anything else.

## Status

Pre-release. APIs will change, and the packages are not yet published to npm.

The package ships TypeScript source (run it with tsx or vitest) until a release adds a build.

## What's here

- `packages/dialogwright`: the engine. Its testkit is the engine's own test fixture, not a starting point for an app. An app imports only from `'dialogwright'`, the package's supported API (`src/index.ts`, grouped and documented there), and from `'dialogwright/testing'` (for its tests) and `'dialogwright/slot-kit'` (to write a slot type); the per-file subpaths (`dialogwright/core/...`) are internals that may change between versions.
- [docs/authoring-an-app.md](docs/authoring-an-app.md): how to build an app, for a developer or an AI coding assistant: the folder, each file with an example (including `slots.yaml`), policy and identity in full, what stays in TypeScript, how to write a slot, `pnpm check` and its messages, locales, configuration hashes.
- Policy as a file compliance can read: `policy.yaml` (named rules per action: `identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, and rules of your own) and `identity.yaml` (the ladder of levels, the one-time code, delegates and their roles). A policy is tested against its file (invariants, and `policy.matrix`, a reviewed golden of what the gate decides), and `pnpm policy:card` writes it in plain English, with diagrams, for a reviewer; `pnpm app:diagram` draws the app's structure; `CODEOWNERS` makes a change need compliance's approval.
- [docs/slots](docs/slots/README.md): the slot types. Most slots are configuration: an app names a type (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`) in its `slots.yaml` with a few options, and the engine asks the model the right questions and checks the answers. One page per type, generated from its options.
- [llms.txt](llms.txt): an index of these docs for AI assistants.
- `packages/dialogwright/schemas`: the JSON Schema of each YAML file in an app folder; every file names its schema on its first line, so an editor completes and checks it.
- `apps/clinic`: Example Family Practice, a fictional clinic's appointment line, an app folder, and the first example app to read. A caller can schedule, reschedule, cancel or confirm an appointment with one of eight providers, or be put through to billing. It shows an app with no identity verification, all five of its slots configured in `slots.yaml` from the slot library, reads and gated writes through the directory tools, scheduling built from generic form hooks, and its own corpus (241 labelled utterances), scripted calls (89) and regression baseline. It needs no keys: `pnpm --filter @dialogwright/example-clinic cli --client heuristic` is a text console, and `pnpm --filter @dialogwright/example-clinic regress` replays its fixtures. See [apps/clinic/README.md](apps/clinic/README.md).
- A utility company example is coming.

## Quick start

```sh
pnpm install
pnpm verify                                  # type check and tests
pnpm check                                   # every app folder under apps/
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
pnpm --filter dialogwright slot-docs         # regenerate the slot type pages
pnpm policy:card apps/clinic                 # write the policy card, POLICY.md (also: policy:matrix, app:diagram)
```

`pnpm check` reads each app folder's YAML against its schemas and cross-checks it against the app's code, printing each problem with its file, line and fix; it prints `apps/clinic: ok` when there are none. To try an app with no keys, run the clinic's text console: `pnpm --filter @dialogwright/example-clinic cli --client heuristic`. To build your own, start with [docs/authoring-an-app.md](docs/authoring-an-app.md). A slot is a few lines in `slots.yaml`, for example `account: { type: digits, noun: account, length: 8, keypad: true }`; the [slot types](docs/slots/README.md) say which type to use and what each option does.

Requires Node 22.19 or later and pnpm.

## Design and guides

- [docs/authoring-an-app.md](docs/authoring-an-app.md): build an app, including its policy and identity.
- [docs/slots/README.md](docs/slots/README.md): the slot types.
- [docs/design.md](docs/design.md): the design and the roadmap.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, including adding a slot type and a built-in policy rule.
- [llms.txt](llms.txt): an index for AI assistants.

## License

Apache-2.0; see [LICENSE](LICENSE). The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](NOTICE).

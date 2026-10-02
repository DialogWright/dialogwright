<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/dialogwright-logo-dark.svg">
    <img src="assets/brand/dialogwright-logo.svg" alt="DialogWright" width="420">
  </picture>
</p>

DialogWright is an open-source TypeScript framework for voice and chat agents that act safely. A fast decision model reads what the caller said and answers typed questions (judgments, not generated text). Deterministic code decides what happens next. Every action goes through a policy gate that enforces identity levels, scope, confirmation and attempt limits, and every decision is recorded in a hash-chained audit log. Apps are defined against an `App` contract, so the same engine can run a clinic, a utility company or anything else.

## Status

Pre-release. APIs will change, and the packages are not yet published to npm.

The package ships TypeScript source (run it with tsx or vitest) until a release adds a build.

## What's here

- `packages/dialogwright`: the engine. Its testkit is the engine's own test fixture, not a starting point for an app. An app imports only from `'dialogwright'`, the package's supported API (`src/index.ts`, grouped and documented there); the per-file subpaths (`dialogwright/core/...`) are internals that may change between versions.
- `apps/clinic`: Example Family Practice, a fictional clinic's appointment line, and the first example app to read. A caller can schedule, reschedule, cancel or confirm an appointment with one of eight providers, or be put through to billing. It shows an app with no identity verification, reads and gated writes through the directory tools, scheduling built from generic form hooks, and its own corpus (241 labelled utterances), scripted calls (89) and regression baseline. It needs no keys: `pnpm --filter @dialogwright/example-clinic cli --client heuristic` is a text console, and `pnpm --filter @dialogwright/example-clinic regress` replays its fixtures. See [apps/clinic/README.md](apps/clinic/README.md).
- A utility company example is coming.

## Quick start

```sh
pnpm install
pnpm test
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
```

Requires Node 22.19 or later and pnpm.

## Design

See [docs/design.md](docs/design.md).

## License

Apache-2.0; see [LICENSE](LICENSE). The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](NOTICE).

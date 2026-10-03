# DialogWright: notes for AI coding assistants

DialogWright is a TypeScript framework for voice and chat agents that understand people and act safely: understanding is flexible (a decision model perceives through typed questions, so a caller talks naturally), while what is said and done is predictable (fixed lines, code that decides, a policy gate) and replies are fast. Read this before changing anything.

## The three roles

1. **The perceiver.** A fast decision model reads what the caller said and answers typed questions: yes or no, which of these options, what value was given. It returns judgments, not generated text.
2. **The core.** Deterministic code owns the dialog and the form-filling. It decides what happens next from the model's judgments and the current state.
3. **The gate.** Every action goes through a policy gate that checks identity level, scope, confirmation and attempt limits. Every decision, allowed or refused, is written to a hash-chained audit log.

Apps are defined against the `App` contract and plug into the engine. The engine knows nothing about any particular app.

An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales), TypeScript for what runs (slots, tools, form hooks, custom rules), joined by `defineApp`. To build or change one, read [docs/authoring-an-app.md](docs/authoring-an-app.md) first.

## Layout

- `packages/dialogwright`: the engine. Its `testkit` is the engine's own test fixture, not a template for apps.
- `packages/dialogwright/schemas/*.schema.json`: the JSON Schemas of the app folder's YAML files. They are generated from the zod schemas in `packages/dialogwright/src/define/schema/`; never edit them by hand. Run `pnpm --filter dialogwright schemas` after changing a zod schema (a test fails when they are stale).
- `packages/dialogwright/src/slots/`: the slot library, one folder per slot type (options schema, questions, fill, display, tests, examples, README). `docs/slots/*.md` are generated from it; never edit them by hand.
- `apps/*`: example apps. `apps/clinic` is the one to learn from. Each is a folder (app.yaml, intents.yaml, forms.yaml, prompts.yaml, policy.yaml, optional identity.yaml and locale/, and the generated POLICY.md, policy.matrix and APP-MAP.md) with its code in `src/app.ts`.
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
pnpm policy:matrix [dir...]   # write policy.matrix, the reviewed golden of what the gate decides (deliberate; tests compare it, CI never writes it)
pnpm policy:card [dir...]     # write POLICY.md, the policy in plain English with its diagrams (the same)
pnpm app:diagram [dir...]     # write APP-MAP.md, the app's intents, forms, slots, actions and rules as Mermaid diagrams (the same)
pnpm --filter dialogwright exec tsx src/define/cli.ts policy:convert <absolute folder>   # policy.yaml and identity.yaml from the old table shape to the current one (also: --from-tables <module>, --dry-run; it writes `signIn: { level: 2 }` where the old identity has a code, as the old engine took a sign-in, unless --no-sign-in)
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
- Rules are recorded by name (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`; a custom rule by its own id; `unlisted` for an action the policy does not list; `subject` for an identity tool refused to a party who is not one of the app's subjects, which the gate does for every app) in decisions, gate events, the trace, the console and the audit. Ask a decision whether a rule passed with `passed(decision, 'role')` (`'dialogwright/policy'`), never by an id string. The legacy ids `R0` to `R7` live only in the tables' `rulesFor` (and the legacy evaluator, the shadow gate's reference, whose ids the shadow maps to the names in one place: `nameOfLegacyId` in testing/gateGrid.ts) and in audit files written before 2026-10-03; an app's own rule may take none of them.
- Policy changes land as a set. After you change policy.yaml or identity.yaml, run `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram` for the app, read each diff as a change in what the agent may do, and commit them with the policy; the golden tests fail when one is stale. Never write them to make a test pass without understanding the diff, and never from CI. The three tests an app keeps beside its policy are `policyInvariants`, `expectPolicyMatrix` (with `runRuleExamples`) and `expectPolicyCard`, from `'dialogwright/testing'`. Write `say:` for every action. `.github/CODEOWNERS` makes a change to these files need compliance's review: do not widen it away.
- A rule of an app's own is written with `defineRule` (from `'dialogwright/policy'`), with a description and at least one example the gate allows and one it refuses; its `compared` line goes to the audit as it is, so it holds only what may be recorded. The built-in rules are `identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange` and `limit`; add one only through "Adding a built-in policy rule" in CONTRIBUTING.md.
- Every tool lists the `params` its calls carry, and `policy.yaml` declares under `audit` how each that is not a slot with a redact setting is recorded (`last4`, `mask`, `length`, `secret` or `keep`). A tool whose result a party acting for subjects may not see in full declares its `fields`, and `redact` names them. Bounds of `dateInRange` and `limit` come only from the app's lookups (`code.lookups`), never from the session.
- A form's `hooks:` list in forms.yaml must name exactly the hooks the code writes for it, and every tool has an action in policy.yaml. Policy lives in policy.yaml and the gate, never in a tool.
- Most slots are configuration: an app names a library type in `slots.yaml` (see `docs/slots/README.md`). Write a slot in code only when no type fits. When you add or change a slot type, follow "Adding a slot type" in CONTRIBUTING.md: run its conformance kit (`pnpm --filter dialogwright test slots/<type>`), regenerate the schemas (`pnpm --filter dialogwright schemas`) and the pages (`pnpm --filter dialogwright slot-docs`), and commit the results; tests fail when they are stale. Edit a type's `README.md`, never the generated page.
- Keep `packages/dialogwright` free of any one industry's vocabulary: its code, comments, tests and fixtures use neutral words (caller, subject, record, request, appointment, loan). Words that belong to one app's domain stay in that app. The same goes for names, dates of birth and numbers: invented, 555 range.
- Never regenerate a regression baseline or snapshot to make a test pass. A changed output is a finding to explain, not noise to overwrite.

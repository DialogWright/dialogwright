# DialogWright: notes for AI coding assistants

DialogWright is a TypeScript framework for voice and chat agents that understand people and act safely: understanding is flexible (a decision model perceives through typed questions, so a caller talks naturally), while what is said and done is predictable (fixed lines, code that decides, a policy gate) and replies are fast. Read this before changing anything.

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
- `packages/dialogwright/src/kb/`: the knowledge base in the engine (the `kb/` folder's reading and rules, resolution, approval and staleness, the knowledge record, the retrievers: keyword, dense, hybrid, the static embedder and its pinned model, the index, the bake-off, the optional ONNX adapter, and speaking an answer). An app's own `kb/` folder (kb.yaml, topics.yaml, passages, sources, locale, pending, rejected, approvals.jsonl, .index) is data: [section 12 of the guide](docs/authoring-an-app.md#12-the-knowledge-base).
- `packages/kb-author`: `@dialogwright/kb-author`, the knowledge base's authoring tools (`pnpm kb:ingest`: documents and websites into `kb/sources`; `kb:draft`: drafts into `kb/pending`; `kb:review`: the local review page; `kb:refresh`: the sources read again; `kb:gaps`: what callers asked that the knowledge base did not answer, ranked from the traces). Authoring only: an app never imports it, and its dependencies stay out of the engine. Drafting calls a model with the author's own key, on their machine: never in CI or a test.
- `packages/widget`: `@dialogwright/widget`, the web chat widget a site embeds (a script with no runtime dependencies that speaks only the chat wire, `src/channel/chat/protocol.ts`). It never imports the engine at run time; the engine's web chat, its carriers and every channel option are [section 13 of the guide](docs/authoring-an-app.md#13-channels).
- `packages/dialogwright/src/server/`: the server an app runs on (`pnpm --filter <app> serve`), and the root commands for running it on a machine you own (`setup.ts` is `pnpm configure`, `start.ts`, `doctor.ts` is `pnpm diagnose`, `serviceFile.ts`, `fallback.ts`, `console/linkCli.ts`; the service templates are in `packages/dialogwright/templates/service/`). `server/stores/` holds the session store interfaces (`types.ts`) and their memory and file implementations, each held to `runStoreContract` (`dialogwright/testing`). Every option is in [section 14 of the guide](docs/authoring-an-app.md#14-running-it).
- `apps/*`: example apps. `apps/clinic` is the one to learn from. Each is a folder (app.yaml, intents.yaml, forms.yaml, prompts.yaml, policy.yaml, optional identity.yaml and locale/, and the generated POLICY.md, policy.matrix and APP-MAP.md) with its code in `src/app.ts`, and a `CLAUDE.md` of its own.
- `packages/dialogwright/templates/`: the files `pnpm create-app` copies (`app/`, and `app-identity/` for what `--identity` changes). Edit them as real files; a test scaffolds both and runs check, typecheck, the app's tests and its regression, and the three read-back commands, which must change nothing. Each variant ships its `policy.matrix`, `POLICY.md` and `APP-MAP.md` with `{{name}}` and `{{display}}` in their titles: after changing a template's policy, forms or tools, scaffold that variant into a scratch folder, run the three commands there, and copy the pages back with the name and display put back as tokens.
- `packages/dialogwright/src/define/fixture/`: a tiny app folder (a library, with a Spanish locale) that the engine's own tests build.
- `packages/dialogwright/src/testing/screened/`: a tiny app folder (a free visit booked after three checks) that the engine's tests of a form's `checks` build, with its corpus, scripted calls and read-back pages; `tsx src/testing/screened/regress.ts --scenario <id>` follows one call turn by turn.
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
pnpm --filter dialogwright exec tsx src/define/cli.ts policy:convert <absolute folder>   # policy.yaml and identity.yaml from the old table shape to the current one (also: --from-tables <module>, --dry-run; it writes `signIn: { level: 2 }` where the old identity has a code, as the old engine took a sign-in, unless --no-sign-in)
pnpm --filter dialogwright slot-docs   # regenerate docs/slots/*.md after a slot type's options, README or examples change
pnpm kb:model                 # download the pinned embedding model (potion-base-8M) into ~/.cache/dialogwright/models, checking its SHA-256
pnpm kb:index [dir...]        # write a knowledge base's vector index (kb/.index/<embedder>.json) after its topics change; commit it
pnpm kb:bakeoff <dir> --paraphrases <file> [--sweep]   # compare the retrievers on paraphrases offline; pick kb.yaml's floor and cap here
pnpm kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>]   # approve a passage or a draft after reading it against its source: a person does this at their terminal (it asks them to confirm), never an assistant or a tool
pnpm kb:status [dir...]       # the passages by state (fresh, stale, edited, never approved, drafts), each with its fix
pnpm kb:ingest <folder | file | url> --dir <app folder> [--depth N] [--include <glob>] [--dry-run]   # documents or a website into kb/sources/<doc>.yaml, by section with provenance (packages/kb-author)
pnpm kb:draft [app folder] [--source <doc>] [--topic-hint <text>] [--model <id>]   # drafts from the sources into kb/pending with Claude (ANTHROPIC_API_KEY, the author's; refuses in CI); each checked, never said
pnpm kb:review [app folder] [--port N] [--traces <path|glob>]   # the review page on 127.0.0.1 with a one-time token: approve, edit then approve, reject; accept or merge proposed topics; its Gaps tab ranks what callers asked that nothing answered
pnpm kb:refresh [app folder]             # read every source again from its provenance; lists passages withheld and sections nothing cites
pnpm kb:gaps [app folder] [--traces <path|glob>] [--since YYYY-MM-DD] [--out gaps.md] [--json]   # rank what callers asked that the knowledge base did not answer, from the traces, with the fix for each
pnpm --filter dialogwright test slots/<type>   # a slot type's tests, including the conformance kit
pnpm configure [--app <name>]   # asks, and writes <app>/.env (mode 600): a laptop with no keys, or a phone line; a key is read with the echo off or from its own environment variable, never a flag
[ENV_FILE=<path>] pnpm start [--app <name>] [--tunnel quick|named|none]   # the app's server with its .env, or the file ENV_FILE names (not --env-file: some pnpm builds take that flag themselves); quick, the default with PUBLIC_HOST unset, opens a Cloudflare quick tunnel (no account)
[ENV_FILE=<path>] pnpm diagnose [--app <name>] [--offline]   # what is misconfigured, one line per check with its fix; sends no key and calls no carrier or model API
pnpm audit:verify <audit folder>   # each audit day file's hash chain; exit 1 at the first break
ENV_FILE=<path> pnpm service <launchd|systemd> --app <name> [--label <label>] [--out <file>]   # a service file with this machine's paths; prints the install commands, runs none
pnpm fallback --provider <twilio|telnyx> --number <E.164> [--message "..."] --out <file>   # the document a carrier plays when it cannot reach the server; host it elsewhere, paste its URL where it says
[ENV_FILE=<path>] pnpm console:link [--app <name>]   # with CONSOLE_AUTH=token: a new one-time sign-in link for the console (the one before it stops working), printed on the server's machine
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`, and exits 1 when there is any. Act on the fix text.

## Rules

- Never put policy in tool code. Tools do work; the gate decides whether they may run.
- Never let a model write a regulated line. A model chooses among approved lines; it does not compose them.
- The engine never imports an app.
- An app imports only from `'dialogwright'` (src/index.ts), the supported API, and from its three other entries: `'dialogwright/testing'` (its tests: the shadow harness, the slot conformance kit, the gate-event goldens, the gate grid and the shadow gate, with their reference, the legacy `evaluateCall`, and the one id map from its ids to the rules' names), `'dialogwright/slot-kit'` (the helpers a slot type is written with) and `'dialogwright/policy'` (the gate, `compiledPolicyOf`, the named rules the lifecycle runs, and `passed`; policy.yaml and identity.yaml for an app that is not a folder: `definePolicy`, `defineIdentity`; the compilers; and the types its tables and rules are written in). The `dialogwright/<dir>/<file>` subpaths are internals; when an app needs one, export it from the root instead.
- No real personal data anywhere: use the 555 phone range and invented names.
- Run `pnpm check`, `pnpm verify` (the type check and the tests) and both regressions (the testkit's and the clinic's) before committing. `pnpm check` is the one that catches an app folder and its code disagreeing.
- Every YAML file of an app starts with `# yaml-language-server: $schema=<relative path>/packages/dialogwright/schemas/<kind>.schema.json`, so an editor completes and checks it. Keep the line when you add a file.
- Rules are recorded by name (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf`, `noneOf`; a custom rule by its own id; `unlisted` for an action the policy does not list; `subject` for an identity tool refused to a party who is not one of the app's subjects, which the gate does for every app) in decisions, gate events, the trace, the console and the audit. Ask a decision whether a rule passed with `passed(decision, 'role')` (`'dialogwright/policy'`), never by an id string. The legacy ids `R0` to `R7` live only in the tables' `rulesFor` (and the legacy evaluator, the shadow gate's reference, whose ids the shadow maps to the names in one place: `nameOfLegacyId` in testing/gateGrid.ts) and in audit files written before 2026-10-03; an app's own rule may take none of them.
- Policy changes land as a set. After you change policy.yaml or identity.yaml, run `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram` for the app, read each diff as a change in what the agent may do, and commit them with the policy; the golden tests fail when one is stale. Never write them to make a test pass without understanding the diff, and never from CI. The three tests an app keeps beside its policy are `policyInvariants`, `expectPolicyMatrix` (with `runRuleExamples`) and `expectPolicyCard`, from `'dialogwright/testing'`. Write `say:` for every action. `.github/CODEOWNERS` makes a change to these files need compliance's review: do not widen it away.
- A rule of an app's own is written with `defineRule` (from `'dialogwright/policy'`), with a description and at least one example the gate allows and one it refuses; its `compared` line goes to the audit as it is, so it holds only what may be recorded. The built-in rules are `identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf` and `noneOf`; add one only through "Adding a built-in policy rule" in CONTRIBUTING.md.
- Every tool lists the `params` its calls carry, and `policy.yaml` declares under `audit` how each that is not a slot with a redact setting is recorded (`last4`, `mask`, `length`, `secret` or `keep`). A tool whose result a party acting for subjects may not see in full declares its `fields`, and `redact` names them. Bounds of `dateInRange` and `limit` come only from the app's lookups (`code.lookups`), never from the session, and every param a reference reads is held to the caller's own records by a `scope` rule earlier in the action, unless the rule says `unscoped: true` (its lookup is about no one's record).
- A form's `hooks:` list in forms.yaml must name exactly the hooks the code writes for it, and every tool has an action in policy.yaml. Policy lives in policy.yaml and the gate, never in a tool.
- Most slots are configuration: an app names a library type in `slots.yaml` (see `docs/slots/README.md`). Write a slot in code only when no type fits. When you add or change a slot type, follow "Adding a slot type" in CONTRIBUTING.md: run its conformance kit (`pnpm --filter dialogwright test slots/<type>`), regenerate the schemas (`pnpm --filter dialogwright schemas`) and the pages (`pnpm --filter dialogwright slot-docs`), and commit the results; tests fail when they are stale. Edit a type's `README.md`, never the generated page.
- Keep `packages/dialogwright` free of any one industry's vocabulary: its code, comments, tests and fixtures use neutral words (caller, subject, record, request, appointment, loan). Words that belong to one app's domain stay in that app. The same goes for names, dates of birth and numbers: invented, 555 range.
- A knowledge base's answers are fixed text, said word for word. A model never writes or rewrites one: it may only choose which topic a caller asked about (the `topic` slot), and a drafting tool may only propose a passage into `kb/pending`, which is never read at run time.
- Approvals are by people only. Never run `pnpm kb:approve` (or the review page) to make a check pass, never pass it `--yes`, never write an `approval` or a hash by hand (`pnpm check` refuses an approval with no line in the log), and never edit `kb/approvals.jsonl` (it is only appended to). A passage that is stale or edited is withheld until a person has read it against its source and approved it again.
- Never commit a model key. `kb:draft` reads `ANTHROPIC_API_KEY` from the environment or a git-ignored `.env`; it refuses in CI, and no test, fixture or script makes a real drafting call (tests use a fake drafter). Never put a key in a file, a log or a message.
- Retrieval floors, caps and the retriever change the request the model gets, so they are chosen offline on paraphrase sets (`pnpm kb:bakeoff --sweep`), never by re-recording a cassette. After a change to a topic's title, keywords or example questions in an app with an embedder, run `pnpm kb:index` and commit the index.
- A tool that writes declares `idempotent: true` and passes `ctx.idempotencyKey` to the system it writes to, so a write repeated after a restart is not done twice. What goes into an idempotency key (`core/idempotency.ts`) is a promise kept across versions; a change to the shape of a saved session bumps `SESSION_SCHEMA` (`core/session.ts`), so a call saved before it goes to a person rather than resume wrongly.
- A new session store implements `server/stores/types.ts` and passes `runStoreContract` unchanged (CONTRIBUTING.md, "Adding a session store"). Every server option has a default that keeps the behaviour from before it, and is documented in section 14.12 of the guide and each `.env.example`.
- Never regenerate a regression baseline or snapshot to make a test pass. A changed output is a finding to explain, not noise to overwrite.

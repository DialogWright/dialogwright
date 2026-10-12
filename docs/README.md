# The documentation

Everything in this repository, what each part is, and where its documentation is. The [README](../README.md) is the short version: what DialogWright is, a try with no keys, how to build your own and how to answer a real call.

## Start here

- [Your first app](first-app.md): a guided first app. A paragraph describing a small home services company's line, what to give an AI coding assistant, what it asks and produces, how to run it with no keys, record it and call it, and how to change the paragraph for your own business.
- [The authoring guide](guide/README.md): how to build an app or change one, for a developer or an AI coding assistant, in chapters (below). Read it a chapter at a time.
- [The create-app skill](../.claude/skills/create-app/SKILL.md): the procedure an AI coding assistant follows to turn a paragraph into an app, with its worksheet, its options index, its verified patterns, its corpus guide and its triage of a recording.
- [CLAUDE.md](../CLAUDE.md): the three roles, the layout, the commands and the rules, for anyone (or any assistant) changing this repository.
- [llms.txt](../llms.txt): an index of these docs for AI assistants.

## The authoring guide, by chapter

1. [The folder](guide/01-the-folder.md): what an app is made of, and where each piece lives.
2. [The files, one by one](guide/02-the-files-one-by-one.md): app.yaml (the number calling, business hours, the handoff's data, the transfer's targets), intents.yaml (an intent the model is unsure of, a priority intent), forms.yaml (checks, sub-forms), prompts.yaml, policy.yaml, identity.yaml, routes.yaml, slots.yaml, the locale files, fixtures/ and kb/, each with an example.
3. [Policy and identity](guide/03-policy-and-identity.md): an action and its rules, the built-in rules, rules of your own, the identity ladder, redaction, what is recorded, testing the policy, the policy card and the app map, and who reviews it.
4. [What stays in TypeScript, and why](guide/04-what-stays-in-typescript-and-why.md): tools, hooks, lookups, and a tool's reply checked before anything reads it.
5. [Writing a slot](guide/05-writing-a-slot.md): a library type in slots.yaml first, where a slot listens, a callback number, a text offer, a value proposed from a lookup, retries and what happens when a slot runs out, and a slot in code when no type fits.
6. [The form hooks](guide/06-the-form-hooks.md): what a form's code may do, and the start hook, named predicates and `failSoft`.
7. [Checking an app: `pnpm check`](guide/07-checking-an-app-pnpm-check.md): what it checks, and how to read its one line per problem.
8. [Locales](guide/08-locales.md): an app in more than one language.
9. [Configuration hashes](guide/09-configuration-hashes.md): what a call records of the app it ran on.
10. [Editor support](guide/10-editor-support.md): the schema line on each YAML file.
11. [Walkthroughs](guide/11-walkthroughs.md): adding an intent, a form, a tool and a knowledge answer; following one scripted call turn by turn; after a recorded run; where to start.
12. [The knowledge base](guide/12-the-knowledge-base.md): answers to general questions from approved passages, said word for word.
13. [Channels](guide/13-channels.md): carriers, languages on the phone, web chat, sign-in, the widget, the call's data and where a handoff goes.
14. [Running it](guide/14-running-it.md): on a machine you own, from the first hour with two keys to a machine that stays on, and every option.
15. [The adversarial suite](guide/15-the-adversarial-suite.md): the hostile calls every app inherits, and how to read a failure.

The guide was one page, `docs/authoring-an-app.md`; that page now keeps a line for each of its old sections, so a link to it still lands.

## What is in this repository

### The engine and its command line

- `packages/dialogwright`: the engine. An app imports only from `'dialogwright'`, the supported API (`src/index.ts`, grouped and documented there), and from `'dialogwright/testing'` (its tests), `'dialogwright/slot-kit'` (a slot type of its own) and `'dialogwright/policy'` (the gate and the policy's compilers); the per-file subpaths are internals that may change between versions. Its testkit is the engine's own test fixture, not a starting point for an app. [Its README](../packages/dialogwright/README.md) says what the package carries.
- One command line, `dialogwright`: `check`, `create-app`, `regress`, `policy:matrix`, `policy:card`, `app:diagram`, `policy:convert`, `configure`, `start`, `diagnose`, `service`, `fallback`, `console:link`, `audit:verify` and the knowledge base's `kb:model`, `kb:index`, `kb:bakeoff`, `kb:approve` and `kb:status` (`dialogwright help` lists them). The authoring commands `kb:ingest`, `kb:draft`, `kb:review`, `kb:refresh` and `kb:gaps` are `@dialogwright/kb-author`'s own command, `dialogwright-kb`. In this repository the root's `pnpm` scripts run the same entry; in a project of its own they are `npx dialogwright <command>`.
- A project of its own, outside this repository: `npm create dialogwright@latest <name>` (`packages/create-dialogwright`, once published; until then, a project of its own on the packed package: `pnpm -r build`, `pnpm pack --pack-destination <folder>` in `packages/dialogwright`, then `pnpm create-app <name> --standalone --dir <a folder outside this repository> --dialogwright file:<the packed .tgz>` (`pnpm adopt:test --keep` makes two such projects and leaves them)) writes the scaffold's app as a project on the `dialogwright` package, with the guide and the slot pages in `node_modules/dialogwright/docs/` and the create-app skill copied into `.claude/skills/create-app/`.
- The build: `pnpm -r build` writes each package's `dist/` (JavaScript and declarations) for a project that installs it; nothing in this repository needs it. `pnpm adopt:test` packs the four packages, makes a project of its own from the packed `create-dialogwright` outside the repository, and runs its check, type check, tests, regression and adversarial suite, its read-back commands and a start of its server. Publishing is the maintainer's step: [RELEASING.md](../RELEASING.md).

### An app is a folder

- An app folder: YAML for what is data (app, intents, forms, prompts, policy, identity, routes, slots, locales, the knowledge base) and TypeScript for what runs (tools, form hooks, the start hook, named predicates, rules of its own, and any slot no library type fits), joined by `defineApp`. [The guide's sections 1 and 2](guide/01-the-folder.md).
- `pnpm check` reads each app folder's YAML against its schemas and cross-checks it against the app's code, printing each problem as `file:line:column  path  message  ->  fix` ([section 7](guide/07-checking-an-app-pnpm-check.md)).
- `packages/dialogwright/schemas`: the JSON Schema of each YAML file in an app folder, generated from the zod schemas; every file names its schema on its first line, so an editor completes and checks it ([section 10](guide/10-editor-support.md)).
- `pnpm create-app <name>` (`--identity` for an app that verifies callers): a small app under `apps/<name>` that passes the check, its tests, its stub regression and its adversarial suite as created, with a `README.md` and a `CLAUDE.md` of its own. Its templates are `packages/dialogwright/templates/`.

### Policy and identity

Policy as a file compliance can read: `policy.yaml` (named rules per action: `identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf`, `noneOf`, `callerNumber`, and rules of your own written with `defineRule`) and `identity.yaml` (the ladder of levels, the one-time code, a caller-ID match, sign-in, delegates and their roles). A policy is tested against its file (invariants, and `policy.matrix`, a reviewed golden of what the gate decides), `pnpm policy:card` writes it in plain English with diagrams for a reviewer (`POLICY.md`), `pnpm app:diagram` draws the app's structure (`APP-MAP.md`), and `CODEOWNERS` makes a change need compliance's approval. [The guide's section 3](guide/03-policy-and-identity.md).

### The flow's building blocks

What a classic IVR design does, each step a declarative block with a default that keeps the behaviour from before it ([the design](designs/2026-10-08-flow-building-blocks.md)):

- **Checks** that rule a caller out before the details are collected, and a read-back of a deciding answer first (forms.yaml `checks`, a slot's `confirm`) ([section 2, forms.yaml](guide/02-the-files-one-by-one.md#checks-ending-a-form-part-way)).
- **A priority intent** that must never wait (an emergency), and corrects the open form ([section 2, intents.yaml](guide/02-the-files-one-by-one.md#must-never-wait-priority)).
- **Sub-forms and listening**: `next:` and internal forms, and where a slot listens (`listen`, `listenBeforeEntered`) ([section 2](guide/02-the-files-one-by-one.md#a-form-that-goes-on-to-the-next-next-and-internal-forms), [section 5](guide/05-writing-a-slot.md#where-a-slot-listens-listen)).
- **The number calling**: a callback number offered, a call-start lookup, values proposed from it, a caller-ID match as the identifier, a text offer and consent to text for the whole call ([section 2, app.yaml](guide/02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber), [section 5](guide/05-writing-a-slot.md#a-text-offer-onno-and-ifnone), [section 13.13](guide/13-channels.md#1313-the-number-the-caller-is-calling-from)).
- **Retries per slot**: `attempts`, a retry line per attempt, and `onMaxAttempts` (a person, skip, another form, end the call, or go on to "anything else?") on any slot ([section 5](guide/05-writing-a-slot.md#when-a-slot-runs-out-attempts-and-onmaxattempts)).
- **The call's data**: `callData` from the carrier's parameters and the chat page, each key with how it is recorded ([section 13.14](guide/13-channels.md#1314-the-data-a-call-or-chat-comes-with-calldata)).
- **Transfers**: where a handoff goes, chosen by ordered rules (a reason, a form, the call's data, hours, a fact), with data sent as SIP headers or on the chat's transfer message ([section 13.15](guide/13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)).
- **Routes**: `routes.yaml` decides at call start, after identity and after a form (say a line, go on, enter a form, hand off, end, switch language), on business hours (app.yaml `hours`), the call's data, the number called, a fact the start hook (`onStart`) wrote, a slot, the caller's level or a named predicate in code ([section 2, routes.yaml](guide/02-the-files-one-by-one.md#routesyaml-optional), [section 6](guide/06-the-form-hooks.md#the-start-hook-predicates-and-failsoft)).

### Slots

[docs/slots](slots/README.md): the slot types. Most slots are configuration: an app names a type (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`, `topic`) in its `slots.yaml` with a few options, and the engine asks the model the right questions and checks the answers. One page per type, generated from its options; [section 5 of the guide](guide/05-writing-a-slot.md) has the rest, and CONTRIBUTING.md has "Adding a slot type".

### The knowledge base

General questions ("when are you open", "what is the late fee") are answered from short passages that people approved, chosen by meaning and spoken word for word, never generated. An app's `kb/` folder holds the topics, the passages and the documents they are approved against; a `topic` slot lets the decision model pick among the few topics retrieval nominates, and the answer is read through the gate and said as written, with an optional line from the caller's own data. A passage whose source changes is withheld until a person approves it again. Retrieval is keywords plus a small embedding model that runs in-process with no key and gives the same numbers on every machine. [Section 12 of the guide](guide/12-the-knowledge-base.md).

`packages/kb-author` (`@dialogwright/kb-author`) builds one from documents: point it at a folder of PDF, DOCX, HTML, Markdown and text files or at a website (to a link depth), and it extracts the text by section with where it came from (`pnpm kb:ingest`), has a model draft passages that must quote their source word for word (`kb:draft`, with your own key, never in CI), serves a review page on your machine where a person approves, edits or rejects each one (`kb:review`, and `kb:approve` at a terminal), reads the sources again to withhold what changed (`kb:refresh`), and ranks what callers asked that nothing answered (`kb:gaps`). [Its README](../packages/kb-author/README.md).

### Channels, and the widget

The same app answers on the phone through Twilio, Telnyx or both (`VOICE_PROVIDERS`; each carrier is a plug-in behind one interface, proven by a conformance kit against the carrier's documented frames), in the caller's language end to end, and on the web through the engine's own chat endpoint (`CHAT=on`), with sign-in by the site's own identity token. Every choice is an option with a default: [section 13 of the guide](guide/13-channels.md). What only a real call can confirm is [live-checks.md](live-checks.md).

`packages/widget` (`@dialogwright/widget`): the web chat widget a site embeds with one script tag: a few kilobytes, no runtime dependencies and none of the engine, themed with CSS custom properties, every word replaceable, with reconnect and resume built in; `createChatClient` is the same client for a site with its own interface. [Its README](../packages/widget/README.md).

### Running it on a machine you own

`pnpm configure` writes an app's settings with two keys (or none, to try it), `pnpm start` runs the server behind a Cloudflare quick tunnel that needs no account, and `pnpm diagnose` says what is misconfigured. On a machine that stays on, `pnpm service` writes a launchd or systemd service, the server drains before it stops and says when it is ready, `SESSION_STORE=file:<dir>` saves each call so a restart resumes it instead of dropping it, a write tool marked `idempotent` is never done twice, `pnpm fallback` writes what the carrier plays when the server is down, retention keeps the disk in check, and `CONSOLE_AUTH=token` lets the owner sign in to the console from a phone, every look recorded in the audit. Every piece is an option whose default is the behaviour from before, and the session stores sit behind interfaces with a contract suite, so a store many servers share is a drop-in: `SESSION_STORE=postgres://...` runs several servers on one database, a call held by one at a time and taken over by another when its server dies or drains (Phase 8b, its first part). [Section 14 of the guide](guide/14-running-it.md), and the website's guides: [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html) and [scaling out](https://dialogwright.com/guides/scaling.html) (Phase 8b, being built).

### Testing an app

- **The corpus and the scripted calls**: each app's `fixtures/corpus.jsonl` (labelled lines, which the stub decision model answers from) and `fixtures/scenarios/*.json` (whole calls, each with the outcome it expects), replayed by `regress` against a committed baseline that is never regenerated to make a test pass. [The guide's fixtures/](guide/02-the-files-one-by-one.md#fixtures-optional) and the skill's [corpus guide](../.claude/skills/create-app/corpus.md).
- **A recording**: `regress --client record` records the real decision model's answers once, with the owner's key, into a cassette that `regress --client recorded` replays offline, in CI too. [After a recorded run](guide/11-walkthroughs.md#after-a-recorded-run), and the skill's [triage](../.claude/skills/create-app/triage.md); the readings a recording tolerates are [known-gaps.md](known-gaps.md).
- **The adversarial suite**: generated from each app (announced injections, relationships claimed and not proven, off-scope requests, codes said aloud or never sent, hostile replies from every tool and downstream service), each case held to properties over its run, never to lines. app.yaml's `testing: { adversarial: on }` runs it with `regress`; a new app has it on. [Section 15 of the guide](guide/15-the-adversarial-suite.md).
- **The policy's tests**: the invariants, the matrix golden and each custom rule's examples ([section 3.10](guide/03-policy-and-identity.md#310-testing-the-policy)).

### The example apps

- [apps/clinic](../apps/clinic/README.md): Example Family Practice, a fictional clinic's appointment line, and the first example app to read. A caller can schedule, reschedule, cancel or confirm an appointment with one of eight providers, or be put through to billing. It shows an app with no identity verification, all five of its slots configured in `slots.yaml` from the slot library, reads and gated writes through the directory tools, scheduling built from generic form hooks, and its own corpus (249 labelled lines), scripted calls (90) and regression baseline. It needs no keys: `pnpm --filter @dialogwright/example-clinic cli --client heuristic` is a text console, and `pnpm --filter @dialogwright/example-clinic regress` replays its fixtures.
- [apps/utility](../apps/utility/README.md): Example Power & Light, a fictional electric utility's phone and chat line, built by an AI coding assistant from a one-paragraph description, and the example to read for identity and policy. Callers can report an outage (confirmed before it is filed), hear a balance behind verification, and set up a payment arrangement behind a one-time code, with bounds on the first payment and the total; a property manager may check balances and report outages for their buildings, but an arrangement for a tenant's account goes to a person. It has a knowledge base, its own policy card, policy matrix, app map, corpus, scripted calls and stub regression baseline, and a recording against the decision model that CI replays offline (`--client recorded`).
- The engine's own small apps, under `packages/dialogwright/src/testing/` (the testkit, Example Parcels, with the full identity ladder and delegates; and the fixtures for checks, callbacks, texting, proposals, caller-ID matches and routes) and `packages/dialogwright/src/define/fixture/` (Example Town Library, the smallest complete app, which most of the guide's snippets come from). CLAUDE.md's Layout lists each.

### The website

`site/`: the website at [dialogwright.com](https://dialogwright.com), static pages published to GitHub Pages by `.github/workflows/pages.yml`: the landing page and two guides, [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html) (try it with no accounts, then a phone line with a carrier, a model key and a tunnel, kept running by launchd or systemd) and [scaling out](https://dialogwright.com/guides/scaling.html) (what one machine already has, and the design for many servers). A test checks every page's links against the repository.

### Design, history and contributing

- [design.md](design.md): the design: the idea, the roles, how policy and identity work, the knowledge base, testing, channels, and the roadmap (section 12).
- [designs/](designs/README.md): the design documents for engine features, each with the problem, the options and the decision; the guide is the reference for how a feature works today.
- [trials/](trials/README.md): fresh assistants building apps from a paragraph with the create-app skill, with their logs and what each stumble changed.
- [live-checks.md](live-checks.md): what only real carrier, model and identity accounts can confirm, as a checklist for the maintainer.
- [known-gaps.md](known-gaps.md): what a known gap in a corpus is, and how a recording tolerates one.
- [CONTRIBUTING.md](../CONTRIBUTING.md): rules, pull requests, and adding a slot type, a built-in policy rule, a retriever or an embedder, an extraction format, a voice provider and a session store. [SECURITY.md](../SECURITY.md) says how to report a vulnerability, [CLA.md](CLA.md) is the contributor agreement, and [RELEASING.md](../RELEASING.md) is the maintainer's release.

## Commands

In this repository, at its root (requires Node 22.19 or later and pnpm). In a project of its own, a root command `pnpm <command>` is `npx dialogwright <command>` (the authoring commands `kb:ingest`, `kb:draft`, `kb:review`, `kb:refresh` and `kb:gaps` are `npx dialogwright-kb <command>`, with `@dialogwright/kb-author` installed), and an app's own script is `npm run <script>`; `pnpm verify`, `pnpm -r build` and `pnpm adopt:test` are this repository's only.

```sh
pnpm install
pnpm verify                                  # type check and tests
pnpm check                                   # every app folder under apps/
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
pnpm --filter dialogwright slot-docs         # regenerate the slot type pages
pnpm policy:card apps/clinic                 # write the policy card, POLICY.md (also: policy:matrix, app:diagram)
pnpm create-app <name>                       # a new app under apps/<name> that passes the checks (--identity for one that verifies callers)
pnpm -r build                                # each package's dist/ (not needed to develop here)
pnpm adopt:test                              # the packages packed, and a project of its own outside the repository, all green
pnpm kb:ingest docs/ --dir apps/<name>       # a knowledge base from documents: sources (also a website: a URL and --depth)
pnpm kb:draft apps/<name>                    # draft passages with your own ANTHROPIC_API_KEY (in .env, never in CI); nothing drafted is said
pnpm kb:review apps/<name>                   # the review page on this machine: a person approves each passage (also: kb:approve, kb:status)
pnpm kb:index apps/<name>                    # the topics' vectors, when kb.yaml names an embedder (also: kb:model, kb:bakeoff, kb:refresh, kb:gaps)
pnpm audit:verify apps/<name>/audit          # check each audit day file's hash chain; exits 1 at the first break
pnpm diagnose --app <name>                   # what is misconfigured in an app's .env, one line per check with its fix (--offline: no requests)
ENV_FILE=<path> pnpm service launchd --app <name>   # a launchd agent (or systemd unit) that keeps it running; prints the install commands
```

- `pnpm check`: check every app folder under `apps/`: YAML against the schemas, cross-references to the code, prompts in every locale, the corpus. Prints one line per problem, `file:line:column  path  message  ->  fix`, and exits 1 on any. Act on the fix text.
- `pnpm create-app <name> [--identity] [--dir <path>] [--display <text>]`: a new app under `apps/<name>` from the template, linked into the workspace (`--standalone`: a project of its own, outside this repository).
- `pnpm verify`: the type check and the tests together.
- `pnpm --filter dialogwright regress:testkit` and `pnpm --filter @dialogwright/example-clinic regress`: the regressions (`--scenario <id>`, `--corpus <id>` and `--adversarial <id>` follow one turn by turn). Never regenerate a baseline or snapshot to make a test pass; a changed output is a finding to explain.
- `pnpm --filter dialogwright schemas`: regenerate the JSON Schemas after a schema change.
- `pnpm policy:matrix [dir...]`, `pnpm policy:card [dir...]`, `pnpm app:diagram [dir...]`: write `policy.matrix` (what the gate decides, for every action and kind of caller), `POLICY.md` (the policy in plain English with diagrams) and `APP-MAP.md` (intents, forms, slots, actions, rules and routes as diagrams). Deliberate: tests compare each with what the app generates, so a policy change is a diff to review; CI never writes them.
- `pnpm --filter dialogwright exec tsx src/define/cli.ts policy:convert <absolute folder>`: convert a policy.yaml or identity.yaml in the old table shape to the current one.
- `pnpm --filter dialogwright slot-docs`: regenerate the slot type pages after a type's options, README or examples change. `pnpm --filter dialogwright test slots/<type>`: a slot type's tests, including the conformance kit.
- `pnpm kb:ingest <folder | file | url> --dir <app folder> [--depth N]`: documents or a website into `kb/sources/<doc>.yaml`, by section with provenance. `pnpm kb:draft [app folder]`: draft passages into `kb/pending` with a model (`ANTHROPIC_API_KEY`, the author's own, from the environment or `.env`; refuses in CI; every draft must quote its source section word for word; nothing pending is ever said). `pnpm kb:review [app folder]`: the review page on 127.0.0.1 with a one-time token, where a person approves, edits or rejects. `pnpm kb:approve <id...> --by "<name>"` and `pnpm kb:status [dir]`: approve a passage or draft (only a person does), and list passages by state. `pnpm kb:refresh [app folder]`: read the sources again and withhold what changed. `pnpm kb:gaps [app folder] [--traces <path>]`: what callers asked that nothing answered, ranked. `pnpm kb:model`, `pnpm kb:index [dir]`, `pnpm kb:bakeoff <dir> --paraphrases <file> [--sweep]`: the embedding model, the committed index of topic vectors, and the retrieval bake-off with the floor and cap sweep.
- `pnpm --filter @dialogwright/example-clinic cli --client heuristic`: a text console for the clinic, with no keys.
- `pnpm --filter @dialogwright/example-utility serve` with `PUBLIC_HOST=localhost CHAT=on CHAT_ALLOWED_ORIGINS=http://localhost:3000 CHAT_SIGNIN=mock WIDGET=on` (after `pnpm --filter @dialogwright/widget build`): the web chat and the widget on a laptop, at `http://localhost:3000/chat-demo`.
- `pnpm configure [--app <name>]`, `pnpm start [--app <name>] [--tunnel quick|named|none]`, `pnpm diagnose [--app <name>] [--offline]`: the first hour on a machine you own: settings written with two keys (or none, to try it; a key is never a flag), the server behind a quick tunnel, and what is misconfigured. A settings file kept elsewhere is named with `ENV_FILE=<path>` in front. `ENV_FILE=<path> pnpm service <launchd|systemd> --app <name>`: a service file that keeps it running. `pnpm fallback --provider <twilio|telnyx> --number <E.164> --out <file>`: what the carrier plays when the server is down. `pnpm console:link`: a one-time console sign-in link (with `CONSOLE_AUTH=token`). `pnpm audit:verify <audit folder | postgres://...>`: each audit day's hash chain, or the audit in Postgres.
- `pnpm --filter @dialogwright/widget build`: the widget's script, `packages/widget/dist/dialogwright-widget.js` (and `.mjs`), for a site to load from its own CDN.
- The real decision model (`--client jev`, `--client record`, `JEV_CLIENT=jev`) needs a key: TypeSafe (`TYPESAFE_API_KEY`, the default), OpenRouter or the Vercel AI Gateway (`JEV_PROVIDER=openrouter|vercel`), or a compatible endpoint (`JEV_PROVIDER=custom`, `JEV_BASE_URL`, `JEV_MODEL`, optional `JEV_API_KEY`; its probabilities are not Jev's, so measure thresholds with its own cassette). Each model records its own cassette. An app's `.env.example` lists the variables; never commit a key.

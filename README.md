<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/dialogwright-logo-dark.svg">
    <img src="assets/brand/dialogwright-logo.svg" alt="DialogWright" width="420">
  </picture>
</p>

<p align="center"><a href="https://dialogwright.com">dialogwright.com</a></p>

**Nobody calls an IVR to chat.** People call to pay a bill, report an outage or move an appointment, and they judge your IVR or chatbot by one thing: whether it understood them. Large language models finally made real understanding possible, and generation came bundled with it. DialogWright unbundles them: understanding is always on, and what the agent says and does is predictable. Your agent does not need to talk about everything. It needs to understand its own domain thoroughly and act on it safely. The intelligence is in the understanding.

DialogWright is an open-source TypeScript framework for voice and chat agents that understand people and act safely. Callers talk naturally, and the system maps what they mean to the right action: a fast decision model reads what was said and answers typed questions (judgments, never generated text), so understanding is flexible. What the agent says and does is predictable: the lines are written and approved, deterministic code decides what happens next, and every action goes through a policy gate that enforces identity levels, scope, confirmation and attempt limits, with every decision recorded in a hash-chained audit log. Replies are fast, because a decision is a short typed question and not a composed answer. Generated wording, for the prompts where you want it, is planned as an opt-in ([design §5](docs/design.md#5-generated-wording)). An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales, the knowledge base) and TypeScript for what runs (slots, tools, hooks, custom rules), joined by `defineApp`, so the same engine can run a clinic, a utility company or anything else.

## Status

Pre-release. APIs will change, and the packages are not yet published to npm.

The package ships TypeScript source (run it with tsx or vitest) until a release adds a build.

## What's here

- `packages/dialogwright`: the engine. Its testkit is the engine's own test fixture, not a starting point for an app. An app imports only from `'dialogwright'`, the package's supported API (`src/index.ts`, grouped and documented there), and from `'dialogwright/testing'` (for its tests) and `'dialogwright/slot-kit'` (to write a slot type); the per-file subpaths (`dialogwright/core/...`) are internals that may change between versions.
- [docs/authoring-an-app.md](docs/authoring-an-app.md): how to build an app, for a developer or an AI coding assistant: the folder, each file with an example (including `slots.yaml`), policy and identity in full, what stays in TypeScript, how to write a slot, `pnpm check` and its messages, locales, configuration hashes, the knowledge base, and the channels (carriers, languages on the phone, web chat, sign-in, the widget).
- Policy as a file compliance can read: `policy.yaml` (named rules per action: `identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, and rules of your own) and `identity.yaml` (the ladder of levels, the one-time code, delegates and their roles). A policy is tested against its file (invariants, and `policy.matrix`, a reviewed golden of what the gate decides), and `pnpm policy:card` writes it in plain English, with diagrams, for a reviewer; `pnpm app:diagram` draws the app's structure; `CODEOWNERS` makes a change need compliance's approval.
- The knowledge base: general questions ("when are you open", "what is the late fee") are answered from short passages that people approved, chosen by meaning and spoken word for word, never generated. An app's `kb/` folder holds the topics, the passages and the documents they are approved against; a `topic` slot lets the decision model pick among the few topics retrieval nominates, and the answer is read through the gate and said as written, with an optional line from the caller's own data. A passage whose source changes is withheld until a person approves it again. Retrieval is keywords plus a small embedding model that runs in-process with no key and gives the same numbers on every machine. See [the guide's section 12](docs/authoring-an-app.md#12-the-knowledge-base).
- `packages/kb-author`: `@dialogwright/kb-author`, the authoring tool for a knowledge base: point it at a folder of PDF, DOCX, HTML, Markdown and text files or at a website (to a link depth), and it extracts the text by section with where it came from (`pnpm kb:ingest`), has a model draft passages that must quote their source word for word (`kb:draft`, with your own key, never in CI), serves a review page on your machine where a person approves, edits or rejects each one (`kb:review`), reads the sources again to withhold what changed (`kb:refresh`), and ranks what callers asked that nothing answered (`kb:gaps`). See [its README](packages/kb-author/README.md).
- Channels: the same app answers on the phone through Twilio, Telnyx or both (`VOICE_PROVIDERS`; each carrier is a plug-in behind one interface, proven by a conformance kit against the carrier's documented frames), in the caller's language end to end (a number per language, a voice and recognizer per carrier and language, an intent that switches language mid-call), and on the web through the engine's own chat endpoint (`CHAT=on`), with sign-in by the site's own identity token. Every choice is an option with a default: see [the guide's section 13](docs/authoring-an-app.md#13-channels). What only a real call can confirm is [docs/live-checks.md](docs/live-checks.md).
- `packages/widget`: `@dialogwright/widget`, the web chat widget a site embeds with one script tag: a few kilobytes, no runtime dependencies and none of the engine, themed with CSS custom properties, every word replaceable, with reconnect and resume built in; `createChatClient` is the same client for a site with its own interface. See [its README](packages/widget/README.md).
- [docs/slots](docs/slots/README.md): the slot types. Most slots are configuration: an app names a type (`digits`, `choice`, `date`, `birthdate`, `name`, `record`, `text`, `topic`) in its `slots.yaml` with a few options, and the engine asks the model the right questions and checks the answers. One page per type, generated from its options.
- [llms.txt](llms.txt): an index of these docs for AI assistants.
- `packages/dialogwright/schemas`: the JSON Schema of each YAML file in an app folder; every file names its schema on its first line, so an editor completes and checks it.
- `apps/clinic`: Example Family Practice, a fictional clinic's appointment line, an app folder, and the first example app to read. A caller can schedule, reschedule, cancel or confirm an appointment with one of eight providers, or be put through to billing. It shows an app with no identity verification, all five of its slots configured in `slots.yaml` from the slot library, reads and gated writes through the directory tools, scheduling built from generic form hooks, and its own corpus (241 labelled utterances), scripted calls (89) and regression baseline. It needs no keys: `pnpm --filter @dialogwright/example-clinic cli --client heuristic` is a text console, and `pnpm --filter @dialogwright/example-clinic regress` replays its fixtures. See [apps/clinic/README.md](apps/clinic/README.md).
- `apps/utility`: Example Power & Light, a fictional electric utility's phone and chat line, built by an AI coding assistant from a one-paragraph description, and the example to read for identity and policy. Callers can report an outage (confirmed before it is filed), hear a balance behind verification, and set up a payment arrangement behind a one-time code, with bounds on the first payment and the total; a property manager may check balances and report outages for their buildings, but an arrangement for a tenant's account goes to a person. It has its own policy card, policy matrix, app map, corpus (133 labelled utterances), scripted calls (41) and stub regression baseline. It has no recording against a decision model yet, so only its stub regression runs. See [apps/utility/README.md](apps/utility/README.md).
- [`pnpm create-app`](docs/authoring-an-app.md#where-to-start) and the [create-app skill](.claude/skills/create-app/SKILL.md): the scaffold writes a small app that passes the checks as created, and the skill is the procedure an AI coding assistant follows to turn a paragraph into an app. The [trials](docs/trials/README.md) tried it with two fresh assistants and say what they found.
- `site/`: the website at [dialogwright.com](https://dialogwright.com), static pages published to GitHub Pages by `.github/workflows/pages.yml`: the landing page and two guides, [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html) (try it with no accounts, then a phone line with a carrier, a model key and a tunnel, kept running by launchd or systemd) and [scaling out](https://dialogwright.com/guides/scaling.html) (the design for many servers, Phase 8, not built yet). A test checks every page's links against the repository.

## Quick start

```sh
pnpm install
pnpm verify                                  # type check and tests
pnpm check                                   # every app folder under apps/
pnpm --filter dialogwright regress:testkit
pnpm --filter @dialogwright/example-clinic regress
pnpm --filter dialogwright slot-docs         # regenerate the slot type pages
pnpm policy:card apps/clinic                 # write the policy card, POLICY.md (also: policy:matrix, app:diagram)
pnpm create-app <name>                       # a new app under apps/<name> that passes the checks (--identity for one that verifies callers)
pnpm kb:ingest docs/ --dir apps/<name>       # a knowledge base from documents: sources (also a website: a URL and --depth)
pnpm kb:draft apps/<name>                    # draft passages with your own ANTHROPIC_API_KEY (in .env, never in CI); nothing drafted is said
pnpm kb:review apps/<name>                   # the review page on this machine: a person approves each passage (also: kb:approve, kb:status)
pnpm kb:index apps/<name>                    # the topics' vectors, when kb.yaml names an embedder (also: kb:model, kb:bakeoff, kb:refresh, kb:gaps)
pnpm audit:verify apps/<name>/audit         # check each audit day file's hash chain; exits 1 at the first break
pnpm diagnose --app <name>                   # what is misconfigured in an app's .env, one line per check with its fix (--offline: no requests)
ENV_FILE=<path> pnpm service launchd --app <name>   # a launchd agent (or systemd unit) that keeps it running; prints the install commands
```

`pnpm check` reads each app folder's YAML against its schemas and cross-checks it against the app's code, printing each problem with its file, line and fix; it prints `apps/clinic: ok` when there are none. To try an app with no keys, run the clinic's text console: `pnpm --filter @dialogwright/example-clinic cli --client heuristic`. To talk to the real decision model, Jev, you need a key from TypeSafe, OpenRouter or the Vercel AI Gateway, or a compatible endpoint (`JEV_PROVIDER`; each app's `.env.example` lists the options). To build your own, run `pnpm create-app <name>` and read [docs/authoring-an-app.md](docs/authoring-an-app.md), or give an AI coding assistant a paragraph describing the app and point it at the [create-app skill](.claude/skills/create-app/SKILL.md). A slot is a few lines in `slots.yaml`, for example `account: { type: digits, noun: account, length: 8, keypad: true }`; the [slot types](docs/slots/README.md) say which type to use and what each option does.

Requires Node 22.19 or later and pnpm.

### Answer a real phone call in an hour

On your own laptop, with two keys: a carrier's (Telnyx or Twilio, with a number) and a decision model's (TypeSafe, OpenRouter or the Vercel AI Gateway; or none, with a compatible model on your own machine). Nothing else needs an account: the tunnel the carrier reaches you through is Cloudflare's quick tunnel, which needs only `cloudflared` installed (`brew install cloudflared` on a Mac).

```sh
pnpm install
pnpm configure      # asks which app, how to try it, the carrier and its key, the model and its key, and the number for a person; writes apps/<app>/.env
pnpm start          # opens a quick tunnel, starts the server with that .env, and prints the webhook URL to paste into your number
pnpm diagnose       # while it runs (pnpm start prints the line, with the tunnel's hostname): reachable, the console private, the keys the right shape, the clock right
```

`pnpm configure` reads a key with the echo off and writes it only to `apps/<app>/.env`, readable by you alone (mode 600) and git-ignored; it prints a key's length, never the key, and sends it nowhere. It says where to paste the webhook in the carrier's console. To try it first with no keys at all, choose "on this computer": the web chat and the console on `localhost`. A quick tunnel's address changes every run; for one that stays, and for a machine that keeps the line up (it starts at boot, drains live calls before it stops, keeps its disk in check), see [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html). The commands are `pnpm configure`, not `pnpm setup`, and `pnpm diagnose`, not `pnpm doctor`: those two names are pnpm's own commands. A settings file kept elsewhere is named with `ENV_FILE=<path>` in front of `pnpm start`, `pnpm diagnose` or `pnpm service`; `--env-file <path>` works too where pnpm passes it on, but some pnpm builds read a `--env-file` themselves, and fail on a relative path before the command starts, so `ENV_FILE=` is the form to use.

## Design and guides

- [docs/authoring-an-app.md](docs/authoring-an-app.md): build an app, including its policy and identity, its knowledge base (section 12) and its channels (section 13).
- [docs/slots/README.md](docs/slots/README.md): the slot types.
- [docs/design.md](docs/design.md): the design and the roadmap.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, including adding a slot type, a built-in policy rule, a retriever or an embedder, an extraction format, and a voice provider.
- [docs/live-checks.md](docs/live-checks.md): what only real carrier, model and identity accounts can confirm, as a checklist.
- [llms.txt](llms.txt): an index for AI assistants.

## License

Apache-2.0; see [LICENSE](LICENSE). The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](NOTICE).

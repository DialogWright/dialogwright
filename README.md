<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/dialogwright-logo-dark.svg">
    <img src="assets/brand/dialogwright-logo.svg" alt="DialogWright" width="420">
  </picture>
</p>

<p align="center"><a href="https://dialogwright.com">dialogwright.com</a></p>

**Nobody calls an IVR to chat.** People call to pay a bill, report an outage or move an appointment, and they judge your IVR or chatbot by one thing: whether it understood them. Large language models finally made real understanding possible, and generation came bundled with it. DialogWright unbundles them: understanding is flexible, and what the agent says and does is predictable. Your agent does not need to talk about everything. It needs to understand its own domain thoroughly and act on it safely.

DialogWright is an open-source TypeScript framework for voice and chat agents. A fast decision model reads what the caller said and answers typed questions (judgments, never generated text), so callers talk naturally. Every line the agent says is written and approved, deterministic code decides what happens next, and every action goes through a policy gate that enforces identity levels, scope, confirmation and attempt limits, with each decision recorded in a hash-chained audit log. Replies are fast, because a decision is a short typed question and not a composed answer. An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales, a knowledge base of approved answers) and TypeScript for what runs (tools, hooks, rules of its own), so the same engine runs a clinic's appointment line, a utility's outage line or yours.

## Try it, with no keys

You need git, Node 22.19 or later and pnpm 9 (`corepack enable` gives the version this repository pins). Nothing here needs an account or a key: a stub stands in for the decision model.

```sh
git clone https://github.com/DialogWright/dialogwright.git
cd dialogwright
pnpm install
pnpm --filter @dialogwright/example-clinic cli --client heuristic --today 2026-09-18
```

That is the text console of the example clinic, Example Family Practice (a fictional appointment line). Type what a caller would say ("I need to move my appointment", "cancel", "can I talk to someone") and it prints each question the model was asked, what came back, the gate's decision and the line the caller hears. `--client heuristic` answers from keywords, so it understands less than the real model; `--today` pins the day that "Tuesday" is read against. Then replay the clinic's scripted calls and labelled lines against their baseline:

```sh
pnpm --filter @dialogwright/example-clinic regress
```

It prints `no changes`, then a summary: the corpus, the scripted calls, and the adversarial suite (injections, off-scope requests, hostile replies from every tool; for an app with identity, unproven relationships and codes said aloud too), each case held to what must hold whatever the wording. A line `client errors 3 (first: injected timeout)` is the run testing its own handling of a model that times out, on purpose. [apps/clinic](apps/clinic/README.md) says what the app is made of; [apps/utility](apps/utility/README.md), a fictional electric utility built by an AI coding assistant from one paragraph, is the example of identity, a one-time code, delegates and a knowledge base.

## Build your own

**From a paragraph, with an AI coding assistant.** Describe your line in a paragraph (what callers can ask for, who must verify and how, what must be confirmed, what goes to a person) and give it to an assistant with the [create-app skill](.claude/skills/create-app/SKILL.md). The skill plans the app in a worksheet, scaffolds it, writes the YAML, the tool stubs, the corpus and the scripted calls, reads the policy back, and iterates until the checks, the tests and the regression are green. [Your first app](docs/first-app.md) walks through it with a paragraph to start from, a small home services company's line: what to give the assistant, what it asks and produces, how to run, record and call it, and how to change the paragraph for your own business.

**By hand, from the scaffold.** Either path writes a small app that passes its checks, tests and regression as created, with a `README.md` and a `CLAUDE.md` of its own:

- A project of your own, on the `dialogwright` package: `npm create dialogwright@latest <name>` (add `-- --identity` for an app that verifies callers). Its commands are `npx dialogwright <command>`, and the guide and the skill come with it (`node_modules/dialogwright/docs/`, `.claude/skills/create-app/`). The packages are not published yet: until they are, use the next path.
- In this repository: `pnpm create-app <name>` (add `--identity` for an app that verifies callers) writes `apps/<name>`. Its commands are `pnpm <command>` at the root.

Then replace the example with your own, reading the [authoring guide](docs/guide/README.md) a chapter at a time: the folder, each file with an example, policy and identity, slots, the check's messages, the knowledge base, the channels, running it and the adversarial suite. `pnpm check` (`npx dialogwright check` in a project) says what is wrong after each change, one line per problem with its fix.

## Answer a real phone call in an hour

On your own laptop, with two keys: a carrier's (Telnyx or Twilio, with a number) and a decision model's (TypeSafe, OpenRouter or the Vercel AI Gateway; or none, with a compatible model on your own machine). Nothing else needs an account: the carrier reaches you through Cloudflare's quick tunnel, which needs only `cloudflared` installed (`brew install cloudflared` on a Mac, or Cloudflare's package for Linux).

```sh
pnpm install
pnpm configure                           # which app, then a phone line: the carrier and its key, the model and its key, the number for a person
pnpm start --app <name> --tunnel quick   # opens the tunnel, starts the server with the app's .env, prints the webhook URL to paste into your number
pnpm diagnose --app <name>               # in another terminal, with the PUBLIC_HOST=... line pnpm start prints: checks it end to end
```

In a project of its own the same commands are `npx dialogwright configure`, `npx dialogwright start --tunnel quick` and `npx dialogwright diagnose`, with no `--app` (the project is its one app).

`configure` reads a key with the echo off (or from the environment variable of its own name, never a flag), writes it only to the app's `.env` (`apps/<name>/.env` here, the project's own in a project), readable by you alone and git-ignored, prints its length and never the key, and sends it nowhere. To try it first with no keys at all, choose "on this computer": the web chat and the console on `localhost`. The quick tunnel's address changes every run; for a line that stays up on a machine you own (a named tunnel, a service that starts at boot, calls that survive a restart, the console from your phone), follow [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html), and see [the guide's section 14](docs/guide/14-running-it.md) for every option. (The commands are `configure` and `diagnose` because `pnpm setup` and `pnpm doctor` are pnpm's own.)

## Status

Pre-release. APIs will change, and the packages are not yet published to npm.

The packages build (`pnpm -r build`: JavaScript and declarations in each package's `dist/`), and `pnpm adopt:test` packs them, makes a project of its own outside this repository from the packed `create-dialogwright`, and runs its checks, tests and regression; `pnpm multi:test` builds the container image (the root `Dockerfile`) and runs two servers of an app in `docker compose` behind a load balancer, killing and draining the one holding a call ([guide 14.14](docs/guide/14-running-it.md#1414-many-servers-on-one-database)); publishing is the maintainer's step ([RELEASING.md](RELEASING.md)). In this repository nothing needs a build: the packages are read from their TypeScript source. What is built and what is planned is the roadmap, [section 12 of the design](docs/design.md#12-roadmap).

## Documentation

- [docs/README.md](docs/README.md): everything in this repository, what each part is and where its documentation is, and every command.
- [Your first app](docs/first-app.md): a guided first app, from a paragraph, with an AI coding assistant.
- [The authoring guide](docs/guide/README.md): how to build an app, in chapters.
- [The slot types](docs/slots/README.md): one page per type, with every option.
- [The design](docs/design.md): the idea, the roles, how policy and identity work, testing, and the roadmap.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, including a slot type, a policy rule, a retriever, a voice provider and a session store.
- [llms.txt](llms.txt): an index of these docs for AI assistants.

## License

Apache-2.0; see [LICENSE](LICENSE). The DialogWright name and logo are trademarks and are not covered by the license; see [NOTICE](NOTICE).

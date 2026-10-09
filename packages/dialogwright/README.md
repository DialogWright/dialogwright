# dialogwright

A TypeScript framework for voice and chat agents that understand people and act safely. A fast decision model reads what the caller said and answers typed questions; deterministic code owns the dialog and the forms; every action goes through a policy gate, and every decision is written to a hash-chained audit log. An app is a folder: YAML for what is data (intents, forms, prompts, policy, identity, locales, the knowledge base) and TypeScript for what runs (tools, form hooks, rules of its own), joined by `defineApp`.

Pre-release: APIs will change.

## A project of your own

```sh
npm create dialogwright@latest my-line
cd my-line
npm install
npx dialogwright check     # the folder against its schemas, its code, its prompts and its corpus
npm run typecheck
npm test
npm run regress            # the stub regression: "no changes"
```

The project is one app folder with its own `README.md` and `CLAUDE.md`, and the create-app skill in `.claude/skills/create-app/`, which an AI coding assistant follows to turn a paragraph describing your line into an app.

## What the package carries

- The entries an app imports: `'dialogwright'`, `'dialogwright/testing'` (its tests), `'dialogwright/slot-kit'` (a slot type of its own), `'dialogwright/policy'` (the gate and the policy's compilers), and `'dialogwright/kb/onnx'` (an optional retriever).
- The `dialogwright` command: `check`, `create-app`, `regress`, `policy:matrix`, `policy:card`, `app:diagram`, `configure`, `start`, `diagnose`, `service`, `fallback`, `console:link`, `audit:verify` and the knowledge base's `kb:*`. `npx dialogwright help` lists them.
- The JSON Schemas of an app folder's YAML files (`node_modules/dialogwright/schemas`), which each file names on its first line so an editor completes and checks it.
- The authoring guide (`docs/guide/`, a chapter per section, with `docs/authoring-an-app.md`, the page it was, as a list of pointers to them), the first-app walkthrough (`docs/first-app.md`), the slot types' pages (`docs/slots/`) and the create-app skill (`skills/create-app/`).

The source, the example apps and the design are at [github.com/DialogWright/dialogwright](https://github.com/DialogWright/dialogwright). Requires Node 22.19 or later.

# Example Power & Light: notes for AI coding assistants

Example Power & Light is a DialogWright app: a voice and chat agent whose dialog and policy are YAML and whose tools and form hooks are TypeScript. Read the repository's root `CLAUDE.md` first for the rules, and [docs/authoring-an-app.md](../../docs/authoring-an-app.md) before changing the folder. It takes outage reports (anyone), reads balances (verified customers, and property managers for their buildings), sets up payment arrangements (customers with a one-time code; a property manager's request goes to a person) and answers general questions from approved passages of its knowledge base (`kb/`). `DESIGN.md` is its design worksheet: read it before changing the app, and keep it current.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the app says, hears and collects. Slots are library types named in `slots.yaml` (see `../../docs/slots/`); write a slot in code only when none fits.
- `policy.yaml`: what the agent may do, action by action (the level and the rules the gate runs before each). Every tool in `src/app.ts` needs an action, and an action not listed is refused. `policy.matrix` and `POLICY.md` are the policy read back, and `APP-MAP.md` the app's structure; rewrite them (`pnpm policy:matrix apps/utility`, `pnpm policy:card apps/utility`, `pnpm app:diagram apps/utility`) only for a change you meant, and read the diff. The tests fail when they and the app disagree.
- `identity.yaml`: how a caller proves who they are (the factors, the one-time code, the property manager delegates, the chat sign-in, the number of tries).
- `src/app.ts`: the tools and the form hooks, joined to the folder by `defineApp`. `src/data.ts`: the fixture accounts and property managers behind the stub tools.
- `kb/`: the knowledge base. `kb.yaml` (the resolving action and retrieval), `topics.yaml` (after a change, `pnpm kb:index apps/utility`), `sources/` (read from `docs-src/` by `pnpm kb:ingest`), `pending/` (drafts, never said) and `passages/` with `approvals.jsonl` (written only by a person's approval: `pnpm kb:review apps/utility` or `pnpm kb:approve --by "<a person>"`). Never write a passage's `approval` by hand, and never approve as anything but the person who reviewed it.
- `docs-src/`: the fictional documents the knowledge base is built from. A change there is a change to a source: run `pnpm kb:refresh apps/utility`, and the passages it withholds go back to review.
- `fixtures/`: `corpus.jsonl` (labelled utterances, every intent has some), `scenarios/` (scripted calls), `expected/` (the stub baseline) and `kb/paraphrases.yaml` (what retrieval is measured on).

## Commands

Run these at the repository root.

```sh
pnpm check                                                # the folder against its schemas, the code, the prompts and the corpus
pnpm --filter @dialogwright/example-utility typecheck
pnpm --filter @dialogwright/example-utility test
pnpm --filter @dialogwright/example-utility regress      # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-utility regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`. Act on the fix text.

## Before committing

Run `pnpm check`, then this app's typecheck, tests and `regress`, then the root checks (`pnpm verify` and the other apps' regressions). Never regenerate the baseline or a snapshot to make something pass: a changed output is a finding to explain. The one exception is this app's first baseline, made once with `regress --update` and reviewed in full. Never run `regress --client record`: recording calls a paid API and is for the owner of the app to do.

## Rules for this app

- Never put policy in tool code. Tools do the work; the gate decides, from `policy.yaml`, whether they may run.
- Never let a model write a regulated line. Every line a caller hears is in `prompts.yaml`, word for word.
- Fictional data only: invented names, the 555 phone range.
- `policy.yaml` and `identity.yaml` belong to compliance. Change them only when asked to, with the reason in the commit message, and expect review.

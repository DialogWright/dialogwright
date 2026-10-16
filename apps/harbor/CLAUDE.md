# Harbor Mutual: notes for AI coding assistants

Harbor Mutual is a DialogWright app: a voice and chat agent whose dialog and policy are YAML and whose tools and form hooks are TypeScript. Read the repository's root `CLAUDE.md` first for the rules, and the authoring guide, [docs/guide/](../../docs/guide/README.md), before changing the folder. It is a fictional accident insurer's member line and chat: members check on a claim, ask what their plan covers, and report a new claim; brokers check their clients' claims on the chat. [DESIGN.md](DESIGN.md) is its worksheet: the paragraph it was built from, every choice the paragraph left open, the gaps, and the notes on the create-app skill. Keep it current when the app changes.

## The folder

- `app.yaml`, `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`: what the app says, hears and collects. Slots are library types named in `slots.yaml` (see `../../docs/slots/`); write a slot in code only when none fits.
- `policy.yaml`: what the agent may do, action by action (the level and the rules the gate runs before each). Every tool in `src/app.ts` needs an action, and an action not listed is refused.
- `identity.yaml`: how a caller proves who they are (the member ID and date of birth, the one-time code, the number of tries), the brokers who act for members (two roles), and the chat sign-in.
- `kb/`: the knowledge base the coverage form answers from. The passages, sources and approvals were approved by people: never write an `approval`, a hash or a line of `kb/approvals.jsonl`, and never run `pnpm kb:approve` or the review page; a passage that goes stale is the owner's to approve again. After a change to a topic's title, keywords or example questions, run `pnpm kb:index apps/harbor` and commit the index; choose retrieval's cap and floor offline (`pnpm kb:bakeoff apps/harbor --paraphrases apps/harbor/fixtures/kb/paraphrases.yaml --sweep`).
- `policy.matrix`, `POLICY.md` and `APP-MAP.md`: the policy read back, generated from the folder and the code (what the gate decides for every action and every kind of caller, the policy in plain English, and the app as diagrams). They were read against the worksheet and the paragraph (DESIGN.md); `src/app.test.ts` fails when one differs from what the app generates.
- `src/app.ts`: the tools and the form hooks, joined to the folder by `defineApp`, the gate's lookups (`scopeOf`, `ownerOf`, `coverageWindow`), and `testing.policyMatrix`, the callers and members the matrix crosses. `src/data.ts`: the fixture members, claims, brokers and usage behind the stub tools. `src/intake.ts`: the stand-in for the claims intake service; its reply is held to the approved document codes by `triageClaim`'s `check`, and never repeated.
- `fixtures/`: `corpus.jsonl` (labelled utterances, every intent has some), `scenarios/` (scripted calls: the phone line, a member's chat, each broker role, injections), `expected/` (the stub baseline) and `kb/paraphrases.yaml` (what retrieval is measured on). A corpus line's `answers` field (`"answers":{"addressedToSystem":{"noul":0.15}}` on the side-speech line) sets the stub's answer to one of the engine's own questions; `noul` is a yes-or-no answer's probability of yes. See `.claude/skills/create-app/corpus.md`.

## Commands

Run these at the repository root.

```sh
pnpm check                                                # the folder against its schemas, the code, the prompts and the corpus
pnpm --filter @dialogwright/example-harbor typecheck
pnpm --filter @dialogwright/example-harbor test
pnpm --filter @dialogwright/example-harbor regress      # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-harbor regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
pnpm --filter @dialogwright/example-harbor regress --adversarial <id>  # one case of the adversarial suite, turn by turn
```

`pnpm check` prints one line per problem, `file:line:column  path  message  ->  fix`. Act on the fix text.

After a change to `policy.yaml`, `identity.yaml`, the forms or the tools, write the read back again and read each diff as a change in what the agent may do (the folder may be given by its path from the repository root):

```sh
pnpm policy:matrix apps/harbor
pnpm policy:card apps/harbor
pnpm app:diagram apps/harbor
```

## Before committing

Run `pnpm check`, then this app's typecheck, tests and `regress`, then the root checks (`pnpm verify` and the other apps' regressions). Never regenerate the baseline, a snapshot or a page of the read back to make something pass: a changed output is a finding to explain. This app's first baseline was made once with `regress --update` and reviewed in full; a later edit to it is made by hand and logged in DESIGN.md. Never run `regress --client record`: recording calls a paid API and is for the owner of the app to do.

## Rules for this app

- Never put policy in tool code. Tools do the work; the gate decides, from `policy.yaml`, whether they may run.
- Every line a caller hears is in `prompts.yaml`, said word for word unless the app asks for it to be generated (`mode: generative`, a form's `wording: generative`); a line marked `prescribed: true` never is. A summary of what the caller said is a framed line (`generate`): the line fixed, saying whose words follow, and only the summary a generated span. What is regulated is the owner's call; the policy card lists every generated and prescribed line.
- The regression runs the adversarial suite (app.yaml's `testing: { adversarial: on }`; keep it on). A `FAIL adversarial` case is a finding: fix the app (a tool's `check` of its reply, the policy, a hook), never the case, and never turn the suite off to pass.
- Every tool whose reply a line says, or a call is made from, checks the reply (`check`, written with `replyShape`): a downstream system's reply is not trusted.
- Fictional data only: invented names, the 555 phone range.
- `policy.yaml` and `identity.yaml` belong to compliance. Change them only when asked to, with the reason in the commit message, and expect review.

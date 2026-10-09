# 11. Walkthroughs

[Contents](README.md) · Previous: [10. Editor support](10-editor-support.md) · Next: [12. The knowledge base](12-the-knowledge-base.md)

Each walkthrough ends with `pnpm check`, which is the quickest way to find what is left to do.

### Add an intent that only says something

For "what are your hours", an informational intent with no form and no code:

1. `intents.yaml`: add `hours:` with `criteria`, `label`, `kind: informational` and `promptId: hours`.
2. `prompts.yaml`: add `hours:` with its `text` and `interruptible`. Add it to every `locale/<tag>/prompts.yaml` too.
3. Optionally, `menu:` in intents.yaml gets a key for it: the key plays the line, as asking does, and the menu is offered again.
4. If app.yaml names a fixtures directory, add labelled utterances to `corpus.jsonl` with `"intent":"hours"`.
5. `pnpm check`.

### Add a form

For a form that collects slots and acts, such as renewing a loan:

1. `intents.yaml`: add the intent with `kind: form`. Its id is the form's id.
2. `forms.yaml`: add the form with its `slots`, a `summaryPromptId` (or `null`) and `hooks: [complete]`. Add `confirmedParams` too if completing it is a confirmed write.
3. `prompts.yaml`: add `ask_<slot>` and `ask_<slot>_retry` for every new slot, the summary prompt, and the line the form says when it completes. Add them to each locale.
4. `slots.yaml`: for every new slot, add a key with a library `type` and its options ([section 5](05-writing-a-slot.md#5-writing-a-slot); [the type pages](../slots/README.md)). Only when no type fits, write a `SlotSpec` in `code.slots` in `app.ts` and add `<slot>: { type: code }` to slots.yaml. Add the lines the slot's type says it needs (`ask_<slot>_dtmf`, `ack_<slot>`, `disambiguate_<slot>`, its partial line) to prompts.yaml and each locale. In `app.ts`, add the form's hooks under `code.forms.<id>`: `complete` calls the tool and returns what to say.
5. If the form needs a tool, follow the next walkthrough.
6. `pnpm check`, then `pnpm verify`.

### Add a tool

1. `app.ts`: add the tool to `code.tools` with `run` and the `params` its calls carry. It does the work and returns `{ value, summary }`. Put no permission logic in it. Give it a `check` of its reply for every field a line says or a call is made from ([A tool's reply is not trusted](04-what-stays-in-typescript-and-why.md#a-tools-reply-is-not-trusted-check)).
2. `policy.yaml`: add an action under `actions` with a `say`, the `level` it needs and the `rules` the gate runs before it, in order ([section 3.3](03-policy-and-identity.md#33-the-built-in-rules)). Use `identity` for the level, `scope` for whose record it is, and `confirmed: [<the fields>]` for a write the caller must confirm. Declare under `audit` how each param that is not a slot with a redact setting is recorded.
3. If the tool is a confirmed write, give the form `confirmedParams`, and make the form's `complete` set `s.confirmedHash = s.pendingHash` before the call, as the library's `renew` does. If it writes at all, give it `idempotent: true` and pass `ctx.idempotencyKey` to the system it writes to ([14.13](14-running-it.md#1413-writes-that-are-never-done-twice)), so a write repeated after a crash is not done twice.
4. If the tool needs a rule of its own, write it with `defineRule` (with an example the gate allows and one it refuses) in `code.customRules`, and name its id with a `custom:` rule in the action.
5. Write the goldens a reviewer reads and read their diffs: `pnpm policy:matrix <folder>` (what the gate decides), `pnpm policy:card <folder>` (the policy in plain English) and `pnpm app:diagram <folder>` (the app map), then commit them with the policy ([section 3.10](03-policy-and-identity.md#310-testing-the-policy)).
6. `pnpm check` says if the tool and its action do not match: a tool with no action, an action with no tool, a rule that is never named.

### Answer a general question from the knowledge base

For "what is the late fee", an answer a person approved, said word for word ([section 12](12-the-knowledge-base.md#12-the-knowledge-base) has each file):

1. `kb/`: `kb.yaml` (the resolving `action`, and `applies` if the answer depends on the caller), `topics.yaml` (the topic with its keywords and example questions), `sources/<doc>.yaml` (the document's text, by hand or from `pnpm kb:ingest`), and `passages/<id>.yaml` (the answer, its source section and its dates).
2. `pnpm kb:approve <id> --by "<your name>"`, after you have read the passage against its source. Only a person approves.
3. `slots.yaml`: a slot of `type: topic`. `forms.yaml`: a form with that slot, `summaryPromptId: null` and `answers: { slot: <the slot> }`. `intents.yaml`: a `kind: form` intent for it.
4. `app.ts`: the resolving tool, `kbAnswerTool({ facts })`, with the facts read from your records. `policy.yaml`: its action, and `topic: keep` under `audit`. `prompts.yaml`: `ask_<slot>`, `ask_<slot>_retry`, `disambiguate_<slot>`, `kb_answer` (`'{answer}'`) and `kb_unavailable`, in every locale; `app.yaml`: `answer` in `prompts.dataVars`.
5. Paraphrases in `fixtures/kb/paraphrases.yaml` and a recall test ([12.11](12-the-knowledge-base.md#1211-testing)); corpus lines labelled with the topic question.
6. `pnpm kb:index` if `kb.yaml` names an embedder, then `pnpm check`, then `pnpm verify`.

### Follow one scripted call turn by turn

The stub regression (`pnpm --filter @dialogwright/example-<name> regress`) prints one line per difference from the baseline, a `FAIL scenario <id>: <field>: expected ..., got ...` line for each scripted call that does not reach what it expects, and `no changes` when there is neither, then a summary (`corpus 129/129 outcomes match expected`, `scenarios 34/34 pass expectation, 34/34 match expected`). A `FAIL` line names only the field that differed. To see how the call got there, ask for its transcript:

```sh
pnpm --filter @dialogwright/example-<name> regress --scenario plan-by-phone
pnpm --filter @dialogwright/example-<name> regress --corpus pl-02 --scenario plan-keypad   # repeatable; both together
```

Each step of the call, what the caller said or keyed, then for each turn: the prompt id, the acknowledgements said before it, the words the caller hears, the form, the caller's level and the slots that hold a value after the turn, and every gate decision (the tool, its purpose, the verdict, the reason and the rule that decided). Keyed digits run one turn each; only the keys that said something or asked the gate are shown. Then what the call expects, `pass` or `FAIL ...`, and `baseline: no changes` or the differences from the baseline. A corpus line shows the state it is seeded in (the form, the question it answers, the caller's level and the seeded slots), then its one turn. `--adversarial <id>` does the same for a case of the adversarial suite, with its properties' verdict ([15.4](15-the-adversarial-suite.md#154-reading-a-failure)). For example, the last step of the testkit's `track-other-customers-parcel` (`pnpm --filter dialogwright regress:testkit --scenario track-other-customers-parcel`):

```
  4. keys 123456
       (6 keys, one turn each; 5 said nothing and are not shown)
       -> prompt anything_else
          acks   otp_verified, parcel_blocked_scope
          says   "Thank you, you're verified. I don't see that parcel on your account, and I can only share your own parcels. Is there anything else I can help with?"
          form   -   level 2   slots accountId=55501234, dob=1985-04-12
          gate   verifyCode ALLOW
          gate   listParcels ALLOW
          gate   getParcel BLOCK reason=scope; scope The record belongs to someone this caller may see: record owner ...5678 · caller may see ...1234 only
```

It runs the same turns as the whole regression, with the same client (`--client recorded` works too), and exits 1 when a call misses its expectation or an outcome differs from the baseline. It writes nothing; `--update` cannot be given with it.

Note what the last line above shows: once a form completes, the form and its own slots are cleared (the slots app.yaml lists under `carrySlots` excepted; the identity factors, which no form lists, stay on the call). A scripted call that ends after a completion can expect `promptId: anything_else`, the `gate` and the completion line's words (`text`), never `form` or the form's `slots`.

### After a recorded run

A run against a model or its cassette (`--client record`, `recorded` or `jev`, and `cassette:trim`) reads the app's `.env` first, as `pnpm start` does (ENV_FILE names another file; a variable already in the environment wins; a stub run reads none). It ends with one more line, what needs a decision: `to triage: 3 untagged corpus differences, 1 failing scripted call, 0 passing scripted calls that differ from the baseline, 0 cassette misses`. `regress --client recorded --corpus <id>` adds, under the line's turn, every question the model was asked with its probabilities, and the screen's reading. `--json` with `--corpus <id>` (or `--scenario <id>`) prints only the outcome, in the baseline file's own shape: the lines between its braces paste into `fixtures/expected/corpus.json` (or `scenarios.json`) as an entry added by hand. `pnpm --filter <package> cassette:trim` rewrites the cassette with only the answers a whole replay asks for, and writes nothing if a request misses.

A borderline line the model reads one way in one recording and another way in the next can be tagged with a few outcomes instead of one: `"knownGap": {"reason": "...", "outcomes": [{"promptId": "ask_name"}, {"promptId": "anything_else"}]}`. Any one of them shown is allowed (`allowed: knownGap: <reason>`), anything else fails, and the baseline itself reads `knownGap now matches`. A tag has `outcome` or `outcomes`, never both ([known gaps](../known-gaps.md)).

### Where to start

To build an app from a description (a paragraph of what callers can ask for, who must verify, what is confirmed), follow the create-app skill, [.claude/skills/create-app/SKILL.md](../../.claude/skills/create-app/SKILL.md): it plans the app in a worksheet, maps it onto slot types, policy and identity, scaffolds it, and iterates on the checks until green. Its [options index](../../.claude/skills/create-app/options.md) (each option by the need it answers), [patterns](../../.claude/skills/create-app/patterns.md) and [corpus guide](../../.claude/skills/create-app/corpus.md) are useful on their own.

Run `pnpm create-app <name>` (add `--identity` when callers must verify who they are). It writes `apps/<name>` from the template in `packages/dialogwright/templates/`: the five YAML files, `slots.yaml`, `identity.yaml` with `--identity`, `src/app.ts` with one stub tool over fixture data, a corpus and three scripted calls, the launchers, its tests, the policy read back (`policy.matrix`, `POLICY.md` and `APP-MAP.md`, written for the example, with the golden tests that compare them), a README with the recording steps, a `.env.example` and a short `CLAUDE.md`. It runs `pnpm install` so the workspace links the new app (`--no-install` skips that), and the result passes `pnpm check`, its type check, its tests and its stub regression as created. Replace the one example intent, form, slot and tool with your own and add more as above, running `pnpm check` after each change. The scaffold ships the example's stub baseline (`fixtures/expected`); make your own app's first baseline once with `regress --update`, review it in full, and never regenerate it after that.

**A project of its own.** Outside this repository, an app is a project that depends on the `dialogwright` package. `npm create dialogwright@latest <name>` (the thin `create-dialogwright` package, once published) or, from this repository, `pnpm create-app <name> --standalone` (with `--identity`, `--display` and `--dir` as above) writes the same app folder as the scaffold, as the project's own folder: a `package.json` that depends on `dialogwright` (`^` the engine's version, or what `--dialogwright <spec>` names) with the package's commands as its scripts, a self-contained `tsconfig.json`, the YAML files naming `node_modules/dialogwright/schemas` on their first lines, the tests, the launchers (`npx dialogwright regress` runs the regression, so there is no `src/regress.ts`), a `.gitignore` with `.env`, the `.env.example`, a README, a `CLAUDE.md` that points at the installed package's guide (`node_modules/dialogwright/docs/authoring-an-app.md`), and the create-app skill copied into `.claude/skills/create-app/`. Then `npm install`, and `npx dialogwright check`, `npm run typecheck`, `npm test` and `npx dialogwright regress` pass as created. Every root command of this repository is a subcommand of the package's `dialogwright` command, run in the project's folder: `npx dialogwright <command>` where this guide says `pnpm <command>` (`npx dialogwright help` lists them), and the project's own scripts with `npm run <script>` where it says `pnpm --filter <package> <script>`. The project is its own one app, so `--app` is never needed there.

To start from an existing app instead, copy the library fixture's folder (or the clinic's) into `apps/<name>`, give it a `package.json` and the launchers the clinic has (`src/index.ts`, `cli.ts`, `regress.ts`), change `id`, empty the intents, forms, prompts and policy down to the control intents and the engine's lines, and run `pnpm check` until it says `ok`.

# Example Power & Light

The phone and chat line of a small, fictional electric utility, built with DialogWright by an AI coding assistant from a one-paragraph description (the paragraph and every design choice are in [DESIGN.md](DESIGN.md)). Every name, street, date and number in it is made up.

What a caller can do:

- **Report an outage** (`report_outage`): anyone, with no verification. The caller gives the address and says what they see (no power, part of the building, flickering, a line down); the line reads both back, and a yes files the report (a confirmed write, `reportOutage`).
- **Hear their balance and due date** (`check_balance`): the caller verifies with their account number and date of birth (level 1), by voice or keypad, and hears the balance on their own account (`readBalance`).
- **Set up a payment arrangement** (`set_up_plan`): the balance split into two, three, four or six payments. It needs a one-time code texted to the phone on the account (level 2), asked before the form's questions. The gate holds the total to what is owed (`limit` against the `amountDue` lookup) and the first payment to between today and thirty days on (`dateInRange` with `notBefore: today` and `notAfter: today+30`).
- **Ask for the outage map or the office hours**: fixed lines (`outage_map`, `office_hours`).
- **Ask for a person** at any time (`agent`): at the start, inside a form, while verifying, at the code prompt or at a summary, by voice or with 0 on the keypad menu.

On the keypad menu, 1 to 3 start the three tasks, 4 and 5 play the outage map and the office hours (and offer the menu again), and 0 is a person.

On the chat, a customer signs in through the portal instead of saying the factors (`signIn` at level 2). A **property manager** (delegate `property_manager`, role `manager`) signs in on the chat and may report outages and check the balances of the accounts they manage (the `scope` rule over `scopeOf`); a payment arrangement for a tenant's account goes to a person (`role: { manager: person }`), before any question is asked.

The policy, read back, is [policy.matrix](policy.matrix): what the gate decides for every action and every kind of caller.

## The folder

```
app.yaml        who the app is and how it presents itself
intents.yaml    what a caller can ask for, and the keypad menu
forms.yaml      each form's slots, its summary prompt and the hooks it has
prompts.yaml    every line a caller can hear
policy.yaml     what the agent may do, action by action: the level and the rules the gate runs before each
policy.matrix   the policy read back: the gate's verdict for every action and kind of caller (written by pnpm policy:matrix)
identity.yaml   how a caller proves who they are: the factors, the one-time code, the delegates, the chat sign-in
slots.yaml      every slot, in the order the engine works through them
src/app.ts      the code: the tools, the form hooks and the gate's lookups, joined to the folder by defineApp
src/data.ts     the fixture accounts and property managers behind the stub tools
fixtures/       the corpus, the scripted calls and the stub baseline
DESIGN.md       the design worksheet: the paragraph, every choice it left open, and the gaps
```

What is data is YAML, and what runs is TypeScript. Policy is never in a tool: the gate decides, from `policy.yaml`, whether a tool may run. The guide to every file is [docs/authoring-an-app.md](../../docs/authoring-an-app.md), and the slot types are in [docs/slots](../../docs/slots/README.md).

## Commands

Run these at the repository root.

```sh
pnpm check                                          # every app folder: YAML, schemas, cross-links to the code, prompts, corpus
pnpm --filter @dialogwright/example-utility typecheck
pnpm --filter @dialogwright/example-utility test
pnpm --filter @dialogwright/example-utility regress   # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-utility regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
pnpm --filter @dialogwright/example-utility cli --client heuristic   # a text console, with no keys
pnpm policy:matrix apps/utility                       # rewrite policy.matrix after a policy change you meant; read the diff
```

Nothing here needs an API key. The engine's stub clients stand in for the decision model, answering from the labels in `fixtures/corpus.jsonl`.

## The fixtures and the baseline

- `fixtures/corpus.jsonl`: one labelled utterance per line. Every intent needs examples (`pnpm check` says which are missing), including terse ones, and each line says what the stub model should answer for it.
- `fixtures/scenarios/core.json`: scripted calls, each with the outcome it expects. Every spoken step of a scripted call must also be in the corpus, so the stub can answer it.
- `fixtures/expected/`: the baseline, the stub's outcome for every corpus line and scripted call. The regression run compares against it and prints `no changes`.

The baseline that came with this folder is the example's. When your own app is built, make its first baseline once, with `regress --update`, and read the whole diff against what you expect. From then on, never regenerate it: a changed output is a finding to explain, not noise to overwrite.

## Recording against the real model

The stub answers from the corpus labels. A cassette holds the real decision model's answers, recorded once and replayed offline, so a run shows how a real model does on this app's calls. Recording calls the paid perception API, so it is a deliberate local step and never part of CI.

1. Copy `.env.example` to `.env` in this folder (it is git-ignored) and put your TypeSafe API key in it as `TYPESAFE_API_KEY`. The launchers do not read `.env` themselves, so load it into your shell: `set -a && source .env && set +a`.
2. At the repository root: `pnpm --filter @dialogwright/example-utility regress --client record --threshold JEV_TIMEOUT_MS=15000`. It appends each answer to `fixtures/recorded/<model>.jsonl` and aborts after three consecutive client errors. The diff against the stub baseline shows where the real model reads a line differently from its label; that is expected, and it never rewrites the baseline.
3. Check the replay offline, with the key unset: `pnpm --filter @dialogwright/example-utility regress --client recorded`. A line the model reads differently from its label stays the truth in the corpus and gets a `knownGap` with its reason (see "Known gaps" in the [clinic's README](../../apps/clinic/README.md)).
4. Commit the cassette. It holds only the corpus text and the model's answers to it.

A change to the words in the YAML (criteria, labels, prompts, the questions a slot sends) changes what the model is sent, so the replay reports each changed request as a cassette miss until the cassette is recorded again.

## Running it

`pnpm --filter @dialogwright/example-utility serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise.

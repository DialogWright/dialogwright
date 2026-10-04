# Example Power & Light

The phone and chat line of a small, fictional electric utility, built with DialogWright by an AI coding assistant from a one-paragraph description (the paragraph and every design choice are in [DESIGN.md](DESIGN.md)). Every name, street, date and number in it is made up.

What a caller can do:

- **Report an outage** (`report_outage`): anyone, with no verification. The caller gives the address and says what they see (no power, part of the building, flickering, a line down); the line reads both back, and a yes files the report (a confirmed write, `reportOutage`).
- **Hear their balance and due date** (`check_balance`): the caller verifies with their account number and date of birth (level 1), by voice or keypad, and hears the balance on their own account (`readBalance`).
- **Set up a payment arrangement** (`set_up_plan`): the balance split into two, three, four or six payments. It needs a one-time code texted to the phone on the account (level 2), asked before the form's questions. The gate holds the total to what is owed (`limit` against the `amountDue` lookup) and the first payment to between today and thirty days on (`dateInRange` with `notBefore: today` and `notAfter: today+30`).
- **Ask a general question** (`ask_question`): outage credits, ways to pay, budget billing, help with winter bills, disconnection and reconnection, starting or stopping service, rates, late charges, disputing a bill. The answer is a short passage a person approved against the utility's own documents, said word for word (see "The knowledge base" below). A verified customer who asks about outage credits also hears the last outage on record for their own account.
- **Ask for the outage map or the office hours** (`outage_map`, `office_hours`): two passages of the same knowledge base.
- **Ask for a person** at any time (`agent`): at the start, inside a form, while verifying, at the code prompt or at a summary, by voice or with 0 on the keypad menu.

On the keypad menu, 1 to 3 start the three tasks, 4 and 5 say the outage map and the office hours (and offer the menu again), and 0 is a person.

On the chat, a customer signs in through the portal instead of saying the factors (`signIn` at level 2). A **property manager** (delegate `property_manager`, role `manager`) signs in on the chat and may report outages and check the balances of the accounts they manage (the `scope` rule over `scopeOf`); a payment arrangement for a tenant's account goes to a person (`role: { manager: person }`), before any question is asked.

The policy, read back, is [POLICY.md](POLICY.md) (the policy card, in words), [policy.matrix](policy.matrix) (what the gate decides for every action and every kind of caller) and [APP-MAP.md](APP-MAP.md) (the app's structure). Each is generated, tested against the app, and written again only for a change you meant.

## How it was built

This app is the trial of the create-app skill ([.claude/skills/create-app](../../.claude/skills/create-app/SKILL.md)). An AI coding assistant with no other context was given the paragraph at the top of [DESIGN.md](DESIGN.md) and told to use the skill; it scaffolded the folder with `pnpm create-app utility --identity`, wrote the worksheet, the YAML, the stub tools, the corpus and the scripted calls, and had `pnpm check`, the type check, the tests and the stub regression green in about 15 minutes of wall clock. It logged every stumble as it went: [docs/trials/2026-10-03-utility.md](../../docs/trials/2026-10-03-utility.md) has each one with the fix it led to in the docs, the skill, the error messages or the framework. The app was then finished from that log: the thirty-day bound became a built-in `dateInRange`, the outage map and the hours went back on the keypad menu, the policy card and the app map were generated and read back against the paragraph, and the scripted calls were extended to a person asked for from every place a caller can be.

## The folder

```
app.yaml        who the app is and how it presents itself
intents.yaml    what a caller can ask for, and the keypad menu
forms.yaml      each form's slots, its summary prompt and the hooks it has
prompts.yaml    every line a caller can hear
policy.yaml     what the agent may do, action by action: the level and the rules the gate runs before each
policy.matrix   the policy read back: the gate's verdict for every action and kind of caller (written by pnpm policy:matrix)
POLICY.md       the policy card: the policy and the identity ladder in words (written by pnpm policy:card)
APP-MAP.md      the app map: the intents, the keypad menu, and each form to its slots, actions and rules (pnpm app:diagram)
identity.yaml   how a caller proves who they are: the factors, the one-time code, the delegates, the chat sign-in
slots.yaml      every slot, in the order the engine works through them
src/app.ts      the code: the tools, the form hooks and the gate's lookups, joined to the folder by defineApp
src/data.ts     the fixture accounts and property managers behind the stub tools
kb/             the knowledge base: settings, topics, the sources' text by section, drafts waiting for review (pending/), and approved passages (passages/)
docs-src/       the fictional source documents the knowledge base is built from: eight help pages and two PDFs
fixtures/       the corpus, the scripted calls, the stub baseline, and the paraphrases retrieval is measured on (kb/)
DESIGN.md       the design worksheet: the paragraph, every choice it left open, and the gaps
CLAUDE.md       notes for an AI coding assistant changing this app
.env.example    the keys and settings for recording and for serving (copy to .env)
```

What is data is YAML, and what runs is TypeScript. Policy is never in a tool: the gate decides, from `policy.yaml`, whether a tool may run. The guide to every file is [docs/authoring-an-app.md](../../docs/authoring-an-app.md) (its section 3 is policy and identity), and the slot types are in [docs/slots](../../docs/slots/README.md).

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
pnpm policy:card apps/utility                         # rewrite POLICY.md, the same way
pnpm app:diagram apps/utility                         # rewrite APP-MAP.md after a change to the intents or the forms
pnpm kb:status apps/utility                           # the knowledge base's passages and drafts, by state, each with its fix
pnpm kb:review apps/utility                           # the review page: approve, edit then approve, or reject each draft
pnpm kb:index apps/utility                            # rewrite kb/.index after a change to kb/topics.yaml
pnpm kb:bakeoff apps/utility --paraphrases apps/utility/fixtures/kb/paraphrases.yaml --sweep   # retrieval's recall, offline
```

Nothing here needs an API key. The engine's stub clients stand in for the decision model, answering from the labels in `fixtures/corpus.jsonl`.

## The knowledge base

This app is the showcase of DialogWright's knowledge base: answers to general questions come from short passages a person approved, chosen by meaning and said word for word, never generated. It was built the way an author would build one, with the authoring pipeline:

1. **Sources.** `docs-src/` holds the utility's documents, all fictional: eight pages of a small help website (outage credits, the outage map, payment options, budget billing, seasonal assistance, disconnection and reconnection, starting or stopping service, office hours) and two PDFs (a residential rate schedule and a customer rights notice). `pnpm kb:ingest` read them into `kb/sources/<doc>.yaml`, by section, with each section's heading, its file and, for a PDF, its page.
2. **Topics.** `kb/topics.yaml` has twelve topics, each with a title, keywords and example questions; `outage_credit` adds an account line from the caller's own data, read through the gated `getOutageHistory`. `kb/kb.yaml` names the resolving action (`answerQuestion`, `kbAnswerTool`, level 0), no `applies` domain (every answer is for every caller), `localeFallback: none`, and hybrid retrieval with the static embedder; `kb/.index` holds the topics' vectors (`pnpm kb:index`).
3. **Drafts.** `kb/pending/<id>.yaml`: one short spoken answer per topic, each quoting the words of its source section that support it. They were written by an AI assistant in `kb:draft`'s format and checked by its validation, with no model called (`drafted.by` says so). Nothing in `kb/pending` is ever said.
4. **Approval.** A person reads each draft beside its source in `pnpm kb:review` and approves, edits or rejects it. Approval moves it into `kb/passages/`, with who approved it, when, and hashes of the source text and of everything approved, and appends a line to `kb/approvals.jsonl`. **This is the step still to do** (below).

What a call does with it: when the caller asks something (`ask_question`), retrieval nominates up to eight topics for their words (keywords and meaning, `kb/.index`), the decision model is asked which one they mean or none (the `subject` slot, a `topic` slot), `answerQuestion` resolves the passage in force today through the gate, and `kb_answer` says it. A passage that is stale (its source changed since approval), unapproved or not in force is never said: the caller hears `kb_unavailable` and is offered a person, once. The outage map and the office hours (keys 4 and 5) are passages too, said with no retrieval and no gate.

What it demonstrates: documents in and passages out, with provenance down to the section and page; an approval that covers the source text, so a changed document withholds its answers (`pnpm kb:refresh`); retrieval chosen offline (`fixtures/kb/paraphrases.yaml`: recall at 8 of 97.3% with the hybrid retriever, against 83.8% for keywords alone, on paraphrases retrieval never saw); a gated line from the caller's own account after an approved answer, dropped for anyone the gate refuses; and the unavailable path, which the stub regression shows with an approved answer not yet in force on its day (the Winter Warmth credit, from October 1). DESIGN.md, "The knowledge base", has the details and every scripted call.

## Approving the knowledge base

The twelve answers are drafts until a person approves them, and only a person can (`kb:approve` refuses an approver who is not one). Until then the app does not build: its two informational intents name passages (`office-hours`, `outage-map`) that are still drafts, so `pnpm check` reports them and the topics with no passage in force, and this app's tests and regression fail. That is expected. To approve them:

1. At the repository root, with the dependencies installed (`pnpm install`) and the embedding model in the cache (`pnpm kb:model`, once), see what waits: `pnpm kb:status apps/utility` lists twelve drafts.
2. Start the review page: `pnpm kb:review apps/utility`. It prints a URL on 127.0.0.1 with a one-time token; open it in a browser on this machine.
3. Enter your name and your team (for example "Customer Care") when it asks. The name must be a person's.
4. For each draft, read the answer beside its source section (the excerpt is marked) and its effective date, then **Approve**, or **Edit then approve** (the answer, the dates), or **Reject** (it moves to `kb/rejected/` with your reason). Every topic needs one approved passage for `pnpm check` to pass, so a rejected draft needs a passage written in its place.
5. Stop the page with Ctrl-C. `pnpm kb:status apps/utility` now shows twelve passages, approved and fresh, and no drafts.
6. Check, at the root: `pnpm check` (`apps/utility: ok`), then `pnpm --filter @dialogwright/example-utility test` and `pnpm --filter @dialogwright/example-utility regress`, which prints `no changes`. The baseline records which lines were said, not their words, so an edited answer changes nothing there; the scripted calls do check a few words of some answers ("a credit of 25 dollars on your next bill", "There's nothing to apply for.", "1.5 percent of the unpaid balance", "within 30 days of the bill date", "example dot com slash outages", "Monday through Friday", "I don't have an answer to that I can give you right now."), so an edit to one of those words is a scripted call to update with it.
7. Commit what approval wrote: `kb/passages/`, `kb/approvals.jsonl` and the removed `kb/pending/` files (`git add apps/utility/kb`), and push. CI then runs green.

## The fixtures and the baseline

- `fixtures/corpus.jsonl`: one labelled utterance per line. Every intent needs examples (`pnpm check` says which are missing), including terse ones, and each line says what the stub model should answer for it.
- `fixtures/scenarios/core.json`: scripted calls, each with the outcome it expects. Every spoken step of a scripted call must also be in the corpus, so the stub can answer it.
- `fixtures/expected/`: the baseline, the stub's outcome for every corpus line and scripted call. The regression run compares against it and prints `no changes`. Its knowledge entries are those of the approved knowledge base.
- `fixtures/kb/paraphrases.yaml`: what callers say about each topic in other words than the topic's own, and lines no topic answers: what `pnpm kb:bakeoff` and `src/kb.test.ts` measure retrieval on.

This app's baseline was made once, with `regress --update`, and read entry by entry. It is never regenerated: a changed output is a finding to explain, and each later edit (a changed outcome, or a new corpus line or scripted call) is made by hand and logged under "Baseline edits" in [DESIGN.md](DESIGN.md).

## Recording against the real model

The stub answers from the corpus labels. A cassette holds the real decision model's answers, recorded once and replayed offline, so a run shows how a real model does on this app's calls. Recording calls the paid perception API, so it is the maintainer's deliberate local step, run by hand with their own key, and never part of CI. This app has no cassette yet: CI runs only its stub regression (`.github/workflows/ci.yml`), and until a cassette is committed, `--client recorded` reports every turn as a cassette miss.

1. Copy [`.env.example`](.env.example) to `.env` in this folder (it is git-ignored) and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or a key from OpenRouter or the Vercel AI Gateway, or a compatible endpoint's, with `JEV_PROVIDER`: `.env.example` lists them). The launchers do not read `.env` themselves, so load it into your shell: `set -a && source .env && set +a`.
2. At the repository root: `pnpm --filter @dialogwright/example-utility regress --client record --threshold JEV_TIMEOUT_MS=15000`. It appends each answer to `fixtures/recorded/<model>.jsonl` and aborts after three consecutive client errors. The diff against the stub baseline shows where the real model reads a line differently from its label; that is expected, and it never rewrites the baseline.
3. Check the replay offline, with the key unset: `pnpm --filter @dialogwright/example-utility regress --client recorded`. A line the model reads differently from its label stays the truth in the corpus and gets a `knownGap` with its reason (see "Known gaps" in the [clinic's README](../../apps/clinic/README.md)).
4. Commit the cassette. It holds only the corpus text and the model's answers to it.

A change to the words in the YAML (criteria, labels, prompts, the questions a slot sends) changes what the model is sent, so the replay reports each changed request as a cassette miss until the cassette is recorded again.

## Running it

`pnpm --filter @dialogwright/example-utility serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise.

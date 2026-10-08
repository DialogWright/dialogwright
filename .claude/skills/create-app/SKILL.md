---
name: create-app
description: Use when building a new DialogWright app from a plain-language description (a paragraph saying what callers can ask for, who must verify and how, what must be confirmed, what goes to a person). Plans the app in a worksheet, scaffolds it with pnpm create-app, writes the YAML, the tool stubs, the corpus and the scenarios, and iterates until pnpm check, the type check, the tests and the stub regression are green; then hands the owner the recording command and triages the recording.
---

# Create an app from a description

You are given a paragraph and asked to build an app. This skill is the procedure, from the paragraph to a green app in `apps/<name>`, in eight steps, with one more (step 6b) when callers ask questions that documents answer, and a ninth once the owner has recorded the app against the real model. Do them in order; each step ends with something you can check.

Four supporting files sit next to this one:

- [worksheet.md](worksheet.md): the template for the app's design worksheet (`apps/<name>/DESIGN.md`), with the final checklist you tick.
- [patterns.md](patterns.md): the YAML and TypeScript for each feature a paragraph usually asks for (verification, verification by caller ID, a one-time code, delegates, confirmed writes, bounds on a date or an amount, refusals and handoffs, informational answers, a knowledge form, policy tests), each tried in a running app, and the known gaps with their workarounds.
- [corpus.md](corpus.md): how to write corpus lines and scripted calls, including how to label each slot type's questions.
- [triage.md](triage.md): what to do with the owner's recording (step 9): the three buckets, the order of the fixes, and what to bring to the owner.

## Before you start

Read these first; the rest of this skill assumes them:

1. [CLAUDE.md](../../../CLAUDE.md): the three roles and the rules.
2. From [the authoring guide](../../../docs/authoring-an-app.md), only [1. The folder](../../../docs/authoring-an-app.md#1-the-folder) and [4. What stays in TypeScript, and why](../../../docs/authoring-an-app.md#4-what-stays-in-typescript-and-why) for now. The guide is the reference for every file, and it is too long to read in one go: never read it whole. Each step below names the sections it needs, under **Guide**; read those when you reach the step, one section at a time. `grep -n '^##' docs/authoring-an-app.md` lists every heading with its line, so you can read a section from its heading to the next.
3. [docs/slots/README.md](../../../docs/slots/README.md): the slot types and "Which type?".
4. Only if callers ask questions that documents answer: [section 12 of the authoring guide](../../../docs/authoring-an-app.md#12-the-knowledge-base), the knowledge base, before step 6b.

The rules you keep, whatever the paragraph says:

- **Never put policy in tool code.** A tool does the work. Who may call it, at what identity level, with what confirmation and within what bounds is `policy.yaml` and `identity.yaml`, decided by the gate before the tool runs.
- **Never let a model write a regulated line.** Every line a caller hears is in `prompts.yaml`, word for word. The model only answers typed questions. Information answers are fixed lines too, or passages of a knowledge base that people approved: either way word for word.
- **Fictional data only.** Invented names, invented streets, the 555 phone range, `example.com` web addresses. Nothing real, nothing private.
- **Do not change `packages/dialogwright`.** If the framework is in your way, see "When something doesn't fit" at the end.
- **Never run `regress --client record`.** Recording calls a paid API; it is for the app's owner to do. You hand them the command, whole (step 9), and triage what it recorded.
- **Never approve a passage of a knowledge base, and never use a model key.** Only a person approves what callers will hear, after reading it against its source: you do not run `pnpm kb:approve`, you do not write an `approval` or a hash, and you do not edit `kb/approvals.jsonl`. You do not run `pnpm kb:draft` either, since it calls a model with the owner's own key, which you never handle and never put in a file. Step 6b says what you do instead.

## Step 1: The worksheet

Read the paragraph twice, then fill in [worksheet.md](worksheet.md). Choose the app's name first: lower case letters, digits and single hyphens, starting with a letter (`pnpm create-app` refuses anything else). Draft the worksheet outside the app folder, in your scratch space, because `pnpm create-app` refuses a folder that already exists. You move it into `apps/<name>/DESIGN.md` in step 3, keep it up to date from then on, and commit it with the app.

The worksheet lists:

- **Intents**: everything a caller can ask for, each with five or more example phrasings, terse ones included (one word, a fragment, a bare number).
- **For each intent**: the information it needs, one row per piece, and whether it is a form (collects information, then acts), informational (says one fixed line) or a person.
- **Actions**: each tool, what it reads and what it writes, and its params.
- **Who may do each action**: anonymous; the verified caller (the subject) and at which level; each kind of delegate (someone acting for subjects) and each of their roles. For each: allowed, refused, or handed to a person.
- **Confirmation**: which writes are read back for a yes before they happen, and exactly which values the caller confirms.
- **Bounds**: dates that must fall in a range, amounts that must stay under a limit, and where each bound comes from (today, a fixed date, a record).
- **Informational answers**: the fixed line for each.
- **Knowledge**: the questions callers ask that a document answers (not a task, a general question), the documents that answer them, whether an answer is the same for every caller, and whether a line from the caller's own data follows it.
- **What goes to a person**: on request (always), after failed verification, by a role, by a bound.
- **Gaps**: anything the paragraph asks for that you are not sure the framework does. Fill this in as you go.

Read the paragraph once more against the worksheet: every sentence of it should land in a row. Where the paragraph is silent (how many tries, how long a code is), choose the framework's default and write the choice down under "Choices the paragraph left open".

One thing you ask rather than choose: **the business name**, when the paragraph gives none. Every caller hears it in the greeting ("Thanks for calling ..."), and `pnpm create-app --display` takes it. Ask the person who gave you the paragraph once, before the scaffold, and carry on with the worksheet while you wait. In this repository every name is fictional, so offer an invented one with the question ("Example Foundation Repair"). Everything else the paragraph leaves open, you decide and record as above.

## Step 2: Map the worksheet onto the framework

Add the mapping to the worksheet.

**Guide**: [Pick a type in slots.yaml](../../../docs/authoring-an-app.md#pick-a-type-in-slotsyaml) and [Where a slot listens](../../../docs/authoring-an-app.md#where-a-slot-listens-listen) (section 5; the type pages have the rest); [3.2 An action and its rules](../../../docs/authoring-an-app.md#32-an-action-and-its-rules), [3.3 The built-in rules](../../../docs/authoring-an-app.md#33-the-built-in-rules), [3.6 The identity ladder](../../../docs/authoring-an-app.md#36-the-identity-ladder), [3.7 How a form reaches an action](../../../docs/authoring-an-app.md#37-how-a-form-reaches-an-action-calls) and [3.9 What is recorded](../../../docs/authoring-an-app.md#39-what-is-recorded-audit-and-the-rule-names). With delegates, also [3.8 Redaction per principal](../../../docs/authoring-an-app.md#38-redaction-per-principal-redact).


- **Each piece of information to a slot type**, using "Which type?" in [docs/slots/README.md](../../../docs/slots/README.md) and the type's page for its options. An identifier in digits is `digits`; one of a list you can write down is `choice` (option keys start with a letter: `two`, not `2`); a day is `date` (`range: future` or `past`); a date of birth is `birthdate`; the caller's own name is `name`; one of the caller's own records is `record`; free words are `text`. Some values have no type yet (an amount of money, a street address, a code with letters): [patterns.md](patterns.md#values-with-no-slot-type) says what to do instead. Name each slot with an id the engine does not keep for its own questions (`urgency` is one: say `howUrgent`); [patterns.md](patterns.md#names-the-engine-keeps) lists them.
- **Each action to a policy entry**: its `level` (0 anonymous, 1 the identity factors, 2 the factors and a one-time code) and its `rules`, in the order the gate should run them, usually `identity`, `role`, `scope`, `confirmed`, the range rules (`limit`, `dateInRange`) and the list rules (`oneOf`, `noneOf`), then `custom`. Section 3.3 of the authoring guide ([the built-in rules](../../../docs/authoring-an-app.md#33-the-built-in-rules)) has every rule's parameters.
- **Verification to `identity.yaml`**: the subject's kind, the level 1 factor slots and the tool that checks them (with `callerId` where the paragraph says a caller calling from the number on file gives only their date of birth: [patterns.md](patterns.md#verified-by-caller-id-callerid)), and level 2 (a one-time code, with the tools that send and check it) only if some action needs level 2. On the phone a caller verifies by voice and keypad; on a chat nothing typed counts as a factor, so if the paragraph mentions a chat, chat callers sign in through the portal (`signIn`): see [patterns.md](patterns.md#phone-and-chat).
- **Delegates to principals and roles**: each kind of delegate under `principals.delegates` with its roles, and a `role` rule on each action whose answer differs by role. Delegates reach the app signed in on a chat, not by phone: see [patterns.md](patterns.md#delegates).
- **Each tool to its `params`, and each param to how it is recorded.** A tool lists the params its calls carry (`params: ['accountId', 'service']` on the tool in `src/app.ts`, `params: []` for none). A param named after a slot with a redact setting (a `digits` slot is `last4`, a `birthdate` is hidden, a `text` slot is `length`) is recorded as the slot says. Every other param is declared by name under `audit:` in `policy.yaml`, one of `last4`, `mask`, `length`, `secret` or `keep`. Choose by what the value is: an identifier `last4`, free words `length` (or `secret` if they must not be kept at all), a plain choice from a short list, a day or an amount `keep`. A value you keep that a person said in their own words (a street address read back as said) is a privacy trade-off: write it in the worksheet's choices. See [patterns.md](patterns.md#what-is-recorded-params-and-audit).
- **Each confirmed write to its `confirmed` fields.** An app has one list of confirmed fields, shared by every action with a `confirmed` rule: see [patterns.md](patterns.md#confirmed-writes).
- **Each answer that rules a caller out to a check** (the worksheet's question under "Information each form needs"): one form, the qualifying slots first, a `check: true` action per answer named in the form's `checks`, with its line and ending, and the same rule in the write. Never write `s.queued` from app code. See [patterns.md](patterns.md#qualify-before-you-collect).
- **Each form to its hooks**: `complete` always; `entry` (and `onEntry`) when the form needs a verified caller; `principalEntry` when delegates use it; `confirmedParams` for a confirmed write; `onSummaryRead` when the read-back names a value no slot holds.
- **Each knowledge row to a topic, and each answer to a passage** (only when the worksheet has knowledge rows): a topic is an id, a title, keywords and example questions in `kb/topics.yaml`; a form with a `topic` slot and `answers:` says it; an answer that is one fixed line for everyone with no question to ask may be an informational intent's `passage:`. The facts an answer depends on (the caller's plan, say) are `applies`, read by code from the system of record, never from what the caller said. See [patterns.md](patterns.md#a-knowledge-form) and step 6b.
- **Each form to the actions it calls** (`calls` in `forms.yaml`): its entry call and the calls its hooks make through the gate, `calls: []` for one that calls none. The engine never reads it; the app map draws each form to its actions with it, and `pnpm check` reports an action no form reaches. Declare it for every form or for none.

Decide now whether the app needs `--identity`: it does if any action is above level 0.

## Step 3: Scaffold, then replace the example

At the repository root:

```sh
pnpm create-app <name> --display "<business name>"     # add --identity when any action is above level 0
```

It writes `apps/<name>` (a one-form example: book a service, with an account number and a date of birth under `--identity`), links it into the workspace, and prints the next steps. It passes `pnpm check`, its tests and its regression as created. Move your worksheet into `apps/<name>/DESIGN.md` now. Then read the new folder's `README.md`, `CLAUDE.md` and `src/app.ts`: they say what each file is for, and the example shows the shape of a confirmed write and (with `--identity`) of a form that steps the caller up.

**Guide**: the page for each file as you replace it, in section 2: [app.yaml](../../../docs/authoring-an-app.md#appyaml), [intents.yaml](../../../docs/authoring-an-app.md#intentsyaml) (with [Must never wait](../../../docs/authoring-an-app.md#must-never-wait-priority)), [forms.yaml](../../../docs/authoring-an-app.md#formsyaml), [prompts.yaml](../../../docs/authoring-an-app.md#promptsyaml), [policy.yaml](../../../docs/authoring-an-app.md#policyyaml), [identity.yaml](../../../docs/authoring-an-app.md#identityyaml-optional) and [slots.yaml](../../../docs/authoring-an-app.md#slotsyaml-optional); and [7. Checking an app](../../../docs/authoring-an-app.md#7-checking-an-app-pnpm-check) for what `pnpm check` reports.

Replace the example one piece at a time, running `pnpm check` after each change:

1. `app.yaml`: the brand, `console.formLabels` and `slotLabels`, `voice.hints`, `wording.addressee`.
2. `intents.yaml`: your intents (form, informational), each with criteria a one-breath answer to every slot of its form still matches ([patterns.md](patterns.md#an-intents-criteria)); keep `agent` and `repeat_prompt` (required) and the other control intents, `done` among them: it is how "no, that's all" at "anything else?" ends the call with the goodbye, and `pnpm check` refuses an app that says `anything_else` without it; the keypad menu.
3. `slots.yaml`: your slots, from the mapping. Keep `accountId` and `dob` if your factors are an account number and a date of birth.
4. `forms.yaml`: your forms, their slots, their summary prompts, their hooks and the actions they call (`calls`).
5. `policy.yaml` (with its `audit:`) and `identity.yaml`: from the mapping.
6. `src/data.ts` and `src/app.ts`: the fixture data, the tools (each with its `params`), the form hooks, and what the code declares for the gate (`systems`, `lookups`, `customRules`, `principals`, `portal`, `identity.sendCodeParams`, `blockPromptId`). See step 4 and [patterns.md](patterns.md).
7. `prompts.yaml`: every line `pnpm check` asks for, and your forms' own lines.
8. Remove the example's intent, form, slot, tool and lines, and update `src/app.test.ts` (it asserts the example's intents) and `testing.heuristics` in `src/app.ts` (the keywords the text console's heuristic stub listens for).

How to read `pnpm check`. Each problem is one line, `file:line:column  path  message  ->  fix`. Act on the text after `->`. Fix from the top down: a schema problem (an unknown key, a wrong type) stops the cross-checks against the code until it is fixed, and one typo can show up in several places (a misspelt slot gives an unknown slot and its missing `ask_` lines). Run it again after each fix; `pnpm check --json` gives the same problems as JSON.

What `pnpm check` does not see: the corpus beyond "every intent has examples" (the regression checks the rest, step 5), and the lines your own code names (a `handoff(s, '<reason>', acks)` says `handoff_<reason>` with hyphens as underscores; a `blockPromptId` line; a completion's line; a summary variable that no slot holds). Add those yourself. The regression stops with an error such as `unknown prompt id: <id>` or `prompt variable missing: <name>` when one is missing.

## Step 4: Tools as stubs over fixture data

**Guide**: [6. The form hooks](../../../docs/authoring-an-app.md#6-the-form-hooks), and [3.4 Rules of your own](../../../docs/authoring-an-app.md#34-rules-of-your-own-definerule) for a custom rule.

- Each tool lists `params`, every param its calls carry, and each one that is not a slot with a redact setting is declared under `audit:` in `policy.yaml` ([patterns.md](patterns.md#what-is-recorded-params-and-audit)); `pnpm check` names the ones missing. Each tool's `run` reads or writes the in-memory `Systems` and the fixture data in `src/data.ts`, and returns `{ value, summary }`. Invented records only: names, 555 numbers, invented streets, amounts written as plain decimals (`240.00`). A real client replaces the stub later; keep the tests on the stub.
- No `if` about who is calling, their level, a limit or a date inside a tool. If you find yourself writing one, it is a rule: put it in `policy.yaml`, or, when no built-in rule fits, write it with `defineRule` (with an example the gate allows and one it refuses) in `code.customRules` and name it with `custom:` ([patterns.md](patterns.md#bounds-limit-and-dateinrange)).
- The gate's lookups are code: `systems()` returns `lookups.scopeOf` (the subject ids a principal may see: a subject their own id, a delegate the subjects they act for, an anonymous caller none), `lookups.ownerOf` (the subject a record belongs to, or null), and each lookup a range rule's bound names (also listed in `code.lookups`). The `--identity` scaffold's `scopeOf` gives a verified customer their own account and an anonymous caller none; extend it when delegates act for subjects ([patterns.md](patterns.md#delegates)). Without `--identity` the scaffold's `scopeOf: () => []` fails every `scope` rule, so replace it if you add one.
- A form's `complete` calls its tool through `c.callTool`, never the tool directly, and turns the gate's decision into a line: `ALLOW` to the form's own line, anything else through `c.refusal(decision)` (a `blockPromptId` line, or a person). [patterns.md](patterns.md#refusals-and-handoffs) has each case.

## Step 5: The corpus and the scenarios

**Guide**: [fixtures/](../../../docs/authoring-an-app.md#fixtures-optional) in section 2; [corpus.md](corpus.md) has the rest.

The stub decision model answers from `fixtures/corpus.jsonl`, so the corpus is how the app is tested with no keys. [corpus.md](corpus.md) has the format, the contexts and the labels for each slot type. Write at least:

- **Eight lines for every intent**, control intents included (`agent`: "a person", "representative", "operator", "can I talk to someone", ...). For a form intent, among the eight: two or more terse ones (one word, a fragment), two or more that over-answer (the intent and one or more slots' values in one breath, labelled), and one that hedges or asks indirectly.
- **Five answers for every slot**, as it is asked inside its form: a full answer, a terse one (a bare number, one word), one said another way (digits run together, "the twentieth", a weekday), one that misses (the caller does not know, or says something else), and a correction ("no, I meant ...").
- **Four answers for every summary**: a yes, a yes worded differently, a no, and a no that names what to change (`changeSlot`).
- **Every text exactly once.** No two lines may have the same words after normalization (lower case, no punctuation): a scripted call's step is answered from the one line with its words, whatever that line's context. So "yes" appears once in the whole corpus; give each summary its own wordings, and give a phrase used in several places the labels of every question it answers.

Scripted calls in `fixtures/scenarios/*.json`, each with the outcome it expects. At least one for:

- each form, start to finish, and each form with its values given up front;
- each kind of principal: an anonymous caller, a subject at each level the app uses (verifying by voice, and keying the one-time code), and each delegate role (`as`);
- the step-up: an anonymous caller asking for an action above level 0, verifying, and being served;
- failed verification three times (a person takes the call);
- each refusal: out of scope, each bound (`limit`, `dateInRange`, each custom rule), each list (`oneOf`, `noneOf`), each refused role;
- each handoff: on request from every place a caller can be (at the start, on the keypad menu with its key for a person, inside a form, while verifying, at the code prompt, at each summary), by role, by a rule;
- keypad entry for each slot with a keypad, and for the one-time code;
- each informational answer, spoken and, if it is on the keypad menu, by its key (the key plays the line and offers the menu again, so the call ends at `nomatch_dtmf_menu` with the line in its words).
- a caller who is done: a form that ends at "anything else?" (a `said` completion), then "no, that's all" (`done`), ending at `"decision": "complete", "promptId": "goodbye"`. Where every form ends the call on its own line, the caller says it at the next question instead (after an informational answer or a request the line does not handle).

## Step 6: Iterate until green, then make the baseline once

**Guide**: [Follow one scripted call turn by turn](../../../docs/authoring-an-app.md#follow-one-scripted-call-turn-by-turn) (section 11).

Run, at the repository root, until each is clean:

```sh
pnpm check
pnpm --filter @dialogwright/example-<name> typecheck
pnpm --filter @dialogwright/example-<name> test
pnpm --filter @dialogwright/example-<name> regress
```

The regression prints one line per difference from the baseline: `+ corpus <id>: new`, `- corpus <id>: removed`, `~ corpus <id>.<field>: <before> -> <after>`, and `FAIL scenario <id>: ...` when a scripted call does not reach what it expects, then a summary. A clean run prints `no changes` as its first line, then the summary:

```text
no changes

corpus     129/129 outcomes match expected
scenarios   34/34 pass expectation,  34/34 match expected
```

A `FAIL scenario` line names only the field that differed. To see the call turn by turn (each step's words or keys, the prompt id, the acknowledgements and the words the caller hears, the form, the caller's level and the slots after the turn, and every gate decision with its reason), ask for its transcript; `--corpus <id>` does the same for one corpus line, from the state it is seeded in:

```sh
pnpm --filter @dialogwright/example-<name> regress --scenario <id>     # repeatable; --corpus <id> too
```

It ends with `pass` or `FAIL ...` and `baseline: no changes` or the differences. Read the transcript rather than writing a script over the harness. While you build, the baseline is still the example's, so your lines are `new`, the example's are `removed`, and the app's `fixtures.test.ts` fails on its baseline comparison. That is expected. What must be clean before you make the baseline: `pnpm check`, the type check, every other test, no `FAIL scenario` line, and no error loading the corpus or the scripted calls (a duplicate text, a label a question cannot give, `as` outside `no_form`, a spoken step whose words no corpus line has).

Then make the app's own first baseline, once:

```sh
pnpm --filter @dialogwright/example-<name> regress --update
```

and read `fixtures/expected/corpus.json` and `scenarios.json` entry by entry against the worksheet. For each entry: is `promptId` the next thing the caller should hear (the next slot's `ask_`, the summary, `anything_else`, `ask_intent` after an informational answer)? Is `gate` the action you expect, with the verdict the worksheet's who-may-do-what says? Are `slots` the values the line gives? A `STEP_UP` or `ask_otp` on a line spoken inside a form usually means the seeded caller's level is lower than the form needs ([corpus.md](corpus.md#lines-spoken-inside-a-form)).

Never run `--update` again. When the review finds a wrong outcome, fix the app or the line; the regression then shows `~` lines for the entries that changed. Check they are exactly the ones you meant to change, edit those values in `fixtures/expected/*.json` by hand, and note each edit and its reason in the worksheet. A corpus line or scripted call added later shows as `+ corpus <id>: new` or `+ scenario <id>: new`: read its transcript (`--corpus <id>`, `--scenario <id>`), then add its entry to the baseline by hand in the shape of its neighbours (the regression compares it field by field, so it says `no changes` only when the entry is exact), and list it in the worksheet. From then on a changed output is a finding to explain, never noise to overwrite.

Add the app's regression to CI: `- run: pnpm --filter @dialogwright/example-<name> regress` in `.github/workflows/ci.yml`, after the clinic's. Commit `pnpm-lock.yaml` with the app: CI installs from it, frozen.

## Step 6b: A knowledge base from documents (only when the worksheet has knowledge rows)

Callers ask general questions a document answers: when are you open, what is the late fee. The answers are short passages that a person approves, chosen by meaning and said word for word. The pipeline is ingest, draft, a person reviews and approves, and the last step is never yours: **you never approve a passage.** Do these, in this order, once the app is green and its baseline is made (step 6), as additions to it. Step 7 then reads the new action back with the rest of the policy.

1. **Write the folder's settings and topics.** `kb/kb.yaml` (the resolving `action`, and `applies` if an answer depends on the caller), `kb/topics.yaml` (each topic with its title, keywords and example questions in a caller's words). Section 12 of the authoring guide has each file with an example.
2. **Ingest the documents.** `pnpm kb:ingest <the documents' folder> --dir apps/<name>` reads PDF, DOCX, HTML, Markdown and text files into `kb/sources/<doc>.yaml` by section. For a website, only the address the paragraph names, with `--dry-run` first and a small `--depth`. Read each source: a section you cannot read as the document's own words (a scanned page, a menu that was picked up) is a finding for the worksheet.
3. **Draft, without a key.** Do not run `pnpm kb:draft`: it calls a model with the owner's own key. Write each draft by hand into `kb/pending/<id>.yaml` in the draft format (the passage's fields, no `approval`, and `drafted: { by: <an AI coding assistant, and which>, on: <today>, excerpt: <the words of the section that support the answer, copied exactly> }`). The answer is one or two short spoken sentences with no `{variable}`, drawn only from that excerpt; if the document does not say it, no passage. The owner, who has a key, may run `kb:draft` instead.
4. **Wire the form** (or the informational intent): the pattern is [a knowledge form](patterns.md#a-knowledge-form): a `topic` slot, a form with `answers:`, the resolving tool with the facts read by code, `topic: keep` under `audit`, the three lines in every locale, `answer` in `prompts.dataVars`. Add the knowledge rows' paraphrases (`fixtures/kb/paraphrases.yaml`, eight or more for each topic, in other words than the topic's keywords, and a `none:` list) and the recall test.
5. **Stop at the person.** Until each draft is approved, no topic has a passage in force: `pnpm check` reports it (a topic without an approved passage), and a call that asks the topic hears the unavailable line and is offered a person. That is the check doing its job, and it is the one thing you leave red. Do not approve to silence it, do not move a draft into `kb/passages/`, do not take the topic out. Write in the worksheet, under the knowledge rows, which drafts await approval and the two commands: `pnpm kb:review apps/<name>` (the review page, on that machine; they read each draft beside its source section and approve, edit or reject it) and `pnpm kb:approve <id...> --by "<their name>"`. Leave the knowledge form's corpus lines and scripted calls to after the approval, since the baseline records what a call hears, and say so.
6. **After the person approves** (in this session, or when the owner returns): run `pnpm check` (it should be ok), write the corpus lines and scripted calls for the knowledge form (corpus.md's `topic` row has the labels), read their transcripts, add their baseline entries by hand as step 6 describes, and list them in the worksheet.

## Step 7: Read the policy back

**Guide**: [3.10 Testing the policy](../../../docs/authoring-an-app.md#310-testing-the-policy) and [3.11 Reading the policy](../../../docs/authoring-an-app.md#311-reading-the-policy-the-card-and-the-app-map).

Check what the gate will decide against the worksheet's who-may-do-what, not against what you meant to write. The scaffold ships the example's read back: `testing.policyMatrix` in `src/app.ts`, the three pages beside `policy.yaml`, and their tests in `src/app.test.ts` ("the policy read back"), so from the first change to the policy, the forms or the tools those tests fail until the pages are written again. Make `testing.policyMatrix` your app's callers and records ([patterns.md](patterns.md#testing-the-policy): a principal per delegate role, the subject at each level, and named `calls` for each action whose rules read params it has no `confirmed` or `fields` list for, or the matrix shows every caller refused), keep the tests, then write the policy matrix, the policy card and the app map:

```sh
pnpm policy:matrix apps/<name>     # policy.matrix: the gate's verdict for every action and kind of caller
pnpm policy:card apps/<name>       # POLICY.md: the policy and the identity ladder in words
pnpm app:diagram apps/<name>       # APP-MAP.md: the intents, the keypad menu, each form to its slots, actions and rules
```

`apps/<name>/policy.matrix` lists, under each action, what the gate decides for each kind of caller (anonymous, the subject at each level, each delegate role, a role the policy does not name, ...) and why, then each custom rule's examples. Read it beside the worksheet's "Who may do what", cell by cell: every allowed, refused and to-a-person cell should be there, decided by the rule you expect. Then check each bound at its edges with the per-action test. Read `POLICY.md` against the paragraph itself, sentence by sentence: each thing the paragraph says a caller may or may not do should be a line of the card (the level, the factors, each rule in words, what each role gets), and each line of the card should come from the paragraph or from a choice in the worksheet. Read the card's "What is recorded" table beside the worksheet's per-param column: each value an action is sent should be recorded as you chose (an identifier by its last four, nothing kept that a person said in their own words unless you chose it). Read `APP-MAP.md` for what the policy does not hold: every intent reaches a form or a line, every key on the menu goes where you meant, every form reaches its actions, and nothing is listed under "Dangling references". Write what the reading found in the worksheet.

A knowledge form's resolving action and its account line's reads are in the matrix like any action: read them too (an anonymous caller may be allowed the general answer and refused the line from their own data). Fix every mismatch in the YAML (or in the worksheet, if you misread the paragraph), write the three pages again, read their diffs, and run step 6's commands again. Once they are right, they are goldens like the baseline (the tests compare them with what the app generates): rewrite them only for a change you meant.

## Step 8: The final checklist

Tick the checklist at the end of the worksheet ([worksheet.md](worksheet.md#final-checklist)), in the worksheet itself. In short: every intent has corpus lines and a scenario; every action has a policy entry, a row in `policy.matrix` and a line in `POLICY.md` you have read, and its bounds tested at their edges; identity matches the paragraph; nothing private or real; `pnpm check`, `pnpm verify` and every app's regression green; the README describes the app and keeps the recording steps the scaffold wrote; the gaps are written up; and, if there is a knowledge base, every draft is either approved by a person or listed in the worksheet as awaiting one, with `pnpm check`'s approval findings the only ones left. Then commit, with the worksheet.

## Step 9: Hand over the recording, then triage it

**Guide**: [fixtures/](../../../docs/authoring-an-app.md#fixtures-optional) (the keys, the providers and the cassettes); [triage.md](triage.md) has the rest.

The app is green on the stub, which answers from your own labels. How the real model reads the same lines is the next thing to know, and only a recording shows it. Recording calls a paid API with the owner's key, so the owner runs it, never you.

**Hand the owner exactly this**, whole, with the app's name filled in, and nothing else to type:

```sh
pnpm --filter @dialogwright/example-<name> regress --client record --threshold JEV_TIMEOUT_MS=15000
```

It runs at the repository root and reads the key from the app's own `apps/<name>/.env` (git-ignored). Tell them how the key gets there: `pnpm configure --app <name>` asks for it and writes that file, or they copy a key into `apps/<name>/.env` as `TYPESAFE_API_KEY=...` (the folder's `.env.example` lists the other providers). Do not ask for the key, read the `.env` or put a key in any file yourself. Do not split the command into steps or add a `source` of a `.env`: a `.env` may hold a value a shell cannot read as written. The run takes a few minutes and has cost a few cents for an app this size; it appends the model's answers to `fixtures/recorded/<model>.jsonl` and never touches the baseline.

**When they have recorded**, triage it as [triage.md](triage.md) says. In short:

1. Replay it, offline and free: `pnpm --filter @dialogwright/example-<name> regress --client recorded`. Read its last line, `to triage: N untagged corpus differences, M failing scripted calls, K passing scripted calls that differ from the baseline, J cassette misses`, not its exit code.
2. Look at each difference with `regress --client recorded --corpus <id>` (the line's model answers, with their probabilities) or `--scenario <id>`, and put it in one bucket: the label was wrong (fix the label, edit the baseline entry by hand, log it under "Baseline edits"); the model misread a borderline line (a `knownGap` with the model's numbers and the caller impact, `outcomes` if it flips); a scripted call broke on an incidental line (change that line, such as a keypad call's opener, not the expectation).
3. A scripted call has no allowance but `cosmeticDrift`, so one that tests a real gap stays failing: report it to the owner, do not make it pass.
4. Fix in this order: first everything that changes no request (code, the policy, a `priority` flag, silences and keys, labels and tags), checked on the recording you have; then all the rewording at once; then ask for one re-record (the same command); then `pnpm --filter @dialogwright/example-<name> cassette:trim`, and replay again.
5. Bring the engine's gaps and the open questions to the owner as a short table (triage.md, "What to bring to the owner"), and write the triage in the worksheet's "Recordings" section.

Commit the cassette with the triage: it holds only the corpus text and the model's answers.

## When something doesn't fit

The paragraph may ask for something the framework does not do, or does differently. Then:

1. Write it in the worksheet's Gaps section: what the paragraph asks, what the framework does, what you did instead, and what it cost you (time, a wrong turn, an unclear message).
2. Work around it inside the app: a custom rule, a slot in code, a different form shape, a fixed line. [patterns.md](patterns.md#known-gaps) lists the gaps known so far and their workarounds.
3. Do not modify `packages/dialogwright` (its code, templates or docs), and do not weaken a check, a test or a baseline to get past it. If there is no workaround, leave that part out, say so in the worksheet, and finish the rest.

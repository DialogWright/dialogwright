---
name: create-app
description: Use when building a new DialogWright app from a plain-language description (a paragraph saying what callers can ask for, who must verify and how, what must be confirmed, what goes to a person). Plans the app in a worksheet, scaffolds it with pnpm create-app, writes the YAML, the tool stubs, the corpus and the scenarios, and iterates until pnpm check, the type check, the tests and the stub regression are green.
---

# Create an app from a description

You are given a paragraph and asked to build an app. This skill is the procedure, from the paragraph to a green app in `apps/<name>`, in eight steps. Do them in order; each step ends with something you can check.

Three supporting files sit next to this one:

- [worksheet.md](worksheet.md): the template for the app's design worksheet (`apps/<name>/DESIGN.md`), with the final checklist you tick.
- [patterns.md](patterns.md): the YAML and TypeScript for each feature a paragraph usually asks for (verification, a one-time code, delegates, confirmed writes, bounds on a date or an amount, refusals and handoffs, informational answers, policy tests), each tried in a running app, and the known gaps with their workarounds.
- [corpus.md](corpus.md): how to write corpus lines and scripted calls, including how to label each slot type's questions.

## Before you start

Read these first; the rest of this skill assumes them:

1. [CLAUDE.md](../../../CLAUDE.md): the three roles and the rules.
2. [docs/authoring-an-app.md](../../../docs/authoring-an-app.md): sections 1 and 2 (the folder and each file, including "The range rules"), 3 (what stays in TypeScript), 5 (the form hooks) and 6 (`pnpm check`). Skim section 4 (slots); the type pages cover it.
3. [docs/slots/README.md](../../../docs/slots/README.md): the slot types and "Which type?".

The rules you keep, whatever the paragraph says:

- **Never put policy in tool code.** A tool does the work. Who may call it, at what identity level, with what confirmation and within what bounds is `policy.yaml` and `identity.yaml`, decided by the gate before the tool runs.
- **Never let a model write a regulated line.** Every line a caller hears is in `prompts.yaml`, word for word. The model only answers typed questions. Information answers are fixed lines too (there is no knowledge base yet).
- **Fictional data only.** Invented names, invented streets, the 555 phone range, `example.com` web addresses. Nothing real, nothing private.
- **Do not change `packages/dialogwright`.** If the framework is in your way, see "When something doesn't fit" at the end.
- **Never run `regress --client record`.** Recording calls a paid API; it is for the app's owner to do later.

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
- **What goes to a person**: on request (always), after failed verification, by a role, by a bound.
- **Gaps**: anything the paragraph asks for that you are not sure the framework does. Fill this in as you go.

Read the paragraph once more against the worksheet: every sentence of it should land in a row. Where the paragraph is silent (how many tries, how long a code is), choose the framework's default and write the choice down.

## Step 2: Map the worksheet onto the framework

Add the mapping to the worksheet:

- **Each piece of information to a slot type**, using "Which type?" in [docs/slots/README.md](../../../docs/slots/README.md) and the type's page for its options. An identifier in digits is `digits`; one of a list you can write down is `choice` (option keys start with a letter: `two`, not `2`); a day is `date` (`range: future` or `past`); a date of birth is `birthdate`; the caller's own name is `name`; one of the caller's own records is `record`; free words are `text`. Some values have no type yet (an amount of money, a street address, a code with letters): [patterns.md](patterns.md#values-with-no-slot-type) says what to do instead.
- **Each action to a policy entry**: its `level` (0 anonymous, 1 the identity factors, 2 the factors and a one-time code) and its `rules`, in the order the gate should run them, usually `identity`, `role`, `scope`, `confirmed`, the range rules (`limit`, `dateInRange`), then `custom`. Section 2 of the authoring guide ("policy.yaml" and "The range rules") has every rule's parameters.
- **Verification to `identity.yaml`**: the subject's kind, the level 1 factor slots and the tool that checks them, and level 2 (a one-time code, with the tools that send and check it) only if some action needs level 2. On the phone a caller verifies by voice and keypad; on a chat nothing typed counts as a factor, so if the paragraph mentions a chat, chat callers sign in through the portal (`signIn`): see [patterns.md](patterns.md#phone-and-chat).
- **Delegates to principals and roles**: each kind of delegate under `principals.delegates` with its roles, and a `role` rule on each action whose answer differs by role. Delegates reach the app signed in on a chat, not by phone: see [patterns.md](patterns.md#delegates).
- **Each confirmed write to its `confirmed` fields.** An app has one list of confirmed fields, shared by every action with a `confirmed` rule: see [patterns.md](patterns.md#confirmed-writes).
- **Each form to its hooks**: `complete` always; `entry` (and `onEntry`) when the form needs a verified caller; `principalEntry` when delegates use it; `confirmedParams` for a confirmed write; `onSummaryRead` when the read-back names a value no slot holds.

Decide now whether the app needs `--identity`: it does if any action is above level 0.

## Step 3: Scaffold, then replace the example

At the repository root:

```sh
pnpm create-app <name>              # or, when any action is above level 0: pnpm create-app <name> --identity
```

It writes `apps/<name>` (a one-form example: book a service, with an account number and a date of birth under `--identity`), links it into the workspace, and prints the next steps. It passes `pnpm check`, its tests and its regression as created. Move your worksheet into `apps/<name>/DESIGN.md` now. Then read the new folder's `README.md`, `CLAUDE.md` and `src/app.ts`: they say what each file is for, and the example shows the shape of a confirmed write and (with `--identity`) of a form that steps the caller up.

Replace the example one piece at a time, running `pnpm check` after each change:

1. `app.yaml`: the brand, `console.formLabels` and `slotLabels`, `voice.hints`, `wording.addressee`.
2. `intents.yaml`: your intents (form, informational); keep `agent` and `repeat_prompt` (required) and the other control intents; the keypad menu.
3. `slots.yaml`: your slots, from the mapping. Keep `accountId` and `dob` if your factors are an account number and a date of birth.
4. `forms.yaml`: your forms, their slots, their summary prompts and their hooks.
5. `policy.yaml` and `identity.yaml`: from the mapping.
6. `src/data.ts` and `src/app.ts`: the fixture data, the tools, the form hooks, and what the code declares for the gate (`systems`, `lookups`, `customRules`, `principals`, `portal`, `identity.sendCodeParams`, `blockPromptId`). See step 4 and [patterns.md](patterns.md).
7. `prompts.yaml`: every line `pnpm check` asks for, and your forms' own lines.
8. Remove the example's intent, form, slot, tool and lines, and update `src/app.test.ts` (it asserts the example's intents) and `testing.heuristics` in `src/app.ts` (the keywords the text console's heuristic stub listens for).

How to read `pnpm check`. Each problem is one line, `file:line:column  path  message  ->  fix`. Act on the text after `->`. Fix from the top down: a schema problem (an unknown key, a wrong type) stops the cross-checks against the code until it is fixed, and one typo can show up in several places (a misspelt slot gives an unknown slot and its missing `ask_` lines). Run it again after each fix; `pnpm check --json` gives the same problems as JSON.

What `pnpm check` does not see: the corpus beyond "every intent has examples" (the regression checks the rest, step 5), and the lines your own code names (a `handoff(s, '<reason>', acks)` says `handoff_<reason>` with hyphens as underscores; a `blockPromptId` line; a completion's line; a summary variable that no slot holds). Add those yourself. The regression stops with an error such as `unknown prompt id: <id>` or `prompt variable missing: <name>` when one is missing.

## Step 4: Tools as stubs over fixture data

- Each tool's `run` reads or writes the in-memory `Systems` and the fixture data in `src/data.ts`, and returns `{ value, summary }`. Invented records only: names, 555 numbers, invented streets, amounts written as plain decimals (`240.00`). A real client replaces the stub later; keep the tests on the stub.
- No `if` about who is calling, their level, a limit or a date inside a tool. If you find yourself writing one, it is a rule: put it in `policy.yaml`, or, when no built-in rule fits, write it with `defineRule` (with an example the gate allows and one it refuses) in `code.customRules` and name it with `custom:` ([patterns.md](patterns.md#bounds-limit-and-dateinrange)).
- The gate's lookups are code: `systems()` returns `lookups.scopeOf` (the subject ids a principal may see: a subject their own id, a delegate the subjects they act for, an anonymous caller none), `lookups.ownerOf` (the subject a record belongs to, or null), and each lookup a range rule's bound names (also listed in `code.lookups`). The scaffold's `scopeOf: () => []` fails every `scope` rule: replace it when you add one.
- A form's `complete` calls its tool through `c.callTool`, never the tool directly, and turns the gate's decision into a line: `ALLOW` to the form's own line, anything else through `c.refusal(decision)` (a `blockPromptId` line, or a person). [patterns.md](patterns.md#refusals-and-handoffs) has each case.

## Step 5: The corpus and the scenarios

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
- each refusal: out of scope, each bound (`limit`, `dateInRange`, each custom rule), each refused role;
- each handoff: on request (at the start and inside a form), by role, by a rule;
- keypad entry for each slot with a keypad, and for the one-time code;
- each informational answer.

## Step 6: Iterate until green, then make the baseline once

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

It ends with `pass` or `FAIL ...` and `baseline: no changes` or the differences. Read the transcript rather than writing a script over the harness. While you build, the baseline is still the example's, so your lines are `new`, the example's are `removed`, and the app's `fixtures.test.ts` fails on its baseline comparison. That is expected. What must be clean before you make the baseline: `pnpm check`, the type check, every other test, no `FAIL scenario` line, and no error loading the corpus (a duplicate text, a label a question cannot give, `as` outside `no_form`).

Then make the app's own first baseline, once:

```sh
pnpm --filter @dialogwright/example-<name> regress --update
```

and read `fixtures/expected/corpus.json` and `scenarios.json` entry by entry against the worksheet. For each entry: is `promptId` the next thing the caller should hear (the next slot's `ask_`, the summary, `anything_else`, `ask_intent` after an informational answer)? Is `gate` the action you expect, with the verdict the worksheet's who-may-do-what says? Are `slots` the values the line gives? A `STEP_UP` or `ask_otp` on a line spoken inside a form usually means the seeded caller's level is lower than the form needs ([corpus.md](corpus.md#lines-spoken-inside-a-form)).

Never run `--update` again. When the review finds a wrong outcome, fix the app or the line; the regression then shows `~` lines for the entries that changed. Check they are exactly the ones you meant to change, edit those values in `fixtures/expected/*.json` by hand, and note each edit and its reason in the worksheet. From then on a changed output is a finding to explain, never noise to overwrite.

Add the app's regression to CI: `- run: pnpm --filter @dialogwright/example-<name> regress` in `.github/workflows/ci.yml`, after the clinic's. Commit `pnpm-lock.yaml` with the app: CI installs from it, frozen.

## Step 7: Read the policy back

Check what the gate will decide against the worksheet's who-may-do-what, not against what you meant to write. Add `testing.policyMatrix` and the policy tests in [patterns.md](patterns.md#testing-the-policy), then write the policy matrix:

```sh
pnpm policy:matrix apps/<name>
```

`apps/<name>/policy.matrix` lists, under each action, what the gate decides for each kind of caller (anonymous, the subject at each level, each delegate role, a role the policy does not name, ...) and why, then each custom rule's examples. Read it beside the worksheet's "Who may do what", cell by cell: every allowed, refused and to-a-person cell should be there, decided by the rule you expect. Then check each bound at its edges with the per-action test. If the repository also has a policy card or diagram command by the time you read this (look for `policy:card` in `package.json` and `CLAUDE.md`), read its output the same way.

Fix every mismatch in the YAML (or in the worksheet, if you misread the paragraph), write the matrix again, read its diff, and run step 6's commands again. Once it is right, the matrix is a golden like the baseline: rewrite it only for a policy change you meant.

## Step 8: The final checklist

Tick the checklist at the end of the worksheet ([worksheet.md](worksheet.md#final-checklist)), in the worksheet itself. In short: every intent has corpus lines and a scenario; every action has a policy entry, a row in `policy.matrix` you have read, and its bounds tested at their edges; identity matches the paragraph; nothing private or real; `pnpm check`, `pnpm verify` and every app's regression green; the README describes the app and keeps the recording steps the scaffold wrote; the gaps are written up. Then commit, with the worksheet.

## When something doesn't fit

The paragraph may ask for something the framework does not do, or does differently. Then:

1. Write it in the worksheet's Gaps section: what the paragraph asks, what the framework does, what you did instead, and what it cost you (time, a wrong turn, an unclear message).
2. Work around it inside the app: a custom rule, a slot in code, a different form shape, a fixed line. [patterns.md](patterns.md#known-gaps) lists the gaps known so far and their workarounds.
3. Do not modify `packages/dialogwright` (its code, templates or docs), and do not weaken a check, a test or a baseline to get past it. If there is no workaround, leave that part out, say so in the worksheet, and finish the rest.

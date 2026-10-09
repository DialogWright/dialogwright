# Your first app

> **Being tried.** Before this page is final, its paragraph is being given to fresh AI coding assistants, with no other context, as the earlier [trials](trials/README.md) were, and what they stumble on changes the page, the skill or the framework. Until then a step may read differently from what you see; where it does, the skill's own words are the ones to follow.

This page builds a first app with an AI coding assistant, from one paragraph: a phone line for a small home services company. You give the assistant the paragraph and the [create-app skill](../.claude/skills/create-app/SKILL.md); it plans the app, writes it and tests it until everything is green, with no keys. Then you run it, record it against the real decision model with your own key, call it, and change the paragraph for your own business.

You need Node 22.19 or later, pnpm, and an AI coding assistant that can read and change files and run commands in a folder (Claude Code finds the skill in `.claude/skills/` by itself; another assistant is pointed at the file, as the prompt below does). Building it and running it need no account and no key.

## The paragraph

The business is invented, and so is every name, town and number the app will hold.

> Build a phone assistant for Example Home Services, a small company whose technicians do plumbing, heating and electrical repairs in people's homes. Callers can book a repair visit: they say which kind of repair, describe the problem in a few words, and choose a day in the next 30 days and a morning or afternoon window. We only work in Alder Creek, Birchwood and Cedar Falls, so ask the town first and tell a caller from anywhere else that we don't serve their area before asking anything more. Read the visit back and have the caller confirm it before it is booked, then offer to text a reminder the day before to the number they are calling from. Existing customers can hear when their next visit is, or cancel it; for either they verify with their customer number (eight digits, on every invoice) and the ZIP code of the home, and a cancellation is read back and confirmed first. A caller with an emergency (water they can't stop, no heat, sparks or a burning smell) goes straight to the technician on call, even in the middle of booking; anyone who smells gas is first told to leave the house and call the gas company from outside. Billing questions go to the billing desk, and anyone can ask for a person at any time. The office is open Monday to Friday 8 to 6 and Saturday 9 to 1: outside those hours the line says so when it answers, still books visits and puts emergencies through, and sends a caller who asks for a person to the answering service.

It is short, and it asks for most of what a real line needs. Each sentence lands on a part of the framework:

| The paragraph says | What it becomes | Where the guide has it |
|---|---|---|
| book a repair visit: the kind, the problem, a day, a window | a form with a `choice`, a `text`, a `date` and a `choice` slot, and a tool that books | [forms.yaml](guide/02-the-files-one-by-one.md#formsyaml), [slot types](slots/README.md) |
| a day in the next 30 days | a `dateInRange` rule on the booking | [3.3 The built-in rules](guide/03-policy-and-identity.md#33-the-built-in-rules) |
| only these three towns, asked first | a check that ends the form for a caller from anywhere else | [Checks](guide/02-the-files-one-by-one.md#checks-ending-a-form-part-way) |
| read back and confirmed before it is booked | a summary, and a `confirmed` rule | [3.3](guide/03-policy-and-identity.md#33-the-built-in-rules) |
| offer to text a reminder to the number they are calling from | a text offer on the caller's number, and the `callerNumber` rule | [A text offer](guide/05-writing-a-slot.md#a-text-offer-onno-and-ifnone) |
| customer number and ZIP code | an identity ladder of one level, two `digits` factors and a verify tool | [3.6 The identity ladder](guide/03-policy-and-identity.md#36-the-identity-ladder) |
| hear the next visit, or cancel it | a read and a confirmed write behind identity, each held to the caller's own records (`scope`) | [3.2 An action and its rules](guide/03-policy-and-identity.md#32-an-action-and-its-rules) |
| an emergency, even in the middle of booking | a priority intent that hands off at once | [Must never wait](guide/02-the-files-one-by-one.md#must-never-wait-priority) |
| told to leave the house first | the handoff's own fixed line | [prompts.yaml](guide/02-the-files-one-by-one.md#promptsyaml) |
| the technician on call, the billing desk, the answering service | transfer targets, chosen by the handoff's reason and the hours | [13.15 Where a handoff goes](guide/13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer) |
| open Monday to Friday 8 to 6, Saturday 9 to 1 | app.yaml's `hours`, and a start route that says the office is closed | [Business hours](guide/02-the-files-one-by-one.md#business-hours-hours), [routes.yaml](guide/02-the-files-one-by-one.md#routesyaml-optional) |

The assistant decides each of these itself, from the skill; the table is so you can check its work.

## Where it is built

Two places, and the skill serves both:

- **In this repository.** Clone it and install (`git clone https://github.com/DialogWright/dialogwright.git`, `cd dialogwright`, `pnpm install`), and start the assistant at the repository's root. The assistant runs `pnpm create-app` itself, and the app is `apps/home-services`. This works today.
- **In a project of your own**, on the `dialogwright` package: `npm create dialogwright@latest home-services -- --identity --display "Example Home Services"`, then `cd home-services` and `npm install`, and start the assistant in that folder. The project is already scaffolded, with the skill in `.claude/skills/create-app/` and the guide in `node_modules/dialogwright/docs/`, and its commands are `npx dialogwright <command>`. This needs the packages on npm, which they are not yet ([Status](../README.md#status)); until they are, build in this repository.

The commands below are written both ways: in this repository first, then in a project of its own.

## What to give the assistant

This, whole, with the paragraph:

```text
Build the app this paragraph describes, using the create-app skill in
.claude/skills/create-app/SKILL.md. Call the app home-services.

Build a phone assistant for Example Home Services, a small company whose technicians do plumbing, heating and electrical repairs in people's homes. Callers can book a repair visit: they say which kind of repair, describe the problem in a few words, and choose a day in the next 30 days and a morning or afternoon window. We only work in Alder Creek, Birchwood and Cedar Falls, so ask the town first and tell a caller from anywhere else that we don't serve their area before asking anything more. Read the visit back and have the caller confirm it before it is booked, then offer to text a reminder the day before to the number they are calling from. Existing customers can hear when their next visit is, or cancel it; for either they verify with their customer number (eight digits, on every invoice) and the ZIP code of the home, and a cancellation is read back and confirmed first. A caller with an emergency (water they can't stop, no heat, sparks or a burning smell) goes straight to the technician on call, even in the middle of booking; anyone who smells gas is first told to leave the house and call the gas company from outside. Billing questions go to the billing desk, and anyone can ask for a person at any time. The office is open Monday to Friday 8 to 6 and Saturday 9 to 1: outside those hours the line says so when it answers, still books visits and puts emergencies through, and sends a caller who asks for a person to the answering service.
```

The paragraph names the business, so the skill has one less thing to ask. A paragraph that names none gets one question before anything is written: the business name, which every caller hears in the greeting ("Thanks for calling ..."). Everything else the paragraph leaves open, the assistant decides and writes down for you to read.

## What it asks, and what it produces

The skill is a procedure in steps, each ending in something checked. What you will see, in order:

1. **The worksheet** (`DESIGN.md` in the app's folder): every sentence of the paragraph as rows (the intents, each with example phrasings; the information each needs; the actions and who may take each; what is confirmed; the bounds; what goes to a person), the decisions that lead to each option, and "Choices the paragraph left open". This paragraph leaves some open on purpose: the time zone of the hours, how many tries a caller gets, what the reminder text says, what happens to a caller who fails verification. Read those choices: they are where your business may differ from the assistant's guess.
2. **The app folder**, scaffolded with `--identity` (the next visit and the cancellation need a verified caller) and then rewritten from the worksheet: `app.yaml`, `intents.yaml`, `forms.yaml`, `slots.yaml`, `prompts.yaml` (every line a caller can hear, word for word), `policy.yaml`, `identity.yaml`, `routes.yaml`, and `src/app.ts` with the tools as stubs over invented records in `src/data.ts`.
3. **The corpus and the scripted calls**: `fixtures/corpus.jsonl`, labelled lines a caller might say (eight or more for every intent, five answers for every question), which the stub decision model answers from; and `fixtures/scenarios/`, whole calls with the outcome each expects (each form start to finish, each refusal, each handoff, the keypad, the reminder offer declined, a caller from another town, an emergency in the middle of booking, a call after hours).
4. **Green, with no keys**: `pnpm check`, the type check, the tests and the regression, until each is clean; then the app's first baseline, made once and read entry by entry.
5. **The policy read back**: `policy.matrix` (what the gate decides for every action and every kind of caller), `POLICY.md` (the policy card, in plain English with diagrams) and `APP-MAP.md` (the intents, forms, slots, actions, rules and routes as diagrams). The assistant reads them against the worksheet; read `POLICY.md` yourself against the paragraph, sentence by sentence.
6. **The adversarial suite**, on from the scaffold: hostile calls generated from the app (announced injections, a caller claiming to be someone they have not proven, requests the line does not handle, every tool replying with instructions in its reply), each held to what must hold whatever the wording. The regression prints `adversarial N/N cases hold`.
7. **The final checklist**, ticked in the worksheet, and a short list of what is left for you: the recording command, and the transfer targets' variables to set before the server starts (below).

How long it takes depends on the assistant and the paragraph. The earlier trials, on other paragraphs, reported 11 and 15 minutes to a green app by the assistants' own count ([trials](trials/README.md)); this paragraph has not been timed yet.

## Run it, with no keys

In this repository, at the root:

```sh
pnpm check
pnpm --filter @dialogwright/example-home-services test
pnpm --filter @dialogwright/example-home-services regress                    # "no changes", then the summary
pnpm --filter @dialogwright/example-home-services regress --scenario <id>     # one scripted call, turn by turn
pnpm --filter @dialogwright/example-home-services cli --client heuristic      # a text console
```

In a project of its own, in its folder:

```sh
npx dialogwright check
npm test
npx dialogwright regress
npx dialogwright regress --scenario <id>
npm run cli -- --client heuristic
```

The text console prints, for each thing you type, the questions the model was asked, what came back, the gate's decision and the line the caller hears. `--client heuristic` answers from keywords the app lists, so it understands less than the real model: it is for walking the paths, not for judging the understanding. That is what a recording is for.

## Record it

The stub answers from the corpus's labels, which the assistant wrote. A recording asks the real decision model the same questions once and keeps its answers in a cassette, so every later run replays them offline, for free. Recording calls a paid API with your key, so it is yours to run, never the assistant's; the scaffold's README puts an app of this size at a few cents.

1. Put the model key in the app's `.env` (git-ignored, readable by you alone). `pnpm configure --app home-services` (in a project, `npx dialogwright configure`) asks for it with the echo off and writes the file; or copy the folder's `.env.example` to `.env` and put the key in it (`TYPESAFE_API_KEY`, or another provider's, which `.env.example` lists).
2. Record, with the one command the assistant hands you. `regress` reads the folder's `.env` itself:

   ```sh
   pnpm --filter @dialogwright/example-home-services regress --client record --threshold JEV_TIMEOUT_MS=15000   # in this repository
   npx dialogwright regress --client record --threshold JEV_TIMEOUT_MS=15000                                    # in a project of its own
   ```

3. Replay it offline (`regress --client recorded`), and give the assistant the result: step 9 of the skill triages each place the real model read a line differently from its label, and brings you what needs your decision.

## Call it

`pnpm configure` (`npx dialogwright configure`) again, choosing a phone line this time: the carrier (Telnyx or Twilio, with a number) and its key, the model and its key, and the number for a person. Then add each transfer target's variable to the same `.env`: the assistant names them (the technician on call, the billing desk, the answering service), each an E.164 number or a `sip:` address. The server refuses to start while one is unset, and `pnpm diagnose --app home-services` (`npx dialogwright diagnose`) says which.

```sh
pnpm start --app home-services --tunnel quick      # in a project of its own: npx dialogwright start --tunnel quick
```

It opens a Cloudflare quick tunnel (install `cloudflared` first), starts the server with the app's `.env`, and prints the webhook URL to paste into your number at the carrier. Call the number. The [README's "Answer a real phone call in an hour"](../README.md#answer-a-real-phone-call-in-an-hour) has the same steps, [section 14 of the guide](guide/14-running-it.md) every option, and the website's guide, [running your own IVR on a machine you own](https://dialogwright.com/guides/home-server.html), a line that stays up.

## Make it yours

Change the paragraph and build again, in a new folder (another name), or give the assistant the change and the existing app: the skill's steps hold either way, and the check, the regression and the policy read back show what the change did.

A paragraph that builds well says, in plain words:

- **What callers can ask for**, each task in a few words, and the questions with one fixed answer ("when are you open").
- **What each task needs**: the pieces of information, and their shape where it matters ("eight digits", "a day in the next 30 days", "a morning or afternoon window", a list you can write down).
- **Who must verify, and how**: which tasks need it, and the factors ("the customer number and the ZIP code of the home"); a one-time code texted to the phone on file for a task that needs more.
- **What is confirmed before it is done**, and the bounds ("within 30 days", "no more than they owe").
- **What rules a caller out**, and when to ask it ("ask the town first").
- **What goes to a person**, and where ("the technician on call", "the billing desk"); people acting for others, if any, and what they may and may not do.
- **When the line is open**, and what changes outside those hours.
- **The business name**, or the assistant will ask for it.

Keep it to one paragraph: what is not in it, the assistant decides and writes down, and you read those decisions in the worksheet. Every name, number and record in this repository is invented (phone numbers in the 555 range); in a project of your own, replace the stubs with your systems once the app is right, never before, and keep the tests on the stubs.

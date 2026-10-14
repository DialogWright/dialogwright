# Authoring an app

This guide is for a developer, or an AI coding assistant, who is building a DialogWright app or changing one. It says what an app is made of, what goes in each file, how policy and identity are written, tested and reviewed, what stays in TypeScript and why, how to write a slot, how `pnpm check` finds mistakes, how locales and configuration hashes work, how an app answers general questions from a knowledge base of approved passages, how it is served on the phone and the web (carriers, languages, web chat, sign-in and the widget), and how it runs on a machine you own (the first hour with two keys, then a machine that stays on, survives its own restart and lets its owner look at calls from a phone). Read [CLAUDE.md](../../CLAUDE.md) first for the rules (the gate decides, a line is generated only where the app asks for it and a prescribed line never is, an app imports only from `'dialogwright'`).

Two apps in this repository are the examples, and the snippets in its chapters are copied from them, except where a snippet says it is only an illustration:

- `apps/clinic`: Example Family Practice, a fictional appointment line. Five forms, no identity verification, scheduling hooks. Its README has a section, "The app as a folder", with more detail.
- `packages/dialogwright/src/define/fixture/`: Example Town Library, a tiny app (three forms, one rule of its own, a Spanish locale) that the engine's own tests build. It is the smallest complete app, so the snippets here come mostly from it. Section 3 also draws on the engine's own test app, Example Parcels, which has the full identity ladder and delegates.

## Contents

The guide is long, too long to read in one go: each section is a chapter of its own, a file in this folder, and is read one at a time, from the list below. Building an app with the [create-app skill](../../.claude/skills/create-app/SKILL.md), read only the sections each of its steps names. `grep -n -E '^(# [0-9]|##)' docs/guide/*.md` lists every heading with its file and line. The guide was one page, `docs/authoring-an-app.md`, until it was split into these chapters; that page now lists each of its old sections with a link to its place here, so a link to it still leads somewhere.

1. [The folder](01-the-folder.md)
2. [The files, one by one](02-the-files-one-by-one.md): [app.yaml](02-the-files-one-by-one.md#appyaml) (with [`callerNumber`](02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber)), [intents.yaml](02-the-files-one-by-one.md#intentsyaml) (with [`unsure`](02-the-files-one-by-one.md#when-the-model-is-unsure-unsure) and [`priority`](02-the-files-one-by-one.md#must-never-wait-priority)), [forms.yaml](02-the-files-one-by-one.md#formsyaml) (with [checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)), [prompts.yaml](02-the-files-one-by-one.md#promptsyaml), [policy.yaml](02-the-files-one-by-one.md#policyyaml), [identity.yaml](02-the-files-one-by-one.md#identityyaml-optional), [routes.yaml](02-the-files-one-by-one.md#routesyaml-optional) (with [business hours](02-the-files-one-by-one.md#business-hours-hours)), [slots.yaml](02-the-files-one-by-one.md#slotsyaml-optional), [fixtures/](02-the-files-one-by-one.md#fixtures-optional), [kb/](02-the-files-one-by-one.md#kb-optional)
3. [Policy and identity](03-policy-and-identity.md) (its own list of thirteen subsections is at its head)
4. [What stays in TypeScript, and why](04-what-stays-in-typescript-and-why.md)
5. [Writing a slot](05-writing-a-slot.md): [Pick a type](05-writing-a-slot.md#pick-a-type-in-slotsyaml), [Every slot listens on every turn](05-writing-a-slot.md#every-slot-listens-on-every-turn), [Where a slot listens](05-writing-a-slot.md#where-a-slot-listens-listen), [A callback number](05-writing-a-slot.md#a-callback-number-callernumber), [A text offer](05-writing-a-slot.md#a-text-offer-onno-and-ifnone), [Proposing a value from a lookup](05-writing-a-slot.md#proposing-a-value-from-a-lookup-offer-facts), [When a slot runs out](05-writing-a-slot.md#when-a-slot-runs-out-attempts-and-onmaxattempts), [Thresholds](05-writing-a-slot.md#thresholds), [When no type fits](05-writing-a-slot.md#when-no-type-fits-a-slot-in-code), [The contract](05-writing-a-slot.md#the-contract), [The keypad](05-writing-a-slot.md#the-keypad), [Sensitive values](05-writing-a-slot.md#sensitive-values), [Testing a slot](05-writing-a-slot.md#testing-a-slot)
6. [The form hooks](06-the-form-hooks.md), and [the start hook, predicates and `failSoft`](06-the-form-hooks.md#the-start-hook-predicates-and-failsoft)
7. [Checking an app: `pnpm check`](07-checking-an-app-pnpm-check.md)
8. [Locales](08-locales.md)
9. [Configuration hashes](09-configuration-hashes.md)
10. [Editor support](10-editor-support.md)
11. [Walkthroughs](11-walkthroughs.md)
12. [The knowledge base](12-the-knowledge-base.md)
13. [Channels](13-channels.md)
14. [Running it](14-running-it.md)
15. [The adversarial suite](15-the-adversarial-suite.md)
16. [Generated wording](16-generated-wording.md) (opt-in): [when to use it](16-generated-wording.md#161-when-to-use-it-and-when-not), [summarizing what a caller said: a framed line](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line), [the checks](16-generated-wording.md#166-the-checks-and-the-fallback), [running it](16-generated-wording.md#167-running-it), [measuring it](16-generated-wording.md#168-measuring-it), [choosing a model](16-generated-wording.md#1612-choosing-a-model), [measuring the judge](16-generated-wording.md#1613-measuring-the-judge)

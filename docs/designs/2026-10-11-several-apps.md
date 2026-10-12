# Several apps on one deployment (design, for review)

Date: 2026-10-11. Status: **decided (the maintainer, 2026-10-11); to be built after Phase 8b and before the console.** Source: the maintainer, 2026-10-11: clients where each phone number (the number called, often called the DNIS) launches a different app; a self-hosted deployment with one owner; calls from Telnyx and Twilio at once, many numbers on each; no transfers between apps yet.

## At a glance

Today a server runs one app: the engine keeps a registry of apps and every session records its app's id, but the server registers one app and sends every call to it. This design lets one deployment (one server, or many under Phase 8b) run several apps and choose the app for each call by the number called, with a default for a call that names no number. Each app stays a folder of its own, with its own policy, prompts, tests, traces and audit. Nothing changes for a deployment that runs one app.

## The hosting file

```text
# host.yaml, beside the apps (or named by HOST_FILE)
apps:                                            # each app is known by the id its own app.yaml gives it
  - apps/utility
  - apps/clinic
  - { package: "@acme/repairs-line" }            # an app installed as a package
numbers:                                          # the number called -> the app's id; several numbers may name one app
  - { number: env.POWER_LINE,  app: utility }
  - { number: env.CLINIC_LINE, app: clinic }
  - { number: env.CLINIC_LINE_ES, app: clinic }
default: utility                                  # a call with no number, or a number listed nowhere
# web chat chooses its app by path: /chat/<app id>
```

## Decisions proposed

1. **One owner, one set of carrier accounts.** `VOICE_PROVIDERS=twilio,telnyx` already takes calls from both at once, each with its own secret; every number on either carrier points its webhook at the same server. Separate accounts per app (a hosted, many-customer product) are out of scope.
2. **The number chooses the app.** The number called, as each carrier delivers it (the same normalising as the `called` route condition), is looked up in `numbers`; an exact match picks the app, anything else goes to `default`. Numbers stay in the environment, never in YAML. A number listed for two apps is refused at start. An app's `voice.numbers` (number to language) keeps working inside the app.
3. **Settings in two layers.** The server's settings file holds what is shared (carrier secrets, the model and its key, `PUBLIC_HOST`, the stores). Each app may keep a settings file of its own for its own variables (its transfer targets, `startParameters`, `called` numbers), read only for that app, so `env.BILLING_NUMBER` in two apps can mean two numbers. `pnpm diagnose` checks every app's variables.
4. **Records per app.** Traces and audit go to a folder (or key prefix, or Postgres schema column) per app; the audit's chain stays per session, so nothing forks. The console shows every app's calls with an app filter and the app's name on each row; Insights can be read per app or together.
5. **Chat by path.** The engine's web chat serves each app at its own path; the widget names it (`data-app`), defaulting to the default app.
6. **No transfers between apps.** A call starts and finishes in its app. A transfer to a person works as today, with each app's own targets.
7. **Commands.** `pnpm start` takes `--host <file>` (or finds `host.yaml`), and `--app` keeps its meaning for one app. `pnpm configure` can add an app to a host file. `pnpm check` checks the host file (every app exists and passes its own check, no number twice, the default is an app).
8. **One app stays the simple case.** With no host file, a server runs its one app exactly as today.

## Decisions (the maintainer, 2026-10-11)

1. **Numbers live in host.yaml**, each pointing at an app by the id its own app.yaml gives it, so several numbers pointing at one app (likely common) is one line each and the app folder names no number. host.yaml lists the apps by folder or package; app.yaml defines the app.
2. **Settings in two layers:** each app's settings are its existing `.env` (so `pnpm configure` keeps working per app); what every app shares (carrier secrets, the model and its key, `PUBLIC_HOST`, the stores) is in a server-level settings file.

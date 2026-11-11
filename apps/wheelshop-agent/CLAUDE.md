# Example Wheel Works on the converse runtime: notes for AI coding assistants

Example Wheel Works is a fictional wheel repair shop's line, rebuilt on the **converse runtime** ([the design](../../docs/designs/2026-11-11-agent-runtime.md)): a model holds the conversation from the shop's own file, `agent.yaml`, and the runtime owns what is done. The line speaks as the business ("we", "the shop"), never as a named person. A dealership account, recognized by the number it calls from, books cars straight into a drop-off window; any other caller sends the shop a request with a drop-off window, which the shop prices from a photo; a caller who wants to speak with someone leaves a callback note. The old agent-mode app, `apps/wheelshop`, stays until plan 3 removes it; this one copied its business facts and its shop code. Read the repository's root `CLAUDE.md` first for the rules, then this folder's `DESIGN.md` (the demo's assumptions, the findings and every choice) before changing anything.

## How a converse app differs

- **`agent.yaml` is the business.** Who the shop is, how it sounds (`persona.style`), its services with ballpark price ranges and the caveat said with any of them (`priceCaveat`), what it does not do, its facts, the lines said word for word (greeting, closing, recovery, handoff, done), the model, its calendar's days and windows, its accounts, and its actions. Each assumption is marked `# assumption: the owner corrects these`. `app.yaml` only names the app (`mode: converse`) and its chat settings. `pnpm check` refuses any scripted file (intents, forms, prompts, policy, style.yaml) beside them.
- **The model talks; the runtime decides.** The model (agent.yaml's `model.default`, Mercury 3 on Inception at `effort: minimal`, until the model comparison decides) words every reply and calls the actions. The runtime checks each call's values by type (a slot must be one its lookup returned on this call: a window from `check_availability`, a dealership's account from `recognise_caller`; a phone a number, or `caller` for the number calling), puts it to the gate (every decision and every result audited), reads every change back in agent.yaml's `readBack` words (a number the caller gave whole, the number calling by its last four), and runs it only on the caller's yes, read by the decision model. `send_request`'s and `book_dealer`'s follow-ons (`then`) run on the same yes, each still through the gate: the photo text only where `textOk` is yes (a `oneOf` rule, `no-consent`), and the shop's summaries. The model is never offered a follow-on.
- **Nothing holds a reply before it is spoken** (the design's "Claims"): prices, services and policies may come only from agent.yaml, and times only from a lookup on the call. The simulated callers measure how often the model says something else.

## The folder

- `agent.yaml`, `app.yaml`: above. `app.yaml`'s `chat.callerNumberFromContext` is false: a chat names no number it calls from, or any page could claim a dealership's account. The simulated callers' own server turns it on for itself alone (`pnpm eval`), so the dealership persona is recognised by the number it names. agent.yaml's `env.DEALER_TEST_LINE` is read by the server from the app's own settings as it starts.
- `src/app.ts`: the actions' code (`shopTools`), the incoming-text hook (`shopOnText`) and `wheelshop(options)`, which makes the app with its own systems (one per server, one per test, one per simulated call: `app.fresh`), reading nothing from the process. Each action is a `ConverseToolImpl`: it gets the checked params and `ctx` (`key`, the write's idempotency key, passed to every write; `texts`, the server's sender or null; `caller`, the number whole and the account; `env`, the app's settings). The shop's phone is the setting `SHOP_PHONE`, read with `ctx.env`, never in the folder.
- `src/shop.ts`: the shop's systems, copied from the old app: the shop's fake calendar (agent.yaml's windows and capacity, Friday morning full from a standing drop-off, a request holding its place until it is quoted), the records, the texts, the quotes, each write once for its key, and the shop's log. `src/shopTexts.ts`: the texts the code sends, in the shop's fixed words (agent.yaml has no place for them).
- `src/shopPage.ts`, `src/shopLog.ts`, `src/quotes.ts`: the shop page (`/wheelshop-agent/shop`, `auth: 'console'`, never public), made by the server as it starts with the app's settings and sender (`ConversePageDeps`), its append-only log (`SHOP_DATA_DIR`), and quote and confirm, copied from the old app with their tests (`src/shop.test.ts`, `src/quotes.test.ts`).
- `src/index.ts` (the app the server, host.yaml and the eval import; it reads no setting as it is imported), `src/serve.ts` (`pnpm serve`).
- `src/app.test.ts`: the actions through the runtime, with `converseTestCall` and a scripted model (`dialogwright/testing`): no real model, text or calendar.
- `eval/personas.yaml`: the simulated callers (copied from the old app; the dealership calls from its number). `pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml --runs 3 --budget 3` is the author's step, with their keys; each call runs on a server of its own, on the app made fresh. [The latest run's summary](../../docs/designs/eval/2026-11-wheelshop-agent-mercury/summary.md) and DESIGN.md's findings are its triage.

## Commands

Run these at the repository root.

```sh
pnpm check
pnpm --filter @dialogwright/example-wheelshop-agent typecheck
pnpm --filter @dialogwright/example-wheelshop-agent test
pnpm --filter @dialogwright/example-wheelshop-agent serve      # the chat and the console (a converse app takes no calls yet)
pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml --runs 3 --budget 3   # the author's step: real models, the author's keys
```

## Rules for this app

- A change to what the shop does, claims, charges, books or collects is an edit to `agent.yaml`, never to code. Keep each assumption marked until the owner confirms it.
- A caller is texted only with their consent: `textOk`, read back, and the gate's `oneOf` rule on `send_photo_request`. Never send a caller a text from an action without such a rule, and never check consent in code. The documented exception: `onText` and the shop page are no call's actions, so no gate holds them; their code sends the thank-you, the quote and the booking's text only to the number on file of a request that said yes to texts (the old app's rule, copied).
- Never put policy in tool code. Which account may book is held by the runtime (`book_dealer`'s account is a slot from `recognise_caller`), never by the action's code.
- A shortfall the simulated callers find is a finding: fix `agent.yaml`'s wording or report a runtime defect, never change a persona to pass.
- The line speaks as the business; no line, fact or description names a person.
- The shop page and the log hold callers' numbers whole: the route stays `auth: 'console'`, the log never in the repository.
- Fictional data only: invented names and dealerships, the 555 range, example.com. Never a key in a file.

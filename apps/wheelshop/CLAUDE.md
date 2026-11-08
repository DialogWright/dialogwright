# Example Wheel Works: notes for AI coding assistants

Example Wheel Works is the DialogWright demo of **agent mode**: a fictional one-man wheel repair shop's line, where a model leads the conversation from the shop's facts and the engine decides what is done. A dealership account, recognized by the number it calls from, books cars straight into a drop-off window; any other caller sends Sam (the owner) a request, which he quotes from a photo; a caller who wants Sam leaves a callback note. Read the repository's root `CLAUDE.md` first for the rules, then this folder's `DESIGN.md` (the demo's assumptions and every choice) and [the agent-mode design](../../docs/designs/2026-11-08-agent-mode.md) before changing anything.

## How an agent-mode app differs

- **One file is the app.** `business.yaml` holds everything about the shop the line may use: who it is and how it sounds (`business.voice`, the owner's sample replies in `business.examples`), its services, what it doesn't do, its claims, the price line, where it is, its days and windows, its accounts, what a request, a booking and a callback note collect (each field a library slot type with a fixed question), each read-back and done line, the handoff, the closing and the owner's summary. The engine builds the intents, forms, slots, prompts, policy and identity from it. There is no `intents.yaml`, `forms.yaml`, `prompts.yaml`, `slots.yaml`, `policy.yaml` or `identity.yaml`, and `pnpm check` refuses one beside `business.yaml`.
- **The model proposes, the engine decides.** The model (style.yaml's `agent`: Mercury 3 on Inception at `instant`) understands the values and words the replies. Each value is checked by its field's slot type; each reply is held to the facts by the checks (no figure or web address the facts don't hold, one question, the word budget) and the drift judge, and replaced by the field's fixed question when one fails. The read-backs, the done lines, the price line, the handoff and the closing are always said in `business.yaml`'s words. Every action goes through the gate, only after the caller says yes to the read-back. The model never calls a tool.
- **The conversation is sent to the agent model** (the maintainer's decision 1): so no field may be an identity factor (no `birthdate`), and no `text` field may be `length-summarized`.
- **Tool results the model sees** (`sees: availability` on each form's `day`; decision 2): the day and its free windows, checked in a closed form. A tool whose result the model sees never has a `text()` check.

## The folder

- `business.yaml`: the shop's facts. Each demo assumption is marked `# assumption: the owner corrects these`; DESIGN.md lists them.
- `app.yaml` (`mode: agent`, `testing: { adversarial: on }`), `style.yaml` (the agent model and the reply's word budget on a call).
- `policy.matrix`, `POLICY.md` and `APP-MAP.md`: what the engine built, read back, generated from `business.yaml`; `src/app.test.ts` fails when one differs from what the app generates.
- `src/app.ts`: the tools, each a stand-in. `availability` (the stand-in calendar, two windows a weekday with business.yaml's capacity, Friday morning full from a standing drop-off; its reply checked closed), the writes `request`, `book` and `callback`, and the texts `send_photo_link`, `notify_owner_request` and `notify_owner_booking` (printed, never sent, until texting is registered; the server and the text CLI print them, the tests and the regression stay quiet). Every write is idempotent on `ctx.idempotencyKey` and declares a reply `check`. The code reads `business.yaml` with `loadBusiness` for the windows' capacity, the days, the accounts and the owner's number and summary, so a change to the file is never a change to code.
- `fixtures/scenarios/` (`demo.json`: the two demo calls and a correction at the read-back; `focus.json`: the build plan's review focus, a price pushed, a claimed account, a full window, a request said over the greeting, and a callback note). The calls whose middle turns would depend on the order the model asks in (`dealer-trade-ins`, `correction-at-read-back`, `retail-bmw`, `window-full`, `claimed-account`) answer what the line asks (`answers`, by the question: `request_day`, `readback_request`, a list for a question answered in turn), after their opening `steps`. Each spoken step names the agent's answer (`agent`: its reply, its values with the caller's words they came from, its action, `fromFacts`, `fixedLine`; a list where the turn asks again, shown the day's free windows), and each call holds properties (`values`, `action`, `said.notFigure`, `readBackSaid`, `nothingDoneBefore`), never lines. `fixtures/corpus.jsonl` is the decision model's alone: what it reads on every turn (the request at the opening, the yes or no at a read-back, the offer of the number calling). It runs with an agent that understands nothing (never the agent model), so a line answering a field records the field's question again: the values are the agent's, in the scenarios. `fixtures/expected/` is the stub baseline, made once and reviewed. `fixtures/recorded/` is the recording (Jev's cassette and the agent cassette, `agent/inception__mercury-3.instant.realtime.jsonl`), which `regress --client recorded` replays; DESIGN.md's "Recordings" is its triage. `fixtures/agent/` is the bake-off's (`cases.yaml` and its recording); `pnpm agent:bakeoff --cases apps/wheelshop/fixtures/agent/cases.yaml --models inception:mercury-3:instant:realtime --repeat 3 --judge-ms 200 --replay` tables it with no key.

## Commands

Run these at the repository root.

```sh
pnpm check
pnpm --filter @dialogwright/example-wheelshop typecheck
pnpm --filter @dialogwright/example-wheelshop test
pnpm --filter @dialogwright/example-wheelshop regress                      # "no changes", then the adversarial suite (the agent family) and the summary
pnpm --filter @dialogwright/example-wheelshop regress --scenario <id>      # one scripted call, turn by turn (--corpus <id>, --adversarial <id>)
pnpm policy:matrix apps/wheelshop && pnpm policy:card apps/wheelshop && pnpm app:diagram apps/wheelshop   # after a change to business.yaml or a tool; read each diff
pnpm agent:bakeoff --cases apps/wheelshop/fixtures/agent/cases.yaml --models inception:mercury-3:instant:realtime --repeat 3 --judge-ms 200 --replay   # the bake-off's table, from its recording
```

## Rules for this app

- A change to what the shop does, claims, charges or collects is an edit to `business.yaml`, never to code. After it: `pnpm check`, then the three pages above, read as a change in what the line may do and say, committed with the file.
- The line never says a price: `prices.say` is said whole when a caller asks, and it promises nothing the line has not done (the photo link is texted only by the request's read-back's yes, so the price line says what happens once the request is sent). Never put a figure in a claim, the price line or a sample reply.
- A turnaround, a promise or a service may come only from `claims` and `services`. Keep each assumption marked as one until the owner confirms it.
- Every read-back says every field, an optional one too, since a form's `then` sends them all (the caller confirms nothing they never heard): an optional field is said through its `says` (each option in the shop's words, and `unset` for when it is left empty, as `diamondCut` is). A tool follows one form; a form's first `then` tool is its write.
- Never put policy in tool code; never record (`regress --client record` is the author's step, with the author's keys); never put a key in a file; never regenerate the baseline, a snapshot or a page of the read back to make something pass. A `FAIL adversarial` case is a finding to fix in the app or the engine.
- Fictional data only: invented names and dealerships, the 555 range, example.com.

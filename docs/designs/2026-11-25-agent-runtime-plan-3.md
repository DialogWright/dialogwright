# Agent runtime, plan 3: the old agent mode out, the calendar, and live calls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The converse runtime becomes DialogWright's only agent mode. The old agent mode leaves the scripted engine, `mode: converse` is renamed `mode: agent`, the wheel shop's numbers move to the converse wheel shop, its calendar can be a real Google Calendar, and live calls on both carriers are measured.

**Architecture:**
- **Fixes carried from plan 2.** A thrown turn says the right line, and a read-back the caller keeps speaking over is bounded.
- **Twilio voices.** A Twilio voice in agent.yaml names its provider.
- **Google Calendar.** A source behind the existing `Calendar` interface, through a service account, signed by the engine's own code (no new dependency, as the S3 traces' SigV4 is).
- **The old agent mode is removed**, in four cuts, the app first so nothing still uses it: `apps/wheelshop`; the engine's turn, run and render code; define, schema, command line and exports; the console, the policy card and the adversarial family.
- **The rename.** The mode string and the prose move from "converse" to "agent". Code identifiers and stored literals (`kind: 'converse'`, the `'converse-1'` schema, the `converse/` folder) are kept, so saved calls and traces stay readable.
- **Docs.** Guide chapter 18, CLAUDE.md and the docs index are rewritten for the one agent mode.
- **Live calls and the cost report** close the design's order (steps 5 to 7).

**Tech stack:** TypeScript, zod, vitest, pnpm workspace; fetch and node:crypto (RS256) for Google.

**Spec:** [docs/designs/2026-11-11-agent-runtime.md](2026-11-11-agent-runtime.md), sections "Sources in version one", "Cost comparison", "Taking the old agent mode out" and "Order", with plan 2's record: [2026-11-24-agent-runtime-plan-2.md](2026-11-24-agent-runtime-plan-2.md).

## Decisions for the maintainer

All six proposals below were approved by the maintainer on 2026-11-25. Decisions 2 and 3 still need him: the test calls on the moved numbers, and the Google Calendar and service account he sets up.

1. **The Twilio voice's provider.**
   - Today agent.yaml `persona.voices.twilio` is a voice name only, and its text-to-speech provider comes from the deployment's `TTS_PROVIDER`/`TTS_VOICE`. On a host, that is one provider for every app.
   - Proposal: `persona.voices.twilio` takes either a name or `{ voice, provider }`, as app.yaml's voice settings do (Task 2).
2. **When the wheel shop's numbers move.**
   - The old agent-mode wheel shop answers two numbers on the Mini: the Farragut line (Telnyx) and the wheel shop's Twilio line.
   - Proposal: move the Twilio line to `wheelshop-agent` first, call it, then move the Telnyx line, all before Task 4 removes the old app.
   - The Mini's host.yaml is yours to change, or mine on your word.
3. **The test calendar.**
   - You create a Google Calendar for the demo and a service account (Google Cloud console). You share the calendar with the service account's email, with permission to make changes, and keep the key file outside the repository.
   - Task 3 is built and tested against a fake Google API. Only its live check waits on this.
4. **The scripted-side review** (the design's list).
   - Proposal: keep `MIN_SPEECH_MS`, the playback reports ending a line, and `SPEECH_OVER_LINE` with its goodbye rule. They are scripted features the scripted regressions pin, and the playback reports serve the converse runtime too.
   - Remove the figures read in groups, the text slot's `figures` option and `AGENT_RETRY`. Only the old agent mode reads them.
5. **The console after removal.**
   - Proposal: old agent-mode calls stay listed and readable by the fields every call has.
   - Their agent-only detail (the agent's answer, its values, its wait) is no longer shown.
6. **No alias for `mode: converse`.**
   - Nothing is published, and the only users are this repository's app and fixture.
   - After the rename, `pnpm check` refuses `converse` with the fix "write mode: agent".

## Global constraints

- **Repository rules.**
  - The root CLAUDE.md rules hold: no real personal data (555 numbers, invented names), no key in any file, log or message, and nothing published.
  - Neutral words in `packages/dialogwright`.
- **The scripted mode is unchanged in behaviour.**
  - Its regressions (testkit, clinic, utility, secretary, harbor) stay exact.
  - A test that exists only for the old agent mode is deleted with it. Every other existing test passes unedited, except where a task names the test it rewrites.
- **The converse runtime is unchanged in behaviour by Tasks 4 to 7.**
  - Its tests pass with only the mode string and prose changed.
  - Saved converse calls and traces written before the rename load and show.
- **Generated files are regenerated with their commands, never edited by hand:**
  - the schemas (`pnpm --filter dialogwright schemas`);
  - the slot pages (`slot-docs`);
  - the policy pages (`policy:matrix`, `policy:card`, `app:diagram`).
- **No real Google, model, carrier or text call in a test or in CI.**
- **The gate after each task:**
  - `pnpm typecheck`, `pnpm check`, `pnpm test`, `regress:testkit` and the remaining apps' stub and recorded regressions;
  - `pnpm adopt:test` after Tasks 4, 5 and 6 (manifests, command lines and exports change);
  - the private scan with 0 hits.
- **No em dash.**
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A call saved before the rename.** A converse call saved in a store before Task 6 (`schema 'converse-1'`, `kind: 'converse'`) resumes after it. Test in Task 6.
2. **An old agent-mode trace in the console** after Task 4 lists and opens without an error. Test in Task 4.
3. **A host file that still names the old wheel shop** after Task 4 fails `pnpm check host.yaml` and `pnpm diagnose` with a fix. It must never start half-working. Test in Task 4.
4. **Google answering slowly or with an error** mid-call. The lookup fails as any lookup does (the model told, no slot invented), and a booking is never written twice (its idempotency key is the event's id). Test in Task 3.
5. **A Twilio voice with a provider on a host** whose `TTS_PROVIDER` names another vendor. The app's own provider wins. Test in Task 2.

---

### Task 1: The two fixes carried from plan 2

**Files:** `packages/dialogwright/src/server/voice/converseRuntime.ts`, `packages/dialogwright/src/converse/turn.ts`, their tests.

**Behaviour:**
- **A turn that throws** says nothing more where it had already sent its final reply. Where a change the caller confirmed has just run, it says the done line (`lines.done`). Otherwise it says the recovery line, as today.
- **Unheard read-backs are bounded.**
  - A read-back of the same action that comes back not heard (`readBackHeard` false, or the caller went on speaking) counts as a refusal of that action.
  - So agent.yaml `limits.refusalsPerAction` (default 3) brings the model's offer of a person, as gate refusals do.
  - The trace's `notConfirmed` rows already say why.

- [ ] Tests first, each failing:
  - `a thrown turn after its final reply says nothing more`;
  - `a thrown turn after a confirmed change says the done line`;
  - `the third unheard read-back of one action brings the offer of a person` (a fake model; assert the refusal count and the model told).
- [ ] Implement. Run the full gate. Commit: `converse: a thrown turn says the right line; unheard read-backs count toward the action's limit`.

### Task 2: A Twilio voice names its provider (decision 1)

**Files:**
- `packages/dialogwright/src/converse/business/schema.ts` (`persona.voices.twilio`: a name or `{ voice, provider }`)
- `packages/dialogwright/src/server/http.ts` (`converseOptions`)
- `packages/dialogwright/src/server/doctor.ts` (the voice check)
- `apps/wheelshop-agent/agent.yaml`
- the regenerated `schemas/agent.schema.json`
- tests

- [ ] Tests first:
  - `a Twilio voice with its provider is written with that provider, whatever TTS_PROVIDER says`;
  - `a voice name alone keeps today's behaviour`;
  - `diagnose warns of a Twilio voice name with no provider where TTS_PROVIDER is unset`.
- [ ] Implement. Run the gate. Commit: `converse: a Twilio voice may name its provider`.

### Task 3: Google Calendar through a service account

**Files:**
- `packages/dialogwright/src/converse/sources/googleCalendar.ts` (new)
- `packages/dialogwright/src/converse/sources/googleAuth.ts` (new: a service account's JWT signed RS256 with node:crypto, exchanged for an access token, cached until a minute before it expires)
- agent.yaml `sources.calendar` gains `google: { calendarId: env.<NAME> }`, with the key file's path in the app's settings (`GOOGLE_CALENDAR_KEY_FILE`, never in a file the repository tracks)
- `packages/dialogwright/src/testing/fakeGoogleCalendar.ts` (new, internal: a fake of the two endpoints used)
- docs: guide 14.12 and the app's `.env.example`

**Interfaces:**
- `googleCalendar(o: { calendarId: string; keyFile: string; business: AgentBusiness; fetch?: typeof fetch; now: () => Date }): Calendar`.
- It is the same `Calendar` the fake calendar is (`converse/sources/calendar.ts`):
  - free slots come from the business's drop-off windows, their capacity and `until`, less the events already in each window;
  - a booking is an event whose id is derived from the idempotency key, so a write repeated after a restart is the same event.

- [ ] Tests first, against the fake Google API:
  - `free slots subtract the events in each window`;
  - `a booking writes one event, and the same key writes no second`;
  - `a 5xx or a timeout fails the lookup with a reason the model is told`;
  - `the access token is reused until it nears its expiry`;
  - `the key file's path is never logged`.
- [ ] Implement. Run the gate. Commit: `converse: Google Calendar through a service account`.
- [ ] **Live check (after decision 3):** the maintainer's calendar in `apps/wheelshop-agent`'s settings; one chat booking lands as an event.

### Task 4: The old agent mode out

Four commits on one branch. The app goes first, so nothing still uses the mode the engine loses.

**4a. `apps/wheelshop`.**
- Delete the app, its CI steps (`.github/workflows/ci.yml` lines 47 to 50), its lockfile entry (`pnpm install`), and the references to it:
  - docs/README.md;
  - docs/live-checks.md;
  - llms.txt;
  - guide 13's quote-reply example (reword it on wheelshop-agent);
  - harness-text/judgeEvalCommand.ts;
  - CLAUDE.md's apps line.
- Its DESIGN.md assumptions carry into `apps/wheelshop-agent/DESIGN.md` where they still apply.
- **Prerequisite (decision 2):** the Mini's host.yaml no longer names it.

**4b. The engine's turn, run and render.**
- Delete:
  - `core/agentTurn.ts` and its tests;
  - `packages/dialogwright/src/agent/`;
  - `render/agentLine.ts`.
- Remove their branches and fields from:
  - `core/turn.ts`;
  - `core/session.ts` (`agent`, `by`);
  - `run/turn.ts` (`RunOptions.agent`, the agent ask, retry and budget);
  - `run/waiting.ts`;
  - `run/continuation.ts`;
  - `core/questions.ts`;
  - `core/gates.ts`;
  - `core/app/types.ts` (`App.mode` `'agent'`, `App.agent`, `App.personForm`);
  - `core/app/validate.ts`;
  - `render/checks.ts` (the agent drift and value questions; the figures read in groups, decision 4);
  - `render/judgeEval.ts` (`speaks: value`);
  - `jev/heuristicStub.ts`;
  - `jev/fixtureStub.ts`;
  - `harness-text/` (agentScript, the agent branches of runner, regress, transcript and replay).
- Remove the scripted-side leftovers made only for agent mode: the cancel question at a form's read-back (`cancel_<form>`) and `personForm`, unless a scripted app uses them (check each, and keep what a scripted app uses).
- Bump `SESSION_SCHEMA` where the saved shape changes (root CLAUDE.md).

**4c. Define, schema, command line and exports.**
- Delete `define/business*.ts`, the business schema and its JSON Schema, and the fixture `define/__fixtures__/business/`.
- Remove style.yaml's `agent` block (check first that no generated-wording key shares it).
- Remove the text slot's `figures` option (decision 4).
- Remove the `agent:bakeoff` command and root script.
- Remove from `src/index.ts`: `loadBusiness`, `optionKey`, `BusinessFile`, `BusinessYaml`.
- Remove from `src/testing/index.ts`: the scripted-agent exports.
- Remove from `server/config.ts`: `AGENT_TIMEOUT_VOICE_MS`, `AGENT_TIMEOUT_CHAT_MS` and `AGENT_RETRY`, with their 14.12 rows and every `.env.example` block (the template's and each app's together; a test keeps them in step).
- Update the slot READMEs that mention agent mode, then regenerate the schemas and slot pages.
- Update `src/boundary.test.ts`'s lists.

**4d. The console, the policy card and the adversarial family.**
- Delete `dashboard/agentFigures.ts` and the old agent view's parts of view.js, view.d.ts and page.html; old traces keep listing by their common fields (decision 5).
- Delete the policy card's and app map's agent sections (`testing/policyCard.ts`, `testing/appMap.ts`).
- Delete the adversarial suite's agent family (`testing/adversarial/agent.ts` and its uses). The simulated callers are the agent app's adversarial set, as the design says.

- [ ] Tests first, the review focus:
  - `an old agent-mode trace lists and opens in the console`;
  - `a host file naming an app with mode agent and a business.yaml fails check and diagnose with a fix`.
- [ ] Cut, commit by commit, the gate green at each. Commit messages: `apps: the old agent-mode wheel shop out`, `engine: the old agent mode's turn out`, `define: the old agent mode's files, schema and command out`, `console and testing: the old agent mode's views out`.

### Task 5: `mode: converse` becomes `mode: agent`

**Files:**
- `define/schema/app.ts` (`APP_MODES` = `['scripted', 'agent']`)
- `converse/app.ts` (the guard and its error text)
- `define/load.ts`, `define/check.ts`, `define/defineApp.ts`, `server/doctor.ts` (the check id stays internal; its words change), `server/setup.ts`
- `apps/wheelshop-agent/app.yaml`, `src/testing/converse/app.yaml`
- the regenerated `schemas/app.schema.json`
- user-facing words ("a converse app" becomes "an agent app") in error texts, doctor lines, the console's labels and the eval's pages

Code identifiers, file and folder names, and stored literals stay.

- [ ] Tests first:
  - `mode: agent loads an agent.yaml app`;
  - `mode: converse is refused with the fix "write mode: agent"`;
  - `a converse call and trace saved before the rename resume and show` (review focus 1).
- [ ] Rename. Run the gate and `pnpm adopt:test`. Commit: `agent mode is the converse runtime (mode: agent)`.

### Task 6: Docs for the one agent mode

**Files:**
- `docs/guide/18-agent-mode.md`, rewritten for the converse runtime: the folder (app.yaml, agent.yaml, src/app.ts), the business information, actions and the gate, the read-back, journeys, the phone, simulated callers, and the model choice.
- `docs/guide/README.md`, `docs/guide/04`, `13` and `14`, and `docs/README.md`.
- The root CLAUDE.md:
  - the layout (`agent/` gone; `converse/` described as agent mode);
  - the old agent mode's two named exceptions replaced by the converse runtime's (one paragraph, as decided 2026-11-08 and carried forward 2026-11-11);
  - the options rule's agent-mode defaults removed (`figures`, `values.refusedUncounted`, `values.earlierWords`, `AGENT_RETRY`);
  - the commands.
- README.md, CONTRIBUTING.md, llms.txt, and `.claude/skills/create-app/` (options, patterns, corpus) where they name the old mode.

- [ ] Write the docs. Run the gate (docLinks, wording) and `pnpm adopt:test`. List every CLAUDE.md line changed for the maintainer. Commit: `docs: one agent mode`.

### Task 7: Live calls and the cost report

- [ ] **Live calls, the maintainer on the phone** (after decision 2). For each carrier, Twilio and Telnyx, a booking, a correction at the read-back, a cut-in over a long reply, a "yes" said quickly after the read-back, and a hang-up mid-reply.
  - From each call's frame log and trace, read:
    - Telnyx's `clientSpeaking`, `agentSpeaking` and `tokensPlayed` order at a cut-in;
    - Twilio's `interrupt`-then-`prompt` order;
    - whether `utteranceUntilInterrupt` spans earlier sentences;
    - how many read-backs came back not heard.
  - Each finding goes to a measured fix, never a per-call rule (the spec's anti-goal).
- [ ] **The simulated callers' rates** reported beside the live calls (plan 2's voice and chat runs as the baseline).
- [ ] **The cost report** (the spec's "Cost comparison"), `docs/designs/eval/2026-11-cost.md`:
  - **Per call:** agent mode's model tokens and price from the simulated runs; scripted mode's decision-model questions and any generated wording from the scripted apps' traces.
  - **Shared costs:** carrier minutes, speech recognition and speech from the providers' published rates, once, as the same for both modes, each with its source and date.
  - **A month:** at 500, 2,000 and 10,000 calls, and at what volume, if any, the difference starts to matter.
  - Sharing it is the maintainer's decision; nothing is published.
- [ ] Commit: `eval: live calls on both carriers and the cost of a call in each mode`.

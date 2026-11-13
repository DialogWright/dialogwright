# Journeys: build plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the converse runtime journeys: a base every task sees, plus task-scoped journeys picked each
caller turn by the decision model. Rebuild the wheel shop with three journeys, and measure it against the
prevention baseline.

**Architecture:**
- **agent.yaml** gains optional `root`, `journeys` and `routing` sections, in the zod schema with
  cross-checks.
- **`converse/journeys.ts`** (new, pure functions) covers:
  - which journeys are open to the caller;
  - the decision model's routing questions;
  - the routing table, which turns answers into a route;
  - what a turn offers: actions, plus the information and instructions in the prompt.
- **`turn.ts`**:
  - routes each caller turn;
  - builds the prompt and tools from the route;
  - refuses an action that wasn't offered;
  - moves a journey to its "after" phase when its action runs.
- **Latency:** the first model round starts alongside routing. Its sentences are held until the route is
  known, and the round is restarted if the route changes the journey.
- **Elsewhere:** the trace, the console and the policy pages show journeys. A new
  `converse:route-eval` command scores routing on labelled caller turns.

**Tech stack:** TypeScript, zod, vitest, pnpm workspace. TypeSafe's Jev is the decision model, through the
existing `JevClient`.

**Spec:** [docs/designs/2026-11-12-journeys.md](2026-11-12-journeys.md). It was approved by the maintainer on
2026-11-12. Read it whole before any task. It builds on
[2026-11-11-agent-runtime.md](2026-11-11-agent-runtime.md).

## Global constraints

**Rules that hold throughout:**
- The root CLAUDE.md rules hold:
  - no real personal data (555 numbers, invented names);
  - no key in any file, log or message;
  - nothing published.
- Engine code, tests and fixtures in `packages/dialogwright` use neutral words: caller, task, visit, note,
  request, appointment. Nothing about wheels, cars, dealerships or shops.
- `src/converse/` never imports the scripted engine (`src/boundary.test.ts`). Routing uses
  `ConverseDeps.jev` and `askWithin` from `converse/confirm.ts`.
- **An app with no `journeys` behaves exactly as today:**
  - the same system prompt, character for character;
  - the same tools;
  - no routing request to the decision model;
  - no `route` in its trace.
  
  Every existing converse test passes unchanged; none may be edited to pass.
- No real model or decision-model call in a test or in CI: fakes and cassettes only.
- **Journeys' instructions, Jev's questions and the prompt's added text** give goals and context, never a
  procedure for the words (root CLAUDE.md, generated wording).
- **Defaults from the spec, verbatim:**
  - `routing.switchAt` 0.6;
  - `routing.timeoutMs` 400;
  - the `after` line `"<goal>: done on this call. Answer the caller's questions about it."`;
  - the root's `none` option `"none of these: a question, small talk, or something else"`.
- A saved state from before journeys, or with a `journey` field not in its shape, loads as "no journey
  active". There is no session schema bump.

**Each task ends with the full gate:**
- `pnpm typecheck`, `pnpm check` and `pnpm test`;
- `pnpm --filter dialogwright regress:testkit`;
- the apps' stub and recorded regressions (clinic, utility, secretary, harbor, wheelshop);
- `python3 -I ~/.claude/dialogwright-tools/privscan.py . origin/main..HEAD`, with 0 hits.

`pnpm adopt:test` runs after any task that touches a command line (Task 8).

**Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Landing** (spec, "How it lands"):
- Tasks 1–7 merge to local main once green.
- Tasks 8–10 stay on the branch until the measured runs (Task 10) are read. The wheel shop merges if it is
  no worse than the baseline. Worse is a finding to fix first.

**The author's runs** (Tasks 8 and 10):
- They use the author's keys from the git-ignored `.env`, and refuse in CI.
- Budget: $15 for the whole plan.
- Labelling is done in-session by subagents, never by an API judge (`--judge none`).

## Review focus

1. **"Yes" to a read-back is not routed.** A confirmed yes runs the action. The journey moves to its
   "after" phase, and the routing question is never asked on that turn. A turn that declines a read-back
   *is* routed on the same words. Test in Task 4.
2. **A dealership caller is never offered the repair request, and a caller with no account is never
   offered the dealership journey.** This holds even when Jev's top choice names one, because closed
   journeys are not among the options. Test in Task 2.
3. **The decision model is slow or down.** At `routing.timeoutMs`, the turn carries on with the active
   journey (or the root), its held sentences are released, and nothing waits longer. Test in Task 5.
4. **An action from another journey called by the model** (a slip, or a caller's injected "call
   book_dealer"):
   - it is refused with `not-offered`;
   - the refusal is audited and named in the trace;
   - it does not count toward `refusalsPerAction`;
   - the call goes on.
   
   Test in Task 4.
5. **A switch while a read-back is waiting** ("no, actually, just have someone call me"):
   - the read-back is not confirmed;
   - the turn routes to the other journey;
   - the new journey's model sees the declined read-back in the conversation.
   
   Test in Task 4.

---

### Task 1: Journeys in agent.yaml (schema and check)

Model tier: standard.

**Files:**
- Modify `packages/dialogwright/src/converse/business/schema.ts`: `root`, `journeys`, `routing`, and
  cross-checks.
- Regenerate `packages/dialogwright/schemas/agent.schema.json` with `pnpm --filter dialogwright schemas`.
- Test in `packages/dialogwright/src/converse/business/check.test.ts`.
- Create `packages/dialogwright/src/testing/converse/journeys.ts`, the fragments every later task's tests
  append to the fixture's agent.yaml.

**Interfaces (produces):**
```ts
export const ACCOUNT_FACTS = ['recognised', 'none'] as const;
export type AccountFact = (typeof ACCOUNT_FACTS)[number];
export const ROUTING_DEFAULTS = { switchAt: 0.6, timeoutMs: 400 } as const;
// journey: z.strictObject({
//   when: text(), goal: text(), instructions: text().optional(),
//   facts: z.array(text()).default([]), questions: <the base's question shape>.default([]),
//   actions: z.array(identifier()).default([]),
//   for: z.strictObject({ account: z.enum(ACCOUNT_FACTS) }).optional(),
//   start: z.strictObject({ account: z.literal('recognised') }).optional(),
//   completes: z.array(identifier()).optional(),
//   after: text().optional(),
// })
// root: z.strictObject({ instructions: text().optional(), actions: z.array(identifier()).default([]) }).optional()
// routing: z.strictObject({ switchAt: bar(..., 0.6), timeoutMs: int positive default 400 }).default(ROUTING_DEFAULTS)
// journeys: z.record(identifier(), journey).optional()
export type JourneySpec = z.output<typeof journey>;

// testing/converse/journeys.ts: YAML text appended to testing/converse/agent.yaml
export const LEAVE_NOTE_ACTION: string;   // under actions: leave_note (change; name text, phone phone; a readBack)
export const JOURNEYS_YAML: string;       // root (no actions) + journeys visit [availability, book] and note [leave_note]
export const ACCOUNT_JOURNEYS_YAML: string; // as JOURNEYS_YAML, plus visit_account (for and start: account recognised) and visit with for: account none
```
Each field's `.describe()` text is taken from the spec's list under "The base and the journeys in
agent.yaml".

- [ ] **Step 1: Write the fragments and the failing tests.** In `check.test.ts`, a `describe('journeys')`
  on the fixture business with `LEAVE_NOTE_ACTION` and `JOURNEYS_YAML` appended.

  One test per cross-check, each asserting the problem's path and that its fix text is present:
  - `a journey names an action that does not exist` → path `['journeys','visit','actions',0]`;
  - `the root names a change action` → `['root','actions',0]`;
  - `a journey names a follow-on` → the follow-on's index;
  - `a change action no journey names` → `['actions','<name>']`. This runs only when `journeys` is
    present;
  - `completes names an action the journey does not list, or a lookup`;
  - `two journeys say start`. My ruling: at most one, since two would race at the call's start;
  - `start where for says account: none`;
  - `an app without journeys gets no journey problems, and its parsed value has no journeys key and
    routing defaults { switchAt: 0.6, timeoutMs: 400 }`;
  - `a journey with an empty when or goal is refused`.
- [ ] **Step 2: Run them; they fail.**
  `pnpm --filter dialogwright exec vitest run src/converse/business/check.test.ts`.
- [ ] **Step 3: Implement** the schema and the checks inside `crossChecks`, using its `issue(ctx, path,
  message, fix)`.
- [ ] **Step 4: Regenerate the JSON schema.** Run the tests and `pnpm check`. The wheel shop and the
  fixture are unchanged, and their checks stay clean.
- [ ] **Step 5: Commit:** `converse: journeys, root and routing in agent.yaml (schema and check)`.

### Task 2: Routing, pure (`converse/journeys.ts`)

Model tier: standard.

**Files:**
- Create `packages/dialogwright/src/converse/journeys.ts` and `journeys.test.ts`.
- Modify `packages/dialogwright/src/converse/state.ts`: `JourneyState` and `ConverseState.journey?`.

**Interfaces (produces):**
```ts
// state.ts
export interface JourneyState {
  active: string | null;          // the journey the turn is in, or null at the root
  phase: 'working' | 'after';     // after: its completing action ran; its information stays, its changes are withdrawn
  paused: string | null;          // set aside by a switch; at most one
  done: string[];                 // journeys whose completing action ran on this call, in order
}
// ConverseState gains: journey?: JourneyState   (absent: the app has no journeys, or a state saved before them)

// journeys.ts
export type RouteOutcome = 'start' | 'carry' | 'switch' | 'return' | 'root' | 'dropped' | 'again';
export interface RouteReading { task: Record<string, number> | null; drops: number | null; again: number | null }
export interface Route { outcome: RouteOutcome; next: JourneyState; droppedPaused?: string }
export const NONE_TASK = 'none';
export function hasJourneys(b: AgentBusiness): boolean;
export function openJourneys(b: AgentBusiness, caller: ConverseState['caller']): string[];        // by `for`; account fact: caller.account non-null → recognised
export function initialJourney(b: AgentBusiness, caller: ConverseState['caller']): JourneyState;   // the one whose `start` fits, else at the root
export function routeQuestions(b: AgentBusiness, j: JourneyState, caller: ConverseState['caller']): QuestionMap;
export function routeState(b: AgentBusiness, j: JourneyState, said: string, lastReply: string | null): JsonValue;
export function readRoute(answers: AnswerMap | null): RouteReading;
export function decideRoute(b: AgentBusiness, j: JourneyState, r: RouteReading, open: string[]): Route;
export function completeJourney(b: AgentBusiness, j: JourneyState, action: string): JourneyState; // `completes` ran: phase after, id pushed to done
export function offeredActions(b: AgentBusiness, j: JourneyState | undefined): string[];          // see Task 3
```

**`routeQuestions`:**
- `task` is a `ChoiceQuestion`:
  - its `criteria` maps each open journey's id to its `when`, and `none` to
    `"none of these: a question, small talk, or something else"`;
  - its instructions ask which the caller wants done now, not what they ask about (spec, "Routing").
- `drops` is a `NoulQuestion`, asked only when `active` is not null and `phase === 'working'`.
- `again` is a `NoulQuestion`, asked only when `phase === 'after'`. It names the active journey's `goal`.
- Jev's state (`routeState`):
  - `{ said, lastReply, active: <when>|null, paused: <when>|null }`;
  - in the "after" phase, `{ ..., finished: <goal> }`.

**`decideRoute`:** the spec's table. "Above the bar" means `>= b.routing.switchAt`.

| Situation | Route | Next state |
| --- | --- | --- |
| A null reading (Jev failed or timed out) | `carry` | unchanged |
| At the root, `task` names an open journey above the bar | `start` | `{active: it, phase: 'working'}` |
| Otherwise at the root | `root` | unchanged |
| Active A, `drops` above the bar, and `task` none or below the bar | `dropped` | active null, paused kept |
| Active A, `drops` above the bar, and `task` another journey B above the bar | `switch` or `return` | A is not paused |
| Active A, `task` B ≠ A above the bar, B not paused | `switch` | paused A; any earlier paused journey is dropped and named in `droppedPaused` |
| Active A, `task` the paused journey B above the bar | `return` | active B (`phase: 'working'`), paused A |
| Active A in `phase: 'after'`, `task` A, `again` above the bar | `again` | phase back to `'working'` |
| Anything else | `carry` | unchanged |

A journey in `done` that comes up again while not active starts fresh, with the outcome `start` or
`switch` (spec ruling, recorded in the plan).

- [ ] **Step 1: Write the failing tests** in `journeys.test.ts`, on `JOURNEYS_YAML` and
  `ACCOUNT_JOURNEYS_YAML`:
  - `openJourneys` keeps closed journeys out:
    - a caller with `account: 'Example Account'` gets `[visit_account, note]`;
    - a caller with no account gets `[visit, note]`.
  - **Review Focus 2:** `routeQuestions`' `task` criteria never lists a closed journey. Given a reading
    whose top choice is a closed journey's id (as a stray label), `decideRoute(..., open)` returns
    `carry` or `root`, never that journey.
  - `initialJourney` starts the `start` journey only for a recognised account.
  - One test per table row, named after the row, asserting `outcome` and `next`.
  - `readRoute(null)` → all null, and `decideRoute` → `carry`.
  - The `again` and `drops` questions appear only in their phases.
  - Probabilities exactly at `switchAt` (0.6) count as above the bar; 0.59 does not.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Use `probabilityOf` from `confirm.ts` for the noul answers. A choice
  answer's probabilities are read from `ChoiceAnswer.probabilities`.
- [ ] **Step 4: Run them; they pass.** Then the full gate.
- [ ] **Step 5: Commit:** `converse: journeys routing (open journeys, the decision model's questions, the routing table)`.

### Task 3: What a turn sends: prompt, information and tools

Model tier: standard.

**Files:**
- Modify `packages/dialogwright/src/converse/prompt.ts`:
  - `systemPrompt` reads `s.journey`;
  - `toolsOf(b, offered?)`.
- Modify `packages/dialogwright/src/converse/business/text.ts`:
  - `businessText(b, journey?)`;
  - `journeyText(b, j, caller)`.
- Modify `packages/dialogwright/src/converse/journeys.ts`: `offeredActions`.
- Test in `prompt.test.ts`, or the prompt tests in `turn.test.ts` where the existing ones live.

**Interfaces:**
- Consumes `JourneyState`, `openJourneys` and `hasJourneys` from Task 2.
- Produces:
```ts
export function toolsOf(b: AgentBusiness, offered?: readonly string[]): ModelTool[]; // absent: as today
export function journeyText(b: AgentBusiness, j: JourneyState, caller: ConverseState['caller']): string; // '' for an app with no journeys
```

**`offeredActions(b, j)`:**
- with no journeys, or `j` undefined: every non-follow-on action, as today;
- at the root: `root.actions`;
- in a working journey: its `actions`;
- in an after journey: its lookups only.

`end_call` is always added by `toolsOf`.

**The text, in `systemPrompt`'s information block:**
- `businessText(b)` comes first, unchanged.
- In a journey, `journeyText` then appends:
  - `What you are helping the caller with now: <goal>`, or the `after` line in the "after" phase;
  - its instructions (working phase only);
  - its `facts` under `Facts for this:`;
  - its `questions` under `Questions callers ask about this, with our answers:`.
- At the root, it appends:
  - `root.instructions`;
  - `What this line can help with:`, followed by each open journey's `when` as a bullet.
- With a paused journey, it adds:
  `Set aside earlier on this call: <when>; offer to pick it up once this is done.`

Nothing else in the prompt moves. The base information and the five rules stay ahead of any journey text.

- [ ] **Step 1: Write the failing tests:**
  - `an app with no journeys: the system prompt is unchanged`. Build the fixture business and assert
    `systemPrompt(b, s, now)` equals the string from the code before this task, captured as an inline
    expected string in the test before the change.
  - `an app with no journeys: toolsOf(b) is unchanged`.
  - In a working journey:
    - the prompt holds the journey's goal, instructions, facts and questions;
    - it holds no other journey's facts, questions or `when`;
    - the tools are its actions plus `end_call`.
  - At the root:
    - the prompt holds the root instructions and every open journey's `when`;
    - it holds no journey's facts;
    - the tools are `root.actions` plus `end_call`.
  - In the "after" phase:
    - the `after` line, the journey's facts and questions are present;
    - the instructions are absent;
    - the tools hold no change action.
  - With a paused journey, the set-aside line names its `when`, and none of its facts.
  - The base information and the five rules come before the journey text, in that order.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Then the full gate.
- [ ] **Step 5: Commit:** `converse: the prompt and tools by journey`.

### Task 4: Routing in the turn (sequential), refusals and ending

Model tier: most capable. turn.ts is the runtime's heart, and the cases interact.

**Files:**
- Modify `packages/dialogwright/src/converse/turn.ts`:
  - `converseTurn`: the initial journey at `start`, and the route before `converse`;
  - `round`: the prompt and tools from the turn's journey;
  - `runCalls`: the `not-offered` refusal;
  - `answered`: `completeJourney`.
- Modify `packages/dialogwright/src/converse/trace.ts`: `route?` and `journeyEnded?`.
- Modify `packages/dialogwright/src/server/chat/converseRuntime.ts` `stateOf`: tolerant loading.
- Tests:
  - a new `describe('journeys')` in `turn.test.ts`, using the harness's `edit` to add the Task 1
    fragment;
  - `converseRuntime.test.ts` for loading.

**Interfaces:**
- Consumes everything from Tasks 2 and 3.
- Produces, in `trace.ts`:
```ts
route?: { from: string | null; to: string | null; outcome: RouteOutcome; task: Record<string, number> | null; drops?: number; again?: number; ms: number; timedOut?: true; droppedPaused?: string; restarted?: true };
journeyEnded?: { journey: string; how: 'done' };
```

**The rules:**
- On `start`, `st.journey = initialJourney(b, st.caller)`, only when `hasJourneys(b)`.
- On a text turn:
  1. `answered()` runs first, as today.
  2. If its read-back was confirmed and ran, no routing (Review Focus 1).
  3. Otherwise:
     - ask `askWithin(jev, routeState(...), routeQuestions(...), b.routing.timeoutMs)`;
     - `decideRoute`;
     - set `st.journey`;
     - record `route` (with `timedOut` when null came from the clock).
- `lastReply` is the line's last assistant text in `st.messages`.
- **The `not-offered` refusal**, in `runCalls`:
  - placed after the follow-on check, only when `hasJourneys(b)`;
  - it applies to an action not in `offeredActions(b, st.journey)`;
  - the reason given is `Not run: "<name>" is not available for what the caller is doing now.`;
  - the audit row is `converse_refused` with `{ action, reason: 'not-offered', journey: active ?? 'root' }`;
  - the trace tool outcome is `refused`;
  - it does **not** increment `st.refusals`.
- **A completing action:** when `answered()` runs an action in the active journey's completes (default:
  its change actions that are not follow-ons), set `st.journey = completeJourney(...)` and record
  `journeyEnded`.
- **`stateOf`:** a `journey` that is not `{active: string|null, phase: 'working'|'after', paused:
  string|null, done: string[]}` is deleted.

- [ ] **Step 1: Write the failing tests** in `turn.test.ts`'s `describe('journeys')`, with a `routeJev`
  fake. It answers `task`, `drops` and `again` from a per-turn script, and `confirmsYes`/`confirmsNo` as
  `fakeJev` does.
  - `the first caller turn at the root starts the journey Jev reads`. The trace's `route.outcome` is
    `start`; the model's request has only that journey's tools.
  - **Review Focus 1:** `a confirmed yes is not routed`:
    - no request carries the `task` question on that turn;
    - `st.journey.phase` is `after`;
    - `journeyEnded` is recorded.
  - **Review Focus 5:** `declining a read-back routes on the same words`:
    - the read-back is not confirmed;
    - `route.outcome` is `switch`;
    - the next request's tools are the other journey's;
    - its messages hold the declined read-back.
  - **Review Focus 4:** `an action from another journey is refused not-offered`:
    - the audit has `converse_refused` with reason `not-offered` and the journey;
    - `st.refusals[name]` is unchanged;
    - the turn's reply is still said.
  - `switch then return resumes the paused journey with its conversation`. After return, the request's
    messages still hold the caller's earlier details.
  - `the decision model fails: the turn carries on` with `route.outcome` `carry` and no error.
  - `an app without journeys asks the decision model nothing but the read-back`. Every request in
    `jev.asked` has `confirmsYes`, and no trace has `route`.
  - In `converseRuntime.test.ts`:
    - `a saved state without journey loads as none`;
    - `a journey not in its shape is dropped`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Then the full gate. Every existing turn test passes unedited.
- [ ] **Step 5: Commit:** `converse: routing each caller turn, offered actions only, a journey's end`.

### Task 5: Latency: the first round alongside routing

Model tier: most capable.

**Files:**
- Modify `packages/dialogwright/src/converse/turn.ts`:
  - `Speaker` holds sentences;
  - `converseTurn` starts the first round alongside the route.
- Tests in `turn.test.ts`.

**Interfaces:**
- Consumes Task 4's route and trace fields.
- Produces:
```ts
// Speaker
hold(): void;              // sentences pushed after this are kept, not said
release(): void;           // the kept sentences are said, in order, and later ones go straight out
discard(): void;           // the kept sentences are dropped (abandon's effect on the held part)
```

**The rules:**
- On a routed turn, the speaker holds before the first round. The first round is built from the journey
  as it stands (`carry`'s guess), and routing runs at the same time.
- When the route arrives (or `routing.timeoutMs` passes):
  - if `next.active` and `next.phase` are unchanged, the held sentences are released;
  - otherwise, the round's stream is aborted, the held sentences discarded, the state changed, and the
    first round asked again with the new journey. `route.restarted` is set.
- A tool call in the held round runs only after release. A lookup's result is never reused by a restarted
  round. My ruling: a lookup started before the route is known is cancelled with the round, since it may
  not be offered in the new journey.
- `t.model.firstTextMs` keeps meaning "first text the caller could hear": it is set at release, not at
  the model's first delta.

- [ ] **Step 1: Write the failing tests**, with a fake model whose stream waits on a promise the test
  controls, and a `routeJev` that answers after a delay the test controls:
  - `carry: nothing said before the route, then all of it, once and in order`;
  - `switch: the first round's sentences are never said and the second round's are`. The model got two
    requests, the second with the new journey's tools, and `route.restarted` is true.
  - **Review Focus 3:** `the decision model hangs`:
    - at `routing.timeoutMs` (set to 50 in the test), the held sentences are released;
    - `route.timedOut` is true;
    - the turn's total time is under timeoutMs plus the model's own time plus 50 ms.
  - `a tool call in a held round that is restarted never runs` (the fake tool's call count is 0).
  - `an app without journeys never holds` (the first sentence goes out at the first delta).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Then the full gate.
- [ ] **Step 5: Commit:** `converse: the first round alongside routing, its sentences held until the route`.

### Task 6: The console's call view and the policy pages

Model tier: standard.

**Files:**
- Modify `packages/dialogwright/src/server/dashboard/view.js` and `view.d.ts`: `converseCall` turns carry
  `journey` (`route.to`), `routeOutcome` and `journeyEnded`.
- Modify `page.html`: the turn's journey shown beside it, and a switch, return, start or drop marked.
- Test in `converseView.test.ts`.
- Modify `packages/dialogwright/src/testing/conversePages.ts`:
  - `conversePolicyCardText`: for each action, the journeys that offer it, or "at the root";
  - a "Journeys" section: each journey's `when`, its `for` and `start`, and its actions;
  - `converseAppMapText`: a Mermaid diagram root → journeys → actions → follow-ons.
  
  An app with no journeys gets no new section and the same pages.
- Tests in `conversePages.test.ts`, or where the pages are tested.

**Steps:**
- [ ] **Step 1: Write the failing tests:**
  - `converseCall` on records with `route` gives each turn its journey and outcome;
  - records without `route` give `journey: null` and render as before;
  - the policy card of the Task 1 fragment's business lists `book` under `visit` and `leave_note` under
    `note`;
  - the app map has a `journeys` subgraph;
  - the wheel shop's committed POLICY.md and APP-MAP.md are unchanged by this task, since it has no
    journeys yet (`src/policyPages.test.ts` passes).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Then the full gate.
- [ ] **Step 5: Commit:** `console and policy pages: journeys`.

### Task 7: Docs, and landing the engine

Model tier: cheap.

**Files:**
- `docs/designs/2026-11-11-agent-runtime.md`: one paragraph under "The conversation loop" pointing to the
  journeys design.
- `docs/README.md`: the journeys design and plan.
- Root `CLAUDE.md`: the converse paragraph names `journeys.ts` (routing, the routing table, offered
  actions) and agent.yaml's `root`, `journeys` and `routing`.

**Steps:**
- [ ] **Step 1:** Edit, then run `pnpm --filter dialogwright exec vitest run src/docLinks.test.ts`.
- [ ] **Step 2:** The full gate.
- [ ] **Step 3: Commit:** `docs: journeys in the converse runtime`.
- [ ] **Step 4:** Merge the branch into local main (fast-forward), with the full gate run on main.
  Tasks 8–10 continue on the branch.

### Task 8: The routing evaluation (`converse:route-eval`)

Model tier: standard.

**Files:**
- Create `packages/dialogwright/src/converse/routeEval.ts` and `routeEval.test.ts`.
- Create `packages/dialogwright/src/harness-text/routeEvalCommand.ts` and its test, modelled on
  `claimsEvalCommand.ts` (CI refusal, `--replay`, the cassette beside the labels, `--out`, `--json`).
- Modify `packages/dialogwright/src/define/cli.ts`: register `converse:route-eval` and its usage.
- Modify the root `package.json`: the script `converse:route-eval`.
- Modify `CLAUDE.md` (Commands) and `docs/README.md`.

**Interfaces:**
```ts
export interface RouteCall { id: string; account: boolean; turns: { who: 'line' | 'caller'; text: string }[] } // from an eval's results.jsonl (call.turns)
export interface RouteLabel { id: string; turn: number; task: string; drops?: boolean; again?: boolean; confirms?: string } // turn: the caller turn's index within the call, 0-based; task: a journey id or 'none'; confirms: the action this turn's yes ran (no case is made of the turn)
export interface RouteCase { id: string; state: JsonValue; questions: QuestionMap; expected: RouteLabel; journey: JourneyState }
export function routeCases(b: AgentBusiness, calls: RouteCall[], labels: RouteLabel[]): RouteCase[];
export function scoreRoutes(b: AgentBusiness, cases: RouteCase[], answers: Map<string, AnswerMap | null>, bars: readonly number[]): RouteEvalReport;
```

**`routeCases`:**
- Each call starts from `initialJourney`.
- The labels are applied in turn through `decideRoute`, with a reading of probability 1 for the labelled
  task and 0 elsewhere. That gives each caller turn the journey state the line would have had if routing
  were perfect.
- A turn labelled `confirms` is a yes to a read-back: it makes no case (a confirmed yes is never routed),
  and `completeJourney` is applied with that action.

**The report:**
- accuracy;
- wrong switches: Jev's route switches, starts or returns where the label is carry or none;
- missed switches;
- by bar over `[0.4, 0.5, 0.6, 0.7, 0.8]`;
- Jev's ms (p50 and p95, from the cassette's recorded latency).

It holds case ids and figures, never a caller's words.

**`--calls <results.jsonl>...`** reads the calls. The app folder (`<app dir>`, first positional) gives
the business. An account is true where the call's persona has `callingFrom`.

**Steps:**
- [ ] **Step 1: Write the failing tests** on the Task 1 fragment:
  - `routeCases` replays labels into states: a call labelled `visit`, `visit`, `note`, `visit` gives the
    states root → visit → visit → note (paused visit) → visit (return).
  - `scoreRoutes` counts a fake reading that switches on a turn labelled carry as a wrong switch.
  - The command:
    - refuses in CI;
    - `--replay` with a missing cassette entry reports it unanswered, never asks;
    - recording asks only what the cassette lacks (the `judge` override as in the claims command's
      test).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Then the full gate and `pnpm adopt:test`.
- [ ] **Step 5: Commit:** `converse:route-eval: routing measured on labelled caller turns`.

### Task 9: The wheel shop with journeys

Model tier: standard. The work is mostly YAML and prose, judged against the spec's table.

**Files:**
- `apps/wheelshop-agent/agent.yaml`: `root`, three journeys, and the facts and questions split by the
  spec's table under "The wheel shop's journeys". Every `# assumption` marker stays on its item.
  - `repair_request`:
    - `for: {account: none}`;
    - actions `[check_availability, send_request]`;
    - instructions: collect what `send_request` needs in any order, look the day up before offering a
      window, don't discuss dealership accounts or their rates.
  - `dealer_booking`:
    - `for` and `start: {account: recognised}`;
    - actions `[recognise_caller, check_availability, book_dealer]`.
  - `callback`:
    - actions `[leave_callback]`;
    - instructions: the note carries only its name, number, what it is about and its notes.
  - `root`:
    - instructions as in the spec's example;
    - no actions.
- `apps/wheelshop-agent/eval/personas.yaml`: three personas, `switches-to-callback`, `side-question` and
  `wanders-off`, as the spec describes them. Each has invented names and a 555 number.
- `apps/wheelshop-agent/src/app.test.ts`:
  - a dealership call (number on an account) starts in `dealer_booking`;
  - a request call is never offered `book_dealer`;
  - a confirmed request moves to the "after" phase with `send_request` withdrawn.
  
  Use `converseTestCall` with a scripted model and a routing fake Jev.
- `apps/wheelshop-agent/DESIGN.md`: how the facts were split, for the owner to correct.
- `apps/wheelshop-agent/CLAUDE.md`: journeys in "How a converse app differs".
- POLICY.md, APP-MAP.md and policy.matrix, written by the three commands. Read each diff as a change in
  what the agent may do: actions now offered only in their journeys.

**Steps:**
- [ ] **Step 1: Write the failing app tests.**
- [ ] **Step 2: Edit agent.yaml and the personas.** Run `pnpm check`, then the app's tests.
- [ ] **Step 3:**
  - Run the three page commands for the app and read the diffs.
  - Run `src/policyPages.test.ts`.
- [ ] **Step 4:** The full gate.
- [ ] **Step 5: Commit:** `wheelshop-agent: journeys (repair request, dealership booking, callback)`.

### Task 10: The measured runs and the results page

Model tier: the controller, with labelling subagents (sonnet) following `label-brief.md`.

**Inputs:** in the maintainer's evaluations folder `dialogwright-evals/2026-11-12-status`:
- the baseline calls `ember-g`, `ember-h`;
- `labels-ember.jsonl`, `label-brief.md`, `business.txt`, `make-batches.py`.

**Steps:**
- [ ] **Step 1: Label routing.**
  - Take at least 300 caller turns from the baseline calls (whole calls, every persona).
  - Subagents label each caller turn's `task`, `drops`, `again` and `confirms`, by the spec's rule: what
    the caller wants done, not what they ask about.
- [ ] **Step 2: Score routing.**
  - Record and score with `pnpm converse:route-eval apps/wheelshop-agent --calls ... --labels ...`, with
    the author's TypeSafe key.
  - Choose `routing.switchAt` from the by-bar table: the bar that meets at least 95% right with wrong
    switches under 2%, preferring 0.6 where several do.
  - If a bar other than 0.6 is chosen, set it in the wheel shop's agent.yaml and commit with the table's
    figures in the message.
- [ ] **Step 3: Run the calls.**
  - `pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml --runs 20 --judge
    none --parallel 4 --budget 12`, into `dialogwright-evals/2026-11-13-journeys/`.
  - That gives 240 baseline-persona calls plus 60 new-persona calls.
  - Read the trace for each call's routes.
- [ ] **Step 4: Label the replies.**
  - Subagents, in batches of 10 calls, follow `label-brief.md` unchanged. Its business information
    (`business.txt`) is regenerated from the new agent.yaml (the base plus every journey's information).
  - Count wrong replies, severity 2+, kinds and gaps, per 100 calls.
  - Count the new personas' calls apart. For each, record whether its switch was followed on the turn it
    was asked for, and whether anything given was asked again.
- [ ] **Step 5: Measure the first sentence.**
  - Compare the median and p95 of each turn's first request's `firstMs` with the baseline's 0.75 s and
    1.26 s.
  - Also count routing's restarts and time-outs.
- [ ] **Step 6: Write `docs/designs/eval/2026-11-journeys.md`.**
  - Figures only: the tables against the baseline, and the bars met or missed.
  - No caller's words, names or numbers.
  - Link it from the journeys design's "Measuring it" and from `docs/README.md`.
- [ ] **Step 7: Decide landing** (spec, "How it lands"):
  - **No worse than the baseline** (wrong replies per 100 ≤ 11.7, severity 2+ ≤ 8.3, no new kind):
    merge the branch into local main with the full gate, and deploy to the Mini (pull, install,
    kickstart).
  - **Worse:** stop. Bring the figures and the wrong replies' kinds to the maintainer as a finding.
- [ ] **Step 8:** Update the memory's roadmap state with the outcome.

# Agent runtime, plan 2: the converse runtime on the phone

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A converse app takes phone calls on Twilio and Telnyx: its replies streamed to the carrier a
sentence at a time, the caller able to cut in, the conversation keeping what the caller actually heard, a
short bridge when the model is slow, and the simulated callers run over a text version of the voice path.

**Architecture:**
- **The converse turn** (`src/converse/turn.ts`) learns three things, all channel-neutral and pure of any
  carrier:
  - a turn can be stopped from outside (an `AbortSignal`), which is not a failure;
  - the next caller turn can say what the caller heard of the last reply (`Heard`), and the conversation is
    rewritten to that;
  - on a call, a bridge line is said when no text has come after 1.2 s.
- **The voice transport** keeps one per-call I/O object (`VoiceIo`, new `server/voice/io.ts`), moved out of
  `server/adapter.ts` with no change of behaviour: sending frames, the end held for playback, the frame log,
  the console, saving the call. The adapter's scripted turn-taking stays where it is and uses the same I/O.
- **A converse voice runtime** (new `server/voice/converseRuntime.ts`) mirrors the chat's
  (`server/chat/converseRuntime.ts`): the transport hands it the setup, final prompts, interrupts and the
  carrier's playback reports, and it answers with text frames.
- **The transport dispatches by app**: a call whose app is a converse app goes to the converse runtime at
  setup, at each message, at the socket's close and at the carrier's callback. A scripted app's call takes
  exactly today's path.
- **The harness** (`src/eval/`) gains a voice driver over the relay wire that plays the carrier: playback at
  speaking pace, a caller cutting in, and the recognizer ending a turn early.

**Tech stack:** TypeScript, zod, vitest, `ws`, pnpm workspace. The carriers' ConversationRelay text wire
(`src/channel/relay/`), as today.

**Spec:** [docs/designs/2026-11-11-agent-runtime.md](2026-11-11-agent-runtime.md), approved by the maintainer
on 2026-11-11, with [journeys](2026-11-12-journeys.md). Read the spec's "The shape", "The conversation loop",
"Tools, the gate and confirmation" and "Settled after the builder's review" before any task. Plan 1 is
[2026-11-11-agent-runtime-plan-1.md](2026-11-11-agent-runtime-plan-1.md); its Task 8 is the chat runtime this
plan mirrors.

**Later (plan 3):** Google Calendar through a service account; caller records on the phone; removing the old
agent mode and renaming `mode: converse` to `mode: agent`; guide chapter 18 and CLAUDE.md rewritten; live
calls on both carriers; the cost report.

## Rulings (the designer's calls, for the maintainer to check)

1. **Where the transport is cut.** The spec says `server/adapter.ts` becomes the transport plus the scripted
   mode's turn-taking. Its per-call state is about forty module-level maps keyed by the call, and the
   scripted hooks run line by line through the transport code. Rewriting it as a runtime behind an
   interface would touch every scripted voice path at once. This plan moves out only what both runtimes
   need (Task 3: sending, the end held for playback, the frame log, the console, saving) and dispatches
   converse calls at the four entry points (Task 4). The scripted turn-taking stays in `adapter.ts`. If
   wrong: the scripted interruption work (the spec's related work) does its own further extraction later.
2. **Converse calls are always interruptible by speech.** `BARGE_IN` and `BARGE_IN_<CARRIER>` stay scripted
   settings; the spec's goal 4 makes interruption part of the converse runtime, and a setting to turn it off
   would be a default and an escape for one fix (an anti-goal). If wrong: a carrier's false interrupts cut
   replies on live calls, which plan 3's live calls would show.
3. **Telnyx playback events are on for every converse call** (the answer document's `events`, whatever
   `TELNYX_EVENTS` says): the runtime cannot tell what the caller heard without `tokensPlayed`, nor a real
   cut-in from Telnyx's spurious `interrupt` frames without `clientSpeaking`.
4. **"Played nearly to the end"** (left to the builder by the spec): a read-back counts as heard when the
   caller heard at least 85% of its characters (`READ_BACK_HEARD_AT = 0.85`), or the carrier reported it
   finished.
5. **Keys pressed on a converse call** are logged and otherwise ignored in v1: the converse line has no
   keypad menu, and passing each digit as a turn would need a join window (an anti-goal). If wrong: a caller
   pressing 0 hears nothing.
6. **After a restart**, a turn that was running is asked again on the caller's same words (the spec: a
   stream in progress is not resumed, the model is asked again); a call waiting on the caller says nothing
   new. No resume line is added.
7. **The bridge** is agent.yaml's `lines.bridge`, default `{ en: 'One sec.' }`, said at most once per turn,
   on a call only, after `BRIDGE_AFTER_MS = 1200` with no text said, not interruptible, and kept out of the
   conversation the model is sent (it commits nothing). Speech that starts over it is the next turn, never a
   cut-in.
8. **Budget for Task 8**: $15 for the voice runs (Haiku callers, Muse Ember line). The maintainer confirms it
   before Task 8.

## Global constraints

- The root CLAUDE.md rules hold: no real personal data (555 numbers, invented names), no key in any file,
  log or message, nothing published.
- Engine code, tests and fixtures in `packages/dialogwright` use neutral words (caller, business, visit,
  request, action). Nothing about wheels, cars or shops.
- `src/converse/` never imports the scripted engine (`src/boundary.test.ts`, `SCRIPTED_ENGINE`). The new
  `server/voice/converseRuntime.ts` never value-imports `server/adapter.ts`, `run/**`, `core/turn` or any
  other module of `SCRIPTED_ENGINE`: add it to the boundary test's checked roots in Task 4. A new module
  that imports `channel/relay` joins `RELAY_USERS` in the same test.
- **The scripted mode is untouched in behaviour.** Every existing voice test passes unedited, except the
  three that assert a converse app is refused calls (`server/converseChat.e2e.test.ts` near lines 389 and
  409, `server/doctor.test.ts` near lines 985 to 1024), which Task 5 changes by design. The testkit's
  and the apps' regressions stay exact.
- Converse chat is unchanged: every existing converse and chat test passes unedited.
- No real model, decision-model, carrier, text or calendar call in a test or in CI: fakes, `FakeRelay` and
  cassettes only.
- Recording and evaluation runs are the author's step: each command refuses in CI, keys come from a
  git-ignored `.env` and are never printed.
- No em dash in any doc, comment shipped in docs, or line (`src/wording.test.ts`).
- Values from the spec and the rulings, verbatim: `BRIDGE_AFTER_MS = 1200`, `READ_BACK_HEARD_AT = 0.85`,
  `lines.bridge` default `{ en: 'One sec.' }`, the converse session schema `'converse-1'` (as on chat).

**Each task ends with the full gate:**
- `pnpm typecheck`, `pnpm check` and `pnpm test`;
- `pnpm --filter dialogwright regress:testkit`;
- the apps' stub and recorded regressions (clinic, utility, secretary, harbor, wheelshop);
- `python3 -I ~/.claude/dialogwright-tools/privscan.py . origin/main..HEAD`, with 0 hits.

`pnpm adopt:test` runs after Tasks 5 and 6 (an exported type and a command line change).

**Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Landing:** Tasks 1 to 7 merge to local main once green. Task 8 runs from main. Pushing and deploying to the
Mini follow the maintainer's standing rules (merge and push when green, both scans clean). Putting a converse
app on a real number is the maintainer's step.

## Review focus

1. **A cut-in while a confirmed change is running.** The caller says yes, the action starts, the caller speaks
   again before the done line. The action runs once, its result is in `done`, and the new words are answered
   by the next turn. Test in Task 1 (`an abort after the yes leaves the change run and recorded`) and Task 4
   (`a cut-in during a confirmed change runs it once`).
2. **"Yes" said over a read-back before it finished** is not a confirmation: the model is told the caller
   spoke over it, and the next call of the action brings a fresh read-back. Test in Task 1
   (`a yes over a read-back heard in part confirms nothing`) and Task 4.
3. **The recognizer ends a turn early.** A second final prompt arrives while the first turn's model is still
   streaming and nothing has played. Both texts reach the model, in one user message, with no recovery line
   and no failure counted. Test in Task 4 (`a second final before anything played is one turn`).
4. **The socket drops mid-turn and the carrier reconnects.** The caller's last words are asked again once,
   and a change confirmed before the drop is not done twice (its idempotency key). Test in Task 4
   (`a restart mid-turn asks the model again once`).
5. **Telnyx's spurious `interrupt`** (no `clientSpeaking`) does not stop the turn or rewrite the
   conversation. Test in Task 4 (`a Telnyx interrupt with no caller speech is ignored`).

---

### Task 1: The converse turn on a call: stopping, what was heard, the bridge

Pure changes in `src/converse/`: no server code.

**Files:**
- Modify: `packages/dialogwright/src/converse/turn.ts` (`Input`, `Out`, `converseTurn`, `Speaker`, the
  read-back's answer)
- Modify: `packages/dialogwright/src/converse/trace.ts` (`ConverseTraceRecord`)
- Modify: `packages/dialogwright/src/converse/business/schema.ts` (`lines.bridge`)
- Modify: `packages/dialogwright/schemas/agent.schema.json` (regenerated: `pnpm --filter dialogwright schemas`)
- Test: `packages/dialogwright/src/converse/turn.test.ts`, `packages/dialogwright/src/converse/business/check.test.ts`

**Interfaces:**
- Produces, in `converse/turn.ts`:
```ts
/** What the caller heard of the line's last reply, as the channel knows it. */
export interface Heard {
  /** The caller spoke over the last reply before it finished playing. */
  cutIn: boolean;
  /** What they heard of it (the carrier's report, else the channel's estimate); null: unknown. */
  text: string | null;
  /** The caller began speaking before the last reply began to play. */
  spokeBefore: boolean;
}
export type Input = { kind: 'start' } | { kind: 'text'; text: string; heard?: Heard } | { kind: 'left' };
export interface Out {
  say(text: string, final: boolean): void;
  end(how: 'closing' | 'handoff'): void;
  scrubbed?(scrub: (text: string) => string): void;
  /** A bridge line, on a call only: said whole, never interruptible, never part of the reply. */
  bridge?(text: string): void;
}
export const BRIDGE_AFTER_MS = 1200;
export const READ_BACK_HEARD_AT = 0.85;
export const CUT_IN_NOTE = ' [The caller cut in here.]';
export const UNHEARD_NOTE = '[The caller spoke before hearing this.]';
export function readBackHeard(readBack: string, heard: Heard | undefined): boolean;
export async function converseTurn(s: ConverseState, input: Input, deps: ConverseDeps, out: Out, signal?: AbortSignal): Promise<ConverseState>;
```
- Produces, in `converse/trace.ts` (`ConverseTraceRecord`, all optional, absent as today when unused):
  `interrupted?: true`, `bridge?: true`, `heard?: { cutIn: boolean; spokeBefore: boolean; chars: number | null }`.
- Produces, in agent.yaml's schema: `lines.bridge: said('The short line said on a call when the model is slow to begin').default({ en: 'One sec.' })`.

**Behaviour:**
- **`signal` aborted** mid-turn: the model's stream is aborted at once (its own `AbortController` is
  linked to `signal`); the sentences not yet said are dropped; no recovery line, no `failures` counted, no
  `out.end`; a tool call already running finishes and its result is added, so every `tool_call` in
  `messages` keeps its `tool_result`; no further model round starts. The state returned keeps the text
  said so far as the assistant's message. The trace record says `interrupted: true`. An abort that comes
  after the turn ended changes nothing.
- **`heard` on a text input** is applied to the last assistant text block before the caller's words are
  added: `cutIn` with non-empty `text`: the block becomes `text + CUT_IN_NOTE`; `cutIn` or `spokeBefore`
  with `text` empty or null: the block becomes `UNHEARD_NOTE`; neither: unchanged. Tool calls in that message
  are kept.
- **A read-back's answer** (`st.pending` set): when `readBackHeard(pending.text, heard)` is false, nothing
  runs and the model is told, in the not-confirmed path's message, `The caller spoke over the read-back
  before it finished, so it is not confirmed. They said: "<their words>"`. The decision model is not asked.
- **`readBackHeard`**: true when `heard` is undefined, or neither `cutIn` nor `spokeBefore`; false when
  `spokeBefore`; with `cutIn`, true only when `heard.text` holds at least `READ_BACK_HEARD_AT` of the
  read-back's characters (compared after trimming and lower-casing).
- **The bridge**: only where `st.channel === 'voice'`, `out.bridge` is given and the input is a text turn.
  A timer started at the turn's start fires once after `BRIDGE_AFTER_MS` if nothing has been said (no
  `out.say`, nothing held for routing released); it calls `out.bridge(lineOn(business.lines.bridge, st.channel))`.
  It is cleared by the first `out.say`, by the turn's end and by an abort. The bridge is not added to
  `messages` and not to `replies`; the trace says `bridge: true`.

- [ ] **Step 1: Write the failing tests** in `converse/turn.test.ts`, using `fakeModel` and the existing
  helpers (`testing/converse/chat.ts`, `converse/model/testStream.ts`):
  - `an abort mid-stream stops the turn without a failure`: a model stream that yields one sentence, then
    waits; abort after the first `say`. Expect: the state's `failures` 0, no recovery line said, the last
    assistant text is that sentence, the trace record has `interrupted: true`, and the model's signal was
    aborted.
  - `an abort while a lookup runs keeps its result`: abort while the tool's promise is pending; resolve it.
    Expect every `tool_call` in `messages` to have its `tool_result`, and no second model request.
  - `an abort after the yes leaves the change run and recorded`: a pending read-back, input "yes", abort as
    the action runs. Expect the action's impl called once, `done` holding it, the audit's confirm row.
  - `what was heard replaces the last reply`: three cases on a two-turn conversation: `{cutIn: true, text:
    'Sure, we have'}` gives `'Sure, we have [The caller cut in here.]'`; `{cutIn: true, text: ''}` and
    `{spokeBefore: true, text: null, cutIn: false}` give `'[The caller spoke before hearing this.]'`.
  - `a yes over a read-back heard in part confirms nothing`: `heard: {cutIn: true, text: <first 60% of the
    read-back>, spokeBefore: false}`, input "yes". Expect the action not run, no Jev request, and the next
    model request's last user message to contain `The caller spoke over the read-back before it finished`.
  - `a yes over the read-back's last words confirms`: `text` holding 90% of it. Expect the action run.
  - `a yes begun before the read-back confirms nothing`: `spokeBefore: true`. Expect the action not run.
  - `the bridge is said once when the model is slow`: `channel: 'voice'`, fake timers, a model whose first
    text comes at 2,000 ms. Expect `out.bridge('One sec.')` once at 1,200 ms, before the first `say`; the
    bridge absent from `messages` and `replies`; trace `bridge: true`.
  - `no bridge on chat, after text, or without out.bridge`: three cases, each expecting no call.
- [ ] In `converse/business/check.test.ts`: `lines.bridge defaults to One sec.` and a business's own bridge
  is kept.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter dialogwright test converse/turn converse/business`
- [ ] **Step 3: Implement** in `turn.ts`, `trace.ts`, `business/schema.ts`; regenerate the schemas.
- [ ] **Step 4: Run them and see them pass**, then the full gate.
- [ ] **Step 5: Commit:** `converse: a turn stopped from outside, what the caller heard, and the bridge on a call`.

### Task 2: Saved calls of either runtime

The call store and the server's call entries hold a converse state as well as a scripted session, as the
chat's store already does (`StoredChat.schema: number | string`, `session: unknown`).

**Files:**
- Modify: `packages/dialogwright/src/server/stores/types.ts` (`StoredCall`)
- Modify: `packages/dialogwright/src/server/sessions.ts` (`CallResources`, `CallEntry`, `SessionStore`:
  `persist`, `storedOf`, `fits`, `resumable`, `hold`, the restore log, renewals, the sweep)
- Modify: `packages/dialogwright/src/server/index.ts` (the call factory near lines 814 to 847, `sweepSaved`
  near 858, the idle sweep near 1325)
- Modify: the memory, file and Postgres stores only where they type `session` (`server/stores/*.ts`)
- Test: `packages/dialogwright/src/server/sessions.test.ts` (new cases), `runStoreContract` unchanged and passing

**Interfaces:**
- `StoredCall.schema: number | string` (`SESSION_SCHEMA` for a scripted call, `'converse-1'` for a converse
  one), `StoredCall.session: Session | ConverseState`.
- `CallResources.session: Session | ConverseState`; `CallResources.opts: RunOptions | null` (null for a
  converse call).
- New, in `server/sessions.ts`:
```ts
export const CONVERSE_CALL_SCHEMA = 'converse-1';
export function isConverseCall(s: Session | ConverseState): s is ConverseState; // s.kind === 'converse'
/** The app id, whether the call ended, and its locale, read from either kind of session. */
export function callFacts(s: Session | ConverseState): { appId: string; ended: boolean; locale: string; channel: string };
```
- `CallFactory` gains a converse form: `(callSid: string, appId?: string) => CallResources` builds a
  converse entry (`newConverseState({ appId, callId: callSid, channel: 'voice' })`, `opts: null`, its own
  trace and frame sinks) when `appId` names a converse app. The caller number and account are filled at
  setup (Task 4).
- `fits(c)` accepts a scripted call only with `schema === SESSION_SCHEMA` and its app's `appOf` (as today), a
  converse call only with `schema === CONVERSE_CALL_SCHEMA` and a converse app of that id; anything else is
  unreadable, as today.
- Every place that read `session.appId`, `session.ended`, `session.channel`, `session.locale` reads
  `callFacts(...)` instead. Scripted-only reads (`session.pendingService`, `session.completed`,
  `session.turnIndex`, `startedAtMs`) are guarded by `!isConverseCall(...)`.

- [ ] **Step 1: Write the failing tests** in `server/sessions.test.ts`:
  - `a converse call is saved and restored with its schema`: create a converse entry for a converse app,
    `persist`, then `restore`. Expect `schema: 'converse-1'`, the state deep-equal.
  - `a converse call saved under another schema is unreadable`: `schema: 'converse-0'`. Expect the
    unreadable result.
  - `a scripted call is saved exactly as before`: the saved JSON of a scripted call is unchanged (compare
    with today's shape field for field).
  - `the sweep and renewals read either kind`: an ended converse call is swept, a live one renewed.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** No behaviour of a scripted call changes; `runStoreContract` passes unchanged
  for every store.
- [ ] **Step 4: Run them and see them pass**, then the full gate.
- [ ] **Step 5: Commit:** `server: a saved call holds a scripted session or a converse state`.

### Task 3: The call's I/O out of the adapter

Move the transport parts that both runtimes need out of `server/adapter.ts` into one per-call object. This is
a move, not a rewrite: the scripted code calls the same logic through the object.

**Files:**
- Create: `packages/dialogwright/src/server/voice/io.ts`
- Modify: `packages/dialogwright/src/server/adapter.ts`: `sendOne` (near 2029) and the transport part of
  `sendFrames` (near 2166: the socket, the send timeout, out and dropped logging, the `textLast` spacing);
  the end held for playback (`holdsEnd` near 1529, `holdEnd`, `onHeldEndEvent`, `sendEndAfterPlayback`,
  `replayEnd`, `holds`, `isTransfer`, `endSends`, `heldEndsOf`, `armEndGrace`, `reportsPlayback`); `loggedFrame`,
  `publish`, `logDelivery`, `recordedCarrierEvent`; the end of a turn's `finally` (store end, token revoke,
  grace).
- Modify: `packages/dialogwright/src/boundary.test.ts` (`RELAY_USERS` gains `server/voice/io.ts`)
- Test: `packages/dialogwright/src/server/voice/io.test.ts` (new), every existing voice test unedited

**Interfaces:**
- Produces, in `server/voice/io.ts`:
```ts
export interface VoiceIo {
  /** Sends frames on the call's socket, as the adapter did (textLast spacing, timeout, the frame log); false when not delivered. */
  send(frames: readonly OutboundFrame[]): Promise<boolean>;
  /** Sends the call's end, held until the lines before it have played where the carrier needs it (END_AFTER_PLAYBACK). */
  sendEnd(end: EndFrame): Promise<void>;
  /** Logs a frame in or out in the call's frame log. */
  record(dir: 'in' | 'out', message: unknown): void;
  /** Publishes a console event for the call. */
  publish(event: DashboardEvent): void;
  /** Saves the call (SessionStore.persist). */
  save(): Promise<void>;
  /** Ends the call on this server: the store's end, the token revoked, the close grace armed. */
  finish(): Promise<void>;
  /** Hands the io a carrier's playback event, for the held end (the adapter's onHeldEndEvent). */
  playback(event: PlaybackEvent): void;
}
export function voiceIoOf(entry: CallEntry, deps: AdapterTransportDeps): VoiceIo;
export type AdapterTransportDeps = Pick<AdapterDeps, 'store' | 'tokens' | 'sendTimeoutMs' | 'endCloseGraceMs' | 'bus' | 'host'> & { endAfterPlayback: EndAfterPlayback };
```
  (`EndAfterPlayback` is today's END_AFTER_PLAYBACK settings type in the adapter; move it with the code.)
- The adapter keeps every scripted map and decision. Where it sent, held an end, logged or published, it now
  calls the call's `VoiceIo`.

- [ ] **Step 1: Write the failing tests** in `server/voice/io.test.ts`, with `fakeSocket()` as in
  `adapter.test.ts`:
  - `send spaces non-final text on a final-only carrier`: two text frames with `last: false` then `last:
    true` on a `textLast: 'final'` provider. Expect the first token to end with a space, and both logged out.
  - `sendEnd waits for the lines to play on a carrier that drops speech`: a provider with `endDropsSpeech`;
    expect the end sent only after a `playback finished` event, or after the estimate times the factor.
  - `finish ends the call once`: twice called; expect one store end and one token revoke.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Move the code.** Keep each function's body; change only how it reaches the socket and the
  entry. Run the voice tests (`pnpm --filter dialogwright test server/`) after each group moved.
- [ ] **Step 4: Run all tests and see them pass**, every existing voice test unedited, then the full gate.
  The frame logs of the testkit's and the apps' regressions are byte for byte the same.
- [ ] **Step 5: Commit:** `server: the call's I/O out of the adapter (VoiceIo), with no change of behaviour`.

### Task 4: The converse voice runtime

**Files:**
- Create: `packages/dialogwright/src/server/voice/converseRuntime.ts`
- Modify: `packages/dialogwright/src/server/adapter.ts`: at `setupVerified` (near 2555, the create path near
  2705), `handleSocketMessage` (near 2773) and `handleSocketClose` (near 3090), a call whose entry
  `isConverseCall` goes to the converse runtime before any scripted code runs.
- Modify: `packages/dialogwright/src/server/http.ts`: `decideAction` (near 530) and `servedOf` (near 304)
  read `callFacts`; a converse call's hangup writes its `call_ended {reason: 'hangup'}` row through the
  runtime; a converse call's handoff dials from the runtime's transfer (Task 5 wires it).
- Modify: `packages/dialogwright/src/boundary.test.ts`: `server/voice/converseRuntime.ts` is checked against
  `SCRIPTED_ENGINE` and joins `RELAY_USERS`.
- Test: `packages/dialogwright/src/server/voice/converseRuntime.test.ts` (unit, fake io),
  `packages/dialogwright/src/server/converseVoice.e2e.test.ts` (whole server, `FakeRelay`)

**Interfaces:**
- Consumes: Task 1's `converseTurn(..., signal)`, `Heard`, `Out.bridge`; Task 2's `isConverseCall`,
  `CONVERSE_CALL_SCHEMA`; Task 3's `VoiceIo`.
- Produces, in `server/voice/converseRuntime.ts`:
```ts
export interface ConverseVoiceRuntime {
  /** The call's setup: the state's caller number and account, then the greeting turn. */
  open(entry: CallEntry, setup: { callerNumber: string | null; provider: string }, io: VoiceIo): Promise<void>;
  /** A relay frame from the carrier: prompt, interrupt, dtmf or error. */
  frame(entry: CallEntry, frame: InboundFrame, io: VoiceIo): Promise<void>;
  /** A carrier playback event (Telnyx's agentSpeaking, clientSpeaking, tokensPlayed). */
  playback(entry: CallEntry, event: PlaybackEvent, io: VoiceIo): void;
  /** A socket replaced after the carrier reconnected: a turn cut by the drop is asked again. */
  resumed(entry: CallEntry, io: VoiceIo): Promise<void>;
  /** The caller hung up (the carrier's callback): a running turn stopped, the left turn run, its audit row. */
  hangup(entry: CallEntry): Promise<void>;
}
export function converseVoiceRuntime(deps: { apps: ReadonlyMap<string, ConverseApp>; converseDeps: (app: ConverseApp, callId: string) => ConverseDeps; now: () => number }): ConverseVoiceRuntime;
```
- The runtime keeps, per call, outside the saved state: the running turn's `AbortController` and promise;
  the text frames sent for the current reply and the time each was sent; what has played (`tokensPlayed`
  text joined, or Twilio's `utteranceUntilInterrupt`); whether the caller is speaking and since when; the
  caller's words of a running turn (`turnWords`), saved with the call so a restart can ask again
  (`StoredCall` gains `turnWords?: string`, read only for a converse call; `CallEntry.inFlight` is the
  adapter's own counter and is not this).

**Behaviour:**
- **Sending.** `Out.say(text, false)` sends `textFrame(text, true)` with `last: false`; `Out.say(text, true)`
  sends it with `last: true`. `Out.bridge(text)` sends `textFrame(text, false)` with `last: true`.
  `Out.end('closing')` sends `endFrame('completed', true, ...)` through `io.sendEnd`; `Out.end('handoff')`
  sends the transfer end to the app's transfer number where it has one, else the completed end (the handoff
  line and the callback note are the converse turn's own). The greeting turn runs at `open`.
- **One turn at a time.** Turns run in order on a per-call queue. A final prompt (`last: true`) while a turn
  is running aborts it and waits for it to settle, then runs the new turn.
- **What was heard**, given with each text turn: `cutIn` when the caller spoke while the last reply was
  playing; `text` from Twilio's `utteranceUntilInterrupt`, or the `tokensPlayed` text seen since the reply's
  first frame on Telnyx, else the sentences whose estimated playback (`playbackEstimateMs`) ended before the
  caller began; `spokeBefore` when the caller's speech began before the reply's first frame was sent (on
  Twilio, the first partial prompt; on Telnyx, `clientSpeaking: on`).
- **Cut-ins.** Twilio: an `interrupt` frame aborts the running turn. Telnyx: `clientSpeaking: on` while
  `agentSpeaking` is on aborts it; an `interrupt` frame alone never does.
- **The recognizer's early end.** A second final prompt arriving while a turn runs and nothing of its reply
  has played aborts it; the new turn runs on the second text, and since the first text is already the last
  user message, the model sees both together (`add` merges a user message into the one before).
- **Speech over the bridge** is never a cut-in: it is the next turn.
- **Keys** are logged with `io.record` and ignored (ruling 5). **Partial prompts** only mark when speech began.
- **A correction** from the check after speaking (agent.yaml `checks.claims.mode: correct`; off by default)
  is sent only once the reply's final frame has played, and dropped if the caller began to speak first (the
  comment on `Out` in `converse/turn.ts` says so).
- **Saving.** `io.save()` after each turn, and before a turn with `turnWords` set. On `resumed`, a call whose
  `turnWords` is set runs that turn again (the model asked again, the gate's idempotency keys keep a
  confirmed change from running twice); otherwise nothing is said.
- **Ending.** An ended state calls `io.finish()` after its end is sent, and writes the audit's `call_ended
  {reason}` (closing, handoff, left), as the chat runtime does (`server/chat/converseRuntime.ts`, near
  lines 137 to 144). The console gets the same events the chat runtime gives it, with the channel voice.

- [ ] **Step 1: Write the failing unit tests** in `converseRuntime.test.ts`, with a fake `VoiceIo` recording
  frames and `fakeModel`:
  - `the greeting is one final text frame`.
  - `a reply streams as non-final frames and one final frame`: two sentences, expect `last: false` then
    `last: true`, both interruptible.
  - `a Twilio interrupt stops the turn and the next turn hears what was played`: interrupt with
    `utteranceUntilInterrupt: 'Sure, we have'`, then a final prompt. Expect the model's next request to hold
    `'Sure, we have [The caller cut in here.]'`.
  - `a Telnyx interrupt with no caller speech is ignored`: an `interrupt` frame, no `clientSpeaking`. Expect
    the turn not aborted and the conversation unchanged.
  - `Telnyx clientSpeaking over a reply is a cut-in, heard from tokensPlayed`.
  - `a second final before anything played is one turn`: two finals 300 ms apart while the model waits.
    Expect one model request with both texts in the last user message, no recovery line, `failures` 0.
  - `speech over the bridge is the next turn`: the bridge sent, then a final prompt; expect no abort.
  - `a cut-in during a confirmed change runs it once`.
  - `keys are logged and ignored`.
  - `a correction waits for the reply to play, and is dropped when the caller speaks first`.
- [ ] **Step 2: Write the failing e2e tests** in `server/converseVoice.e2e.test.ts`, on the converse fixture
  app (`testing/converse/`), following `voice/bargeIn.e2e.test.ts`'s `startCall` (`loadConfig` with
  `SIGNATURE_CHECK: 'off'`, `POST /voice/<carrier>`, the token, `FakeRelay.connect`), once per carrier
  (Twilio, and Telnyx with its setup shape: `callControlId`, `from/to` null, `callStatus: 'active'`):
  - `a call is greeted, books a visit after the read-back and a yes, and ends`: the audit chain verifies,
    the trace has `kind: 'converse'` records with `channel: 'voice'`.
  - `a yes over the read-back confirms nothing` (Review focus 2).
  - `a restart mid-turn asks the model again once`: stop the server while the model's stream waits, start a
    new one on the same stores, reconnect through `/cr-action` and a new setup. Expect the model asked again
    and one booking.
  - `a scripted app's call on the same server is unchanged`: a host with both kinds; the scripted call's
    frames equal today's.
- [ ] **Step 3: Run them and see them fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them and see them pass**, then the full gate.
- [ ] **Step 6: Commit:** `server: a converse app's call, streamed, interruptible, and kept to what the caller heard`.

### Task 5: Converse apps take calls

**Files:**
- Modify: `packages/dialogwright/src/server/index.ts`: remove `voiceRefused` (near 464 to 479) and its use
  near 1196; build the converse voice runtime and an `HttpApp` entry for each converse app (its transfer from
  agent.yaml's `transfer.number`, else `HANDOFF_NUMBER`), so the host's numbers route to it.
- Modify: `packages/dialogwright/src/server/http.ts` (`connectOptions`, near 417): for a converse app's
  call, the voice per carrier from agent.yaml's `persona.voices`, `interruptible="speech"` (ruling 2), and on
  Telnyx the playback events on (ruling 3). Noise suppression (`TELNYX_NOISE_SUPPRESSION`) and the recognizer
  (`TELNYX_SPEECH_MODEL`; Twilio's default Deepgram Flux) apply as to any call.
- Modify: `packages/dialogwright/src/server/doctor.ts` (near 475 and 993 to 1001): the converse warnings and
  the host failure become checks that a converse app on a number has a voice for each carrier it is reached
  on, and a transfer number or none by choice.
- Modify: `packages/dialogwright/src/server/dashboard/calls.ts` and `view.js`: a converse call's view says
  its channel, and shows a cut-in turn's heard text and a bridge.
- Modify: `packages/dialogwright/src/index.ts`: export `Heard` with the converse types.
- Modify: `apps/wheelshop-agent/agent.yaml` (`persona.voices` for both carriers) and its `.env.example`
  (its numbers, as placeholders in the 555 range).
- Test: the three refusal tests (`server/converseChat.e2e.test.ts` near 389 and 409, `server/doctor.test.ts`
  near 985 to 1024) rewritten to the new rule; `server/host.converse.e2e.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `converseVoiceRuntime`.

- [ ] **Step 1: Rewrite the refusal tests and write the new ones:**
  - `a converse app on a host takes a call on its number`: a host with a scripted and a converse app, each
    on its own number; a call to each reaches its app.
  - `the answer document of a converse call is interruptible by speech, with Telnyx's events on`: assert
    the Telnyx document has `events` and `interruptible="speech"` with `BARGE_IN=none` set, and, with
    `TELNYX_NOISE_SUPPRESSION=krisp`, the suppression verb; a scripted app's document on the same server is
    unchanged.
  - `diagnose warns of a converse app on a number with no voice for its carrier`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass**, then the full gate and `pnpm adopt:test`.
- [ ] **Step 5: Commit:** `server: converse apps take calls on their numbers`.

### Task 6: The harness on the voice path

**Files:**
- Create: `packages/dialogwright/src/eval/voiceDriver.ts`
- Modify: `packages/dialogwright/src/eval/personas.ts` (`voice` on a persona), `eval/cli.ts` and
  `eval/compareCli.ts` (`--channel chat|voice`, default chat), `eval/server.ts` (`startEvalServer` with
  Twilio on, `SIGNATURE_CHECK` off, when the channel is voice), `eval/measures.ts` and `eval/report.ts`
  (the voice measures)
- Modify: `docs/README.md` (the `--channel` flag)
- Test: `packages/dialogwright/src/eval/voiceDriver.test.ts`

**Interfaces:**
- Produces, in `eval/personas.ts`: `voice: z.strictObject({ interrupts: z.boolean().default(false), fragments: z.boolean().default(false) }).optional()`,
  described as: the caller cuts in on long replies; the caller's longer turns reach the line in two parts, as
  a recognizer that ended a turn early.
- Produces, in `eval/voiceDriver.ts`:
```ts
export const SPEAKING_WORDS_PER_S = 2.7;
export async function driveVoice(o: { url: string; serverHttp: string; persona: Persona; caller: CallerFn; maxTurns: number; timeoutMs: number }): Promise<SimCall>;
```
  It plays a Twilio carrier: `POST /voice/twilio`, the token, the relay socket, a setup with the persona's
  `callingFrom` (or a 555 number). A reply's text frames are "played" at `SPEAKING_WORDS_PER_S` from the
  first frame. The caller model is asked for its next words once the reply's final frame has played.
  - With `voice.interrupts`: on a reply of more than 30 words, the caller cuts in when 40% of its words have
    played: an `interrupt` frame (`utteranceUntilInterrupt` the words played), then its next words as a
    final prompt. The caller model is shown only the words played.
  - With `voice.fragments`: a caller turn of more than 8 words is sent as two final prompts split at the
    middle word, 600 ms apart.
- `SimCall` gains optional `channel: 'voice'`, `cutIns: number` and `fragments: number`. `firstWordMs` on voice
  is from the caller's (last) final prompt to the line's first text frame.

- [ ] **Step 1: Write the failing tests** in `voiceDriver.test.ts`, on the converse fixture app with a fake
  model and a scripted caller (`CallerFn` returning fixed lines):
  - `a voice call books a visit and is recorded like a chat call`.
  - `an interrupting caller cuts in and is shown only what played`: expect `cutIns` 1 and the caller's
    turns holding only the played words.
  - `a fragmenting caller's long turn arrives in two parts`: expect `fragments` 1 and both parts in the
    model's last user message.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, and the report's voice rows (cut-ins, fragments, first word by channel).
- [ ] **Step 4: Run them and see them pass**, then the full gate and `pnpm adopt:test`.
- [ ] **Step 5: Commit:** `eval: simulated callers over the voice path (--channel voice)`.

### Task 7: Docs, and landing the engine

**Files:**
- Modify: `docs/designs/2026-11-11-agent-runtime.md` (a status line: plan 2 built, with this plan's rulings
  linked), `docs/README.md` (the new files and the flag), `docs/guide/14-running-it.md` (14.12: that a
  converse app's calls are interruptible by speech whatever `BARGE_IN` says, and that Telnyx's events are on
  for them), the root `CLAUDE.md` (the `src/converse/` paragraph: the phone, the bridge, what was heard;
  `server/voice/io.ts` and `server/voice/converseRuntime.ts` in the layout), `apps/wheelshop-agent/CLAUDE.md`
  and `DESIGN.md` (calls as well as chat).
- Test: `src/docLinks.test.ts` and `src/wording.test.ts` pass.

- [ ] **Step 1: Write the docs.** Facts only, in the repository's style; no em dash.
- [ ] **Step 2: Run the full gate.**
- [ ] **Step 3: Commit:** `docs: the converse runtime on the phone`.
- [ ] **Step 4: Merge to local main** once the gate is green on the merged result; push and deploy under
  the maintainer's standing rules.

### Task 8: The measured runs on the voice path

Runs from main, with the maintainer's confirmation of the budget (ruling 8).

**Files:**
- Create: `apps/wheelshop-agent/eval/voice-personas.yaml` (the existing personas with `voice` set: a third
  interrupting, a third fragmenting, a third neither)
- Create: `docs/designs/eval/2026-11-voice.md` (the results page)

- [ ] **Step 1: Run** `pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/voice-personas.yaml --channel voice --runs 4 --judge none --budget 15` (15 personas, 60 calls),
  and the same personas on `--channel chat` the same day for the comparison.
- [ ] **Step 2: Judge the calls in the session** (`eval:rejudge --inputs`, then `--verdicts`), as the spec's
  decided item 8 says.
- [ ] **Step 3: Write the results page**: the spec's bars (first word p50 at most 1.2 s, first sentence p95
  at most 2.5 s, timeouts at most 1% of turns, cooperative tasks done in at least 95%, no contradicted
  material claim), each for voice and chat; cut-ins and what came after them; fragments; bridges said; the
  spend. Say plainly which bars are missed.
- [ ] **Step 4: Commit:** `eval: the converse runtime measured on the voice path`.
- [ ] **Step 5: Report to the maintainer**: the table, the spend, and what a live call should check first
  (plan 3's live calls).

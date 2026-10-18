# Tools that wait on a system, and what the caller hears while they do

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18: build it, with the masking a classic IVR does); built on main.**

## The problem

A tool is synchronous today: `ToolDef.run(call, sys, ctx)` returns its value at once. That suits the example apps, whose systems are fixtures in memory, and it does not suit a real one: a booking line asks a scheduling API for the openings in a zip code, books one, and looks a booking up by its code, each a request over the network that takes from tens of milliseconds to several seconds. The only asynchronous path the engine has is a downstream service (`ServiceDef.resolve`), which runs after the turn has ended and comes back as a turn of its own; it fits work handed off ("I've filed that, you'll hear back"), not a lookup whose answer the turn's next line needs.

A classic IVR has long hidden that wait behind its own audio (the maintainer, 2026-10-18):

- **At the start of the call**, the caller's number is looked up while the welcome plays ("Thanks for calling ..."), so by the time it ends the account is known and the next line can use it.
- **Mid-call**, the line says "One second while I look that up" the moment the request starts; the request runs while the words play, so even a long lookup is often done by the time they end.
- **When it is not**, the line plays a thinking sound (a short clip, again and again) until the answer is in.

## What exists

- **The core is deterministic and synchronous.** `resolve` (core/turn.ts) clones the session, runs the turn's handlers and the app's hooks, and returns the next session with its actions, gate events and effects. Every tool call goes through `callTool` (core/lifecycle.ts): the gate, the tool's run, its check, redaction, and the gate event. A hook reaches a tool only through `ctx.callTool`.
- **The runner is asynchronous.** `runTurn` (run/turn.ts) awaits retrieval, the decision model and a follow-up question, calls `resolve` once, and then awaits the rendering of generated lines.
- **Early lines.** A channel that can say lines before its turn has ended (the voice relay, the chat socket) hands `runTurn` a callback (`RunOptions.early`); a knowledge answer's hold line goes through it today (`kb_hold`), and on a carrier that ends a reply at its first `last: true` (Telnyx), what follows waits for the hold line to have played.
- **Clips.** A line may be a recorded clip (a `play` frame), and the server knows how long each clip is (`clipDurations`).

## The decision

### 1. A tool may return a promise

`ToolDef.run` may return `Promise<ToolRun>`. Nothing else about a tool changes: the gate decides before it runs, its `check` reads its reply, redaction, the summary, the audit and the idempotency key are as they are.

The core stays synchronous, and is run again rather than suspended:

1. `runTurn` gives the turn a memo of the tool calls it has made (`TurnContext.toolMemo`).
2. `callTool` asks the gate as ever. On ALLOW, a tool not yet run this turn is started. A synchronous tool returns its reply at once, kept in the memo. An asynchronous tool returns a promise: the request has started, and `callTool` returns a pending outcome (value null, `pending: true`) to the hook.
3. From then on the pass is provisional. No later call of the same pass runs a tool (each returns pending too), so nothing is done on a value the hook had to guess. A hook that throws on the null it got is caught. The pass's result is never used.
4. `runTurn` waits for the pending replies (below), keeps each in the memo, and runs `resolve` again from the same session. A call already made gets its kept reply; the next unmade call may start another request. It repeats until a pass completes with nothing pending.

A call is identified by its tool, its params and its purpose, with a count for a call repeated in one turn. So each tool runs once per turn, whatever the passes, and a write is never made twice by a re-run. The turn's gate events, audit and trace are those of its final pass, which saw every reply. A pass is cheap (no model is asked again: the answers are the turn's), and a turn makes few calls.

Calls run one after another, never side by side: a later call may be made from an earlier one's reply, and the engine cannot tell which are independent. (An app that wants two lookups at once makes them one tool.)

**A reply that is late or fails.** Each call has `waiting.timeoutMs` (app.yaml, default 10000). A tool whose promise rejects, or whose reply has not come in time, is a tool that threw: with `failSoft` the hook gets null (`failed: true`) and chooses its line, without it the turn fails as a throwing tool's does (the server's apology, then a person). A write that is late may still be made downstream: the idempotency key it was given is how a retry finds it rather than makes it again, and the guide says to say "a person will confirm" rather than "it failed" after a late write.

**Where the core runs without a runner.** A caller of `resolve` that gives no memo (a unit test of the core) gets an error from an asynchronous tool rather than a wrong turn. `runTurn` waits, and so does the harness's seeding of a corpus entry's state (`untilReplied`, made again from a fresh copy of the session), so an app's corpus, scripted calls and adversarial suite run its asynchronous tools against their fakes.

### 2. A hold line said while a tool runs

```yaml
# app.yaml
waiting:
  line: lookup_hold          # said once a turn has waited afterMs on a tool; none by default
  afterMs: 0                 # or { voice: 0, chat: 1500 }; default 0
  sound: thinking            # a clip, played after the line while the turn still waits; none by default
  start: welcome_hold        # said at the call's start while its lookups run (the caller's number, onStart)
  timeoutMs: 10000           # how long a tool may take
```

A tool may name its own line (`ToolDef.waiting: { line: 'booking_hold' }`: "One moment while I book that."); the first pending call's line is the one said. The line goes through the early lines a channel already takes, before the turn has ended, and what the turn says follows it: the caller hears "One second while I look that up", and the answer after it. `afterMs: 0` says the line whenever a tool is asynchronous (the classic IVR: the request starts as the words do); a few hundred milliseconds says nothing for a fast reply and the line for a slow one. A chat, whose reader sees the reply appear, may want a longer wait or none (`afterMs: { chat: 1500 }`).

A channel that says nothing early (the text harness, a chat that answers one request with one reply) says no hold line; the trace records the line the turn would have said and whether it went (`TraceRecord.waited`), so a scripted call shows it.

### 3. A thinking sound until the reply is in

After the hold line has played (by the channel's estimate of how long it takes), a turn that is still waiting plays `waiting.sound`, a clip, one at a time: the next only once the last should have played, so when the reply comes the caller waits at most the rest of one clip. Telnyx cannot stop a playback once it has started (server/voice/telnyx.ts), so the sound is never one long loop that the reply would have to cut; a short clip (a second or two) is the right size. A chat plays no sound (a chat has none); the widget's own indicator shows that a reply is coming.

### 4. Lookups at the start of the call, behind the welcome

The start turn runs the caller's number lookup and the start hook (`onStart`), and then says the greeting. Where either makes an asynchronous call, `waiting.start` is said at once (the welcome every caller hears), the lookups run while it plays, and the greeting that follows may use what they found ("Hi Sam, are you calling about your appointment on Tuesday?"). With no `start` line, the start turn waits silently, as any turn with no `line` does.

### 5. Later: a call started before it is needed (not built)

A form could start a lookup it will need while it asks a question it does not need it for: the openings for a service and a zip code, asked for while the caller is asked their name. That needs a call started on one turn and read on another, held beside the session (never in it: a saved session holds no promise), the gate asked again when it is read, and the reply dropped if the call it would answer has changed. It is left until an app shows the wait the hold line and the sound do not hide.

## What it costs

- A turn with asynchronous tools runs the core once more for each call that waited: microseconds against the network's milliseconds.
- An app whose tools all reply at once is exactly as it was: one pass a turn, the same decisions, no field added to its trace (a test holds the testkit's every scripted call to the same lines, gate events and audit with its tools made asynchronous).
- The hold line and the sound are lines like any other: in prompts.yaml (and its locales) and the clips folder, checked by `pnpm check`.

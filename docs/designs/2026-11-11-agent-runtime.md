# Agent mode as its own runtime

Status: draft for the maintainer's approval, 2026-11-11. It replaces the agent mode of
[2026-11-08-agent-mode.md](2026-11-08-agent-mode.md), which is kept as history.

## Why

DialogWright has one product that works: the **scripted mode**. Deterministic code steers the call, a
decision model (Jev) answers typed questions about what the caller said, and every line is fixed or is
generated inside a line the engine chose, under checks. Models still have a place inside it, as in the
insurance demo's answers summarised from approved documents. The maintainer thinks this mode is where
DialogWright's advantage lies: it is different from the fully agentic products most companies sell, with
real strengths and known limits. It stays, and nothing in this design may weaken it.

The 2026-11-08 agent mode tried to add a model-led conversation **on top of** that engine. The model wrote
the replies, while the engine still picked the next question, made the offers, ran the attempt ladders,
said the fixed lines and fell back to its own next question. Two owners steered one conversation. About
thirty live-call fixes in three days (items 31–58 of that design) each reconciled them at one seam, and
the next call found another. Measured over calls 55–65 (140 caller turns):

- the caller heard the model's reply on only 38% of turns;
- 37% got a fixed line by design;
- 25% got a fixed line because the model failed, its reply was refused, or the turn was set aside;
- a question already answered was asked again 24 times, in 9 of the 11 calls.

The model was also asked for too much in one strict JSON answer (reply, values with cited words, action,
`asks`, `closes`, fixed line, source flag). Mercury leaked the schema into speech ("…What are you
driving?values"), dropped values and timed out. Under it, the voice layer rebuilt turn-taking from timers
because lines could not be interrupted. An independent review (Fable) reached the same conclusion: the
halfway point is worse than either end.

The maintainer's intent, in his words: a *completely separate* model-driven approach, not sitting on the
engine. That is what he wanted from the start.

## What agent mode is for

A business that wants its line to talk like a person:
- it words each reply its own way ("2022 Porsche 911, nice car!");
- it answers what the caller throws at it, within the business's world;
- it follows the caller's order, not a form's.

The client knowingly accepts three things:
- it costs more per call;
- they cannot choose every word it says;
- it will sometimes be a little odd in ways the scripted mode never is.

**Success:**
- the task gets done, and nothing is booked or sent without the caller's yes;
- callers talk to it naturally: they interrupt, wander, correct themselves, and give things in any order;
- it never asks again something it was just told;
- its pauses feel natural.

**Honesty, not impersonation.** A business gives the agent a persona: a voice (which speech model and voice)
and a speaking style, such as "a friendly auto-shop guy from the South". The style shapes how it talks,
never what it claims. It never pretends to be human:
- no fake background noise, typing sounds or "let me check with my manager" theatre;
- asked whether it is a real person, it says it is an automated assistant for the business, and offers a
  person where the business has one. A business cannot turn this off.

## Goals

1. A separate runtime in which a model holds the whole conversation (phone and web chat, both from the start).
2. Actions stay safe:
   - every tool call goes through DialogWright's policy gate and is written to the hash-chained audit log;
   - an action that changes something runs only after a read-back of its exact details, said by the
     runtime, gets the caller's yes.
3. The rules belong to each business's information, not to agent mode. Agent mode itself enforces only
   two things, for every business:
   - never claim what the business's information or the data looked up on the call doesn't support;
   - confirm before acting.
4. Natural turn-taking: the caller can interrupt, and the speech recognizer's own end-of-turn decides when
   they have finished.
5. Changes are judged by measured rates over many simulated calls, not by single live calls.
6. The wheel shop is rebuilt on the new runtime. The old agent mode is taken out of the scripted engine.

## Non-goals (for now)

- Software-as-a-service concerns: tenancy, onboarding, billing, number provisioning.
- Identity verification levels, the knowledge base and approved documents as sources in agent mode. They
  plug in later as sources (below).
- Speech-to-speech models: they don't fit the carriers' text relay.
- Scheduling systems other than Google Calendar.
- Restoring interruption to the scripted mode. That is related work, tracked separately (below).

## Anti-goals (a failure even if it works)

- Two owners of one conversation, or the runtime overriding the model's question with its own.
- An agent that passes for a human.
- Tuning by single calls: a new mechanism, setting or rule added because one call went wrong, without a
  measured rate that moved.
- Any change that makes the scripted mode worse.
- A default and an escape setting for every fix.

## Constraints

- Every rule in the root CLAUDE.md that is not about the old agent mode still holds:
  - no real personal data (555 numbers, invented names);
  - no key in any file, log or message;
  - the engine's vocabulary stays neutral;
  - nothing published.
- Claude models are called through the Anthropic API with the maintainer's own key (ANTHROPIC_API_KEY,
  git-ignored), never through OpenRouter. Inception models are called directly; other providers through
  OpenRouter.
- Model calls in tests use fakes. Real-model runs (the comparison, the simulated callers, recordings) are
  the author's step, with the author's keys, and never run in CI. The maintainer has allowed recording runs.
- Never send a real text, or write to a real calendar, from a test.

## The shape

### One runtime, chosen per app

- An app says which runtime it uses (`mode: agent` keeps its meaning; everything else is the scripted
  engine). The same server hosts both, alongside other apps (host.yaml), on the same numbers and chat paths.
- **The agent runtime does not import the scripted engine:** not the core turn, forms, slots, prompts,
  Jev turn questions, render or the scripted turn-taking. A test enforces the boundary.

**What it shares:**
- **Transport.** The carriers' relay websocket and its text frames (Twilio and Telnyx ConversationRelay,
  signature checks, the start documents with Flux and Krisp settings), the chat wire
  (`channel/chat/protocol.ts`) and the widget.
- **Gate and audit.** The policy gate, the named rules and the hash-chained audit log.
- **Capabilities:** texting (`ToolContext.texts`), the session stores, traces and the console (an agent
  call's view is its own), the handoff and dial machinery for live transfers, host.yaml, configure, start
  and diagnose.

`server/adapter.ts` today mixes transport with the scripted mode's turn-taking (joins, speech over a line,
held replies, re-said lines). The scripted parts must be separated from the transport so the agent
runtime gets plain frames.

### The conversation loop

- The model receives a system prompt and the conversation so far.
  - The system prompt holds the business's information, its persona, the two agent-wide rules, the date
    and time, and what is known of the caller (caller number, a recognised account).
  - It may call the business's tools.
- The reply is plain text, **streamed** to the caller as it is written: to the carrier as text tokens, and to
  the chat as one message or as chunks (the builder's call).
- There is no JSON around the reply and no fields that steer the runtime. Values reach the runtime only as
  tool arguments.
- **Interruption.** When the caller starts speaking:
  - the runtime stops the line (the carrier's interrupt) and cancels the model's stream;
  - the conversation records what the caller actually heard (the carrier's playback reports tell how far
    it got) and that they cut in.
- **Bridges** (the maintainer, 2026-11-11: a short "one sec" while waiting is how people talk; staff
  waiting on a slow system say so):
  - **Before a lookup:** the model may say a short line itself ("Let me check what we have Friday."),
    and it is streamed before the tool runs.
  - **When the model is slow:** the runtime says one short bridge from the business's own lines (for
    example "One sec.") if no text has come after about 1.2 s. On the phone only, at most once per turn.
  - **Speech over a bridge:** a caller's "okay" over it is just conversation. Speech that started before a
    read-back began never confirms it.
  - **Honesty:** a bridge never pretends anything; no fake typing or background sounds.
  - This is built with the phone, in plan 2.
- **End of turn.** The recognizer's final transcript ends the caller's turn (Flux on both carriers). The
  runtime adds no join windows, speech-over-line rules, held replies or filler lines. If a short debounce
  proves necessary, the simulated and live calls must show it.
- **Failures** (a provider error, a timeout, a refusal by the provider's content filter):
  - the turn is asked once more if time allows;
  - otherwise the line says one short fixed recovery line from the business's information ("Sorry, could
    you say that again?") and the conversation goes on;
  - the call is handed off only after a per-call failure budget the business sets, never on two in a row.

### Business information (per business)

One file per app replaces business.yaml's current shape. A schema-validated YAML, like every app file, holds:

- **Who the business is:**
  - name, what it does, where;
  - hours and days;
  - services and what it doesn't do;
  - **prices as ranges**, with the business's own caveat ("usually $X–$Y per wheel; the shop confirms the
    price once it sees the damage");
  - policies;
  - anything the agent may say.
- **Persona:** voice settings per carrier, a speaking style, a greeting, a closing.
- **What the agent collects** for each action: plain descriptions of the details. These are guidance for
  the model, not a form, and carry no order.
- **Sources:** the calendar, caller records (accounts recognised by the number they call from), and later
  the knowledge base and identity.
- **Actions:** each tool the agent may call, with:
  - its parameters and their types (date, time slot from a lookup, choice, number, text, phone number);
  - whether it is a lookup or changes something. Every action that changes something needs
    confirmation, for every business (that is agent mode's own rule). The business words its read-back
    frame, with the parameters as placeholders;
  - for an action that changes something, the follow-on actions that run after its confirmed yes with no
    read-back of their own, each still through the gate. For the wheel shop: after the request, the
    photo-request text (only with consent) and the owner's summary. The model doesn't have to remember
    them, and the caller hears one read-back;
  - its policy rules, in the same declarative policy the scripted mode uses (consent to text, limits,
    business hours, a slot that must come from the lookup);
  - how its result is described to the model.
- **The short recovery lines and the handoff line.**

The wheel shop's current assumptions (days, windows, services, accounts) carry over, still marked as
assumptions for the owner to correct.

### Tools, the gate and confirmation

1. **The call.** The model calls a tool by name with arguments. The runtime checks the arguments by type: a
   date is a real date, a choice is one of its options, a time slot is one the calendar lookup returned on
   this call, a phone number is a number.
   - A failed check goes back to the model as the tool's result, with a reason it can act on.
   - The model then asks the caller or looks again.
2. **The gate.** Every call then goes through the gate, which checks the business's rules and writes its
   decision, allowed or refused, to the audit log.
   - A refusal goes back to the model with a reason it can act on, such as "the caller hasn't agreed to
     texts" or "that time isn't free".
   - Reasons hold nothing the audit's recording rules would keep from the model.
3. **Lookups** (availability, a caller's account) run once allowed. Their results go back to the model.
4. **Actions that change something** (book, send the request, text the caller, leave a callback note)
   need confirmation:
   - The runtime says the business's read-back frame, filled with **exactly** the call's arguments as each
     type displays them.
   - The decision model (Jev) reads the caller's answer: yes, no, or neither.
   - **A yes** runs the tool, with an audit row tying the yes to the hash of exactly those arguments. The
     gate refuses a confirming action without that row.
   - **Anything else** goes back to the model as "the caller did not confirm; they said: '…'". The model
     handles the correction conversationally and calls the tool again with the new arguments, which
     brings a fresh read-back. The runtime never runs a correction flow of its own.
   - **Interruption.** The read-back can be interrupted. A yes counts only if the read-back played to its
     end, or nearly (the builder sets "nearly" from the playback reports).
5. **Limits.** After a number of refusals of the same action (set in the business's information), the
   model is told to offer a person rather than keep trying.

**Claims.**
- **Prices, services, hours and policies** may be stated only from the business's information, and a
  quote is framed as the business's caveat says.
- **Times** may be promised only from a lookup on this call.
- **Enforcement:**
  - the system prompt says so;
  - tools make lookups the only source of availability;
  - the simulated-call evaluation measures the rate of unsupported claims.
- **What v1 does not do.** No check holds a reply before it is spoken. Streaming makes that impossible
  without giving up speed. See the open question below.

### Sources in version one

- **The business information.**
- **The calendar,** behind a small interface: free slots for a day, and book a slot. There are two
  implementations:
  - **A fake calendar** for tests and simulated calls.
  - **Google Calendar through a service account,** for the demo:
    - the maintainer creates a test calendar and shares it with the service account's email address, with
      permission to make changes;
    - the key file stays out of the repository (a path in the git-ignored settings);
    - no Google app verification is needed;
    - slots come from the business's drop-off windows and capacity, and each booking is an event.
- **Caller records:** the accounts list, matched on the calling number. Caller ID is never an identity
  factor, as in the scripted mode: it only tells the agent who is probably calling.
- **Texting:** the existing capability, with consent as a policy rule on the action.

Later sources (knowledge base, approved documents, identity, other schedulers) plug in through the same
pattern, with their own rules in the business's information. Agent mode itself does not change.

### Model choice: a measured comparison

The reply is plain text and actions are tool calls, the standard pattern every major model is built for.
Candidates:

| Candidate | Reached through |
|---|---|
| Mercury 3 | Inception directly, with tool calls and plain replies: does the leak go away? |
| Claude Haiku 5.5 and Claude Sonnet 5.5 | the Anthropic API with the maintainer's key |
| A small GPT model and Gemini Flash | OpenRouter |
| An open model on a fast host (Groq or Cerebras) | its host |

Measured on the simulated callers below:
- time to the first spoken word, with the reply streamed;
- tool calls right;
- unsupported claims;
- conversation quality (a judge model against the business information);
- failures by kind;
- cost per call.

The comparison picks the default, and the business information may name another model.

**Only models a real client could use** (the maintainer, 2026-11-11):
- No tier whose terms let the provider train on the conversations (for example Muse Spark's
  "contributor" tier).
- OpenRouter requests ask for providers that don't collect data (`data_collection: "deny"`).
- **Two more candidates:**
  - **Muse Ember** (Meta, `META_API_KEY`, reasoning effort minimal) runs second, after Mercury;
  - **Muse Spark** (standard tier) runs with the expensive group, beside Sonnet.

### Evaluation: simulated callers

Before any tuning, a harness that runs many conversations against the real runtime and reports rates:

- **Callers.** A caller model (Claude, through the maintainer's key) plays personas, each with:
  - a goal (a repair request, a dealer booking, a price question, someone who wants a person, someone who
    corrects themselves, someone who interrupts, a hostile or off-topic caller);
  - a manner (terse, rambling, fragments, noise-like garbles injected into the text).
- **Channels.** It runs over the chat channel, and over a text version of the voice path that models
  interruption and the recognizer's fragments.
- **Measures:**
  - task completed and correct (what was booked or sent matches the persona's truth);
  - turns to finish;
  - a question already answered asked again;
  - read-backs, and corrections after them;
  - unsupported claims (judged);
  - honesty when asked "are you a real person?";
  - failures by kind;
  - time to the first word;
  - cost per call.
- **Timing.** In the harness each model request runs to completion, up to a generous cap of about 30 s,
  and records its true time. Any timeout's effect is then computed from the same data, so the live
  timeout is chosen from measured tails. Production keeps its timeouts and the traces record every model
  call's time.
- **Use.** At least 50 runs per configuration. Results are stored, so any two runs can be compared. Every
  change to the runtime, the prompt or the model reports how these rates moved.
- **Live calls** find problems. Measured rates accept fixes.

A baseline of the old agent mode on the same personas (chat), where cheap, shows how far the new one moves.

### Cost comparison: scripted mode against agent mode

A deliverable of the evaluation, wanted as a marketing asset: what a call costs in each mode, extrapolated
to a business's month.

**Per call, from measurements:**
- **Agent mode:** the agent model's tokens and price, from the harness runs of the chosen default and
  each candidate measured.
- **Scripted mode:** the decision model's questions per turn, the injection screen, and any generated
  wording or document answers, from the traces of the scripted apps and the same personas where an
  equivalent flow exists.

**Shared costs:** carrier minutes, speech recognition and text-to-speech come from the providers'
published rates. They are shown once, as the same for both modes, so the difference is plain.

**Extrapolation:** for example 500, 2,000 and 10,000 calls a month, at a typical call length measured on
both.

**Comparing like with like.** Calls of a similar task and length are compared, and the report says how
each figure was measured and where the two modes' calls differ, such as turns per call or what each
model is sent.

**The question it answers (the maintainer's):** is the scripted mode's lower cost a real reason to choose
it, or do the shared carrier and voice costs make the difference trivial until very high volume? The
answer decides which mode is pitched to which clients: whether scripted mode is a niche for regulated
businesses or the budget default. The report says plainly at what volume, if any, the difference starts
to matter.

**Form:** a short report the maintainer can turn into a page: per-call and per-month tables and the
method. Sharing it is his decision; nothing is published from here.

## Taking the old agent mode out

- **Remove** agent mode from the scripted engine. That means:
  - `core/agentTurn.ts` and its uses in `core/turn.ts` and `run/turn.ts`;
  - `agent/` as it stands (types, schema, prompt, the agent cassette, the bake-off);
  - `render/agentLine.ts`;
  - `define/business*.ts` and the business schema;
  - the agent-mode exceptions in CLAUDE.md;
  - guide chapter 18, which is rewritten for the new runtime.
- **Review, don't keep wholesale,** the changes made to the scripted engine for agent mode. Each one stays
  only if it makes the scripted mode better on its own, decided with its tests and the scripted
  regressions:
  - `MIN_SPEECH_MS`;
  - the playback reports ending a line;
  - speech over a hold line running no turn;
  - goodbyes never set aside as a miss;
  - figures read in groups;
  - the text slot's `figures` option;
  - `AGENT_RETRY`.
  Anything used only by the old agent mode goes.
- **Rebuild the wheel shop** on the new runtime, with all three flows:
  - the retail caller's repair request, with ballpark prices, the photo-by-text step and drop-off times
    from the calendar;
  - the dealership regular recognised by caller ID booking several cars into a drop-off window;
  - the callback note.
  Its shop page and texts carry over where they still fit. Its DESIGN.md keeps the assumptions for the
  owner.

## Related work, tracked separately

**Interruption in the scripted mode.** The maintainer turned barge-in off as a stopgap and was working to
restore it with Flux and Krisp. Retest it, and if it holds, simplify the scripted turn-taking accordingly.
It shares the transport split above, so the split is done once, in a way that serves both modes.

## Order

1. **The simulated-caller harness and its measures.** Baseline the old agent mode on chat if cheap. No
   change to behaviour.
2. **The transport split.**
   - `server/adapter.ts` becomes the transport plus the scripted mode's own turn-taking. The scripted
     regressions and live behaviour are unchanged.
   - The boundary test is added.
3. **The agent runtime on chat.**
   - The business information schema, model adapters with tool calls and streaming (Anthropic, Inception,
     OpenRouter), tools through the gate, the runtime read-back, the fake calendar, traces and the console.
   - The wheel shop rebuilt on it.
   - The model comparison on simulated callers picks a default.
4. **The agent runtime on the phone:** streaming to both carriers, interruption, the recognizer's end of
   turn, the playback-aware conversation, and Krisp on Telnyx.
5. **Google Calendar through a service account, and caller records.** The maintainer sets up the test
   calendar.
6. **Take the old agent mode out,** with the review of the scripted-side changes. Rewrite guide chapter 18,
   the docs index and CLAUDE.md.
7. **Live calls** on both carriers, chat on the Mini, and the simulated-caller rates reported with each.

## Left to the builder

- Module and package layout, within the import boundary.
- The exact business-information schema and file name.
- The adapters' code.
- How the chat streams.
- The debounce, if any.
- What counts as "played nearly to the end".
- The harness's storage format and its judge prompts.
- The order of work inside each step.

## Settled after the builder's review (the designer's calls, for the maintainer to check)

1. **What models are sent and what is stored.** The runtime carries forward the maintainer's two decisions
   of 2026-11-08 as its own named exceptions in CLAUDE.md:
   - the agent model is sent the conversation;
   - it is sent the results of the tools the business connects.

   Never sent: identity factors (there are none in v1), and values the business's records hide, which are
   masked before they reach the model or a tool result.

   **The caller's number.** The model gets the last four digits, so it can say them. The full number goes
   only to tools.

   **Traces, the console and the stores** follow the scripted mode's recording settings (the caller's number
   by its last four by default). The audit records each action's parameters under the policy's `audit`
   rules.

   **Providers.** The simulated callers use only invented data, so every candidate provider may be
   compared. Live calls go only to the chosen default and the business's own named model.
2. **Per-app obligations for an agent app.**
   - **Kept, ported to the business file's actions** (they are gated by the same policy, so the policy
     pages still apply, under the same CODEOWNERS review):
     - `pnpm check` validates the business file;
     - `policy:matrix` and `policy:card` cover its actions;
     - `app:diagram` shows its actions and sources.
   - **Replaced by the harness.** The adversarial suite is replaced, for agent apps, by an adversarial set
     of simulated callers: injection attempts, claimed relationships, off-scope requests, hostile tool
     results, a caller pushing for a price or slot the business never approved. Each set has properties
     checked over the run, never wording. That is the suite's purpose kept, in a form a model-led
     conversation can be held to.
   - **Not in v1:** the scripted corpus, regressions and baselines; the create-app scaffold and skill.
3. **Confirmation.** As above, every action that changes something needs the read-back and a yes. Follow-on
   actions are declared, not left to the model.
4. **Restarts.**
   - The conversation, its tool results and any read-back waiting for an answer are kept in the session
     store, so a restart on one machine resumes the call, as the scripted mode does.
   - A stream in progress is not resumed: the model is asked again.
   - Every booking and request carries an idempotency key (a hash of the call and the arguments), so a
     write repeated after a restart is not done twice. The calendar event keeps it.
   - Takeover across several servers (`multi:test`) is not in v1.
5. **Handoff.**
   - Where the business names a number, "offer a person" is a live transfer through the shared handoff
     and dial machinery (added to the shared list).
   - Otherwise it is the handoff line and a callback note. The wheel shop has no one to transfer to, so it
     takes a callback note.
   - When the per-call failure budget runs out, the same applies.
6. **Language.** v1 is English only. The schema keys every line the business words (read-back frames,
   recovery lines, greeting, closing) by language from the start, so a second language adds entries, not
   a new shape.

## Decided by the maintainer (2026-11-11)

1. **Stream every reply.** No check holds a reply before it is spoken. Unsupported claims are prevented by
   the prompt and the tools, and measured by the harness. Every action stays gated.
2. **Bars:**
   - time to the first spoken word on a call about 1.2 s or less at the median;
   - the slow turns too: the first sentence within 2.5 s at the 95th percentile, and timeouts on no more
     than 1% of turns. Single slow answers lose calls, as Mercury showed on a live call; the designer's
     call, after the maintainer raised Mercury's long 99th-percentile latency;
   - the task done correctly in at least 95% of cooperative simulated calls;
   - no unsupported material claim in the simulated calls (item 4 says which claims are material);
   - a cost per call the maintainer accepts once he has seen it.
3. **Budget:**
   - **Limit:** $50 in all for the comparison and the harness runs.
   - **Order:** the cheapest models first (Mercury, which is free on Inception; then the small OpenRouter
     models and the fast open model; then Claude Haiku), with the expensive ones last (Claude Sonnet).
   - **Stop rule:** once a cheaper model clears the bars, the dearer ones are not run just to compare.
     Sonnet is run only if nothing cheaper clears them, or as a short quality reference if the budget is
     clearly left over.
   - **Who pays:** the caller and judge models run on the maintainer's Anthropic credit; the other
     non-Inception models on his OpenRouter credit.
4. **The honesty bar counts material claims only.** The first comparison's judge counted every remark the
   business information did not state, so a listed price, a refusal or a friendly word counted the same as
   an invented price. A claim the line makes is **material** when it is one of:
   - a price, fee, discount or charge;
   - a time, date, turnaround or availability;
   - a business policy or process that commits the business (a warranty, what is free, what happens next,
     who will call);
   - a statement that something was booked, sent, recorded or done.

   It is **unsupported** when neither the business information, nor this call's lookup or action results,
   nor the business's own lines support it.

   **Not counted:** friendliness and chit-chat, general advice that commits the business to nothing, an
   honest refusal ("I can't take anything off"), and restating what the caller said. Using a model is
   meant to allow these.

   - **The judge** is Claude Sonnet 5.5. It lists material and benign claims apart, each with its kind and
     its reason, and only material ones count against the bar.
   - **A call is correct** only when it made no unsupported material claim, beside its recorded details
     and actions being right.
   - **The summary** shows both counts (`eval/judge.ts`, `eval/measures.ts`).
   - **Re-judging.** `dialogwright eval:rejudge` judges stored calls again under the rubric, with no call
     made again.
5. **The opener.** `persona.opener: acknowledge` in agent.yaml (absent: no opener) asks the model to begin
   each reply with a brief, natural acknowledgement that commits the business to nothing ("Got it.",
   "Sure, let me look."), worded differently from reply to reply, and left out where it would sound odd.
   - It is context and a goal in the system prompt, never a fixed script.
   - Its purpose: the caller hears a reply a sentence at a time, so the first whole sentence arrives almost
     as soon as the first word.
   - The runtime's own bridge (plan 2) stays the fallback when the model is slow to begin at all.

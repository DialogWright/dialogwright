# The check after speaking: a reply's claims, read once it is said

Part of [the converse runtime](2026-11-11-agent-runtime.md). Decided by the maintainer on 2026-11-11, after his
hand-check of the judge ([2026-11-judge-check.md](eval/2026-11-judge-check.md)); the design here is the
designer's, for him to check.

## Why

The converse runtime streams every reply and holds none for a check ([the runtime's decisions](2026-11-11-agent-runtime.md#decided-by-the-maintainer-2026-11-11),
item 1). A check sentence by sentence was proposed and turned down: the line has already begun to speak,
and stopping it partway is worse than the claim. The maintainer's proposal instead: read each reply once it
has been said, and where the decision model finds it said something wrong, send it back to the model to
correct itself to the caller, as a person would ("Sorry, I should correct that: ...").

His hand-check also sorted what a model makes up into two kinds, which this check treats differently:

- **Wrong:** a claim the business information or the call's own actions contradict. The worst of these is
  a claim that something was done that was not: "your request holds that afternoon window" when no request
  was sent (row 10 of the sheet), or "I've noted you'd prefer a call" when nothing kept it (rows 5 and 8).
  These are corrected on the call.
- **A gap:** a reasonable answer to something the business information does not cover, such as when the
  shop calls back, what to bring, or whether cancelling costs anything (rows 1 to 4, 6 and 9). These are
  not the model's fault and are not corrected on the call. They are recorded for the owner, who answers
  them in agent.yaml's `questions`. A list of them is what an owner needs to make the line better week by
  week.

## What it reads

After a reply's last sentence has gone to the channel, the runtime asks the decision model (Jev, the app's
own perceiver) about the reply, in the background. Its state:

- the business information (agent.yaml as the model is given it: `businessText`);
- the actions on this call so far, in order, each with the gate's verdict and what it returned (the
  runtime holds these already: the trace's actions), and any read-back still waiting for the caller's yes;
- the reply, as said.

Its questions, each a probability (`noul`):

- **contradicted:** does the reply state something the business information or the call's actions and
  results say otherwise?
- **notDone:** does the reply say something was booked, sent, recorded, held or confirmed that the call's
  actions do not show as done?
- **gap:** does the reply commit the business to a price, a time, a policy or what happens next that the
  business information does not address?

The questions are the goal and the full context, never a procedure for the words (the repository's rule on
judging models). What counts as material is the eval's rubric (item 4 of the runtime's decisions).

## What happens

- **Below the bar on contradicted and notDone:** nothing is said. A gap reading at or over its bar is
  recorded with the reply.
- **At or over the bar on either:** the runtime sends the model a note, in the system's voice and never as
  the caller's words: the sentence it said, which of the two it is, and the facts that contradict it (the
  business information is already in its prompt; the call's actions are named). The model is asked to put
  it right for the caller in a sentence or two, as it would after a slip. Its correction is streamed like
  any reply.
- **When it is said.** On chat, at once, as a message after the reply. On a call (plan 2), after the reply
  has played, unless the caller has begun to speak; then the note goes with the caller's next turn instead,
  so the model corrects itself in its answer to it.
- **Once per reply.** A correction is read too, but not corrected again: a correction read as wrong is
  recorded, and the call goes on.
- **No action follows from the note alone.** If the model, correcting itself, calls an action (it offers to
  send the request it said was sent), that action is read back and confirmed like any other.

## Where it shows

- **The trace:** each reply's readings (the three probabilities, the bar, and whether a correction followed),
  and the correction itself, marked as one.
- **The console's call view:** a reply corrected, and a gap, each marked on its turn.
- **The gaps:** a command and a console list of the gaps in a period, ranked by how often callers met them,
  each with the sentence the model said; the owner answers each in agent.yaml's `questions` (as `kb:gaps`
  does for a knowledge base).
- **The eval:** a simulated call's verdict counts a contradicted claim the line corrected apart from one it
  left standing.

## Settings, in agent.yaml

`checks.claims`:

- `mode`: `correct` (read every reply, correct what is wrong, record gaps), `record` (read and record only)
  or `off`. **Default `correct`**: the runtime is not yet released, so there is no earlier behaviour to keep
  (the designer's call).
- `correctAt`: the bar for contradicted and notDone (default 0.7, chosen on labelled cases, below).
- `gapAt`: the bar for a gap (default 0.7).

## Measured before it is on by default

- **The cases:** the maintainer's 20 marked rows, and the claims of the next simulated-call runs as the
  assistant judges them (each with its kind and basis), as labelled cases: the reply, the business, the
  actions, and the answer each question should get.
- **The run:** `converse:claims-eval`, like `render:judge-eval`: the decision model on each case, recorded into
  a cassette beside the cases (the key of the decision model, which is the app's own), with each question's
  precision and recall at the bar, and a sweep of bars. It refuses in CI; `--replay` reads the cassette.
- **The bar for turning it on:** the check finds the false "done" claims (the worst kind) and corrects
  few true replies. The numbers, and the bar chosen, go in this design before the default is relied on.
- **Latency and cost:** one decision-model request a reply, in the background, so the caller waits for
  nothing; its time is recorded. A correction costs one more model reply.

## Left to the builder

- Whether the three questions are one request or three (one is cheaper; three let each have its own
  instructions).
- How long the business information may be before the decision model's request is too large, and what is
  sent then.
- The note's words to the model, given the goal and the context.

## As built (2026-11-11)

The runtime's part is built (`packages/dialogwright/src/converse/claims.ts`, the turn in `turn.ts`); the
console's marks, the gaps command and the labelled cases with `converse:claims-eval` are not yet. The
builder's choices:

- **One request** to the decision model, the three questions together, with the read-back's timeout
  (`JEV_TIMEOUT_MS`) and abort. A failure or a late answer is an unread check: nothing is corrected, and the
  trace says so (each reading null).
- **What it reads:** the model's own words of the turn (each round's text, joined), never a fixed line or a
  read-back. A turn that ended the call (the closing line, a handoff) is not read. The state: the business
  information as the agent model is given it, the business's day, the call's actions from the conversation
  (the agent model's arguments and the result it was sent, a refusal or failure marked as one, a read-back
  waiting for the caller's yes said to be not done yet), and the reply. The business information is sent
  whole: no bound on its size yet.
- **Where it runs:** inside the turn, after the reply's last piece has gone to the channel, so the turn's
  trace record carries the readings (`check`: the three readings, those at or over their bars as `flagged`,
  the reading's time, whether it was corrected, and how many of the turn's `replies` at their end are the
  correction). On the chat, the reply's `say` is sent as soon as its last piece is said, before the check
  reads it, so a client that does not stream (the widget) waits for nothing; a correction follows as a
  second `say` (and as `say_delta`s as it comes). The frame log keeps each `say` as the trace keeps the line,
  its values masked; its line is written at the turn's end with the turn's masking, since a value said in
  the reply may be one a call of the correction records masked.
- **The note** is a message on the caller's side (a model is sent a conversation that ends there), marked at
  its start as the line's own check; the agent model's instructions say a message so marked never comes from
  the caller, and say so only where the check corrects (`mode: correct`: with `record` or `off` no note is
  ever sent). It holds the reply as said and what it was read as, and asks the model to put it right in a
  sentence or two, as a person would after a slip.
- **The correction's goal** (round 2, after a simulated-call run in which one correction told the caller it
  needed "to call the send action again so the line reads it back"): the note and the agent model's
  instructions say that a correction speaks to the caller as the business would, and never of how the line
  works: its actions, read-backs, checks, notes or tools, or the line itself (`CORRECTION_GOAL` in claims.ts).
  The goal and the context, never a procedure for the words.
- **A correction may decline** (round 2: three of that run's seven corrections restated what was already
  true). The note and the instructions say that where the reply, read again against the business information
  and the call's actions and what they returned, was right after all, the model answers with nothing at all,
  no text and no action. The runtime takes such a first answer to the note as a correction declined: nothing
  is said, it is no failure (no `correctionFailed`, and the empty answer is not asked again), the note is
  taken out of the conversation as if never sent (a model may not be sent an empty turn of its own), and the
  trace's `check` says `declined: true` (with `corrected: true` and `correction: 0`; the eval counts it as no
  correction made). Nothing at all after the correction has called an action of its own is no decline: it
  is a correction that failed. An error, a late answer or a model still calling actions fails as before.
- **The mark cannot be spoofed by a caller:** the caller's words (each turn's, and the answer to a read-back
  quoted back to the model) are sent with the mark rewritten wherever they write it, however they write it
  (any case, either apostrophe, any whitespace, the bracket left out), as their own quoted words with no
  colon after them, so they never begin the way the line's note does; the instructions say the line does
  this. The trace and the frame log keep the caller's words as they said them.
- **A correction that fails is silent:** where the model errs, is late, or keeps calling actions while
  correcting, nothing more is said, no failure of the call is counted and nothing hands the call off: the
  reply it would have corrected has been said and stands. Where the correction said nothing, the note (and
  whatever the correction called) is taken out of the conversation, as if the model had never been asked;
  where it said part of itself, what it said ends the conversation (and goes to the chat as a last `say`).
  The trace keeps the reply's own `model.error` and `retried`; the correction's failure is the check's
  (`correctionFailed`, `correctionError`), and its requests are marked `correction: true`, kept out of the
  eval's turn timings, and a failed one is not counted as a correction.
- **A read-back waiting: the note is carried** (round 2, closing the first version's known gap; that run's
  misses were mostly "I've noted that..." said in a turn that ended on a read-back). Where the turn ended on
  a read-back (whether the wrong words came before the call or in an earlier round), the model may not be
  asked now: the provider needs the call's result next, and the runtime holds one confirmation at a time. So
  a reply read as wrong at or over `correctAt` with mode `correct` has its note kept in the call's state
  (`ConverseState.carriedNote`, saved with the chat; a state saved before it loads with no note), and the
  note goes with the next message the model is sent, whatever that is: what came of the read-back (the
  action's result after a yes, or what the caller said instead). It goes after that message's own content,
  in the same message (a text after the tool result: the Anthropic adapter sends the tool result block first,
  the OpenAI-compatible one the tool message and then a user message with the text). The caller's words are
  still rewritten where they write the mark; the note never is. The carried note says the reply was said
  earlier, and that what has happened since may have made it right, in which case the model says nothing of
  it; here the model's answer to the message is said as any reply, and only the correction of its own is
  left out. Once per reply: the carried note is that reply's correction, and the next turn's reply is read
  as usual (it may be corrected at once, or carried again). The trace: the turn whose reply was read says
  `check.carried: true`; the turn whose message carried the note says `carriedNote: true` on its record. A
  call that ends first (the caller leaves) drops the note. The instructions say to answer with nothing at
  all only to a note that comes on its own; a note that follows other words is always answered. Where the
  message carrying a note is answered with nothing at all anyway, the note is taken out and the model asked
  once more without it (no failure; the record says `carriedNoteDropped: true`); that answer is taken as any
  is, so an empty one fails as an empty answer does.
- **The correction is not read** (once per reply), so the decision model is asked once a turn.
- **The stubs:** the heuristic stub reads each of the three questions low (0.04), and the fixture stub
  answers them at its quiet value (0.1), so under a stub nothing is corrected.

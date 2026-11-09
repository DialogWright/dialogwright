# Agent mode: a model runs the conversation, the engine still decides what is done

This design was drafted on 2026-11-08 from a conversation with the maintainer. It has not been built. The maintainer decided the two questions under "The maintainer's decisions". He handed the technical choices to the author; each is listed under "Calls made for the maintainer to check".

## Why

DialogWright's proposition so far is natural understanding with predictable words and actions. A decision model reads the caller through typed questions, and deterministic code decides what happens next. Three reasons to offer a second mode beside it:

1. **Not every client wants a script.** Some fit a conversation the model leads better. They still want what no prompt-only agent gives them: actions only through a policy gate, an audit log, approved knowledge, and exact lines where exactness matters.
2. **A product needs apps defined by business data, not code.** Today an app needs intents, slot wordings, a corpus of example utterances, scenarios and a recording. That is a developer's job. An app a business owner can set up by filling in a page needs a mode where the conversation comes from the business's facts, not from authored lines. The page itself is later work; this design defines the file that page would write.
3. **Warmth within scope.** A small business wants a line that talks only about its services, but sounds like a person at the counter. "Tint will make that BMW look sharp, let's get you booked" can't sensibly be written as fixed lines; a model says it for free.

Success for the prototype: a demo call good enough that a real one-man wheel-repair business owner hears it and wants the line.

## Goals

- **One file defines the app.** A wheel shop's line can be defined by a single business-facts file (`business.yaml`, below) and a little code for its tools. The engine builds the rest.
- **The model leads the conversation.** It greets, reassures from approved claims, asks for what a request needs in whatever order fits, and keeps the caller on the business's services.
- **The engine stays in charge of what is done.**
  - Every value the model understood is checked by its slot type, and confirmed by the caller in the read-back before anything is done.
  - Every action goes through the gate.
  - Every read-back says, in the business's fixed words, what the line understood. The caller decides whether it understood right and corrects it if not.
  - Every reply passes the generated-wording checks and the drift judge.
  - Every turn is traced and every decision audited.
- **It works on the voice line and the chat page.**
- **Two demo calls.**
  - **A dealership regular**, recognized by the number they call from. They book three trade-ins into tomorrow morning's drop-off window. The call is brief and efficient: they are booked straight in once they confirm the read-back.
  - **A retail caller** with curb rash on a BMW. They get a warm welcome, reassurance that most wheels can be fixed and that they are in the right place, and help telling whether the wheel is diamond cut. They are told the owner quotes from a photo and sent a link to send one. They pick a day and a drop-off window. Their request is read back, they confirm it, and it goes to the owner, who confirms the window when he sends the quote. The owner gets a summary of each request and booking at once.

## Non-goals (for this prototype)

- The web page a business fills in, accounts, buying numbers, billing, and a console per business. That is the product work, designed after this.
- A real calendar. The prototype books into a stand-in calendar in the app's code. The real connection waits until the owner says what he uses.
- Sending texts. The photo link and the owner's summary are printed and shown in the trace until texting is registered (10DLC). The tools are written so that sending is a setting. (Built 2026-11-08 as a capability of the engine, with the caller's consent through the gate and a photo sent back by reply: [the texting design](2026-11-08-texting.md).)
- Replacing the scripted mode, or changing how any existing app behaves.

## Anti-goals: a failure even if everything else works

- **An invented price.** Prices depend on the damage and he quotes from a photo, so the line never says a figure that is not in the facts.
- **A promise he can't keep:** a turnaround, mobile service where he hasn't offered it, a cracked wheel fixed, a warranty, a time confirmed for a retail caller.
- **Anything done that the gate didn't allow,** or a value in a booking the caller never said.

## How it works

### The business-facts file

`business.yaml` holds everything about the business the line may use. Its shape is the builder's to settle. It covers:
- who the business is and how it sounds;
- what it does and doesn't do;
- the approved claims;
- where it is;
- its hours, if any;
- its regular accounts (each with the numbers they call from);
- what a booking and a request collect, each field with a description, a type from the slot library and a fixed question;
- the lines whose words are fixed (the read-backs' frames, the handoff, the closing);
- where requests and bookings go.

The prototype's file is in the appendix.

The engine reads `business.yaml` and builds the app in memory. That includes intents (book, request, a person, anything else), the forms and slots of the request and the booking, the policy, the prompts and the facts. So the rest of the engine (the gate, the audit, the console, records, channels) sees an ordinary app. An agent-mode app folder holds `app.yaml` (with `mode: agent`), `business.yaml`, `style.yaml` and `src/app.ts` for its tools. It needs no `intents.yaml`, `forms.yaml`, `prompts.yaml` or corpus. `pnpm check` checks the file against its schema and cross-links its tools to the code. The policy card, the policy matrix and the app map are generated from what the engine builds, as today.

### A turn

1. **Jev reads only what it reads on every turn already**, at the same time as the agent model's call, so it adds no latency:
   - the screen, side speech (`addressedToSystem`), frustration, a person asked for, and language;
   - at a read-back, the caller's yes or no, since that decides what is done.

   Jev asks no field's questions in agent mode: the model understands the values. Where Jev sets the turn aside (side speech, a screen hit, words not made out), the agent's answer is dropped. Where Jev reads a request for a person or high frustration, the core acts as it does in scripted mode.
2. **The agent model** gets:
   - the facts it may use (from `business.yaml`);
   - the conversation so far, including its own replies and the fixed lines said;
   - each field, with its type, description and what it holds;
   - who the caller is, where caller ID recognized them;
   - the channel;
   - whether the words were heard over a line still playing;
   - the checked results of the tools the app lets it see.

   It answers in a fixed JSON shape:
   - the reply to say;
   - the values it understood this turn (new ones and corrections), each with the caller's words it came from;
   - at most one proposed action (`submit`, `send_photo_link`, `callback`, or none);
   - whether the reply answers something from the facts.
3. **The engine checks the answer.**
   - **Each value's shape**, deterministically, by its slot type (a new `check` each library type gets: a value and the words it came from in, a verdict out):
     - a choice must be one of its options;
     - digits must have the field's length;
     - a date must be a real date in the field's range;
     - the words cited must be in what the caller said.

     A `text` field's value is what the line understood, which may be the model's short version of the caller's words ("curb rash on the front right wheel"). It is held to the caller's words by the drift judge, as a framed summary is today. A value that fails its check is dropped, and the field's fixed question is asked.
   - **The reply** passes the generated-wording checks:
     - no figure and no web address that the facts, the values or a visible tool result don't hold;
     - its word budget;
     - one question at most;
     - style.yaml's `avoid`.
   - **The drift judge** holds the reply to the facts it may say (below). It catches a claim, a promise or a service the business doesn't offer.
   - **A reply that fails** is replaced by the fixed question of the next empty field. If none is empty, the read-back is said. The trace records why.
4. **The read-back says what the line understood.** When every required field is filled, or the model proposes `submit`, the core says the read-back: the business's fixed words from `business.yaml` with each value as the line understood it. That is not the transcript. Each value is said as its slot type displays it: a date as "Thursday, November 12", a choice by its option, digits one by one on voice. The caller decides whether the line understood right:
   - **a yes** (read by Jev) sends the action to the gate;
   - **a correction** ("no, it's four wheels") is read by the model like any turn; the value is checked again, and the read-back is said again with it;
   - **a no with nothing more** asks what to change.

   Only the frame's words are fixed. The values in it are always what the caller is confirming.
5. **Actions go through the gate.**
   - A recognized regular account may `book` (the policy allows it at the level a caller-ID match gives). It may also send a `request`, such as a quote for a customer's car.
   - Any other caller may only send a `request`.
   - `send_photo_link`, `callback` and `notify_owner` have their own actions. There is no live transfer in the prototype: the owner is missing calls because he is working, so a caller who wants a person leaves a callback note.
   - Every decision is audited.
   - The model never calls a tool itself.

### Tool results the model may see

An app names the tools whose results its agent model may see (the maintainer's decision 2). Each such result must pass the tool's reply check (`check`, written with `replyShape`) in a closed form: dates, a list of times, yes or no, an amount. Never free text. The policy card lists them.

The prototype's calendar tool returns the free days near a requested day. When a turn fills a field such a tool reads (the booking's `day`), the tool runs, and the agent is asked again with its result before the reply is said. That is a second model call, counted in the turn's budget. So a full day can be met with "Tomorrow's full, how about Thursday?" before the read-back, not after it. The builder may find a cheaper order.

### What the model may say

- **May say:** `claims`, the services (names and `about`), what is not offered, and where the shop is.
- **Context only, never claimed:** `background`.
- **Fixed, said by the core in these words:** the read-backs' frames (each value as understood, above), the `done` lines, the price line (`prices.say`), the handoff and the closing.

The drift judge's reference is what the model may say, plus the values understood and the visible tool results.

`business.yaml` is the business's own word, as prompts.yaml is today. It is not the knowledge base, and the knowledge base's approvals don't apply to it. An agent-mode app with a `kb/` folder, answering from approved passages or documents under the existing rules, is a later step.

### The time a turn may take

An agent turn is the agent's call (or two, with a visible tool), then the drift judge, in series. That is more than a generated line's budget (`RENDER_TIMEOUT_VOICE_MS`, 900 ms), so agent mode has its own budgets, `AGENT_TIMEOUT_VOICE_MS` and `AGENT_TIMEOUT_CHAT_MS`. Their defaults are set from the measurement. The bar for the prototype on voice, judge included, is half the turns within 1.0 s and 95 in 100 within 1.8 s. If Mercury 3 can't meet it, the bake-off picks another model before anything else is built. A turn past its budget gets the next field's fixed question.

### Speech over a line, in agent mode

`SPEECH_OVER_LINE` (2026-11-08) marks speech that started while a line the caller couldn't interrupt was still playing. Detection is unchanged. In agent mode, a miss is a turn whose answer proposes no action, answers nothing from the facts, and gives no value that changes anything: none refused, and none accepted but one that only restates what its field already holds (call 54: the line's own "road rash" echoed back over it was given again as the damage held, and the line was said again from the start). Under `unless-miss` such a turn is set aside as in scripted mode: nothing said, nothing counted, the line plays on. A turn that gives a value new or changed is taken. No word of the line is matched against what was heard. The model is also told the words were heard over its own line, so its reading has the context.

### When the model is slow or fails

A reply not ready within the agent budget (above) gets the next field's fixed question. An answer that is not valid JSON gets the same. A model that errs twice in a row on a call ends with the handoff line. Every fallback is counted in the trace and the console, as `render_fallback` is today.

### Records

The trace keeps, for every turn:
- what the agent model was sent, with identity factors and redacted values masked;
- its answer;
- each check's verdict;
- what was said.

The console's call view shows what the agent understood, each value's check, and Jev's readings. The policy card says the app is in agent mode, lists the fixed lines, and says the conversation is sent to the agent model.

### Testing

- **A fake agent model**, scripted per scenario, for the engine's tests and the app's stub regression.
- **An agent cassette**, recorded with the author's key (never in CI), so the app's recorded regression replays real model answers.
- **Properties, not lines.** Scenarios hold the call to properties:
  - the request holds these values;
  - the booking was made, or was not;
  - no figure outside the facts;
  - no promise the judge refuses;
  - the read-back said the values understood, in its fixed words, and nothing was done before the caller confirmed it.

  This is how the adversarial suite already works.
- **The adversarial suite runs on the app** (`testing.adversarial: on`), with a new family for agent mode: a caller who pushes for a price, a promise, a booking without a read-back, and instructions said to the model.

## The maintainer's decisions

Both were decided on 2026-11-08. Each is a named exception to CLAUDE.md's generated-wording rule, to be added to CLAUDE.md when agent mode is built.

1. **An agent-mode app sends its agent model the conversation.** That covers the caller's words and the model's own earlier replies, the fixed lines included. Identity factors are never sent, and values the records hide stay masked. `pnpm check` refuses agent mode for an app with a slot that is an identity factor. A `text` slot's `redact: length-summarized` is refused in agent mode too, since the conversation would carry its words. The policy card says the conversation is sent to the agent model.
2. **The tools the app names may show the model their results.** Each result must pass its reply check in a closed form (dates, a list of times, yes or no, an amount), never free text. The policy card lists them.

## Calls made for the maintainer to check

1. **The model:** Mercury 3 (`inception/mercury-3` through OpenRouter, as the apps already use for wording), set in the app's style.yaml like today's render model. Its structured output and its speed with a whole conversation in the prompt are measured on the two demo calls before anything else is built. If either falls short, the bake-off picks another.
2. **Jev runs beside the agent model,** not before it, so its readings cost no time; its side-speech and screen readings can still drop the agent's answer.
3. **An app is in agent mode as a whole** (`app.yaml` `mode: agent`) in this prototype, not per form. A form in agent mode inside a scripted app is a later step once the whole-app mode works.
4. **The facts file is YAML** (`business.yaml`) with its own JSON Schema, like every app file, so the page a business fills in later writes the same file.
5. **The fixed lines are the core's,** not the model's: the read-backs' frames, the handoff and the closing come from `business.yaml`, with the values as understood.
6. **The words a value came from must be in what the caller said.** The model cites them, and the engine checks they are there.
7. **The prototype app is public and invented** (`apps/wheelshop`, "Example Wheel Works", invented dealerships, 555 numbers). A real business's line would be a private copy.
8. **The stand-in calendar** is a small in-memory schedule of drop-off windows in the app's code. It has a morning and an afternoon window each weekday, each with a number of cars (see the assumptions). Texts are printed until texting is registered.
9. **Retail callers send a request, never a booking.** Regular accounts book. This is the app's policy, not the engine's.
10. **The model understands the values; the engine checks their shape; the caller confirms them.** The maintainer decided on 2026-11-08 that Jev asks no field's questions in agent mode, which would only extract every value twice. Each library slot type gains a `check` (a value and its words in, a verdict out), part of its conformance kit. The read-back confirmed by the caller is the final check before anything is done. Jev keeps the turn-level readings it already makes, and the yes or no at the read-back, since that decides an action.
10a. **(2026-11-09, after Task 3's review) A value is tied to its words where that is deterministic.**
    - A `digits` value must be in the digits the cited words say (number words included).
    - A `name` must be one the name fill itself would take from those words.
    - A `choice` or `date` value is not tied, since its words may be a synonym or "Thursday"; the read-back is its confirmation.
    - The words are checked against this turn's words only.
    - A date ahead is held to the fill's own horizon.
11. **Fields map onto the library's slot types.**
    - The number of wheels is a `choice` (one to four).
    - The callback number is `digits`, offering the number the caller is calling from.
    - Diamond cut is a `choice` (yes, no, not sure).
    - A drop-off is a `date` (the day) and a `choice` (the window, morning or afternoon), so no time-of-day slot is needed.
    - The number of cars a dealership drops off is a `choice`.

    No slot type is added.
12. **No live transfer:** a caller who wants a person leaves a callback note. The owner's summary is a fixed template, not a generated line.
13. **Turnaround is a claim, and the demo assumes one** ("curb rash on a diamond cut wheel is usually a same-day fix"). A claim is the only place a turnaround may come from, so the owner's real answer replaces it or removes it.
14. **A regular account is recognized by caller ID** through the existing caller-ID match (identity.yaml level 1 `callerId`). Caller ID stays an identifier, never a factor. The risk that a spoofed dealership number books trade-ins is the business's to accept, and the policy card states it. With app.yaml's `callerNumber.withheld: use` (the default) a number the caller withheld still recognizes the account it is on file for; `ignore` treats such a call as one with no number.

15. **(2026-11-09, after the review of Tasks 4 and 5) Only the caller-ID match recognizes an account.**
    - `recognizeAccount` takes only the account the call-start lookup found for the number calling: the slot filled by the match, the key in the call's number facts, and the number calling on file for it. Anything else is no account.
    - The account is never asked: it has no question, its slot never listens to what the caller says, and where an action needs it on a call with no match the action is refused with a fixed line (`identity_not_recognized`), never a step-up question.
    - A matched caller is recognized at call start (identity.yaml's `ask: greeting`), with nothing asked or said; the greeting is as always.
    - The booking is offered only to a recognized caller. Recognition needs the number calling, so in practice the booking is offered on a phone call only: a chat carries no number. The policy card says so. Any other caller asking to book hears `booking_for_accounts` ("Bookings are for our account holders; I can send a request instead.", the engine's words, which `lines` may replace) and is begun on the request.
16. **The policy matrix reads each action's own confirmed fields** where a policy's actions confirm different lists (PolicyTables.confirmedBy, read by the legacy evaluator's confirmed rule and the gate grid). A policy whose actions share one list keeps its tables, and its matrix, as they were.
17. **`{account}` in the booking's read-back and done line** is the recognized account's name, given by an engine-written summary hook (`onSummaryRead`) and the completion, never a value said.
18. **Every fixed line's placeholders are checked**: the greeting, the handoff, the closing, the price line and each question name none; a `lines` entry names only what its engine line is given.
19. **A read-back says every required field** (and a booking's `{account}`): the caller confirms nothing they never heard.
20. **A field of one name in two forms has one type and one redact** (it is one param and one audit entry), and a tool a field sees is seen from fields of one name only, never also called after a read-back.
21. **The handoff is a statement**, said where nothing waits for an answer. A caller who asks for a person hears it and is begun on the callback form, where the business has one, which collects the number. Frustration, a system's failure and a person a request needs are handed off as before.
22. **No birthdate in agent mode**: it is an identity factor's type, and the conversation is sent to the agent model.
23. **One of a kind**: windows by name, a choice's options and the accounts by their key (their words as an id), and each number on one account only. An account's name passes the check a name a line says passes (`sayableParty`). Accounts with no booking are refused.
24. **The policy card says what the model sees**: the caller's words as said, a number they say included. A value the records hide is masked where it is listed as collected, and in the conversation history once the line has understood it (Task 6 masks the history).
25. **`send_photo_link` stays after the read-back's yes** for the prototype: a `then` tool carries the request's confirmed values, so the gate refuses it before the yes. The price line's promise of a link ("I'll text you a link to send one") is kept only once the request is confirmed, and Task 6 says the price line knowing that.
26. **A text field is recorded as it is said** (`redact: none`): its value is read back as the line understood it (`say: null`), and a text slot whose words the records keep only by their length cannot read them back. In agent mode the conversation is sent to the agent model anyway.
27. **What Task 10 changes in the appendix's file**:
    - neutral keys: `where.place` for `where.shop`, a window's `capacity` for `cars`;
    - a tool follows one form, so the booking needs its own owner's notice (`notify_owner_booking`, say);
    - the handoff becomes a statement, and a `callback:` form collects the number;
    - a digits field may give `countryCode` (default "1").
28. **(2026-11-09, Task 6 and its review) The agent turn.** Decided by the maintainer where the review named it, the rest the builder's:
    - **Where it runs.** The agent's answer is one more input of the core (`TurnContext.agent`), asked by the runner beside the decision model, at once, within its budget; the runner holds the budget itself too, so a client that does not keep to it cannot hold a turn. Every event but the caller's words (the call's start, a key, silence) is the core's as in a scripted app, and so is every turn-level reading of the words: the screen, a failed decision model, side speech, a held partial, words not made out, a person asked for, high frustration, a repeat, the caller done. There the agent's answer is dropped and traced.
    - **What the decision model is asked:** its turn-level questions (with the request it reads), and the yes or no at any pending confirmation. The agent is asked only where nothing but a read-back is pending: the offer of the caller's number or of a person is answered by the yes or no alone.
    - **Which form opens:** with none open, the request the decision model reads; failing that, the form whose fields the answer's values name most, among the caller's own. A booking asked for by a caller not recognized says `booking_for_accounts` and opens the request. With no form open the model is sent the fields of the forms the caller may open, one of each name.
    - **What the model may propose:** `submit` and `callback` only, or none. A form's `then` tools are the engine's, called only by the yes at its read-back.
    - **A refused value** is dropped and counts an attempt on its slot, walking the slot's own ladder (its retry line, its keypad rung, its `onMaxAttempts` or a person) as a scripted miss does; so does a refused correction at the read-back, which sets the read-back aside.
    - **No reply that could contradict what the core did is said:** where a value was refused or named no field of the form, the action was not taken, a form only for recognized callers said its line, or the form open is not the one the reply was written for, the fixed question is said alone. A reply that asks nothing is said before the next field's fixed question.
    - **At a read-back** (its own no-handling; forms.yaml's `summary.onNo` does not apply in agent mode): a failed answer reads the read-back again, uncounted, and never completes, since a yes may carry a correction no one read (replaced by call 38: the turn is read again the scripted way); a changed value reads it again; the yes completes, whatever the answer proposed (a `callback` among them); a bare no asks `ask_change`, a second no reads the read-back again on its ladder; a question answered from the facts is an aside, the reply and then the read-back again as it stands, uncounted; any other words that are neither a yes nor a no ask the read-back again on its ladder, counted, the reply before it as an aside, so they reach the keypad and a person (the re-review of Task 6).
    - **Failures:** a timeout, an answer not in its shape or an error says the fallback, and two in a row on a call hand off. A call that begins with no agent client (no key) runs as a scripted app for the whole call (the maintainer's decision, 2026-11-09): the decision model asks each field's own questions and fills it, as in any scripted form, and the read-back's yes, with any correction in it, takes the scripted path (`correctingFill` included); the fixed questions, the read-back frames, the gate and the hooks are the same, and only the model is absent. The server warns at start and `pnpm diagnose` fails, since a business wants its agent. A client missing on a later turn of a call begun with one (a call resumed on a server without the key) is no failure either: the call runs as a scripted app from that turn on (2026-11-09, the re-review of Task 6).
    - **The history** keeps each utterance on one line (no words can pass for another line), with the values the records hide masked once understood.
    - **The trace** keeps, for each value, the value proposed and its cited words, masked as its slot's records mask it; the reply, said or not; and the agent's tokens and cost, counted with the render model's in the console and Insights (Mercury 3 at $0.20 and $0.70 a million, the render price table).
29. **(2026-11-09, Task 7) The agent's reply held to the facts** (`render/agentLine.ts`), once the core has decided, with no model asked to word it:
    - **The checks by code**, of data and shape only: no figure or web address that the facts (what the line may say, its fixed lines), a value held (but a text value, the model's own short version), the words an accepted value cited, the caller's own numbers and date words on the call, a visible tool's result or the turn's own fixed lines hold (the bake-off's rule); one question at most; the word budget and `avoid` of style.yaml; on a call no markup or line break, in a chat no braces or angle brackets; and no key of the answer's own shape run into its words or spelled as the shape spells it (`shape`: "What's your name?values"), read from the schema's own keys.
    - **The price line** is named by the model: where the business has one, the answer carries `fixedLine` (`price` or `none`, in the strict schema; the prompt says to name it where it answers the caller). The core then says the price line whole before the turn's own line and never the reply, so a price is never worded; at a read-back it is an aside, the read-back again as it stands. A reply that words a price without naming it falls back on its figure. Detecting price from the reply's words would be a list of English words; the model's own answer is the clean signal.
    - **The drift judge** (`renderAgentDrift`, on the decision model, `judge.refuseAt`) is given who speaks, to whom and where, the reply, what follows it, what the line may say, its background, its fixed lines, every value understood (masked as the records mask it, whether the caller confirmed it, a text value as a summary with the caller's words it came from this turn), the seen results and the caller's words; and asked whether the reply says anything the business has not given its line to say.
    - **A fallback** says the fixed line (for an aside, nothing: the turn's own line follows), corrects `lastPromptText`, the conversation's last line and the decision traced, records `render_fallback` (`agent: true`) and keeps the line on the agent's record (`line`, a RenderLine with `source: 'agent'`, its judge reading kept), not in the render record, so generated wording's figures stay the generated lines'. The console shows each agent turn's values with their outcomes, the action, the reply said or replaced and why, and the judge's reading; Insights counts the agent's turns, answers missed and replies replaced, by why.

30. **(2026-11-09, Task 8) Tool results the model may see**, the builder's:
    - **A check known closed.** `replyShape` keeps beside each check it makes what it is (`shapeOf`), so a check built only of closed forms (`oneOf`, `digits`, `code`, `isoDate`, `amount`, `number`, `boolean`, and `nullable`, `list`, `object`, `all` and `any` of them) is known closed (`openPart` is null). A check that uses `text()`, or one written by hand (a function the engine cannot read), is refused for a tool a field sees, at load and by `pnpm check`, with the place it is open; so is a seen tool with no check. The model is shown only the fields the check names (`namedPart`): a field it does not name is never checked, so never shown. The policy card lists, for each seen tool, the fields the model is shown.
    - **When it runs.** An accepted value that fills a field whose tool the model sees, with a value its result was not yet shown for, runs the tool through the gate with that field's value, as any tool (an async one waits, `core/toolWait.ts`). A result that fails its check ends the turn with a person (`result-unchecked`) and is never shown; one the gate refuses, or with no value, shows nothing. The result is kept on the call (`Session.agent.seen`, the latest of each tool), so later turns are sent it and the same value runs nothing again.
    - **The second asking.** The core marks the turn (`TurnResult.agentAgain`); the runner asks the model again with the results, given what is left of the turn's agent budget counted from its first asking (the tool's wait included), and resolves the turn again from the start with that answer (`TurnContext.agentSeen`), the calls already made kept (one memo for both resolutions), so none is made twice. The second resolution asks no more. Where no second answer comes (no time left, a timeout, an answer not in its shape, an error), the turn is said as it first stood: its values, its fixed question or read-back, and never the first reply, which was written without the result. That is no failure in the count of two in a row; the trace keeps it (`again`). A reply of the second answer is not said where it gave a value whose result the model was not shown.
    - **At a read-back,** a correction of such a field runs it too, and the second answer's reply is said as an aside before the read-back again ("Saturday afternoon is full, but the morning is free."), held to the facts and the result as every agent line is.

31. **(2026-11-09, Task 9) Testing an agent-mode app**, the builder's:
    - **The stub regression's fake agent is the scripted call's own data:** each spoken step may name the agent's answer (`agent`: its reply, values with their words, action, fromFacts, fixedLine, each optional, or `{ "fail": "timeout" }`), or a list of them, one per asking (the second where the turn asks again, shown a tool's result). It is the agent's counterpart of the corpus labels the decision model's stub answers from: data beside the words, the same on every machine, read with the call, with no fake agent written in an app's code. A step the agent is asked on that names no answer fails the call, naming the step, rather than pass on an answer no one wrote.
    - **Properties** a scripted call's `expect` may hold beside its end (`harness-text/agentScript.ts`, exported in `dialogwright/testing`): `values` (the params of the last write a form made, by field; with none, the form open at the end), `action` (a tool allowed, `"none"`, or `{ "not": tool }`), `said: { notFigure: true }` (no reply said holds a figure the facts, the values understood or the results shown do not: the caller's own words are no source), `readBackSaid` and `nothingDoneBefore: "confirm"`. Each that fails names its turn.
    - **The agent cassette** is `fixtures/recorded/agent/<provider>__<model>[.settings].jsonl` (the bake-off's name for the app's style.yaml `agent`), keyed by `agent/cassette.ts`; `--client recorded` replays it beside the decision model's, `--client record` appends to it with the author's key and is refused in CI, `--client jev` asks the model. A turn the cassette has no answer for fails its call. A corpus line is the decision model's alone and runs without the agent in either case, so the stubs and a recording read it alike.
    - **The `agent` family** is an agent-mode app's whole adversarial suite: the scripted families seed a call and answer its words by labels the decision model reads in a scripted app, which the agent model does not take. Its cases run under the stub with the agent answering as a fooled model would (a price given, a promise made, `submit` proposed with the values, the instructions obeyed); under a model or its recording, the model answers. Its properties (`no-figure`, `no-promise`: every reply said passed the judge, `confirmed-first`, `level-held`) are checked over the run. Run first, it found the review of Task 7's item 1 (`promise-asked`: the caller's own "today" and "promise" taken as the line's).

32. **(2026-11-09, the review of Task 7) Decided by the maintainer:**
    - **A figure the caller proposes is not the line's.** The caller's numbers and date words are no source of a figure in an agent reply (`agentFigureSources`); the words an accepted value was cited from still are, so "two copies" is said back. This is the engine's own rule for a generated line (`render/checks.ts` `allowedFigures`). The drift judge is asked, besides, whether the line agrees to or states a figure, a time or a promise the caller proposed that what it may say does not hold, and the stub's judge reads the caller's quoted words as the caller's, never as given. The same check reads a pronoun "one" as a figure ("a lovely one"): such a reply falls back to its fixed line, a cost the maintainer accepted over a rule of grammar.
    - **Asides at a read-back are bounded:** of asides in a row at one read-back (a question answered from the facts, the price line), only the first is uncounted; a second in a row counts as any other turn, and an aside with nothing said in answer always counts, so a caller who only asks still reaches the keypad and a person.
    - **After "What should I change?"**, a reply that asks nothing is said before the question, never in its place.
    - **`RENDER_CHECK_TIMEOUT_MS` holds the agent reply's judge** as it holds a generated line's: the server passes the render settings' budget through the agent runner and logs it at start.
    - **Chat buttons:** the fixed line said in a reply's place gets its question's buttons again (it is noted as the prompt's own said line), and a question after an aside keeps its buttons.
    - **The judge is given the call so far** (`agent.conversation`), masked as the agent model is sent it, this turn's words quoted apart.
    - Smaller: `shapeLeak` refuses a key only where the answer's JSON marks join it to a word, or as the schema spells it (camelCase), never an ordinary word; Insights shows the turns the agent was asked and those it answered apart.
    - **For Task 10:** the demo's price line must not promise a link before the request is confirmed (decision 25): `send_photo_link` is a `then` tool, called only by the read-back's yes, so a price line said before it ("I'll text you a link to send one") would promise what the line has not yet done; word it as what happens once the request is sent.

33. **(2026-11-09, the review of Tasks 8 and 9) Decided by the maintainer:**
    - **A yes said with a change never completes on the second asking.** At a read-back, where the first resolution changed a value and asked the model again, the second resolution says the read-back again, the reply as an aside, whatever the second answer gave ("yes, but make it Saturday afternoon": nothing is booked until the caller confirms the read-back as it now stands; `TurnContext.agentSeen.changed`).
    - **A seen tool that throws or replies late shows nothing,** and the turn goes on; `callTool` records the failure. A result that fails its check still ends with a person. A check not known closed at run time (a guard behind `pnpm check`) shows nothing and runs no tool.
    - **The first resolution's lookups are kept:** the second resolution makes each of them again through the turn's memo (no tool runs twice), so the turn's gate events, its audit and the call's `seen` keep every lookup that ran, whatever the second answer gave. The call keeps the latest eight results, one per tool, field and value.
    - **No second asking where a value was refused** on the same turn: its slot's question is asked.
    - **Figure sources:** a `choice`'s or a `date`'s cited words are no source (they are not tied to the value: a synonym, "Thursday"); its held value and display are. A `digits` or `name` value's cited words stay sources: its check ties them to the value.
    - **`sees` only on a field the records keep whole** (`redact: none`; a digits field's default is last4): `pnpm check` refuses any other, since the value and its result would reach the model whole. A `code()` longer than 20 characters is no closed form.
    - **`replyShape.object`** closes over one frozen copy of its fields, which both the check and what it is read.
    - **The adversarial suite of an agent-mode app** is the `agent` family and the `hostile-reply` family, run over the app's own scripted calls with the agent answers their steps name. The `agent` family adds an injection at a read-back, an injection given as a `text` field's value (read back in its place, and sent to the model and the judge after), and an injection on the callback form; `claimed-account` and `instructions-to-the-model` gain a yes. `level-held` holds every write to the level the caller had once greeted (recognition is at the call's start only, call 15).
    - **`readBackSaid`** holds the read-back's values (as held when it was said) to the write's params, and allows the keypad rung (`confirm_dtmf`) between them.
    - **One scripted answer per asking:** where a turn asks the agent again, its step must name a second answer; a missing one fails the call, naming the step.
    - **`pnpm check` warns of a field's labels in an agent-mode app's corpus**, since a corpus line runs without the agent (the guide's note comes in Task 11). `--client jev` is refused in CI for the agent model, as recording is.
    - **The judge's history** takes off only the line this turn noted. The bake-off counts, beside the replies with a figure not in the facts, those whose only such figure is the number one, so the cost of call 32's "one" is measured in Task 12.

34. **(2026-11-09, from building `apps/wheelshop`) Decided by the maintainer:**
    - **A figure in an accepted text value is a source** where it is both in the value as held and in the words the value was cited from ("2020 BMW 3 Series" from "it's a 2020 BMW 3 Series"), so "A 3 Series, nice" passes. A figure the caller says outside an accepted value's own words stays no source (call 32 holds).
    - **The app map draws a tool a field sees** as called once its field is filled, its result shown to the model (a dotted edge from the slot), never by the read-back's yes; the forms' `calls` still list it, so reach is checked as before.
    - **A default corpus seed:** an agent-mode app whose code writes no `testing.seed` gets one from business.yaml, by the slots the engine builds (`<form>_<field>`): each value the app's grid's (`policyMatrix().values`, by field) or a stand-in of its type, its display as the slot's own check shows it, and with accounts the first account recognized at level 1, calling from its first number. An app's own seed wins.

35. **(2026-11-08, the first recording of `apps/wheelshop`) The builder's, for the maintainer to check:**
    - **A `callback` the agent model proposes is taken only where the decision model agrees.** Mercury 3 read "I'll have Sam call you back to confirm" as a callback mid-request (5 of 11 askings of one turn), the decision model reading wantsHuman 0.02, and the request was left. Now: taken where the decision model's verdict routes to the person form; checked with the caller ("Just to check, do you want to speak with someone?", the `agent` intent's explicit check; a yes opens the person form, a no goes back to the form where it stood, its read-back where every required field is filled) where its wantsHuman, or the `agent` and person-form intents together, reach INTENT_EXPLICIT; otherwise not taken, its reply not said (`actionOutcome`: `taken`, `checked`, `ignored`). The action's description says it is for a caller who asks to speak with a person, never for a call the business makes anyway.
    - **One answer per request in a regression.** The agent cassette answers every asking of a request as first recorded, and a recording asks only a request with none (`oneAnswer`; the bake-off keeps its answers in turn); a live run (`--client jev`) asks once per request. So an adversarial variant differs from its clean call by what was changed in it, never by the model sampled twice, and a call replays alone (`--scenario <id>`) as in the whole run.
    - **A corpus line runs with an agent that understands nothing,** never as a call with no key: the decision model is asked only what agent mode asks it, and no field fills, so the stubs and a recording read the line alike (call 31's aim).
    - **An answer that leaves out `values` gives none;** any other key left out is still refused.
    - **`said.notFigure` reads figures as the agent line's check does** (call 34's text value, a digits or name value's words), and **`values` may name words a text value holds** (`{ "has": [...] }`), any case and order.
    - **The transcript** (`regress --scenario <id>`) shows the agent's answer under each turn: its values with their checks, the action and what was done with it, the reply said or replaced and why, a second asking.

36. **(2026-11-08, after the triage of the first wheelshop recording) Decided by the maintainer:**
    - **Call 35's callback rule and its `values` leniency stand.**
    - **The budgets:** `AGENT_TIMEOUT_VOICE_MS` defaults to 1800, the bar's p95, and `AGENT_TIMEOUT_CHAT_MS` to 4000: a turn that asks the model twice (shown a seen tool's result) took up to 1.75 s in the recording, and the first default, 1200 (a single asking's p95 and 300 ms), would have cut most of them, saying the turn as it first stood (the full window's news lost). Options of agent apps only: nothing scripted changes.
    - **`prices.forms`:** the forms in which the model may name the price line (default every form). With another form open it is not offered, and named there, neither it nor the reply is said. The wheelshop's is `[request]` (the model named it in a dealership's booking, promising a photo link a booking never sends), with an assumption claim for the dealerships: "Dealership work is billed at the rates agreed with Sam."
    - **`freeFrom: <tool>.<list>`** on a choice field: once the model has been shown the result of a tool a field of the same form sees, for the form's value of that field, a value its list does not name is refused (`range`): the slot as it was, its own ladder, the reply not said. So the line never takes, or promises, a full window ("We can take it Friday morning", shown Friday morning full). `pnpm check` refuses it on a field that is not a choice, from a tool no field of the form sees, or naming a list the tool's check does not name.
    - **`words.answer`** in style.yaml: the budget of a reply that answers from the facts (`fromFacts`), on either channel; default the channel's and half again. The diamond-cut explanation (45 words over 30) was replaced by the next question, the caller's question unanswered. The wheelshop keeps `words.voice: 30`.
    - **Every handoff opens the callback form** where the business has one (frustration, attempts run out, a system's failure, a person asked for or needed): the handoff line, then the form. Only a handoff of the callback form itself ends with the statement alone, and so does a downstream reply that failed its check (`result-unchecked`), whose record goes with the handoff (the adversarial suite holds such a turn to end with a person).
    - **The persona reaches the model:** `business.kind`, `owner` and `oneOwner` (the persona in `agent/prompt.ts`, through `factsOf`): whom the line speaks for, that it is never the owner, and that a one-person business has no team.
    - **`pnpm configure`** asks an agent-mode app for its agent model's key (`INCEPTION_API_KEY`, or `OPENROUTER_API_KEY`), with the echo off, with a decision model or a phone line; Enter leaves it unset.

37. **(2026-11-08, the third wheelshop recording) The builder's, for the maintainer to check:** a value the model gives that is the held value as it holds it, shows it, or was sent it masked ("...0177" at a callback number's read-back) is no new value and no correction: kept as it is, nothing refused. The model restated the number masked at the callback note's read-back, and its refusal set the read-back aside.

38. **(2026-11-08, the third wheelshop recording) Decided by the maintainer: robust to the model's failures, never tagged.**
    - **A failed answer at a read-back gets a scripted reading of that turn** (replacing call 28's "never completes"). Where the agent's answer fails at a form's read-back (a timeout, an answer not in its shape, an error), the decision model is asked again on the same turn with the questions the form asks as a scripted app (each slot's, and those `correctingFill` reads), as a call with no key runs, and the turn is decided the scripted way: a plain yes completes; "yes, but make it three" corrects the value and says the read-back again, nothing filed. An optional field left empty is not asked on the way back, as in agent mode. The asking counts in the turn's agent budget (counted from the agent's asking, at most JEV_TIMEOUT_MS); with none in time, the read-back is said again as before. The call goes on in agent mode, the failure counted. The trace keeps it as the turn's follow-up (`agent-failed`) and the agent record's `scripted` (`read` or `none`).
    - **The agent's answer is capped:** `max_tokens` 400 (the OpenAI-compatible chat API's, which Inception's and OpenRouter's take; 4000 where the model reasons), sized from the largest valid answer of the bake-off and the recordings (302 tokens of 560) with a third more. An answer cut off at it is `invalid` at once. The answers that ran on ("Goodbye. Goodbye. ...") took 950 to 1000 tokens. The request changes, so the agent cassettes (wheelshop's, the bake-off's) are recorded again.
    - **`claimed-account` holds what it proves:** an unknown number saying it is an account cannot book. It is held to the level greeted (`levelHeld`), no booking, the booking line said (`said.lines`), and the request begun, never to which values the model took on that turn. Two scripted-call properties are added for it: `said.lines` (each line named was said on some turn) and `levelHeld` (nothing ran above the level the caller had once greeted, the agent family's `level-held`).

39. **(2026-11-08, the fourth wheelshop recording) Decided by the maintainer: the second asking keeps the first answer's values.** On a turn asked again with a seen tool's result (call 30), a value the first answer gave and the turn accepted is kept where the second answer leaves it out: an omission is no retraction (`claimed-account`: shown the day's windows, the model gave neither the day nor the window again, and both were lost). A value the second answer gives replaces the first's. A `freeFrom` field's first value is kept only where the result still lists it, and is checked again with the rest; one the result no longer lists is left out, never refused, so its question is asked with no attempt counted (core/agentTurn.ts withFirstValues).

40. **(2026-11-08, the whole-branch review) Decided by the maintainer:**
    - **A text value carries nothing of its own.** The text slot's check refuses (`words`) a value with a figure (a number, an amount, a date word) or a web address that neither the words it is cited from (as said, and as the slot writes them) nor the value the slot held before have ("The Quiet Harbor, waived fee of $40 agreed" cited from "The Quiet Harbor"). And each text value accepted that is not the caller's words as cited is judged against them by the drift judge a framed summary is (`renderSpanDrift`), at the app's `refuseAt`; refused, failed or late, the value held is the cited words as said, the turn resolved again with them (`agent.textJudged`). (Replaced by call 45: such a value is never held, nor are the words it cited.)
    - **Every held `freeFrom` value is checked again** after the turn's values and its seen lookups, and before a read-back, in a form and at its read-back: one the latest result for its day no longer lists is cleared, no attempt counted, and its question asked (a window chosen before the day, the day then shown with it taken). The wheelshop's `book` also refuses a window without room for its cars, as a real calendar would (its reply then fails its check, and the call goes to a person); the gate is not the place for that.
    - **After a `system-failure` handoff the rest of the call is scripted** (`Session.agent.scripted`), so the callback form is filled by the decision model, not the model that failed.
    - **Optional fields are read back:** every field is sent by the form's `then`, so `pnpm check` refuses an optional field its read-back does not name; one named needs `says.unset`. A choice field's `says` gives each option's words in the read-back and the done line (and `unset`, for an optional field left empty), through the form's summary hook. The wheelshop's read-back says the diamond cut: "diamond cut", "not diamond cut", "not sure if diamond cut".
    - **The bake-off reads the app's facts:** `agent:bakeoff --business <business.yaml>`, or the cases' `business:`, gives the facts, persona, sample replies, forms (their actions as the engine offers them) and fixed lines the app sends; the cases keep the calls and their labels.

41. **(2026-11-08) Decided by the maintainer: in agent mode, a scripted call's caller answers what the line asks.** A scenario may give `answers`, keyed by the question the line said: the prompt itself (`readback_request`, `confirm_intent_explicit`, `offer_request_callbackNumber`) or the slot a field's question asks (`request_day` answers `ask_request_day` and its retry). After its ordered `steps` (the turns tied to no question: the opening, an aside), each turn says the answer to the line's question, until the line asks none (`anything_else`, a goodbye, a handoff, the call's end) or the one `expect.promptId` names. A question asked again is answered again with the same words; a list answers in turn, its last again after that. A question with no answer fails the call, naming it; a call still asking after 24 answers fails. The stub's agent answers stay with each step, one per asking; the properties are unchanged. The wheelshop's calls whose middle turns rested on question order take this form, so a recorded run no longer depends on which field the model asks first.

42. **(2026-11-08) Decided by the maintainer: a chat opens and ends on its own lines.** `business.yaml`'s `greeting` and `closing` were said on both channels, so a web chat opened with "Thanks for calling" and ended on it. It may now be a string, the call's greeting (a chat gets the chat default), or `{ call, chat }`, each channel's own, one left out keeping its default. The chat default is "Hi, this is `<says>`. What can I help with?", worded as the scripted apps' chat greetings are ("Hi, this is Example Service Line. ... What can I help with?"; the maintainer kept that ending); the call's stays "Thanks for calling `<says>`. How can I help?". `closing` is read the same way (still required): a string is the call's, and the chat default is "Thanks for chatting with `<says>`. Goodbye.", as the scripted apps' `goodbye_chat` lines are worded ("Thanks for chatting with Example Service Line. Goodbye."); within `{ call, chat }` the call's default is "Thanks for calling `<says>`.". The call's closing is the one the agent model is told of (`fixed_lines`), on either channel, so no request changes. Each line's placeholders are checked at its own path (`greeting.call`, `closing.chat`, ...), and the policy card lists `greeting_chat` and `goodbye_chat` among the fixed lines. The wheelshop's greeting is the default and its closing a string, so its chat now opens and ends on the chat defaults and its call's lines are unchanged; its scripted calls and corpus run as calls, so no recording changed and none was made again.

43. **(2026-11-08) Decided by the maintainer: the price line needs the decision model to agree.** In a live chat on the wheelshop the agent model named `fixedLine: price` on the turn the caller gave their callback number (the last empty field), and the whole price line ("Sam quotes every job from a photo, ... you'll get a text ...") was said before the read-back, with no price asked: the model used it as a "what happens next". On an earlier turn it proposed `submit` with a required field still empty, which the engine rightly ignored.
    - **One more turn-level question**, asked on every agent turn of an app with a price line, and nowhere else (`asksPrice`, core/questions.ts): "Read asr.text. Does the caller ask what something costs, such as a price, a fee, a quote, or how much it is?", its criteria `true`: "The caller asks what something costs or will cost: a price, a fee, a rate, an estimate or a quote, or how much it is, even roughly, as a range, or by proposing a figure"; `false`: "The caller asks about something else, gives a detail such as a name, a day, a count or a phone number, answers the question just asked, or says nothing about what anything costs".
    - **The line is due on that reading** (`AGENT_PRICE_ASKED`, 0.5, beside the other thresholds; fixed, not swept): at or above it the price line is said whole before the turn's own line, the reply never, whether or not the answer named it (the caller asked; the line is the business's answer). Named under it, the line is not said and the turn goes on as one that named none: the reply goes through the checks and the judge, its fixed question in its place where it fails. `prices.forms` still holds (a line named and due where the form does not allow it takes its reply with it; one read and not named there is simply not said). At a read-back a price line said is an aside under call 32's bound: the first in a row uncounted, the second counted. A turn with the line said is no miss over a line.
    - **The trace** keeps the reading on the agent's record (`priceAsked`: its score, the bar, whether the answer named the line); the transcript and the console show it where the line was said, or named and not said.
    - **The prompt says what each fixed line is for**, in `<fixed_lines>`: the price line "for a caller who asks what something costs; never to say what happens next or to sum up", the handoff "for a caller who asks to speak with a person", the closing "for the end of the call"; the rule names a line "where a line of <fixed_lines> answers what the caller asked this turn ..., as its purpose there says", and otherwise none. `submit` is "only once nothing the form needs is still missing (no required field left in <still_needed>)". The request changes, so the wheelshop's agent and Jev cassettes and the bake-off's were recorded again.
    - **Amended (2026-11-08, after an automated security review): a reply written beside the price line is never said on its own.** As first written, the price line named and read under the bar left the reply to the checks and the judge alone (above): the model wrote it as a price answer, and before call 43 a reply whose answer named the price line was never said. The deterministic fail-safe is kept: named and read under the bar, neither the line nor the reply is said, and the turn says its own fixed step (the next field's question, or the read-back again on its ladder), as a line named where `prices.forms` does not allow it already did (`withoutAgentReply`); the values the answer gave stand. With no reading (`asksPrice` missing from the decision model's answers, or not a yes or no), the safe outcome: a line named is said, never the reply; none named, nothing about price is said, as before. The trace keeps no `priceAsked` there, only the line said. Tests (core/agentTurn.test.ts): named with no price asked, mid-form and at the read-back, neither the line nor the reply and the fixed question or the read-back; named with no reading (missing, or of the wrong type), the line; not named with no reading, the turn as before. The recorded wheelshop regression is unchanged (corpus 24/26, the two known gaps; scenarios 8/8 matching; adversarial 26/26; nothing to triage, no cassette miss, nothing recorded again): its one turn on this path, `price-pushed`'s third push ("just give me a number", read 0.02, the line named), heard the name question alone before, its reply having fallen back on the word budget, and hears it now with the reply never put to the checks.
    - **What the recording showed.** Jev read the price questions at 0.96 to 0.99, and "Seriously, just give me a number." (the third push in `price-pushed`, its words alone) at 0.02: the line is not said there, the reply (the model's own copy of the price line and the name question) fell back on the word budget, and the caller heard the name question alone, having heard the price line twice. The corpus's two price questions (`rq-05`, `rq-10`) now say the price line, though the corpus runs with an agent that understands nothing: they give the stubs the reading with an answers override. No other recorded turn had the model name the line where the decision model read no price asked.

44. **(2026-11-08) Decided by the maintainer: the demo speaks as the business.** The wheelshop's line named its owner throughout ("send Sam a request", "I'll have Sam call you back as soon as he's free."), which sounds like one person's phone, not a professional operation. It now speaks as the business: "we", "the shop", "Example Wheel Works". An app change only, no engine change: `business.yaml` drops `business.owner`, `oneOwner` and the `background` line that the owner works alone (each pushed the model toward talking about him); `voice` describes a friendly, professional front desk that speaks for the shop as "we"; the claims ("We see this kind of damage every day.", "Diamond cut wheels are what our lathe is for."), the price line ("We quote every job from a photo, because the price depends on the damage. Once your request is in, you'll get a text with a link to send one, and we'll get back to you with a price and confirm your drop-off.": still no link promised before the read-back's yes, decision 25), the read-backs ("Here's your request: ..."), the done lines, the handoff and the callback note ("Someone from the shop will call you back as soon as they can."), the labels, the tool descriptions and the sample replies say "we" or "the shop". The owner's summary is for the shop and is unchanged; so are the assumptions' labels. The policy matrix is unchanged; the policy card and the app map change in wording only (and "0 lines of background"). The appendix is updated to match.
    - **Recorded fresh** (both cassettes emptied, then `--client record`; the persona changes every request): corpus 24/26 (the two known gaps), scenarios 8/8, every call matching the stub baseline, adversarial 26/26, no cassette miss, 0 to triage. No reply named a person; every one spoke as "we". The stub baseline is unchanged.
    - **The bake-off** (below, "after call 44") missed the bar on values right at 85% (0 wrong, 11 missed) over 3 repeats. Measured again into a scratch folder at 8 repeats, the old voice and the new alike read 91% (0 wrong, 17 and 18 missed), so the 85% is the sample, not the voice; the misses are the same values left out as before (`correction-in-one-turn`'s 2021 Camry, `claimed-account`'s day and window), each asked for by its field's question.

45. **(2026-11-08) Decided by the maintainer: a text value the judge refuses is never held as raw words.** Call 40 held a refused text value as the caller's cited words, and on the recordings that read back badly inside the frame ("a Honda Civic with It's two wheels, both with curb rash., on two of its wheels", "Rivergate Motors dropping off take the Tacoma off. It's just the Civic ..."). Now:
    - **Refused, failed or late, the value is not held.** Where the drift judge refuses a newly understood text value against the caller's words, fails or is late, the field keeps the value it held before, or none (the value's outcome is `judged`; `agent.textJudged`'s `held` is `before`). The engine never substitutes the cited words; a value the model itself gives as the caller's words as cited is not judged, as before.
    - **Its question is asked again.** The turn is resolved again with the field marked (`TurnContext.agentTextRefused`): the field's fixed question, the reply not said (it was written with the value). The first such refusal of a field counts no attempt; a second, with no value of the field held between (`Session.agent.judged`), counts one and walks the slot's own ladder, so a field the judge keeps refusing still reaches the keypad and a person. The turn's other values stand.
    - **At a read-back** a text correction the judge refuses keeps the value read back, sets the read-back aside and asks the field's question, under the same count; the next answer is read back again.
    - **The judge of a text value has a question of its own** (`renderAgentValue`, render/checks.ts), found with the texting build's recording: the span drift question holds a summary to keep every amount its words give, so "curb rash" cited from "It's two wheels, both with curb rash." was refused (0.62 to 0.69, three askings), and with nothing held the damage was asked until the attempts ran out and the call was handed off. A field's value is one detail of what the caller said: the judge is now given the field, what it holds and the form's other fields, which hold the other details apart, and asked whether the value is anything but what the words say of its field. Measured live (three askings each): the extractions pass ("curb rash" from that sentence 0.20 to 0.27, "Civic and Model 3" from "take the Tacoma off. It's just the Civic and the Model 3" 0.10 to 0.17, "2020 BMW 3 Series" 0.05), and what a value must not do is refused ("curb rash" from "It's not curb rash, the rim is cracked." 0.94 to 0.95; "curb rash on all four wheels" from "curb rash on the front one" 0.96; "The Quiet Harbor, a signed copy" from "The Quiet Harbor" 0.89; "Civic and Tacoma" from the Tacoma taken off 0.91 to 0.93). The stub's judge (`stubAgentValue`) refuses a value's own figures, names and words, never what it leaves out.
    - Tests: core/agentTurn.test.ts, "a text value the judge refuses is never held as raw words (call 45)".

46. **(2026-11-08, the review of the texting branch) Decided by the maintainer** ([the texting design](2026-11-08-texting.md), "Call 46"): a text is routed under a host by each app's `TEXT_FROM`, then by host.yaml's `numbers`, and one for no app is recorded under `_server` and handed to none; the sender's abuse limits (`TEXT_LIMIT_PER_NUMBER`, default 3 a day; `TEXT_LIMIT_PER_HOUR`, default 20; a refused send `limited`, never retried); `texts` off the app context (a hook texts through a gated tool); a message sent again handed on once; send errors scrubbed of addresses and numbers; the wheelshop's thank-you only to a request that said yes to texts; `when` refused on an optional field and with a reserved reason; the webhook mounted only where an app takes or sends texts, and only Twilio's own media URLs kept. For agent mode: a value that restates the one held is not judged again, and guide 18 states call 45's trade-off (a long judge outage asks a text field twice, then counts).

47. **(2026-11-08, a live call on the wheelshop) Figures are compared as numbers on both sides.** The caller said "It's a twenty twenty three Kia Sorento."; the model gave `vehicle` "2023 Kia Sorento", refused (`words`) on two turns: the text check (call 40) read "twenty twenty three" as 20 + 20 + 3, so the value's "2023" was a figure its words did not have, and the third try passed only because the model kept the words. Now every figure, in a value, a reply or a source, is read as the number it is (`render/checks.ts` `figuresOf`: its digits, its number words, leading zeros taken off), and a year said in pairs is the year ("twenty twenty three" 2023, "nineteen ninety nine" 1999, "nineteen oh five" 1905, "twenty twenty" 2020): data in the lexicon behind `spokenToDigits` (`Lexicon.yearPairs`: the first pairs ten to twenty, and "oh" for a nought; Spanish says its years whole and has none), read by `yearPairAt` (core/extract/spokenNumber.ts), which `spelledNumbers` takes where no number is open ("two thousand twenty three" is a number said whole, "twenty one" a count). It holds wherever figures are compared in agent mode: the text slot's check, the agent line's figure sources (`textValueFigures`, `callerFigures`), and the bake-off's scoring (`figuresIn`), which all go through `figuresOf`. Tests: "2023 Kia Sorento" from "twenty twenty three Kia Sorento" passes, "2024 Kia Sorento" from it is refused, "two wheels" against "2" either way, "1999" from "nineteen ninety nine".
48. **(2026-11-08, the same call) A silence after words set aside is no silence to apologize for.** The caller said "Uh, it has both." just before the line's long question ended; the answer gave no value, so the turn was set aside as speech over a line (`SPEECH_OVER_LINE=unless-miss`), and the no-input wait then said "I didn't hear anything." and the question: untrue, the caller spoke. Now a turn whose words are set aside unanswered (speech over a line taken as a miss, or side speech) keeps the question it was at (`Session.spokeAt`, optional, so `SESSION_SCHEMA` is unchanged; gone after the next turn, whatever it is), and a silence right after it at the same question says the question again without the `no_input` line or a slot's own no-input line, the attempt counted as for any silence (core/turn.ts `handleSilence`). A second silence is a silence, with its line. It is the engine's, for every app, since the set-aside is the engine's own: an amendment to SPEECH_OVER_LINE. Tests: core/speechOverLine.test.ts ("a silence after words set aside"), server/speechOverLine.test.ts.
49. **(2026-11-08, the same call) A choice of yes and no is read by the decision model's yes or no.** At the consent question (`ask_request_textOk`, "Is it OK if we text you at that number?"), "Yeah. That's fine." gave no value (the model proposed `submit` and left `textOk` out), so the question was asked again. Now, where the line has just asked a field of the form open (`Session.promptedFor`) that is a `choice` whose options are exactly yes and no, the decision model is asked its `confirmsYes` and `confirmsNo` that turn, as at a read-back (questions.ts `yesNoFieldAsked`), and nowhere else. A clear reading, at the read-back's bars (a yes at `CONFIRM_YES` and at least the no; else a no at `CONFIRM_NO`), fills the field with the option yes or no (`by: 'decision-model'` on the slot and on the agent record's value; the record's `yesNo` keeps the readings), in place of any value the answer gave it; where the answer gave the other option, its reply, written with it, is not said. An unclear reading leaves the field to the agent's answer, as on any turn. The request changes on that turn only, so the wheelshop's recordings were made again where it asks. Tests: core/agentYesNo.test.ts.
50. **(2026-11-08) Decided by the maintainer: an account's number may name a setting.** So the dealer flow can be heard on a real call from a tester's own phone, whose number never belongs in the repository, `business.yaml`'s `accounts[].numbers` take `env.<NAME>` beside a number written out (`["+15555550142", "env.DEALER_TEST_LINE"]`), read as app.yaml's `voice.numbers` reads one (`ENV_REFERENCE`). The value is read from the app's own settings (its settings file under a host, or the environment): by the call-start lookup and the recognition at call time (`ToolContext.env`, define/accountNumbers.ts), and by the server as it starts (server/transfer.ts `accountSettingsFrom`), whose host reads the app's own file for it (define/envReferences.ts lists it, `kind: 'account'`). An unset setting is left out with a startup note, never an error, so the tests and the regressions run without it. A set value must be E.164: the server refuses to start otherwise, naming the setting, and `pnpm diagnose` fails it. It counts in the uniqueness check like a written number (one setting on two accounts is refused by `pnpm check`; a value that is another account's number stops the server). `pnpm check` takes the form and checks the name's shape. The policy card names the setting and its account, never its value; the app's default seed and the wheelshop's owner summary use a number written out. The wheelshop's Rivergate Motors lists `env.DEALER_TEST_LINE`, a tester's own phone set privately on a host, and its `.env.example` has `DEALER_TEST_LINE=` with that note. Tests: define/accountNumbers.test.ts.
51. **(2026-11-08, the live call of calls 47 to 49) The wheelshop's fields, by their meaning.** An app change only. "It is shiny, but it also has painted sections too." was taken as `diamondCut: not sure` while the model's own reply called them "two-tone diamond cut wheels" (the judge refused the reply): by the shop's own facts a bright machined face with painted sections, two-tone, is diamond cut, and the field's `about` now says so, describing the meaning with no example value. The read-back said "a twenty twenty three Kia Sorento with curbed and scraped up": the `damage` field's `about` now asks for a short noun phrase in the caller's own terms (a name for the damage, not a clause or a sentence), still with no example (examples are copied into values, the ninth recording); the frame ("a {vehicle} with {damage}, on {wheels} of its wheels") reads well with one. Measured with `--client jev` before recording: a first wording that named `{vehicle}` made the model leave the damage out on 3 of 6 askings of `over-the-greeting`; the one kept took it on 6 of 6 and gave a noun phrase on 4 of 4. A scripted call reproduces the live call's turns (`live-call-sorento`: the year said in pairs, words over the diamond cut question then a silence, "Yeah. That's fine." at the consent question), and a scenario's `answers` may now give a silence (`{ "silence": true }`), with a turn the line ignored leaving the question it was on. The engine's stub judge of a text value compares figures as numbers too (call 47). Both cassettes were recorded fresh (corpus 36/38, the two known gaps; scenarios 10/10; adversarial 26/26; 0 to triage), and the bake-off's turns again on its cassette (values right 92%, p50 526 ms, p95 818 ms).
52. **(2026-11-08) Decided by the maintainer: quote and confirm.** A retail request becomes a booking only after the customer accepts. On the wheelshop's shop page each request card has a "Quote and book" form (a price; a drop-off day and window, the caller's own picked where it has room, offering only windows with room in the calendar the dealerships book into; Send). Sending holds the window for the request, texts the customer business.yaml's `texts.quote` (only where the request's `textOk` is yes; otherwise the card says to call, with the number) and shows the request "Quoted, waiting". The reply word is `texts.confirmWord`, default CONFIRM (not YES, a Twilio opt-in keyword), and the reply is read by the decision model through a new engine capability, `TextContext.decide` (typed questions about a text, the calls' client, recorded in the audit as `text_decision`; [the texting design](2026-11-08-texting.md), "Call 52"): a yes books the held window, texts `texts.booked` and joins Bookings by day and window; anything else goes to the shop's phone ("Reply from <name>, ...<last4>: <words>") and the hold stays. The hold lapses at 6 pm the day before the drop-off (the server's `TIMEZONE`: no app or business time zone exists) or 24 hours after the quote, whichever comes first: the window released, the shop told, the card "Lapsed"; checked on the server's minute sweep (the page route's), as the page is drawn, as the server starts and before a reply is read, each lapse in the shop's log, so it survives a restart; one server's. The builder's, for the maintainer to check: a yes after a 24-hour lapse still books while the window has room and its 6 pm the day before is to come, and otherwise the shop is told to call (`texts.quoteFull`, `texts.quoteLate`) and the customer is not texted; the shop is texted each booking a reply makes (`texts.quoteBooked`); the form is POST only, behind the page's sign-in, with an HMAC token of the request and its version under a key made at each start, and once for the request and version; an app's pages get the app's sender (`AppPageDeps.texts`) to text the quote and the lapses. No scripted call: the regression harness drives calls, not `onText`; `apps/wheelshop/src/quotes.test.ts` holds it ([DESIGN.md](../../apps/wheelshop/DESIGN.md#quote-and-confirm)). Nothing the agent model or the decision model is sent on a call changes, so no recording was made again.
53. **(2026-11-08, the review of quote and confirm) Decided by the maintainer** ([the wheelshop's DESIGN.md](../../apps/wheelshop/DESIGN.md#quote-and-confirm)):
   - **A superseded quote is never booked, nor a request twice.** After the decision model answers, the reply is read against the quote as it then stands, on the clock of that moment: a quote no longer its request's latest, superseded, withdrawn or booked sends the reply to the shop (`texts.quoteReply`). `bookQuote` books only a waiting quote, its request's latest, whose request has no booking, inside its hold.
   - **A lapsed quote never books.** A reply to one is not read by the model and goes to the shop to call (`texts.quoteLate`); the customer gets no text. Only a waiting quote is read and booked.
   - **Receipts are checked.** Where the customer's booked text does not go (`limited`, `failed`, `refused`, `printed`), the shop's `texts.quoteBooked` adds `texts.customerNotTexted` ("Customer not texted (limited): call them."); a quote whose text did not go says so on its card, with why and the number to call.
   - **Numbers are matched exactly.** A reply, and a photo's request on file, only from a `+1` number that is the request's (`sameNumber`, now exported, against `+1` and its ten digits); the booked text and the thank-you go to the number that consented, never the number the text came from.
   - **`acceptsQuote` is the goal only** (does the reply accept the quote as offered and ask to book it?), the quote and the reply word as context, no instruction to match a word; a reply books only with `acceptsQuote` at 0.7 or more, above `asksChange`, and `asksChange` under 0.5.
   - **`ctx.decide` is costed.** The `text_decision` row adds `inputTokens`, `outputTokens` and `estimated`. The engine puts no limit on `decide` per text that comes in, and guide 13.17 says an app asking on every text lets anyone run up model calls; the wheelshop asks only for a number with a waiting quote.
   - **Page texts.** Guide 13.6 says every app page is given `AppPageDeps.texts`, public ones too, that a public page that texts is an SMS-pumping risk, and that a text's `key` is the audit's id, so it carries no personal data. The wheelshop's page texts through an allow-list (`allowListTexts`): the shop's phone, or a request's callback number that said yes to texts; any other refused and logged.
   - **The forms check Origin and Sec-Fetch-Site** beside their token: the console's sign-in's check, now the engine's `formFromOwnPage` (exported; the console uses it too).
   - **Withdraw.** A waiting quote's Withdraw releases the hold and shows the card "Withdrawn"; the form asks whether to text the customer (`texts.quoteWithdrawn`), unticked by default (the shop calls if it wants).
   - **The texts in a day:** four (the photo request, the thank-you, the quote, the booking), one more for each new quote and for a withdrawal the shop texts. The engine's `TEXT_LIMIT_PER_NUMBER` default stays 3; the wheelshop's `.env.example` suggests 5, and the app notes at start when the limit is under 5. The lapse is still written before the shop is texted.
   - Smaller: the booking uses the clock after the model's answer; a text's reference is taken as it is sent (`Systems.nextRef`), so two texts in flight never share one.

54. **(2026-11-09, a live call on Telnyx to the wheelshop) Decided by the maintainer:** four fixes, the mechanics the builder's. The caller was on a speakerphone with music; the call asked for Friday morning (full on purpose in the demo) three times and ended in a callback note.
    - **A full choice is said to be full.** A `freeFrom` field's value refused as not free (`range`) said only the field's fixed retry ("Morning or afternoon?"), three times, and the model, shown `{ windows: ['afternoon'] }`, had offered "the morning or the afternoon". *As built:* the caller hears, in fixed words, that what they asked for is full and what is free, then the field's question, in place of the plain retry line, the attempt counted as the retry did (`withFull` in core/agentTurn.ts, on a refusal in a form and at a read-back). business.yaml's field key `full` words it: a string is said where another option is free; `{ some, none }` words each case. Its placeholders are the form's fields by name, as in the read-back (the field's own is the option asked for, the seeing field's the day it was looked up for), and in `some`, `{free}`, the options free as the field says them, joined by "or". Left out, the engine's "We're full for the {window} on {day}. We have the {free}." and "We're full on {day}." Where nothing is free on the day, `none` is said, and the day is cleared (its attempts kept) and its question asked; the attempt still counts on the field. A held value cleared because its day changed (call 40's `clearUnfree`) says the same line, no attempt counted. The lines are prompts `full_<form>_<field>` and `full_<form>_<field>_none`, which the policy card lists. `pnpm check` refuses `full` on a field with no `freeFrom`, a placeholder that is no field of the form (or `{free}` in `none`), and a field named `free` in a form with a `freeFrom` field. Once the model has been shown the day's result, the field it is sent lists the free options as its options and the others as full that day (`AgentField.full`, `one of: afternoon; full that day: morning`), on the second asking (run/turn.ts, `narrowedFields`) and on later turns while the day is held; the refusal stays the guard. The free options alone, without the full ones, were tried first: the model then held a caller's "Friday morning" as the afternoon (a choice is not tied to its words, 10a). The wheelshop's line: "{day} in the {window} is full, but we have room in the {free}." *After the review of call 54:* where the first answer gave a full option (the day and the window together) and the second asking, shown it full, leaves the field out (as it tends to), the full line is said in place of the second answer's reply, then the field's question, no attempt counted (`fullLeftOut`, `TurnContext.agentSeen.full`); at a read-back, before the read-back again, which says what the form still holds. The rule is the simplest truthful one: the fixed line, never the reply, so the news never rests on a reply a check or the judge may refuse, and is never said twice. A turn that changes the day to one whose result is already kept asks the model again, sent that day's options (it had been sent the old day's). A full line may name only its own field, the day's and `{free}` (`pnpm check` refuses another field, which may still be empty), and says each option as the read-back does (the field's `says`, `AgentAppField.says`); the model is still sent the options' own words.
    - **Over-line speech that changes nothing is a miss.** The line "Road rash, got it. That's curb rash, and we see it every day. What are you driving?" (not interruptible) heard "road rash" 0.76 s in, the line's own voice echoed; the answer gave the damage again as held (`restated`), no action, and the same reply, and since a value was accepted the turn was taken and the line said again from the start. *As built:* in agent mode a turn over a line is a miss where its answer proposes no action, answers nothing from the facts, and gives no value but those that only restate what their field holds (call 37's `restated`), none refused (`understoodNothing`); under `unless-miss` it is set aside as any miss (nothing said, nothing counted, the line plays on). A value new or changed is a turn. Nothing matches the words heard against the line's. A scripted call may hold `overLineSetAside` (how many turns heard over a line were set aside). The recording found a sample where the model marked such a reply as from the facts, and so it was taken (measured: set aside on 2 of 3 askings).
    - **A read-back's yes survives a slow model.** At the callback note's read-back the caller's "yes" read 0.98, but the agent timed out at its whole budget (`AGENT_TIMEOUT_VOICE_MS`, 1800), no time was left for call 38's scripted reading (`scripted: 'none'`), and the read-back was said again. *As built:* at a form's read-back the agent is asked at, the form's own questions (each field's and those `correctingFill` reads, as an app with no key asks them, an optional field left empty held as declined) ride in the turn's own decision-model request beside the agent's ask (run/turn.ts `readBackReading`), so the reading is there however late the agent fails, and a timeout is decided from the decision model's yes or no and its change questions (a yes with a correction is still read as one). One request: nothing is asked twice or charged twice, and no follow-up request is made (`followUp: agent-failed` is written no more). The agent's turn reads only its own questions' answers. The agent record's `scripted` is `read` (the turn decided from the reading), `unused` (asked, not needed: the agent answered, or the second failure in a row, which still hands off), or `none` (the decision model's request failed). The trace's request shows the reading's questions. *After the review:* `scripted` is set where the screen fired or the turn was quarantined (`unused`) and kept where a text value's judge resolves the turn again, and a follow-up request (an aside's topic) is handed the turn's own answers only. *Measured* (2026-11-09, `jev-1.13.0`, the wheelshop's read-backs, 6 askings each, before and after alternating): the request read-back's request grew from 17 questions to 37 (2,994 to 6,584 tokens, $0.00013 to $0.00028 at $0.042 a million), the booking's 17 to 28 (2,954 to 5,205), the callback note's 17 to 22 (2,915 to 3,562); the decision model's median time went from 96 to 113 ms, 102 to 110 ms and 93 to 104 ms, all of it inside the agent's own time (p50 about 500 ms), so the caller waits no longer.
    - **"no" to "anything else?" is done.** The caller's "no" at "Is there anything else I can help with?" read done 0.54 against none 0.46, and the line checked ("Just to check, do you want to finish up?"). *As built:* the `done` intent built from business.yaml (define/businessFiles.ts) gets the screened fixture's clause, "including a bare no when just asked whether there is anything else". Recorded: "no" done 0.95 at "anything else?"; held where a bare no is not done by two corpus lines, "Nope." at the greeting (none 0.75, done 0.25) and "Nah." at "do you want to speak with someone?" (confirmsNo 0.97, none 0.92), the latter in a corpus context of its own, `check_<intent>` (the line having just checked a request, `confirm_intent_explicit`), added for it.
    - Both wheelshop cassettes were recorded fresh (every decision-model request changed with the `done` criteria; the agent's where a day's result is kept, and at each read-back), and again after the review: corpus 49/51 (the two known gaps), scenarios 12/12, adversarial 26/26, 0 to triage. In that recording the second asking, sent the window with the afternoon only and the morning full, still asked "morning or afternoon?" and the judge passed it (0.41): the reply offering a full option is the judge's to catch, and the refusal and the full line follow when the caller takes it. New scripted calls: `live-call-road-rash` (the call's turns: the echo, Friday, the morning refused with the full line, the afternoon taken) and `no-at-anything-else`; the wheelshop's tests hold the stub run's set-aside and full line ([DESIGN.md](../../apps/wheelshop/DESIGN.md#the-eleventh-recording-call-54-a-live-call-on-telnyx-the-one-committed)).

## Left to the builder

- each slot type's `check`, within the rule above;
- `business.yaml`'s exact schema and how it maps onto intents, forms, slots and policy;
- the agent's JSON shape and its prompt (the goal and full context, never a procedure for the words);
- where in `core/` the agent turn sits beside the scripted one;
- how the console shows proposals;
- the fixed fallback for a reply that fails;
- the measurement harness for Mercury 3.

## The demo's assumptions, for the owner to correct

The demo is a real, working example, so it needs answers only the owner can give. As with a real client, the facts file makes a reasonable assumption for each. The demo is up front that these are assumptions. When the owner hears something that isn't how he works, that is the prompt for him to tell us how he does, or to tell us to leave it out. Each assumption is one entry in `business.yaml`, so correcting it is an edit to the file, never to code.

| Assumption | In the file |
|---|---|
| Curb rash on a diamond cut wheel is usually a same-day fix. | `claims` |
| Cars are dropped off in a window: by 8 in the morning, ready by about noon; or by noon, ready by about 5. | `windows` |
| Each window takes up to three cars. | `windows` |
| He works Monday to Friday. | `days` |
| He works at the shop; no mobile service. | `where.mobile` |
| He doesn't do cracked wheels or straightening. | `notOffered` |
| He quotes every retail job from a photo, and confirms the window with the quote. | `prices`, `request` |
| Dealerships are booked straight into a window. | `booking` |
| He wants a text summary of every request and booking. | `owner` |

## Appendix: the prototype's business facts

The file is invented: no real business, place, person or number. It is shown as text because the format is not built yet.

(2026-11-08, call 44) The maintainer chose the business voice: the line speaks as the business ("we", "the shop", "Example Wheel Works"), never as a named owner. The appendix's wording is updated to match: `owner`, `oneOwner` and the `background` line about the owner working alone are gone, `voice` describes a professional front desk, and the claims, the read-back, the done line, the handoff and the comments say "we" or "the shop" where they said "Sam". The price line is the app's, which promises no link before the request is confirmed (decision 25; the first wording, "I'll text you a link to send one", did). Its shape is otherwise as first written; `apps/wheelshop/DESIGN.md` lists what the build changed.

```text
business:
  name: Example Wheel Works
  says: "Example Wheel Works"
  kind: wheel repair and refinishing
  voice: >
    Friendly, professional and confident, like the front desk of a well-run shop. Speaks for the
    shop as "we". Short sentences. Glad to help, never pushy. Talks about wheels and nothing else.

services:
  - name: curb rash repair
    about: Scrapes and gouges on the rim's edge from a curb.
  - name: scratch and scuff repair
  - name: face damage repair
  - name: diamond cut wheel refinishing
    about: >
      For wheels whose face is bright bare metal with fine machined lines, often two-tone.
      Cut on a lathe in the shop, with the tyre left on.
  - name: refinishing worn or faded finishes
notOffered:                   # assumption: the owner corrects these
  - cracked wheels
  - straightening bent wheels
  - tyres, paint, headlights or anything that isn't a wheel

claims:                       # the only reassurance the line may give (the judge holds it here)
  - Most curb rash and scratches can be fixed.
  - We see this kind of damage every day.
  - Diamond cut wheels are what our lathe is for.
  - Curb rash on a diamond cut wheel is usually a same-day fix.     # assumption
  - Dealerships on Commerce Drive send their trade-ins here.

prices:
  quote: from a photo         # no figures: the line never says a price
  say: >                      # fixed: said in these words when a caller asks about price
    We quote every job from a photo, because the price depends on the damage. Once your request is
    in, you'll get a text with a link to send one, and we'll get back to you with a price and confirm
    your drop-off.

where:
  shop: inside the detailing shop at 400 Commerce Drive, Rivergate
  mobile: false               # assumption: the work is done at the shop
days: [monday, tuesday, wednesday, thursday, friday]               # assumption
windows:                      # assumption: drop-off windows, each with room for some cars
  - name: morning
    says: drop off by 8 in the morning, ready by about noon
    cars: 3
  - name: afternoon
    says: drop off by noon, ready by about 5
    cars: 3

accounts:                     # regulars, booked straight in
  - name: Rivergate Motors
    numbers: ["+15555550142", "+15555550143"]
  - name: Northside Auto Sales
    numbers: ["+15555550150"]
  - name: Lakeview Imports
    numbers: ["+15555550161"]

request:                      # what a retail caller's request collects; the shop confirms the window with the quote
  fields:
    - name: callerName
      type: name
      question: What's your name?
    - name: vehicle
      type: text
      about: The make and model, and the year if they know it.
      question: What car is it?
    - name: wheels
      type: choice
      options: [one, two, three, four]
      question: How many wheels need work?
    - name: damage
      type: text
      about: What the damage is, as the line understood it.
      question: What happened to the wheel?
    - name: diamondCut
      type: choice
      options: [yes, no, not sure]
      about: Whether the wheel's face is bright machined metal with fine lines.
      question: Is the face of the wheel shiny bare metal with fine lines, or painted all over?
      optional: true
    - name: day
      type: date
      question: What day would you like to drop it off?
      sees: availability      # the windows free near that day reach the model (decision 2)
    - name: window
      type: choice
      options: windows        # morning or afternoon, from `windows`
      question: Morning or afternoon?
    - name: callbackNumber
      type: digits
      length: 10
      offer: callerNumber
      question: What's the best number to text you the quote?
  readBack: >
    Here's your request: {callerName}, a {vehicle}, {wheels} wheels, {damage}, hoping to drop
    it off {day} in the {window}, and we'll text you at {callbackNumber}. Is that right?
  then: [send_photo_link, notify_owner]
  done: >
    Thanks, {callerName}. We'll text you a price and confirm your drop-off once we've seen the
    photo.

booking:                      # what a regular account's booking collects
  for: accounts
  fields:
    - name: cars
      type: choice
      options: [one, two, three, four, five, six]
      question: How many cars?
    - name: vehicles
      type: text
      about: The cars and which wheels, by make and model or stock number.
      question: Which cars are they, and which wheels?
    - name: day
      type: date
      question: What day are you dropping them off?
      sees: availability
    - name: window
      type: choice
      options: windows
      question: Morning or afternoon?
  readBack: >
    So that's {cars} cars from {account}, {vehicles}, dropped off {day} in the {window}. Shall I
    book it?
  then: [book, notify_owner]
  done: You're booked for {day}, {window}. Thanks.

handoff: >                    # a callback note to the owner, not a transfer
  Someone from the shop will call you back as soon as they can. What's the best number to reach you?
closing: Thanks for calling Example Wheel Works.
owner:
  notify: text                # assumption; printed until texting is registered
  number: "+15555550100"
  summary: >                  # a fixed template, not a generated line
    New {kind} from {who} ({callbackNumber}): {details}. Drop-off: {day}, {window}.
```

## Measured (2026-11-09, `pnpm agent:bakeoff`, plan Task 2)

The run covered 7 calls and 18 caller turns, each asked 3 times. The cases are in `apps/wheelshop/fixtures/agent/cases.yaml`, with the recordings beside them. The figures assume the drift judge adds 200 ms (Jev's p50 on spans, 2026-10-14). The bar is p50 ≤ 1.0 s, p95 ≤ 1.8 s, valid JSON 98%, values right 90%.

The table is the last of three recordings: after the review's scoring fixes, and after the prompt said a text value is the whole value so far.

| Mercury 3 on Inception's API, `instant`, realtime | valid JSON | values right | actions right | figure not in facts | ms p50 / p95 | with judge | bar |
|---|---|---|---|---|---|---|---|
| with the owner's sample replies | 100% | 94% | 85% | 0 | 482 / 889 | 682 / 1089 | met |
| without them | 98% | 96% | 80% | 3 | 502 / 650 | 702 / 850 | met |

At `low`, the first recording had values right 99% but p50 2.5 s and p95 4.8 s, far over the bar for voice.

**Chosen:** `instant`, realtime, with the owner's sample replies. They gave no reply with a figure the facts don't hold, against three without them. `AGENT_TIMEOUT_VOICE_MS` defaulted to 1200 (p95 + 300, rounded) and `AGENT_TIMEOUT_CHAT_MS` to 3000; superseded by call 36: 1800 (the bar's p95) and 4000, since a turn that asks twice takes up to 1.75 s.

What the measurement showed, for the tasks that follow:
- **OpenRouter no longer serves `inception/mercury-3`** (HTTP 404), so the agent's provider is Inception's API. The apps' wording moved to Inception too, on a branch of its own (`render-inception`).
- **Most action misses are `send_photo_link` proposed before the request is done.** That is harmless, since the action is gated, but Task 6 should decide when it may go.
- **The model reads values back in its reply** ("Let me read it back to you... Does that sound right?") and calls a window free when it has seen no availability ("Thursday morning works"). The engine says the read-back, so Task 7's judge and checks must refuse a reply that confirms values or availability the engine hasn't.
- **It sometimes computes a figure** ("That's seven wheels total"). The figure check refuses it.
- **One reply ended "...What's your name?values"**, a piece of the JSON shape leaking into the words. Task 7's checks should refuse a reply that names a field of the answer's shape.
- **Once, the model introduced itself as the owner** ("Hi, this is Sam at Example Wheel Works"). The judge (Task 7) must refuse the line speaking as a person it is not.
- **With no form chosen yet, the prompt lists no fields**, so a request said over the greeting can give no value. Task 6 sends the fields of the forms the caller may open, or opens one first.

**The wheelshop recordings (2026-11-08, Mercury 3 at `instant` and Jev 1.13.0, three recordings; apps/wheelshop/DESIGN.md "Recordings"):**
- **Latency.** Per answer, p50 551 to 563 ms and p95 801 to 901 ms. Per turn, a turn that asks twice (shown a seen tool's result) took 1.0 to 1.75 s (p95 per turn 1428 ms), so the default budget on a call is now 1800 (call 36). Measured live once with the judge: the judge p50 90 ms, p95 176 ms; a whole turn p50 575 ms, p95 1364 ms.
- **Replies replaced.** Of 123 replies checked over one recorded run, 17 on the word budget (30 on a call) and 12 on two questions; none on a figure, so none on the number one alone.
- **The judge on the bar.** It passed "So it's a Honda Civic, one car." at 0.49, said to a caller who had said two cars ("one" passed the figure check: the offer line's pronoun "one" is among the fixed lines' figures). It refused the owner's own sample reply at 0.53 and 0.54, and passed it at 0.47 and 0.39 on other calls.
- **Answers not in the shape.** `values` left out (2 in about 50: now read as none, call 35); a reply that runs to the token limit ("Goodbye. Goodbye. ...", 3,000 characters, no other key), twice in about 60, both on a final yes at a read-back, which then never completes.
- **The bake-off on the app's business.yaml** (call 40; 2026-11-08, `instant`, realtime, 3 repeats; the facts, persona and fixed lines the app sends, where the table above had a hand-written copy). The table above is kept as history.

  | Mercury 3 on Inception's API, `instant`, realtime | valid JSON | values right | actions right | figure not in facts | ms p50 / p95 | with judge | bar |
  |---|---|---|---|---|---|---|---|
  | with the owner's sample replies | 98% | 94% | 96% | 0 | 541 / 1751 | 741 / 1951 | not met (p95) |
  | without them | 98% | 83% | 98% | 0 | 511 / 1250 | 711 / 1450 | met but values right |

  One answer of each was not valid: one cut off at the 400-token cap, one naming an action not offered. That recording's 1751 ms p95 was taken under a load average of 40. A fresh sample on a quiet machine (the maintainer's, recorded into a scratch folder, not committed): with the sample replies p50 551 ms and p95 1125 ms (1275 with the judge), values right 85% (0 wrong, 11 missed); without them p50 552 ms and p95 3666 ms (one outlier), values right 90%. The misses are never wrong values: a value left out is asked for by its field's question, and every value is read back.
- **The bake-off again, capped at 400 tokens** (call 38; 2026-11-08, `instant`, realtime, 3 repeats): with the owner's sample replies valid JSON 100%, values right 93%, actions right 91%, 2 replies with a figure not in the facts (none on "one" alone); without them 100%, 90%, 83% and 3. The cap cut no answer.
- **The bake-off after call 43** (2026-11-08, `instant`, realtime, the owner's sample replies, 3 repeats, the judge's 150 ms added; the fixed lines' purposes and `submit`'s description in the prompt, recorded fresh):

  | Mercury 3 on Inception's API, `instant`, realtime | valid JSON | values right | actions right | figure not in facts | ms p50 / p95 | with judge | bar |
  |---|---|---|---|---|---|---|---|
  | with the owner's sample replies | 100% | 92% (0 wrong, 6 missed) | 98% | 0 | 522 / 786 | 672 / 936 | met |

  The one action missed was a `callback` proposed at the dealer's second turn (call 35's rule leaves it untaken where the decision model reads no person asked for); the misses are values left out, each asked for by its field's question. Measured under a load average of about 10.
- **The bake-off after call 44** (2026-11-08, the business voice; `instant`, realtime, the owner's sample replies, 3 repeats, the judge's 150 ms added, recorded fresh; load average about 2.4):

  | Mercury 3 on Inception's API, `instant`, realtime | valid JSON | values right | actions right | figure not in facts | ms p50 / p95 | with judge | bar |
  |---|---|---|---|---|---|---|---|
  | with the owner's sample replies | 98% | 85% (0 wrong, 11 missed) | 98% | 1 | 531 / 799 | 681 / 949 | not met (values right) |

  The one answer not in the shape named an action not offered; the figure is the caller's own "$20" and "7am" repeated in a refusal ("I can't confirm a booking for 7am or quote a price of $20."), which the figure check refuses, so the field's question is said. Values right is the sample: at 8 repeats into a scratch folder (not committed) the old voice read 91% (0 wrong, 17 missed; 2 figures not in the facts) and the new 91% (0 wrong, 18 missed; none), p50 468 and 517 ms, p95 723 and 844 ms.
- **The bake-off after texting** (2026-11-08, call 45 and the consent field; `instant`, realtime, the owner's sample replies, 3 repeats, the judge's 150 ms added, recorded fresh, since business.yaml's fields, price line and the damage's description changed every request; load average about 2):

  | Mercury 3 on Inception's API, `instant`, realtime | valid JSON | values right | actions right | figure not in facts | ms p50 / p95 | with judge | bar |
  |---|---|---|---|---|---|---|---|
  | with the owner's sample replies | 100% | 86% (0 wrong, 10 missed) | 100% | 2 (1 "one" alone) | 526 / 1227 | 676 / 1377 | not met (values right) |

  As after call 44, the misses are values left out (0 wrong), each asked for by its field's question; the cases hold no consent turn.
- **Variance.** The same words read otherwise from one recording to the next on the opening turns: the dealer's day given or not, "on my Audi" taken once in three, the claimed account's day and window lost once live and once recorded. A scripted call's pass rests on one sample of each turn; the regression now replays one answer per request (call 35), so it is at least the same sample every time.

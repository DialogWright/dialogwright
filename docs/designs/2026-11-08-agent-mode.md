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
- Sending texts. The photo link and the owner's summary are printed and shown in the trace until texting is registered (10DLC). The tools are written so that sending is a setting.
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

`SPEECH_OVER_LINE` (2026-11-08) marks speech that started while a line the caller couldn't interrupt was still playing. Detection is unchanged. In agent mode, a miss is a turn whose answer proposes no value, no action, and answers nothing from the facts. Under `unless-miss` such a turn is set aside as in scripted mode: nothing said, nothing counted. The model is also told the words were heard over its own line, so its reading has the context.

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
    - **At a read-back** (its own no-handling; forms.yaml's `summary.onNo` does not apply in agent mode): a failed answer reads the read-back again, uncounted, and never completes, since a yes may carry a correction no one read; a changed value reads it again; the yes completes, whatever the answer proposed (a `callback` among them); a bare no asks `ask_change`, a second no reads the read-back again on its ladder; a question answered from the facts is an aside, the reply and then the read-back again as it stands, uncounted; any other words that are neither a yes nor a no ask the read-back again on its ladder, counted, the reply before it as an aside, so they reach the keypad and a person (the re-review of Task 6).
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

```text
business:
  name: Example Wheel Works
  says: "Example Wheel Works"
  kind: wheel repair and refinishing
  voice: >
    Friendly, plain and confident, like the owner at the counter. Short sentences. Glad to help,
    never pushy. Talks about wheels and nothing else.
  owner: Sam
  oneOwner: true            # the line never says "our team" or "our technicians"

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
  - Sam sees this kind of damage every day.
  - Diamond cut wheels are what the shop's lathe is for.
  - Curb rash on a diamond cut wheel is usually a same-day fix.     # assumption
  - Dealerships on Commerce Drive send their trade-ins here.
background:                   # context for the model, never said as a claim
  - Sam works alone, so he often can't answer the phone while he's working on a wheel.

prices:
  quote: from a photo         # no figures: the line never says a price
  say: >                      # fixed: said in these words when a caller asks about price
    Sam quotes every job from a photo, because it depends on the damage. I'll text you a link to
    send one, and he'll get back to you with a price and confirm your drop-off.

where:
  shop: inside the detailing shop at 400 Commerce Drive, Rivergate, across from the car dealership
  mobile: false               # assumption: Sam works at the shop
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

request:                      # what a retail caller's request collects; Sam confirms the window with the quote
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
      question: What's the best number for Sam to text you the quote?
  readBack: >
    Here's what I'll send Sam: {callerName}, a {vehicle}, {wheels} wheels, {damage}, hoping to drop
    it off {day} in the {window}, and he'll text you at {callbackNumber}. Is that right?
  then: [send_photo_link, notify_owner]
  done: >
    Thanks, {callerName}. Sam will text you a price and confirm your drop-off once he's seen the
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
  I'll have Sam call you back as soon as he's free. What's the best number to reach you?
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

**Chosen:** `instant`, realtime, with the owner's sample replies. They gave no reply with a figure the facts don't hold, against three without them. `AGENT_TIMEOUT_VOICE_MS` defaults to 1200 (p95 + 300, rounded) and `AGENT_TIMEOUT_CHAT_MS` to 3000.

What the measurement showed, for the tasks that follow:
- **OpenRouter no longer serves `inception/mercury-3`** (HTTP 404), so the agent's provider is Inception's API. The apps' wording moved to Inception too, on a branch of its own (`render-inception`).
- **Most action misses are `send_photo_link` proposed before the request is done.** That is harmless, since the action is gated, but Task 6 should decide when it may go.
- **The model reads values back in its reply** ("Let me read it back to you... Does that sound right?") and calls a window free when it has seen no availability ("Thursday morning works"). The engine says the read-back, so Task 7's judge and checks must refuse a reply that confirms values or availability the engine hasn't.
- **It sometimes computes a figure** ("That's seven wheels total"). The figure check refuses it.
- **One reply ended "...What's your name?values"**, a piece of the JSON shape leaking into the words. Task 7's checks should refuse a reply that names a field of the answer's shape.
- **Once, the model introduced itself as the owner** ("Hi, this is Sam at Example Wheel Works"). The judge (Task 7) must refuse the line speaking as a person it is not.
- **With no form chosen yet, the prompt lists no fields**, so a request said over the greeting can give no value. Task 6 sends the fields of the forms the caller may open, or opens one first.

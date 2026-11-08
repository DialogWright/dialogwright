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
  - Every value the model proposes is checked by its slot type against the caller's words.
  - Every action goes through the gate.
  - Every read-back that must be exact is said word for word.
  - Every reply passes the generated-wording checks and the drift judge.
  - Every turn is traced and every decision audited.
- **It works on the voice line and the chat page.**
- **Two demo calls.**
  - **A dealership regular**, recognized by the number they call from. They book three trade-ins for tomorrow, dropped off at the shop. The call is brief and efficient: they are booked straight in after an exact read-back.
  - **A retail caller** with curb rash on a BMW. They get a warm welcome, reassurance that most wheels can be fixed and that they are in the right place, and help telling whether the wheel is diamond cut. They are told the owner quotes from a photo and sent a link to send one. Their request is read back exactly and goes to the owner, who confirms a time when he sends the quote. The owner gets a summary of each request and booking at once.

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
- the lines that must be exact (the read-backs, the handoff, the closing);
- where requests and bookings go.

The prototype's file is in the appendix.

The engine reads `business.yaml` and builds the app in memory. That includes intents (book, request, a person, anything else), the forms and slots of the request and the booking, the policy, the prompts and the facts. So the rest of the engine (the gate, the audit, the console, records, channels) sees an ordinary app. An agent-mode app folder holds `app.yaml` (with `mode: agent`), `business.yaml`, `style.yaml` and `src/app.ts` for its tools. It needs no `intents.yaml`, `forms.yaml`, `prompts.yaml` or corpus. `pnpm check` checks the file against its schema and cross-links its tools to the code. The policy card, the policy matrix and the app map are generated from what the engine builds, as today.

### A turn

1. **Jev reads the turn as in scripted mode**, at the same time as the agent model's call, so it adds no latency:
   - the screen, side speech (`addressedToSystem`), frustration, a person asked for, language, and a yes or no where one is asked;
   - **the open fields' own questions**, as a scripted form asks every open slot's questions on any turn.

   Values come only from these readings, through each slot type's `fill`, exactly as today. A text field stores the caller's words, as the `text` slot does, never the model's tidied version. Where Jev sets the turn aside (side speech, a screen hit, words not made out), the agent's answer is dropped. Where Jev reads a request for a person or high frustration, the core acts as it does in scripted mode.
2. **The agent model** gets:
   - the facts it may use (from `business.yaml`);
   - the conversation so far, including its own replies and the exact lines said;
   - what each field holds;
   - who the caller is, where caller ID recognized them;
   - the channel;
   - whether the words were heard over a line still playing;
   - the checked results of the tools the app lets it see.

   It answers in a fixed JSON shape:
   - the reply to say;
   - the values it believes the caller gave this turn;
   - at most one proposed action (`submit`, `send_photo_link`, `callback`, or none);
   - whether the reply answers something from the facts.
3. **The engine checks the answer.**
   - The agent's values are compared with Jev's fills. Where they agree, or the agent named none, the reply may be said. Where the agent believes a value Jev did not fill, or a different one, the reply is not said: it might confirm something the engine does not hold. The next empty field's fixed question is asked instead, and the trace records the disagreement.
   - The reply passes the generated-wording checks:
     - no figure and no web address that the facts, the fields or a visible tool result don't hold;
     - its word budget;
     - one question at most;
     - style.yaml's `avoid`.
   - The drift judge holds the reply to the facts it may say (below). It catches a claim, a promise or a service the business doesn't offer.
   - A reply that fails is replaced by the fixed question of the next empty field. If none is empty, the read-back is said. The trace records why.
4. **The core takes over for what must be exact.** When every required field is filled, or the model proposes `submit`, the read-back is said word for word from `business.yaml`. Jev reads the yes or no, as a form's summary is read today. Only then does the action go to the gate.
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
- **Exact, said by the core word for word:** the read-backs, the `done` lines, the price line (`prices.say`), the handoff and the closing.

The drift judge's reference is what the model may say, plus the fields and the visible tool results.

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

The console's call view shows the agent's proposals beside Jev's readings. The policy card says the app is in agent mode, lists the exact lines, and says the conversation is sent to the agent model.

### Testing

- **A fake agent model**, scripted per scenario, for the engine's tests and the app's stub regression.
- **An agent cassette**, recorded with the author's key (never in CI), so the app's recorded regression replays real model answers.
- **Properties, not lines.** Scenarios hold the call to properties:
  - the request holds these values;
  - the booking was made, or was not;
  - no figure outside the facts;
  - no promise the judge refuses;
  - the read-back was said word for word.

  This is how the adversarial suite already works.
- **The adversarial suite runs on the app** (`testing.adversarial: on`), with a new family for agent mode: a caller who pushes for a price, a promise, a booking without a read-back, and instructions said to the model.

## The maintainer's decisions

Both were decided on 2026-11-08. Each is a named exception to CLAUDE.md's generated-wording rule, to be added to CLAUDE.md when agent mode is built.

1. **An agent-mode app sends its agent model the conversation.** That covers the caller's words and the model's own earlier replies, the exact lines included. Identity factors are never sent, and values the records hide stay masked. `pnpm check` refuses agent mode for an app with a slot that is an identity factor. A `text` slot's `redact: length-summarized` is refused in agent mode too, since the conversation would carry its words. The policy card says the conversation is sent to the agent model.
2. **The tools the app names may show the model their results.** Each result must pass its reply check in a closed form (dates, a list of times, yes or no, an amount), never free text. The policy card lists them.

## Calls made for the maintainer to check

1. **The model:** Mercury 3 (`inception/mercury-3` through OpenRouter, as the apps already use for wording), set in the app's style.yaml like today's render model. Its structured output and its speed with a whole conversation in the prompt are measured on the two demo calls before anything else is built. If either falls short, the bake-off picks another.
2. **Jev runs beside the agent model,** not before it, so its readings cost no time; its side-speech and screen readings can still drop the agent's answer.
3. **An app is in agent mode as a whole** (`app.yaml` `mode: agent`) in this prototype, not per form. A form in agent mode inside a scripted app is a later step once the whole-app mode works.
4. **The facts file is YAML** (`business.yaml`) with its own JSON Schema, like every app file, so the page a business fills in later writes the same file.
5. **The exact lines are the core's,** not the model's: the read-backs, the handoff and the closing come from `business.yaml` word for word.
6. **Values must be in the caller's words.** A proposed value is accepted only when the slot type accepts it from words the caller actually said.
7. **The prototype app is public and invented** (`apps/wheelshop`, "Example Wheel Works", invented dealerships, 555 numbers). A real business's line would be a private copy.
8. **The stand-in calendar** is a small in-memory schedule in the app's code (two bays, hour slots, weekdays). Texts are printed until texting is registered.
9. **Retail callers send a request, never a booking.** Regular accounts book. This is the app's policy, not the engine's.
10. **Values come from Jev's slot readings, never from the model.** The agent's values are only a cross-check, and a reply that disagrees with the fills is not said. This keeps "the decision model perceives through typed questions" true in agent mode, with no new slot-type contract.
11. **Fields map onto the library's slot types.**
    - The number of wheels is a `choice` (one to four).
    - The callback number is `digits`, offering the number the caller is calling from.
    - Diamond cut is a `choice` (yes, no, not sure).
    - The preferred time is `text`, since the library has no time-of-day slot and the owner confirms the time anyway.
    - The booking's day is `date`.

    No slot type is added.
12. **No live transfer:** a caller who wants a person leaves a callback note. The owner's summary is a fixed template, not a generated line.
13. **The service's `about` holds no turnaround figure.** A time per wheel would read as a promise. It belongs in `claims` once the owner approves one.
14. **A regular account is recognized by caller ID** through the existing caller-ID match (identity.yaml level 1 `callerId`). Caller ID stays an identifier, never a factor. The risk that a spoofed dealership number books trade-ins is the business's to accept, and the policy card states it.

## Left to the builder

- `business.yaml`'s exact schema and how it maps onto intents, forms, slots and policy;
- the agent's JSON shape and its prompt (the goal and full context, never a procedure for the words);
- where in `core/` the agent turn sits beside the scripted one;
- how the console shows proposals;
- the fixed fallback for a reply that fails;
- the measurement harness for Mercury 3.

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
    shopOnly: true
  - name: refinishing worn or faded finishes
notOffered:
  - cracked wheels
  - straightening bent wheels      # until the owner says otherwise
  - tyres, paint, headlights or anything that isn't a wheel

claims:                       # the only reassurance the line may give (the judge holds it here)
  - Most curb rash and scratches can be fixed.
  - Sam sees this kind of damage every day.
  - Diamond cut wheels are what the shop's lathe is for.
  - Dealerships on Commerce Drive send their trade-ins here.
background:                   # context for the model, never said as a claim
  - Sam works alone, so he often can't answer the phone while he's working on a wheel.

prices:
  quote: from a photo         # no figures: the line never says a price
  say: >                      # exact: said word for word when a caller asks about price
    Sam quotes every job from a photo, because it depends on the damage. I'll text you a link to
    send one, and he'll get back to you with a price and a time.

where:
  shop: inside the detailing shop at 400 Commerce Drive, Rivergate, across from the car dealership
  mobile: false               # Sam works at the shop; the line offers no mobile service
hours: null                   # not stated; the line says Sam will confirm a time

accounts:                     # regulars, booked straight in
  - name: Rivergate Motors
    numbers: ["+15555550142", "+15555550143"]
  - name: Northside Auto Sales
    numbers: ["+15555550150"]
  - name: Lakeview Imports
    numbers: ["+15555550161"]

request:                      # what a retail caller's request collects
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
      about: What the damage is, in the caller's words.
      question: What happened to the wheel?
    - name: diamondCut
      type: choice
      options: [yes, no, not sure]
      about: Whether the wheel's face is bright machined metal with fine lines.
      question: Is the face of the wheel shiny bare metal with fine lines, or painted all over?
      optional: true
    - name: preferredTime
      type: text
      question: When would you like to bring it in?
    - name: callbackNumber
      type: digits
      length: 10
      offer: callerNumber
      question: What's the best number for Sam to text you the quote?
  readBack: >
    Here's what I'll send Sam: {callerName}, a {vehicle}, {wheels} wheels, {damage}, hoping to bring
    it in {preferredTime}, and he'll text you at {callbackNumber}. Is that right?
  then: [send_photo_link, notify_owner]
  done: >
    Thanks, {callerName}. Sam will text you a price and a time once he's seen the photo.

booking:                      # what a regular account's booking collects
  for: accounts
  fields:
    - name: wheels
      type: choice
      options: [one, two, three, four]
      question: How many wheels?
    - name: vehicles
      type: text
      about: The cars, by make and model or stock number.
      question: Which cars are they?
    - name: day
      type: date
      question: What day are you dropping them off?
      sees: availability      # its free days near the one asked for reach the model (decision 2)
  readBack: >
    So that's {wheels} wheels on {vehicles} from {account}, dropped off at the shop {day}. Shall I
    book it?
  then: [book, notify_owner]
  done: You're booked for {day}. Thanks.

handoff: >                    # a callback note to the owner, not a transfer
  I'll have Sam call you back as soon as he's free. What's the best number to reach you?
closing: Thanks for calling Example Wheel Works.
owner:
  notify: text                # printed until texting is registered
  number: "+15555550100"
  summary: >                  # a fixed template, not a generated line
    New {kind} from {callerName} ({callbackNumber}): {wheels} wheels, {vehicle}, {damage}.
    Preferred time: {preferredTime}.
```

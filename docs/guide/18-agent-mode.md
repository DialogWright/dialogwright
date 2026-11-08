# 18. Agent mode

[Contents](README.md) · Previous: [17. Tuning with live calls](17-tuning-with-live-calls.md)

In a scripted app (every chapter before this one) the decision model reads the caller through typed questions, and the app's YAML says every line. In agent mode a model leads the conversation from the business's facts: it greets, reassures from the claims the business approved, asks for what a request needs in whatever order fits, and keeps the caller on the business's services. The engine still decides what is done. Every value the model understands is checked by its slot type and confirmed by the caller at a read-back said in the business's fixed words; every reply is held to the facts by checks and a judge, and replaced by a fixed line when one fails; every action goes through the gate; every turn is traced and every decision audited. The model proposes, the engine decides, and the model never calls a tool.

An app is in agent mode as a whole (app.yaml's `mode: agent`); a form in agent mode inside a scripted app is a later step. The design, with every choice its builder made and the measurement behind the defaults, is [designs/2026-11-08-agent-mode.md](../designs/2026-11-08-agent-mode.md). The example is [apps/wheelshop](../../apps/wheelshop/DESIGN.md), Example Wheel Works, a fictional one-man wheel repair shop, and the snippets here are from it.

## 18.1 When to choose it, and when not

Choose agent mode where the line should sound like a person at the counter and what it collects is small: a request any caller sends, a booking regular accounts make, a callback note. A business can be defined by one file of facts (`business.yaml`), with a little code for its tools, and no intents, slot wordings, corpus or prompts to write. "Tint will make that look sharp, let's get you booked" cannot sensibly be written as fixed lines; a model says it, and the engine holds it to the facts.

Keep an app scripted where:

- **Every line must be the app's own words** (a regulated disclosure, a script a reviewer signs off line by line). In agent mode the model words every reply that is not a fixed line.
- **Callers prove who they are by a factor** (a date of birth, an account number with a check). The conversation is sent to the agent model, so an agent-mode app collects no identity factor: `pnpm check` refuses a `birthdate` field, and the only identity is an account recognized by the number it calls from (18.7).
- **It needs what agent mode does not have yet:** more than one language (a `locale/` folder is refused), a knowledge base (a `kb/` folder is refused), routes (`routes.yaml` is refused), a start hook (`onStart`), more than the three forms below, or a slot type other than `choice`, `date`, `digits`, `name` and `text`.

Scripted mode is unchanged by any of this: an app whose app.yaml does not say `mode: agent` never meets it.

## 18.2 The folder

An agent-mode folder holds:

- `app.yaml`, with `mode: agent` (default `scripted`). The rest of app.yaml is as in a scripted app: the brand, `voice.hints`, `callerNumber.withheld`, `records`, `testing`, `fixtures`.
- `business.yaml`, the business's facts (18.3), with its schema line, `# yaml-language-server: $schema=../../packages/dialogwright/schemas/business.schema.json`.
- `style.yaml`, whose `agent` names the model that leads the conversation, and whose `words`, `avoid` and `judge.refuseAt` hold its replies as they hold a generated line ([16.4](16-generated-wording.md#164-styleyaml)).
- `src/app.ts`, the tools, joined by `defineApp` as in any app.
- `fixtures/`: the scripted calls, an optional corpus, the stub baseline and the cassettes (18.12).

```yaml
# app.yaml
id: wheelshop
locale: en-US
mode: agent
testing:
  adversarial: on
```

```yaml
# style.yaml
agent:
  provider: inception     # or openrouter
  model: mercury-3
  effort: instant         # instant, low, medium or high
words:
  voice: 30
```

style.yaml's `agent`: `provider`, `inception` (Inception's own API, key `INCEPTION_API_KEY`) or `openrouter` (any model OpenRouter serves, key `OPENROUTER_API_KEY`), default `inception`; `model`, the model id as the provider names it, default `mercury-3`; `effort`, how hard the model reasons before it answers (`reasoning_effort` on Inception; on OpenRouter `instant` sends no reasoning setting), default `instant`. On Inception the engine also asks for `realtime`. The key is read from the environment only, never from the file. The defaults are the measured choice: Mercury 3 at `instant` met the bar for a call, at `low` it did not (the design's "Measured"). `words` is the most words a reply may use on each channel (default 25 on a call, 40 in a chat); the wheelshop's 30 is the warm opening its owner wants, measured at 26 words. `words.answer` is the budget of a reply that answers from the facts (the model's `fromFacts`: what diamond cut is, how to tell), on either channel; default the channel's and half again (45 on a call at 30), so an explanation from the services fits where a longer reply would have been replaced by the next question. A `persona` in style.yaml is not read in agent mode: the persona is `business.voice`.

**What `pnpm check` refuses in an agent folder**, each with its fix:

- any of `intents.yaml`, `forms.yaml`, `prompts.yaml`, `policy.yaml`, `identity.yaml`, `routes.yaml` and `slots.yaml`: the engine builds them from `business.yaml`;
- a `locale/` or `kb/` folder; app.yaml's `callerNumber.lookup` (the engine looks the number calling up in `accounts` itself) and `onStart`;
- in the code, `facts`, `identity`, `customRules` and `lookups` (the engine writes them), any form hook or slot in code, a tool named `lookupAccount` or `recognizeAccount` (the engine's own), and a tool no form calls and no field sees;
- the other way round: a `business.yaml` in a folder whose app.yaml does not say `mode: agent`, and style.yaml's `agent` in a scripted app.

The engine builds the rest in memory, so the gate, the audit, the console, the records and the channels see an ordinary app: a form intent for each form; each field a library slot named `<form>_<field>`, asked by its question as the prompt `ask_<form>_<field>`; each form's read-back as its summary line (`readback_<form>`) and its done line (`done_<form>`); the price line (`price`); and a policy in which every tool a form calls is called with the form's values, each confirmed at the read-back. The policy card, the policy matrix and the app map are generated from what it builds, as for any app: after an edit to `business.yaml`, run `pnpm check`, then `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram` for the folder, and read each diff as a change in what the line may do and say ([3.10](03-policy-and-identity.md#310-testing-the-policy)).

## 18.3 business.yaml, key by key

Everything about the business the line may use. It is the business's own word, as prompts.yaml is: it is not the knowledge base, and the knowledge base's approvals do not apply to it. Its JSON Schema is `packages/dialogwright/schemas/business.schema.json`, generated from `define/schema/business.ts`, where each key's description is the reference.

**Who the business is.** `business`:

- `name` (required): the business's name.
- `says`: the name as the line says it. Default `name`.
- `voice` (required): how the line sounds, in the business's own words: the model's persona.
- `kind` (what kind of business it is), `owner` (the owner's name) and `oneOwner` (`true` where the business is one person, so the line never speaks of a team): sent to the model with the persona, so it knows whom it speaks for, that it is the line and never the owner, and, with `oneOwner`, that there is no team to speak of.
- `examples`: replies the owner wrote, sent to the model as examples of tone, never as rules or facts. Default none. Measured on the wheelshop: with them, no reply held a figure the facts do not; without them, three.

**What it does.** `services` (at least one): each a `name` and an optional `about`, in the business's words. `notOffered`: what it does not do, which the line may say it does not. `claims`: the reassurance the line may give, in the business's words; the only claims it makes, and the only place a turnaround or a promise may come from. `background`: context for the model only, never said as a claim ("Sam works alone, so he often can't answer the phone"). Each defaults to none.

**Prices.** `prices`: `quote`, how a price is given, for the model ("from a photo"; never a figure), and `say` (required where `prices` is), the price line, said word for word whenever the caller asks what something costs (18.4); `forms`, the forms in which the model may name it (default every form): with another form open the price line is not offered, and named there, neither it nor the reply is said, so a price line about one kind of work is never said in another (the wheelshop's is `[request]`: a dealership's booking is billed at the rates agreed with Sam, a claim). With no form open it is offered. Without `prices` the line has no price line, and a reply that words a price falls back on its figure.

**Where and when.** `where`: `place` (required where `where` is), where the business is, which the line may say; `mobile`, `true` where it also comes to the caller (default `false`, which the line may also say). `days`: the days of the week it works (`monday` to `sunday`), which the line may say; default none said. `windows`: the windows of the day something is dropped off or collected in, each a `name` (what a choice field with `options: windows` takes and the read-back says), `says` (what it is, in the business's words, which the line may say) and an optional `capacity` (for the app's own calendar; never said).

**Accounts.** `accounts`: the regular accounts, each a `name` (as the line and the booking's read-back say it, `{account}`) and the `numbers` it calls from, in E.164 (`"+15555550142"`). A call from one of them is recognized as that account (18.7). Needed by a booking, and refused without one; each number on one account only; a name a line can say (letters, spaces, hyphens and apostrophes, at most four words and 40 characters).

**The forms.** At least one of `request` (what any caller's request collects), `booking` (what a recognized account's booking collects; it adds `for: accounts`) and `callback` (a callback note from a caller who wants a person: there is no live transfer). Each form has:

- `about`: what the form is for, as the model is told. Default the form's name.
- `label`: the form in a few words, as the line names it ("send Sam a request"). Default the engine's words for the form.
- `fields` (at least one), in the order their questions are asked, each with:
  - `name`: the read-back's and done line's `{placeholder}`, the param of the same name in every call the form makes, and the name the model gives its value by. A field of one name in two forms has one type and one `redact`.
  - `type`: the library slot type its value is checked by: `choice`, `date`, `digits`, `name` or `text`. `birthdate` is refused (an identity factor's type, and the conversation is sent to the model), and so is a type that takes no value from outside its own fill (`record`, `reference`, `topic`).
  - `question`: said word for word whenever the line asks for the field in fixed words.
  - `about`: what the value is, for the model. Default none, the name alone.
  - `options`: a choice field's options, a list of the words each is said by, or `windows`, the business's windows by name. Only on a choice, which needs it.
  - `optional`: `true` lets the form be read back without it (default `false`). An optional field is never in a read-back, since it may be empty.
  - `length`: a digits field's number of digits (1 to 40; 10 for a phone number with its area code). Only on a digits field, which needs it.
  - `offer: callerNumber`: a digits field that may be the number the caller is calling from, offered as "Is the number you're calling from, ending in 0142, the best one to reach you?" ([a callback number](05-writing-a-slot.md#a-callback-number-callernumber)); `countryCode`, the calling code taken off the number calling (default `"1"`).
  - `sees`: a tool whose result the model may see once the field is filled (18.8).
  - `freeFrom`: a choice field whose value must be free, `<tool>.<list>`: a tool a field of the same form sees and the list of its result that names the free options (the wheelshop's `window`: `availability.windows`). Once the model has been shown that result for the form's day, a value not in the list is refused (`range`), the model having been asked again with what is free, so the line never takes, or promises, a full option (18.8). `pnpm check` refuses it on a field that is not a choice, from a tool no field of the form sees, or naming a list the tool's check does not name.
  - `redact`: how the value is masked wherever it leaves the turn: a digits field `last4` (its default), `length` or `none`; a text field `none` only (its default), since its value is read back as the line understood it. `length-summarized` is refused: the conversation would carry the words whole.
- `readBack` (required): the read-back, fixed words with each field's value as `{name}` (18.6). It must say every required field (and on a booking, `{account}`): the caller confirms nothing they never heard.
- `then` (required): the tools a yes at the read-back calls, in order, each through the gate, the first the form's write. Each is called with the form's values by field name (and on a booking, the account as `account`). A tool follows one form only, and is never also a tool a field sees.
- `done` (required): the line said once the form's tools have run, with the values as `{placeholders}`.

**The fixed lines.** `greeting`: the opening line. A string is the line a call opens on, and a chat opens on the chat default; `{ call, chat }` words each channel's own, one left out keeping its default. The defaults are "Thanks for calling `<says>`. How can I help?" on a call and "Hi, this is `<says>`. What can I help with?" in a chat (the `greeting` and `greeting_chat` prompts; neither names a `{placeholder}`, which `pnpm check` refuses). `handoff` (required): said when a caller asks for a person, a statement, never a question (`pnpm check` refuses a `?`), since it is said where nothing waits for an answer: a callback, not a transfer ("I'll have Sam call you back as soon as he's free."). Where the business has a `callback` form, every handoff says it and begins that form, which collects the number: a caller who asks for a person, and one handed off for frustration, too many attempts or a system's failure alike (each decided as in a scripted app). Only a handoff of the callback form itself (it fails too) ends the call with the line alone, and so does one for a downstream reply that failed its check (`result-unchecked`), whose record goes with it. A `callback` the model proposes is taken where the decision model reads the callback form's request too; checked with the caller ("Just to check, do you want to speak with someone?") where it reads some sign of a person asked for; not taken otherwise. `closing` (required): the closing line, read as `greeting` is: a string is the line a call ends on, and a chat ends on the chat default, "Thanks for chatting with `<says>`. Goodbye."; `{ call, chat }` words each channel's own, one left out keeping its default (on a call, "Thanks for calling `<says>`."). The call's closing is the one the agent model is told of (the `goodbye` and `goodbye_chat` prompts; neither names a `{placeholder}`). `lines`: the engine's own lines in the business's words, by id (`ask_intent`, `nomatch_open`, `no_input`, `ask_change`, `anything_else`, `ack_frustration`, `booking_for_accounts`, `identity_not_recognized`, each handoff line and both goodbyes, among others; `pnpm check` names the ids and refuses one that is not a line, or a `{placeholder}` the line is never given).

**Where requests go.** `owner`: `notify`, `text` (a text message; the wheelshop prints it until texting is registered) or `print`; `number`, the owner's number in E.164; `summary`, the owner's summary of each request and booking, a fixed template with the values as `{placeholders}` (a field, or `{kind}`, `{who}`, `{details}`), never a generated line. It is for the app's own tools, which read it with `loadBusiness`. `tools`: what each tool does, in a few words, by its name: the action's description on the policy card, the console and the audit (default the tool's name in words).

```yaml
# business.yaml (from apps/wheelshop, shortened)
request:
  about: a retail caller's request, sent to Sam, who quotes from a photo and confirms the drop-off window
  label: send Sam a request
  fields:
    - name: callerName
      type: name
      question: What's your name?
    - name: wheels
      type: choice
      options: [one, two, three, four]
      question: How many wheels need work?
    - name: day
      type: date
      question: What day would you like to drop it off?
      sees: availability
    - name: window
      type: choice
      options: windows
      question: Morning or afternoon?
    - name: callbackNumber
      type: digits
      length: 10
      offer: callerNumber
      question: What's the best number for Sam to text you the quote?
  readBack: >-
    Here's what I'll send Sam: {callerName}, ... on {wheels} of its wheels, hoping to drop it off
    {day} in the {window}, and he'll text you at {callbackNumber}. Is that right?
  then: [request, send_photo_link, notify_owner_request]
  done: Thanks, {callerName}. I'm texting you a link to send Sam a photo. ...
```

## 18.4 What the model may say

- **May say:** the `claims`, the services (their names and `about`), what is not offered, where the business is (and whether it is mobile), its days and its windows' `says`. The policy card counts them.
- **Context only, never claimed:** `background`, each form's `about` and each field's `about`.
- **Tone, never facts:** `business.examples`.
- **Fixed, said by the core in these words, never by the model:** the greeting, each field's question, each read-back's frame, each done line, the price line, the handoff, the closing and the engine's own lines.

The model is told its goal and the full context, never a procedure for the words: who it is, what it may say, the background, the fixed lines, the call (its channel, its language, today's date, the account the number calling recognized), the form open and what it has and still needs, what it may propose, the results it may see, and the conversation so far. It answers in a fixed JSON shape: the `reply`; the `values` it understood this turn, new ones and corrections, each with the caller's own `words` it came from; one `action` (`submit`, `callback` or `none`); `fromFacts`, whether the reply answers from the facts; and where the business has a price line, `fixedLine` (`price` or `none`). The fixed lines are sent with what each is for: the price line for a caller who asks what something costs, never to say what happens next or to sum up; the handoff for a caller who asks for a person; the closing for the end of the call. `submit` is described as for a form with nothing required left.

**The price line needs the decision model to agree.** Where the business has a price line, the decision model is asked on every agent turn whether the caller asks what something costs (`asksPrice`: a price, a fee, a quote, how much it is). The price line is said whole before the turn's own line, and the reply is not said (a price is never worded), where that reading is at `AGENT_PRICE_ASKED` (0.5) or above, whether or not the model named the line: the caller asked, and the line is the business's answer. Where the model names it and the reading is under the bar, the line is not said and the turn goes on as one that named none: the reply is held as any other (the checks and the judge, its fixed question in its place where it fails). A live chat's model named it on the turn the caller gave a callback number, as a "what happens next", and the whole line was said before the read-back with no price asked. `prices.forms` still holds: in a form it does not name, the line is never said, and one named there takes its reply with it.

**The conversation is sent to the agent model** (the maintainer's decision 1 in the design): the caller's words as they said them, a number they say included, the line's own replies and the fixed lines said, up to the last 40 utterances, each on one line. No identity factor is sent, since the app takes none. A value the records hide (a digits field by its last four) is sent masked where it is listed as collected, and in the history once the line has understood it. What the caller said, a value and a tool's result are escaped, so no words of theirs can open or close a section of the prompt. The policy card says all of this, so a reviewer sees what the model sees.

## 18.5 A turn

On each turn of the caller's words the agent model is asked beside the decision model, at once: the caller waits for the slower of the two, never the two in turn.

**The decision model** asks only its turn-level questions, as on every turn of any app (side speech, frustration, a person asked for, a repeat, the caller done, the language, the request the words make), where the business has a price line whether the caller asks what something costs (18.4), and at a pending confirmation the yes or no, since that decides an action; the injection screen reads the words as always. It asks no field's questions: the agent model understands the values. Where the decision model settles the turn on its own (side speech, a screen hit, a held partial, words not made out, a person asked for, high frustration, a repeat, the caller done), or the turn answers a question the core asked itself (the offer of the number calling, the offer of a person), the agent's answer is dropped, the trace says by what, and the turn is the scripted one. A turn that is not the caller's words (the call's start, a key, silence) is the core's, as in a scripted app.

**Which form opens.** With none open, the request the decision model read opens its form; failing that, the form whose fields the answer's values name most, among those the caller may open. A booking asked for by a caller not recognized says `booking_for_accounts` ("Bookings are for our account holders; I can send a request instead.", unless `lines` words it) and opens the request. With no form open, the model is sent the fields of the forms the caller may open, so a request said over the greeting gives its values at once.

**Each value is checked by its field's slot type,** deterministically ([digits](../slots/digits.md#checked-values), [text](../slots/text.md#checked-values) and each type's "Checked values"):

- the words cited must be in this turn's words, for every type;
- `choice`: one of its options (its key or its words, without regard to case and punctuation);
- `date`: a real ISO day in the slot's range, a day ahead held to the fill's own horizon;
- `digits`: only digits, of the field's length, and tied to its words: the words must read to a number that holds the value ("five five five" and "555-555-0142" both hold it);
- `name`: tied to its words: one the name fill itself would take from them;
- `text`: not empty, within its length. Its value is what the line understood, which may be the model's short version ("curb rash on the front right wheel"); the drift judge holds it to the caller's words, as a framed summary is ([16.3](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)).

A `choice` or `date` value is not tied to its words, since they may be a synonym or "Thursday": the read-back is its confirmation. A value that fails its check is dropped and counts an attempt on its slot, walking the slot's own ladder (its retry line, then the keypad or a person), as a scripted miss does. A value that names no field of the form is set aside.

**The reply is held to the facts,** once the core has decided what the turn does (`render/agentLine.ts`), with no model asked to word it: the checks of [16.6](16-generated-wording.md#166-the-checks-the-judge-and-the-fallback) by code, then the drift judge.

- **No figure and no web address** that the facts, a value held, the words a `digits` or `name` value was cited from, a result the model was shown or the turn's own fixed lines hold. The caller's own figures are no source: a figure the caller proposes ("is it under a hundred?") is not the line's to agree to. A `text` value is no source of its own, since it is the model's short version. The same check reads "one" as a figure, so "a lovely one" falls back too: a cost the maintainer accepted over a rule of grammar.
- **One question at most;** within style.yaml's word budget on the channel; none of its `avoid` phrases; on a call no markup or line break, in a chat no braces or angle brackets; and no key of the answer's own shape run into its words ("What's your name?values").
- **The drift judge** (the decision model, its cutoff style.yaml's `judge.refuseAt`, default 0.5) is given who speaks, to whom and where, the reply, what follows it, what the line may say, its background and fixed lines, every value understood (and whether the caller confirmed it), the results shown, the conversation so far and the caller's words, and asked whether the reply says anything the business has not given its line to say: a claim, a promise, a service or an availability not held, speaking as a person the line is not, a value or an availability confirmed that the engine has not confirmed, a figure or a promise the caller proposed.
- **A reply written from words the screen flagged** is never said.

A reply that fails is not said: the fixed line it stands for is (the next empty field's question, the open question, "What should I change?"), and for a reply said before the turn's own line, nothing. The audit records `render_fallback` with the check's name. No reply that could contradict what the core did is said: where a value was refused or named no field, the action was not taken, a form only for accounts said its line, or the form open is not the one the reply was written for, the fixed question is said alone. A reply that asks nothing is said before the next field's question.

**What the model may propose:** `submit` and `callback`, or nothing. `submit` with a required field empty is ignored; once every required field is filled the read-back is said whether or not the model proposed it. `callback` opens the callback form. A form's `then` tools are the engine's, called only by the yes at its read-back.

## 18.6 The read-back

When every required field is filled, the core says the form's read-back: the business's fixed words with each value as the line understood it, said as its slot type displays it (a date as "Thursday, November 12", a choice by its option's words, digits as the slot groups them). It is not the transcript. Only the frame's words are fixed; the values in it are what the caller is confirming.

- **A yes** (read by the decision model) completes the form: its `then` tools run through the gate, in order, then its done line. A yes completes whatever the model proposed.
- **A correction** ("no, it's four wheels", or "yes, but make it Saturday") is read by the model like any turn: the value is checked again, and the read-back is said again with it. A yes said with a change never completes: nothing is done until the caller confirms the read-back as it now stands. A refused correction walks its slot's ladder.
- **A bare no** asks `ask_change` ("What should I change?"); a second no reads the read-back again, on its ladder. A reply that asks nothing after "What should I change?" is said before the question, never in its place.
- **An aside.** A question answered from the facts ("do you do cracked ones?"), or the price line (a cost asked, named by the model or not), is said and then the read-back again as it stands, uncounted; only the first aside in a row is uncounted, so a caller who only asks still reaches the keypad and a person.
- **Words neither a yes nor a no** ask the read-back again on its ladder, counted, the reply before it as an aside.
- **A failed answer** (18.9) is read again the scripted way: the decision model is asked the form's own questions on the same turn (each field's, and the correction's), as an app with no key reads it, and the turn is decided from them: a plain yes completes, "yes, but make it three copies" corrects the value and says the read-back again, nothing filed. The asking counts in the turn's agent budget; with no reading in time, the read-back is said again, uncounted, and nothing completes, since a yes may carry a correction no one read. The trace keeps it as the turn's follow-up (`agent-failed`).

forms.yaml's `summary.onNo` does not apply: an agent-mode read-back has its own no-handling, above.

## 18.7 The gate, and recognition by caller ID

Every action goes through the gate, and every decision, allowed or refused, is audited, as in any app. What the engine builds from `business.yaml`:

- a request's and a callback's tools at level 0: any caller may send one, once they confirm its read-back;
- a booking's at level 1, with the account held to the caller's own (`scope`): only an account recognized by the number it calls from may book;
- a tool a field sees at the lowest level of the forms that ask the field;
- every param recorded as its field's slot records it, and every action with its `say`.

**Recognition by caller ID.** Level 1 is the existing caller-ID match ([`callerId`](03-policy-and-identity.md#a-caller-id-match-as-the-identifier-callerid)): the number calling is looked up in `accounts` at the call's start, and a match recognizes the account at once, with nothing asked or said; the greeting is as always. Only that match recognizes an account. The account is never asked: a caller who says "this is Rivergate Motors" from a number not on file is not recognized, may send a request, and where an action needs an account it is refused with a fixed line (`identity_not_recognized`), never a step-up question. Caller ID stays the identifier, never a factor. With app.yaml's `callerNumber.withheld: use` (the default) a number the caller withheld still recognizes the account it is on file for; `ignore` treats such a call as one with no number ([the number calling](02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber)).

**Voice only, in practice.** Recognition needs the number calling, and a chat carries none, so the booking is offered on a phone call only: a chat caller who asks to book hears `booking_for_accounts` and is begun on the request. The policy card says so.

**A forged number.** Caller ID can be forged. A caller who forges an account's number could book as that account (still only once they confirm the read-back). That risk is the business's to accept, and the policy card states it, action by action, so the owner reads what a forged number could do before the line goes live. A business that cannot accept it leaves out `booking` and `accounts` and takes requests only.

## 18.8 Tools the model sees

A field's `sees` names a tool whose result the model may see (the maintainer's decision 2): the wheelshop's `day` sees `availability`, so a full window is met with the next free one before the read-back ("Tomorrow's full, how about Thursday?"), not after it.

- **A closed check.** The tool must declare a reply `check` written with `replyShape` ([a tool's reply is not trusted](04-what-stays-in-typescript-and-why.md#a-tools-reply-is-not-trusted-check)) from closed forms only: `oneOf`, `digits`, `code` (up to 20 characters), `isoDate`, `amount`, `number`, `boolean`, and `nullable`, `list`, `object`, `all` and `any` of them. A check that uses `text()`, one written by hand, or none at all is refused at load and by `pnpm check`, naming where it is open. The model is shown only the fields the check names. The field itself must be recorded whole (`redact: none`), since its value and the result reach the model whole.
- **When it runs.** An accepted value that fills the field, with a value its result was not yet shown for, runs the tool through the gate with that value, as any tool (an async one waits). The agent is then asked again with the result, within what is left of the turn's budget, and the turn is decided again with that answer; no tool runs twice. Where no second answer comes, the turn is said as it first stood (its values, its fixed question or read-back), never the first reply, which was written without the result; that is no failure in the count of two.
- **What can go wrong.** A result that fails its check ends the turn with a person (`result-unchecked`), as for any tool, and is never shown. A tool that throws or replies late, or the gate refuses, shows nothing, and the turn goes on. The call keeps the latest eight results, one per tool, field and value, and later turns are sent them.

```ts
// src/app.ts (apps/wheelshop)
availability: {
  params: ['day'],
  run(call, sys) { /* the free windows on the day */ },
  check: replyShape.object({ day: replyShape.isoDate(), windows: replyShape.list(replyShape.oneOf(WINDOW_NAMES)) }),
},
```

The policy card lists each seen tool and the fields the model is shown of it.

A choice field that is `freeFrom` the result (`window: freeFrom: availability.windows`) is held to it: on the turn the day is given with a window, the model is asked again with the day's free windows, and a window its second answer gives that the result does not list is refused (`range`): the slot stays empty and its own question is asked again, never "Friday morning works". Given on a later turn, once the result is kept, it is refused at once. A booking that takes room in a window is so held to it; a request too, where the business says so (the wheelshop's do).

## 18.9 Budgets and fallbacks

| Choice | Where it is set | Default | What it does |
|---|---|---|---|
| How long the agent's answer may take | `AGENT_TIMEOUT_VOICE_MS`, `AGENT_TIMEOUT_CHAT_MS` (env), 300 to 15000 | `1800` on a call, `4000` in a chat | Past it, the turn's fallback. A second asking (18.8) shares it, counted from the first: a turn that asks twice took up to 1.75 s in the wheelshop recording, so the default on a call is the bar's p95. |
| How long the drift judge may take | `RENDER_CHECK_TIMEOUT_VOICE_MS`, `RENDER_CHECK_TIMEOUT_CHAT_MS` (env) | `500` on a call, `1000` in a chat | Past it, the reply's fixed line. The same budget as a generated line's checks. |

The voice default is the bar's p95, 1800 ms (the design's call 36): Mercury 3 on Inception's API at `instant`, realtime, with the owner's sample replies, answered one asking at a p50 of 482 ms and a p95 of 889 ms (682 and 1089 with the judge), within the bar for a call (half the turns within 1.0 s and 95 in 100 within 1.8 s, judge included); a turn that asks it twice, shown a seen tool's result, took up to 1.75 s in the wheelshop recording, which the first default (1200, a single asking's p95 and 300 ms) would have cut. Every option is in [14.12](14-running-it.md#1412-the-options).

**A failed answer** (past its budget, not in its shape, or an error) says the turn's fallback: the next empty field's fixed question, or at a read-back the turn read again the scripted way (18.6). An answer is capped at 400 tokens (`max_tokens`; 4000 where the model reasons), sized from the largest valid answer recorded (302) with a third more: one cut off at it is not in its shape at once, so a reply that runs on ("Goodbye. Goodbye. ...") costs no more than the cap. The trace says why (`agent.fallback`). The second failure in a row on a call hands it off: the handoff line, then the callback form where the business has one (above).

**No key.** A call that begins with no agent client (its key unset) runs as a scripted app for the whole call: the decision model asks each field's own questions and fills it, as in any scripted form, and the fixed questions, the read-back frames, the gate and the tools are the same; only the agent model is absent. A client missing on a later turn (a call resumed on a server without the key) runs the call scripted from that turn on. The server warns at start (`WARNING: agent mode: mercury-3 on inception (style.yaml's agent), but INCEPTION_API_KEY is unset: the app runs as a scripted app, ...`), and `pnpm diagnose` fails its `agent` line with the fix, since a business wants its agent ([14.5](14-running-it.md#145-diagnose)). With the key set, the startup line says the model, its effort and its budgets (`agent mode: mercury-3 on inception at instant, within 1800 ms on a call and 4000 ms in a chat, its judge 500 and 1000 ms`). `pnpm configure` asks for the agent model's key (`INCEPTION_API_KEY`, or `OPENROUTER_API_KEY` on OpenRouter) with the echo off, as it asks for every key, or takes it from its variable, and writes it to the app's settings file, never to a committed file; Enter leaves it unset.

## 18.10 Speech over a line

`SPEECH_OVER_LINE` ([13.16](13-channels.md#1316-speech-over-a-line-the-caller-cannot-interrupt)) works in agent mode as in a scripted app, with a miss read from the agent's answer: a turn heard over a line the caller could not interrupt whose answer understood nothing (no value accepted or refused, no action, nothing from the facts) is a miss, and under `unless-miss` (the default) it is set aside: nothing said, nothing counted. A turn that gives values is taken, so a request said over the greeting is acted on. The model is also told the words were heard while the line was still speaking, so its reading has the context.

## 18.11 Records and the console

The trace keeps, for each agent turn (`agent` on the turn's record):

- what the model was sent (`agent.sent`: the form, the fields with their values masked as sent, the actions it might propose, the conversation masked as sent, the turn's circumstances; not the facts and sample replies, which are the app's own);
- how long the answer took, and whether the turn used it, dropped it (and by what) or had none (and why);
- each value proposed with the words it cited and what its check made of it, masked as its slot's records mask it;
- the reply, said or not, and why not: the check that failed, or the judge's reading (its score and cutoff, kept whether it passed or refused);
- the action proposed and what became of it; the price line where it was said, and the decision model's reading of a price asked (`priceAsked`: its score, the bar, and whether the model named the line), which the console shows where the line was said or named and not said;
- a second asking, with the tools whose results were shown;
- the model's tokens and cost.

The console's call view shows under each line said what the agent understood, each value's outcome, the action, the reply said or replaced and why, and the judge's reading, beside the decision model's readings as for every app ([14.9](14-running-it.md#149-looking-at-calls-from-your-phone)). Insights counts the turns the agent was asked and those it answered, the answers missed, and the replies replaced, by why; the agent's cost is counted with the other models'. The policy card has an "Agent mode" section: the model, what the conversation sends it, what it may say, the tools it sees and the fields it is shown, every fixed line, and the forged-number risk.

## 18.12 Testing

The tests never call a model, and neither does CI.

- **Scripted calls name the agent's answers.** The stub regression has no agent model: each spoken step of a scripted call names the answer it gives (`agent`: its `reply`, `values` each with `field`, `value` and `words`, `action`, `fromFacts`, `fixedLine`, each optional, or `{ "fail": "timeout" }`, `"invalid"` or `"error"`), or a list of them, one per asking, where the turn asks again with a tool's result. A step the agent is asked on that names no answer, or names too few, fails the call, naming the step. A call may give `callerNumber` (an account's number, to be recognized), `todayIso`, and on a step `overLine: true` (heard over the line playing).
- **Properties, not lines.** A scripted call's `expect` holds, beside its end: `values` (the params of the last write a form made, by field, as the gate recorded them: a digits field by its last four, a name as the slot keeps it; a text value by the words it holds, `{ "has": ["Civic", "front two"] }`, since it is the model's own short version); `action` (a tool allowed, `"none"`, or `{ "not": "book" }`); `said: { notFigure: true }` (no reply said holds a figure the facts, the values understood or the results shown do not, read as the line's own check reads them); `said: { lines: ["booking_for_accounts"] }` (each line named was said on some turn); `levelHeld` (nothing ran above the level the caller had once greeted); `readBackSaid` (the read-back was said with the values the write carries); and `nothingDoneBefore: "confirm"`. Each that fails names its turn.

- **Answers by the question.** The order the model asks the fields in is its own, so a call whose middle turns would rest on it gives `answers`, keyed by the question the line says (a field's slot, `request_day`, or the prompt, `readback_request`, `offer_request_callbackNumber`), after its ordered `steps` (the opening, an aside): each turn answers the question the line just asked, a question asked again with the same words, a list in turn (a question, then the answer); a question with no answer fails the call, naming it. The call runs until the line asks nothing (`anything_else`, the call's end) or the `promptId` it expects. Each answer names the stub's `agent` answer as a step does.

```json
{
  "id": "dealer-trade-ins",
  "callerNumber": "+15555550142",
  "todayIso": "2026-11-10",
  "steps": [
    { "say": "I've got three trade-ins I want to get in tomorrow morning.",
      "agent": [
        { "reply": "Three for tomorrow morning, sure.", "values": [{ "field": "cars", "value": "three", "words": "three trade-ins" }, { "field": "day", "value": "2026-11-11", "words": "tomorrow" }, { "field": "window", "value": "morning", "words": "morning" }] },
        { "reply": "Tomorrow morning's open. Which cars are they, and which wheels?", "values": [...] }
      ] },
    ...
    { "say": "yes, book it", "agent": { "reply": "" } }
  ],
  "expect": { "action": "book", "values": { "account": "rivergate_motors", "cars": "three", "day": "2026-11-11", "window": "morning", ... }, "said": { "notFigure": true }, "readBackSaid": true, "nothingDoneBefore": "confirm" }
}
```

- **The corpus runs without the agent.** A corpus line is the decision model's alone: what it reads on every turn (the request at the opening, the yes or no at a read-back, the offer of the number calling, a price asked). The stubs read a corpus line's own labels only, so a line that asks what something costs says so for them with an answers override (`"answers": { "asksPrice": { "noul": 0.9 } }`); a scripted call's words not in the corpus are read by the heuristic stub, by keyword. It is read without the agent on the stubs and in a recording alike, so a line that answers a field hears the field's question again: the values are the agent's, in the scripted calls. `pnpm check` warns of a field's labels in an agent-mode app's corpus, since they are read only by the scripted path a call with no key takes.
- **The agent cassette.** `regress --client recorded` replays the decision model's cassette and the agent's, `fixtures/recorded/agent/<provider>__<model>[.settings].jsonl` (the wheelshop's is `inception__mercury-3.instant.realtime.jsonl`), named for style.yaml's `agent`. A turn the cassette has no answer for fails its call. `regress --client record` appends to it with the author's own key, and `--client jev` asks the model live; both are refused in CI.
- **The adversarial suite.** With `testing: { adversarial: on }`, an agent-mode app's suite is the `agent` family and the `hostile-reply` family ([15](15-the-adversarial-suite.md#151-turning-it-on)), run over the app's own scripted calls. The `agent` family's cases: `price-pushed`, `promise-asked`, `book-without-read-back`, `instructions-to-the-model`, `claimed-account` (a regular account claimed from a number not on file), and injections at a read-back, as a `text` field's value and on the callback form. Under the stub the agent answers as a fooled model would (the price given, the promise made, `submit` proposed at once, the instructions obeyed); under a recording or the model, the model answers. Each is held to `no-figure`, `no-promise` (every reply said passed the judge), `confirmed-first` (no form's tools ran but on the turn that confirmed its read-back) and `level-held` (no action above the level the caller had at the call's start). A case that fails is a finding to fix in the app or the engine, never a property loosened.
- **Choosing the model: `pnpm agent:bakeoff`.** Agent models compared on a cases file's calls (the facts, the owner's sample replies, the forms, and each caller turn labelled with the values and action it should give): valid JSON, values right, actions right, replies with a figure not in the facts (and those whose only such figure is "one"), latency p50 and p95 (with the judge's time added by `--judge-ms`), against the bar, and cost. Each model's answers are recorded into a cassette beside the cases with the author's own keys (refused in CI); `--replay` tables the cassettes with no key. `--examples on|off|both` measures the prompt with and without the owner's sample replies (default both); `--repeat N` asks each turn N times; `--print-prompt` prints what one turn sends and asks nothing. `pnpm agent:bakeoff --help` lists every option.

```sh
pnpm agent:bakeoff --cases apps/wheelshop/fixtures/agent/cases.yaml --models inception:mercury-3:instant:realtime --repeat 3 --judge-ms 200 --replay
```

`--models` takes `inception:<model>[:<effort>][:realtime]` (`INCEPTION_API_KEY`) or `openrouter:<vendor/model>[:<thinking>][:<effort>]` (`OPENROUTER_API_KEY`), comma-separated. Change the default model or effort only on a bake-off's table, and the cassette with it.

## 18.13 The demo's assumptions, and correcting them

The wheelshop is a working demo for a real one-man shop's owner to hear, so it needs answers only the owner can give. As with a real client, `business.yaml` makes a reasonable assumption for each and marks it `# assumption: the owner corrects these`: a same-day turnaround for curb rash on a diamond cut wheel (`claims`), two drop-off windows of three cars each (`windows`), Monday to Friday (`days`), no mobile service (`where.mobile`), no cracked wheels or straightening (`notOffered`), every retail job quoted from a photo with the window confirmed with the quote (`prices`, `request`), dealerships booked straight in (`booking`), and a text summary of every request and booking (`owner`). The table, with how the owner corrects each, is in [its DESIGN.md](../../apps/wheelshop/DESIGN.md#the-demos-assumptions-for-the-owner-to-correct).

The demo is up front that these are assumptions: when the owner hears something that is not how he works, that is the prompt for him to say how he does, or to leave it out. Each is one entry in `business.yaml`, so a correction is an edit to the file, never to code: the tools read the windows, their capacity, the days, the accounts and the owner's summary from it (`loadBusiness`). A claim is the only place a turnaround may come from, so deleting the claim removes the turnaround from the line. After any correction, `pnpm check`, then the policy matrix, the policy card and the app map written again and each diff read as a change in what the line may do and say, committed with the file.

A real business's line is a private copy of such a folder, with its own facts, accounts and numbers.

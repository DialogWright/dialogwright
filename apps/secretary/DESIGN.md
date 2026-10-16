# Example Front Desk: design worksheet

Built with the create-app skill (`.claude/skills/create-app/`) by an AI coding assistant (Claude Opus 5.5) on 2026-10-13, from the paragraph below. The business name, "Example Front Desk", was given with the paragraph. Revised on 2026-10-14, once the framework covered what the first build found (Gaps): the paragraph's "in short" restored with a frame for the exact words (`exactText`), and the message kept out of every record (`redact: length-summarized`). Revised again on 2026-10-16, at the maintainer's word (below): a caller asking about a person hears that person's status and is offered what fits it ("Is someone in, and what fits their status", below).

## The paragraph

> Example Front Desk answers the phone for a small design studio when no one can pick up. Callers can leave a message for one of three people: Riley Moreno, Sam Okafor or Jordan Lee, or for "anyone" if they don't mind who. The desk takes the caller's name, a number to call back (offering the number they're calling from), and the message itself, in their own words. Before saying goodbye it reads the message back the way a good receptionist would, briefly: "Thanks, I'll make sure Riley gets your message: Alex Rivera called and said, in short, the logo files are ready for review." Only the summary of what the caller said is worded by the model; the rest of that sentence is fixed, and if the caller says that's not right, it reads back their exact words instead and lets them say it again. Every other line is said word for word. A caller who says it's urgent, or asks for a person, is transferred to the studio's main line. Callers can also ask for the studio's hours (weekdays nine to five) and its address (an invented street). Nobody needs to verify who they are; the desk never says anything about the people's schedules or whereabouts.

The last clause is superseded by the maintainer's revision of 2026-10-16:

> I like the idea where Sam has set his status to out of office or in training or something like that, or maybe he is available and the offer is to leave him a message or transfer.

So a caller who asks about Riley, Sam or Jordan (whether they are in, or to talk to one of them) hears the status that person set in the studio's calendar, in a fixed line per status, and is offered what fits it: someone available, to be put through to their own line or to leave a message; anyone else, a message.

## Intents

| Intent id | Kind (form, informational, control) | What the caller wants | Example phrasings (five or more, terse ones included) |
|---|---|---|---|
| `take_message` | form | leave a message for Riley, Sam, Jordan or anyone | "I'd like to leave a message", "message", "can I leave a message for Riley", "a message for Sam please", "leave word with Jordan", "message for anyone, I don't mind who", "tell Riley the logo files are ready for review"; a quote, a meeting or a price, which only the studio's people can give ("can I get a quote for a website", "can you book me a meeting with Riley"); "yes please" right after the line offers to take a message |
| `urgent` | form (priority, no slots: straight to a person) | reach the studio now | "it's urgent", "urgent", "this is an emergency, I need to reach someone now", "it can't wait, I need someone right now", "the print shop needs sign-off within the hour, it's urgent" |
| `studio_hours` | informational | the hours | "what are your hours", "hours", "when are you open", "what time do you close", "which days do you work" |
| `studio_address` | informational | the address | "what's your address", "address", "where are you located", "how do I find the studio", "what street are you on" |
| `whereabouts` | form (since 2026-10-16; was informational) | whether someone is in, where they are, their schedule, or to talk to one of them by name: their status, then an offer | "is Riley in today", "when will Sam be back", "is Jordan on holiday", "where is Riley", "is Sam available", "can I talk to Sam", "could you put me through to Riley", "I'd like to speak with Jordan Lee please", "is anyone in the office", "is someone in today" |
| `agent` | control | a person, at any time, without naming one of the three | "can I talk to a person", "operator", "representative", "a person", "put me through to someone please" |
| `repeat_prompt` | control | hear it again (word for word) | "can you repeat that", "pardon", "say that again", "can you read that back word for word", "read me the whole message" |
| `done` | control | finished | "that's all I needed, thanks", "goodbye", "no, I'm good", "that's it, bye", "no thanks" |
| `other`, `none` | control | anything else; no request | "do you sell gift cards", "do you repair laptops", "I'm calling to sell you advertising space"; "hello", "um" |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Keypad? | Sensitive? |
|---|---|---|---|---|---|
| `take_message` | who the message is for | `recipient` | `choice`: riley, sam, jordan, anyone ("the team") | no (keypad on the menu only) | no |
| `take_message` | the caller's name | `caller` | `name` | no | kept as given in the trace's slot state, on the console, in the read-back and in the handoff data; the action's param recorded by its length in the audit |
| `take_message` | a number to call back | `phone` | `digits`: length 10, `callerNumber` (offers the number calling) | yes | by its last four (the type's default) |
| `take_message` | the message, in the caller's words | `message` | `text`: `say: null`, `redact: length-summarized`, maxLength 500 | no | by its length in every record; sent whole to the render model only for the read-back's span (see "What is recorded") |
| `urgent` | nothing | | | | |
| `whereabouts` | who the caller asks about | `recipient` (the message's own slot, so a message that follows keeps the person) | `choice`, as above | no | no |
| `reach_person` (internal) | someone available: put through, a message, or neither | `reachHow` | `choice`: through, message, neither | yes (1, 2, 3, after two misses) | no |
| `offer_message` (internal) | anyone else: a message? | `leaveMessage` | `choice`: leave, decline | yes (1, 2, after two misses) | no |

## Decisions

| # | Question | Answer, and the option it leads to |
|---|---|---|
| 1 | Does any answer rule the caller out before the rest is collected? | No. |
| 2 | Does an answer end the call or turn the caller away? | No. The read-back is the one confirmation. |
| 3 | Do callers reach the same booking by different roads? | No: one form. |
| 4 | Do callers give details for a later step in their first sentence? | Yes: "a message for Sam", "this is Alex Rivera, can you take a message for Jordan", and the whole message in one breath. Every slot is in the one form the request opens, so the opener fills them (the default `listen`). |
| 5 | Who must prove who they are? | Nobody ("Nobody needs to verify who they are"). No identity.yaml; the action is level 0. |
| 5b | Does the caller act on something of theirs? | No. |
| 6 | Will callers phone from the number on their account? | No accounts. |
| 7 | Look the caller up by number? | No. |
| 8 | Does a form take a callback number? | Yes: `phone`, a `digits` slot with `callerNumber` (a required offer: `onNo: ask`, `ifNone: ask`, the defaults), `offer_phone` ("Is the number you're calling from, ending in {last4}, the best one to call you back on?"), and the read-back says `{phone}` whole ([A callback number](../../.claude/skills/create-app/patterns.md#a-callback-number-callernumber)). |
| 9 | Will the line text the caller? | No. |
| 10 | Text at more than one moment? | No. |
| 10b | Does call data come with the call? | No. |
| 11 | Something that must never wait? | Yes: "A caller who says it's urgent ... is transferred". `urgent`, a form with no slots, `priority: { correctsForm: true }`, its `complete` hook handing off with the reason `urgent` (`handoff_urgent`) ([Something that must never wait](../../.claude/skills/create-app/patterns.md#something-that-must-never-wait)). |
| 12 | What should the person taking a transfer see? | `handoff.data.unconfirmed: mark` (the default for a new app), every slot (the default `slots: all`; the callback number by its last four, as recorded; the message by its length, as `length-summarized` hands it over whatever `handoff.data` says). |
| 13 | Half-understood callers, corrections at the read-back, silence after "anything else?" | The paragraph is silent: the defaults. |
| 13e | A message said in two breaths, with a pause | The paragraph is silent; a message is the long answer on this line. `voice.continueWithinMs: 900` (default 300): a caller who talks over the read-back within 900 ms is taken as still talking, and the two parts are joined. `maxLength: 500` (the text type's default). A known limit: see "Known limits". |
| 13b | Nice-to-have details; a caller who cannot answer | Every detail is needed for the message: the engine's ladder (three tries, then the main line). |
| 13c | Anything before the request, after identity or after a form? | Before the request and after identity, nothing: the paragraph names the studio's hours as an answer, not as a rule for the line ("when no one can pick up" is any time the line rings). After a form, since 2026-10-16: routes.yaml's `afterForm` decides what follows a status (`whereabouts`: `{ fact: presence, is: available }` to `reach_person`, else `offer_message`) and what follows each offer (a message to `take_message`, the person kept; else "No problem." and "anything else?"). |
| 13d | More than one language? | No. |
| 14 | The phone line itself? | Nothing. |
| A | Generated wording (the skill's rule: only where the paragraph asks) | The read-back's summary only: a framed line ([A framed line](../../.claude/skills/create-app/patterns.md#summarizing-what-the-caller-said-a-framed-line-generate)). `confirm_take_message` with `generate: { summary: { from: message, goal, words: 20, speaks: to-caller, names: [recipient] } }`, `summarizesConfirmed: true`, `when: { situations: [first-ask] }`, its `text` saying "gets your message, in short: {summary}" and its `exactText` "gets your message, as you said it: {summary}", the caller's name and number in a sentence of their own; the form's `summary: { onNo: read-back }` with `read_back_exact`. No `wording: generative` and no `mode: generative` anywhere. |
| A2 | The caller's words in the records | Kept out, deliberately: the message slot is `redact: length-summarized` (guide 16.3, 16.5), the app's demo of that setting. The words are kept in the session for the call and sent whole to the render model only for the span; every caller's words, on every turn, are kept by their length in the trace, on the console and in the frame log (no frame-log replay; `kb:gaps` finds no caller questions); the audit and a handoff get the message by its length. |
| B | Where a transfer goes | "transferred to the studio's main line": app.yaml's `transfer: { default: env.STUDIO_MAIN_LINE }`, every handoff (urgent, a person, max attempts) to the one line ([Where a transfer goes](../../.claude/skills/create-app/patterns.md#where-a-transfer-goes-and-what-goes-with-it-transfer)). Since 2026-10-16 one exception: a caller put through to someone available (the reason `put-through`) goes to that person's own line, a target per person, `when: [{ reason: put-through }, { slot: recipient, is: <person> }]` to `env.RILEY_LINE`, `env.SAM_LINE`, `env.JORDAN_LINE`. Each variable is in `.env.example` with a 555 number. |
| C | Schedules and whereabouts | Was: "the desk never says anything about the people's schedules or whereabouts" (a fixed refusal, `no_whereabouts`). Since 2026-10-16, the maintainer's revision: the status each person set in the studio's calendar is read by a tool (`personStatus`, through the gate, level 0, held by `oneOf` to the three people) and said in a fixed line per status, chosen by the code from the tool's checked reply (`status_available`, `status_out_of_office` with the day an out-of-office note gives, `status_out_of_office_no_day`, `status_in_training`, `status_in_a_meeting`). A model never words or guesses a status: the decision model only picks whom the caller asks about. The span is still worded from the caller's own words only, so it cannot carry anything the studio knows. What the line says of a person is their status today and, out of the office, the day they are back: no place, no reason, no schedule. |

## Actions

| Tool | Reads | Writes | Params (exactly what it sends: `params` in code) | Level | Rules, in order |
|---|---|---|---|---|---|
| `leaveMessage` | nothing | a message in the studio's inbox (a stub, in memory), idempotent by `ctx.idempotencyKey` | `recipient, caller, phone, message` | 0 | `identity`, `confirmed: [recipient, caller, phone, message]` |
| `personStatus` | one person's status today, from the studio's calendar (a stub, `src/data.ts`) | nothing | `person` | 0 | `identity`, `oneOf: { field: person, values: [riley, sam, jordan], reason: not-on-the-calendar }` |

`leaveMessage`'s reply is `{ ref }`, checked with `replyShape.object({ ref: replyShape.code() })`: no line says it, but the audit records it with the write. `personStatus`'s reply is `{ status, back }`, checked in its closed forms, `replyShape.object({ status: replyShape.oneOf(STATUSES), back: replyShape.nullable(replyShape.oneOf(WEEKDAYS)) })`: the status picks the line and the day is said in it. It is called fail-soft (`ctx.callTool(call, { failSoft: true })`): a refusal, a tool that throws or a reply that fails its check is no status, and the caller hears "I can't check whether {recipient} is in right now." and the offer of a message, not a person (the adversarial suite's `hostile-reply/personStatus` cases hold on it).

## What is recorded

| Param | Slot, with its redact setting (or "not a slot") | Recorded as (`audit`, or the slot's) | Why |
|---|---|---|---|
| `recipient` | `recipient`: a choice, no redact | `keep` | one of four keys |
| `caller` | `caller`: a name, no redact | `length` | a person's name, in their own words |
| `phone` | `phone`: digits, `last4` | the slot's | an identifier |
| `message` | `message`: text, `length-summarized` | the slot's (by its length; no `audit` line, which `pnpm check` would refuse as a duplicate) | the caller's own words: the inbox gets them, the records do not |
| `person` (`personStatus`) | not a slot (the code sends the `recipient` slot's value) | `keep` | one of three keys |

In short, the records keep every turn's words and the message by their length; the caller's name as given (the `caller` slot has no redact: it is whole in the trace's slot state, on the console, in the read-back's values and in the handoff data; only the action's param is by its length, in the audit), the number by its last four.

What `length-summarized` costs, accepted: no caller's words are in the trace, the console or the frame log, on any turn (the message may come on any), so a call cannot be replayed from its frame log and `kb:gaps` finds no caller questions; the person on the main line gets the message by its length from a transfer. The words go whole to the render model (and to the decision model's checks of the span) only to summarize them; the policy card says so.

## Who may do what

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate |
|---|---|---|---|---|
| `leaveMessage` | allowed, with exactly the values read back and confirmed | (none: no subjects) | (none) | (none) |
| `personStatus` | allowed for `riley`, `sam` or `jordan`; refused for anything else (`not-on-the-calendar`) and for no value | (none) | (none) | (none) |

### The policy read back (2026-10-16)

`pnpm policy:matrix`, `policy:card` and `app:diagram` were run again after the status was added, and each diff read as a change in what the agent may do:

- **`policy.matrix`**: one new action, nothing else changed. `personStatus · level 0 · identity, oneOf(person: riley, sam, jordan)`: for every kind of caller (anonymous, either subject level, the unlisted role, the roleless party, the other party), a call for one of the three people (`params aPerson`, Sam) is `ALLOW`, a call for the team (`params theTeam`, `anyone`) is `BLOCK not-on-the-calendar`, and a call with no person is `BLOCK value-missing`. So the agent may now read a status, for anyone who calls, verified or not, but only one of the three people's, and nothing it reads is written anywhere. `leaveMessage`'s rows are unchanged. The test's policy matrix names the two calls (`calls.personStatus`).
- **`POLICY.md`**: policy.yaml's hash; the new action's row ("Read whether Riley, Sam or Jordan is in, from the studio's calendar": any caller may ask; the person must be one of `riley`, `sam` or `jordan`, any other refused `not-on-the-calendar`, a missing value refused), its line in the diagram by level, the record of its one param (`person`, "as it is"), and the new prescribed line `handoff_put_through`. "Lines a model words" is unchanged: the read-back's span is still the only generated part, and no status line is generated.
- **`APP-MAP.md`**: `whereabouts` is a form (was an informational answer drawn to `no_whereabouts`), asking `recipient` and calling `personStatus` with its two rules; the two internal forms after it, `reach_person` and `offer_message`, each "after a route"; the routes after each of the three forms; and the transfer targets, `RILEY_LINE`, `SAM_LINE` and `JORDAN_LINE` on `put-through` and the person, before the default `STUDIO_MAIN_LINE`. `reach_person`'s own handoff is drawn as "its complete hook decides what follows, in code" (Gaps).

In short: a caller may now learn one of the three people's status today and, if they are available, be put through to their own line. The message, its confirmation and what is recorded of it are as they were.

## Verification (identity.yaml)

None: the app verifies no one.

## Confirmed writes

| Action | Read back as (the summary line) | Values the caller confirms |
|---|---|---|
| `leaveMessage` | "Thanks! I'll make sure {recipient} gets your message, in short: {summary}. I have you as {caller}, on {phone}. Shall I pass it on?" ({summary} generated the first time, from `message`, spoken to the caller); with the exact words, "I'll make sure {recipient} gets your message, as you said it: {summary}. I have you as {caller}, on {phone}. Shall I pass it on?" (`exactText`) | `recipient, caller, phone, message` |

The app's one list of confirmed fields: `recipient, caller, phone, message`.

## Bounds

None.

## Informational answers

| Intent | The fixed line |
|---|---|
| `studio_hours` | "The studio is open weekdays, nine to five." |
| `studio_address` | "The studio is at 418 Juniper Lane, Suite 2, in Example City." |

`whereabouts` is no longer an informational answer (since 2026-10-16): it is a form whose answer is a status line, below.

## Is someone in, and what fits their status (2026-10-16)

| Status (the calendar's) | The fixed line, chosen by code | Then (routes.yaml) |
|---|---|---|
| `available` | "{recipient} is available." | `reach_person`: "Now, let's put you through or take a message. Which would you like?" Put through: "One moment while I put you through." to that person's own line (`put-through`); a message: the message form, the person kept ("Now, let's leave a message. And who's calling, please?"); neither: "No problem. Is there anything else I can help with?" |
| `out_of_office`, with a day | "{recipient} is out of the office until {back}." | `offer_message`: "Now, let's see about a message. Would you like to leave one?" Yes: the message form, the person kept; no: "No problem. Is there anything else I can help with?" |
| `out_of_office`, no day | "{recipient} is out of the office." | the same |
| `in_training` | "{recipient} is in training today." | the same |
| `in_a_meeting` | "{recipient} is in a meeting right now." | the same |
| the team (anyone): no calendar, no call | "I can only check on Riley, Sam or Jordan by name." | the same (a message for the team) |
| no status (refused, failed, or a reply that fails its check) | "I can't check whether {recipient} is in right now." | the same |

The fixture calendar (`src/data.ts`): Riley available, Sam out of the office until Monday, Jordan in training. `in_a_meeting` and an out-of-office note with no day are in no one's calendar today; `src/app.test.ts` holds their lines.

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time but at the message's own question | `live-agent` | `handoff_live_agent` |
| The caller says it is urgent, at any time but at the message's own question (a priority intent) | `urgent` | `handoff_urgent` |
| A detail not given after three tries | `max-attempts` | `handoff_max_attempts` |
| The inbox's reply fails its check | `result-unchecked` | `handoff_result_unchecked` ("I couldn't confirm your message was passed on, so let me put you through to the studio's main line.") |
| Someone available, and the caller asks to be put through (by voice, or 1 on the keypad) | `put-through` | `handoff_put_through` ("One moment while I put you through."), prescribed |
| An offer after a status not answered after three tries | `max-attempts` | `handoff_max_attempts` |

All go to `STUDIO_MAIN_LINE` (app.yaml's `transfer.default`), but `put-through`, which goes to the person's own line (`RILEY_LINE`, `SAM_LINE`, `JORDAN_LINE`). A status read never goes to a person: it is fail-soft (above), so `handoff_result_unchecked` keeps its message wording.

At "Go ahead with your message." the turn is the message, whole (the engine's default for a `text` slot without `pick`, `commands: ignore`; live findings item 29, the maintainer's decision of 2026-10-14, which this app follows): "hold on, it's really urgent, the website is down" or "can I just talk to a real person" said there is read back as the message, and a no lets the caller say it again or ask for someone. `commands: { listen: [urgent, agent] }` on the message slot would put those through instead; the owner chose the default, written out in slots.yaml (`commands: ignore`), since `pnpm check` warns of a text slot that says nothing there in an app with a priority intent.

## Choices the paragraph left open

- **The frame's words, and whom the summary speaks to** (decided 2026-10-14, after recording 1). The paragraph's example is "Thanks, I'll make sure Riley gets your message: Alex Rivera called and said, in short, the logo files are ready for review." The first frame followed it, the summary in the caller's own terms after "{caller} called and said, in short,". Recording 1 showed what a receptionist (and the render model) does instead: it reads the message back to the caller, "I" said as "you", and 19 of 27 spans fell back for `person` (a "you" the caller's words did not have). The maintainer's example: "the project is complete and I just need him to give his approval", for Sam, read back as "you need Sam's approval". So the span speaks to the caller (`speaks: to-caller`, guide 16.3), with `names: [recipient]` so a pronoun that clearly means the recipient may be said by name, and the frame speaks to them too: `text` "Thanks! I'll make sure {recipient} gets your message, in short: {summary}. I have you as {caller}, on {phone}. Shall I pass it on?", said only with a generated summary; `exactText` "I'll make sure {recipient} gets your message, as you said it: {summary}. ...", said whenever the span is the caller's exact words, in their own first person (no model, a fallback, after a no, a repeat, a later reading), where "in short" would not be true. "{caller} called and said" is gone from before the summary: in the second person it reads wrong ("Alex Rivera called and said, in short, you need Sam's approval"), and `pnpm check` warns of it. The paragraph's "Thanks", "make sure {recipient} gets your message" and "in short" are kept. The caller's name and the callback number are read back in a sentence of their own, since the read-back is where the caller hears the whole number the offer named by its last four, and "Shall I pass it on?" makes the read-back the confirmation.
- **"the team"** is how the line names "anyone" ("I'll make sure the team gets your message"); its inbox is a shared one.
- **The call ends after a message** (`{ kind: 'end' }` on `message_taken`, then "Goodbye."), as the paragraph says ("Before saying goodbye it reads the message back"). A second message for another person is a second call.
- **"Lets them say it again"**: a bare no reads the exact words back and asks again; "no, let me say it again" (a no naming the message) asks for the message again; a second bare no asks `ask_change`, worded to say both ("You can give me the message again, or ask me to read it back.").
- **The span's word budget** is 30 (the default is 25). It was 20 ("briefly"), but recording 2 refused a faithful 22-word summary of the longest message (`ms-04`, 26 words) for `words`. A summary never needs more words than the message it gives back, and the longest messages in the corpus are 26 and 28 words (`ms-04`, `tm-08`), so 30 lets any faithful summary of them through; a longer message (up to the slot's 500 characters) still has to be summarized into 30 words or is read back exact. The style's persona is "a warm, brief receptionist at a small design studio".
- **The summary only the first time** (`when: { situations: [first-ask] }`): every later reading is the exact words, so a caller who has heard the gist and said no is never given another paraphrase.
- **Prescribed lines**: the handoff lines and `message_taken` are `prescribed: true` (the skill's rule where the paragraph does not say what is regulated). No other line is generated anyway; marking them keeps them fixed if a form is ever switched to generated wording.
- **A message that mentions a deadline** is still a message; a caller who says the matter is urgent is `urgent` (the criteria say so). Whether the real model draws that line well is for the recording to show.
- **The whereabouts refusal** (until 2026-10-16) was an informational intent rather than leaving such a question to `other`, so the line said plainly that it would not say, and offered a message. Superseded by the status and its offer (above).
- **The hours are an answer, not a route**: the line takes messages at any hour (no `hours` in app.yaml).
- **The address**: "418 Juniper Lane, Suite 2, in Example City", invented.
- **The keypad menu**: 1 a message, 2 the hours, 3 the address, 0 the main line (`fromGreeting` not set: the menu is offered after two misses, the default).
- **The adversarial suite** is on, as the scaffold sets it.
- **Urgent's own bar, `URGENT_SURE: 0.4`** (app.yaml's `thresholds`, intents.yaml's `priority.threshold`; the engine's bar for a priority intent is 0.8). Missing an urgent caller costs more than putting through one who did not need it: both reach the studio's main line. Chosen on recording 2, where "wait, it's for Sam, and it's urgent" at the read-back read urgent 0.43 against take_message 0.50 and the urgency was lost; checked on that recording, it changed no other line.
- **The span's checks are the engine's data and shape checks, and the drift judge for its meaning** (since generated wording made simple, 2026-10-14: the check levels and the grammar checks are gone): code holds the span to its values, its word budget, one sentence and no four words of its own sentence copied, and the drift judge, given the span heard in its sentence, decides whether it is faithful (a clause with a "no" or a condition left out, who does what to whom), refusing at style.yaml's `judge.refuseAt` (0.5, the default).
- **"Yes please" after the whereabouts line** (until 2026-10-16: "... happy to take a message for them. How can I help you today?") was a request for a message: `take_message`'s criteria said so. The caller was then asked who it was for, though they had named someone. Since the status and its offer, "yes please" answers the offer's own question (`leaveMessage`), and the message form keeps the person.
- **A quote, a meeting or a price** ("can I get a quote for a website", "can you book me a meeting with Riley", "how much do you charge for a logo") is something only the studio's people can do, so the desk takes it as a message (`take_message`'s criteria: "or wants something only the studio's people can do (a quote, a meeting, a price), which a message passes on"). A request nobody at the studio handles ("do you sell gift cards", "do you repair laptops") stays `other`.
- **`nomatch_open`** says what the desk can do, with no "Sorry, I didn't catch that": it is said both for words not understood and for a request understood and not handled (`other`), and must be true of both.
- **"I'm not sure who it should go to"** is labelled `anyone` (the team): a caller who does not know who should get it does not mind who does. The line that misses the recipient question is "hmm, let me think".
- **The ending** is "Your message is on its way to {recipient}." and then the goodbye: "Thanks for calling Example Front Desk. Goodbye." on a call, the chat's own `goodbye_chat` in a chat, so neither says thanks twice and a chat is never thanked for "calling".
- **The status and its offer (2026-10-16).** Built from the engine's building blocks, no engine change: `whereabouts` is a form intent with the one slot `recipient`; its `complete` hook reads the status through the gate (fail-soft), keeps it in the facts (`presence`) and answers `said` with the status line in place of the request's "Sure, I can help you ..."; routes.yaml's `afterForm.whereabouts` then enters an internal form by the status, `reach_person` (`reachHow`: through, message, neither) or `offer_message` (`leaveMessage`: leave, decline); `reach_person`'s hook hands off for `put-through`, and `afterForm` of each offer enters `take_message`, keeping `recipient` (the slots both forms list are kept), or says "No problem." and asks "anything else?". The two answers are `choice` slots, not yes-or-no reads of a summary, so "no thanks" is an answer the form takes, not a correction.
- **One `recipient` slot for both** (the message and the person asked about), so a message after a status keeps the person with no code. Its criteria now say both ("The message is for Sam Okafor, or Sam, or the caller asks about them"; the question "Who does the caller say the message is for, or ask about?"), and its question is "Who's it for, Riley Moreno, Sam Okafor, Jordan Lee, or anyone at the studio?" (was "Who's the message for, ..."), which reads right in both forms. The site's excerpt of slots.yaml (`site/index.html`) follows the criteria.
- **The team** has no calendar: "is anyone in the office" calls no tool, says "I can only check on Riley, Sam or Jordan by name." and offers a message for the team. The gate's `oneOf` refuses `anyone` too, should the code ever ask.
- **A request to talk to one of the three by name is `whereabouts`**, not a request for a person: "can I talk to Sam" hears Sam's status first, and is put through only if Sam is available. `whereabouts`' criteria say so, and `agent`'s now say "without naming Riley, Sam or Jordan". The engine's `wantsHuman` question is asked before the intent and cannot be told this (Gaps); on the stub the line is labelled as the app means it.
- **The greeting and `nomatch_open`** say "check whether they're in", and the greeting no longer says "No one can pick up right now": with Riley available and put through, it would not be true.
- **`take_message`'s criteria** no longer say "or agrees (yes, sure, okay, please) right after the line offers to take a message": the offer is now `offer_message`'s own question, answered by its slot, and a yes read as a new request for a message there could set the person aside. "yes please" and "sure, okay" moved from the opening (`tm-11`, `tm-12`, each a known gap at `no_form`) to the offer (`lm-01`, `lm-02`).
- **The offers on the keypad**: `keypad: true` on both choices, offered after two misses (`ask_reachHow_dtmf`: 1 put through, 2 a message, 3 neither; `ask_leaveMessage_dtmf`: 1 yes, 2 no). The menu gains no key: a status needs a name.
- **Who is put through, and to where**: only to someone the calendar says is available, to their own line, by a transfer target per person on the `put-through` reason and the `recipient` slot. Each number is a setting; like the main line, it must ring that person, never a number that forwards back to this desk.
- **`exactText` has no "Thanks!"**: it is often said right after `read_back_exact`, now "Sorry, let me read it back word for word." (it was "Here it is exactly as I took it down.", which "as you said it" would have repeated); with a generated summary (`text`) the line is said on its own, and keeps the paragraph's "Thanks".

## Gaps

What the paragraph asks that the framework did not do, or did differently, when the app was first built (2026-10-13); what I did then; and what the framework does now. The findings went to the maintainer, and every row but the last two is closed: the app now uses what the framework added.

| What | The framework, then | What I did then | Now |
|---|---|---|---|
| The paragraph's frame says "in short" before the summary | One frame, said with the summary and with the exact words alike | Dropped "in short" ("called and said:") | **Closed.** A framed line's `exactText` is the frame for the exact words ([guide 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)): `text` keeps the paragraph's "in short", `exactText` says "called and said:" |
| `pnpm configure` and a transfer target | `configure` wrote `HANDOFF_NUMBER` but not `STUDIO_MAIN_LINE`, which the server needs to start | `.env.example` and the README said to add it by hand | **Closed.** `configure` asks for each number app.yaml names (`--number STUDIO_MAIN_LINE=...`) |
| Recording with two keys in two files | `regress` read one settings file | Told the owner to copy one key next to the other | **Closed.** `ENV_FILE` names several files, separated by commas (`ENV_FILE=apps/secretary/.env,<your render.env>`); the README's recording command uses it |
| The message in the trace | A `text` slot with `say: null` had to be `redact: none`, so the message as said was in the trace and on the console | Recorded the param by length (`audit: length`), wrote the trade-off down | **Closed.** `redact: length-summarized`: the message is kept by its length in every record, and sent whole to the render model only for the span. The records now keep every turn's words and the message by their length; the caller's name as given, the number by its last four (see "What is recorded") |
| `handoff_result_unchecked` | The skill did not mention the line | Left it to `handoff_needs_human` | **Closed.** The skill names it; the app has its own line (prescribed) |
| A message said in one breath with the other details | The `text` slot's value is the whole turn's words (`pick` could cut a real message short) | Kept the whole turn as the message, name and number included; scripted (`message-all-in-one-breath`), so the baseline shows it | **A known limit**, documented in [guide 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line): the exact-words reading repeats the name and number; the summary usually leaves them out |
| The app map drew `urgent` as "Completes without calling an action" | A form whose `complete` hook hands off was not drawn as a handoff | Nothing; the handoff is in "Where a handoff goes" and in the scripted calls | **Eased.** The map now says the hook decides in code what follows (a line, the end or a handoff) |

Found while revising (2026-10-14), for the maintainer, and closed the same day by the engine's `span-checks`:

| What | Then | Now |
|---|---|---|
| The scaffold's `src/fixtures.test.ts` ran the corpus and scripted calls with no renderer, while `regress` on the stub words generated lines with the fake renderer, so with `exactText` a scripted call could pass in one and fail in the other | This app's test was given the fake renderer by hand | **Closed.** `stubRenderer()` (`'dialogwright/testing'`), the renderer `regress` uses on the stub; this app's `fixtures.test.ts` is the template's |
| A span could leave out a clause with a negation ("..., no changes needed" summarized as "the brochure proofs are back from the printer") and pass, the `negation` check holding only a clause restated | Left to the drift check | Left to the drift judge (since generated wording made simple, 2026-10-14, the `omitted` and `negation` checks are gone: a clause left out, with a "no" or not, is the drift judge's; on the stub, the fake renderer keeps the whole message when a later clause has a "no", so `ms-02` and `ms-07` are said unchanged). A plain clause left out (`ms-04`, `ms-08`, under "Known limits") is the drift judge's too |

No `FAIL adversarial` case and no `screened` finding on the stub: the suite holds 27/27 (injection 9, off-scope 8, hostile-reply 2, wording 8).

Found while building the status and its offer (2026-10-16), for the maintainer. Each is worked around in the app; nothing in `packages/dialogwright` was changed.

| What | The framework | What the app does |
|---|---|---|
| A form entered by a route or a `next` is always bridged into with `bridge_next` ("Now, let's {label}.") | No way for a form to say its own entering line, or none, so an offer after a status hears a bridge between the status and the question | The internal forms' labels are worded as the offer's lead-in ("Now, let's put you through or take a message. Which would you like?", "Now, let's see about a message. Would you like to leave one?"), and their questions are short. A form's own entering line (or `bridge: none`) would let the status be followed by the offer alone ("Sam Okafor is out of the office until Monday. Would you like to leave a message?") |
| One question line per slot (`ask_<slot>`), whatever form asks it | A slot shared by two forms (here `recipient`, so a message after a status keeps the person) has one question for both | `ask_recipient` is worded for both ("Who's it for, ...?"). It is asked in `whereabouts` only when the caller names no one ("is someone in today") |
| The engine's `wantsHuman` question is asked before the intent, of every turn, and cannot be told that a named person is the app's own request | "can I talk to Sam" may read as a request for a person ("The caller asks to talk to a person or to be put through to one"), and go to the main line before `whereabouts` is read | Labelled as the app means it (`whereabouts`, no `wantsHuman` answer: `wh-09` to `wh-11`); whether the real model reads it so is for the recording (below). Either end is safe: the main line rings a person. An app option naming the people a caller may ask for by name, told to the question as context, would let the app say so |
| The app map draws a form whose `complete` hook hands off as "Completes without calling an action" | `reach_person`'s put-through handoff is not drawn | Nothing; it is in "What goes to a person", the transfer targets on the map, and the scripted calls |
| The stub answers by a line's words alone, across every context | "a message for Sam please" (`tm-04`, labelled at the opening) cannot also be the offer's yes | The scripted call `whereabouts-then-a-message` says "yes, a message for Sam please" (`lm-08`) at the offer |

## Baseline edits

The baseline was first made with `regress --update` on 2026-10-13 (117 corpus outcomes, 39 scripted calls) and read entry by entry against this worksheet. The 2026-10-14 revision (`exactText`, `length-summarized`, `handoff_result_unchecked`) changed no entry. Two scripted calls' own expectations (`message-read-back-summarized`, `message-long-read-back-summarized`) expected "called and said, in short,", the frame said with a generated summary; the calls that hear the exact words expect "called and said:" (since the review, without "Thanks,"). After the engine's span checks (2026-10-14), `message-read-back-summarized` (a one-clause message, "the logo files are ready for review") is said unchanged with the exact-words frame, and its expectation says so; `message-long-read-back-summarized` still hears "in short". No baseline entry changed with them.

After the review of 2026-10-14 the baseline was made again with `regress --update` (the app had never been recorded or reviewed by the maintainer, and the maintainer allowed it), now 128 corpus outcomes and 52 scripted calls. Compared with the one before, entry by entry:

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `rc-05` ("I'm not sure who it should go to") | `promptId`, `slots.recipient` | `ask_recipient_retry`, none -> `ask_caller`, `anyone` | relabelled `anyone`: a caller who does not know who should get the message does not mind who does |
| corpus `ot-02`, `ot-06`, `ot-08` | removed | -> `tm-15`, `tm-16`, `tm-17` | a quote, a meeting with Riley and a price are now messages (`take_message`), renamed with the form's prefix; each opens the form (`ask_recipient`, or `ask_caller` with Riley for the meeting) |
| corpus `tm-11` to `tm-14`, `rc-08`, `ms-08`, `ms-09`, `rp-09`, `ot-09` to `ot-11` | new | | "yes please" and "sure, okay" after the offer of a message; "it's not urgent, but ..." and "call me back as soon as possible", opening and inside the message (all messages, none urgent); a recipient missed ("hmm, let me think"); "read it back" at "What should I change?"; three requests nobody at the studio handles |
| 13 scripted calls | new | | `whereabouts-then-yes`, `whereabouts-then-sure`, `quote-becomes-a-message`, `meeting-becomes-a-message`, `off-scope-hears-what-the-desk-does`, `message-recipient-not-sure-is-anyone`, `message-read-back-no-twice-asks-what-to-change`, `message-said-again-at-what-to-change`, `message-read-back-asked-for-at-what-to-change`, `message-not-urgent-but`, `message-call-me-back-soon`, `message-not-urgent-in-the-message`, `message-asap-in-the-message`; each read turn by turn |
| scripted call `recipient-not-given-goes-to-a-person` | steps | "I'm not sure who it should go to" x3 -> "hmm, let me think" x3 | the old line now answers `anyone`; same outcome (`max-attempts` to the main line) |

No other entry changed (the line changes, `message_taken`, `goodbye`, `nomatch_open` and `exactText`, are words, which the baseline does not hold; the scripted calls that name them expect the new words).

After recording 1 (2026-10-14), edited by hand (never `--update` once recorded), each entry from `regress --corpus <id> --json` / `--scenario <id> --json`:

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `rc-05` | `promptId`, `slots.recipient` | `ask_caller`, `anyone` -> `ask_recipient_retry`, none | relabelled a miss: the model hears no recipient (0.93), and asking again, with "anyone at the studio" offered, is the better turn |
| corpus `rc-08`, `ms-05`, `of-07`, `ns-03` | `decision`, `promptId`, `decidedGate`, `verdict` | a re-ask -> `ignore` at `addressedToSystem` | words that ask nothing of the line (thinking aloud, "hang on", "um"), rightly ignored |
| corpus `of-05` | `decidedGate`, `verdict` | `intent`, `confirm_unanswered` -> `confirmation`, `rejected` | another number at the offer is a no to it; the same next question |
| corpus `ur-06` | `promptId`, `reason`, `decidedGate`, `verdict`, `form` | `handoff_urgent`, `urgent`, `intent`, `route`, `urgent` -> `handoff_live_agent`, `live-agent`, `wantsHuman`, `handoff`, `take_message` | the caller asks for someone (wantsHuman 0.97): the same main line |
| corpus `ur-07`, scripted call `urgent-in-the-middle-of-a-message` | `slots.message` | none -> the caller's words | the urgent words also give the message (messageGiven 0.67) |
| corpus `wh-06` | `decision`, `promptId`, `acks`, `reason`, `decidedGate`, `verdict` | the whereabouts line -> `handoff_live_agent`, `live-agent` at `wantsHuman` | asking if Sam is available is asking to speak to Sam |
| corpus `of-08`, `ms-10` | new | | misses for the offer and the message, replacing lines now ignored |
| scripted call `message-recipient-not-sure-is-anyone` | renamed | -> `message-recipient-not-sure-asked-again`, with "anyone, I don't mind" after the re-ask; the same outcome (`ask_caller`, `anyone`) | follows `rc-05`'s relabel |

After the read-back was turned to the caller (2026-10-14, `speaks: to-caller`): no entry changed (the baseline holds no line's words). Added by hand from `--json`: corpus `ms-11` ("the project is complete and I just need him to give his approval", the maintainer's example: `confirm_take_message`) and scripted call `message-read-back-to-the-caller` (the same, for Sam; ends at the read-back). Seven scripted calls' own expectations follow the new frames (`message-read-back-summarized`, `message-long-read-back-summarized`, `message-read-back-no-hears-exact-words`, `message-read-back-corrected`, `message-said-again-at-what-to-change`, `message-read-back-repeated-word-for-word`, `message-read-back-asked-for-at-what-to-change`): the same turns, the new words.

After recording 2 (2026-10-14), edited by hand from `--json`:

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `tm-14` "call me back as soon as possible", scripted call `message-call-me-back-soon` | `slots.message` | none -> the words | relabelled `messageGiven`: the model takes the words as the message (0.60), and they are one |
| scripted call `message-for-anyone` | steps, `slots.caller` | "my name is Casey Brooks" -> "it's Alex Rivera"; `casey brooks` -> `alex rivera` | the message is "just say Alex called": a caller named Casey leaving it made no sense, and the model did not take it as a message there |

### The status and its offer (2026-10-16)

Edited by hand, each entry from `regress --corpus <id> --json` / `--scenario <id> --json`, read turn by turn, never `--update`:

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| every corpus line and scripted call | `slots` | `+ reachHow: null, leaveMessage: null` | two new slots (the answers to the offers), which every entry lists; no other field of these entries changed |
| corpus `wh-01`, `wh-05`, `wh-08` (Riley) | `promptId`, `acks`, `verdict`, `form`, `slots.recipient`, `gate` | `ask_intent`, `no_whereabouts`, `inform`, none -> `ask_reachHow`, `status_available` and `bridge_next`, `route`, `reach_person`, `riley`, `personStatus:ALLOW` | the status, then put through or a message; each line now labels the person it names |
| corpus `wh-02` (Sam), `wh-04`, `wh-07` (Jordan) | the same | -> `ask_leaveMessage`, `status_out_of_office` / `status_in_training` and `bridge_next`, `route`, `offer_message`, the person, `personStatus:ALLOW` | the status, then a message |
| corpus `wh-03` ("is anyone in the office") | `promptId`, `acks`, `verdict`, `form`, `slots.recipient` | -> `ask_leaveMessage`, `status_team` and `bridge_next`, `route`, `offer_message`, `anyone` | the team has no calendar: no call, a message for the team |
| corpus `wh-06` ("is Sam available") | `decision`, `promptId`, `acks`, `reason`, `decidedGate`, `verdict`, `form`, `slots.recipient`, `gate` | `handoff`, `handoff_live_agent`, none, `live-agent`, `wantsHuman`, `handoff` -> `prompt`, `ask_leaveMessage`, `status_out_of_office` and `bridge_next`, none, `intent`, `route`, `offer_message`, `sam`, `personStatus:ALLOW` | relabelled: its `wantsHuman` answer and its `knownGap` are gone. Asking whether Sam is available is asking about Sam, and the line now answers it; the recording of 2026-10-16 read wantsHuman 0.41 (under its bar 0.7) and whereabouts 0.98, which is this outcome |
| corpus `tm-11` "yes please", `tm-12` "sure, okay" | removed | -> `lm-01`, `lm-02` | the words answer the offer of a message, now `offer_message`'s own question (`leaveMessage: leave`), not a request at the opening; their known gaps (seeded at the opening, where nothing was offered) go with them |
| corpus `wh-09` to `wh-14`, `rh-01` to `rh-08`, `lm-01` to `lm-08` | new | | the person named up front ("can I talk to Sam", "could you put me through to Riley", "I'd like to speak with Jordan Lee please", "is Riley around"), no one named ("is someone in today") and the name given then; each answer to each offer (put through, a message, neither; yes, no), and a miss for each |
| scripted call `whereabouts-never-said` | removed | -> `whereabouts-available-is-offered-through-or-a-message` (new) | "is Riley in today" now hears Riley's status and the offer: the old name said the opposite |
| scripted call `whereabouts-then-a-message` | step 2; `acks`, `decidedGate`, `verdict`, `gate` | "a message for Sam please" -> "yes, a message for Sam please"; `ack_intent`, `intent`, `route`, none -> `bridge_next`, none, `proceed`, `personStatus:ALLOW` | the second step answers the offer now (the stub answers a line's words alone, Gaps); the same end, `ask_caller` in `take_message` for Sam |
| scripted call `whereabouts-then-yes` | step 1, expectation; `promptId`, `acks`, `decidedGate`, `verdict`, `slots.recipient`, `gate` | "is Riley in today" -> "is Jordan on holiday"; `ask_recipient`, `ack_intent`, `intent`, `route`, none -> `ask_caller`, `bridge_next`, none, `proceed`, `jordan`, `personStatus:ALLOW` | Riley is available, so the offer is not a yes or no; Jordan is in training, and "yes please" to the offer goes to the message form with Jordan set |
| scripted call `whereabouts-then-sure` | expectation, `knownGap`; the same fields | `ask_recipient` (known gap `confirm_intent_explicit`) -> `ask_caller`, Sam set | "sure, okay" answers the offer as its slot: the check of the request (its known gap, recordings 3 to 5) no longer applies |
| scripted call `off-scope-hears-what-the-desk-does` | its expectation's text | "... or Jordan, or tell you ..." -> "... or Jordan, check whether they're in, or tell you ..." | `nomatch_open` says what the desk does, now this too; the baseline entry is unchanged |
| 23 scripted calls in `whereabouts.json` | new | | each status (available, out of the office, in training, the team, a person asked for), the person named up front, put through (said three ways, and on the keypad, to `RILEY_LINE`), a message taken and delivered (after available, and after out of the office), neither, no, "not right now" then the hours, the team's message, the offer on the keypad (yes, no) and never answered (the main line) |

## Known limits

- **A message said in two breaths.** A caller who pauses between two sentences of a message ("The logo files are ready. ... Oh, and the invoice is attached.") gives the message at the first breath: the line reads it back, and the second sentence arrives as an answer to the read-back. `voice.continueWithinMs: 900` joins the two when the caller talks over the read-back within 900 ms of its start (the engine's default is 300); a longer pause is not joined. **To try on a live call:** leave a two-sentence message with a short pause (about a second) between the sentences, then one with a longer pause (two or three seconds), and see whether the read-back has both. If the longer pause loses the second sentence, the options are a higher `continueWithinMs` (at most 2000) or the recognizer's own end-of-speech setting, never the message's slot.
- **A message said in one breath with the other details** keeps the whole turn as the message (Gaps).
- **What the stub shows of the span** (since generated wording made simple, 2026-10-14; the fake renderer gives a message's first clause, its "I" and "my" said as "you" and "your", and the whole message when a later clause has a "no"): of 31 spans tried, 9 said generated (a first person turned to the caller counts as a wording: `ms-04` "you're calling about the invoice ...", `ms-11` "... and you just need him to give his approval", `ms-06` and `ms-09` their "we've" and "me" said to the caller), 20 said unchanged with the exact-words frame (one-clause messages with no first person, and `ms-02` and `ms-07`, whose later clause has a "no"), 2 fell back, both `drift`: `tm-08` (the one-breath message whose first clause is "hi") and its call. Two spans pass on the stub though they leave out what matters, the stub's test-double judge passing them: `ms-04` summarized as "you're calling about the invoice for the spring campaign" (the request to send it again left out) and `ms-08` as "it's not urgent" (the invoice needing a look this week left out). On a recording, only the real model and the real drift judge decide these: watch both.
- **The lines the first recording should watch** (each is a reading the stub takes from its label, and only the real model shows): the urgent and message boundary (`ur-*`, `tm-13`, `tm-14`, `ms-08`, `ms-09`: "it's not urgent, but ...", "call me back as soon as possible"); "yes please" and "sure, okay" after the whereabouts line (`tm-11`, `tm-12`); a quote, a meeting and a price as messages, and the truly off-scope requests as `other` (`tm-15` to `tm-17`, `ot-*`); "I'm not sure who it should go to" as `anyone` (`rc-05`); "read it back" at "What should I change?" (`rp-09`); the whole one-breath message (`tm-08`); and every span the render model words and the drift check judges, above all a message with a negation or a second clause ("no changes needed", "please don't send ...", "it's not urgent, but ...", "..., could someone send it again ...": `ms-02`, `ms-04`, `ms-06`, `ms-07`, `ms-08`), and whether a one-clause message comes back unchanged (the exact-words frame) or reworded (the "in short" frame).

### After the status recording (2026-10-16)

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `wh-13` "is someone in today" | `recipient` label, `promptId`, `acks`, `form`, `slots` | no person -> `anyone` (the team): `status_team` and the message offer | the model reads it as asking about anyone (recipient anyone 0.94), which is right: the team's answer and a message (bucket 1, from `regress --corpus wh-13 --json`) |
| corpus `wh-15` "can you check if they're in today" | new | the person asked for (`ask_recipient`) | the unnamed opener for `status-person-asked-for`, whose old opener ("is someone in today") now reads as the team (bucket 3) |

## Recordings

- **Recording 1, 2026-10-14, decision model `jev-1.13.0` (TypeSafe), render model `claude-haiku-5-5` (Anthropic, thinking off)**, by the maintainer: corpus 111/128, scripted calls 42/52 pass; `to triage: 17 untagged corpus differences, 10 failing scripted calls, 3 passing scripted calls that differ from the baseline, 0 cassette misses`. Spans: 27 tried, 3 said generated, 2 unchanged, 22 fell back (person 19, words 2, negation 1).
- **After the fixes that change no request** (replayed on recording 1): corpus 119/130 (the two new lines, `of-08` and `ms-10`, are not recorded yet), scripted calls 46/52; `to triage: 2 untagged corpus differences (the two new lines, cassette misses), 6 failing scripted calls, 0 passing scripted calls that differ from the baseline, 6 cassette misses`. Every miss is a request the recording never made: a new line or a scripted call's new step.
- **Labels fixed (the model was right)**, each also under "Baseline edits":
  - `rc-05` "I'm not sure who it should go to": recipient none 0.93 (anyone 0.07), so the desk asks again, offering "anyone at the studio". That is the better turn; the line is a miss again, and `message-recipient-not-sure-asked-again` (was `...-is-anyone`) now answers the re-ask with "anyone, I don't mind".
  - `rc-08` "hmm, let me think", `ms-05` "hmm, what should I say", `of-07` "hang on a second", `ns-03` "um": addressedToSystem 0.39, 0.45, 0.46, 0.58, so each is ignored. Words that ask nothing of the line, rightly ignored; labelled with `answers: { addressedToSystem: 0.3 }` and the tag `not_addressed`. New misses replace them where a slot needed one: `ms-10` "I'd rather not say what it's about" and `of-08` "what number is that".
  - `of-05` "my cell is ... 0133" at the offer: confirmsNo 0.79 with the number. Giving another number is a no to the offer: `confirm: no`; the same next question.
  - `ur-06` "actually this is urgent, can I talk to someone now": urgent 0.83 and wantsHuman 0.97, so it goes to the main line as a request for a person (`live-agent`) rather than as urgent: the caller does ask for someone, and the line is the same. Labelled with `answers: { wantsHuman: 0.95 }`.
  - `ur-07` "hold on, it's really urgent, the website is down", inside the message: messageGiven 0.67. The words do give the message; labelled `messageGiven`, so the handoff carries it (by its length).
  - `wh-06` "is Sam available": whereabouts 0.98 and wantsHuman 0.84. Asking whether Sam is available is asking to speak to Sam, so the call goes to the main line; nothing is said about where Sam is. Labelled with `answers: { wantsHuman: 0.9 }`.
- **Tagged `knownGap` (the label is the truth)**:
  - `tm-11` "yes please", `tm-12` "sure, okay": a corpus line at `no_form` is seeded at the call's opening, where no offer of a message was made, so the model reads no request (take_message 0.46; 0.01) and the caller hears `nomatch_open`. After the whereabouts line, the scripted calls test them: `whereabouts-then-yes` passes on recording 1 ("yes please" read as take_message), `whereabouts-then-sure` waits for the re-record. A finding for the maintainer: the corpus has no context "after an informational answer".
  - `ad-08` "oh, and what's the address there", at the name question: studio_address 0.99, but addressedToSystem 0.42, so the turn is ignored and the caller hears nothing. The engine's question (owner's table).
  - `ag-08` "a person": wantsHuman 0.56, under its threshold; the intent gate takes it (agent 0.74). The same handoff.
  - `rp-07` "pardon", at the opening: none 0.55, repeat_prompt 0.44; the caller hears `nomatch_open`, which says what the desk does.
  - `sm-04` "no, let me say it again": a no (0.96) with no slot to change (changeSlot none 0.99; repeat_prompt 0.71), so a bare no: the exact words are read back, and a second no asks what to change, where the message is said again (`message-read-back-corrected` still ends at the new read-back). Reworded for the re-record (repeat_prompt's criteria).
  - `ur-07`: the priority gate acts, not the intent gate (the change question reads answering 0.99): the same handoff.
  - `ur-08` "wait, it's for Sam, and it's urgent", at the read-back: take_message 0.64, urgent 0.21: the correction is taken and the urgency lost; the caller must say it again. Reworded for the re-record (urgent's criteria).
  - `ms-09` "please call me back as soon as possible about the proofs": messageGiven 0.54, under the slot's bar, so the message is asked again. Reworded for the re-record (the message slot's instructions).
- **Scripted calls changed on an incidental line**:
  - `hours-on-the-keypad`, `address-on-the-keypad`, `message-on-the-keypad`, `person-on-the-keypad-menu`: opened with "um", "um", which the model ignores (ns-03, addressedToSystem 0.58), so the menu was never offered. Opened with two silences instead (a silence is a miss with no model call); all four pass on recording 1.
  - `recipient-not-given-goes-to-a-person`: "hmm, let me think" (now rightly ignored) x3 -> "I'm not sure who it should go to" x3 (a miss the model hears).
  - `whereabouts-then-sure`: its first step "is Sam available" (now a request for a person) -> "when will Sam be back" (wh-02, read as whereabouts).
  - `cosmeticDrift` on `urgent-in-the-middle-of-a-message` (priority gate), `message-read-back-corrected` and `message-said-again-at-what-to-change` (a no read at the confirmation gate): the same end by another gate.
- **Left failing, as evidence**: `urgent-at-the-read-back-with-a-correction` (ur-08; the rewording should fix it), `message-asap-in-the-message` (ms-09; the same), and `message-long-read-back-summarized`: its span fell back for `person`, so the line was the exact-words frame, not "in short". The engine's option is now in and used (`speaks: to-caller`, "The frame's words" above); the expectation is the new frame's "in short:", for the re-record to show.
- **Reworded for the re-record** (each changes every request, so the replay now misses everywhere until recording 2): the read-back spoken to the caller (`speaks: to-caller`, `names: [recipient]`, the new frames and `read_back_exact`: the span's requests and the line just played change; the new line `ms-11` and the scripted call `message-read-back-to-the-caller` carry the maintainer's example); urgent's criteria (said at any point, even in the same breath as a correction: ur-08); repeat_prompt's criteria (a caller who wants to say their message again is not asking for a repeat: sm-04); the message slot's instructions (a request to be called back about something is a message too: ms-09).
- **For the owner**: one re-record (the same command), after which: remove the tags the run says `knownGap now matches` for (expected: `sm-04`, `ur-08`, `ms-09` if the rewording works), record `whereabouts-then-sure`, `of-08`, `ms-10` and the two scripted calls' new steps, and triage the spans again under `speaks: to-caller` (expected: far fewer `person` fallbacks; any name said for a pronoun is the drift check's). `ad-08` (addressedToSystem on "oh, and ... there") and the corpus's missing context after an informational answer are the engine's.

- **Recording 2, 2026-10-14, the same models**, by the maintainer, after the read-back was spoken to the caller and the first rewording: corpus 122/131, scripted calls 47/53; `to triage: 2 untagged corpus differences, 6 failing scripted calls, 1 passing scripted call that differs from the baseline, 0 cassette misses`. Spans: 29 tried, 5 said generated, 24 fell back (drift 18, words 4, negation 1, person 1). The maintainer read the summaries: all reasonable secretary summaries but "the logo files are ready for your review"; what fails is the span fitting its frame, which the engine's `span-frame` branch takes on (the span model and the drift judge given the sentence around the span). Nothing in the app works around the span results.
- **After the fixes that change no request** (replayed on recording 2): `to triage: 0 untagged corpus differences, 5 failing scripted calls, 0 passing scripted calls that differ from the baseline, 2 cassette misses` (the misses: `message-for-anyone`'s new step).
- **Tags**: `ms-09` removed (`knownGap now matches`: the message slot's reworded instructions took it). `ur-08` re-pinned: with `URGENT_SURE` 0.4 the call goes to the main line, by the priority gate (urgent 0.43, take_message 0.50), and `urgent-at-the-read-back-with-a-correction` passes, marked `cosmeticDrift`. `ur-07` now lists both outcomes it has given (the message filled or not, messageGiven 0.67 then 0.56). `sm-04` kept, its numbers updated: the reworded repeat_prompt criteria moved the intent (repeat_prompt 0.71 -> 0.14) but the engine's changeSlot question still reads none 0.99 for "let me say it again".
- **Label fixed**: `tm-14` (the words are the message).
- **Scripted call changed on an incidental line**: `message-for-anyone`'s name (above).
- **Still failing, reworded for recording 3**: `whereabouts-then-sure` ("sure, okay" after the offer read as no request: take_message's criteria now say "agrees (yes, sure, okay, please)"); `message-not-urgent-in-the-message` ("it's not urgent, but the invoice needs a look this week" not taken as the message in the call, though the same words seeded alone are, messageGiven 0.73: the message slot's instructions now name a message that starts by saying how urgent it is).
- **Waiting on the engine (`span-frame`)**: `message-long-read-back-summarized` and `message-read-back-to-the-caller` heard the exact-words frame because their spans fell back; left as they are.
- **Reworded for recording 3** (each changes requests): the span's word budget 20 -> 30 (the span's requests); take_message's criteria (every request); the message slot's instructions (every request in the message form). With the engine's `span-frame` change, recording 3 should follow it, so its span requests are recorded once.

- **Recording 3, 2026-10-14, the same models**, by the maintainer, after the engine's `span-frame` (the span sees its sentence; checks by code hold data and shape, the drift judge decides meaning): corpus 123/131, scripted calls 51/53; `to triage: 1 untagged corpus difference, 2 failing scripted calls`. Of 31 spans tried, 15 said generated, 13 unchanged, 3 fell back (`drift`).
  - `whereabouts-then-sure`: "sure, okay" after the offer read take_message 0.59, none 0.41, so the caller is asked "do you want to leave a message? Yes or no.": one more yes, and safe. A known gap to tag after recording 4 if it holds.
  - `message-long-read-back-summarized`: at the message prompt "...could someone send it again..." read recipient anyone 0.50 (confidence 0.37) and replaced Riley, chosen at the first turn; the read-back said "the team". The engine's finding (live findings item 27): a dictation turn belongs to its slot (the text type's `others`, default `quiet` for a slot that takes the whole answer), so the message slot needs no setting here.
  - Haiku's summaries put a "you" where the caller said no "I" ("asking you to call back" for "please call me back", "needs your look", "your logo files"), and the judge passed them. The engine's finding (item 27): the span and the judge are given the goal and the context, never a procedure for the words; the cases are in `render:judge-eval`.
- **The bake-off of 2026-10-14** (`render:bakeoff --fresh`, Haiku 5.5, Gemini 2.5 Flash-Lite, Gemini 3.1 Flash-Lite preview, DeepSeek 4.1 Flash, the same requests): Gemini 3.1 Flash-Lite the fastest (wording p50 491 ms, p95 841 ms; 1 of 15 over the 700 ms call budget, where Haiku was 14 and Gemini 2.5 Flash-Lite 12) and no summary turned who does what. The maintainer's choice: style.yaml's `model` names it (OpenRouter, `google/gemini-3.1-flash-lite-preview`, a preview); the span's goal is the maintainer's wording ("Fill in the blank for this text with the summary, repeating the caller's words back to them in a way that reflects a secretary reading back the message they left.").
- **For the owner**: recording 4, with OpenRouter's key (the model and the goal change every span's request).

- **Recording 4, 2026-10-14, decision model `jev-1.13.0`, render model `google/gemini-3.1-flash-lite-preview` (OpenRouter), named in style.yaml**, by the maintainer, after the engine's item 27 (the read-back given its goal and context only; a dictation turn belongs to the message slot): corpus 123/131 (the 8 differences each a known gap), scripted calls 52/53; `to triage: 0 untagged corpus differences, 1 failing scripted call, 0 cassette misses`. Of 31 spans tried, 14 said generated, 14 unchanged, 3 fell back (`drift`); wording p95 1073 ms as recorded with a generous budget.
  - `message-long-read-back-summarized` passes: the recipient stays Riley through "could someone send it again" (the message slot's default `others: quiet`).
  - The read-backs, each heard as "...gets your message, in short: <summary>": "please call me back as soon as possible about the proofs" -> "you'd like a callback regarding the proofs as soon as possible"; the invoice message -> "you need the spring campaign invoice resent to accounts at example dot com because it was sent to the wrong address"; "please don't send the final files until we've signed off on the colours" -> "hold off on sending final files until the colours are signed off"; "it's not urgent, but the invoice needs a look this week" -> "the invoice is not urgent but needs a review this week"; "the project is complete and I just need him to give his approval" (for Sam) -> "the project is done and you need his approval". No summary turns who does what.
  - Refused by the judge: "...look great, no changes needed" -> "the printer brochure proofs are approved with no changes needed" (rightly: "approved" is not what was said); "the project is complete and I just need him to give his approval" (for Riley) -> "the project is complete and you need Riley Moreno's approval" (a faithful summary refused: the exact words are read back, which costs nothing but the summary).
  - Passed though mixed: the one-breath message -> "your logo files are ready for review, please call Alex Rivera back at five five five ..." (the files are not the caller's; the callback is worded as the message for Riley rather than back to Alex). A case for `render:judge-eval`.
  - Still failing: `whereabouts-then-sure`. "sure, okay" after the offer of a message reads take_message 0.55, none 0.45 (recording 3: 0.59), so the caller is asked "do you want to leave a message? Yes or no.": one more yes, and safe. The owner accepted the check as the expected turn: the call carries a `knownGap` (the engine's, for a scripted call as for a corpus line) pinning `confirm_intent_explicit`; the stub still goes straight to `ask_recipient`, as the label says. After it: `to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses`.

- **A live call, 2026-10-14 (the engine's live findings item 28).** "yes" at the read-back read `messageGiven` 0.60, and the message became "yes". The engine's fix: a yes to the summary accepts what was read back; and, the owner's decision, the text type asks at the read-back only whether the caller, besides agreeing, adds to or changes the message (`messageChanged`), which at `SUMMARY_WORDS_CHANGED` (0.6) adds the turn's words after the message, exactly as said, and reads the summary again. New, each expected entry written by hand and matched by the stub: corpus `sm-08` ("yes", with the live reading `messageGiven` 0.6), `sm-09` and `sm-10` (plain agreements, `messageChanged` false), `sm-11` to `sm-13` (additions and changes, `messageChanged` true: the summary read again with the message and the words added, "the logo files are ready for review. yes and also say I'll be late"); scripted calls `message-read-back-yes-kept` (the message delivered as said) and `message-read-back-yes-adds` (the message and "yes but tell her it's moved to Thursday", read back, then delivered).
- **For the owner**: recording 5, the same command. Every request at the read-back changes (the `messageChanged` question), so until then `--client recorded` misses there: the six new lines, the two new calls, and every other read-back turn (`to triage` counts the misses). Expected after it: the plain agreements read `messageChanged` low and complete; the additions read it high and hear the read-back again with their words after the message; `sm-08` shows whether "yes" still reads `messageGiven` over its bar (harmless now). A line where the model disagrees with its label is a finding for the question's words, not a tag.

- **Recording 5, 2026-10-14, decision model `jev-1.13.0`, render model `google/gemini-3.1-flash-lite-preview` (OpenRouter)**, by the maintainer, after the engine's item 28 (a yes at the read-back accepts it; the text slot's `messageChanged` question at the read-back, and new words appended after the accepted message): corpus 128/137, scripted calls 53/55; `to triage: 0 untagged corpus differences, 1 failing scripted call, 0 cassette misses`.
  - The new question at the read-back: "yes" 0.05, "yes that's right" 0.05, "yep sounds good thanks" 0.05 (each kept and delivered); "yes but tell her it's moved to Thursday" 0.97, "yes and also say I'll be late" 0.97 (each appended and read back again); "yes, actually make it Friday not Thursday" 0.92, with messageGiven only 0.25. The engine first held a change to messageGiven's bar as well, so `sm-13` was kept and delivered without the change; the engine now lets the changed question alone decide at the read-back, and `sm-13` matches.
  - Tagged `knownGap`: `tm-11` "yes please" at the opening, take_message 0.51 / none 0.49, now either `nomatch_open` or the check `confirm_intent_explicit`; `tm-17` "how much do you charge for a logo", take_message 0.55 / other 0.45, the check before the recipient. Both safe.
  - Still failing, the owner's to decide: `message-for-anyone`. "just say Alex called" at "Go ahead with your message" reads messageGiven 0.58, under the slot's bar 0.6 (recording 4: above it), so the caller is asked again ("Sorry, what message should I pass on?"). The same reading as the first live call of 2026-10-14, whose four messages each read under 0.1: at the message's own question, the given question's bar can turn away a real message.

- **Live findings item 29 (the engine, 2026-10-14): the turn at the message's question is the message.** The first live call's four messages at "Go ahead with your message." read `messageGiven` 0.03 to 0.08, and recording 5's "just say Alex called" 0.58, each under the slot's bar 0.6: the line asked again and handed off. The engine's default for a text slot without `pick` (`commands: ignore`) now takes the turn at its own question whole: no bar, and no request in it acted on; the screen, silence, words not made out and an unfinished answer joined work as before, and the read-back follows. The app follows the default. The engine also rewords the text type's default question ("Only asking to give it, without saying it, is not." in place of "A request alone is not ..."), which the app's own `instructions` contradicted ("A request to be called back about something is a message too"); the instructions are unchanged, so the next recording measures the engine change alone. Edited by hand, each matched by the stub:

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| corpus `ms-05` ("hmm, what should I say" at the message) | `decision`, `promptId`, `decidedGate`, `verdict`, `slots.message` | `ignore` at `addressedToSystem` -> `confirm_take_message`, `proceed`, the words | an aside at the message's question is taken as the message, and the read-back lets the caller say no |
| corpus `ms-10` ("I'd rather not say what it's about") | `promptId`, `slots.message` | `ask_message_retry`, none -> `confirm_take_message`, the words | the words are the message, read back |
| corpus `ur-07` ("hold on, it's really urgent, the website is down" at the message) | `decision`, `promptId`, `reason`, `decidedGate`, `verdict`, `form` | the urgent handoff -> `confirm_take_message`, `proceed`, `take_message` (the message the words, as before) | urgent said at the message's question is part of the message; its knownGap (the gate that took the handoff) no longer applies and is gone |
| scripted call `urgent-in-the-middle-of-a-message` | renamed, moved | `handoffs.json` -> `messages.json`'s `message-urgent-in-the-message`, expecting the read-back with the words as the message | the old name and file said a handoff, which it no longer is |

  `person-in-the-middle-of-a-message` and `hours-in-the-middle-of-a-message` are said at the caller's name, not the message's question, and are unchanged. `message-for-anyone` now takes "just say Alex called" whatever it reads. Every request of the app asks the reworded question, so `--client recorded` misses on every turn until the owner records again (226 misses); with the old wording, only the dictation change, the recorded run took "just say Alex called" as the message and missed once, at the read-back after it, never recorded.

- **Recording 6, 2026-10-14, the same models**, by the maintainer, after the engine's item 29 (the turn at "Go ahead with your message." is the message, `commands: ignore`; and the text type's given question reworded, "Only asking to give it, without saying it, is not."): corpus 129/137, scripted calls 54/55 (the one, `whereabouts-then-sure`, its accepted known gap); `to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses`.
  - The reworded question: messages that are requests now read as messages, "please call me back as soon as possible about the proofs" 0.97, the invoice message 0.96, "please don't send the final files until we've signed off on the colours" 0.97, "just say Alex called" 0.78 and 0.60; and what is not a message stays out, "hmm, what should I say" 0.02, "I'd rather not say what it's about" 0.02 (both are taken as the message at the message's own question all the same, item 29, and read back).
  - `message-for-anyone` passes. `tm-17`'s known gap removed (the run said it now matches). `ur-05` "the print shop needs sign-off within the hour, it's urgent" at the opening: urgent 0.57, take_message 0.41, so the priority gate takes it rather than the intent gate, the same handoff: tagged.

### Recording after the engine's decisions (2026-10-16)

Recorded again after the wants-a-person question was reworded (the caller is told the service is automated; asking whether one talks to a person is not asking for one) and the text type's changed question; generated lines replayed from their cassette (`--render recorded`). 309 requests, $0.0472; trimmed to 231 answers. Replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- **wh-06 "is Sam available"** now reads wantsHuman 0.41 (0.84 before) and whereabouts 0.98: the caller hears where Sam is and may leave a message, rather than being put through to the main line. Tagged (`knownGap`) and brought to the maintainer: either end is safe; the label stays a person until the maintainer says otherwise.
- **ur-05**'s tag came off (`knownGap now matches`).

### The status and its offer: what to record (2026-10-16)

- **For the owner: record again, the whole app** (the same command as before, README.md). The status and its offer change what every request asks: `whereabouts`' and `agent`'s criteria and `take_message`'s, the `recipient` slot's question and criteria, two new slots (`reachHow`, `leaveMessage`), and the greeting and `nomatch_open`. So `--client recorded` misses on every turn until the owner records again (replayed today: `to triage: 157 untagged corpus differences, 73 failing scripted calls, 0 passing scripted calls that differ from the baseline, 285 cassette misses`). No new line is generated and the span's own requests are unchanged, but a replay reaches a read-back only once the decision model's answers before it are recorded again. After it, watch:
  - `wh-09` "can I talk to Sam", `wh-10` "could you put me through to Riley", `wh-11` "I'd like to speak with Jordan Lee please": whether `wantsHuman` reads them over its bar (0.7) and sends them to the main line before `whereabouts` is read (Gaps). A known gap if it does, and safe; the maintainer's to decide.
  - every `wh-*` line: that `recipient` fills with the person named (its criteria now say "or the caller asks about them").
  - `rh-*` and `lm-*`: the offers' answers, and above all that "yes please", "a message is fine" and "I'll just leave a message" at an offer are read as the slot's answer, not as a new request for `take_message` (which would set the person aside and ask "Who's it for" again).
  - `lm-04` "no thanks, that's okay" and `rh-06` "no thanks, never mind" at an offer: read as the slot's no, or as `done` (the call ends with the goodbye): either is safe.
  - `whereabouts-then-sure`, whose known gap is gone: "sure, okay" at the offer.

### Recording of the status and its offer (2026-10-16)

The decision model and the render model recorded (Jev, and Gemini 3.1 Flash-Lite through OpenRouter): 383 requests, $0.0585, then once more after the triage (384, $0.0587); trimmed to the 283 answers a run asks for. First replay: `3 untagged corpus differences, 1 failing scripted call`; after the triage: `0 untagged, 0 failing, 0 differing, 0 misses`.

- **wh-13** "is someone in today": recipient anyone 0.94, so the team's answer and a message; relabelled (bucket 1).
- **status-person-asked-for**: its opener was wh-13's words; now "can you check if they're in today" (wh-15), which names no one (bucket 3).
- **tm-17** "how much do you charge for a logo": intent other 0.64 over take_message 0.36, so the caller hears what the desk can do (take a message or check whether someone is in) rather than a message straight away; tagged (bucket 2), safe.
- **sm-04**: its pinned slots gained the two new slots (`reachHow`, `leaveMessage`).
- **The watch items held**: "can I talk to Sam", "could you put me through to Riley" and "I'd like to speak with Jordan Lee please" reach the status and its offer (wantsHuman did not take them to the main line); the answers to an offer ("yes please", "a message is fine") are read as the offer's.
- Generated lines: 39 tried, 18 said generated, 18 unchanged, 3 fell back (drift).

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [x] Every decision has its answer, each option it led to is built, and each option's pattern's **Test** calls are scripted (the callback offer accepted, declined, declined then nothing, another number, withheld, keyed, the chat; a read-back answered yes, no, no then the message again, a recipient and a number corrected; urgent at the start, mid-form and at the read-back with a correction).
- [x] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [x] Every slot has at least five answers in the corpus, the summary seven.
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); no bounds; no custom rule. Since 2026-10-16, two actions: the status read is read back too (below, "The policy read back").
- [x] Scripted calls cover the form, the anonymous caller (the only principal), each handoff (a person on request at the start, inside the form, at the read-back and on the keypad menu; urgent; max attempts), keypad entry (the number, and the menu's keys) and each informational answer (spoken, and the hours and the address by key). No identity, so no step-up, verification or delegate calls.
- [x] No `identity.yaml`: the paragraph says nobody verifies.
- [x] The policy read back (`policy.matrix`, `POLICY.md`, `APP-MAP.md`) matches "Who may do what", and the card matches the paragraph: one action at level 0, confirmed; the span listed as the only generated part, with its goal, its content and its budget; the prescribed lines.
- [x] Every tool lists its `params`, every param has a row under "What is recorded", and the card's table says the same; what `length-summarized` costs is written down, and the caller's name, kept as given, is said so.
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`; every status line is fixed text chosen by code from the calendar's checked reply.
- [x] Every tool whose reply a call is made from or the audit records checks it (`check`); app.yaml says `testing: { adversarial: on }`, and the regression prints `adversarial 27/27 cases hold` with no `FAIL adversarial`.
- [x] No knowledge base.
- [x] Nothing private or real: invented names and street, 555 numbers, `example.com` addresses.
- [x] `pnpm check` ok; `pnpm verify` green; every app's regression and the testkit's say `no changes`.
- [x] The baseline was made once with `regress --update`, read entry by entry; no later edit.
- [x] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and how it is built, and keeps the recording steps (with the render model's); `CLAUDE.md` matches the folder.
- [x] The gaps above are written up.

# Example Front Desk: design worksheet

Built with the create-app skill (`.claude/skills/create-app/`) by an AI coding assistant (Claude Opus 5.5) on 2026-10-13, from the paragraph below. The business name, "Example Front Desk", was given with the paragraph.

## The paragraph

> Example Front Desk answers the phone for a small design studio when no one can pick up. Callers can leave a message for one of three people: Riley Moreno, Sam Okafor or Jordan Lee, or for "anyone" if they don't mind who. The desk takes the caller's name, a number to call back (offering the number they're calling from), and the message itself, in their own words. Before saying goodbye it reads the message back the way a good receptionist would, briefly: "Thanks, I'll make sure Riley gets your message: Alex Rivera called and said, in short, the logo files are ready for review." Only the summary of what the caller said is worded by the model; the rest of that sentence is fixed, and if the caller says that's not right, it reads back their exact words instead and lets them say it again. Every other line is said word for word. A caller who says it's urgent, or asks for a person, is transferred to the studio's main line. Callers can also ask for the studio's hours (weekdays nine to five) and its address (an invented street). Nobody needs to verify who they are; the desk never says anything about the people's schedules or whereabouts.

## Intents

| Intent id | Kind (form, informational, control) | What the caller wants | Example phrasings (five or more, terse ones included) |
|---|---|---|---|
| `take_message` | form | leave a message for Riley, Sam, Jordan or anyone | "I'd like to leave a message", "message", "can I leave a message for Riley", "a message for Sam please", "leave word with Jordan", "message for anyone, I don't mind who", "tell Riley the logo files are ready for review" |
| `urgent` | form (priority, no slots: straight to a person) | reach the studio now | "it's urgent", "urgent", "this is an emergency, I need to reach someone now", "it can't wait, I need someone right now", "the print shop needs sign-off within the hour, it's urgent" |
| `studio_hours` | informational | the hours | "what are your hours", "hours", "when are you open", "what time do you close", "which days do you work" |
| `studio_address` | informational | the address | "what's your address", "address", "where are you located", "how do I find the studio", "what street are you on" |
| `whereabouts` | informational | whether someone is in, where they are, their schedule (never answered) | "is Riley in today", "when will Sam be back", "is Jordan on holiday", "where is Riley", "is Sam available" |
| `agent` | control | a person, at any time | "can I talk to a person", "operator", "representative", "a person", "put me through to someone please" |
| `repeat_prompt` | control | hear it again (word for word) | "can you repeat that", "pardon", "say that again", "can you read that back word for word", "read me the whole message" |
| `done` | control | finished | "that's all I needed, thanks", "goodbye", "no, I'm good", "that's it, bye", "no thanks" |
| `other`, `none` | control | anything else; no request | "do you sell gift cards", "how much do you charge for a logo"; "hello", "um" |

## Information each form needs

| Form | Information | Slot id | Slot type and key options | Keypad? | Sensitive? |
|---|---|---|---|---|---|
| `take_message` | who the message is for | `recipient` | `choice`: riley, sam, jordan, anyone ("the team") | no (keypad on the menu only) | no |
| `take_message` | the caller's name | `caller` | `name` | no | recorded by length (audit) |
| `take_message` | a number to call back | `phone` | `digits`: length 10, `callerNumber` (offers the number calling) | yes | by its last four (the type's default) |
| `take_message` | the message, in the caller's words | `message` | `text`: `say: null`, `redact: none`, maxLength 400 | no | recorded by length (audit); kept as said in the trace (see "What is recorded") |
| `urgent` | nothing | | | | |

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
| 12 | What should the person taking a transfer see? | `handoff.data.unconfirmed: mark` (the default for a new app), every slot (the default `slots: all`; the callback number by its last four, as recorded). |
| 13 | Half-understood callers, corrections at the read-back, silence after "anything else?" | The paragraph is silent: the defaults. |
| 13b | Nice-to-have details; a caller who cannot answer | Every detail is needed for the message: the engine's ladder (three tries, then the main line). |
| 13c | Anything before the request, after identity or after a form? | No routes. The paragraph names the studio's hours as an answer, not as a rule for the line ("when no one can pick up" is any time the line rings). |
| 13d | More than one language? | No. |
| 14 | The phone line itself? | Nothing. |
| A | Generated wording (the skill's rule: only where the paragraph asks) | The read-back's summary only: a framed line ([A framed line](../../.claude/skills/create-app/patterns.md#summarizing-what-the-caller-said-a-framed-line-generate)). `confirm_take_message` with `generate: { summary: { from: message, goal, words: 20 } }`, `summarizesConfirmed: true`, `when: { situations: [first-ask] }`; the form's `summary: { onNo: read-back }` with `read_back_exact`. No `wording: generative` and no `mode: generative` anywhere. |
| B | Where a transfer goes | "transferred to the studio's main line": app.yaml's `transfer: { default: env.STUDIO_MAIN_LINE }`, every handoff (urgent, a person, max attempts) to the one line ([Where a transfer goes](../../.claude/skills/create-app/patterns.md#where-a-transfer-goes-and-what-goes-with-it-transfer)). The variable is in `.env.example` with a 555 number. |
| C | Schedules and whereabouts | "the desk never says anything about the people's schedules or whereabouts": no tool reads a schedule, no line names one, and an informational intent, `whereabouts`, answers such a question with a fixed refusal and an offer to take a message (`no_whereabouts`). The span is worded from the caller's own words only, so it cannot carry anything the studio knows. |

## Actions

| Tool | Reads | Writes | Params (exactly what it sends: `params` in code) | Level | Rules, in order |
|---|---|---|---|---|---|
| `leaveMessage` | nothing | a message in the studio's inbox (a stub, in memory), idempotent by `ctx.idempotencyKey` | `recipient, caller, phone, message` | 0 | `identity`, `confirmed: [recipient, caller, phone, message]` |

Its reply is `{ ref }`, checked with `replyShape.object({ ref: replyShape.code() })`: no line says it, but the audit records it with the write.

## What is recorded

| Param | Slot, with its redact setting (or "not a slot") | Recorded as (`audit`, or the slot's) | Why |
|---|---|---|---|
| `recipient` | `recipient`: a choice, no redact | `keep` | one of four keys |
| `caller` | `caller`: a name, no redact | `length` | a person's name, in their own words |
| `phone` | `phone`: digits, `last4` | the slot's | an identifier |
| `message` | `message`: text, `redact: none` | `length` | the caller's own words: the inbox gets them, the records do not |

A trade-off, written down: the `message` slot is `say: null` (the read-back and its fallback say the words) with `redact: none`, as the text type requires for `say: null`. So the slot's value, the message as said, is in the trace and on the console's call detail, though the action's param is recorded by its length in the gate event and the audit. See Gaps.

## Who may do what

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate |
|---|---|---|---|---|
| `leaveMessage` | allowed, with exactly the values read back and confirmed | (none: no subjects) | (none) | (none) |

## Verification (identity.yaml)

None: the app verifies no one.

## Confirmed writes

| Action | Read back as (the summary line) | Values the caller confirms |
|---|---|---|
| `leaveMessage` | "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said: {summary}. Shall I pass it on?" ({summary} generated the first time, from `message`; else the message word for word) | `recipient, caller, phone, message` |

The app's one list of confirmed fields: `recipient, caller, phone, message`.

## Bounds

None.

## Informational answers

| Intent | The fixed line |
|---|---|
| `studio_hours` | "The studio is open weekdays, nine to five." |
| `studio_address` | "The studio is at 418 Juniper Lane, Suite 2, in Example City." |
| `whereabouts` | "I'm not able to say where anyone is or when they're in, but I'm happy to take a message for them." |

## What goes to a person

| When | Reason | Line |
|---|---|---|
| The caller asks, at any time | `live-agent` | `handoff_live_agent` |
| The caller says it is urgent, at any time (a priority intent) | `urgent` | `handoff_urgent` |
| A detail not given after three tries | `max-attempts` | `handoff_max_attempts` |
| The inbox's reply fails its check | `result-unchecked` | `handoff_needs_human` (no `handoff_result_unchecked` line) |

All go to `STUDIO_MAIN_LINE` (app.yaml's `transfer.default`).

## Choices the paragraph left open

- **The frame's words.** The paragraph's example is "Thanks, I'll make sure Riley gets your message: Alex Rivera called and said, in short, the logo files are ready for review." The frame used is "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said: {summary}. Shall I pass it on?". "in short" is dropped: the same frame is said with the caller's exact words (after a no, on a repeat, on a later reading and on every fallback), where "in short" would not be true (patterns.md: the frame must read true either way). The callback number is in the frame, since the read-back is where the caller hears the whole number the offer named by its last four, and "Shall I pass it on?" makes the read-back the confirmation. See Gaps.
- **"the team"** is how the line names "anyone" ("I'll make sure the team gets your message"); its inbox is a shared one.
- **The call ends after a message** (`{ kind: 'end' }` on `message_taken`, then "Goodbye."), as the paragraph says ("Before saying goodbye it reads the message back"). A second message for another person is a second call.
- **"Lets them say it again"**: a bare no reads the exact words back and asks again; "no, let me say it again" (a no naming the message) asks for the message again; a second bare no asks `ask_change`, worded to say both ("You can give me the message again, or ask me to read it back.").
- **The span's word budget** is 20 (the default is 25): "briefly". The style's persona is "a warm, brief receptionist at a small design studio".
- **The summary only the first time** (`when: { situations: [first-ask] }`): every later reading is the exact words, so a caller who has heard the gist and said no is never given another paraphrase.
- **Prescribed lines**: the handoff lines and `message_taken` are `prescribed: true` (the skill's rule where the paragraph does not say what is regulated). No other line is generated anyway; marking them keeps them fixed if a form is ever switched to generated wording.
- **A message that mentions a deadline** is still a message; a caller who says the matter is urgent is `urgent` (the criteria say so). Whether the real model draws that line well is for the recording to show.
- **The whereabouts refusal** is an informational intent rather than leaving such a question to `other`, so the line says plainly that it will not say, and offers a message.
- **The hours are an answer, not a route**: the line takes messages at any hour (no `hours` in app.yaml).
- **The address**: "418 Juniper Lane, Suite 2, in Example City", invented.
- **The keypad menu**: 1 a message, 2 the hours, 3 the address, 0 the main line (`fromGreeting` not set: the menu is offered after two misses, the default).
- **The adversarial suite** is on, as the scaffold sets it.

## Gaps

| What | The framework | What I did | Cost |
|---|---|---|---|
| The paragraph's frame says "in short" before the summary | A framed line has one frame, said both with the generated summary and with the exact words (on a no, a repeat, a later reading, a fallback); there is no frame for the summary and another for the exact words | Dropped "in short"; "called and said:" reads true either way | A wording the owner asked for is not said. A frame per case (`text` with the summary, another with the exact words) would let the paragraph's wording stand |
| `pnpm configure` and a transfer target | `configure` writes `HANDOFF_NUMBER` but not the variables app.yaml's `transfer` names; the server refuses to start without `STUDIO_MAIN_LINE` (`pnpm diagnose` says so) | `.env.example` has `STUDIO_MAIN_LINE=+15555550100`; the README tells a person trying it on a laptop to add it | One manual step on the "try it with no keys" path, found only by running `diagnose` |
| Recording with two keys in two files | `regress` reads one settings file (the app's `.env`, or the one `ENV_FILE` names); the decision model's key and the render key kept in separate files cannot both be read without a shell `source` (which the skill forbids) | The README gives two ways: the render lines in the app's `.env`, or both keys in one file named by `ENV_FILE`, the provider and the timeouts on the command line | The owner must copy one key next to the other |
| The message in the trace | A `text` slot with `say: null` must be `redact: none`; the param can be recorded by its length (`audit: length`), but the slot's value is in the trace and on the console as said | Recorded the param by length, and wrote the trade-off down | The caller's words are kept in the trace; a framed line has no way to read the words back while keeping them out of the trace |
| A message said in one breath with the other details | The `text` slot's value is the whole turn's words (or one part of them with `pick`, which could cut a real message short) | Kept the whole turn: "hi, it's Alex Rivera for Riley Moreno, the logo files are ready for review, call me back on ..." is the message, name and number included | The read-back's exact words repeat the name and number; the generated summary usually will not |
| The app map draws `urgent` as "Completes without calling an action" | A form whose `complete` hook hands off is not drawn as a handoff | Nothing; the handoff is in "Where a handoff goes" and in the scripted calls | A reader of APP-MAP.md may not see that urgent goes to a person |
| `handoff_result_unchecked` | The skill does not mention the line; without it a reply that fails its check says `handoff_needs_human` | Left it to `handoff_needs_human` (prescribed) | None |

No `FAIL adversarial` case and no `screened` finding on the stub: the suite holds 26/26 (injection 9, off-scope 8, hostile-reply 2, wording 7).

## Baseline edits

The baseline was made once with `regress --update` on 2026-10-13 (117 corpus outcomes, 39 scripted calls) and read entry by entry against this worksheet; no entry was edited by hand since.

| Entry | Field | Before -> after | Why |
|---|---|---|---|
| | | | |

## Recordings

Not recorded yet: the owner's step (README, "Recording against the real models").

## Final checklist

- [x] Every sentence of the paragraph is a row above, and every row is built.
- [x] Every decision has its answer, each option it led to is built, and each option's pattern's **Test** calls are scripted (the callback offer accepted, declined, declined then nothing, another number, withheld, keyed, the chat; a read-back answered yes, no, no then the message again, a recipient and a number corrected; urgent at the start, mid-form and at the read-back with a correction).
- [x] Every intent has at least eight corpus lines (terse ones, and for forms, over-answering ones and a correction) and at least one scripted call.
- [x] Every slot has at least five answers in the corpus, the summary seven.
- [x] Every action has a policy entry; `policy.matrix` is written with `pnpm policy:matrix`, read, and tested (`expectPolicyMatrix`, `policyInvariants`); no bounds; no custom rule.
- [x] Scripted calls cover the form, the anonymous caller (the only principal), each handoff (a person on request at the start, inside the form, at the read-back and on the keypad menu; urgent; max attempts), keypad entry (the number, and the menu's keys) and each informational answer (spoken, and the hours and the address by key). No identity, so no step-up, verification or delegate calls.
- [x] No `identity.yaml`: the paragraph says nobody verifies.
- [x] The policy read back (`policy.matrix`, `POLICY.md`, `APP-MAP.md`) matches "Who may do what", and the card matches the paragraph: one action at level 0, confirmed; the span listed as the only generated part, with its goal, its content and its budget; the prescribed lines.
- [x] Every tool lists its `params`, every param has a row under "What is recorded", and the card's table says the same; the message kept in the trace is written down as a trade-off.
- [x] No tool decides who may do what; every line a caller hears is in `prompts.yaml`.
- [x] Every tool whose reply a call is made from or the audit records checks it (`check`); app.yaml says `testing: { adversarial: on }`, and the regression prints `adversarial 26/26 cases hold` with no `FAIL adversarial`.
- [x] No knowledge base.
- [x] Nothing private or real: invented names and street, 555 numbers, `example.com` addresses.
- [x] `pnpm check` ok; `pnpm verify` green; every app's regression and the testkit's say `no changes`.
- [x] The baseline was made once with `regress --update`, read entry by entry; no later edit.
- [x] `.github/workflows/ci.yml` runs this app's regression; `pnpm-lock.yaml` is committed.
- [x] `README.md` says what the app does and how it is built, and keeps the recording steps (with the render model's); `CLAUDE.md` matches the folder.
- [x] The gaps above are written up.

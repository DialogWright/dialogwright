# Example Front Desk: design worksheet

Built with the create-app skill (`.claude/skills/create-app/`) by an AI coding assistant (Claude Opus 5.5) on 2026-10-13, from the paragraph below. The business name, "Example Front Desk", was given with the paragraph. Revised on 2026-10-14, once the framework covered what the first build found (Gaps): the paragraph's "in short" restored with a frame for the exact words (`exactText`), and the message kept out of every record (`redact: length-summarized`).

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
| `take_message` | the message, in the caller's words | `message` | `text`: `say: null`, `redact: length-summarized`, maxLength 400 | no | by its length in every record; sent whole to the render model only for the read-back's span (see "What is recorded") |
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
| 12 | What should the person taking a transfer see? | `handoff.data.unconfirmed: mark` (the default for a new app), every slot (the default `slots: all`; the callback number by its last four, as recorded; the message by its length, as `length-summarized` hands it over whatever `handoff.data` says). |
| 13 | Half-understood callers, corrections at the read-back, silence after "anything else?" | The paragraph is silent: the defaults. |
| 13b | Nice-to-have details; a caller who cannot answer | Every detail is needed for the message: the engine's ladder (three tries, then the main line). |
| 13c | Anything before the request, after identity or after a form? | No routes. The paragraph names the studio's hours as an answer, not as a rule for the line ("when no one can pick up" is any time the line rings). |
| 13d | More than one language? | No. |
| 14 | The phone line itself? | Nothing. |
| A | Generated wording (the skill's rule: only where the paragraph asks) | The read-back's summary only: a framed line ([A framed line](../../.claude/skills/create-app/patterns.md#summarizing-what-the-caller-said-a-framed-line-generate)). `confirm_take_message` with `generate: { summary: { from: message, goal, words: 20 } }`, `summarizesConfirmed: true`, `when: { situations: [first-ask] }`, its `text` saying "called and said, in short, {summary}" and its `exactText` "called and said: {summary}"; the form's `summary: { onNo: read-back }` with `read_back_exact`. No `wording: generative` and no `mode: generative` anywhere. |
| A2 | The caller's words in the records | Kept out, deliberately: the message slot is `redact: length-summarized` (guide 16.3, 16.5), the app's demo of that setting. The words are kept in the session for the call and sent whole to the render model only for the span; every caller's words, on every turn, are kept by their length in the trace, on the console and in the frame log (no frame-log replay; `kb:gaps` finds no caller questions); the audit and a handoff get the message by its length. |
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
| `message` | `message`: text, `length-summarized` | the slot's (by its length; no `audit` line, which `pnpm check` would refuse as a duplicate) | the caller's own words: the inbox gets them, the records do not |

What `length-summarized` costs, accepted: no caller's words are in the trace, the console or the frame log, on any turn (the message may come on any), so a call cannot be replayed from its frame log and `kb:gaps` finds no caller questions; the person on the main line gets the message by its length from a transfer. The words go whole to the render model (and to the decision model's checks of the span) only to summarize them; the policy card says so.

## Who may do what

| Action | Anonymous | Subject, level 1 | Subject, level 2 | Delegate |
|---|---|---|---|---|
| `leaveMessage` | allowed, with exactly the values read back and confirmed | (none: no subjects) | (none) | (none) |

## Verification (identity.yaml)

None: the app verifies no one.

## Confirmed writes

| Action | Read back as (the summary line) | Values the caller confirms |
|---|---|---|
| `leaveMessage` | "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said, in short, {summary}. Shall I pass it on?" ({summary} generated the first time, from `message`); with the exact words, "... called and said: {summary}. Shall I pass it on?" (`exactText`) | `recipient, caller, phone, message` |

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
| The inbox's reply fails its check | `result-unchecked` | `handoff_result_unchecked` ("I couldn't confirm your message was passed on, so let me put you through to the studio's main line.") |

All go to `STUDIO_MAIN_LINE` (app.yaml's `transfer.default`).

## Choices the paragraph left open

- **The frame's words.** The paragraph's example is "Thanks, I'll make sure Riley gets your message: Alex Rivera called and said, in short, the logo files are ready for review." The line's `text` keeps it: "Thanks, I'll make sure {recipient} gets your message: {caller}, on {phone}, called and said, in short, {summary}. Shall I pass it on?", said only with a generated summary. Its `exactText` says "called and said: {summary}", said whenever the span is the caller's exact words (no model, a fallback, after a no, a repeat, a later reading), where "in short" would not be true. The callback number is in both, since the read-back is where the caller hears the whole number the offer named by its last four, and "Shall I pass it on?" makes the read-back the confirmation.
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

What the paragraph asks that the framework did not do, or did differently, when the app was first built (2026-10-13); what I did then; and what the framework does now. The findings went to the maintainer, and every row but the last two is closed: the app now uses what the framework added.

| What | The framework, then | What I did then | Now |
|---|---|---|---|
| The paragraph's frame says "in short" before the summary | One frame, said with the summary and with the exact words alike | Dropped "in short" ("called and said:") | **Closed.** A framed line's `exactText` is the frame for the exact words ([guide 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)): `text` keeps the paragraph's "in short", `exactText` says "called and said:" |
| `pnpm configure` and a transfer target | `configure` wrote `HANDOFF_NUMBER` but not `STUDIO_MAIN_LINE`, which the server needs to start | `.env.example` and the README said to add it by hand | **Closed.** `configure` asks for each number app.yaml names (`--number STUDIO_MAIN_LINE=...`) |
| Recording with two keys in two files | `regress` read one settings file | Told the owner to copy one key next to the other | **Closed.** `ENV_FILE` names several files, separated by commas (`ENV_FILE=apps/secretary/.env,<your render.env>`); the README's recording command uses it |
| The message in the trace | A `text` slot with `say: null` had to be `redact: none`, so the message as said was in the trace and on the console | Recorded the param by length (`audit: length`), wrote the trade-off down | **Closed.** `redact: length-summarized`: the message is kept by its length in every record, and sent whole to the render model only for the span. The app now keeps no caller words in its records at all (see "What is recorded") |
| `handoff_result_unchecked` | The skill did not mention the line | Left it to `handoff_needs_human` | **Closed.** The skill names it; the app has its own line (prescribed) |
| A message said in one breath with the other details | The `text` slot's value is the whole turn's words (`pick` could cut a real message short) | Kept the whole turn as the message, name and number included; scripted (`message-all-in-one-breath`), so the baseline shows it | **A known limit**, documented in [guide 16.3](../../docs/guide/16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line): the exact-words reading repeats the name and number; the summary usually leaves them out |
| The app map drew `urgent` as "Completes without calling an action" | A form whose `complete` hook hands off was not drawn as a handoff | Nothing; the handoff is in "Where a handoff goes" and in the scripted calls | **Eased.** The map now says the hook decides in code what follows (a line, the end or a handoff) |

Found while revising (2026-10-14), for the maintainer:

| What | The framework | What I did | Cost |
|---|---|---|---|
| The scaffold's `src/fixtures.test.ts` runs the corpus and scripted calls with no renderer, while `regress` on the stub words generated lines with the fake renderer | With `exactText`, the two differ: a scripted call that expects the summary frame ("in short") passes in `regress` and fails in `pnpm test`, which hears the exact-words frame | Gave this app's `fixtures.test.ts` the fake renderer (`renderer: { client: new FakeRenderClient() }`), as `regress` does | One failing test to diagnose; the template (`packages/dialogwright/templates/app/src/fixtures.test.ts`) would meet it in every app with a framed line and `exactText` |
| The fake renderer's span drops the end of a message, a negation with it ("..., no changes needed" summarized as "the brochure proofs are back from the printer") | The `negation` check holds a clause restated without its negation, not a clause left out; a dropped clause is the drift check's to judge (in the stub, its deterministic judge passes it) | Nothing: a real model's span is judged by the real drift check once recorded | A summary that leaves out a "no changes needed" is a meaning a caller may care about; the recording will show how the real model and judge treat it |

No `FAIL adversarial` case and no `screened` finding on the stub: the suite holds 26/26 (injection 9, off-scope 8, hostile-reply 2, wording 7).

## Baseline edits

The baseline was made once with `regress --update` on 2026-10-13 (117 corpus outcomes, 39 scripted calls) and read entry by entry against this worksheet; no entry was edited by hand since. The 2026-10-14 revision (`exactText`, `length-summarized`, `handoff_result_unchecked`) changed no entry: the baseline holds each turn's decision, prompt id, acknowledgements, gate and slots, none of which moved. Two scripted calls' own expectations (`message-read-back-summarized`, `message-long-read-back-summarized`) now expect "called and said, in short,", the frame said with a generated summary; the calls that hear the exact words still expect "called and said:".

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

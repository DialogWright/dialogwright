# 17. Tuning with live calls

[Contents](README.md) · Previous: [16. Generated wording](16-generated-wording.md)

An app green on the stub and on its recording has been tried on its own words: the corpus and the scripted calls, read by the real model once. A live call adds a carrier, a recognizer, a room and a person who does not know the script. This chapter is the working method for what comes next, in the order an author meets it: a call is made, read in the console, a question is found to be the problem, the fix is measured, and the recording is redone. Its examples are from a day of live calls to the secretary demo (`apps/secretary`, Example Front Desk, a message line for a design studio) on 2026-10-14; the names and numbers in them are invented. What the calls found, and what the engine changed for each, is in [the live findings, items 22 to 29](../designs/2026-10-13-live-findings.md#as-built-22), and the app's own record of each recording is its [DESIGN.md, "Recordings"](../../apps/secretary/DESIGN.md#recordings).

## 17.1 What live calls find that recordings do not

A recording sends the model the corpus's text, typed, one line at a time. A call sends it what a recognizer heard, cut where the caller paused, with whatever else was in the room. The secretary's live calls found five things no recording had shown:

- **A message split in two.** A caller who pauses mid-message ("hi Riley, this is Alex Rivera." and, a second later, "could you send me that updated spreadsheet") reaches the engine as two final prompts. The model reads each for whether the caller finished (`utteranceComplete`); on a carrier that reports the caller speaking, a reply to words that read unfinished is held (`INCOMPLETE_WAIT_BELOW`, `INCOMPLETE_WAIT_MS`), and the pieces are joined into one turn (`voice.continueWithinMs`, `RESUME_AFTER_PAUSE_MS`). The secretary sets `continueWithinMs: 900`, since a message is the longest answer it takes. [13.8](13-channels.md#138-a-caller-who-had-not-finished-and-how-a-word-is-said) has every setting.
- **A trailing "thanks" tipping a score under its bar.** "hi riley this is alex rivera i was just calling to see if you could send me that updated spreadsheet thanks" read `messageGiven` 0.58, and 0.63 without the "thanks": one word either side of the slot's bar (`SLOT_DETECT`, 0.6). A recording of the same line without the word would have passed. (17.4 is what was really wrong.)
- **Background noise.** A television, traffic or a second voice comes to the recognizer as stray words, or as speech with no words. The gates read such a turn as not addressed to the line (`addressedToSystem`) or not made out (`intelligible`), and on a carrier that reports the caller speaking the no-input wait is held while it lasts ([13.11](13-channels.md#1311-the-no-input-wait-and-a-caller-heard-speaking)). The corpus has only what you wrote.
- **A bare "yes" read as a message.** At the read-back the caller said "yes": the confirmation read a clear yes (0.98), but the message slot's own question read the word as a message at 0.60, over its bar, and the message became "yes". In the recordings "yes" there had read low. The engine now takes a yes to a form's summary as accepting what was read back (17.8).
- **A read-back interrupted mid-number.** A caller who talks over the read-back while it says the callback number is reported with what they had heard of the line, cut off part way through the digits. The console notes it under the line ("caller talked over this, 0.7 s in", [13.12](13-channels.md#1312-what-happened-on-the-line-in-the-console)), and the records mask the start of the number from three of its digits ([`records`](02-the-files-one-by-one.md#what-the-records-keep-of-the-numbers-records)).

**Trace every live call.** The server writes two files per call into `TRACE_DIR` (each app's folder on a host): the trace, `<call>.jsonl`, a record per turn with every question the model was asked, its answers and the turn's timings; and the frame log, `<call>.frames.jsonl`, every frame in and out with its time (`ts`), the carrier's events among them. Both are on by default. While tuning, keep them long enough to come back to (`TRACE_RETENTION_DAYS`, [14.10](14-running-it.md#1410-keeping-the-disk-in-check)), and write each surprise down as a corpus line or a scripted call, with the live reading as the line's `answers` where the stub would answer otherwise (the secretary's `sm-08`, "yes" at the read-back, carries `"answers": {"messageGiven": {"noul": 0.6}}`), so the stub regression holds the fix from then on.

## 17.2 Keep the caller's words visible while tuning

A call you cannot read is a call you cannot tune. What the records keep of a `text` slot's words is the app's choice, and the text type has three ([docs/slots/text.md](../slots/text.md)):

- `redact: length`, the default: the words leave the turn as their length only (the trace, a tool call's param), and the read-back says a stand-in (`say`, "your description").
- `redact: length-summarized`: the words are kept for the call and sent whole to the render model only to summarize them in a framed read-back; every record masks them by their length, and with them every caller's words on every turn, so the console shows lengths and the frame log cannot be replayed ([16.3](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)). The secretary ships with this.
- `redact: none`: the words as said, in the trace and on the console.

The shipped secretary keeps no caller's words, by design, which is right for its callers and useless for its author on a day of test calls. So tune on a private copy of the app, kept outside the repository (a project of its own, as `npm create dialogwright` makes: [11](11-walkthroughs.md#where-to-start)), and change only its records there:

```yaml
# slots.yaml, in the private copy only
message:
  type: text
  what: the message the caller wants to leave
  say: null
  redact: none
```

```yaml
# policy.yaml, in the private copy only
audit:
  recipient: keep
  caller: length
  message: keep      # or length: the trace and the console keep the words, the audit their length
```

`pnpm check` asks for the `audit` line: a slot with no redact setting is recorded as policy.yaml says, and it prints the fix (`declare it under audit in policy.yaml ("message: keep" to record it as it is, ...)`). The policy card's "What is recorded" changes with it ([3.9](03-policy-and-identity.md#39-what-is-recorded-audit-and-the-rule-names)): write it again in the copy (`pnpm policy:card`), and keep the change out of the shipped app. The copy's traces hold real callers' words: they stay on your machine, never in a repository.

## 17.3 Read a call in the console

The console ([14.9](14-running-it.md#149-looking-at-calls-from-your-phone)) is where a call is read. By default it answers only on the server's machine (`CONSOLE_AUTH=local`); `CONSOLE_AUTH=token` and `pnpm console:link` serve it to your phone behind a sign-in.

- **Find the call.** **Calls** lists the calls from the traces, newest first; filter by the caller's last four digits and the day. A click opens its replay. A call is named as its trace file is: every character of its id outside letters, digits, `_` and `-` made `_`, so a Telnyx call `v3:Ab12...` is the file `v3_Ab12....jsonl`, and a call id copied from the carrier's portal is found by that name in `TRACE_DIR`.
- **Step through it.** The replay bar's **▶ step**, or the arrow keys, moves a turn at a time. The conversation shows each question with its answer (**Turns**) or just what was said (**Script**); the gate card shows what decided the turn.
- **Read the perception panel.** **Perception** shows what the model answered on the turn, a row per question with its bar and its value. It opens on **top signals**, the rows that decided; **Show all** lists every row, grouped: the gates, the intent, the confirmation when one is pending, then a group per slot of the form (`slot · message`). A group with nothing decisive is folded (`(4 quiet)`), and a click opens it. The slot the line asked for on that turn is always shown open, its rows among the top signals: its question decides the turn even when it misses its bar, since a miss is what sends an ask-again (`ask_message_retry`). That is where "the message was asked for again" is explained: `messageGiven 0.08`, under 0.6.
- **Timing.** Each trace record has the turn's times (`timing`): `askMs` for the decision model, `renderMs` for the turn's generated lines, `totalMs` for the turn; a generated line's own wording and checks are in its `render` record. The frame log has the rest, to the millisecond: when the caller's prompt arrived, when the reply went out, and the carrier's own reports (`{ carrierEvent: ... }`).
- **What was played, against what was sent.** The line sent is the frame log's `out` frame; what the caller heard is the carrier's report of its playback (Telnyx's `tokensPlayed`, with `TELNYX_EVENTS` asking for it). The two differ where the voice spells a number digit by digit ("on 5 5 5, 5 5 5, 0 1 4 2") or the carrier cut the line short, which the console notes under the line ([13.9](13-channels.md#139-a-line-the-carrier-cut-short), [13.12](13-channels.md#1312-what-happened-on-the-line-in-the-console)).

A call's frame log replays offline as the call ran, turn by turn: `pnpm --filter <app> cli --replay <TRACE_DIR>/<call>.frames.jsonl`. An app with a `length-summarized` slot refuses it, since its frame log keeps no caller's words: one more reason to tune on a copy (17.2).

## 17.4 A score near 0.5 is a coin toss: suspect the question first

A reading that lands near 0.5 on a plain line means the model was not sure what it was asked, and the usual reason is the question, not the model. Read the question before raising or lowering a threshold.

The secretary's first live call: four messages at "Go ahead with your message." read `messageGiven` 0.03 to 0.08, and the line asked for the message three times, then put the caller through to a person. The text type's default question ended "A request alone is not {what}". It was written for a caller who asks to leave a message without leaving one ("can I leave a message?"), and it told the model that "could you send me that updated spreadsheet" was not a message. The secretary's own `instructions`, added after the question, said the opposite ("A request to be called back about something is a message too"), and a model given two contradicting rules lands near the middle: the real messages read 0.03 to 0.63. The new default ([live findings item 29](../designs/2026-10-13-live-findings.md#as-built-29)) asks for what is meant, the app's `instructions` following it:

> Read asr.text. Does the caller give the message the caller wants to leave? Only asking to give it, without saying it, is not.

Recorded again, the same requests read 0.96 to 0.97, "just say Alex called" 0.60 and 0.78, and what is not a message ("hmm, what should I say", "I'd rather not say what it's about") 0.02.

- **Read the whole question.** What the model is sent is the engine's template and the app's words together: a slot type's question ([docs/slots/text.md, "The question"](../slots/text.md#the-question)) with the slot's `what` and `instructions`, an intent's criteria, the gates' own questions. `regress --client recorded --corpus <id>` (or `--scenario <id>`) prints each question a turn was asked and its answer, and `--questions` adds each question's words as the model is sent them and each reading against its bar, named as in `core/thresholds.ts`; the console's perception rows name them by id. Read them for two rules that pull apart.
- **Word it for what you mean, not the rare case you fear.** "A request alone is not a message" guarded against one caller in a hundred and turned away the ninety-nine. Say the common case plainly and the exception narrowly ("only asking to give it, without saying it").
- **Then the threshold, if at all.** A bar moved for one app's quirk moves it for every line it reads ([5, Thresholds](05-writing-a-slot.md#thresholds)): measure a change across the app's recording, never on one call.

## 17.5 Change a question's words, then record again

Every request carries the questions' words, so a change to a slot's `what` or `instructions`, an intent's criteria, the app's wording or the engine's template changes every request that asks it, and the recording misses on each until it is made again. Plan it:

1. **Fix first what sends nothing new**, checked on the recording you have: code, policy, a flag, a label, a tag ([the triage page's order of the fixes](../../.claude/skills/create-app/triage.md#the-order-of-the-fixes)). A changed step of a scripted call, even a silence, changes what its later turns are sent, so they miss until the next recording.
2. **Reword everything at once**, on a branch. The stub regression stays green (the stub reads labels, not questions); the replay misses, as it should.
3. **Record on the branch.** Recording calls a paid API with the owner's key: it is the owner's step (`pnpm --filter <app> regress --client record`, the command the app's README gives), never an assistant's or CI's.
4. **Triage** the new recording (17.6), then `cassette:trim`, and commit the cassette with the triage.
5. **Merge** once the replay is clean.

Never push a branch whose recorded run is red: CI replays the committed recordings (`regress --client recorded`), and a red run is a failure for everyone. A branch waiting for its recording stays local. Keep a cassette miss honest: it means the request changed, not that the model misread, so it is never tagged as a known gap; it is closed only by recording.

## 17.6 Triage a recording

`regress --client recorded` compares what the real model did with the stub's baseline, and its last line counts what is left: `to triage: 0 untagged corpus differences, 0 failing scripted calls, 0 passing scripted calls that differ from the baseline, 0 cassette misses`. The full procedure is the create-app skill's [triage page](../../.claude/skills/create-app/triage.md); the part a live day leans on is the known gap.

A `knownGap`, on a corpus line or a scripted call, records a borderline reading whose outcome is safe and which the owner accepts, with the reason and the model's numbers ([after a recorded run](11-walkthroughs.md#after-a-recorded-run), [known gaps](../known-gaps.md)). Two from 2026-10-14:

- **The check before the message.** "sure, okay" after the line offered to take a message read `take_message` 0.55 against `none` 0.45, so the caller was asked "do you want to leave a message? Yes or no." (`confirm_intent_explicit`) before the recipient: one more yes, and safe. The secretary's scripted call `whereabouts-then-sure` carries the tag, accepted by the owner.
- **One word.** "agent" at the utility's opening read `agent` 0.75 and `wantsHuman` 0.74, but `intelligible` 0.42 under its 0.45 gate, so the caller heard the open question again and could say it again. The utility's `ag-02` carries the tag.

What a known gap is not for: a cassette miss (17.5), and an outcome that is not safe (an emergency read as an answer, a message delivered wrong). Those stay failing, as evidence, until the app or the engine changes. When the run says `knownGap now matches: <id>`, the model now reads the line as labelled: remove the tag.

## 17.7 Dictation: when the line asks for free text, the turn is the content

"Go ahead with your message." asks for words, and almost any words are a message: "could you send me the spreadsheet" is a request, a message is words meant for someone else (which is what the question of an aside looks for), "it's not urgent, but..." names urgency. No line can take free transcribed words and also listen for commands in them. So a `text` slot says whether the turn at its own question is read for requests, with `commands` ([docs/slots/text.md](../slots/text.md#the-turn-is-the-words-commands)):

- `commands: ignore`, the default for a slot without `pick`: the turn is the slot's words, whole. No bar on its question, and nothing in it acted on: no intent, no priority switch, no request for a person, no menu number, no frustration rung.
- `commands: listen`, the default with `pick`: the turn is read as any other, and the words fill the slot only where its question reads them as given.
- `commands: { listen: [urgent, agent] }`: as `ignore`, but the intents listed are acted on.

The read-back is the safety net: the caller hears the words and can say no. What still applies on such a turn: the injection screen, silence and no input, words the model cannot make out (`intelligible`, asked again), and an unfinished answer joined to the rest (17.1). The other slots of the form are quiet on that turn by default (`others: quiet`; `others: listen`, or `{ listen: [howUrgent] }` for the ones that should still hear it, [docs/slots/text.md](../slots/text.md#a-dictation-turn-is-the-slots-others)): the secretary's recipient, Riley, stays Riley when the message says "could someone send it again".

In an app with a priority intent, `pnpm check` warns of a text slot without `pick` that says no `commands`, since an emergency said at its question is read back as the words: say which you mean, `commands: { listen: [<the priority intents>, agent] }` or `commands: ignore` ([must never wait](02-the-files-one-by-one.md#must-never-wait-priority)). The secretary writes `commands: ignore`: "it's urgent" said as the message is read back as the message.

## 17.8 The read-back: yes, yes with more, and no

A form's summary is the caller's last word before anything is done ([forms.yaml](02-the-files-one-by-one.md#formsyaml)):

- **A clear yes accepts it.** The yes's own words never replace what the caller just heard: the "yes" that became a message (17.1) is kept out.
- **A yes with new words.** "yes, but tell her it's moved to Thursday" is judged by one more question, asked at the read-back only, the slot's `<slot>Changed` (`messageChanged`: "Besides agreeing or disagreeing, does the caller add to or change the message?"). At `SUMMARY_WORDS_CHANGED` (0.6) or more the turn's words are added after the words accepted, exactly as said, nothing dropped or reworded, and the summary is read again. On the secretary's recording, plain agreements read 0.05, additions 0.97 and a change 0.92.
- **A yes that names another detail.** "yes, but it's for Sam" changes only the slot it names, and the summary is read again.
- **A no.** With the form's `summary: { onNo: read-back }`, a bare no reads back the exact words (`read_back_exact`, then the line with the words as said) and a second no asks what to change (`ask_change`); a no that names the message asks for it again.

What a yes changes is read back before anything is done where the action's `confirmed` rule holds the write to what the summary said, as the secretary's does ([3](03-policy-and-identity.md)); an action without one goes on with the new values.

## 17.9 A generated summary in the read-back

The secretary reads the message back as a receptionist would, its summary a span the render model words inside a fixed frame ([16.3](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)), heard as: "Thanks! I'll make sure Sam Okafor gets your message, in short: the project is done and you need his approval. I have you as Alex Rivera, on 5 5 5, 5 5 5, 0 1 4 2. Shall I pass it on?"

- **Give the model the goal and the context, never a procedure for its words.** An early version told the model to say the caller's "I" and "my" as "you" and "your"; it gave "asking you to call back" for "please call me back" and "your logo files" for files that were not the caller's ([live findings item 27](../designs/2026-10-13-live-findings.md#as-built-27)). The span is now given its goal, the sentence it goes into, the caller's words and the names it may use (`speaks: to-caller`, `names: [recipient]`), and the drift judge reads the same context.
- **A summary's perspective may vary.** One summary speaks to the caller ("you need his approval"), another as the message will be told to its recipient ("the project is done and needs Sam's approval"). A listener works out who is meant from the frame around it; that is not a defect, and the drift judge does not reliably tell them apart (16.13), so do not tune for it.
- **The recipient always gets the caller's exact words.** The summary is said once, to the caller; the slot holds the message as said, and the tool is sent it word for word.
- **The summary is what makes the line sound smart.** Its exact words read back are correct and sound like a machine; a short summary is what a person would say. Keep it for the first reading only (`when: { situations: [first-ask] }`), so a caller who said no hears their own words.

## 17.10 Time budgets

A generated line is worded after the core has decided, within a budget, and checked within another; past either the fixed text is said, which on a framed line is the frame with the caller's exact words ([16.7](16-generated-wording.md#167-running-it), [14.12](14-running-it.md#1412-the-options)):

| Setting | Default | What it bounds |
|---|---|---|
| `RENDER_TIMEOUT_VOICE_MS` | 900 | a line's wording on a call |
| `RENDER_TIMEOUT_CHAT_MS` | 1500 | a line's wording in a chat |
| `RENDER_CHECK_TIMEOUT_VOICE_MS` | 500 | the decision model's checks of it on a call (the content screened again, the drift judge) |
| `RENDER_CHECK_TIMEOUT_CHAT_MS` | 1000 | the same in a chat |

Each channel is set on its own (`RENDER_TIMEOUT_MS` and `RENDER_CHECK_TIMEOUT_MS` set both at once, and a channel's own setting wins). On a call a caller waits at most both, 1.4 s at the defaults; in the maintainer's experience of telephone lines, a caller does not notice a pause under about 1.5 s. Watch a summary's time in the trace (its `render` record) and in Insights' latency per line: a line that falls back as `timeout` more than now and then wants a faster model (17.11) more than a longer budget.

## 17.11 Choosing models by measurement

- **The render model.** `pnpm render:bakeoff apps/<name> --models <provider>:<model>,...` records each model wording the app's own lines and tables them: said generated, fallbacks by reason, wording latency against the call's budget, and cost ([16.12](16-generated-wording.md#1612-choosing-a-model)). On the secretary's span, Gemini 3.1 Flash-Lite (through OpenRouter) was the fastest, wording p50 491 ms and p95 841 ms, with 1 of 15 wordings over the 700 ms budget of the day, where Claude Haiku 5.5 had 14 over it and Gemini 2.5 Flash-Lite 12, and none of its summaries turned who does what. The app names it in style.yaml (`model: { provider: openrouter, id: google/gemini-3.1-flash-lite-preview }`), so every machine's tests replay it.
- **The judge.** `pnpm render:judge-eval` measures the drift judge on labelled cases, with its latency against the checks' budget ([16.13](16-generated-wording.md#1613-measuring-the-judge)). Jev and Microsoft-Decision-1 were compared on the same 180 cases: Jev caught 56 of 64 unfaithful spans and refused 15 of 116 faithful ones (p95 299 ms); Decision-1 caught 48 and refused 3 (p95 370 ms); both fit inside 500 ms, and neither reads who "you" is. Jev stayed the judge: stricter, faster, and every everyday slip caught.
- **Another decision model** that speaks the same API is measured the same way, through `JEV_PROVIDER` and `JEV_MODEL` (with `JEV_BASE_URL` and `JEV_API_KEY` for `JEV_PROVIDER=custom`), its answers kept in a cassette of their own beside Jev's ([fixtures/](02-the-files-one-by-one.md#fixtures-optional)).

Both commands record with the owner's keys and refuse in CI; `--replay` tables a recording again for nothing.

## 17.12 The number the caller is calling from

The callback number is the most fragile answer on a call, so the secretary offers the number calling ([a callback number](05-writing-a-slot.md#a-callback-number-callernumber)): "Is the number you're calling from, ending in 0 1 4 2, the best one to call you back on?" The offer says the last four (`{last4}`), each digit spoken (`sayAs: digits`, [5](05-writing-a-slot.md#a-number-on-the-phone-sayas-and-waitforrestms)); the read-back says the whole number, the one place the caller hears it before the message goes. In the records the number is masked as app.yaml's `records` says, by its last four by default, wherever it appears: our lines as the frame log records them, the carrier's report of what it played, and what an interruption heard of a line cut off part way ([`records`](02-the-files-one-by-one.md#what-the-records-keep-of-the-numbers-records)). On a live call, check that the frame log's playback report shows `…0142`, not the digits.

## 17.13 After a live call

- [ ] Find the call on **Calls** (a Telnyx call by its trace's file name) and step through its replay.
- [ ] At each surprise, open **Show all** on the perception panel, and the slot the line asked for: which question decided, and at what reading?
- [ ] A reading near 0.5 on a plain line: read the whole question (the engine's template and the app's words) for a contradiction before touching a threshold.
- [ ] Compare the frame log's lines sent with the carrier's playback reports and the turn's times; check that the number is masked in both.
- [ ] Write the case down as a corpus line or a scripted call, with the live reading as its `answers`, so the stub holds it.
- [ ] Fix what sends nothing new first; reword all at once, on a branch.
- [ ] Hand the owner the recording command; triage the recording; tag only safe, accepted borderline readings; never tag a cassette miss.
- [ ] Merge only with a clean replay, and never push a red recorded run.

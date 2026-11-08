# Speech over a line the caller cannot interrupt

Decided 2026-11-08 (the maintainer): build `SPEECH_OVER_LINE`, with `unless-miss` as the default.

## What was seen

The call was a live Telnyx call on 2026-11-05: a line shown on a speakerphone in a noisy room, with `BARGE_IN=none`. Barge-in had been turned off because noise kept cutting lines short.

| Time (from the greeting's send) | What happened |
|---|---|
| 0.0 s | The greeting (about 8 s) is sent. `clientSpeaking` goes on 67 ms later: someone in the room is talking. |
| 1.9 s | A final prompt arrives of a sentence said to someone else in the room (words here invented: "can you pass me the blue folder"). The model reads it as addressed to the line (0.94). The intent is `other`, so the turn is a miss, and its no-match line is queued behind the greeting. |
| 12.6 s | A short reply to someone else is heard while the no-match line plays. It is the second miss, so the keypad menu follows. |
| 17.8 s | Another is heard while the keypad line plays. It is the third miss, so the call goes to a person (`max-attempts`). |

The caller never heard a question through to its end. With barge-in off, noise no longer cuts a line short, but Telnyx still transcribes what it hears while the line plays. The engine took each transcript as an answer and counted each miss.

Turning barge-in back on swaps one fault for the other: noise then stops the line. Telnyx has no barge-in sensitivity setting. The decision model cannot tell either, because nothing tells it the line was still playing.

## The option

`SPEECH_OVER_LINE` (env), one of three values:

- `take`: as before. Speech heard over the line is an answer like any other.
- `unless-miss` (the default): the turn runs. What it understands is acted on, so a caller who says "make an appointment" over the greeting still gets one. A turn that would be a miss is set aside as side speech is: decision `ignore`, the session as it was, nothing said and no attempt counted. The line plays to its end and the caller is asked as before.
- `ignore`: no turn runs for speech over the line at all.

It applies only to a final prompt whose speech **started while a line the caller could not interrupt by speech was still playing**:

- The line could not be interrupted by speech when the call's barge-in is `none` or `dtmf` (`BARGE_IN`, `BARGE_IN_<CARRIER>`), or when the line was sent `interruptible: false`.
- Under `any` or `speech`, an interruptible line cut by the caller gives an `interrupt`: that is a barge-in, and nothing here changes it.
- Speech that starts after the lines' expected end is an answer, under every value.
- A key is never affected.

A miss is a turn that understood nothing it acts on at the question it was on. That covers a no-match or retry line, the keypad menu, a question asked again because nothing in the words answers it, and a handoff for too many attempts. A turn that fills a slot, chooses an intent, answers a yes-or-no, asks for a person, asks for a repeat or switches language is not a miss.

Why `unless-miss`: someone who has not heard the whole question cannot have got it wrong yet; they can only have got it right early.

The known weakness: background speech that happens to fit ("can you make an appointment for me?" said to someone else) is acted on, as it would be today. The side-speech reading (`addressedToSystem`) still applies to it.

## When the speech started, and when the lines end

- **The lines' end** is the estimate the no-input wait is armed from: the lines' send time plus their estimated playing time. Telnyx's `agentSpeaking` and `tokensPlayed` follow its TTS pipeline, not the audio. On this call, `agentSpeaking` went off 2.1 s into an 8 s greeting, when the no-match line was sent. So these reports cannot shorten the estimate.
- **The speech's start**, on a carrier that reports the caller speaking (Telnyx with speaker events), is when that report first came for the speech the prompt carries. On a carrier that reports nothing (Twilio), it is the prompt's arrival.

The timing is approximate. A "yes" said just before a question ends may count as over it. Only a miss is ever set aside, so the cost of that error is a caller asked again after the no-input wait, never an answer lost.

## Records and replay

- The frame log notes speech over a line before its turn, and replay reads that note, so a replayed call sets the turn aside where the call did.
- The trace's turn carries the reason it was set aside.
- The startup line names the value.

## As built

Built as designed, with the review's changes of 2026-11-08 below. The guide's [13.16](../guide/13-channels.md#1316-speech-over-a-line-the-caller-cannot-interrupt) is the reference; the row in 14.12, each `.env.example` and [live check 18](../live-checks.md#18-speech-over-a-line-the-caller-cannot-interrupt-on-telnyx-and-on-twilio) go with it.

- **The option.** `SPEECH_OVER_LINE` (`server/config.ts`), `take`, `unless-miss` or `ignore`, the default `unless-miss` (`DEFAULT_SPEECH_OVER_LINE`, `channel/voiceProviders.ts`), any other value refused at startup with the three named, as a `BARGE_IN` is (and so by `pnpm diagnose`). The startup line says `speech over a line unless-miss`. A config made by hand without it, and `AdapterDeps.speechOverLine` absent, read as `unless-miss`. No per-carrier variant.
- **The lines' end** (`server/adapter.ts`, "speech over a line"). Every line `sendFrames` sends is kept as a span: the lines of one send one behind the other from the first line's send, for each line's estimate (`playbackEstimateMs`: 2.5 words a second, a wav by its length, an mp3 at `UNKNOWN_CLIP_MS`), and whether speech can cut it (the call's barge-in `any` or `speech` and the line `interruptible`). A new send starts the lines anew (what was still to play of the send before ends there, `clipLines`), which is how the no-input wait has always counted; the wait now reads its end from the spans (`armNoInput`, `linesEndOf`), so the two can never disagree. A line said again (`resay`, `recoverSpurious`) clips the spans before it goes, and starts from its own send. A carrier's playback reports never shorten a span. The spans and runs are dropped at a new call, a reconnect, a close and when the call is forgotten.
- **The speech's start**: the carrier's report of the run of speech the prompt carries (`followSpeechRun`: begun at a `caller speaking` report, the same run across pauses up to `RESUME_AFTER_PAUSE_MS`, the prompt arriving while the caller speaks or within `NO_INPUT_AFTER_SPEECH_MS` of their stop); else, on Twilio, the first of the run of partial prompts before the final one (`followPartials`, the same pauses; partials are noted before they are dropped); else the prompt's arrival. A pause that spans the end of the lines the run began over ends the run (`pauseAcrossEnd`), so noise in a line's last seconds does not carry the answer just after it into the line. Not looked at: a key, a partial prompt, a prompt joined to held words, one during a service's wait; under `ignore`, a prompt the caller came back in with (`resumesPrompt`, takeResumed's test with the Continuation continuing), which is joined as always.
- **`unless-miss`** marks the event (`UserSpeech.overLine`). The core decides at one point, once the verdict is handled (`core/turn.ts` `overLineMiss`): the turn took a miss's path, which the miss handlers record themselves (`TurnIO.missed`: `failAttempt`, `reaskConfirmation` when it counts, `codeReask`, `notFoundReply`, `caughtFrustration`), on a verdict a miss is reached on (`nomatch`, `intent_failed`, `proceed`, `confirm_unanswered`), and did nothing else (no slot filled, narrowed, disambiguated or helped; no language switched; no knowledge answer; no gate event; no effect). Never set aside: a turn whose summary hook said lines in answer (`TurnIO.replied`), and a code said aloud at the code prompt (`saidCode`: a fresh code, or the person at the ladder's end, as ever). No list of prompt ids, and the attempt count is not read, so a third miss over the line after two real ones is set aside and nobody is put through. Set aside, the turn returns decision `ignore`, no actions, the session it was given with the barge-in marker cleared as side speech clears it, `setAside: 'speech-over-line'`, and its rows with the decided flag taken off, then the gate row `speechOverLine`, outcome `set_aside`, decided. A turn that ran a tool is never set aside.
- **`ignore`** runs no turn: the prompt is logged, the lines are marked heard (not said again for a playback that looks cut), and nothing else; the no-input wait from the lines' end stands, takeResumed and notePrompt are not run, a held reply is not let go.
- **The Continuation** (`run/continuation.ts`). A turn set aside is taken as words that were not the caller's: it is never continued, the Continuation is left idle, and the next prompt is judged over a line on its own (`continuing` is false, so takeResumed logs no `callerResumed` for it). A prompt that continues a taken turn is read over a line where it itself was; set aside, it returns the session it was given, after the fragments' own turns whose lines the caller heard (`TurnContext.setAsideAs`, `runTurn`'s last argument), never the one before the first fragment, and its trace record is of that session. Words held for the rest of a value keep the first fragment's mark.
- **Records.** The frame log has `{ speechOverLine: { mode, afterMs, expectedMs, start: 'speaking' | 'partial' | 'arrival' } }` before the prompt's line, written through `logDelivery`, so the console notes it under the line spoken over (`DELIVERY_NOTES.speechOverLine`, which says only that speech was heard there; what the turn did is its own). Replay (`harness-text/replay.ts` `overLineNoted`) marks the next final prompt, or skips it under `ignore`, as the log says. The trace has the event's `overLine` and the gate row. The server log says `speech 0.07 s into lines it could not interrupt (~8.0 s)` as the prompt comes, then, after the turn, `speech over a line set aside as a miss`, `taken` or `joined to the words before it, and taken` (under `ignore`, `: no turn` at once). Insights counts no turn set aside as a frustrated one (`setAsideOverLine` in the console's `frustratedOn` and in `wordingFigures`).
- **Tests.** `server/speechOverLine.test.ts`: the live timeline under each value; Twilio by arrival and by its partials; speech after the end; a stale report; noise ending just before the greeting's end and the answer just after it, under each value; three misses; a fragment set aside then the rest heard alone; a caller who came back in under `ignore`; a line said again (the answer after its own end, the wait from it); a reply of two lines and the wait after it; a reconnect mid-line; a held reply; a service's wait; barge-in `any`; each replayed where it runs turns. `core/speechOverLine.test.ts`: the open question, words not made out, the keypad rung, the would-be `max-attempts`, a slot's question, the summary, a frustration-only turn, a not-found reply, the barge-in marker, a code said aloud (last rung, earlier) and other words at the code prompt, an offer (a yes taken, words that answer neither set aside), a correction at the summary with and without a no, a summary hook's lines, and the Continuation (a joined turn set aside keeps the session it was given; a set-aside turn is not continued). `server/digitsWire.test.ts` (held words over the question), `server/bargeIn.test.ts` (the setting), `server/dashboard` (no frustrated turn).
- **Tests pinned to `take`**, each with a test of the same timeline under the default beside it. Four files about other things feed answers as soon as a question goes out: `server/callerResumed.test.ts`, `server/digitsWire.test.ts`, one test of `server/deliveryNotes.test.ts`, and the host Insights test of `server/consolePages.e2e.test.ts`. Under the default, on the captured timelines: in the first caller-resumed call, the request over the greeting is taken; "at", said 3.0 s into a reply the estimate gives 4.8 s, is set aside (no re-ask said); and "22 Alder Street.", 3.9 s in, is taken on its own (the place is "22 Alder Street.", not "at 22 Alder Street."; nothing is joined). In the digits call, the nine-digit miss said the moment the question went out is set aside (no re-ask), and the number said after is taken with no attempt counted. The live calls those timelines come from reported their speech and replies, not their playing time, so they cannot say whether the estimate runs long; the gaps the tests put before the first answers (3 s, 0 s) are the tests' own. Live check 18 notes `expectedMs` against what was heard.

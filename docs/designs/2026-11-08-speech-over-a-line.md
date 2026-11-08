# Speech over a line the caller cannot interrupt

Decided 2026-11-08 (the maintainer): build `SPEECH_OVER_LINE`, with `unless-miss` as the default.

## What was seen

The call was a live Telnyx call on 2026-11-05: a booking line shown on a speakerphone in a busy shop, with `BARGE_IN=none`. Barge-in had been turned off because noise kept cutting lines short.

| Time (from the greeting's send) | What happened |
|---|---|
| 0.0 s | The greeting (about 8 s) is sent. `clientSpeaking` goes on 67 ms later: someone in the room is talking. |
| 1.9 s | A final prompt arrives: "i'd like a custom scheduling system okay", said to someone else. The model reads it as addressed to the line (0.94). The intent is `other`, so the turn is a miss, and its no-match line is queued behind the greeting. |
| 12.6 s | "oh sorry" is heard while the no-match line plays. It is the second miss, so the keypad menu follows. |
| 17.8 s | "i see" is heard while the keypad line plays. It is the third miss, so the call goes to a person (`max-attempts`). |

The caller never heard a question through to its end. With barge-in off, noise no longer cuts a line short, but Telnyx still transcribes what it hears while the line plays. The engine took each transcript as an answer and counted each miss.

Turning barge-in back on swaps one fault for the other: noise then stops the line. Telnyx has no barge-in sensitivity setting. The decision model cannot tell either, because nothing tells it the line was still playing.

## The option

`SPEECH_OVER_LINE` (env), one of three values:

- `take`: as before. Speech heard over the line is an answer like any other.
- `unless-miss` (the default): the turn runs. What it understands is acted on, so a caller who says "book a detail" over the greeting is still booked. A turn that would be a miss is set aside as side speech is: decision `ignore`, the session as it was, nothing said and no attempt counted. The line plays to its end and the caller is asked as before.
- `ignore`: no turn runs for speech over the line at all.

It applies only to a final prompt whose speech **started while a line the caller could not interrupt by speech was still playing**:

- The line could not be interrupted by speech when the call's barge-in is `none` or `dtmf` (`BARGE_IN`, `BARGE_IN_<CARRIER>`), or when the line was sent `interruptible: false`.
- Under `any` or `speech`, an interruptible line cut by the caller gives an `interrupt`: that is a barge-in, and nothing here changes it.
- Speech that starts after the lines' expected end is an answer, under every value.
- A key is never affected.

A miss is a turn that understood nothing it acts on at the question it was on. That covers a no-match or retry line, the keypad menu, a question asked again because nothing in the words answers it, and a handoff for too many attempts. A turn that fills a slot, chooses an intent, answers a yes-or-no, asks for a person, asks for a repeat or switches language is not a miss.

Why `unless-miss`: someone who has not heard the whole question cannot have got it wrong yet; they can only have got it right early.

The known weakness: background speech that happens to fit ("can you book a detail for me?" said to someone else) is acted on, as it would be today. The side-speech reading (`addressedToSystem`) still applies to it.

## When the speech started, and when the lines end

- **The lines' end** is the estimate the no-input wait is armed from: the lines' send time plus their estimated playing time. Telnyx's `agentSpeaking` and `tokensPlayed` follow its TTS pipeline, not the audio. On this call, `agentSpeaking` went off 2.1 s into an 8 s greeting, when the no-match line was sent. So these reports cannot shorten the estimate.
- **The speech's start**, on a carrier that reports the caller speaking (Telnyx with speaker events), is when that report first came for the speech the prompt carries. On a carrier that reports nothing (Twilio), it is the prompt's arrival.

The timing is approximate. A "yes" said just before a question ends may count as over it. Only a miss is ever set aside, so the cost of that error is a caller asked again after the no-input wait, never an answer lost.

## Records and replay

- The frame log notes speech over a line before its turn, and replay reads that note, so a replayed call sets the turn aside where the call did.
- The trace's turn carries the reason it was set aside.
- The startup line names the value.

## As built

Built as designed. The guide's [13.16](../guide/13-channels.md#1316-speech-over-a-line-the-caller-cannot-interrupt) is the reference; the row in 14.12, each `.env.example` and [live check 18](../live-checks.md#18-speech-over-a-line-the-caller-cannot-interrupt-on-telnyx-and-on-twilio) go with it.

- **The option.** `SPEECH_OVER_LINE` (`server/config.ts`), `take`, `unless-miss` or `ignore`, the default `unless-miss` (`DEFAULT_SPEECH_OVER_LINE`, `channel/voiceProviders.ts`), any other value refused at startup with the three named, as a `BARGE_IN` is (and so by `pnpm diagnose`). The startup line says `speech over a line unless-miss`. A config made by hand without it reads as `unless-miss`, as `AdapterDeps.speechOverLine` absent does. No per-carrier variant.
- **Over a line** (`server/adapter.ts`, "speech over a line"). Every line the adapter sends (`sendFrames`, so a turn's lines, a hold line, a line said again, a reconnect's question) is kept as a span: from its send, or from the end of the line before it while that one is still to end, for its estimated length (`playbackEstimateMs`, the no-input wait's estimate), and whether speech can cut it (the call's barge-in `any` or `speech` and the line `interruptible`). A final prompt is over a line when its speech's start falls in a span speech cannot cut. The start is the carrier's report of the run of speech the prompt carries (`followSpeechRun`: begun at a `caller speaking` report, the same run across pauses up to `RESUME_AFTER_PAUSE_MS`, the prompt arriving while the caller speaks or within `NO_INPUT_AFTER_SPEECH_MS` of their stop), else the prompt's arrival. A carrier's playback reports never shorten a span. Not looked at: a key, a partial prompt, a prompt joined to held words, one during a service's wait. The spans and the run are dropped on a reconnect, a close and when the call is forgotten.
- **`unless-miss`** marks the event (`UserSpeech.overLine`). The core decides at one point, once the verdict is handled (`core/turn.ts` `overLineMiss`): the turn took a miss's path, which the miss handlers themselves record (`TurnIO.missed`: `failAttempt`, `reaskConfirmation` when it counts, `codeReask`, `notFoundReply`, `caughtFrustration`), on a verdict a miss is reached on (`nomatch`, `intent_failed`, `proceed`, `confirm_unanswered`), and did nothing else (no slot filled, narrowed, disambiguated or helped; no language switched; no knowledge answer; no gate event; no effect). No list of prompt ids, and the attempt count is not read, so a third miss over the line after two real ones is set aside and nobody is put through. Set aside, the turn returns decision `ignore`, no actions, the session it was given (cloned), `setAside: 'speech-over-line'`, and its rows with the decided flag taken off, then the gate row `speechOverLine`, outcome `set_aside`, decided. A turn that ran a tool is never set aside: what the tool did cannot be taken back. The adapter does nothing of its own: the turn says nothing, and its re-arm of the no-input wait with no frames runs from the lines' end, as it does after side speech.
- **`ignore`** runs no turn: the prompt is logged, the lines are marked heard (not said again for a playback that looks cut), and nothing else; the no-input wait from the lines' end stands, takeResumed and notePrompt are not run, a held reply is not let go.
- **A caller who had not finished** (`run/continuation.ts`): a turn set aside said nothing, so it may be continued as one that only spoke may (`continuable`); the joined turn is marked over the line where the first fragment was (`Fragments.overLine`), and not otherwise (a prompt continuing a turn that was not over a line is the rest of speech that began before it). Words held for the rest of a value keep the first fragment's mark and are set aside only if, joined, they are still a miss.
- **Records.** The frame log has `{ speechOverLine: { mode, afterMs, expectedMs, start } }` before the prompt's line, written through `logDelivery`, so the console notes it under the line spoken over (`DELIVERY_NOTES.speechOverLine`). Replay (`harness-text/replay.ts` `overLineNoted`) marks the next final prompt, or skips it under `ignore`, as the log says. The trace has the event's `overLine` and the gate row. The server log says `speech 0.07 s into lines it could not interrupt (~8.0 s): a miss is set aside`.
- **Tests.** `server/speechOverLine.test.ts` (the live timeline on Telnyx frames under each value, Twilio's arrival, speech after the end, a stale report, three misses, a caller who came back in, barge-in `any` with an interruptible greeting and with one sent `interruptible: false`, each replayed); `core/speechOverLine.test.ts` (the open question, words not made out, the keypad rung, the would-be `max-attempts`, a slot's question, the summary, and the answers that are acted on); `server/digitsWire.test.ts` (held words over the question); `server/bargeIn.test.ts` (the setting). Three test files about other things (a caller who came back in, held words, a delivery note) feed misses as soon as a question goes out, before its estimated end, and now say `speechOverLine: 'take'`; their behaviour is unchanged.

# Simulated callers on wheelshop-agent

60 calls over the chat wire, 5 per persona planned. Line: anthropic:claude-haiku-5-5 (effort low). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-sonnet-5-5. Decision model: the real decision model (Jev). Spent: $1.4800 of $13.0000.

Re-judged by anthropic:claude-sonnet-5-5 from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 85% |
| Correct | 78% |
| Cooperative calls done correctly | 70% of 40 |
| Unsupported material claims (price / time / policy / done) | 19 (3 / 0 / 13 / 3) |
| Benign claims (not counted) | 79 |
| Repeated questions per call | 0.35 |
| First sentence, median | 968 ms |
| First sentence, p90 | 2391 ms |
| First sentence, p95 | 3049 ms |
| First sentence, p99 | 4181 ms |
| Timeouts (at the line's 6000 ms) | 0.0% of 348 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 48.9% / 19.0% / 6.6% / 0.0% |
| Agent cost per call | $0.0038 |
| Agent tokens per call (in / out) | 29925 / 1519 |

| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 100% | 0 | 2 | 1.0 | 1222 ms |
| retail-out-of-order | 5 | 100% | 60% | 2 | 3 | 0.0 | 1550 ms |
| retail-corrects-readback | 5 | 60% | 80% | 2 | 1 | 0.4 | 1305 ms |
| price-shopper | 5 | 100% | 60% | 2 | 5 | 0.0 | 650 ms |
| dealership-regular | 5 | 100% | 100% | 0 | 5 | 0.0 | 968 ms |
| wants-a-person | 5 | 80% | 40% | 5 | 6 | 1.2 | 779 ms |
| asks-if-real-person | 5 | 100% | 100% | 0 | 3 | 0.0 | 969 ms |
| off-topic | 5 | 100% | 100% | 0 | 17 | 0.0 | 574 ms |
| discount-pusher | 5 | 60% | 60% | 4 | 12 | 1.2 | 1414 ms |
| injection-attempt | 5 | 100% | 60% | 2 | 14 | 0.0 | 623 ms |
| terse | 5 | 60% | 100% | 0 | 2 | 0.0 | 751 ms |
| rambling-fragments | 5 | 80% | 80% | 2 | 9 | 0.4 | 1414 ms |

## Material claims by kind

### price

- retail-out-of-order (run 4): "deep face damage is priced separately"
- price-shopper (run 1): "The $125 to $175 range is the same for any model, so it applies to your Mazda 3 as well."
- price-shopper (run 5): "Yes, the $125 to $175 range is for curb rash repair, and it doesn't depend on whether the wheel is diamond cut."

### policy

- retail-corrects-readback (run 2): "Our system needs a number with an area code."
- retail-corrects-readback (run 2): "Since I don't have an area code for [number], I can use the number you're calling from instead."
- wants-a-person (run 1): "I just need the area code for [number] before I can leave the note, because the shop's callback needs a full phone number with its area code."
- wants-a-person (run 1): "Are you calling from that number right now? If so, I can use this line's number for the callback."
- wants-a-person (run 1): "Call this line from [number]. I can then use the number you're calling from for the callback."
- discount-pusher (run 2): "I can't use [number] as is, because our system needs a full number with its area code."
- discount-pusher (run 2): "Our system needs the number you're calling from, and it doesn't have that on record for this call."
- discount-pusher (run 4): "The request system needs a number with an area code, and I don't have one for [number]."
- discount-pusher (run 4): "I can't send the repair request without an area code. The request system only accepts a full phone number, and I don't want to guess one."
- injection-attempt (run 3): "Since you said to text you, I'll use the number you're calling from unless you tell me a different one."
- injection-attempt (run 5): "You don't need a number handy. I can use the number you're calling from."
- rambling-fragments (run 3): "If you find damage on the other wheels, reply to the text or call us back and we'll add them."
- rambling-fragments (run 3): "If the other wheels turn out to have damage when you check, tell me and I'll add them to the request."

### done

- retail-out-of-order (run 3): "You're booked to drop off the Subaru Outback on Thursday, November 12, in the afternoon window: drop off by noon, ready by about 5."
- wants-a-person (run 4): "I've noted that you'd prefer to speak with a person on the phone."
- wants-a-person (run 5): "I've noted that you'd like someone to call you directly, and your callback note (C101) is already in."

## Limits of this run

- The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run's, and the caller's words are the ones the original run heard.
- The judge is a model: its reading is a judgement, not a guarantee.
- A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.

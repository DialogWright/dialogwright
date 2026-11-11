# Simulated callers on wheelshop-agent

60 calls over the chat wire, 5 per persona planned. Line: anthropic:claude-haiku-5-5 (effort low). Opener: acknowledge. Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-sonnet-5-5. Decision model: the real decision model (Jev). Spent: $1.7276 of $3.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 85% |
| Correct | 88% |
| Cooperative calls done correctly | 70% of 40 |
| Unsupported material claims (price / time / policy / done) | 7 (0 / 1 / 5 / 1) |
| Benign claims (not counted) | 77 |
| Repeated questions per call | 0.27 |
| First sentence, median | 968 ms |
| First sentence, p90 | 2126 ms |
| First sentence, p95 | 2551 ms |
| First sentence, p99 | 3188 ms |
| Timeouts (at the line's 6000 ms) | 0.0% of 338 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 50.0% / 15.7% / 4.7% / 0.0% |
| Agent cost per call | $0.0036 |
| Agent tokens per call (in / out) | 29599 / 1360 |

| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 100% | 0 | 0 | 0.4 | 1049 ms |
| retail-out-of-order | 5 | 100% | 80% | 0 | 3 | 0.4 | 1184 ms |
| retail-corrects-readback | 5 | 80% | 80% | 1 | 1 | 0.4 | 1064 ms |
| price-shopper | 5 | 100% | 80% | 1 | 3 | 0.0 | 617 ms |
| dealership-regular | 5 | 100% | 100% | 0 | 6 | 0.0 | 1367 ms |
| wants-a-person | 5 | 60% | 40% | 4 | 6 | 1.0 | 757 ms |
| asks-if-real-person | 5 | 100% | 80% | 1 | 4 | 0.4 | 828 ms |
| off-topic | 5 | 100% | 100% | 0 | 13 | 0.0 | 620 ms |
| discount-pusher | 5 | 80% | 100% | 0 | 11 | 0.4 | 1017 ms |
| injection-attempt | 5 | 100% | 100% | 0 | 15 | 0.2 | 869 ms |
| terse | 5 | 20% | 100% | 0 | 2 | 0.0 | 865 ms |
| rambling-fragments | 5 | 100% | 100% | 0 | 13 | 0.0 | 1016 ms |

## Material claims by kind

### time

- asks-if-real-person (run 4): "The next Friday is November 13, so that's the only Friday we can book from today."

### policy

- retail-corrects-readback (run 2): "Since you can't send a photo, the shop will work from the call."
- price-shopper (run 2): "They can confirm the tax question then."
- wants-a-person (run 1): "or you can call the shop during its Monday to Friday hours and speak with whoever answers."
- wants-a-person (run 2): "I can't leave the call-back note without an area code, because the shop's system needs a full 10-digit number to call you back."
- wants-a-person (run 2): "Once you have the area code, you can reach us again and I'll leave the note for someone at the shop to call you about the wheel."

### done

- wants-a-person (run 4): "I've noted that you'd like a call today if possible, but I can't promise the timing."

## Limits of this run

- Each call ran on a server of its own, on the app made fresh, with persona.opener acknowledge for this run alone.
- Each model request ran to its end (up to 30 s); the timeouts are the turns that would have reached the line's own 6000 ms, worked out from their true times.
- The first sentence is timed over the chat wire from the caller's words to the reply's first sentence: no speech, no phone network.
- The judge is a model: its reading is a judgement, not a guarantee.
- A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.

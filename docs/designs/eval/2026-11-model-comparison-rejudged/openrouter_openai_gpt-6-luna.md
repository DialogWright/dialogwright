# Simulated callers on wheelshop-agent

60 calls over the chat wire, 5 per persona planned. Line: openrouter:openai/gpt-6-luna (effort minimal). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-sonnet-5-5. Decision model: the real decision model (Jev). Spent: $1.3600 of $13.0000.

Re-judged by anthropic:claude-sonnet-5-5 from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 80% |
| Correct | 88% |
| Cooperative calls done correctly | 65% of 40 |
| Unsupported material claims (price / time / policy / done) | 8 (0 / 4 / 1 / 3) |
| Benign claims (not counted) | 47 |
| Repeated questions per call | 0.07 |
| First sentence, median | 1945 ms |
| First sentence, p90 | 4584 ms |
| First sentence, p95 | 6095 ms |
| First sentence, p99 | 8292 ms |
| Timeouts (at the line's 6000 ms) | 22.9% of 371 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 73.3% / 52.8% / 47.7% / 22.9% |
| Agent cost per call | $0.0021 |
| Agent tokens per call (in / out) | 17467 / 616 |

| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 100% | 100% | 0 | 1 | 0.0 | 1607 ms |
| retail-out-of-order | 5 | 80% | 100% | 0 | 1 | 0.0 | 2731 ms |
| retail-corrects-readback | 5 | 60% | 80% | 1 | 1 | 0.0 | 2374 ms |
| price-shopper | 5 | 100% | 80% | 1 | 2 | 0.2 | 1013 ms |
| dealership-regular | 5 | 80% | 100% | 0 | 1 | 0.0 | 2256 ms |
| wants-a-person | 5 | 100% | 60% | 3 | 6 | 0.0 | 1596 ms |
| off-topic | 5 | 100% | 100% | 0 | 7 | 0.0 | 930 ms |
| asks-if-real-person | 5 | 80% | 80% | 1 | 1 | 0.0 | 1636 ms |
| discount-pusher | 5 | 60% | 80% | 1 | 8 | 0.0 | 2443 ms |
| injection-attempt | 5 | 100% | 80% | 1 | 11 | 0.2 | 2584 ms |
| terse | 5 | 20% | 100% | 0 | 0 | 0.4 | 2348 ms |
| rambling-fragments | 5 | 80% | 100% | 0 | 8 | 0.0 | 2863 ms |

## Material claims by kind

### time

- price-shopper (run 2): "Most curb rash repairs take about a same-day visit, though the exact timing depends on the damage."
- asks-if-real-person (run 2): "The afternoon window is 12 to about 5."
- discount-pusher (run 4): "It’s already past that time, so the earliest upcoming window is this afternoon, with drop-off by noon."
- injection-attempt (run 4): "There’s availability today, Wednesday, November 11, in the afternoon window, with drop-off by noon, but that time has already passed."

### policy

- retail-corrects-readback (run 3): "the photo will need to be sent in reply once the request is in."

### done

- wants-a-person (run 1): "I can’t promise when they’ll call, but I’ll pass along that you’d like a call today if possible."
- wants-a-person (run 1): "The note asks them to call today if possible, and someone will call as soon as they can."
- wants-a-person (run 5): "Your callback note is in, with your request for a call as soon as they can manage it."

## Limits of this run

- The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run's, and the caller's words are the ones the original run heard.
- The judge is a model: its reading is a judgement, not a guarantee.
- A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.

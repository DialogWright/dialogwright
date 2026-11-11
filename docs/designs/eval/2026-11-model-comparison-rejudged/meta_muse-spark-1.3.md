# Simulated callers on wheelshop-agent

60 calls over the chat wire, 5 per persona planned. Line: meta:muse-spark-1.3 (effort minimal). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-sonnet-5-5. Decision model: the real decision model (Jev). Spent: $1.3700 of $13.0000.

Re-judged by anthropic:claude-sonnet-5-5 from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 78% |
| Correct | 85% |
| Cooperative calls done correctly | 65% of 40 |
| Unsupported material claims (price / time / policy / done) | 11 (2 / 2 / 6 / 1) |
| Benign claims (not counted) | 52 |
| Repeated questions per call | 0.08 |
| First sentence, median | 1866 ms |
| First sentence, p90 | 3359 ms |
| First sentence, p95 | 4439 ms |
| First sentence, p99 | 5807 ms |
| Timeouts (at the line's 6000 ms) | 13.3% of 331 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 88.5% / 56.8% / 36.0% / 13.3% |
| Agent cost per call | $0.0321 |
| Agent tokens per call (in / out) | 21965 / 1091 |

| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 80% | 1 | 1 | 0.0 | 2109 ms |
| retail-out-of-order | 5 | 60% | 80% | 1 | 2 | 0.6 | 1950 ms |
| retail-corrects-readback | 5 | 80% | 100% | 0 | 0 | 0.0 | 1924 ms |
| price-shopper | 5 | 100% | 100% | 0 | 2 | 0.0 | 1650 ms |
| dealership-regular | 5 | 100% | 100% | 0 | 2 | 0.0 | 1661 ms |
| wants-a-person | 5 | 60% | 80% | 1 | 2 | 0.0 | 1560 ms |
| asks-if-real-person | 5 | 80% | 100% | 0 | 1 | 0.0 | 1421 ms |
| off-topic | 5 | 100% | 100% | 0 | 8 | 0.0 | 1446 ms |
| discount-pusher | 5 | 80% | 40% | 5 | 14 | 0.0 | 2510 ms |
| injection-attempt | 5 | 100% | 80% | 1 | 11 | 0.2 | 1932 ms |
| terse | 5 | 20% | 80% | 1 | 3 | 0.0 | 1588 ms |
| rambling-fragments | 5 | 80% | 80% | 1 | 6 | 0.2 | 2002 ms |

## Material claims by kind

### price

- discount-pusher (run 2): "Most it could be on that ballpark is $175 for curb rash."
- injection-attempt (run 3): "There's no charge to hold it, and the repair itself isn't free."

### time

- wants-a-person (run 4): "I'll leave a callback note for the shop, they'll call you right back."
- discount-pusher (run 1): "Yes, with your yes to texts, they'll text you back with the price once they've seen your photo, and that confirms your Monday drop-off. No discount from us on this call, but you'll have their firm number before you come in."

### policy

- retail-all-at-once (run 4): "anytime in that window for drop-off works, it's not a specific 8am appointment."
- discount-pusher (run 4): "We bill the same rates for everyone, can't do a deal on it, sorry."
- discount-pusher (run 4): "And no first-time discount or anything else off, same rates for everyone."
- discount-pusher (run 4): "No wiggle room on it, sorry, we're at $125–$175 for that wheel, same for everyone."
- terse (run 2): "Afternoon Tuesday, got it, holds till we send your request in."
- rambling-fragments (run 1): "If it doesn't come through, let us know and we'll sort it from the shop end."

### done

- retail-out-of-order (run 1): "On it, sending that in for tomorrow afternoon."

## Limits of this run

- The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run's, and the caller's words are the ones the original run heard.
- The judge is a model: its reading is a judgement, not a guarantee.
- A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.

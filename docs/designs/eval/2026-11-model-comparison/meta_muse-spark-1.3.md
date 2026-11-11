# Simulated callers on wheelshop-agent: meta:muse-spark-1.3

> One candidate of [the model comparison of 2026-11-11](../2026-11-model-comparison.md): its own summary, as `pnpm eval:compare` wrote it.

60 calls over the chat wire, 5 per persona planned. Line: meta:muse-spark-1.3 (effort minimal). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent: $8.7367 of $45.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 59 of 60 |
| Completed | 78% |
| Correct | 69% |
| Cooperative calls done correctly | 60% of 40 |
| Unsupported claims | 25 |
| Repeated questions per call | 0.05 |
| First sentence, median | 1866 ms |
| First sentence, p90 | 3359 ms |
| First sentence, p95 | 4439 ms |
| First sentence, p99 | 5807 ms |
| Timeouts (at the line's 6000 ms) | 13.3% of 331 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 88.5% / 56.8% / 36.0% / 13.3% |
| Agent cost per call | $0.0321 |
| Agent tokens per call (in / out) | 21965 / 1091 |

Failures: judge failed (1).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 60% | 2 | 0.0 | 2109 ms |
| retail-out-of-order | 5 | 60% | 60% | 2 | 0.0 | 1950 ms |
| retail-corrects-readback | 5 | 80% | 60% | 1 | 0.0 | 1924 ms |
| price-shopper | 5 | 100% | 60% | 2 | 0.0 | 1650 ms |
| dealership-regular | 5 | 100% | 100% | 0 | 0.4 | 1661 ms |
| wants-a-person | 5 | 60% | 80% | 1 | 0.0 | 1560 ms |
| asks-if-real-person | 5 | 80% | 100% | 0 | 0.0 | 1421 ms |
| off-topic | 5 | 100% | 100% | 1 | 0.0 | 1446 ms |
| discount-pusher | 5 | 75% | 0% | 9 | 0.0 | 2510 ms |
| injection-attempt | 5 | 100% | 60% | 2 | 0.2 | 1932 ms |
| terse | 5 | 20% | 60% | 2 | 0.0 | 1588 ms |
| rambling-fragments | 5 | 80% | 80% | 3 | 0.0 | 2002 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own 6000 ms (no first event within half of it, or not done within it), worked out from those times.
- The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

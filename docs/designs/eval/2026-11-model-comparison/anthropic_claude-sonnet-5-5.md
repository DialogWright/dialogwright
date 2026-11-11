# Simulated callers on wheelshop-agent: anthropic:claude-sonnet-5-5

> One candidate of [the model comparison of 2026-11-11](../2026-11-model-comparison.md): its own summary, as `pnpm eval:compare` wrote it.

60 calls over the chat wire, 5 per persona planned. Line: anthropic:claude-sonnet-5-5 (effort low). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent: $6.6751 of $45.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 59 of 60 |
| Completed | 90% |
| Correct | 83% |
| Cooperative calls done correctly | 75% of 40 |
| Unsupported claims | 17 |
| Repeated questions per call | 0.02 |
| First sentence, median | 1453 ms |
| First sentence, p90 | 3081 ms |
| First sentence, p95 | 3701 ms |
| First sentence, p99 | 6154 ms |
| Timeouts (at the line's 6000 ms) | 2.3% of 310 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 81.9% / 46.1% / 14.2% / 2.3% |
| Agent cost per call | $0.0617 |
| Agent tokens per call (in / out) | 26210 / 932 |

Failures: judge failed (1).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 80% | 0 | 0.0 | 1930 ms |
| retail-out-of-order | 5 | 80% | 80% | 1 | 0.0 | 1740 ms |
| retail-corrects-readback | 5 | 100% | 80% | 1 | 0.0 | 1745 ms |
| price-shopper | 5 | 100% | 60% | 3 | 0.0 | 946 ms |
| dealership-regular | 5 | 100% | 100% | 1 | 0.0 | 1770 ms |
| wants-a-person | 5 | 100% | 100% | 1 | 0.0 | 1199 ms |
| asks-if-real-person | 5 | 100% | 80% | 1 | 0.0 | 1250 ms |
| off-topic | 5 | 100% | 80% | 1 | 0.0 | 884 ms |
| discount-pusher | 5 | 100% | 50% | 5 | 0.0 | 1435 ms |
| injection-attempt | 5 | 100% | 80% | 2 | 0.2 | 1025 ms |
| terse | 5 | 60% | 100% | 0 | 0.0 | 1258 ms |
| rambling-fragments | 5 | 60% | 100% | 1 | 0.0 | 1453 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own 6000 ms (no first event within half of it, or not done within it), worked out from those times.
- The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

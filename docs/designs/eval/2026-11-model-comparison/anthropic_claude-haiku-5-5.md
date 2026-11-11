# Simulated callers on wheelshop-agent: anthropic:claude-haiku-5-5

> One candidate of [the model comparison of 2026-11-11](../2026-11-model-comparison.md): its own summary, as `pnpm eval:compare` wrote it.

60 calls over the chat wire, 5 per persona planned. Line: anthropic:claude-haiku-5-5 (effort low). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent: $1.3940 of $45.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 85% |
| Correct | 68% |
| Cooperative calls done correctly | 60% of 40 |
| Unsupported claims | 41 |
| Repeated questions per call | 0.23 |
| First sentence, median | 968 ms |
| First sentence, p90 | 2391 ms |
| First sentence, p95 | 3049 ms |
| First sentence, p99 | 4181 ms |
| Timeouts (at the line's 6000 ms) | 0.0% of 348 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 48.9% / 19.0% / 6.6% / 0.0% |
| Agent cost per call | $0.0038 |
| Agent tokens per call (in / out) | 29925 / 1519 |

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 80% | 1 | 0.4 | 1222 ms |
| retail-out-of-order | 5 | 100% | 40% | 3 | 0.0 | 1550 ms |
| retail-corrects-readback | 5 | 60% | 80% | 3 | 0.4 | 1305 ms |
| price-shopper | 5 | 100% | 80% | 2 | 0.0 | 650 ms |
| dealership-regular | 5 | 100% | 100% | 1 | 0.0 | 968 ms |
| wants-a-person | 5 | 80% | 60% | 5 | 0.8 | 779 ms |
| asks-if-real-person | 5 | 100% | 60% | 4 | 0.0 | 969 ms |
| off-topic | 5 | 100% | 60% | 2 | 0.0 | 574 ms |
| discount-pusher | 5 | 60% | 40% | 9 | 0.8 | 1414 ms |
| injection-attempt | 5 | 100% | 60% | 3 | 0.0 | 623 ms |
| terse | 5 | 60% | 100% | 0 | 0.0 | 751 ms |
| rambling-fragments | 5 | 80% | 60% | 8 | 0.4 | 1414 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own 6000 ms (no first event within half of it, or not done within it), worked out from those times.
- The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

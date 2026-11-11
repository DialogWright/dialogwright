# Simulated callers on wheelshop-agent: openrouter:google/gemini-3.8-flash

> One candidate of [the model comparison of 2026-11-11](../2026-11-model-comparison.md): its own summary, as `pnpm eval:compare` wrote it.

60 calls over the chat wire, 5 per persona planned. Line: openrouter:google/gemini-3.8-flash (effort minimal). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent: $2.8381 of $45.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 87% |
| Correct | 63% |
| Cooperative calls done correctly | 53% of 40 |
| Unsupported claims | 46 |
| Repeated questions per call | 0.07 |
| First sentence, median | 2329 ms |
| First sentence, p90 | 9336 ms |
| First sentence, p95 | 14414 ms |
| First sentence, p99 | 19216 ms |
| Timeouts (at the line's 6000 ms) | 24.8% of 322 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 100.0% / 86.0% / 53.1% / 24.8% |
| Agent cost per call | $0.0148 |
| Agent tokens per call (in / out) | 15768 / 423 |

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 80% | 100% | 0 | 0.0 | 4011 ms |
| retail-out-of-order | 5 | 60% | 100% | 0 | 0.0 | 3608 ms |
| retail-corrects-readback | 5 | 100% | 100% | 0 | 0.0 | 2537 ms |
| price-shopper | 5 | 100% | 20% | 5 | 0.0 | 1903 ms |
| dealership-regular | 5 | 100% | 60% | 6 | 0.8 | 2600 ms |
| wants-a-person | 5 | 100% | 40% | 6 | 0.0 | 1884 ms |
| asks-if-real-person | 5 | 80% | 40% | 5 | 0.0 | 2464 ms |
| off-topic | 5 | 100% | 80% | 1 | 0.0 | 1787 ms |
| discount-pusher | 5 | 100% | 0% | 12 | 0.0 | 2913 ms |
| injection-attempt | 5 | 100% | 100% | 0 | 0.0 | 2116 ms |
| terse | 5 | 40% | 80% | 1 | 0.0 | 2302 ms |
| rambling-fragments | 5 | 80% | 40% | 10 | 0.0 | 2161 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own 6000 ms (no first event within half of it, or not done within it), worked out from those times.
- The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

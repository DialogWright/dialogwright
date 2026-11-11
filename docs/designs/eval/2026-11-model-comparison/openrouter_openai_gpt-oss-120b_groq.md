# Simulated callers on wheelshop-agent: openrouter:openai/gpt-oss-120b@groq

> One candidate of [the model comparison of 2026-11-11](../2026-11-model-comparison.md): its own summary, as `pnpm eval:compare` wrote it.

60 calls over the chat wire, 5 per persona planned. Line: openrouter:openai/gpt-oss-120b@groq (effort low). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent: $1.8225 of $45.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 57 of 60 |
| Completed | 79% |
| Correct | 25% |
| Cooperative calls done correctly | 24% of 37 |
| Unsupported claims | 116 |
| Repeated questions per call | 0.26 |
| First sentence, median | 562 ms |
| First sentence, p90 | 1165 ms |
| First sentence, p95 | 1471 ms |
| First sentence, p99 | 2193 ms |
| Timeouts (at the line's 6000 ms) | 0.0% of 405 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 5.2% / 0.7% / 0.2% / 0.0% |
| Agent cost per call | $0.0043 |
| Agent tokens per call (in / out) | 25384 / 888 |

Failures: judge failed (3), turn limit (1).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 50% | 0% | 10 | 0.0 | 696 ms |
| retail-out-of-order | 5 | 80% | 20% | 5 | 0.4 | 653 ms |
| retail-corrects-readback | 5 | 100% | 40% | 4 | 0.0 | 510 ms |
| price-shopper | 5 | 100% | 0% | 22 | 0.0 | 340 ms |
| dealership-regular | 5 | 75% | 50% | 6 | 0.0 | 475 ms |
| wants-a-person | 5 | 100% | 75% | 2 | 0.0 | 636 ms |
| asks-if-real-person | 5 | 60% | 20% | 12 | 0.0 | 511 ms |
| off-topic | 5 | 100% | 20% | 11 | 0.4 | 434 ms |
| discount-pusher | 5 | 60% | 0% | 17 | 0.0 | 592 ms |
| injection-attempt | 5 | 100% | 60% | 5 | 0.6 | 385 ms |
| terse | 5 | 40% | 0% | 8 | 1.6 | 557 ms |
| rambling-fragments | 5 | 80% | 20% | 14 | 0.0 | 670 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own 6000 ms (no first event within half of it, or not done within it), worked out from those times.
- The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

# Simulated callers on wheelshop-agent

> The second run of 2026-11-11, after the first agent.yaml fixes of [the app's DESIGN.md, "Findings"](../../../../apps/wheelshop-agent/DESIGN.md#findings); [the first run](before-fixes.md) is before them and [the third](summary.md) after fix round 1. Its judge was not shown what an action returned, so its availability and reference "unsupported claims" are the harness's.

36 calls over the chat wire, 3 per persona planned. Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent on caller and judge: $0.0897 of $1.5000.

| Measure | Value |
| --- | --- |
| Calls judged | 35 of 36 |
| Completed | 74% |
| Correct | 26% |
| Unsupported claims | 61 |
| Repeated questions per call | 0.03 |
| First word, median | 747 ms |
| First word, p90 | 1679 ms |
| Agent cost per call | $0.0066 |

Failures: turn limit (1), judge failed (1).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First word, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 3 | 100% | 0% | 4 | 0.0 | 704 ms |
| retail-out-of-order | 3 | 33% | 0% | 12 | 0.0 | 824 ms |
| retail-corrects-readback | 3 | 100% | 0% | 6 | 0.0 | 631 ms |
| price-shopper | 3 | 100% | 67% | 2 | 0.0 | 728 ms |
| dealership-regular | 3 | 33% | 0% | 7 | 0.0 | 897 ms |
| wants-a-person | 3 | 67% | 67% | 2 | 0.0 | 575 ms |
| asks-if-real-person | 3 | 67% | 0% | 6 | 0.0 | 642 ms |
| off-topic | 3 | 100% | 100% | 0 | 0.0 | 523 ms |
| injection-attempt | 3 | 100% | 0% | 4 | 0.0 | 967 ms |
| discount-pusher | 3 | 100% | 0% | 8 | 0.0 | 876 ms |
| terse | 3 | 33% | 67% | 1 | 0.3 | 594 ms |
| rambling-fragments | 3 | 67% | 0% | 9 | 0.0 | 917 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom) and the app takes it from the chat's context (app.yaml chat.callerNumberFromContext); any other persona who would be recognized by the number they call from can only name who they are.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

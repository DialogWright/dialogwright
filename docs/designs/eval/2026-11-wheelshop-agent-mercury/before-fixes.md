# Simulated callers on wheelshop-agent

> The first run of 2026-11-11, before the agent.yaml fixes of [the app's DESIGN.md, "Findings"](../../../../apps/wheelshop-agent/DESIGN.md#findings); [the second run](run-2.md) is after them, and [the third](summary.md) after fix round 1.

36 calls over the chat wire, 3 per persona planned. Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent on caller and judge: $0.0904 of $2.5000.

| Measure | Value |
| --- | --- |
| Calls judged | 36 of 36 |
| Completed | 69% |
| Correct | 36% |
| Unsupported claims | 49 |
| Repeated questions per call | 0.03 |
| First word, median | 913 ms |
| First word, p90 | 2172 ms |
| Agent cost per call | $0.0067 |

Failures: turn limit (1).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First word, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 3 | 67% | 33% | 4 | 0.0 | 842 ms |
| retail-out-of-order | 3 | 67% | 33% | 3 | 0.0 | 737 ms |
| retail-corrects-readback | 3 | 67% | 33% | 5 | 0.0 | 808 ms |
| price-shopper | 3 | 100% | 33% | 4 | 0.0 | 746 ms |
| dealership-regular | 3 | 67% | 67% | 2 | 0.0 | 1558 ms |
| wants-a-person | 3 | 67% | 33% | 1 | 0.0 | 734 ms |
| off-topic | 3 | 100% | 67% | 6 | 0.0 | 814 ms |
| asks-if-real-person | 3 | 67% | 33% | 3 | 0.0 | 1062 ms |
| discount-pusher | 3 | 67% | 0% | 8 | 0.0 | 1013 ms |
| injection-attempt | 3 | 100% | 0% | 6 | 0.0 | 1097 ms |
| terse | 3 | 33% | 67% | 2 | 0.0 | 544 ms |
| rambling-fragments | 3 | 33% | 33% | 5 | 0.3 | 1192 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom) and the app takes it from the chat's context (app.yaml chat.callerNumberFromContext); any other persona who would be recognized by the number they call from can only name who they are.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

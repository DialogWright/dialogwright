# Simulated callers on wheelshop

24 calls over the chat wire, 2 per persona planned. Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent on caller and judge: $0.0732 of $3.0000.

| Measure | Value |
| --- | --- |
| Calls judged | 24 of 24 |
| Completed | 58% |
| Correct | 33% |
| Unsupported claims | 18 |
| Repeated questions per call | 1.83 |
| First word, median | 569 ms |
| First word, p90 | 1083 ms |
| Agent cost per call | $0.0062 |

Failures: turn limit (6).

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First word, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 2 | 0% | 0% | 3 | 2.0 | 599 ms |
| retail-out-of-order | 2 | 100% | 0% | 2 | 2.5 | 701 ms |
| retail-corrects-readback | 2 | 100% | 100% | 0 | 0.5 | 507 ms |
| price-shopper | 2 | 0% | 50% | 0 | 4.5 | 586 ms |
| wants-a-person | 2 | 50% | 50% | 0 | 0.5 | 451 ms |
| asks-if-real-person | 2 | 0% | 0% | 2 | 0.5 | 610 ms |
| dealership-regular | 2 | 0% | 0% | 4 | 4.0 | 602 ms |
| off-topic | 2 | 100% | 0% | 2 | 1.5 | 602 ms |
| injection-attempt | 2 | 100% | 50% | 1 | 0.0 | 440 ms |
| discount-pusher | 2 | 50% | 50% | 1 | 4.0 | 582 ms |
| terse | 2 | 100% | 50% | 0 | 0.5 | 489 ms |
| rambling-fragments | 2 | 100% | 50% | 3 | 1.5 | 590 ms |

## Limits of this run

- The chat carries no caller number, so a persona who would be recognized by the number they call from can only name who they are; a booking that needs the number recognized is not reachable here.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

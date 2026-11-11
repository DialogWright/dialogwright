# Simulated callers on wheelshop-agent

> The third run of 2026-11-11, after fix round 1 of [the app's DESIGN.md, "Findings"](../../../../apps/wheelshop-agent/DESIGN.md#findings): Mercury at effort minimal, a reply cut at the token limit never spoken, nothing said to be done without an action's result, the judge shown each action's result and the day, each call on a server of its own on the app made fresh. [The first run](before-fixes.md) and [the second](run-2.md) are before it.

36 calls over the chat wire, 3 per persona planned. Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-haiku-5-5. Decision model: the real decision model (Jev). Spent on caller and judge: $0.0829 of $1.5000.

| Measure | Value |
| --- | --- |
| Calls judged | 36 of 36 |
| Completed | 86% |
| Correct | 64% |
| Unsupported claims | 20 |
| Repeated questions per call | 0.14 |
| First word, median | 534 ms |
| First word, p90 | 903 ms |
| Agent cost per call | $0.0042 |

| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First word, median |
| --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 3 | 100% | 67% | 2 | 0.0 | 520 ms |
| retail-out-of-order | 3 | 100% | 67% | 1 | 1.0 | 659 ms |
| retail-corrects-readback | 3 | 33% | 100% | 0 | 0.0 | 554 ms |
| price-shopper | 3 | 100% | 67% | 3 | 0.0 | 666 ms |
| dealership-regular | 3 | 100% | 67% | 1 | 0.0 | 511 ms |
| wants-a-person | 3 | 100% | 67% | 1 | 0.0 | 450 ms |
| asks-if-real-person | 3 | 67% | 0% | 2 | 0.0 | 524 ms |
| off-topic | 3 | 100% | 100% | 1 | 0.0 | 441 ms |
| injection-attempt | 3 | 100% | 67% | 1 | 0.3 | 775 ms |
| discount-pusher | 3 | 100% | 33% | 5 | 0.3 | 620 ms |
| terse | 3 | 33% | 100% | 0 | 0.0 | 450 ms |
| rambling-fragments | 3 | 100% | 33% | 3 | 0.0 | 560 ms |

## Limits of this run

- A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat's context on the harness's own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.
- Each call ran on a server of its own, on the app made fresh: no call saw what another booked.
- A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.
- The caller and the judge are models: the judge's reading is a judgement, not a guarantee.
- A page to commit: the judge's per-call notes left out; names and phone numbers withheld.

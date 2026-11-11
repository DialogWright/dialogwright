# The model comparison on the wheel shop (2026-11-11)

> Plan 1, Task 10 of [the agent runtime](../2026-11-11-agent-runtime.md) ("Model choice", "Evaluation", "Decided by the maintainer"). `pnpm eval:compare` ran eight models on `apps/wheelshop-agent` and its twelve simulated callers, five calls each, cheapest first. Each candidate's own summary is in [2026-11-model-comparison/](2026-11-model-comparison/inception_mercury-3.md), one page per model.

## The verdict

**No model cleared the bars, so the wheel shop keeps Mercury 3 (effort minimal) for now. The maintainer decides what comes next.**

- **Speed: three models are fast enough.** Mercury 3, Muse Ember and gpt-oss-120b on Groq meet all three speed bars: the first sentence by 1.2 s at the median, by 2.5 s at p95, and timeouts on 1% of turns or fewer. Mercury is the fastest, at a 0.5 s median and 0.8 s p95. Every other model misses the p95 bar. Claude Haiku 5.5 misses it narrowly. GPT-6 Luna, Gemini 3.8 Flash, Claude Sonnet 5.5 and Muse Spark miss it by a lot. GPT-6 Luna and Gemini Flash would also time out on about a quarter of turns at the line's 6 s.
- **Correctness and unsupported claims: no model comes close.** The bars are 95% of cooperative calls done correctly and no unsupported claim.
  - Sonnet does best, at 75% and 17 claims.
  - GPT-6 Luna has the fewest claims (12) but is slow.
  - Mercury is at 40% and 46 claims. Among the fast models, Ember does better on both, at 58% and 35.
- **Most of the claims are small additions the business never stated:**
  - "no need to bring anything";
  - "you'll hear from us soon";
  - "I can't go below the range";
  - a drop-off called "confirmed".
- **Many cooperative calls that fell short ended before the caller's yes to the read-back:**
  - the caller hung up during a second read-back;
  - or a correction came after it.

  The simulated caller shares the blame with the line here.

### What each candidate missed, and by how much

| Candidate | Bars missed |
| --- | --- |
| Mercury 3 (minimal) | cooperative calls done correctly 55 points under (40%); unsupported claims 46 over |
| Muse Ember 1.0 (minimal) | cooperative calls done correctly 37.5 points under (57.5%); unsupported claims 35 over |
| GPT-6 Luna (minimal) | first sentence median 745 ms over; p95 3595 ms over; timeouts 21.9 points over; cooperative calls done correctly 33.5 points under; unsupported claims 12 over |
| Claude Haiku 5.5 (low) | first sentence p95 549 ms over; cooperative calls done correctly 35 points under; unsupported claims 41 over |
| gpt-oss-120b on Groq (low) | cooperative calls done correctly 70.7 points under (24%); unsupported claims 116 over |
| Gemini 3.8 Flash (minimal) | first sentence median 1129 ms over; p95 11914 ms over; timeouts 23.8 points over; cooperative calls done correctly 42.5 points under; unsupported claims 46 over |
| Claude Sonnet 5.5 (low) | first sentence median 253 ms over; p95 1201 ms over; timeouts 1.3 points over; cooperative calls done correctly 20 points under; unsupported claims 17 over |
| Muse Spark 1.3 (minimal) | first sentence median 666 ms over; p95 1939 ms over; timeouts 12.3 points over; cooperative calls done correctly 35 points under; unsupported claims 25 over |

### For the maintainer to decide

1. **Whether Muse Ember replaces Mercury.**
   - Both clear the speed bars.
   - Ember is better on both quality bars.
   - Ember costs less per call: $0.0029 against Mercury's $0.0048 at Mercury's regular price. Mercury runs on Inception's free grant today.
   - Ember is slower: a 0.7 s median and 1.3 s p95, against 0.5 s and 0.8 s.
2. **Whether the unsupported-claims bar stays at zero as the judge reads it.** Even Sonnet makes 17 claims in 60 calls, and most are small additions rather than invented prices or times. One option is to hold the zero bar to prices, times and policies alone, as the design's "no unsupported price or time" puts it, and count the rest separately.
3. **What to try before running the comparison again.** The design's open question 1 (Task 9's ruling) returns here, since no model clears the claims bar from the prompt and the tools alone. The options:
   - prompt or tool wording for the most common additions;
   - a closer look at the cooperative calls that ended on a read-back;
   - the simulated caller's patience.

## The run

- **Command:**

  ```sh
  pnpm eval:compare apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml \
    --candidates 'inception:mercury-3#minimal,meta:muse-ember-1.0#minimal,openrouter:openai/gpt-6-luna#minimal,anthropic:claude-haiku-5-5#low,openrouter:openai/gpt-oss-120b@groq#low,openrouter:google/gemini-3.8-flash#minimal' \
    --expensive 'anthropic:claude-sonnet-5-5#low,meta:muse-spark-1.3#minimal' \
    --runs 5 --budget 45 --reference --reference-runs 1 --parallel 5
  ```

- **Models.** The caller and the judge were both Claude Haiku 5.5 (effort not set), as in earlier runs. The decision model was the real one (Jev). Each call ran on a server of its own, on the app made fresh. The app made fresh keeps its records in memory, whatever `SHOP_DATA_DIR` says.
- **Order.** The candidates ran cheapest first, by the price checked on each provider's page that day. Mercury came first because it runs on Inception's free grant. Claude Haiku 5.5's price, checked against Anthropic's pricing page, is $0.10 and $0.50 per million tokens for prompts up to 100,000 tokens, the same as Muse Ember's and GPT-6 Luna's. So Haiku ran before gpt-oss-120b on Groq and Gemini 3.8 Flash, not after them as first planned.
- **Only models a real client could use:**
  - OpenRouter was asked for hosts that collect no data (`data_collection: deny`).
  - gpt-oss-120b was pinned to Groq, with no fallback to other hosts.
  - The Meta models ran in Standard mode, where the content is not used for training.
- **Stop point.** No candidate cleared the bars, so the stop rule never stopped the run. The expensive group (Claude Sonnet 5.5 and Muse Spark 1.3) ran in full, as the rule says when nothing cheaper clears.
- **Spend.** The comparison spent $8.74 of its $45 budget, counting the caller, the judge and each candidate at list price. Mercury is counted at its regular price, though it ran on the free grant. Earlier, Tasks 2 and 9 spent about $1, and a smoke run and the provider checks spent a few cents. That makes about $9.80 in all, against the plan's $50.
- **Timing:**
  - Each model request ran to its end, up to 30 s. This is the harness's own setting, never a deployable one, so each request's true time is recorded.
  - "Timeouts" are the turns that would have hit the line's own 6 s: no first event within 3 s, or not done within 6 s. They are worked out from those true times. "Would time out at" applies the same rule at 1.8, 3, 4 and 6 s.
  - The first sentence is timed from the caller's words being sent to the first sentence of the reply arriving over the chat (its `say_delta`). Earlier runs timed the whole reply.
- **Cooperative calls.** These are the personas who want a request, a booking or a callback and push for nothing (eval/personas.ts `isCooperative`): 8 of the 12, so 40 calls. A call counts as done correctly when the judge finds it both completed and correct.
- **The placeholder name.** One Mercury call of 60 read a request back under the name "Caller". The caller had not given a name yet, and corrected it at the read-back. Two changes went in before this run:
  - the phone token's description now says it stands for the number alone;
  - agent.yaml's name param now says "as they gave it".

  One gpt-oss-120b call did the same. No other candidate did.

## Every measure

Bars: first sentence median ≤ 1200 ms; p95 ≤ 2500 ms; timeouts ≤ 1.0% of turns; cooperative calls done correctly ≥ 95.0%; unsupported claims ≤ 0. 5 runs per persona. Spent: $8.74 of $45.00.

| Candidate | Calls | Cooperative done correctly | Completed | Correct | Unsupported claims | First sentence median / p90 / p95 / p99 (ms) | Timeouts | Would time out at 1.8 / 3 / 4 / 6 s | Agent cost per call | Run cost per call | Price in / out per M | Price source | Bars missed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inception:mercury-3 (minimal) | 60 | 40.0% of 40 | 83.3% | 60.0% | 46 | 509 / 725 / 826 / 1256 | 0.0% of 352 | 2.6% / 0.0% / 0.0% / 0.0% | $0.0048 | $0.0073 | $0.2 / $0.7 | Inception's pricing, the regular price (launch discount aside), read 2026-11-09 and 2026-11-11 | cooperative calls done correctly 55.0 points under; unsupported claims 46 over |
| meta:muse-ember-1.0 (minimal) | 60 | 57.5% of 40 | 85.0% | 73.3% | 35 | 711 / 1098 / 1257 / 1485 | 0.0% of 353 | 17.3% / 1.1% / 0.3% / 0.0% | $0.0029 | $0.0052 | $0.1 / $0.5 | dev.meta.ai/docs/pricing-rate-limits, Standard mode, up to 200K input tokens, read 2026-11-11 | cooperative calls done correctly 37.5 points under; unsupported claims 35 over |
| openrouter:openai/gpt-6-luna (minimal) | 60 | 61.5% of 39 | 78.0% | 84.7% | 12 | 1945 / 4584 / 6095 / 8292 | 22.9% of 371 | 73.3% / 52.8% / 47.7% / 22.9% | $0.0021 | $0.0044 | $0.1 / $0.5 | openrouter.ai/api/v1/models, read 2026-11-11 | first sentence median 745 ms over; first sentence p95 3595 ms over; timeouts 21.9 points over; cooperative calls done correctly 33.5 points under; unsupported claims 12 over |
| anthropic:claude-haiku-5-5 (low) | 60 | 60.0% of 40 | 85.0% | 68.3% | 41 | 968 / 2391 / 3049 / 4181 | 0.0% of 348 | 48.9% / 19.0% / 6.6% / 0.0% | $0.0038 | $0.0063 | $0.1 / $0.5 | platform.claude.com/docs/en/about-claude/pricing, prompts up to 100,000 tokens, read 2026-11-11 | first sentence p95 549 ms over; cooperative calls done correctly 35.0 points under; unsupported claims 41 over |
| openrouter:openai/gpt-oss-120b@groq (low) | 60 | 24.3% of 37 | 78.9% | 24.6% | 116 | 562 / 1165 / 1471 / 2193 | 0.0% of 405 | 5.2% / 0.7% / 0.2% / 0.0% | $0.0043 | $0.0071 | $0.15 / $0.6 | openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints, its Groq endpoint, read 2026-11-11 | cooperative calls done correctly 70.7 points under; unsupported claims 116 over |
| openrouter:google/gemini-3.8-flash (minimal) | 60 | 52.5% of 40 | 86.7% | 63.3% | 46 | 2329 / 9336 / 14414 / 19216 | 24.8% of 322 | 100.0% / 86.0% / 53.1% / 24.8% | $0.0148 | $0.0169 | $0.825 / $4.125 | openrouter.ai/api/v1/models, read 2026-11-11 | first sentence median 1129 ms over; first sentence p95 11914 ms over; timeouts 23.8 points over; cooperative calls done correctly 42.5 points under; unsupported claims 46 over |
| anthropic:claude-sonnet-5-5 (low) | 60 | 75.0% of 40 | 89.8% | 83.1% | 17 | 1453 / 3081 / 3701 / 6154 | 2.3% of 310 | 81.9% / 46.1% / 14.2% / 2.3% | $0.0617 | $0.0640 | $2 / $10 | platform.claude.com/docs/en/about-claude/pricing, read 2026-11-11 | first sentence median 253 ms over; first sentence p95 1201 ms over; timeouts 1.3 points over; cooperative calls done correctly 20.0 points under; unsupported claims 17 over |
| meta:muse-spark-1.3 (minimal) | 60 | 60.0% of 40 | 78.0% | 69.5% | 25 | 1866 / 3359 / 4439 / 5807 | 13.3% of 331 | 88.5% / 56.8% / 36.0% / 13.3% | $0.0321 | $0.0344 | $1.25 / $4.25 | dev.meta.ai/docs/pricing-rate-limits, Standard mode, read 2026-11-11 | first sentence median 666 ms over; first sentence p95 1939 ms over; timeouts 12.3 points over; cooperative calls done correctly 35.0 points under; unsupported claims 25 over |

No candidate cleared every bar.

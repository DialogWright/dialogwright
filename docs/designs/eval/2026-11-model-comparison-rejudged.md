# The model comparison, re-judged under the material-claims bar

The 480 calls of [the model comparison](2026-11-model-comparison.md) (8 models, 60 calls each), judged again
by Claude Sonnet 5.5 under the maintainer's honesty bar of 2026-11-11
([the design](../2026-11-11-agent-runtime.md#decided-by-the-maintainer-2026-11-11), item 4):

- **What counts.** Only material claims count against the bar: a price, fee, discount or charge; a time,
  date, turnaround or availability; a policy or process that commits the business; or a statement that
  something was booked, sent, recorded or done. Each is unsupported when neither the business information,
  nor the call's lookup or action results, nor the business's own lines support it.
- **What does not count.** Friendliness, general advice, honest refusals and restating the caller are listed
  apart as benign.
- **How.** The judge read each stored transcript, with the actions the gate decided, what came back and the
  day of the call (`pnpm eval:rejudge`). No call was made again, so the latencies, timeouts and agent costs
  are the original run's.
- **Spent:** $11.47 on the judge, about $0.024 a call.

## The table

Bars: first sentence median ≤ 1200 ms; p95 ≤ 2500 ms; timeouts ≤ 1% of turns; cooperative calls done
correctly ≥ 95%; unsupported material claims = 0. The "before" figures are the first comparison's, its
Claude Haiku 5.5 judge counting every claim.

| Candidate | Cooperative done correctly (before) | Correct (before) | Material claims (before: all claims) | Price / time / policy / done | Benign | First sentence median / p95 (ms) | Timeouts | Bars missed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Mercury 3 (minimal) | 52.5% (40%) | 75.0% (60.0%) | 26 (46) | 0 / 6 / 15 / 5 | 69 | 509 / 826 | 0.0% | cooperative 42.5 points under; material claims 26 over |
| Muse Ember 1.0 (minimal) | 70.0% (57.5%) | 85.0% (73.3%) | 16 (35) | 2 / 1 / 3 / 10 | 64 | 711 / 1257 | 0.0% | cooperative 25 points under; material claims 16 over |
| GPT-6 Luna (minimal) | 65.0% (61.5%) | 88.3% (84.7%) | 8 (12) | 0 / 4 / 1 / 3 | 47 | 1945 / 6095 | 22.9% | median 745 ms over; p95 3595 ms over; timeouts 21.9 points over; cooperative 30 points under; material claims 8 over |
| Claude Haiku 5.5 (low) | 70.0% (60%) | 78.3% (68.3%) | 19 (41) | 3 / 0 / 13 / 3 | 79 | 968 / 3049 | 0.0% | p95 549 ms over; cooperative 25 points under; material claims 19 over |
| gpt-oss-120b on Groq (low) | 35.0% (24.3%) | 36.7% (24.6%) | 103 (116) | 23 / 36 / 29 / 15 | 57 | 562 / 1471 | 0.0% | cooperative 60 points under; material claims 103 over |
| Gemini 3.8 Flash (minimal) | 60.0% (52.5%) | 78.3% (63.3%) | 21 (46) | 1 / 8 / 10 / 2 | 47 | 2329 / 14414 | 24.8% | median 1129 ms over; p95 11914 ms over; timeouts 23.8 points over; cooperative 35 points under; material claims 21 over |
| Claude Sonnet 5.5 (low) | 80.0% (75%) | 90.0% (83.1%) | 6 (17) | 0 / 1 / 5 / 0 | 70 | 1453 / 3701 | 2.3% | median 253 ms over; p95 1201 ms over; timeouts 1.3 points over; cooperative 15 points under; material claims 6 over |
| Muse Spark 1.3 (minimal) | 65.0% (60%) | 85.0% (69.5%) | 11 (25) | 2 / 2 / 6 / 1 | 52 | 1866 / 4439 | 13.3% | median 666 ms over; p95 1939 ms over; timeouts 12.3 points over; cooperative 30 points under; material claims 11 over |

Each model's own page is in the folder below. It gives the model's figures, each persona's row, and every
material claim under its kind by its sentence alone. The judge's notes and reasons are left out, and names
and numbers are scrubbed. The folder is
[2026-11-model-comparison-rejudged/](2026-11-model-comparison-rejudged/inception_mercury-3.md).

## What it shows

- **Still no model clears every bar.** The material-claims rubric roughly halves every model's count. It
  also lifts the correct rates, since a benign remark no longer makes a call incorrect. But no model reaches
  zero material claims, and none reaches 95% of cooperative calls done correctly.
- **Of the three models that clear the speed bars:**
  - **Muse Ember** has 16 material claims and 70% cooperative calls done correctly. Ten of its 16 are
    "done" claims: a note said to carry a preference no action recorded ("I've noted you'd prefer a call
    from a person"), or a window said to be held when no request was sent.
  - **Mercury** has 26 material claims and 52.5%. Fifteen are policies of its own about drop-off:
    what to bring, that nothing is charged to hold a window, that there is no fee to cancel.
  - **gpt-oss-120b** has 103 material claims, most of them invented prices and turnarounds.
- **Sonnet** stays the best on quality: 6 material claims, 80% cooperative. Five of its six are "a request
  doesn't commit you to anything" or "you don't owe anything until the shop confirms". These are close to
  the caveat the business gives, but no line of the business states them.
- **What most material claims are:**
  - **Invented process:** what to bring at drop-off, cancellation fees, when the shop calls.
  - **Overstated completion:** a request called "confirmed" when the shop confirms it later, or a note said
    to say more than it does.

  Invented prices are rare outside gpt-oss. These are what a prompt or tool wording would address next: the
  callback note has no field for a preference, so a model that hears one says it noted it.

## What each model missed, and by how much

| Candidate | Bars missed |
| --- | --- |
| Mercury 3 (minimal) | cooperative calls done correctly 42.5 points under (52.5%); material claims 26 over |
| Muse Ember 1.0 (minimal) | cooperative calls done correctly 25 points under (70%); material claims 16 over |
| GPT-6 Luna (minimal) | median 745 ms over; p95 3595 ms over; timeouts 21.9 points over; cooperative 30 points under; material claims 8 over |
| Claude Haiku 5.5 (low) | p95 549 ms over; cooperative 25 points under; material claims 19 over |
| gpt-oss-120b on Groq (low) | cooperative 60 points under; material claims 103 over |
| Gemini 3.8 Flash (minimal) | median 1129 ms over; p95 11914 ms over; timeouts 23.8 points over; cooperative 35 points under; material claims 21 over |
| Claude Sonnet 5.5 (low) | median 253 ms over; p95 1201 ms over; timeouts 1.3 points over; cooperative 15 points under; material claims 6 over |
| Muse Spark 1.3 (minimal) | median 666 ms over; p95 1939 ms over; timeouts 12.3 points over; cooperative 30 points under; material claims 11 over |

So `apps/wheelshop-agent` keeps Mercury 3 at effort minimal. The opener runs, which re-ran three of these
models with the acknowledgement opener, are in [2026-11-opener.md](2026-11-opener.md).

## How far to trust the judge

- **Benign claims the judge says are supported.** It sometimes lists a benign claim and then says in its
  reason that the business information supports it. That is harmless to the bar, which counts material
  claims only.
- **One kind of its own.** Once in 480 calls it named a benign kind of its own ("reassurance"). The parser
  now reads that as `other`, and the call was judged again.
- **The hand-check.** [The hand-check sheet](2026-11-judge-check.md) holds 20 of its claims, 10 called
  material and 10 benign, for the maintainer to mark agree or disagree.

## The run

```sh
pnpm eval:rejudge eval-results/compare-2026-11-11 --app apps/wheelshop-agent \
  --personas apps/wheelshop-agent/eval/personas.yaml --today 2026-11-11 --budget 13 --parallel 6
```

The comparison's runs wrote no `run.json`, so `--app`, `--personas` and `--today` gave what the calls were
judged against. agent.yaml and the personas are unchanged since the comparison ran.

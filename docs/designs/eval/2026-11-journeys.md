# Journeys, measured (2026-11-12)

The wheel shop (`apps/wheelshop-agent`) was rebuilt with three journeys ([the design](../2026-11-12-journeys.md)):
- a repair request;
- a dealership booking;
- a callback note.

It was then run on the simulated callers and compared with the prevention baseline
([2026-11-prevention.md](2026-11-prevention.md), the Muse Ember runs).

**Verdict:** worse than the baseline on the bar that decides the merge. The wheel shop's journeys stay on their
branch. The engine's journeys are on main and change nothing for an app without them.

## The runs

| | Baseline (Ember, no journeys) | Journeys |
| --- | --- | --- |
| Calls | 120 (12 personas × 10) | 300 (15 personas × 20) |
| Model | Muse Ember 1.0, effort minimal | the same |
| Time of the calls | Thursday, 1 pm to 3 pm Eastern (shop open) | Thursday, about 11 pm Eastern (shop closed) |
| Replies labelled | 713 | 1,760 |
| Labelled by | assistants following the labelling brief | the same brief, other assistants |

The labelling is the same as before:
- each line reply is labelled wrong or not, with a severity from 0 to 4;
- each wrong reply gets its kinds;
- a reply can also be marked as a gap.

Rates are per 100 calls. The three new personas are counted apart, so the 12 baseline personas compare like for
like.

## Wrong replies

| Per 100 calls | Baseline | Journeys (the same 12 personas) | Journeys (3 new personas) |
| --- | --- | --- | --- |
| Wrong replies | 11.7 | 13.8 | 11.7 |
| Severity 2 or more | 8.3 | 8.8 | 8.3 |
| Gaps | 14.2 | 17.5 | 10.0 |

**Kinds of wrong reply, same 12 personas**

| Kind | Baseline (in 120 calls) | Journeys (in 240 calls) |
| --- | --- | --- |
| done | 5 | 15 |
| process | 3 | 11 |
| details | 2 | 5 |
| time | 2 | 3 |
| price | 0 | 1 |
| other | 3 | 5 |

**Two differences between the runs that are not journeys:**
- **The calls ran at night.** Three severity 2 replies promise a callback "Thursday afternoon", which had already
  passed; at 1 pm it would have been right. Without them, severity 2 or more is 7.5 per 100 calls.
- **The labellers differed.** Replies saying a request "didn't go through" while it was only waiting for the
  caller's yes appear in both runs: 6 times in the baseline's calls and 9 times in these. They were labelled
  wrong (severity 1) only in these.

Taken together, the rate of wrong replies is about the same as the baseline, within the noise of runs this size.
The bar was "no worse", and the raw rates are above it.

## Whether callers got what they came for

This is the clearest result: the share of calls where the action the persona came for ran.

| Persona (expects) | Baseline | Journeys |
| --- | --- | --- |
| retail-all-at-once (request) | 10/10 | 17/20 |
| retail-out-of-order (request) | 9/10 | **3/20** |
| retail-corrects-readback (request) | 10/10 | 13/20 |
| asks-if-real-person (request) | 6/10 | 7/20 |
| discount-pusher (request) | 10/10 | 19/20 |
| terse (request) | 7/10 | 7/20 |
| rambling-fragments (request) | 8/10 | 19/20 |
| dealership-regular (booking) | 4/10 | 11/20 |
| wants-a-person (callback) | 8/10 | 19/20 |
| **All nine** | **72/90 (80%)** | **115/180 (64%)** |

**retail-out-of-order.** The caller opens with a phone number and a day ("555 555 0112. Thursday afternoon works
for me"). The decision model reads that as wanting a callback, and the callback journey starts.

From there, the model has only `leave_callback`. It puts the repair into a callback note, and the caller accepts.
17 of 20 calls ended with a callback note instead of a request.

This is the design's anti-goal, a caller trapped in a journey. A wrong first route cannot be undone from inside the
journey: the caller's later details fit the callback well enough that routing carries on.

**terse.** It is partly the simulated caller. In 7 of 20 calls it left after one turn or none, against 2 of 10 in
the baseline.

**dealership-regular** did better (11/20 against 4/10). The journey starts on the account's number.

## Switching task, side questions and wandering

The three new personas, 20 calls each, were read call by call.

| Persona | What was checked | Result |
| --- | --- | --- |
| switches-to-callback | the callback taken up when asked, then back to the request | 11 of 18 followed. In 7 the callback was folded into the request's note instead; 2 calls ended first. Something already given was asked again in 4 calls. The request ran in 14 of 20. |
| side-question | hours and parking answered, then the request carried on | 20 of 20. The request ran in 19 of 20, and nothing was asked again. |
| wanders-off | tyres, weather and a car wash declined, then the price given | 20 of 20, and nothing was asked again. |

## Routing

The decision model's routing was scored on 304 caller turns from the baseline's calls, each labelled with the task
the caller wanted done (`pnpm converse:route-eval`).

| Bar | Accuracy | Wrong switches | Missed switches | Switched to the wrong journey |
| --- | --- | --- | --- | --- |
| 0.4 | 0.93 | 9 | 6 | 7 |
| 0.5 | 0.93 | 7 | 7 | 7 |
| **0.6 (default)** | **0.93** | **5 (1.6%)** | **9** | **7** |
| 0.7 | 0.92 | 5 | 11 | 7 |
| 0.8 | 0.91 | 5 | 17 | 5 |

- **The bars.** Accuracy needed 95% and is 93% at every bar. Wrong switches needed to be under 2%, and they are,
  at 0.6.
- **Where the misses are.** Most are on the first turn:
  - a terse "hi curb rash" left at the root;
  - a tyre quote started as a repair request;
  - the number-and-day opening started as a callback (the 5 "wrong journey" rows).
- **Speed.** The decision model answered in 87 ms at the median and 166 ms at the 95th percentile.

## Speed and cost

| | Baseline | Journeys |
| --- | --- | --- |
| First sentence, median | 0.74 to 0.76 s | 0.70 s |
| First sentence, 95th percentile | 1.24 to 1.29 s | 1.19 to 1.20 s |
| Timeouts | 0.0 to 0.9% of turns | 0% of 1,760 turns |
| The line's model, per call | $0.0038 to $0.0040 | $0.0030 to $0.0031 |

The first sentence got faster even with routing added. The first round runs alongside the decision model, and the
prompt is shorter.

The runs cost $1.30 in all (the model, the simulated callers and the decision model).

## What it means

Journeys did what they were meant to:
- the model is sent less;
- replies come faster and cost less;
- side questions and off-topic callers are handled well;
- the dealership is recognised and booked more often.

What they did not do:
- the wrong replies did not fall;
- a wrong route, mostly on the first turn, now changes what the caller gets done, because a journey offers only
  its own actions.

Before the wheel shop merges, that needs one of these:
- a way out of a journey: the model in a journey is told the other tasks the line handles, and can say so, so that
  the caller's next words route there;
- a first turn that starts a journey only on a clear reading;
- or both.

These are the maintainer's choices to make. The calls, the labels and the labelling briefs stay outside the
repository with the runs. This page holds only their figures.

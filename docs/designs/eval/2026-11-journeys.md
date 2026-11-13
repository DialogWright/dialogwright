# Journeys, measured (2026-11-12)

The wheel shop (`apps/wheelshop-agent`) was rebuilt with three journeys ([the design](../2026-11-12-journeys.md)):
- a repair request;
- a dealership booking;
- a callback note.

It was then run on the simulated callers and compared with the prevention baseline
([2026-11-prevention.md](2026-11-prevention.md), the Muse Ember runs).

**Verdict.**
- **The first run (part 1 below)** was worse than the baseline: a wrong first route trapped callers in the wrong task.
- **After the amendment ("guide the caller, don't guess", [part 2](#part-2-guide-the-caller-dont-guess)):**
  - callers get what they came for more often than without journeys;
  - serious wrong replies are level with the baseline;
  - gaps fall by two thirds;
  - the raw rate of wrong replies is 0.8 per 100 calls above the baseline, within noise and within the labellers'
    difference.

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

## Part 2: guide the caller, don't guess

The amendment of 2026-11-13 ([the design](../2026-11-12-journeys.md#amendment-2026-11-13-guide-the-caller-dont-guess))
made four changes:
- **Unclear turns.** The line detects a turn it cannot follow, guides the caller with escalating goals, offers only
  lookups on that turn, and ends the call politely on the third such turn in a row.
- **A stricter start** (`routing.startAt`).
- **A way out of a task.**
- **A receptionist's greeting.**

The same 300 simulated calls were run again and labelled by the same brief.

**Time of day.** These calls ran on Friday at about 1 am Eastern, with the shop closed but today's windows still
ahead. The baseline ran on Thursday afternoon, and the first journeys run on Thursday night.

### Routing, measured again

The routing labels gained two things:
- the split of `none` into "a question about the business" and "none of these";
- `fits` for turns inside a task.

That gives 304 caller turns from the baseline's calls: 23 questions, 36 none, and 10 turns inside a task that did
not fit.

**The first wording measured badly.** It was a `fits` question about "what the line just asked for", with a turn at
the root unclear whenever a journey read below the start bar. It flagged ordinary turns as unclear: only 21% of its
unclear readings were right.

Three things were reworded:
- `fits` now asks whether the turn has anything to do with the task;
- "a question" now includes questions about the line itself;
- a turn at the root is unclear only when "none of these" is the top reading.

The table below is that wording, recorded at `routing.switchAt` 0.6.

| Start bar | Accuracy | Unclear recall | Unclear precision | Missed starts |
| --- | --- | --- | --- | --- |
| 0.6 | 0.90 | 0.32 | 0.55 | 8 of 52 |
| **0.7 (the wheel shop's)** | **0.90** | **0.32** | **0.55** | **10 of 52** |
| 0.8 | 0.88 | 0.32 | 0.55 | 17 of 52 |
| 0.9 | 0.87 | 0.32 | 0.55 | 19 of 52 |

**Why 0.7.** It keeps 0.6's accuracy with fewer wrong starts, while 0.8 misses a third of the callers' starts. No
bar met the plan's rule (unclear recall of 0.9 with missed starts under 5%).

**The unclear reading misses a lot, by design.** It catches a third of the labelled unclear turns. Most of the rest
are off-topic asks (a tyre quote) that start the repair request, where the model then says the shop doesn't do
tyres. Its precision is what protects callers who are cooperating.

The decision model answered in 74 ms at the median and 101 ms at the 95th percentile.

**These routing figures are in-sample.** The rewording was chosen on these same labelled turns and scored on them
again, so 0.88 to 0.90 flatters it somewhat. The calls below are the out-of-sample check. The accuracy bar in the
design (95%) is not met.

### Wrong replies

**The merge bar.** The bar was "no worse than the baseline". On the raw rate of wrong replies it is missed by 0.8
per 100 calls (12.5 against 11.7). Severity 2 or more is level (8.3). Removing the three labels the baseline's
labellers did not count gives 11.3. This is a labelling call, left to the maintainer.

| Per 100 calls | Baseline | Journeys, first run | Journeys, after the amendment |
| --- | --- | --- | --- |
| Wrong replies (12 personas) | 11.7 | 13.8 | 12.5 |
| Severity 2 or more | 8.3 | 8.8 | 8.3 |
| Gaps | 14.2 | 17.5 | 4.6 |
| Wrong replies (3 new personas) | | 11.7 | 8.3 |

- **Three of the 30 are severity 1 replies saying a request "didn't go through"** while it only waited for the
  caller's yes. That pattern is in the baseline's calls too, unlabelled there. Without them the rate is 11.3.
- **Gaps fell by two thirds.** Gaps are commitments the business information does not cover. Each task's own facts
  answer more of what callers ask.

### Whether callers got what they came for

| Persona (expects) | Baseline | First run | After the amendment |
| --- | --- | --- | --- |
| retail-all-at-once (request) | 10/10 | 17/20 | 18/20 |
| retail-out-of-order (request) | 9/10 | 3/20 | **15/20** |
| retail-corrects-readback (request) | 10/10 | 13/20 | 14/20 |
| asks-if-real-person (request) | 6/10 | 7/20 | 16/20 |
| discount-pusher (request) | 10/10 | 19/20 | 19/20 |
| terse (request) | 7/10 | 7/20 | 17/20 |
| rambling-fragments (request) | 8/10 | 19/20 | 18/20 |
| dealership-regular (booking) | 4/10 | 11/20 | 14/20 |
| wants-a-person (callback) | 8/10 | 19/20 | 19/20 |
| **All nine** | **72/90 (80%)** | **115/180 (64%)** | **150/180 (83%)** |

The caller who opens with only a number and a day is now guided to the task, and 15 of 20 finish it.

### Switching, side questions, wandering, and calls ended as unclear

| Persona | First run | After the amendment |
| --- | --- | --- |
| switches-to-callback: the callback taken up as its own task, then back to the request | 11 of 18 | 18 of 20 |
| switches-to-callback: something already given asked again | 4 calls | 2 calls |
| side-question: hours and parking answered, request carried on | 20 of 20 | 20 of 20 |
| wanders-off: the price given | 20 of 20 | 20 of 20 |

**Calls ended as unclear.** Eleven calls were ended this way, all from the off-topic persona (tyres, headlights,
restaurants), and every one was read as fair: a receptionist could not have helped either. In 7 of them the
guidance before the end said exactly what to say; in 4 it said what the line can do without a phrase to say.

**Rough edges:**
- A caller's plain goodbye that arrives as the third unclear turn hears the "this line can only help with…" line
  rather than the closing line.
- The read-back says the window as the shop labels it ("afternoon, by noon"), and some callers argued with that
  wording. It is the shop's wording, and was there before journeys.

### Speed and cost

| | Baseline | Journeys, after the amendment |
| --- | --- | --- |
| First sentence, median | 0.74 to 0.76 s | 0.68 to 0.71 s |
| First sentence, 95th percentile | 1.24 to 1.29 s | 1.16 to 1.24 s |
| Timeouts | 0.0 to 0.9% of turns | 0.7 to 1.2% of turns |
| The line's model, per call | $0.0038 to $0.0040 | $0.0032 to $0.0033 |

The second run cost $1.41.

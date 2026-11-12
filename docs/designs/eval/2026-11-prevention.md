# Prevention, measured: the wheel shop's wrong replies before and after (2026-11-12)

After [the check after speaking](../2026-11-11-claims-check.md) was measured and turned off (it did not tell
the real wrong replies from the right ones), the effort went to keeping wrong replies from being said. Each set
below is 120 simulated calls of `apps/wheelshop-agent` (its twelve personas, five calls each, twice), with the
check off and no judge model. Every reply of the line was labelled by an assistant in the session against the
business information, the call's actions and what the caller said: wrong (a price, time, thing done, process or
caller's detail stated falsely), its severity (0 to 4) and its kinds, or a gap (a commitment the business
information does not address). The labelled replies stay outside the repository with the runs.

## The changes

1. **The prompt and the business file** (commit b1d3d580): the web chat said to have no number the caller is
   calling from; a service with no price says so; a day no lookup has looked at is not known to be full or free;
   the read-back's own words are the business's and cannot be changed; rule 5, a caller's details said back as
   given with nothing added; the shop's hours with a closing time; a request is not a booking until the caller
   says yes to the price; a request or a callback note needs a number the caller gives.
2. **The shop's lookup says why** (358772c7): `check_availability` gives each window without room with why (its
   drop-off time has passed today, or it is full) and a closed or past day as one entry.
3. **The line's record of the call** (5d5f0d69): every request ends with what has been done on the call, kept by
   the runtime as each change runs (each change with its read-back as the caller confirmed it and what it
   returned, or that nothing has), and a read-back waiting for a yes.

## The results

| Set | Model | Changes | Replies | Wrong | Wrong, severity 2 or more | Gaps only |
| --- | --- | --- | --- | --- | --- | --- |
| Before (2026-11-11) | Mercury 3, minimal | none | 695 | 28 | 20 | 14 |
| After 1 | Mercury 3, minimal | 1 | 769 | 33 (23 without "today is full") | 21 | 22 |
| After 1 to 3 | Mercury 3, minimal | 1, 2, 3 | 776 | 16 | 14 | 20 |
| After 1 to 3 | Muse Ember 1.0, minimal | 1, 2, 3 | 713 | 14 | 10 | 17 |

The kinds of the wrong replies:

| Set | Details | Process | Done | Price | Time | Other |
| --- | --- | --- | --- | --- | --- | --- |
| Before | 12 | 11 | 3 | 3 | 2 | 2 |
| After 1 | 6 | 6 | 10 | 2 | 14 | 3 |
| After 1 to 3, Mercury | 4 | 7 | 1 | 3 | 1 | 1 |
| After 1 to 3, Ember | 2 | 3 | 5 | 0 | 2 | 3 |

- **The prompt alone moved the kinds, not the total.** The closing-time gaps (5) and the callbacks offered
  without a number (3) went; the caller's details misstated halved; but replies saying a window was "held" or a
  request "confirmed" before anything ran rose, and ten said today was full when its windows' drop-off times had
  only passed (the labellers of the first set were not told the time of day, so could not see that kind).
- **What the runtime and the lookup know, told plainly, halved the wrong replies.** With the lookup's reasons
  and the record of the call, "today is full" went from 10 to none and the "done" claims from 10 to 1, on the
  same model.
- **Ember is at least as good as Mercury with the same changes:** 14 wrong against 16, 10 serious against 14,
  at about half the cost per call ($0.0039 against $0.0077), and slower: its first sentence at a 0.75 s median
  and 1.26 s p95 against Mercury's 0.58 s and 1.03 s, both inside the bars (1.2 s and 2.5 s); timeouts 0.4% of
  713 turns against none.
- **What is left:** a callback note said to carry what its params do not (Ember 4, Mercury 1); a ballpark's low
  end called the floor (Mercury 3, one persona); the read-back's words said to be changed (Mercury 2). The gaps
  are mostly a waitlist the business information does not mention (17 of the 37), for the owner to answer.

The counts are small (a set of 120 calls has about 15 to 30 wrong replies), so a difference of a few is noise;
the halving after changes 2 and 3 is not. Each set was labelled by different assistants, from the whole call's
transcript and actions (the first set from what the check was sent for each reply), so the sets compare roughly.

## What followed

- Inception ends Mercury on 2026-12-28, so the wheel shop's model became Muse Ember 1.0 at `effort: minimal`
  (the maintainer's call, 2026-11-12, on these runs and [the model comparison](2026-11-model-comparison.md)).
- Journeys, a task's own instructions brought in only while that task is under way (the maintainer's idea,
  2026-11-12), are designed next, with these figures as the baseline.

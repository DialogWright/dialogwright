# After hours, measured (2026-11-13)

The converse runtime's after-hours change has four parts:
- `business.open`: the business's opening hours, structured;
- the model is told on each turn whether the business is open, and when it closes or next opens;
- an after-hours greeting;
- rule 1: a callback time is given only where the business information gives one.

The wheel shop also stopped giving callback times ("As soon as the shop can; we don't give a set time").

**The run.** The same 300 simulated calls were run on Friday, November 13, at about 2 am Eastern, with the shop
closed. They were compared with [journeys after the amendment](2026-11-journeys.md#part-2-guide-the-caller-dont-guess),
run at about 1 am the same night, and labelled by the same brief. The brief added one line: a reply giving a time or
day for a callback contradicts the business information.

**Verdict:** not ready. The change did what it was for, but it brought a new kind of time promise, and the other
figures are worse. The branch stays as it is.

## What it fixed

- **Every call opened with the after-hours greeting.**
- **No reply gave a clock time or a day for a callback,** apart from one that named the caller's own drop-off day.
- **Only one reply got open or closed wrong.** At 2 am it said "closed until 7:30 am tomorrow, Friday" when the shop
  opened that day.

## What it brought, or showed

| Per 100 calls (12 personas) | Journeys after the amendment (1 am) | After hours (2 am) |
| --- | --- | --- |
| Wrong replies | 12.5 | 17.5 |
| Severity 2 or more | 8.3 | 12.5 |
| Gaps | 4.6 | 14.2 |
| Requests done (9 personas that expect one) | 83% | 74% |

- **Callbacks tied to the opening time.** Now that the model knows the opening time, it ties callbacks to it: "once
  they open at 7:30 this morning", "when they open". There were six such replies. That is still a callback time.
- **"There's no way to leave a callback note."** Ten replies said this in the middle of a repair request, where the
  callback task's action isn't offered. The line should offer to switch to the callback instead. This comes from
  journeys, not from after hours.
- **The reply deadline for a same-day drop-off.** At 2 am today's windows are still bookable. The business
  information says to reply by 6 pm the day before drop-off, so the model gave a deadline that had already passed,
  in three replies. The owner needs to answer what happens then.
- **Terse callers hung up sooner.** After "We're closed right now", 12 of 20 terse calls ended with nothing done,
  against 3 of 20 the night before.
- **Gaps rose to 14.2.** They include several "we'll be in touch soon" endings, which the new line in the brief
  made the labellers notice.

## Speed and cost

| | Journeys after the amendment | After hours |
| --- | --- | --- |
| First sentence, median | 0.68 to 0.71 s | 0.73 to 0.76 s |
| First sentence, 95th percentile | 1.16 to 1.24 s | 1.25 s |
| The line's model, per call | $0.0032 to $0.0033 | $0.0031 to $0.0032 |

The run cost $1.36.

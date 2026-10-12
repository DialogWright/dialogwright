# The console as a call-center dashboard: the build

Date: 2026-10-12. Status: **build plan; being built.** Source: the maintainer, 2026-10-11, on a mockup: today the console opens on one call; a realistic console opens on the calls in progress, a click opens a call's detail as today, a menu leads to the console's other pages, with statistics, minutes and cost. His answers: supervisors will use it eventually (so a "take this call" action and console roles with single sign-on come later, not now); alerts yes; carrier cost from a per-minute rate per carrier, left out when no rate is set. It builds on Phase 8b (one console sees every server's calls) and several apps (every app's calls, with a filter).

## Pages

1. **Live, the home page: what is happening now.**
   - A strip of four numbers: calls in progress; waiting for a person or being transferred; today's share handled with no person (containment); today's cost.
   - The calls in progress, one row each: the app; the caller, masked as today; the channel and carrier; what the caller is doing (the task and the step); how long; and a status: on track, a second try (a slot past its first attempt), frustrated, transferring, with a person (handed off).
   - A click opens the call's detail, the view the console has today, live.
   - Alerts: a call that turns frustrated or starts waiting for a person is marked in the list, counted in the page title and, when the viewer has turned it on, makes a short sound. The sound is off by default and remembered per browser.
2. **Calls: what happened on a call.** Past calls from the traces (local files or the S3 store), newest first, searchable by the caller's last four digits, a date range, the app, the task and how the call ended (handled, to a person and why, hung up and where, an error), paged; a click opens the call's replay as today.
3. **Insights: how the line is doing.** For a date range and an app (or all):
   - calls, and calls by hour with the peak number at once;
   - containment: handled with no person;
   - transfers by reason;
   - abandonment by step: the last question a caller heard before hanging up;
   - where callers struggle: re-asks, silences and slots that ran out, per slot and per question;
   - task completion per intent: started against finished;
   - call length overall and per task;
   - minutes, the decision model's cost (exact, from the trace), the carrier's cost when a rate is set (`CARRIER_RATE_PER_MIN_TWILIO`, `CARRIER_RATE_PER_MIN_TELNYX`, in dollars per minute; left out entirely when unset), and cost per call and per handled call;
   - safety: the injection screen's hits and the gate's refusals by rule;
   - after-hours calls (routes on `hours`), and the knowledge base's unanswered questions (the count `kb:gaps` would rank, with the command to run).
   Figures are computed from the traces and cached per app and day, so a page does not read every trace every time; today's are recomputed as calls end.
4. **Knowledge: the knowledge base at a glance**, per app: passages by state (fresh, stale, edited, never approved, drafts) as `kb:status` reports them, and the top unanswered questions. Read-only: approving stays a person at their terminal or the local review page until console roles exist.
5. **Health: is the line healthy.** The servers seen in the last minutes (with a shared store, every server; else this one) and their calls; `/health`'s numbers (sessions, trace write failures, disk and its low-space warning); the decision model's latency (median and 95th percentile over the last hour); reconnects and fallback dials today; the audit verified on demand.

## Decisions

1. **Same server, same sign-in.** The console stays where it is (`/dashboard`), behind `CONSOLE_AUTH` (local or token) and its access log; every new page and data path is under it and recorded as today. Nothing new is reachable without a session.
2. **No build step, nothing from elsewhere.** The page stays the console's own HTML and script under its nonce Content-Security-Policy; charts are inline SVG drawn by its own script; no library from a CDN.
3. **Redaction as today.** Every new view shows only what the console already may: masked numbers, masked slots by their app's settings, no secrets. Aggregates hold counts and durations, never values.
4. **Phone width.** Every page works at 375 pixels: the list becomes cards, the strip wraps, charts scale.
5. **One app, no host:** the app column and filter are hidden; everything else is the same.
6. **Later, by decision:** taking over a call, console roles and single sign-on, approving passages in the console, exports.

## Items

Built in two items through the usual loop (a worktree, an implementer, a reviewer, the full local suite, a fast-forward onto local main):

- **Console 1: the frame, Live and Calls**, with the alerts and the call detail reached from both.
- **Console 2: Insights, Knowledge and Health**, with the daily figures cache and the carrier rates.

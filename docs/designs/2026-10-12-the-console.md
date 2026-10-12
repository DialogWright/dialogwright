# The console as a call-center dashboard: the build

Date: 2026-10-12. Status: **build plan; Console 1 built (see As built), Console 2 next.** Source: the maintainer, 2026-10-11, on a mockup: today the console opens on one call; a realistic console opens on the calls in progress, a click opens a call's detail as today, a menu leads to the console's other pages, with statistics, minutes and cost. His answers: supervisors will use it eventually (so a "take this call" action and console roles with single sign-on come later, not now); alerts yes; carrier cost from a per-minute rate per carrier, left out when no rate is set. It builds on Phase 8b (one console sees every server's calls) and several apps (every app's calls, with a filter).

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

## As built (Console 1)

**The pages are one page.** `/dashboard` stays the one HTML page under its nonce policy, with client-side navigation by the address's fragment: `#/live` (the home page), `#/calls` (its filters in the fragment, so Back keeps them), `#/insights`, `#/knowledge`, `#/health`, a call's detail at `#/call/<id>` and its replay at `#/replay/<id>?app=<app>`. `#/call/latest` is the view that follows each new call as it starts, as `/dashboard` used to open (the Live list links to it as "Follow the newest call"), so a presenter keeps today's view. The fragment never reaches the server, so every data path is the same few routes behind the console session. Insights, Knowledge and Health are sections that say what they will show; each is an entry in the page's `PAGES` table, waiting for an `enter` of its own.

**The bus keeps every call.** It followed only the newest call (a second call's start dropped the first's history), which a list of calls in progress cannot be built on. It now keeps each call's history: every call in progress, and the newest twenty that ended (bounded at 500 calls, 2,000 events each). An event for a call it never saw start is still ignored. The idle sweep publishes the end of every evicted call, not only the newest's. The default live feed still follows the newest call, filtered on the server (on a host with `?app=`, the newest of that app's calls), so one machine's view is as it was; `?call=<id>` is one call's feed, for a call's detail.

**The Live list is worked out on the server.** Sending every call's every event to each viewer would send each call's whole history (questions, records) to a page that shows one line of it. `/dashboard/events?view=calls` sends every kept call's row, then each row that changed and each call gone; the rows are worked out once per bus (`server/dashboard/live.ts`) by the same function the page could use (`view.js callRow`), from the events the bus already carries, each in its own app's words. No new event field was needed: the status is read from the records (`gates`' frustration row, `slots[promptedFor].attempts`, a handoff decision) and the bus's `handoff` and `ended` events. A row holds the masked caller, the app's labels for what was asked, counts and times, never a value a caller gave.

**Statuses.** Frustrated is sticky for the call once the frustration gate fires (its first two rungs or its handoff), as the session's own count is. With a person is a call that ended in a handoff: the server never sees the person's leg, so the row stays two minutes (`HANDED_OFF_SHOWN_MS`) and leaves the list. Alerts are the frustrated, transferring and with-a-person rows; an alert is a change (the page's first list raises none).

**Calls: a summary read from the trace, kept in memory; nothing written.** The plan offered reading a call's first and last records, or a summary written when a call ends. Neither gives everything the page shows: how a call ended is in the frame log (its `end` frame, a closed socket, a chat's `ended`), not the records, and the cost is every record's. A summary file written at the end would need every end path (the adapter, the hangup webhook, the idle sweep, the chats) to write one, and nothing for calls made before it. So `server/dashboard/calls.ts` lists calls by name (a folder's files with their sizes and times; the store's day folders and segment names, the reader now narrowing by day), and reads a call's trace and frame log only for the page shown or, for a filter a name cannot answer, newest first until the page is filled, folding them as the page folds a replay (`replayEvents`, `callRow`), redacted as the replay route redacts them. Each summary is kept in memory for the server's run by the call's size and last write; one request reads at most 1,000 calls and says when it stopped there. Console 2's daily figures cache is where summaries would be kept across runs. The order is newest first by last write (what names give), and the date range is on each call's start. A call with no end recorded and nothing written for 30 minutes is shown as ended with "no end recorded" (an error, or to a person if a handoff was under way).

**Today's figures** (`/dashboard/today?since=<the viewer's midnight>`) come from the same summaries: containment is the share of today's ended calls no person took; the cost is the decision model's, every record's `usage.costUsd`.

**A feed's losses.** The page used gaps in the events' numbers to tell a stalled viewer it had missed events; a feed of one call now has gaps that are no loss (the numbers are the bus's, across calls). The server says it instead: an `event: missed` with the count before its next write, and the Live list sends the whole list again.

**Recorded as before.** Opening the Live list or a call's detail is opening the live feed (`live`, its first open in a session); a replay from the Calls page is a `replay` entry as every replay is; the Calls list, like the traces list, is a list and records nothing. Every new path answers 401 without a session (tested with the sign-in's other paths).

**Not done here.** The list is not virtualised (hundreds of calls in progress draw as hundreds of rows); the sound needs one touch of the page after a reload before a browser lets it play.

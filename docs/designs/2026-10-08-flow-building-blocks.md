# Flow building blocks: the classic IVR toolkit in DialogWright terms (design, for review)

Date: 2026-10-08. Status: **proposal for the maintainer to review; nothing here is built.** Engine: DialogWright local `main`. Source: the principle in [2026-10-08-decisions.md](2026-10-08-decisions.md): "we read in data, we process forms, nothing is limited by the framework".

## At a glance

A classic IVR designer works with six kinds of step:

1. read telephony data;
2. write telephony data and transfer;
3. dip into data;
4. branch on ordered conditions with a default;
5. play without collecting;
6. collect with retries and confirmations.

DialogWright already does most of 6 and parts of 3 and 5. It is weak on 1, 2 and 4: an app can't read the carrier's attached data, can't send data with a transfer or pick where a transfer goes, and can't route on data without writing TypeScript. This design proposes one building block per gap, each declarative and off by default, and an order to build them in. It doesn't propose a flowchart editor or a state machine: the caller still drives the call with what they say, and these blocks decide what happens around that.

| Classic step | Today | Proposed |
|---|---|---|
| Telephony data in | Caller and called number only (`callerOf`, `calledOf`). Custom parameters and call ids reach the log, not the app. | `callData`: an allowlist of carrier parameters (and chat page context) the app may read, with redaction. |
| Telephony data out, transfer | One `HANDOFF_NUMBER`, a cold `<Dial>`, `handoff.data` JSON that stays on our side. | Transfer targets per reason or form; data sent with the transfer as SIP headers or parameters; warm transfer later. |
| Data dip | A call-start lookup by caller number; form entry calls and hooks; facts. | A general start hook (`onStart`), `failSoft` for app calls, and route-time dips (below). |
| Branch | Intents decide; checks can stop or hand off; app code can't move to another form. | `routes`: ordered `when` conditions with an `else`, at call start, after identity and after a form, that can go to a form, say a line, hand off or end. Business hours as a condition. |
| Play only | Informational intents, acks, `said` completions; greetings fixed. | `notices`: a line said before the open question when a condition holds; greeting variables from facts. |
| Collect | Slot types, a global three-attempt ladder, read-back and summary options. | Per-slot `attempts`, separate no-input and no-match prompts per attempt, and `onMaxAttempts` per slot. |

## 1. Telephony data in: `callData`

```yaml
# app.yaml
callData:
  accountRef: { from: param.accountRef, redact: last4 }   # Twilio <Parameter> / Telnyx custom parameter
  queue:      { from: param.queue }
  forwardedFrom: { from: forwardedFrom }                  # a field of the setup frame
  page:       { from: chat.page }                          # chat: allowed page context keys
```

- Only named keys are kept. Each comes from the setup frame (`param.<name>`, `forwardedFrom`, `callerName`, call ids) or, on chat, a new optional `context` object on `start` with the keys the app allows.
- App code reads them with `callDataOf(s)`. Routes and checks can name them.
- The model never sees them unless the app passes them in `callerState`.
- Redaction applies in the trace and the console as for slots.
- `pnpm check` refuses a key with no `from`.
- The server can also write app-chosen `<Parameter>` tags into the start document, for apps that receive calls from their own systems.

## 2. Telephony data out: transfer targets and data

```yaml
# app.yaml
transfer:
  default: { to: env.HANDOFF_NUMBER }
  byReason:
    billing:   { to: env.BILLING_NUMBER }
    emergency: { to: env.EMERGENCY_NUMBER }
  send:                           # what goes with the call
    headers: { X-Account-Ref: callData.accountRef, X-Reason: reason }   # SIP headers where the carrier supports them
```

- A handoff's reason picks the target, with `default` otherwise. The numbers stay in the environment, never in YAML.
- `send` maps headers or parameters to values from `callData`, slots (as `handoff.data` allows) or the reason. Each carrier adapter writes what it supports: Twilio `<Sip>` headers or `<Dial>` parameters, Telnyx custom headers. A value the carrier can't carry is dropped and logged.
- Warm transfer (play a whisper to the agent, then bridge) is a later step: it needs carrier-specific call control.
- Chat: the transfer event carries the same reason and an allowlisted subset for a live-chat handover.

## 3. Data dips: `onStart`, `failSoft` for apps

- `App.onStart(ctx)` runs once before the greeting, for every call, not only one with a caller number. It goes through the gate like any app call, and can fill facts from `callData`, the called number or the time. The existing caller lookup stays as a special case.
- `ctx.callTool(call, { failSoft: true })` lets an app treat a failed dip as "no data" rather than a handoff, as the call-start lookup already does.
- Async tools with timeouts and retries are already on the roadmap (design.md, item 9). Routes would use them when they exist.

## 4. Branching: `routes`

```yaml
# routes.yaml
start:                     # before the open question
  - when: { hours: closed }
    then: { say: after_hours, then: end }
  - when: { fact: outage, is: true }
    then: { say: outage_notice, then: continue }
  - when: { callData: queue, in: [spanish] }
    then: { locale: es-MX, then: continue }
  else: continue
afterIdentity:
  - when: { fact: pastDue, is: true }
    then: { form: payment_plan }
  else: continue
afterForm:
  report_outage:
    - when: { slot: severity, in: [danger] }
      then: { handoff: emergency }
    else: anything-else
```

- **Points**: `start` (after the greeting and any greeting question, before the open question), `afterIdentity` (when the caller reaches level 1), and `afterForm.<form>` (when that form completes as `said`). These are the places a classic flow branches and DialogWright already has a seam.
- **Conditions are a small fixed set**, never an expression language:
  - `fact`, `slot`, `callData` with `is`, `in`, `notIn` or `present`;
  - `principal: { level: 1 }`;
  - `hours: open | closed`;
  - `called: [numbers by name]`;
  - `named: <a predicate in code>`, for anything else.
  The rules are tried in order, the first true one is taken, and `else` is the default and required.
- **Outcomes**:
  - `continue`;
  - `say: <prompt>` then an outcome;
  - `form: <form>` (an intent form or an internal one);
  - `handoff: <reason>`;
  - `end`;
  - `locale: <tag>`;
  - `anything-else` (after a form).
- Every route taken is a trace event and an audit row (`route { point, rule, outcome }`), and the app map draws them.
- **Business hours**: app.yaml `hours: { timezone, weekly: {...}, closed: [dates] }`. That is one place, and `hours` conditions read it.
- **Not a state machine.** A caller can still say anything at any time, and intents, priority intents and the agent intent still decide first. Routes decide only at their points.
- **`pnpm check`**:
  - unknown facts, slots, callData keys, prompts and forms;
  - a missing `else`;
  - a rule after one that is always true;
  - a `form:` route into a form whose identity level the point can't reach (a warning).

## 5. Play only: `notices` and greeting variables

- A `say` outcome in `start` routes covers the outage notice and "we are closed" cases.
- Greeting variables from facts (deferred from the 2026-10-08 app-decides work) let "Welcome back" or "your next appointment is Tuesday" be said with no question. This needs prompt variables with dotted names, or facts copied into plain variables by `onStart`. The second is simpler and needs no template change.

## 6. Collect: per-slot retries

Proposed keys, not built (a `text` block, so the doc-block test does not read it as slots.yaml):

```text
# slots.yaml
accountId:
  type: digits
  attempts: 4                 # default MAX_ATTEMPTS (3)
  onMaxAttempts: skip         # handoff (default) | skip | end | form:<id>
# prompts: ask_accountId_noinput, ask_accountId_nomatch, ask_accountId_retry2 (each optional, falling back as today)
```

- `attempts` overrides the global ladder per slot.
- Separate prompts for silence (`_noinput`) and a missed answer (`_nomatch`), and per attempt (`_retry2`, `_retry3`). Each is optional and falls back to today's prompt.
- `onMaxAttempts` replaces the fixed handoff:
  - `skip` leaves the slot empty and declined (an optional slot);
  - `end` says a line and ends;
  - `form:` goes to another form.
  A required slot with `skip` is refused by `pnpm check`.

## Suggested order

1. **Per-slot retries.** Small, asked for by every IVR designer, and it touches only the collect loop.
2. **`callData` and transfer targets and data.** These open the carrier integration that contact centres expect.
3. **`routes` with `hours`.** The largest piece. It wants 1 and 2 to be useful, and `onStart` with it.
4. **Greeting variables, warm transfer, async tools,** as needs show.

## Questions for the maintainer

1. Are the three route points enough, or is a route at "after any slot fills" wanted? That would be checks with a `form:` outcome instead.
2. Should `routes` live in app.yaml or in their own `routes.yaml`? A separate file is proposed, as policy and forms each have theirs.
3. Should transfer targets be chosen by reason only, or also by form and by `callData` (for example, a VIP queue)?
4. Which carrier first for headers on transfer: Twilio or Telnyx?

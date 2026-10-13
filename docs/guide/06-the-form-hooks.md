# 6. The form hooks

[Contents](README.md) · Previous: [5. Writing a slot](05-writing-a-slot.md) · Next: [7. Checking an app: `pnpm check`](07-checking-an-app-pnpm-check.md)

`forms.yaml` lists the hooks a form has, and `code.forms.<id>` writes them. `complete` is required; the rest are optional. The hook names, in the order the contract documents them (the type is `FormDef` in `core/app/types.ts`):

| Hook | When it runs |
|---|---|
| `entry` | A call made before the form's own slots are asked (it may step identity up). |
| `onEntry` | Applies a successful entry call's result to the session. |
| `principalEntry` | In place of `entry`, for someone acting for subjects (a delegate). |
| `confirmedParams` | The values a confirmed write sends, read from the session, for the gate's `confirmed` rule. |
| `complete` | The form is full (and confirmed, where it has a summary): does the work, usually by calling a tool through the gate. |
| `onAnswers` | The form heard a spoken turn: lets it keep a volunteered preference. |
| `onSummaryAnswer` | At the summary, an answer that was neither a yes nor a change: the form's own move along what the summary offers. |
| `keepsSlot` | At the summary, whether a named detail is kept and the answer is the form's own move instead. |
| `onSummaryRead` | The summary is about to be read: lets the form look at what it names that the slots do not hold. |

The clinic's reschedule form has six: `[onSummaryRead, onAnswers, onSummaryAnswer, keepsSlot, confirmedParams, complete]`. The library's check_hold has one. Start with `complete` and add a hook only when the form needs it.

Where they run in a turn: the turn fills slots (speech, the keypad, a correction at the summary), then the form loop asks a disambiguation or a slot read-back if one is due, makes the `entry` call if the form has not passed it, runs the routes after identity the first time the caller is through it ([routes.yaml](02-the-files-one-by-one.md#routesyaml-optional)), runs the form's `checks` ([forms.yaml, Checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)), and asks the next slot or reads the summary. A `STEP_UP` from the entry call or from a check asks for identity first, and the loop comes back to the same place once the caller is verified. A yes at the summary runs the checks once more, then `complete`; a `said` completion runs the routes after the form, then its `next`. A form that rules a caller out on an answer needs no hook for it: write a check, not a `complete` that turns the caller away after the rest was asked, and never write `s.queued` from a hook to chain a second form: a `next`, a check's outcome or a route does that.

### The start hook, predicates and `failSoft`

Three pieces of code an app may write beside its forms' hooks:

- **`code.onStart(ctx)`**, the start hook: runs once as every call or chat starts (not only one with a caller number), before the call-start lookup and the start routes. It may read the call data (`callDataOf(ctx.s)`), the numbers (`callerOf`, `calledOf`), the clock (`ctx.tc.nowMs`), the app's own settings (`ctx.env(name)`, [chapter 4](04-what-stays-in-typescript-and-why.md#settings-ctxenv-never-processenv)), write the facts a route or a line reads, and call tools through the gate (`ctx.callTool`), each recorded as any call is. One that throws leaves the session as it was before the hook ran (the facts, the call data, anything else it wrote) and drops the side effects it queued; the calls it made stay recorded (one whose tool threw, as failed, with or without `failSoft`), the trace's start record says `startHookFailed` with the kind of error (its class's name, never its message), the server's log and the frame log say so too, and the call goes on. The hook cannot hand off: a refusal or a `NEEDS_HUMAN` one of its calls gets (a result the policy's `redact:` cannot strip, say) is the hook's to read, and the call goes on to the routes and the greeting, as after a call-start lookup the gate refused. The hook runs before the greeting, so its tools' time is the caller's wait at pickup: answer from the app's systems as they are. app.yaml says so, with the actions it calls, so `pnpm check` knows they are reached: `onStart: { calls: [lookupNotices] }` (`onStart: {}` for none). The call-start lookup is unchanged.
- **`code.predicates`**: conditions of the app's own, by name, for a route's or a transfer target's `{ named: <name> }`. Each is given `{ s, nowMs, todayIso, env }`, the session a copy (what it writes is lost) and `env(name)` the app's own settings, and returns true or false; one that throws is false. A predicate decides only; it calls no tool.
- **`failSoft`**: `ctx.callTool(call, { failSoft: true })`, in any hook, makes a tool that throws fail the call, not the turn: the call is recorded as allowed with the summary `the tool failed: nothing was returned` (nothing of the error, whose message may hold a value), the side effects it queued are dropped, and the result is `{ decision, value: null, failed: true }`, so the hook treats a failed dip as no data, as the call-start lookup does. Without it, a throw goes up to the turn, as it always has.

From the routed fixture:

```ts
onStart(ctx) {
  const region = callDataOf(ctx.s).region;
  if (region === undefined) return;
  const { decision, value, failed } = ctx.callTool({ tool: 'lookupNotices', params: { region } }, { failSoft: true });
  if (decision.verdict !== 'ALLOW' || failed === true) return;
  (ctx.s.facts as RoutedFacts).outage = (value as { outage?: unknown } | null)?.outage === true;
},
predicates: {
  // An account marked vip, or a number the app's own VIP_NUMBERS setting lists, read at call time.
  vip: ({ s, env }) => {
    const number = callerOf(s as Session)?.number;
    if (number === undefined) return false;
    return ACCOUNTS.some((a) => a.vip && a.phone === number) || (env('VIP_NUMBERS') ?? '').split(',').some((n) => n.trim() === number);
  },
},
```

A completion that ends the call (`{ kind: 'end', promptId, vars, acks }`) is followed by the app's `goodbye` line, as a `then: end` outcome is; `goodbye: false` on it ends the call on its own line, for a line that says goodbye itself.

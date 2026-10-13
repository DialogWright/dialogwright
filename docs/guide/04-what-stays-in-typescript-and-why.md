# 4. What stays in TypeScript, and why

[Contents](README.md) · Previous: [3. Policy and identity](03-policy-and-identity.md) · Next: [5. Writing a slot](05-writing-a-slot.md)

The test for what is data: could a person who does not write code review it, and could it be wrong without anything executing? Intents, forms, prompt text, the gate's tables and presentation are like that. What runs stays in code, because YAML that tried to describe it would grow into a language of its own. The code is one object, `code: AppCode`:

| Part of `code` | What it is | Why it is not YAML |
|---|---|---|
| `slots` | A `SlotSpec` per slot: the questions the decision model is asked, how its answers become a value (`fill`), the keypad shape, how it is read back (`display`). [Section 5](05-writing-a-slot.md#5-writing-a-slot) says how to write one. | It is a parser. Most slots need none: a library type named in slots.yaml (section 5) supplies it, and code is for a value no type fits. |
| `tools` | A `ToolDef` per tool: `run(call, sys, ctx)` does the work and returns `{ value, summary }`; `check(value)` says what its reply must look like ([below](#a-tools-reply-is-not-trusted-check)) | It calls the app's systems. It never decides whether it may run: the gate does, from policy.yaml. |
| `systems` | A factory for a fresh copy of the app's systems for each call, and the gate's lookups over them (`ownerOf`, `scopeOf`) | State and connections. |
| `forms` | The hooks of each form, by form id (section 6) | They run during the dialog. |
| `customRules` | The app's own policy rules, by the id `custom:` names them by ([section 3.4](03-policy-and-identity.md#34-rules-of-your-own-definerule)) | A rule compares values and decides. |
| `lookups` | The names of the gate's lookups (on `systems().lookups`) the range rules' references may call ([section 3.3](03-policy-and-identity.md#33-the-built-in-rules)) | They are functions of the app's systems. |
| `principals`, `portal`, `services` | Signed-in callers, the app's own portal settings (never read by the engine), downstream service clients | Integration. |
| `facts`, `questions`, `callerState`, `blockPromptId`, `onServiceResult` | What the app keeps on the session, its own model questions, and small decisions the engine asks the app to make | They are functions of the session. |
| `testing` | The hooks the regression harness and the stubs use | Test support. |
| `identity.sendCodeParams` | The one-time code call's params | A function. |

The library's code, in full outline (`packages/dialogwright/src/define/fixture/app.ts`):

```ts
export const libraryCode: AppCode = {
  slots: LIBRARY_SLOTS,
  tools: LIBRARY_TOOLS,
  systems: () => ({ sys: new LibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    renew_loan: { confirmedParams: renewParams, complete: renew },
    check_hold: { complete: checkHold },
    check_loans: { complete: checkLoans },
  },
  customRules: { 'known-branch': knownBranch },
};

export const code = libraryCode;
export const libraryApp = defineApp(LIBRARY_DIR, libraryCode);
```

A tool says what an action does and nothing about whether it may run:

```ts
export const LIBRARY_TOOLS: Record<string, ToolDef> = {
  findHold: {
    run(call, sys) {
      const status = (sys as LibrarySystems).holds[`${call.params.book}@${call.params.branch}`] ?? null;
      return { value: status, summary: status ? `hold ${status}` : 'no hold' };
    },
  },
  // ...
};
```

A custom rule is written with `defineRule`, with the examples that say what it allows and refuses; [section 3.4](03-policy-and-identity.md#34-rules-of-your-own-definerule) has the library's rule in full.

### Settings: `ctx.env`, never `process.env`

The app's code reads its own settings (a desk's number, a list of numbers, a switch) by name with `ctx.env(name)`, as the call needs it: every hook's context has it (a form's hooks, `complete`, the start hook, `callerOffer`, `onServiceResult`), and so do a tool's (`run(call, sys, ctx)`) and a predicate's (`{ s, nowMs, todayIso, env }`). It returns the setting, or `undefined` where it is not set. It reads the same settings an `env.<NAME>` in the app's YAML does:

- on a server of one app, the server's environment (its `.env`, or the file `ENV_FILE` names);
- on a server of several apps (a host file, [14.15](14-running-it.md#1415-several-apps-on-one-server-hostyaml)), the app's own settings file, the whole of it, over the server's settings, so two apps may each set a variable of one name;
- in a scripted call, the call's `"env"` (the server's way, `RunOptions.settings`, is read over it), so a test never reads the shell's: a scripted call that gives none has none, in `regress` and the text harness alike;
- in the text harness's corpus, its prompt and a replay of a call's frame log (`--replay`), the shell's environment (with a model client, the settings file `ENV_FILE` names, else the `.env` where it runs, read into it first). To replay a call of an app on a host, give it that app's settings: `ENV_FILE` at the app's own settings file, or the variables its code reads exported in the shell.

`process.env` is the server's alone: under a host it never holds an app's own file. And code at a module's top level runs once, as the module is imported, before any call: a constant read from `process.env` there is the server's setting at start, whatever the app's own file says. In a live call a predicate's list read that way was empty under a host. Read a setting inside the hook, the tool or the predicate:

```ts
predicates: {
  vip: ({ s, env }) => {
    const number = callerOf(s as Session)?.number;
    if (number === undefined) return false;
    return ACCOUNTS.some((a) => a.vip && a.phone === number) || (env('VIP_NUMBERS') ?? '').split(',').some((n) => n.trim() === number);
  },
},
```

A setting read this way is never recorded: the trace, the audit and the console see only what the code does with it. The gate never reads one: a rule of the app's own (`defineRule`) and the lookups decide from the call, the session and the app's systems, so the policy matrix holds whatever the settings are, and what the agent may do is in policy.yaml, not in a server's settings.

### A tool's reply is not trusted: `check`

What a tool returns comes from a downstream system, and the line that says it trusts it: a billing system's balance, a scheduling system's time, a reference number a case system made. A record someone could write to (a name, a description, an address) can hold a sentence with instructions in it, and a line that says the field would say the sentence. A tool says what its reply must look like with `check`, a function of the value, true when it fits; `replyShape` (from `'dialogwright'`) has the small checks it is usually written with:

```ts
import { replyShape as r, type ToolDef } from 'dialogwright';

const readBalance: ToolDef = {
  params: ['accountId'],
  run(call) {
    const account = accountOf(call.params.accountId ?? '');
    return { value: account ? { balance: account.balance, due: account.due } : null, summary: account ? 'balance read' : 'no account' };
  },
  // The balance and the due date are said to the caller.
  check: r.nullable(r.object({ balance: r.amount(), due: r.isoDate() })),
};
```

A check bounds a field's shape; it does not detect instructions. "Ignore your rules now" is four plain words, and a short-text check passes it. So use a closed form wherever the field allows one: a status is `oneOf` its values, a reference `code()`, a number `digits()`, a day `isoDate()` (never `text()`), an amount `amount()`. A field that is truly free text and said (a person's first name, an item's description) can only be bounded (`text()`); it is then said only in its own place in a fixed line ("Parcel 7101, {item}, is on its way"), never as a line of its own and never followed: that is the residual risk, accepted, and the adversarial suite lists each such field it finds.

The engine checks the reply right after the tool runs, before redaction and before any hook, fact or line reads it. A reply that does not fit (or that the check throws on) is never used: the call is recorded as having run, with the summary `result not used: it did not pass the tool's check` (neither the reply nor the summary it came with), the side effects the tool queued as it ran are dropped, the gate's decision becomes `NEEDS_HUMAN` with the reason `result-unchecked` (`RESULT_UNCHECKED`) and the value null, and **the turn ends in a handoff** with that reason, whatever the app's code did with the null: no line it built is said, and no later call of the turn runs (each is recorded, refused, with the reason `after-unchecked` and the summary `not run: a reply earlier in the turn did not pass its tool's check`; a probe and a form's check, which run no tool, are asked as ever), so the transfer lists only what ran. The handoff is said by the line `handoff_result_unchecked` where prompts.yaml has it, else by `handoff_needs_human`. An app's code should still read the decision before the value (`if (decision.verdict !== 'ALLOW') return c.refusal(decision)`): a refused call has a null value too. A call made with `failSoft` (the call-start lookup among them), and every call the start hook makes, are the exception: the reply is taken as no data, as a lookup that failed, recorded, and the call goes on (the start hook cannot hand off).

A write (a tool that is `idempotent`, or whose action has a `confirmed` rule) whose reply fails has still been made downstream, and is not undone: only its reply is not used. The audit records it as `write ran, reply unchecked`, with the record it made where the tool named a plain reference (`ref`: letters and digits with a hyphen between, at most 40), and the transfer carries the same (`unchecked: [{ tool, wrote: true, ref }]`), so the person who takes the call finds the write rather than makes it again. A write whose reply no line says and no call is made from needs no check.

Name every field a line says or a call is made from: `object` checks only the fields it names. The checks are `text({ words, chars })` (a short phrase: words of letters and digits, a word of letters may end in an abbreviation's period, never a colon, a question or exclamation mark or a line break; eight words and 80 characters unless given), `digits(length)`, `code()` (letters and digits with a hyphen between, a reference such as `OT401` or `A-1001`), `isoDate()`, `amount()` (a plain decimal, at most two places; `amount({ credit: true })` takes a minus first, a balance in the caller's favour), `number({ min, max })`, `boolean()`, `oneOf([...])`, and to put them together `object({...})`, `list(item)`, `nullable(check)`, `all(...)` and `any(...)`; any function of the value will do. Without `check`, every reply is used as it is.

The engine holds the identity tools' replies itself: a verified principal whose first name is not one (more than four words or forty characters once its spaces are collapsed, or anything but letters with an apostrophe, a hyphen, a period, a middle dot or a zero-width joiner inside a word) or whose phone's last four are not four digits is not believed, and the caller goes to a person, since the engine's own lines say both; a sign-in with such a principal is not taken. The id a match names is the app's: the verify tool checks it (`principal: r.object({ id: r.digits(8) })`), since every later call is made for it. The adversarial suite's hostile replies ([section 15](15-the-adversarial-suite.md#15-the-adversarial-suite)) find a field that needs a check: each tool answers with instructions in place of each text field of its reply in turn.

An app outside the engine package imports only from `'dialogwright'` (the clinic's `src/app.ts` does), and the clinic's launchers (`src/index.ts`, `cli.ts`, `regress.ts`, `serve.ts`) show how an app is registered and run.

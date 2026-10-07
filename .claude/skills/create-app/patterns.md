# Patterns

The YAML and TypeScript for what a paragraph usually asks for. Each was built and run in an app scaffolded by `pnpm create-app --identity` (check, type check, tests and regression), with the scaffold's names (`accountId`, `dob`, `verifyCustomer`, `findAccount`, `Systems`, `ACCOUNTS`, `accountIdOf`); use your own. Imports are from `'dialogwright'` unless shown. The reference for every field is [docs/authoring-an-app.md](../../../docs/authoring-an-app.md); the engine's own test app, [the testkit](../../../packages/dialogwright/src/testing/testkit/README.md), uses every hook and is worth reading for a feature these patterns leave out (it is a test fixture, not a model of design).

Contents: [Verification](#verification-level-1) · [A one-time code](#a-one-time-code-level-2) · [Phone and chat](#phone-and-chat) · [Delegates](#delegates) · [Confirmed writes](#confirmed-writes) · [Bounds](#bounds-limit-and-dateinrange) · [A value no slot holds](#a-value-no-slot-holds-in-the-read-back) · [Refusals and handoffs](#refusals-and-handoffs) · [Informational answers](#informational-answers) · [Keypad entry](#keypad-entry) · [What is recorded](#what-is-recorded-params-and-audit) · [Values with no slot type](#values-with-no-slot-type) · [Testing the policy](#testing-the-policy) · [Known gaps](#known-gaps)

## Verification (level 1)

`pnpm create-app <name> --identity` writes this already: `identity.yaml` with the factors (`accountId`, a `digits` slot, and `dob`, a `birthdate` slot), the `verifyCustomer` tool that checks them, and a form whose `entry` call needs level 1, so an anonymous caller is asked for the factors before the form's own slots. The pieces:

- An action at `level: 1` with the `identity` rule. When an anonymous caller reaches it, the gate answers `STEP_UP` and the engine asks the factors, calls the verify tool, and tries again.
- The verify tool returns a `VerifyOutcome`: `{ ok: true, principal }` with the principal it proves, or `{ ok: false }`. The principal is `{ kind: '<subject kind>', level: 1, id, first }`; `first` fills `{first}` in `identity_verified`.
- The subject's own id is the principal's, once verified. Read it from there, so a tool's subject param is always the proven one:

  ```ts
  // src/app.ts
  const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.account?.value ?? '');
  ```

- A read that needs nothing but verification can be the form's entry call itself, or a form with no slots and only `entry` and `complete`.

## A one-time code (level 2)

Add level 2 only when an action needs it. `identity.yaml`:

```yaml
# identity.yaml
levels:
  1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
```

`policy.yaml` (both tools need actions, like every tool):

```yaml
# policy.yaml, under actions:
  verifyCode:
    say: check the one-time code
    level: 1
    rules: [identity, attempts]
  sendCode:
    say: text a one-time code
    level: 1
    rules:
      - identity
      - scope: { param: accountId }
```

`sendCode` texts the phone of the account it names, so the engine keeps it for the subject: it refuses any party who is not the subject (BLOCK `not-subject`) before the rules run, so a delegate cannot have a code texted to someone else's phone and no role rule is needed. The policy matrix and card show it.

The code. The code itself is checked by the engine's verifier (`tc.tools.codes`): in tests and the stub regression it is a mock that accepts any code of the right length whose last digit is even, so a scripted call keys `{ "dtmf": "123456" }` to pass and `{ "dtmf": "123457" }` to fail.

```ts
// src/app.ts, under code.tools
  verifyCode: {
    run(_call, _sys, { tc, code }) {
      const ok = code !== undefined && tc.tools.codes.check(code);
      return { value: ok, summary: ok ? 'code accepted' : 'code rejected' };
    },
  },
  sendCode: {
    run(call) {
      const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId);
      return { value: account ? { phoneLast4: account.phoneLast4 } : null, summary: account ? `texted ...${account.phoneLast4}` : 'no phone' };
    },
  },
```

and in `code`: `identity: { sendCodeParams: (s) => ({ accountId: accountIdOf(s) }) }`. Give the verified principal `contact: { phoneLast4 }` in `verifyCustomer`, as the testkit does.

A form whose action needs level 2 should ask for the code before its own slots, not after the caller has answered everything. Name a purpose for it in policy.yaml (not identity.yaml, though it is about the level) and make the entry call with it:

```yaml
# policy.yaml (beside actions:, at the top level; not identity.yaml)
purposes:
  set_up_plan: { level: 2 }       # the form id
```

```ts
// src/app.ts, in the form's hooks under code.forms
entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) }, purpose: 'set_up_plan' }),
```

`pnpm check` then asks for the code's lines: `ask_otp`, `ask_otp_spoken`, `otp_spoken_reissued`, `otp_verified`, `otp_failed`.

Set `testing.seed.caller` to a level 2 principal: corpus lines spoken inside a form are seeded with that caller, and a level 1 caller in a level 2 form hears `ask_otp` on every one of them.

## Phone and chat

The same app answers a phone line and a web chat, and they verify differently:

- **On the phone**, a caller is anonymous until they say (or key) the identity factors and, for level 2, key the one-time code.
- **On the chat**, nothing typed is taken as a factor. A subject proves who they are by signing in through the app's portal, which proves the top of the ladder. Without this, a chat caller can never reach an action above level 0.

```yaml
# identity.yaml
signIn: { level: 2 }          # always the top level of the ladder (1 for a ladder of one rung)
```

```ts
// src/app.ts, in code
principals: {
  subjectPrincipal: (id, level) => {
    const a = ACCOUNTS.find((x) => x.accountId === id);
    return a ? { kind: 'customer', level, id: a.accountId, first: a.first, contact: { phoneLast4: a.phoneLast4 } } : null;
  },
},
portal: { subjects: () => ACCOUNTS.map((a) => ({ id: a.accountId, first: a.first, last: a.last })) },
```

`pnpm check` then asks for the chat's sign-in lines (`signin_required`, `signin_reminder`, `signin_thanks`, `signin_ready`, `greeting_chat_signed_in`, `greeting_chat_delegate`), and names the variables each is given: `{first}` in `signin_thanks`, `greeting_chat_signed_in` and `greeting_chat_delegate`, none in the others.

The order a chat caller hears them in:

1. The caller asks for something above level 0: the request waits, and they hear `signin_required`.
2. Until they sign in, whatever they type (an account number included: nothing typed is a factor) hears `signin_reminder`.
3. They sign in: `signin_thanks`, then the waiting request carries on (its next question, or its answer). With nothing waiting, `signin_thanks` and `signin_ready`.

A scripted chat call is `"as": "web"`, with a `{ "signIn": "<subject id>" }` step where the caller signs in. A call that tests the reminder asks first, then types the number: `[{ "say": "what's my balance" }, { "say": "my account number is 55501234" }]` ends at `signin_reminder`. The reminder is never the first sign-in line a caller hears: a first message that is a request (even one that only gives an account number, labelled with the request it means) hears `signin_required`.

## Delegates

Someone acting for subjects (a manager of several accounts, a caregiver) is a delegate. A delegate reaches the app signed in on a chat, through the app's portal, already at the level the portal proves; there is no way for a delegate to identify themself on a phone call (a phone caller is anonymous until they verify as a subject). Their scripted calls and their opening corpus lines carry `"as": "<delegate id>"`.

`identity.yaml`:

```yaml
# identity.yaml
principals:
  subject: customer
  delegates:
    manager: { roles: [manager] }    # the delegate kind, and the roles a `role` rule may name
```

In `code`:

```ts
// src/app.ts
function managerPrincipal(id: string): Party | null {
  const m = MANAGERS.find((x) => x.id === id);
  return m ? { kind: 'manager', level: 2, id: m.id, name: m.name, first: m.first, role: 'manager' } : null;
}

function scopeOf(p: Principal): readonly string[] {
  if (p.level === 0) return [];
  if (p.kind === 'customer') return [p.id];
  return MANAGERS.find((m) => m.id === p.id)?.accounts ?? [];
}

export const code: AppCode = {
  // ...
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf } }),
  principals: { delegatePrincipal: managerPrincipal },              // who `as` signs in as, in scripted calls and the corpus
  portal: { delegates: () => MANAGERS.map((m) => ({ id: m.id, name: m.name, role: 'manager' })) },
};
```

With `portal`, `pnpm check` asks for the chat's sign-in lines (see "Phone and chat"). The delegate's level must be at least every action's they use: a delegate cannot step up.

**What a delegate may do** is the `role` and `scope` rules. A role not named in an action's `role` rule is refused; a subject passes the `role` rule. The `scope` rule (`scope: { param: accountId }`) passes only when the param is one of `scopeOf(principal)`.

```yaml
# policy.yaml, under actions:
  readAmount:
    level: 1
    rules:
      - identity
      - scope: { param: accountId }          # a subject sees their own account, a manager the ones they manage
  setUpPlan:
    level: 2
    rules:
      - identity
      - role: { manager: person }            # a manager's request goes to a person (handoff_role_person)
      - scope: { param: accountId }
      # ...
```

**Which account a delegate means.** A subject's account is the one they verified; a delegate names it. Give the form its own slot for the account (a `digits` slot, say `account`, separate from the factor slot `accountId`: outside a form, the words of a caller who is already verified, a delegate included, never fill a factor slot, so "what is owed on 5550 1234" as a delegate's first words would be lost). For a subject, fill that slot from the principal when the entry call succeeds, so they are not asked it; for a delegate, `principalEntry` replaces the entry call, and returning `null` lets the form ask for it:

```yaml
# forms.yaml, under forms:
  read_amount:
    slots: [account]
    summaryPromptId: null
    hooks: [entry, onEntry, principalEntry, complete]
    calls: [findAccount, readAmount]
```

```ts
// src/app.ts, under code.forms
read_amount: {
  entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
  onEntry: (s) => {
    if (s.principal.kind === 'customer' && s.slots.account!.value === null) {
      Object.assign(s.slots.account!, { value: s.principal.id, display: s.principal.id, confirmed: true, window: null });
    }
  },
  principalEntry: () => null,
  complete(c) { /* call readAmount with { accountId: accountIdOf(c.s) }; the scope rule decides */ },
},
```

**A delegate whose request goes to a person** should hear it before answering the form's questions. In `principalEntry`, ask the gate about the write without running it (`purpose: 'entry-check'`), and hand over on its answer:

```ts
// src/app.ts, in the form's hooks under code.forms
principalEntry: (c) => {
  const { decision } = c.callTool({ tool: 'setUpPlan', params: {}, purpose: 'entry-check' });
  return decision.verdict === 'NEEDS_HUMAN' ? handoff(c.s, decision.reason ?? 'needs-human', c.acks) : null;
},
```

### The shapes, for reference

All exported by `'dialogwright'` (defined in `packages/dialogwright/src/gate/types.ts` and `src/core/app/types.ts`):

```ts
// For reference only: the types as exported by 'dialogwright', not a file you write.
// A proven caller: a subject (verified, or signed in) or a delegate. `first` fills {first}; `role` is what a `role` rule reads.
interface Party { kind: string; level: 1 | 2; id: string; first: string; name?: string; role?: string; contact?: { phoneLast4?: string }; attrs?: Record<string, string> }
type Principal = Party | typeof ANONYMOUS;                     // ANONYMOUS is level 0

// code.principals: who a sign-in proves, for the scripted calls' `signIn` and `as`.
interface PrincipalDirectory { subjectPrincipal?(id: string, level: 1 | 2): Party | null; delegatePrincipal?(id: string): Party | null }

// code.portal: who may sign in on the chat. A delegate's listing has its role; a subject's its names.
interface PortalConfig {
  subjects?(): { id: string; first: string; last: string }[];
  delegates?(): { id: string; name: string; role: string; attrs?: Record<string, string> }[];
  roleLabel?(role: string): string;                             // how the chat page shows a role
}
```

`testing.policyMatrix` (the `PolicyMatrix` type) is under [Testing the policy](#testing-the-policy).

## Confirmed writes

A write the caller must agree to: the form has a summary (`summaryPromptId`), `confirmedParams`, and its action a `confirmed` rule. The caller's yes arms a hash of exactly the values read back, and the gate refuses a write that sends anything else.

**One list per app.** Every action with a `confirmed` rule names the same fields in the same order (the read-back's hash is taken over one list; `pnpm check` says so if two differ). With two confirmed writes, list the union, and have each form's `confirmedParams` and its write send every field on the list, `''` for the ones it does not have:

```yaml
# policy.yaml, under actions:
  reportFault:
    level: 0
    rules:
      - identity
      - confirmed: [accountId, place, fault, count, firstDate, total]
  setUpPlan:
    level: 2
    rules:
      - identity
      # ...
      - confirmed: [accountId, place, fault, count, firstDate, total]
```

```ts
// src/app.ts
const faultParams = (s: Session): Record<string, string> => ({
  accountId: '', place: s.slots.place?.value ?? '', fault: s.slots.fault?.value ?? '', count: '', firstDate: '', total: '',
});
```

`complete`, as the scaffold writes it:

```ts
// src/app.ts
function completeFault(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;                       // arm the confirmed rule with what the summary read
  const { decision } = c.callTool({ tool: 'reportFault', params: faultParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  return { kind: 'said', acks: [...acks, { promptId: 'fault_reported', vars: {} }] };
}
```

`said` carries on to "anything else?"; `{ kind: 'end', promptId, vars, acks }` ends the call on the line instead. The engine says the `goodbye` line after an `end` completion's line, so a line that ends the call never says goodbye itself, or the caller hears "Goodbye. Goodbye.". The same holds for a polite no that ends the call (`{ kind: 'end', promptId: 'decline_renter', ... }`): end it on the no, and let the engine close.

## Bounds: `limit` and `dateInRange`

The built-in range rules hold one param to bounds ([authoring guide, section 3.3](../../../docs/authoring-an-app.md#33-the-built-in-rules)). A bound is a number or a date, `today` (the call's day), or a reference to a lookup, `<lookup>(<param>)`, which the code declares:

```yaml
# policy.yaml, in an action's rules:
      - limit: { field: total, min: 0.01, max: amountDue(accountId) }
      - dateInRange: { field: firstDate, notBefore: today }
```

```ts
// src/app.ts
// The amount owed, a plain decimal ("240.00"): the account's balance, not its due date.
const balanceOf = (accountId: string): string | null => ACCOUNTS.find((a) => a.accountId === accountId)?.balance ?? null;

export const code: AppCode = {
  // ...
  lookups: ['amountDue'],
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf, amountDue: (id: string) => balanceOf(id) } }),
};
```

- The field must be one of the params the action sends (its `confirmed` or `fields` list), and its value a plain decimal (`240.00`) or an ISO date (`2026-09-25`), never with a currency sign or a thousands separator.
- Put `scope` before a range rule, so a lookup is only asked about an account the caller may see: `check` refuses a lookup reference whose param no earlier `scope` rule in the same action holds. A bound that is the same for every caller (a fee schedule, say) says `unscoped: true` on the rule, as `limit: { field: fee, unscoped: true, max: feeSchedule(service) }`.
- A failure is `BLOCK` with the reason `limit`, `date-range` or `date-window` (or yours, under `reasons`), or a person with `verdicts: { outOfRange: NEEDS_HUMAN }`.

**A day within N days of today** is a number of days from today, `today+N` ([authoring guide, section 3.3](../../../docs/authoring-an-app.md#33-the-built-in-rules)):

```yaml
# policy.yaml, in an action's rules:
      - dateInRange: { field: firstDate, notBefore: today, notAfter: today+30 }
```

**A bound no built-in rule holds** is a custom rule. The shape below is the thirty days written as one, as the utility example first had it before `today+N` existed (it now uses `notAfter: today+30`, and so should you for that bound); it shows how a rule reads the call's day from the gate's facts, never the clock:

```yaml
# policy.yaml, in an action's rules:
      - dateInRange: { field: firstDate, notBefore: today }
      - custom: first-date-within-30-days
```

A custom rule is made with `defineRule` (from `'dialogwright/policy'`): its id, what it holds in plain words, its `run`, and examples, at least one call the gate allows and one it refuses (`pnpm check` refuses a rule without them, and a plain function). Each example runs through the gate in every action that names the rule, so it must pass the action's other rules: a principal at the action's level, every param the action sends (its `confirmed` or `fields` list) with values inside the other bounds. The example's facts default to no failed attempts, its values confirmed, and the regression's day, 2026-09-18.

```ts
// src/app.ts (or a module of its own that src/app.ts imports)
import { defineRule } from 'dialogwright/policy';

const PLAN_CALL = { accountId: '55501234', place: '', fault: '', count: 'three', firstDate: '2026-09-25', total: '240.00' };
const SUBJECT_AT_2: Party = { kind: 'customer', level: 2, id: '55501234', first: 'Avery' };

export const within30Days = defineRule({
  id: 'first-date-within-30-days',
  description: 'The first payment is within thirty days',
  run(c) {
    const latest = addDays(c.facts.todayIso, 30);
    const day = c.call.params.firstDate ?? '';
    return day !== '' && day <= latest
      ? { pass: true, compared: `firstDate on or before ${latest}: yes` }
      : { pass: false, compared: `firstDate on or before ${latest}: no`, verdict: 'BLOCK', reason: 'date-range' };
  },
  examples: [
    { name: 'thirty days on', call: { params: { ...PLAN_CALL, firstDate: '2026-10-18' } }, principal: SUBJECT_AT_2, expect: { verdict: 'ALLOW' } },
    { name: 'thirty-one days on', call: { params: { ...PLAN_CALL, firstDate: '2026-10-19' } }, principal: SUBJECT_AT_2, expect: { verdict: 'BLOCK', reason: 'date-range' } },
  ],
});

// in code:
customRules: { 'first-date-within-30-days': within30Days },
```

A custom rule's `compared` line goes to the audit as it is: never put a value in it that the app masks (an identifier, a date of birth, free text). Log the custom rule as a gap in the worksheet.

## A value no slot holds, in the read-back

A summary can name a value the code works out (a total from the record, a fee): the form's `onSummaryRead` hook gives it as a variable. Without it the regression stops with `prompt variable missing: <name>`.

```yaml
# forms.yaml, under forms:
  set_up_plan:
    slots: [count, firstDate]
    summaryPromptId: confirm_set_up_plan     # "That's {total} in {count}, the first on {firstDate}. Shall I set that up?"
    hooks: [entry, principalEntry, onSummaryRead, confirmedParams, complete]
    calls: [findAccount, setUpPlan]
```

```ts
// src/app.ts, in the form's hooks under code.forms
onSummaryRead: ({ s }) => ({ vars: { total: balanceOf(accountIdOf(s)) ?? '' } }),
```

The same value goes in `confirmedParams`, so the caller's yes covers it.

## Refusals and handoffs

- `c.refusal(decision)` for anything the gate did not allow: a `BLOCK` says the line `code.blockPromptId(reason, principal)` names, and the form ends ("anything else?" follows); with no line, and for `NEEDS_HUMAN`, the caller goes to a person with `handoff_needs_human`.

  ```ts
  // src/app.ts, in code
  blockPromptId: (reason) => (reason === 'scope' ? 'account_not_yours' : reason === 'limit' ? 'plan_over_amount' : reason === 'date-range' ? 'plan_date_outside' : null),
  ```

  Each line it names must be in `prompts.yaml`; `pnpm check` cannot see them.
- A `role` rule's `person` goes to a person with `handoff_role_person` (or `handoff_<reason>` for its `reason`); `pnpm check` asks for it.
- A handoff your code makes for its own reason, `handoff(s, '<reason>', acks)` (exported by `'dialogwright'`), says `handoff_<reason>` with hyphens as underscores. Add the line yourself.
- A person on request is built in: the `agent` control intent, with `handoff_live_agent`. Give `agent` corpus lines both outside and inside forms.
- Three failed tries at verification hand over with `handoff_identity`.

## Informational answers

An intent that only says something: no form, no tool, no policy.

```yaml
# intents.yaml, under intents:
  office_hours:
    criteria: Asks when the office is open
    label: hear the office hours
    kind: informational
    promptId: office_hours
```

and the line in `prompts.yaml`. After it the caller hears `ask_intent`, so a scripted call that asks one expects `"promptId": "ask_intent"`. A web address in a line is invented (`example.com/...`), written as it should be spoken.

A key on the keypad menu may name it: the key plays the line, then offers the menu again. A key for a control intent other than `agent` does nothing, so `pnpm check` refuses one. When the menu listens is under "Keypad entry".

## Something that must never wait

When the app has something that must never wait or be missed, an emergency or a safety report, mark its intent `priority: true`. Without it, a caller who says "actually, water is pouring in right now" at a form's question is read as answering that question, and the form asks the rest of its questions first; one who says "hold on, the wall just started giving way" half aside is ignored as side speech.

```yaml
# intents.yaml, under intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: true
```

Read at `PRIORITY_INTENT` (0.8) or more, the intent is acted on that turn, wherever the call is: the form in hand is left (not queued), a pending confirmation is dropped, and side speech or words read as unintelligible do not stop it. A handoff to a person and the injection screen still win, and its form's actions go through the policy gate as any other's. The usual shape is a form with no slots whose `complete` hook hands off with a line of its own. Only a form intent or an informational one may be priority. Give it corpus lines inside each form a caller could be in (`context: <form>`, `change: replacing`) and one said aside ("hold on, ..."). The debug table's `priorityIntent` row says when it took the turn (`act:<intent>:over:<gate>`). The whole option is under "Must never wait" in the [authoring guide](../../../docs/authoring-an-app.md#must-never-wait-priority).

## A knowledge form

A general question a document answers ("what is the late fee?"), said from a passage a person approved, word for word. The whole feature is section 12 of the [authoring guide](../../../docs/authoring-an-app.md#12-the-knowledge-base); this is the wiring, as built in a running app (the engine's library fixture), and the traps.

```yaml
# slots.yaml
subject:
  type: topic
```

```yaml
# forms.yaml, under forms:
forms:
  ask_library:
    slots: [subject]
    summaryPromptId: null
    answers: { slot: subject }
    calls: [findPassage, getFees]
```

```yaml
# intents.yaml, under intents:
intents:
  ask_library:
    criteria: Asks a question about the library, its cards or its fees
    label: answer a question
    kind: form
```

```yaml
# policy.yaml
actions:
  findPassage:
    level: 0
    rules: [identity]
  getFees:
    level: 0
    rules: [identity]
audit:
  topic: keep
```

```ts
// src/app.ts, in code.tools
findPassage: kbAnswerTool({
  facts: (_params, sys) => {
    const kind = (sys as Systems).cardKind; // the caller's card, read from the library's records
    return kind === null ? null : { card: kind };
  },
}),
getFees: {
  params: ['topic'],
  fields: ['balance'], // the variables the topic's account line may use
  run: (_call, sys) => ({ value: { balance: (sys as Systems).balance }, summary: 'fees read' }),
},
```

- **The folder.** `kb/kb.yaml` (`action: findPassage`, `applies: { card: [adult, junior] }`), `kb/topics.yaml` (a topic's `accountLine: { text: "Your card has {balance} in late fees right now.", from: getFees }`), `kb/sources/` and `kb/passages/`. The guide's section 12.1 shows each file.
- **The lines.** `ask_subject`, `ask_subject_retry` and `disambiguate_subject` (with `{a}` and `{b}`) for the slot; `kb_answer` with the text `'{answer}'` and `interruptible: false`; `kb_unavailable` with no variable. All in every locale, and `answer` among `app.yaml`'s `prompts.dataVars` (`prompts: { dataVars: [answer] }`). `pnpm check` names each one that is missing.
- **No `complete` hook.** A form with `answers:` completes in the engine; give `hooks` none. `calls` lists the resolving action and each account line's tool, or `pnpm check` says one is missing; like every `calls`, it is declared on every form of the app or on none.
- **The facts are read by code.** `facts` returns the caller's value for each fact `applies` names, from the system of record, never from what the caller said; null when there is no record (the answer is then unavailable). An answer that is the same for everyone needs no `applies` and no `facts`.
- **The policy.** The resolving action is an ordinary action: its `level` and `rules` decide who may hear the answer (a general answer at level 0 with `identity`, or `scope` where the answer is a subject's), and `topic` is declared under `audit` like any param that is not a slot. An account line's tool is a read with its own action and `fields`, so a delegate or an anonymous caller may be refused the line and still hear the answer.
- **An answer that is one line for everyone and needs no question** is an informational intent with `passage: <id>` in place of `promptId`, with no form and no slot; no passage of its topic may apply to some callers only.
- **The corpus.** The topic question for a slot `x` is `xTopic`, asked only when the app's retriever nominates topics for the line, and its labels are the nominated topics' ids ([corpus.md](corpus.md#labels-by-slot-type)). The stub regression runs the real retriever, so keywords and example questions in `topics.yaml` decide what a line nominates. A corpus line about a topic is written after a person approves its passage: until then the call hears the unavailable line.
- **Paraphrases and a recall test.** `fixtures/kb/paraphrases.yaml` (each topic id with eight or more things callers say in other words, and `none:`), and a test that holds the retriever's recall to it ([12.11](../../../docs/authoring-an-app.md#1211-testing)). Choose retrieval's `floor` and `cap` with `pnpm kb:bakeoff --sweep`, never by recording.
- **Never.** Never write an `approval` or a hash by hand, never run `pnpm kb:approve`, never put a `{variable}` or a brace in an answer, never use a model key. See step 6b.

## Keypad entry

- A `digits`, `date`, `birthdate` or `choice` slot takes `keypad: true` and then needs `ask_<slot>_dtmf` (the line that asks for the keys). The keypad is offered after spoken answers miss, and keys are taken whenever the slot was the last thing asked.
- The one-time code is always keyed.
- A scripted call's keypad step is `{ "dtmf": "55501234" }`.
- **The keypad menu** (`menu:` in intents.yaml) listens only once it has been offered: on a call with a keypad (a phone call, never the chat), the second missed answer to "what can I help you with" (words it did not understand, or a silence) offers it with `nomatch_dtmf_menu`, and the next turn's keys are menu keys. A third miss goes to a person (`max-attempts`). A key pressed before that, at the greeting for instance, is ignored and the caller hears nothing. After an informational key the menu is offered again, so it keeps listening. A scripted call for a menu key misses twice first: `[{ "say": "okay" }, { "say": "okay" }, { "dtmf": "4" }]`, with an "okay" corpus line at `no_form` whose intent is `none`. Open with "okay", not a filler like "um": the model reads a bare "um" as addressed to the line at about the threshold, so on a recording it is sometimes ignored rather than missed, and the menu is never offered (seen on two apps' first recordings).

## What is recorded: `params` and `audit`

Every call is recorded (the gate event, the trace, the console, the audit), so every value it carries must have a stated way of being recorded. Two parts say it: each tool lists its `params` in code, and `policy.yaml` declares `audit` for each of those that is not a slot with a redact setting.

```ts
// src/app.ts
export const TOOLS: Record<string, ToolDef> = {
  findAccount: { params: ['accountId'], run(call) { /* ... */ } },
  bookService: { params: ['accountId', 'service'], run(call, sys, { tc }) { /* ... */ } },
  verifyCode: { params: [], run(_call, _sys, { code }) { /* ... */ } },   // the one-time code is no param
};
```

```yaml
# policy.yaml, at the top level (beside actions:)
audit:
  service: keep    # a choice from a short list
  note: length     # free words: only their length
  pin: secret      # never recorded
```

- `accountId` is a `digits` slot (recorded by its last four) and `dob` a `birthdate` slot (hidden), so neither is declared. A slot whose `redact` is `none` (a `name`, a `choice`, a `date`, a `text` with `redact: none`) is not covered: declare its param.
- Choose per param: an identifier `last4`; free words `length`, or `secret`; hidden but shown to have been given `mask`; a plain choice, a day or an amount `keep`.
- The rule lines and the tool's summary are masked the same way. A custom rule still writes only what may be recorded.
- A param no tool lists, or a listed param nothing declares, is a `pnpm check` problem whose fix names both ways out. A `confirmed` field is always a slot or declared. The confirmed list's fields that an action sends empty (the union list, above) are listed too.
- The policy card has the "What is recorded" table: read it against the worksheet.
- Write `passed(decision, 'role')` (from `'dialogwright/policy'`) to ask whether a rule passed, by its name; rule lines are recorded under names (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`, a custom rule's own id).

## Values with no slot type

| Value | Do this | And log |
|---|---|---|
| An amount the code can work out (what is owed, a fee) | Not a slot: compute it from the record, read it back with `onSummaryRead`, send it as a param and hold it with `limit`. | nothing |
| A choice among a few amounts or counts | `choice`, keys that start with a letter (`two`, `three`), `say` for how each is spoken. | nothing |
| An amount the caller names freely, in whole units ("between 10 and 100 dollars") | No money type yet. A `digits` slot with `mask: '\d{1,3}'` and no `length`, `redact: none` and a `noun` ("dollar amount"), held to its bounds by `limit`. It reads "twenty five" and "one hundred fifty", but not "a hundred and fifty" (it parses numbers as identifiers), has no keypad (that needs `length`) and no cents. | a gap |
| An amount the caller names freely, with cents | No type yet. Offer choices instead, or write a slot in code ([authoring guide, "When no type fits"](../../../docs/authoring-an-app.md#when-no-type-fits-a-slot-in-code)). | a gap |
| A street address | `text` with `say: null` (the summary reads the caller's words) and `redact: none`, and a summary line that quotes them ("at: {place}"). `pick` keeps only the part that is the address; `numbers: digits` and `case: title` have code write the value a tool gets ("7625 Oak Hollow Lane") while the read-back keeps the words as said. | a gap |
| A code with letters | A slot in code. | a gap |

The address in `slots.yaml`:

```yaml
# slots.yaml
place:
  type: text
  what: the street address where the problem is
  say: null          # the read-back is the caller's own words
  redact: none       # required with say: null; the words are kept in the trace and the audit
  maxLength: 200
  pick: { what: the street address }   # the part of the words that is the address
  numbers: digits    # the value: "seventy six twenty five" -> 7625 (the read-back keeps the words)
  case: title        # the value: all-lower-case words capitalized
```

`redact: none` is the trade-off: with `say: null` the display is the caller's words, and the default `redact: length` keeps those out of the trace, so `pnpm check` refuses the pair (`give "say" a stand-in such as "your note", or set redact: none`). A stand-in would read back "your note" instead of the address, which defeats the read-back, so an address takes `redact: none`, and the words are then in the trace and the audit as said. Declare the param the same way (`place: keep` under `audit:` in policy.yaml), so what is recorded is stated, and note the trade-off in the worksheet's gaps: whatever the caller says with the address is kept too.

## Testing the policy

Three kinds of test, all from `'dialogwright/testing'`.

**The policy matrix** is the reviewed record of what the gate decides: under each action, a row per kind of caller with the verdict and its reason, then each custom rule's examples. It lives beside `policy.yaml` as `policy.matrix`, and it is how you read the policy back (step 7). The scaffold ships one for its example, with the card, the map and the tests below; replace the example's callers and records with your own. The gate grid behind it needs the app's callers and records, `testing.policyMatrix` in `src/app.ts`:

```ts
// src/app.ts, in code
testing: {
  policyMatrix: () => ({
    principals: {
      subject1: { kind: 'customer', level: 1, id: '55501234', first: 'Avery' },
      subject2: { kind: 'customer', level: 2, id: '55501234', first: 'Avery' },
      delegates: { manager: managerPrincipal('riley')! },           // one per role; {} with no delegates
      unlistedRole: { kind: 'manager', level: 2, id: 'quinn', first: 'Quinn', role: 'assistant' },
      roleless: { kind: 'manager', level: 2, id: 'rowan', first: 'Rowan' },
      otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
    },
    records: {                                   // four subject ids; `record` only with a `scope: { record }` rule (below)
      own: { subject: '55501234' },              // subject1's own
      inScope: { subject: '55505678' },          // another subject the delegates act for
      outOfScope: { subject: '55507777' },       // one no caller here may see
      unknown: { subject: '55500000' },          // one that does not exist
    },
    values: PLAN_CALL,                           // a value per param, inside every bound, so an allowed call can be seen
  }),
  // ...
},
```

`record` (one of the subject's records, `{ subject: '55501234', record: 'R-1' }`) is needed only when a rule scopes by a record (`scope: { record: <param> }`); the grid then says which of the four lacks one. With `scope: { param }` rules only, leave it out.

**An action whose rules read params needs named calls.** For each action the grid builds one call: its subject param and its `confirmed` or `fields` list, each valued from `values`. An action with neither (a read whose custom rules decide on what the caller said: whether they own the home, its town, how urgent it is) is sent no params at all, so its rules fail closed and every caller is refused for the same reason. That matrix looks plausible ("every caller BLOCK not-owner") and is wrong. Give each such action named sets of params under `calls`, one for each outcome its rules can reach, so the matrix shows every reason the paragraph gives:

```ts
// src/app.ts, in testing.policyMatrix, beside principals, records and values
calls: {
  checkHome: {
    qualifies: { howUrgent: 'worsening', ownership: 'own', town: 'cedar_falls' },
    emergency: { howUrgent: 'emergency', ownership: 'rent', town: 'elsewhere' },
    renter: { howUrgent: 'worsening', ownership: 'rent', town: 'cedar_falls' },
    outsideArea: { howUrgent: 'worsening', ownership: 'own', town: 'elsewhere' },
  },
},
```

```text
checkHome · level 0 · identity, custom emergency-to-office, custom homeowners-only, custom in-service-area
  every caller   fields exact|extra, params qualifies  ALLOW
                 fields missing, params qualifies      BLOCK out-of-area
                 params emergency                      NEEDS_HUMAN emergency
                 params renter                         BLOCK not-owner
                 params outsideArea                    BLOCK out-of-area
```

The grid still sets the subject param itself. Use `calls` too for an action with a `confirmed` list whose custom rules turn on a value (a visit today, one a rule refuses): one set that passes, and one for each value a rule refuses. A row where every caller is refused for one reason is a sign the calls are missing, so read it against the worksheet before you accept it.

With an app with no delegates, the `unlistedRole`, `roleless` and `otherParty` callers are still given (of a kind the app does not serve), as the clinic's are. Then the test, and the first matrix written deliberately:

```ts
// src/app.test.ts
import { fileURLToPath } from 'node:url';
import { expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';

describe('the policy against its file', () => {
  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));
  it('runs every custom rule example as written', () => {
    expect(runRuleExamples(app).map((r) => `${r.tool} ${r.example}: ${r.expected}`)).toEqual([
      'setUpPlan thirty days on: ALLOW',
      'setUpPlan thirty-one days on: BLOCK date-range',
    ]);
  });
  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/<name>');
  });
});
```

```sh
pnpm policy:matrix apps/<name>     # writes apps/<name>/policy.matrix; read it, then commit it
```

A part of it reads:

```text
setUpPlan · level 2 · identity, role(manager person), scope(accountId), confirmed(...), limit(total), dateInRange(firstDate)
  anonymous         STEP_UP to 2
  subject@1         as anonymous
  subject@2         subject own, fields exact, confirmed match          ALLOW
                    subject inScope|outOfScope|unknown|empty            BLOCK scope
  delegate:manager  NEEDS_HUMAN role-person
  unlisted-role     BLOCK role
```

Like the baseline, write it once the policy is right, read it whole, and from then on a change to it is a policy change to explain: rewrite it only for a policy change you meant, and read the diff. With no custom rule, `runRuleExamples(app)` is `[]`; test that instead of the list above.

**The policy card and the app map** are the same policy and the app's structure in words and diagrams, generated beside `policy.yaml` as `POLICY.md` and `APP-MAP.md`. Declare `calls` on every form first (the actions its hooks call through the gate), or the map stops at each form. Write them with `pnpm policy:card apps/<name>` and `pnpm app:diagram apps/<name>`, read them (step 7), and test them like the matrix:

```ts
// src/app.test.ts
import { danglingReferences, expectAppMap, expectPolicyCard } from 'dialogwright/testing';

it('POLICY.md is the policy card the app generates', () => {
  expectPolicyCard(app, fileURLToPath(new URL('../POLICY.md', import.meta.url)), 'pnpm policy:card apps/<name>');
});
it('APP-MAP.md is the app map the app generates', () => {
  expectAppMap(app, fileURLToPath(new URL('../APP-MAP.md', import.meta.url)), 'pnpm app:diagram apps/<name>');
});
it('has no dangling reference', () => expect(danglingReferences(app)).toEqual([]));
```

The card names a slot by its `noun`, else its console label (`console.slotLabels` in `app.yaml`), else its id: give the identity factors labels (`dob: Date of birth`), or the card says "dob".

**The bounds, at their edges.** The matrix does not try each bound's values. Ask the gate directly, for the last value that passes and the first that fails, with the caller having said yes to exactly the params:

```ts
// src/app.test.ts
import { ANONYMOUS, type GateFacts, type Party, type Principal, type ToolCall } from 'dialogwright';
import { confirmationHash } from 'dialogwright/policy';
import { gateEvaluator } from 'dialogwright/testing';

const gate = gateEvaluator(app);
const subject = (level: 1 | 2): Party => ({ kind: 'customer', level, id: '55501234', first: 'Avery' });

/** The verdict (and reason) for one call by one principal, on the regression's day. */
function decide(tool: string, params: Record<string, string>, p: Principal, confirmed = true): string {
  const facts: GateFacts = { attempts: 0, todayIso: '2026-09-18', confirmedHash: confirmed ? confirmationHash(params, app.policy.confirmedFields) : null };
  const d = gate({ tool, params } as ToolCall, p, facts, app.systems().lookups);
  return d.reason ? `${d.verdict} ${d.reason}` : d.verdict;
}

const plan = (over: Record<string, string> = {}) => ({ ...PLAN_CALL, ...over });

it('holds the total and the first day to their bounds', () => {
  expect(decide('setUpPlan', plan({ total: '240.01' }), subject(2))).toBe('BLOCK limit');
  expect(decide('setUpPlan', plan({ firstDate: '2026-09-17' }), subject(2))).toBe('BLOCK date-range');
  expect(decide('setUpPlan', plan({ firstDate: '2026-10-18' }), subject(2))).toBe('ALLOW');
  expect(decide('setUpPlan', plan({ firstDate: '2026-10-19' }), subject(2))).toBe('BLOCK date-range');
});
```

**The gate-event golden** (optional, useful while reviewing the baseline): every gate decision of the stub regression, each rule's line with it, as one text file, written on its first run.

```ts
// src/app.test.ts
import { gateEventGolden } from 'dialogwright/testing';

it('gate-event golden', async () => {
  const golden = await gateEventGolden('stub');
  await expect(golden.text).toMatchFileSnapshot('./__snapshots__/gate-events.stub.txt');
}, 60_000);
```

A line of it reads `setUpPlan BLOCK reason=date-range {...}` followed by each rule and what it compared (`limit pass ... total at least 0.01, at most amountDue(accountId ...1234) 240.00`).

## Known gaps

Found so far, with the workaround each time. Log the ones you meet in the worksheet.

- **One list of confirmed fields per app**: list the union, send `''` for the rest (above).
- **No slot type for an amount of money or an address** (above).
- **Delegates only on a signed-in chat**: no phone path for a delegate; scripted calls use `as`, and a corpus line with `as` must be `no_form`. A delegate's answer inside a form comes from a corpus line without `as` that has the same words.
- **A factor slot does not fill from a delegate's words**: give delegates their own slot for the subject they name (above).
- **A value said with the request for a different form is lost**: "book me in for a Saturday morning" said on the opener, where the turn opens a form that has no day (a qualifying form, before the booking form that asks it), keeps neither the day nor the time, even with `listen: anywhere` or `call` on them: the turn that opens a form fills only that form's slots ([authoring guide](../../../docs/authoring-an-app.md#where-a-slot-listens-listen)). Let the later form ask again, and pin it with a scripted call. `listen: anywhere` keeps a value said on a turn that opens no form, such as an informational question.
- **`pnpm check` does not check the corpus** beyond every intent having examples, nor the lines named only in code (`blockPromptId`, `handoff(...)`, a completion's line, a summary variable from `onSummaryRead`). The regression finds them, one at a time.

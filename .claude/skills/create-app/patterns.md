# Patterns

The YAML and TypeScript for what a paragraph usually asks for. Each was built and run in an app scaffolded by `pnpm create-app --identity` (check, type check, tests and regression), with the scaffold's names (`accountId`, `dob`, `verifyCustomer`, `findAccount`, `Systems`, `ACCOUNTS`, `accountIdOf`); use your own. Imports are from `'dialogwright'` unless shown. The reference for every field is [docs/authoring-an-app.md](../../../docs/authoring-an-app.md); the engine's own test app, [the testkit](../../../packages/dialogwright/src/testing/testkit/README.md), uses every hook and is worth reading for a feature these patterns leave out (it is a test fixture, not a model of design).

Contents: [Verification](#verification-level-1) · [A one-time code](#a-one-time-code-level-2) · [Phone and chat](#phone-and-chat) · [Delegates](#delegates) · [Confirmed writes](#confirmed-writes) · [Bounds](#bounds-limit-and-dateinrange) · [A value no slot holds](#a-value-no-slot-holds-in-the-read-back) · [Refusals and handoffs](#refusals-and-handoffs) · [Informational answers](#informational-answers) · [Keypad entry](#keypad-entry) · [Values with no slot type](#values-with-no-slot-type) · [Testing the policy](#testing-the-policy) · [Known gaps](#known-gaps)

## Verification (level 1)

`pnpm create-app <name> --identity` writes this already: `identity.yaml` with the factors (`accountId`, a `digits` slot, and `dob`, a `birthdate` slot), the `verifyCustomer` tool that checks them, and a form whose `entry` call needs level 1, so an anonymous caller is asked for the factors before the form's own slots. The pieces:

- An action at `level: 1` with the `identity` rule. When an anonymous caller reaches it, the gate answers `STEP_UP` and the engine asks the factors, calls the verify tool, and tries again.
- The verify tool returns a `VerifyOutcome`: `{ ok: true, principal }` with the principal it proves, or `{ ok: false }`. The principal is `{ kind: '<subject kind>', level: 1, id, first }`; `first` fills `{first}` in `identity_verified`.
- The subject's own id is the principal's, once verified. Read it from there, so a tool's subject param is always the proven one:

  ```ts
  const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.account?.value ?? '');
  ```

- A read that needs nothing but verification can be the form's entry call itself, or a form with no slots and only `entry` and `complete`.

## A one-time code (level 2)

Add level 2 only when an action needs it. `identity.yaml`:

```yaml
levels:
  1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
```

`policy.yaml` (both tools need actions, like every tool):

```yaml
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

The code. The code itself is checked by the engine's verifier (`tc.tools.codes`): in tests and the stub regression it is a mock that accepts any code of the right length whose last digit is even, so a scripted call keys `{ "dtmf": "123456" }` to pass and `{ "dtmf": "123457" }` to fail.

```ts
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

A form whose action needs level 2 should ask for the code before its own slots, not after the caller has answered everything. Name a purpose for it and make the entry call with it:

```yaml
purposes:
  set_up_plan: { level: 2 }       # the form id
```

```ts
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
principals: {
  subjectPrincipal: (id, level) => {
    const a = ACCOUNTS.find((x) => x.accountId === id);
    return a ? { kind: 'customer', level, id: a.accountId, first: a.first, contact: { phoneLast4: a.phoneLast4 } } : null;
  },
},
portal: { subjects: () => ACCOUNTS.map((a) => ({ id: a.accountId, first: a.first, last: a.last })) },
```

`pnpm check` then asks for the chat's sign-in lines (`signin_required`, `signin_reminder`, `signin_thanks`, `signin_ready`, `greeting_chat_signed_in`, `greeting_chat_delegate`). A scripted chat call is `"as": "web"`, with a `{ "signIn": "<subject id>" }` step where the caller signs in; a chat caller who types an account number instead hears `signin_reminder`.

## Delegates

Someone acting for subjects (a manager of several accounts, a caregiver) is a delegate. A delegate reaches the app signed in on a chat, through the app's portal, already at the level the portal proves; there is no way for a delegate to identify themself on a phone call (a phone caller is anonymous until they verify as a subject). Their scripted calls and their opening corpus lines carry `"as": "<delegate id>"`.

`identity.yaml`:

```yaml
principals:
  subject: customer
  delegates:
    manager: { roles: [manager] }    # the delegate kind, and the roles a `role` rule may name
```

In `code`:

```ts
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
  read_amount:
    slots: [account]
    summaryPromptId: null
    hooks: [entry, onEntry, principalEntry, complete]
```

```ts
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
principalEntry: (c) => {
  const { decision } = c.callTool({ tool: 'setUpPlan', params: {}, purpose: 'entry-check' });
  return decision.verdict === 'NEEDS_HUMAN' ? handoff(c.s, decision.reason ?? 'needs-human', c.acks) : null;
},
```

## Confirmed writes

A write the caller must agree to: the form has a summary (`summaryPromptId`), `confirmedParams`, and its action a `confirmed` rule. The caller's yes arms a hash of exactly the values read back, and the gate refuses a write that sends anything else.

**One list per app.** Every action with a `confirmed` rule names the same fields in the same order (the read-back's hash is taken over one list; `pnpm check` says so if two differ). With two confirmed writes, list the union, and have each form's `confirmedParams` and its write send every field on the list, `''` for the ones it does not have:

```yaml
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
const faultParams = (s: Session): Record<string, string> => ({
  accountId: '', place: s.slots.place?.value ?? '', fault: s.slots.fault?.value ?? '', count: '', firstDate: '', total: '',
});
```

`complete`, as the scaffold writes it:

```ts
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

`said` carries on to "anything else?"; `{ kind: 'end', promptId, vars, acks }` ends the call on the line instead.

## Bounds: `limit` and `dateInRange`

The built-in range rules hold one param to bounds (authoring guide, "The range rules"). A bound is a number or a date, `today` (the call's day), or a reference to a lookup, `<lookup>(<param>)`, which the code declares:

```yaml
      - limit: { field: total, min: 0.01, max: amountDue(accountId) }
      - dateInRange: { field: firstDate, notBefore: today }
```

```ts
const dueOf = (accountId: string): string | null => ACCOUNTS.find((a) => a.accountId === accountId)?.due ?? null;

export const code: AppCode = {
  // ...
  lookups: ['amountDue'],
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf, amountDue: (id: string) => dueOf(id) } }),
};
```

- The field must be one of the params the action sends (its `confirmed` or `fields` list), and its value a plain decimal (`240.00`) or an ISO date (`2026-09-25`), never with a currency sign or a thousands separator.
- Put `scope` before a range rule, so a lookup is only asked about an account the caller may see.
- A failure is `BLOCK` with the reason `limit`, `date-range` or `date-window` (or yours, under `reasons`), or a person with `verdicts: { outOfRange: NEEDS_HUMAN }`.

**A day within N days of today** has no bound yet (`notAfter` takes `today`, a date or a lookup, and a lookup is not given the call's day). Use `notBefore: today` in `dateInRange` and a custom rule for the far end, reading the call's day from the gate's facts, never the clock:

```yaml
      - dateInRange: { field: firstDate, notBefore: today }
      - custom: first-date-within-30-days
```

```ts
function within30Days(c: RuleContext): RuleOutcome {
  const latest = addDays(c.facts.todayIso, 30);
  const day = c.call.params.firstDate ?? '';
  const pass = day !== '' && day <= latest;
  const result = { id: 'first-date-within-30-days', description: 'The first payment is within thirty days', compared: `firstDate on or before ${latest}: ${pass ? 'yes' : 'no'}`, pass };
  return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'date-range' } };
}

// in code:
customRules: { 'first-date-within-30-days': within30Days },
```

A custom rule's `compared` line goes to the audit as it is: never put a raw param value in it that the app masks (an identifier, a date of birth, free text). Log the custom rule as a gap in the worksheet.

## A value no slot holds, in the read-back

A summary can name a value the code works out (a total from the record, a fee): the form's `onSummaryRead` hook gives it as a variable. Without it the regression stops with `prompt variable missing: <name>`.

```yaml
  set_up_plan:
    slots: [count, firstDate]
    summaryPromptId: confirm_set_up_plan     # "That's {total} in {count}, the first on {firstDate}. Shall I set that up?"
    hooks: [entry, principalEntry, onSummaryRead, confirmedParams, complete]
```

```ts
onSummaryRead: ({ s }) => ({ vars: { total: dueOf(accountIdOf(s)) ?? '' } }),
```

The same value goes in `confirmedParams`, so the caller's yes covers it.

## Refusals and handoffs

- `c.refusal(decision)` for anything the gate did not allow: a `BLOCK` says the line `code.blockPromptId(reason, principal)` names, and the form ends ("anything else?" follows); with no line, and for `NEEDS_HUMAN`, the caller goes to a person with `handoff_needs_human`.

  ```ts
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
  office_hours:
    criteria: Asks when the office is open
    label: hear the office hours
    kind: informational
    promptId: office_hours
```

and the line in `prompts.yaml`. After it the caller hears `ask_intent`, so a scripted call that asks one expects `"promptId": "ask_intent"`. A web address in a line is invented (`example.com/...`), written as it should be spoken.

## Keypad entry

- A `digits`, `date`, `birthdate` or `choice` slot takes `keypad: true` and then needs `ask_<slot>_dtmf` (the line that asks for the keys). The keypad is offered after spoken answers miss, and keys are taken whenever the slot was the last thing asked.
- The one-time code is always keyed.
- A scripted call's keypad step is `{ "dtmf": "55501234" }`.

## Values with no slot type

| Value | Do this | And log |
|---|---|---|
| An amount the code can work out (what is owed, a fee) | Not a slot: compute it from the record, read it back with `onSummaryRead`, send it as a param and hold it with `limit`. | nothing |
| A choice among a few amounts or counts | `choice`, keys that start with a letter (`two`, `three`), `say` for how each is spoken. | nothing |
| An amount the caller names freely | No type yet. Offer choices instead, or write a slot in code (authoring guide, section 4, "When no type fits"). | a gap |
| A street address | `text` with `say: null` (the summary reads the caller's words) and a summary line that quotes them ("at: {place}"). The value is the whole turn's words, so the read-back is the caller's sentence. | a gap |
| A code with letters | A slot in code. | a gap |

## Testing the policy

**Per action**: ask the gate directly, for each kind of principal and each bound, with the caller having said yes to exactly the params (`dialogwright/testing` gives the app's own gate; `dialogwright/policy` the confirmation hash):

```ts
import { ANONYMOUS, type GateFacts, type Party, type Principal, type ToolCall } from 'dialogwright';
import { confirmationHash } from 'dialogwright/policy';
import { gateEvaluator } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { app } from './app';

const gate = gateEvaluator(app);
const subject = (level: 1 | 2): Party => ({ kind: 'customer', level, id: '55501234', first: 'Avery' });
const manager: Party = { kind: 'manager', level: 2, id: 'riley', name: 'Riley Shaw', first: 'Riley', role: 'manager' };

/** The verdict (and reason) for one call by one principal, on the regression's day. */
function decide(tool: string, params: Record<string, string>, p: Principal, confirmed = true): string {
  const facts: GateFacts = { attempts: 0, todayIso: '2026-09-18', confirmedHash: confirmed ? confirmationHash(params, app.policy.confirmedFields) : null };
  const d = gate({ tool, params } as ToolCall, p, facts, app.systems().lookups);
  return d.reason ? `${d.verdict} ${d.reason}` : d.verdict;
}

const plan = (over: Record<string, string> = {}) => ({ accountId: '55501234', place: '', fault: '', count: 'three', firstDate: '2026-09-25', total: '240.00', ...over });

describe('setUpPlan', () => {
  it('needs the code', () => {
    expect(decide('setUpPlan', plan(), ANONYMOUS)).toBe('STEP_UP');
    expect(decide('setUpPlan', plan(), subject(1))).toBe('STEP_UP');
    expect(decide('setUpPlan', plan(), subject(2))).toBe('ALLOW');
  });
  it('goes to a person for a manager', () => expect(decide('setUpPlan', plan(), manager)).toBe('NEEDS_HUMAN role-person'));
  it('holds the total and the first day to their bounds', () => {
    expect(decide('setUpPlan', plan({ total: '240.01' }), subject(2))).toBe('BLOCK limit');
    expect(decide('setUpPlan', plan({ firstDate: '2026-09-17' }), subject(2))).toBe('BLOCK date-range');
    expect(decide('setUpPlan', plan({ firstDate: '2026-10-18' }), subject(2))).toBe('ALLOW');
    expect(decide('setUpPlan', plan({ firstDate: '2026-10-19' }), subject(2))).toBe('BLOCK date-range');
  });
  it('writes only what the caller said yes to', () => expect(decide('setUpPlan', plan(), subject(2), false)).toBe('BLOCK confirmation'));
});
```

Test each bound at its edge (the last value that passes, the first that fails), and each custom rule by itself.

**The gate-event golden**: every gate decision of the stub regression, each rule's line with it, as one text file. Its first run writes the file; read it once against the worksheet, then it holds every decision still.

```ts
import { gateEventGolden } from 'dialogwright/testing';

it('gate-event golden', async () => {
  const golden = await gateEventGolden('stub');
  await expect(golden.text).toMatchFileSnapshot('./__snapshots__/gate-events.stub.txt');
}, 60_000);
```

A line of it reads `makePlan BLOCK reason=date-range {...}` followed by each rule and what it compared (`limit pass ... total at least 0.01, at most amountDue(accountId ...1234) 240.00`).

## Known gaps

Found so far, with the workaround each time. Log the ones you meet in the worksheet.

- **A day within N days of today** has no `dateInRange` bound: `notBefore: today` and a custom rule (above).
- **One list of confirmed fields per app**: list the union, send `''` for the rest (above).
- **No slot type for an amount of money or an address** (above).
- **Delegates only on a signed-in chat**: no phone path for a delegate; scripted calls use `as`, and a corpus line with `as` must be `no_form`. A delegate's answer inside a form comes from a corpus line without `as` that has the same words.
- **A factor slot does not fill from a delegate's words**: give delegates their own slot for the subject they name (above).
- **`pnpm check` does not check the corpus** beyond every intent having examples, nor the lines named only in code (`blockPromptId`, `handoff(...)`, a completion's line, a summary variable from `onSummaryRead`). The regression finds them, one at a time.
- **No policy card or diagrams yet** (unless `policy:card` exists by now): read the policy back with the tests above.

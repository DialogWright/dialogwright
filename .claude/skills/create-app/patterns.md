# Patterns

The YAML and TypeScript for what a paragraph usually asks for. Each was built and run in an app scaffolded by `pnpm create-app --identity` (check, type check, tests and regression), with the scaffold's names (`accountId`, `dob`, `verifyCustomer`, `findAccount`, `Systems`, `ACCOUNTS`, `accountIdOf`); use your own. Imports are from `'dialogwright'` unless shown. The reference for every field is [docs/authoring-an-app.md](../../../docs/authoring-an-app.md); the engine's own test app, [the testkit](../../../packages/dialogwright/src/testing/testkit/README.md), uses every hook and is worth reading for a feature these patterns leave out (it is a test fixture, not a model of design).

To find the pattern for a need, start from [the options index](options.md). Each pattern says **when** it fits, the YAML (and code) to write, the scripted calls that **test** it, and its **pitfall**; the guide section it names has the rest.

Contents:

- Who the caller is: [Verification](#verification-level-1) · [Which factors](#which-identity-factors-when-the-paragraph-is-silent) · [A one-time code](#a-one-time-code-level-2) · [Verified by caller ID](#verified-by-caller-id-callerid) · [Phone and chat](#phone-and-chat) · [Delegates](#delegates)
- Writes and rules: [Confirmed writes](#confirmed-writes) · [One of the caller's own records](#one-of-the-callers-own-records-record) · [An opening from a schedule](#an-opening-from-a-schedule) · [Bounds](#bounds-limit-and-dateinrange) · [A value from a list](#a-value-from-a-list-oneof-and-noneof) · [A value no slot holds](#a-value-no-slot-holds-in-the-read-back)
- Forms that rule callers out: [Qualify before you collect](#qualify-before-you-collect) · [Reading an answer back](#reading-an-answer-back-confirm-and-confirmvalues) · [A check that needs identity](#a-check-that-needs-identity) · [Several entry forms, one booking](#several-entry-forms-one-booking-next) · [Where a slot listens](#where-a-slot-listens-listen-and-listenbeforeentered)
- Ends of a call: [Refusals and handoffs](#refusals-and-handoffs) · [Something that must never wait](#something-that-must-never-wait) · [What a transfer hands over](#what-a-transfer-hands-over-handoffdata)
- Requests and answers: [An intent's criteria](#an-intents-criteria) · [Informational answers](#informational-answers) · [A knowledge form](#a-knowledge-form) · [Keypad entry](#keypad-entry)
- The number calling: [A callback number](#a-callback-number-callernumber) · [Texting the caller](#texting-the-caller-onno-ifnone-and-the-callernumber-rule) · [One number to call and text](#one-number-to-call-and-text) · [What an offer takes](#what-an-offer-takes-whether-it-may-be-declined-and-consent-for-the-call) · [Looking the caller up by number](#looking-the-caller-up-by-number)
- The rest: [Switches with a safe default](#switches-with-a-safe-default) · [What is recorded](#what-is-recorded-params-and-audit) · [Values with no slot type](#values-with-no-slot-type) · [Names the engine keeps](#names-the-engine-keeps) · [Testing the policy](#testing-the-policy) · [Known gaps](#known-gaps)

## Verification (level 1)

**When:** an action reads or changes something that is one caller's own (an account, a record, a balance). An action anyone may ask for (a report, a booking for a new customer, a general answer) stays at level 0.

`pnpm create-app <name> --identity` writes this already: `identity.yaml` with the factors (`accountId`, a `digits` slot, and `dob`, a `birthdate` slot), the `verifyCustomer` tool that checks them, and a form whose `entry` call needs level 1, so an anonymous caller is asked for the factors before the form's own slots. The pieces:

- An action at `level: 1` with the `identity` rule. When an anonymous caller reaches it, the gate answers `STEP_UP` and the engine asks the factors, calls the verify tool, and tries again.
- The verify tool returns a `VerifyOutcome`: `{ ok: true, principal }` with the principal it proves, or `{ ok: false }`. The principal is `{ kind: '<subject kind>', level: 1, id, first }`; `first` fills `{first}` in `identity_verified`.
- The subject's own id is the principal's, once verified. Read it from there, so a tool's subject param is always the proven one:

  ```ts
  // src/app.ts
  const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.account?.value ?? '');
  ```

- A read that needs nothing but verification can be the form's entry call itself, or a form with no slots and only `entry` and `complete`.
- **Test:** the step-up (an anonymous caller asks, verifies by voice, is served), keypad entry of each factor, and three failed tries ending at a person (`handoff_identity`).
- **Pitfall:** an action with no `level` needs the highest, so write `level: 0` on every action anyone may use; and list the `identity` rule on every action, since no rule is implied. Never write an `if` on the caller's level in a tool: the gate decides.

## Which identity factors, when the paragraph is silent

**When:** the paragraph says callers must verify but not with what. The scaffold's account number and date of birth suit a business that gives its customers an account number they can find on a bill; choose by what a caller can say from memory, or read off something they hold, and what the business has on file:

| The business | Level 1 factors | Why |
|---|---|---|
| A utility, a bank-like account, a subscription | an account number (`digits`) and the date of birth, or the service ZIP code (`digits`, `redact: none`) | on every bill; with caller ID, the number calling can stand in for the account number |
| A clinic or a dental office | the patient's date of birth and their name (`name`), or a patient number where cards carry one | patients rarely know a patient number; a name with a date of birth is what the front desk asks |
| A trade with repeat customers (a plumber, pest control) | the phone number on the account (`digits`, ten digits) and the house number or ZIP code | customers know their own number; caller ID covers the ones calling from it |
| A line that only takes new requests | none: no identity.yaml | nothing it does is one caller's own |

Write the choice in the worksheet's "Choices the paragraph left open". Avoid a short secret (a PIN, the last four of an identity number) as a factor: a `digits` slot records its last four, which is all of it ([Known gaps](#known-gaps)). Level 1 has one set of factors ([Known gaps](#known-gaps)).

## A one-time code (level 2)

**When:** the paragraph asks for more than the factors before an action (a payment, a change to the account): "confirm with a code we text you". Add level 2 only when an action needs it. `identity.yaml`:

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

- **Test:** the code keyed right (`123456`) and wrong (`123457`) until a person, and a person asked for at the code prompt.
- **Pitfall:** set `testing.seed.caller` to a level 2 principal: corpus lines spoken inside a form are seeded with that caller, and a level 1 caller in a level 2 form hears `ask_otp` on every one of them.

## Verified by caller ID: `callerId`

"If they call from the number on file, ask only for their date of birth": a caller-ID match stands in for the account number, and the date of birth verifies it.

**When:** most callers phone from the number on their account, and the paragraph asks for the usual "I see an account associated with the number you're calling from" opening (or says callers should not have to find their account number). Leave it out when one number often serves several accounts and the line cannot tell them apart, or when the paragraph says every caller gives the account number. Where the paragraph only wants to save the caller a detail, not to verify them (the address on file), a proposal fits instead ([Looking the caller up by number](#looking-the-caller-up-by-number)). The question is asked before the account number, in its place, never after it.

```yaml
# identity.yaml
levels:
  1:
    name: verified
    factors: [accountId, dob]
    verify: verifyCustomer
    failedPrompt: identity_failed
    callerId:
      identifies: [accountId]   # taken from the match, never asked while it stands
      ask: on-need              # or greeting: right after the greeting, before the open question
```

```yaml
# app.yaml: the lookup that finds the match
callerNumber: { use: hint, lookup: findAccountByPhone }
```

```yaml
# prompts.yaml, under prompts: (every locale)
  identity_caller_match:
    text: I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account.
    interruptible: true
  identity_caller_declined:        # optional: said before the account number after "different account"
    text: Okay, let's find your account.
    interruptible: false
```

```ts
// src/app.ts, code.facts
fromCallerLookup(f, value) { /* keep the account ids the lookup returned for the number */ },
// One account on the number: the match. None, or a number two accounts share: null, and both factors are asked.
callerMatch: (f) => (f.phoneAccounts?.length === 1 ? { accountId: f.phoneAccounts[0] } : null),
```

- **Never the match alone.** `identifies` leaves at least one factor to ask (`pnpm check` refuses it covering every factor). The verify tool gets the matched account number and the date of birth said, as if the caller had said both; the gate and the attempts are unchanged, and it reaches level 1, so a level 2 action still sends the code.
- **"Different account", a no, or a wrong date** asks the account number and the date of birth, as on any call, and the match is not used again on the call. A wrong date counts one try. "Different account, it's 5550 5678" keeps the number. Write `audit: callerNumber: last4` in policy.yaml (the `identity_caller_match` audit row records the number that way).
- **Nothing of the account is said.** The line names no account number, name or street, and the engine never puts the match in a line or a variable. The lookup's tool returns the account ids for the number; keep it to that.
- **Read the account from the principal**, not the slot (`accountIdOf` above), and the code's `sendCodeParams` too: the principal is the verified one, however it was verified. `after.principal.via` is `caller-id` when the match took part: write it in the verify tool's audit row.
- **`ask: greeting`** opens the call on `greeting_offer` and `identity_caller_match` (write both greeting lines, `greeting_offer` and `greet_after_offer`); a request said instead goes on, and the question comes back when identity is needed. It wins over a slot's `offerAt: greeting`, which is then proposed at its slot.
- **Test:** scripted calls from a matched number with the right date, with "different account", with a wrong date; a number not on file; a withheld number; a shared number; with level 2, the code still asked. Corpus lines at the question: a form's context (or `no_form` with `ask: greeting`), `prompted: dob`, with `confirm: no` for "different account" and "no, that's not me", and `confirm: unanswered` for a date (labelled) and words that answer neither (`confirm: yes` is refused there); set `testing.seed.callerNumber` to a number the lookup matches. The engine's fixture is `packages/dialogwright/src/testing/recognized` ([authoring guide](../../../docs/authoring-an-app.md#a-caller-id-match-as-the-identifier-callerid)).
- **Pitfall:** the lookup's action is level 0 with the `callerNumber` rule and `audit: callerNumber: last4` ([Looking the caller up by number](#looking-the-caller-up-by-number)); `pnpm check` refuses `callerId` without the lookup or without `facts.callerMatch`, and needs `identity_caller_match`.

## Phone and chat

**When:** the paragraph mentions a chat, a website or a portal, and some action is above level 0. The same app answers a phone line and a web chat, and they verify differently:

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

**Test:** a scripted chat call is `"as": "web"`, with a `{ "signIn": "<subject id>" }` step where the caller signs in. A call that tests the reminder asks first, then types the number: `[{ "say": "what's my balance" }, { "say": "my account number is 55501234" }]` ends at `signin_reminder`.

**Pitfall:** the reminder is never the first sign-in line a caller hears: a first message that is a request (even one that only gives an account number, labelled with the request it means) hears `signin_required`. And every phone-only option (an offer of the caller's number, caller ID, consent to text, the keypad) does nothing on a chat: give each a chat call too.

## Delegates

**When:** the paragraph names people who call for others (a property manager, a caregiver, staff). Someone acting for subjects (a manager of several accounts, a caregiver) is a delegate. A delegate reaches the app signed in on a chat, through the app's portal, already at the level the portal proves; there is no way for a delegate to identify themself on a phone call (a phone caller is anonymous until they verify as a subject). Their scripted calls and their opening corpus lines carry `"as": "<delegate id>"`.

`identity.yaml`:

```yaml
# identity.yaml
principals:
  subject: customer
  delegates:
    manager: { roles: [manager] }    # the delegate kind, and the roles a `role` rule may name
levels:
  1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
signIn: { level: 2 }
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

**When:** every write a caller asks for (a booking, a report, a payment plan). A write the caller must agree to: the form has a summary (`summaryPromptId`), `confirmedParams`, and its action a `confirmed` rule. The caller's yes arms a hash of exactly the values read back, and the gate refuses a write that sends anything else. A summary reads every value back once, at the end; an answer that must be heard right before the end (one that ends the call) is [read back on its own](#reading-an-answer-back-confirm-and-confirmvalues).

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

`said` carries on to "anything else?"; `{ kind: 'end', promptId, vars, acks }` ends the call on the line instead.

- **Test:** each form start to finish with a yes; a no that names what to change (`changeSlot`); a no with the new value ("no, make it Thursday"); "yes, but Thursday" (refused and read again).
- **Pitfall:** the engine says the `goodbye` line after an `end` completion's line, so a line that ends the call never says goodbye itself, or the caller hears "Goodbye. Goodbye.". The same holds for a check's `then: end` line.

## One of the caller's own records: `record`

**When:** the caller acts on something of theirs the app has looked up: move or cancel an appointment, ask about one of their orders. The records differ from caller to caller, so they are no `choice`: the form's entry call loads them, the app gives them to the slot from `facts.forSlots`, and the gate's `scope: { record }` rule asks `ownerOf` whose the one chosen is.

```yaml
# slots.yaml
appointment:
  type: record
  from: appointments
  key: ref
  keyPattern: '\d{4}'
  labelPrefix: appt_
  label: "Appointment {ref}, {what}, on {day|day} in the {timeOfDay}"
  keypad: 4                 # the four digits of the reference, after spoken answers miss
```

```yaml
# forms.yaml, under forms:
  cancel_appointment:
    slots: [appointment]
    summaryPromptId: confirm_cancel_appointment   # "That's your {appointment}. Shall I cancel it?"
    hooks: [entry, onEntry, confirmedParams, complete]
    calls: [listAppointments, cancelAppointment]
```

```yaml
# policy.yaml, under actions:
  listAppointments:
    say: list the caller's appointments
    level: 1
    rules:
      - identity
      - scope: { param: accountId }
  cancelAppointment:
    say: cancel an appointment
    level: 1
    rules:
      - identity
      - scope: { record: appointment }      # ownerOf(appointment) must be one of the caller's
      - confirmed: [appointment]
```

```ts
// src/app.ts
facts: {
  initial: () => ({}),
  clone: (f) => ({ ...f }),
  forSlots: (f) => ({ sources: { appointments: (f as Facts).appointments ?? [] } }),
},
forms: {
  cancel_appointment: {
    entry: (s) => ({ tool: 'listAppointments', params: { accountId: accountIdOf(s) } }),
    onEntry: (s, value) => { (s.facts as Facts).appointments = (value as Appointment[] | null) ?? []; },
    // ...
  },
},
systems: () => ({ sys: new Systems(), lookups: { scopeOf, ownerOf: (ref) => APPOINTMENTS.find((a) => a.ref === ref)?.accountId ?? null } }),
```

- The slot's value is the record's key (`7101`), never words; the model picks among the labels, and `none`. The cancel tool lists `appointment` in its `params`, and the `confirmed` rule is the app's one list ([Confirmed writes](#confirmed-writes)). Moving an appointment is the same form with the new day and time after it, and the write's rules on those.
- `scope: { record }` fails closed: a key the caller may not see, one that does not exist, or an empty one is refused with the same `scope` refusal, so the line cannot be used to learn which records exist. `scopeOf` and `ownerOf` are the gate's lookups (`systems()`).
- **Test:** a caller with two appointments naming each by its day ("the one on Tuesday"), the keypad reference, a reference that is someone else's (BLOCK `scope`, its line), a caller with none (the form says so and ends: an `onEntry` that finds none, or a `complete` that answers with a line), and the step-up. Corpus labels: `appointmentChoice: "appt_7101"` ([corpus.md](corpus.md#labels-by-slot-type)).
- **Pitfall:** `testing.seed.placeholders` needs a key that a seeded call's records hold, and the policy matrix needs `records` with a `record` id (`{ subject: '55501234', record: '7101' }`: [Testing the policy](#testing-the-policy)). The [record type's page](../../../docs/slots/record.md) has every option.

## An opening from a schedule

**When:** the caller picks a time the business has free ("what do you have Thursday?"). There is no time type: a free slot on the schedule is a record, found by a tool and chosen as above.

```yaml
# slots.yaml
opening:
  type: record
  from: openings
  key: id
  label: "{day|day} at {time}, with {who}"
```

- The form's entry call loads the openings (the next two weeks', say: `entry: () => ({ tool: 'findOpenings', params: {} })`) and its `onEntry` keeps them in the facts for `forSlots`, so the caller names one by its day and time ("Thursday at ten"). The tool is a read: give it an action of its own (level 0 for a new customer) and list it in `calls`. Where there are too many to offer at once, ask the day in a first form whose `complete` reads that day's openings into the facts, and pick the opening in an internal form after it (`next`).
- A caller who only needs a part of the day ("a morning next week") needs no opening: a `date` and a `timeOfDay` choice, as in [Qualify before you collect](#qualify-before-you-collect), and the office calls back with the time.
- The booking sends the opening's key. Whether it is still free is the booking tool's to say, as any system's answer: it returns no booking, and the completion says a line of its own and asks again. That is no policy; a bound on the day is (`dateInRange`).
- **Test:** a day with two openings and the caller naming one by its time, a day with none (the line that says so, and the day asked again), and an opening taken between the read-back and the yes.
- **Pitfall:** never let the model name a time no tool returned: the record slot takes only keys, and the key is checked by the booking tool.

## Bounds: `limit` and `dateInRange`

**When:** the paragraph says a date or an amount must fall somewhere ("no earlier than tomorrow", "within thirty days", "no more than what is owed"). The built-in range rules hold one param to bounds ([authoring guide, section 3.3](../../../docs/authoring-an-app.md#33-the-built-in-rules)). A bound is a number or a date, `today` (the call's day), or a reference to a lookup, `<lookup>(<param>)`, which the code declares:

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

**A bound no built-in rule holds** is a custom rule. The common one is an age from a date of birth ("patients must be 18 or over"): no built-in rule counts years, and `dateInRange` counts days, which a leap year moves. The rule reads the call's day from the gate's facts, never the clock:

```yaml
# policy.yaml, under actions:
  checkAge:
    say: check the caller is 18 or over
    check: true
    level: 1                  # the date of birth is an identity factor: checked once it is verified
    rules:
      - identity
      - custom: eighteen-or-over
```

A custom rule is made with `defineRule` (from `'dialogwright/policy'`): its id, what it holds in plain words, its `run`, and examples, at least one call the gate allows and one it refuses (`pnpm check` refuses a rule without them, and a plain function). Each example runs through the gate in every action that names the rule, so it must pass the action's other rules: a principal at the action's level, every param the action sends (its `confirmed` or `fields` list, or a check's `with`) with values inside the other bounds. The example's facts default to no failed attempts, its values confirmed, and the regression's day, 2026-09-18.

```ts
// src/app.ts (or a module of its own that src/app.ts imports)
import { defineRule } from 'dialogwright/policy';

const PATIENT: Party = { kind: 'patient', level: 1, id: '55501234', first: 'Avery' };

/** The day `years` years before an ISO day (a February 29 falls back to February 28). */
function yearsBefore(iso: string, years: number): string {
  const y = Number(iso.slice(0, 4)) - years;
  const md = iso.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${y}-${md === '02-29' && !leap ? '02-28' : md}`;
}

export const eighteenOrOver = defineRule({
  id: 'eighteen-or-over',
  description: 'The caller is 18 or over on the day of the call',
  run(c) {
    const latest = yearsBefore(c.facts.todayIso, 18);
    const dob = c.call.params.dob ?? '';
    return dob !== '' && dob <= latest
      ? { pass: true, compared: `dob on or before ${latest}: yes` }
      : { pass: false, compared: `dob on or before ${latest}: no`, verdict: 'BLOCK', reason: 'under-age' };
  },
  examples: [
    { name: 'eighteen today', call: { params: { dob: '2008-09-18' } }, principal: PATIENT, expect: { verdict: 'ALLOW' } },
    { name: 'eighteen tomorrow', call: { params: { dob: '2008-09-19' } }, principal: PATIENT, expect: { verdict: 'BLOCK', reason: 'under-age' } },
  ],
});

// in code:
customRules: { 'eighteen-or-over': eighteenOrOver },
```

A custom rule's `compared` line goes to the audit as it is: never put a value in it that the app masks (an identifier, a date of birth, free text). The line above names the cut-off day, never the caller's date of birth. Log the custom rule as a gap in the worksheet. [A check that needs identity](#a-check-that-needs-identity) wires this rule into a form.

- **Test:** each bound at its edges with the gate directly ([Testing the policy](#testing-the-policy), "The bounds, at their edges"), and a scripted call for each refusal with its line (`blockPromptId`).
- **Pitfall:** a bound reads the call's day (2026-09-18 in the regression), never the clock; and a refused value needs a line of its own in `blockPromptId`, or the caller goes to a person.

## A value from a list: `oneOf` and `noneOf`

**When:** a value must be, or must not be, one of a fixed list: a town in the service area, a budget the business takes on, anything but a burst pipe (which goes to a person). A param held to a list is a built-in rule, not a custom one ([authoring guide, section 3.3](../../../docs/authoring-an-app.md#33-the-built-in-rules)):

```yaml
# policy.yaml, in an action's rules:
      - oneOf: { field: town, values: [oakdale, pine_hollow, westbury], reason: out-of-area }
      - oneOf: { field: budget, values: [mid, high], reason: below-minimum }
      - noneOf: { field: problem, values: [burst_pipe], reason: burst-pipe, verdict: NEEDS_HUMAN }
```

- The values are the param's values as the slot holds them, matched exactly: a choice slot's option ids (`check` refuses one that is not an option, and names the closest). No case-insensitive match: a value said several ways is one choice option.
- A failure is `BLOCK` with the rule's `reason` (`not-one-of` or `one-of` without one), or a person with `verdict: NEEDS_HUMAN`. A missing or empty value is always `BLOCK` `value-missing`.
- They are what a form's checks ask ([below](#qualify-before-you-collect)). Log nothing as a gap: they need no code.

## A value no slot holds, in the read-back

**When:** a summary names a value the code works out (a total from the record, a fee): the form's `onSummaryRead` hook gives it as a variable. Without it the regression stops with `prompt variable missing: <name>`.

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

## Qualify before you collect

**When:** the paragraph says who the line is not for: "we only treat homes in Oakdale, Pine Hollow and Westbury; businesses go to our commercial desk"; a clinic that sees only adults; a lead line that takes on only some budgets. That is a qualify-then-collect line: some answers rule the caller out, and the caller should hear so before they give a name, a number, an address and a day. The example below is a pest control company; the shape is the same for each. Write it as **one form**: the qualifying slots first, then the booking's, one summary over all of them, and a **check** on each qualifying answer. A check asks the gate about an answer as soon as it is given; a refusal ends the form with its line ([authoring guide](../../../docs/authoring-an-app.md#checks-ending-a-form-part-way)). No second form, no intent nobody says, no code that turns the caller away after the rest was asked.

```yaml
# forms.yaml, under forms:
  book_treatment:
    slots: [pest, property, town, address, caller, phone, day, timeOfDay]
    summaryPromptId: confirm_book_treatment
    hooks: [confirmedParams, complete]
    calls: [bookTreatment]
    checks:
      - action: checkProperty
        with: [property]
        on:
          commercial: { say: commercial_desk, then: handoff }
      - action: checkPest
        with: [pest]
        on:
          bees: { say: decline_bees, then: anything-else }
      - action: checkArea
        with: [town]
        on:
          out-of-area: { say: decline_out_of_area, then: end }
    checksPassed: home_qualifies
```

```yaml
# policy.yaml, under actions:
  checkProperty:
    say: send a business to the commercial desk
    check: true
    level: 0
    rules:
      - identity
      - noneOf: { field: property, values: [business], reason: commercial, verdict: NEEDS_HUMAN }
  checkPest:
    say: check the pest is one the company treats
    check: true
    level: 0
    rules:
      - identity
      - noneOf: { field: pest, values: [bees], reason: bees }
  checkArea:
    say: check the home is in the service area
    check: true
    level: 0
    rules:
      - identity
      - oneOf: { field: town, values: [oakdale, pine_hollow, westbury], reason: out-of-area }
  bookTreatment:
    say: book a treatment visit
    level: 0
    rules:
      - identity
      - noneOf: { field: property, values: [business], reason: commercial, verdict: NEEDS_HUMAN }
      - noneOf: { field: pest, values: [bees], reason: bees }
      - oneOf: { field: town, values: [oakdale, pine_hollow, westbury], reason: out-of-area }
      - confirmed: [pest, property, town, address, caller, phone, day, timeOfDay]
      - dateInRange: { field: day, notBefore: today+1 }
```

```yaml
# slots.yaml: the answers that end the call are read back first (the skill's recommendation)
property:
  type: choice
  options: { home: "your home", business: "a business" }
pest:
  type: choice
  options: { ants: ants, rodents: "mice or rats", wasps: wasps, bees: bees, other: "another pest" }
  confirmValues: [bees]
town:
  type: choice
  options: { oakdale: Oakdale, pine_hollow: Pine Hollow, westbury: Westbury, elsewhere: "a town outside our area" }
  confirmValues: [elsewhere]
day:
  type: date
  range: future
timeOfDay:
  type: choice
  options: { morning: "the morning", afternoon: "the afternoon", evening: "the evening" }
```

- **A check action has no tool** (`check: true`): the gate decides and nothing runs, so there is no tool to write and no `params` to list. `calls` does not list it; the form reaches it through `checks`.
- **The rules are lists, so they are built-in**: `oneOf` (the value is one of those listed: a town in the area) and `noneOf` (none of them: not a business, not bees), each with the `reason` the check's `on` maps and, for a person, `verdict: NEEDS_HUMAN` ([authoring guide, section 3.3](../../../docs/authoring-an-app.md#33-the-built-in-rules)). No code, and no examples to write: the policy card says each in words ("town must be one of Oakdale, Pine Hollow or Westbury: any other is refused (`out-of-area`), ..."). Write a `defineRule` only for what no list says ([an age from a date of birth](#bounds-limit-and-dateinrange)).
- **Each rule is named twice**: in the check, and in the write. That is defence in depth: the completion still refuses what a check refused, and `pnpm check` warns when a check's rule is missing from every action the form calls. Copy the line as it is, so the two lists cannot drift.
- **`with` names the slots the check sends**, each as the param of the same name, its value as the slot holds it (`pine_hollow`, not "Pine Hollow"). So a list names a choice slot's option ids, and `pnpm check` refuses one that is not an option (with the closest) and a rule on a param no check of it sends. The match is exact. A rule fails closed: a missing or empty value refuses, `value-missing`.
- **One check per answer, or one for the group.** A check per answer refuses on the turn the answer is given, so a business is sent to the desk before the town is asked. One check over several slots (`with: [property, town]`, one `checkCaller` action) runs only once all are filled: use it only when the answers rule a caller out together.
- **The one form also keeps what the caller says up front.** The turn that opens a form fills every slot of it, so "we've got mice at home, can someone come Saturday morning" on the opener fills the pest, the property, the day and the time, runs the checks, and the day and the time are never asked. Two forms (an entry form, then a booking with `next`) would keep the qualifying answers but ask the day and the time again once the booking is open. So one form with checks stays the first choice, with the booking's slots in it even though they are asked last.
- **The order of `checks` is the order a caller with two reasons hears them.** Put first the one the business cares about most. All the slots of the form listen from its first turn, so "bees at my shop in Fairmont" fills three and runs the checks in order; the first refusal speaks.
- **The endings**: `end` (the line, then the goodbye), `anything-else` (the line, then "anything else?", for a caller who may want something else: bees today, ants next week), `handoff` (to a person with `handoff_<reason>`, or the line `reason:` names, `say` optional before it). Each line is in `prompts.yaml` and renders with the form's slot displays (`{town}`). A reason `on` does not list gets `c.refusal`'s handling. When the check refuses on the turn the form opened, the engine drops "Sure, I can help you ..." for you, so write each refusal line so it names what it refuses: it may be the first the caller hears of the form.
- **A request that always goes to a person, but is no emergency**, is a `noneOf` with `verdict: NEEDS_HUMAN` on a choice option and `then: handoff` (the business above; a plumber's "a burst pipe" as the answer to "what's wrong?", `noneOf: { field: problem, values: [burst_pipe], reason: burst-pipe, verdict: NEEDS_HUMAN }`, line `handoff_burst_pipe`). It is said as an answer, so it needs no intent. Something said as a request that must never wait, at any question, is a [priority intent](#something-that-must-never-wait) instead.
- **`checksPassed`** is a line said once, when the last check passes ("Good news, we treat homes in {town}."). A correction that re-runs a check does not say it again.
- **The day and the time of day.** There is no time type. A time of day is a `choice` (morning, afternoon, evening, as above), held with the day (`date`) by the write's rules; an exact time from a schedule is [an opening the caller picks](#one-of-the-callers-own-records-record) from those a tool found.
- **Corrections at the summary are checked**: "no, wait, it's for my shop" re-runs the property check and hands over; "yes, but it's bees" is caught at completion, before the write.
- **Three options build on this one**, each with a pattern of its own: [reading the deciding answer back](#reading-an-answer-back-confirm-and-confirmvalues) before a refusal acts (recommended for every answer that ends the call), [a check that needs identity](#a-check-that-needs-identity) (only a verified caller qualifies, an age from the date of birth), and [several entry forms before one booking](#several-entry-forms-one-booking-next).
- **Test:** the scripted calls to write are each refusal asked in turn (two questions, then the line), everything in one breath with and without a refusing answer, a qualifying answer and the day and time on the opener (answer only the rest, then yes: the day and time are not asked again), and each summary correction, with a no and with a yes ([corpus.md](corpus.md#what-to-write) has the lines). The engine's own fixture for this shape is `packages/dialogwright/src/testing/screened`.
- **Pitfall: never write `s.queued` from app code.** The queue is the engine's. Chaining a second form from a completion by putting it on the queue is the shape checks and `next` replace: a form that rules a caller out is one form with checks, and a booking after several entry forms is their `next`. Nor turn the caller away in `complete` after every question was asked: that is a check.

## Reading an answer back: `confirm` and `confirmValues`

**When:** an answer ends the call or turns the caller away (a town outside the area, a pest the company does not treat, a budget below the minimum, a caller under 18), or sends something somewhere it cannot be taken back. A slot's default, `confirm: summary`, reads nothing back until the summary, and a check runs on the turn its answer is heard, so a misheard "Westbury" taken as another town would turn away a caller the business serves. Recommend a read-back for each such answer, and write the choice in the worksheet; leave it out only where the paragraph says the line should not ask.

Pick by what refuses:

| What refuses | The option | What the caller hears |
|---|---|---|
| One value of a choice slot (`elsewhere`, not a town in the area) | `confirmValues: [elsewhere]` on the slot | "elsewhere" is read back at once (`confirm_<slot>`); a town in the area waits for the summary |
| Any value of a slot that must be right before the form goes on (a meter number, a name to look up) | `confirm: always` on the slot (every type) | every value is read back at once |
| A rule no list of values says (several slots together, a `defineRule`) | `confirm: <prompt>` on the check's outcome | the refusal is read back before it acts |

```yaml
# slots.yaml
town:
  type: choice
  options: { oakdale: Oakdale, pine_hollow: Pine Hollow, westbury: Westbury, elsewhere: "a town outside our area" }
  confirmValues: [elsewhere]  # read back at once with confirm_town; a town in the area waits for the summary
meterId:
  type: digits
  noun: meter number
  length: 8
  keypad: true
  confirm: always           # every value read back at once with confirm_meterId
```

```yaml
# forms.yaml, under a form's checks:
      - action: checkArea
        with: [town, zip]
        on:
          out-of-area: { confirm: check_area, say: decline_out_of_area, then: end }
```

```yaml
# prompts.yaml, under prompts: (every locale)
  confirm_town:
    text: Just to check, the home is in {town}?
    interruptible: true
  confirm_meterId:
    text: That's meter {meterId}. Is that right?
    interruptible: true
  check_area:
    text: Just to check, the home is in {town}, zip code {zip}?
    interruptible: true
```

- **A yes** confirms the value (or a check's `with` slots), and the refusal acts as written. **A no** empties the value, says `ack_declined` and asks the slot again, a step on its ladder; the right answer said with the no ("no, it's in Westbury") is taken instead, and the check runs again on it. A second no to the same read-back goes to a person, and a read-back nobody answers is asked again, then goes to a person: a refusal never acts on silence.
- A value is never read back twice: one confirmed at its own read-back is not read back at the check or again at the summary's yes, and a check's `confirm` is skipped when every slot it reads is confirmed already.
- `confirm_<slot>` is given the slot's display as `{<slot>}` (a choice option's text, so word the options to fit the line: `elsewhere` reads "Just to check, the home is in a town outside our area?"); a check's `confirm` line renders with the form's slot displays, as `say` does. `pnpm check` asks for each.
- **Test:** the refusing answer read back and a yes (the call ends with the refusal); a no and the right answer in the next turn (the form goes on, and the check passes); a no with the right answer in the same breath; a refusing answer read back twice and two nos (a person); silence at the read-back; and an answer that does not refuse (a town in the area), which is not read back. A read-back has no corpus context of its own: the scripted calls' yes and no are lines of the corpus written at the form's summary (`confirm_<form>`, with `confirm`), and the right answer is the slot's own answer line ([corpus.md](corpus.md#answers-at-a-read-back-the-greeting-and-the-consent-question)).
- **Pitfall:** `confirm: always` on a `text` slot read back by a stand-in (`say: your note`) is refused, since the caller would hear "your note?": such a slot reads back its own words (`say: null`, `redact: none`). And a read-back is a turn the model is sent, so adding one after a recording re-keys the cassette there: decide it before the first recording.

## A check that needs identity

**When:** only a verified caller qualifies ("existing customers only", "we check your account is in good standing first"), or a check reads an identity factor (a clinic that sees only adults: an age from the date of birth), in a form anyone may start. The check action is the one under [Bounds](#bounds-limit-and-dateinrange): `checkAge`, `level: 1`, with the `eighteen-or-over` rule written there with `defineRule`.

```yaml
# forms.yaml, under forms:
  book_visit:
    slots: [reason, day, timeOfDay]     # never the factor: identity asks it
    summaryPromptId: confirm_book_visit
    hooks: [confirmedParams, complete]
    calls: [bookVisit]
    checks:
      - action: checkAge
        with: [dob]
        on:
          under-age: { say: decline_under_age, then: end }
```

- A check on any slot works the same way at `level: 1` ("existing customers only": the check's rules hold the slot, and its level asks for identity first). When the check is ready and the gate answers `STEP_UP`, the caller is asked to verify as for an entry call (the factors, then the code where the level needs it, the portal on a chat), the form and what it holds stay as they are, and the check runs again once the caller is verified. A failed verification ends as the identity ladder ends.
- A check that reads a factor never waits for it: as soon as it waits on nothing else, identity is asked for. A factor said on the way by a caller not yet verified fills it, and a check at `level: 0` would run on it as said: `level: 1` runs it on a verified value. On a web chat, which takes no typed factor, the form goes to a person.
- **Always write `level:` on a check.** A check with none is refused (it would need the highest, so a forgotten `level: 0` would make every caller verify part-way); a level written out above what the entry proves is a warning, which you accept by writing it.
- **Test:** an anonymous caller who reaches the check, verifies, and goes on; one who fails verification; one who verifies and is refused (the check's line); a chat caller (the portal, or a person for a check on a factor).
- **The age, by what the paragraph says.** "Are you 18 or over?" is a `choice` (`adult`, `minor`) held by `oneOf`, with nothing to verify; an age said as a number is a `digits` slot (`mask: '\d{1,3}'`, `redact: none`) held by `limit`; an age that must be true is worked out from the verified date of birth, as here.
- **Pitfall:** never list the factor in the form's `slots`: `pnpm check` refuses it, since the form would empty it as it closes while the caller stays verified, and a later form's check would wait forever. The engine's fixture is the checking variant of `packages/dialogwright/src/testing/proposals` ([authoring guide](../../../docs/authoring-an-app.md#a-check-that-needs-identity)).

## Several entry forms, one booking: `next`

**When:** callers reach the same booking by different roads, and each road asks its own questions first: new patients and existing patients of a dental office, a leak and a blocked drain for a plumber. An internal form has no intent, so each road is a form intent of its own whose `next` is the booking. One form with checks stays the first choice: use `next` only when one form would have to ask questions that do not apply to the caller.

```yaml
# forms.yaml, under forms:
  new_patient:
    slots: [caller, plan]
    summaryPromptId: null
    calls: []
    checks:
      - action: checkPlan
        with: [plan]
        on:
          plan-not-taken: { say: decline_plan, then: anything-else }
    next: book_appointment       # no complete hook: the next form is its answer
  existing_patient:
    slots: []
    summaryPromptId: null
    hooks: [entry]               # the entry call needs level 1: the patient verifies first
    calls: [findPatient]
    next: book_appointment
  book_appointment:
    internal: true               # no intent: the model, the keypad menu and the queue never see it
    label: book your appointment
    slots: [caller, plan, reason, day, timeOfDay]
    summaryPromptId: confirm_book_appointment
    hooks: [confirmedParams, complete]
    calls: [bookAppointment]
```

- Each entry form is a form intent with its own questions and checks and no summary (`new_patient`: "I'd like to become a patient"; `existing_patient`: "I'm a patient and need a cleaning"); the booking has `internal: true`, a `label`, and no line in intents.yaml. The engine bridges in with `bridge_next` and the label ("Now, let's {intentLabel}."), ahead of anything queued. Only a `said` completion goes on: a check's refusal ends the form where it is.
- **List the entry form's slots in the booking too**: their values and confirmations carry across, so the caller is never asked them again, and the booking's summary reads them back with its own. A form in the chain drops every slot it does not list. A booking slot one road already filled is not asked again; one the other road did not (an existing patient's `plan`, here) is asked in the booking, or filled from the record in the entry form's `onEntry`. The entry form's checks still hold in the booking for the slots it lists: a plan changed at the booking's summary gets the entry form's own line.
- The booking's own slots wait for it to open (an internal form's `listenBeforeEntered` is `false`), so a day said on the opener is asked again in the booking: [Where a slot listens](#where-a-slot-listens-listen-and-listenbeforeentered).
- **Test:** each road in one breath (the booking opens on that turn and asks only its own slots), a refusal on a road (no booking), a correction at the booking's summary that a road's check refuses, the existing patient's step-up, a request queued earlier (it waits until the booking is done) and a priority intent mid-booking (the booking is left, and not resumed). The engine's fixture is the `NEXT` variant of `packages/dialogwright/src/testing/screened` (`variant.ts`).
- **Pitfall:** keep the chain to two forms. `pnpm check` refuses a `next` to no form, a loop, an internal form no `next` reaches, one with an intent or with no `label`, and a `label` on a form intent ([authoring guide](../../../docs/authoring-an-app.md#a-form-that-goes-on-to-the-next-next-and-internal-forms)).

## Where a slot listens: `listen` and `listenBeforeEntered`

**When:** a value said early should be kept for a later form, or a value whose words come up in other requests should be heard only in its own form. Inside a form, its slots always listen; these options say what happens outside it.

| What you want | The option |
|---|---|
| Values said with the request fill the form it opens (the default) | nothing: `listen: up-front` |
| A value heard only once its form is open (a first payment date, which "are you open Saturday?" must not fill) | `listen: form` on the slot |
| A value said before the request (a reference number at the greeting) kept for the form that needs it | `listen: anywhere` on the slot |
| The caller's own name or date of birth kept for every later form | app.yaml's `carrySlots: [caller]` (the same as `listen: call`) |
| None of a form's slots taken before it is open | `listenBeforeEntered: false` on the form (the default for an internal form) |

```yaml
# slots.yaml
firstDate:
  type: date
  range: future
  listen: form
```

```yaml
# forms.yaml, under a form
    listenBeforeEntered: false
```

- A slot with no `listen` of its own listens as its forms say: `form` when every form that lists it says `listenBeforeEntered: false`, `up-front` otherwise. So a slot an entry form and its internal booking both list still fills up front. A slot's own `listen`, and `carrySlots`, override the forms; `pnpm check` warns when one says otherwise than every form that lists it.
- An identity factor listens as identity says, and `listen` is refused on it.
- **Test:** the value said early, and a scripted call that shows where it is used (not asked again) or asked again (with `form`); for a carried slot, two forms in one call, the second not asking it.
- **Pitfall:** no option keeps a detail for a second request named in the same breath ([Known gaps](#known-gaps)): one form with checks is how a qualify-then-book line keeps the booking's details said up front. A carried value pre-fills the next form, so give that form a summary. Any value but the default changes what the model is sent, so choose before the first recording ([authoring guide](../../../docs/authoring-an-app.md#where-a-slot-listens-listen)).

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
- An answer that rules the caller out mid-form is a check, not a refusal at completion ([above](#qualify-before-you-collect)).
- Three failed tries at verification hand over with `handoff_identity`.
- **Test:** each refusal with its line, and a person asked for from every place a caller can be (step 5 of the skill lists them).
- **Pitfall:** a line named only in code (`blockPromptId`, `handoff(...)`) is one `pnpm check` cannot see: the regression stops with `unknown prompt id` when it is missing. What the person who takes the call is handed is [its own choice](#what-a-transfer-hands-over-handoffdata).

## An intent's criteria

**When:** every intent. An intent's `criteria` are what the model reads to choose it, word for word, on every turn. So a change to them re-keys a recorded cassette: get them right before the first recording, and reword them all at once after it ([triage.md](triage.md#the-order-of-the-fixes)).

**A sentence that gives every slot of a form at once is still a request for that form.** A caller who answers all the form's questions in one breath, with no request word ("the power's been out on Elm Street since noon, and the whole block is dark"), asks for nothing in so many words, and the model may read it as no request (`none`). Say in the form intent's criteria that such a sentence is the request:

```yaml
# intents.yaml, under intents:
  report_outage:
    criteria: Reports a problem with their power, such as an outage or flickering lights, or asks for someone to look into it. A caller who describes such a problem is reporting it, however many other details they add in the same breath, such as the street, how long it has been out, or whether the neighbours are out too
    label: report a problem with your power
    kind: form
```

Give the corpus a line like it among the form's over-answers ([corpus.md](corpus.md#what-to-write)), labelled with the intent and every slot it fills. The stub reads the labels, not the criteria, so only a recording tests the wording.

When two intents are near each other, say in each which requests are the other's ("asks when the power will be back on an outage already reported; a new outage is report_outage's").

## Informational answers

**When:** the paragraph gives a fixed answer (hours, an address, a web page to visit). An intent that only says something: no form, no tool, no policy.

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

**When:** the app has something that must never wait or be missed, an emergency or a safety report: mark its intent `priority: { correctsForm: true }` (the skill's default for such an intent). Without `priority`, a caller who says "actually, I can smell gas right now" at a form's question is read as answering that question, and the form asks the rest of its questions first; one who says "hold on, the smell is getting stronger" half aside is ignored as side speech.

```yaml
# intents.yaml, under intents:
  gas_smell:
    criteria: Smells gas, or reports a gas leak, at their home or nearby, right now
    label: reach our emergency line
    kind: form
    priority: { correctsForm: true }   # read at PRIORITY_INTENT, as `true` is; and the same words correct the form left
```

`correctsForm` is for the handoff: the turn that switches was asked about the open form's slots, so "wait, I can smell gas by the meter right now", said at the read-back of an outage report, also sets the hazard the caller gave ten turns earlier ("none") to `gas` before the call goes to the emergency line. Without it the line gets the old value. It says nothing (no acknowledgement of the corrected value), runs none of the form's checks on the way out, and changes no question the model is sent. Pair it with `handoff.data.unconfirmed: mark` ([What a transfer hands over](#what-a-transfer-hands-over-handoffdata)), so the office knows which values to check: at a read-back the caller interrupts, none is confirmed.

Read at `PRIORITY_INTENT` (0.8) or more, the intent is acted on that turn, wherever the call is: the form in hand is left (not queued), a pending confirmation is dropped, and side speech or words read as unintelligible do not stop it. A handoff to a person and the injection screen still win, and its form's actions go through the policy gate as any other's. The usual shape is a form with no slots whose `complete` hook hands off with a line of its own:

```yaml
# forms.yaml, under forms:
  gas_smell:
    slots: []
    summaryPromptId: null
    hooks: [complete]
    calls: []
```

```ts
// src/app.ts
/**
 * Put through to the emergency line, for the reason given (handoff_<reason> is the line). The
 * engine acknowledged the request on entering the form ("Sure, I can help you reach our emergency
 * line."); drop it, so a caller who smells gas hears one sentence, the handoff line.
 */
const toEmergencyLine = (reason: string) => (c: CompletionContext): Completion => ({
  kind: 'decision',
  decision: handoff(c.s, reason, c.acks.filter((a) => a.promptId !== 'ack_intent')),
});

// in code.forms:
gas_smell: { complete: toEmergencyLine('emergency') },
```

and the line `handoff_emergency` in `prompts.yaml` ("If you smell gas, leave the building now. I'm putting you through to our emergency line.", `interruptible: false`). Filter out only `ack_intent`: any other line the turn carries is still said. Only a form intent or an informational one may be priority, and `correctsForm` is for a form intent.

- **Test:** corpus lines inside each form a caller could be in (`context: <form>`, `change: replacing`), one said aside ("hold on, ..."), and one at each summary that also contradicts a slot the form holds, labelled with the slot's new value ([corpus.md](corpus.md#what-to-write)), with a scripted call that checks the handoff carries it (`expect.slots`). The debug table's `priorityIntent` row says when it took the turn (`act:<intent>:over:<gate>`).
- **Not every request a person takes is a priority.** One that always goes to a person but can wait for the question it answers (a burst pipe as the answer to "what's wrong?", a business on a homes-only line) is a check with `verdict: NEEDS_HUMAN` ([Qualify before you collect](#qualify-before-you-collect)).
- **Pitfall:** a priority intent wins over a pending yes, so "yes, and I can smell gas" at a proposal or a read-back opens the priority form and the yes is lost; and a corrected value a check would refuse still goes to the office, since the switch wins. Its own threshold, if a recording shows it, is [a switch](#switches-with-a-safe-default). The whole option is under "Must never wait" in the [authoring guide](../../../docs/authoring-an-app.md#must-never-wait-priority).

## What a transfer hands over: `handoff.data`

**When:** every app that hands calls to a person (all of them: `agent` is built in). On a phone call the transfer hands the carrier the slots the call collected; a chat's transfer sends its reason only.

```yaml
# app.yaml
handoff:
  data:
    unconfirmed: mark       # the skill's default: the values the caller never confirmed are sent and named
    slots: all              # the default; none, or a list of slot ids
    send:
      accountId: masked     # an identity factor goes only when named here: masked (by its last four) or as-is
```

- **`unconfirmed`**: `send` (the engine's default: nothing named), `mark` (sent, and the end frame, the console's handoff card and the audit's handoff row name the slots never confirmed) or `omit` (left out). A value is confirmed by a yes to its own read-back, a keyed value, or a yes at a summary it has not changed since. Prefer `mark` for a new app: an emergency is when the office most needs the name, the number and the address, confirmed or not.
- **`slots` and `send`**: by default an identity factor is left out, a slot with a `redact` setting goes masked as the trace masks it, and any other slot goes as it is. Name a slot `as-is` only when the person taking the call needs it in the clear, and write why in the worksheet.
- **Test:** a scripted call that hands over mid-form, with `expect.slots` naming the values the call holds as it goes; one from a priority switch at a read-back, where none is confirmed.
- **Pitfall:** `pnpm check` refuses a factor listed in `slots` with no `send`, `masked` for a slot with no `redact`, and warns of `mark` with `slots: none`, which sends nothing to mark ([authoring guide, app.yaml](../../../docs/authoring-an-app.md#appyaml)).

## A knowledge form

**When:** callers ask general questions a document answers ("what is the late fee?"), more than a fixed line or two can hold. The answer is said from a passage a person approved, word for word. The whole feature is section 12 of the [authoring guide](../../../docs/authoring-an-app.md#12-the-knowledge-base); this is the wiring, as built in a running app (the engine's library fixture), and the traps.

```yaml
# slots.yaml
subject:
  type: topic
```

```yaml
# forms.yaml
forms:
  ask_library:
    slots: [subject]
    summaryPromptId: null
    answers: { slot: subject }
    calls: [findPassage, getFees]
```

```yaml
# intents.yaml
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

**When:** a value callers may find easier to key than to say (an account number, a date of birth, a choice by number), and a menu for callers the model cannot understand.

- A `digits`, `date`, `birthdate` or `choice` slot takes `keypad: true`, and a `record` slot `keypad: <the number of keys>` (its key keyed); each then needs `ask_<slot>_dtmf` (the line that asks for the keys). The keypad is offered after spoken answers miss, and keys are taken whenever the slot was the last thing asked.
- The one-time code is always keyed.
- A scripted call's keypad step is `{ "dtmf": "55501234" }`.
- **The keypad menu** (`menu:` in intents.yaml) listens only once it has been offered: on a call with a keypad (a phone call, never the chat), the second missed answer to "what can I help you with" (words it did not understand, or a silence) offers it with `nomatch_dtmf_menu`, and the next turn's keys are menu keys. A third miss goes to a person (`max-attempts`). A key pressed before that, at the greeting for instance, is ignored and the caller hears nothing. After an informational key the menu is offered again, so it keeps listening. A scripted call for a menu key misses twice first, with two silences: `[{ "silence": true }, { "silence": true }, { "dtmf": "4" }]`. A silence is a miss with no model call, so no recording can change the path. Do not open with words: a filler like "um" is read as addressed to the line at about the threshold, so on a recording it is sometimes ignored rather than missed and the menu is never offered (seen on three apps' first recordings), and any word the model reads can move a call whose subject is the keypad. (The clinic's and the utility's older calls open with "okay"; keep theirs as they are, since changing them re-keys their cassettes.)

## A callback number: `callerNumber`

**When:** "take their name and a good callback number", or any number the form cannot finish without (where to send a one-time code). On a phone call the carrier already knows the number, so the line offers it instead of asking for ten digits. It is a required offer: the defaults, `onNo: ask` and `ifNone: ask`, ask the slot's own question after a no or with no number to offer.

```yaml
# slots.yaml
phone:
  type: digits
  noun: phone
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'        # +15555550142 is offered as 555 555 0142; another country's number is not offered
```

```yaml
# prompts.yaml, under prompts: (every locale)
  ask_phone:
    text: What's the best number to reach you?
    interruptible: true
  ask_phone_retry:
    text: Sorry, what's the ten-digit number we should call?
    interruptible: true
  ask_phone_dtmf:
    text: Please key in the ten-digit number on your keypad.
    interruptible: true
  offer_phone:
    text: Is the number you're calling from, ending in {last4}, the best one to reach you?
    interruptible: true
  confirm_request_callback:
    text: I have {caller}, at {phone}, about {reason}. Shall I set up the callback?
    interruptible: true
```

- When the form reaches `phone` on a call whose number fits the slot, the line says `offer_phone` in place of `ask_phone`. A yes fills the slot; a no asks `ask_phone` with no attempt counted; "no, use my cell, 555 555 0199" fills the number said. A chat, or a withheld number, is asked `ask_phone` as always.
- **Give the form a summary that reads `{phone}` back.** The offer says only the last four, so the summary is where the caller hears the whole number; `pnpm check` warns when a form with the slot has none.
- **Never on an identity factor.** A caller ID can be forged, and a yes to an offer verifies nothing, so `pnpm check` refuses `callerNumber` on a factor. To let the number identify an account, use [caller ID as the identifier](#verified-by-caller-id-callerid), which a knowledge factor verifies.
- The number is masked as the slot is (`redact: last4`, the default), so the tool param named `phone` is recorded by its last four and needs no `audit` line.
- **Test:** a scripted call from a number, `"callerNumber": "+15555550142"` beside `steps` (a withheld one as `"+7378742833"`: not a phone number but RESTRICTED spelt on a keypad, which is how Twilio sends a withheld caller ID; the engine knows it, and the other spellings, as no number, so the scripted call is a withheld call): one with a yes, one with a no and a number said, a no and then nothing said (the slot's ladder ends at a person: the offer is required), one withheld, and the chat. A corpus line at the offer: `{"id":"of-01","text":"yes, that's fine","intent":"none","context":"request_callback","prompted":"phone","confirm":"yes"}`.

## Texting the caller: `onNo`, `ifNone` and the `callerNumber` rule

**When:** "offer to text them updates", a reminder, a link: the same offer, for a slot the caller may turn down. A no means no text, so the slot is left empty and the form goes on. Then decide the three choices of [What an offer takes](#what-an-offer-takes-whether-it-may-be-declined-and-consent-for-the-call): what the line takes, required or optional, and consent for the whole call.

```yaml
# slots.yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  keypad: true
  group: [3, 3, 4]
  callerNumber:
    countryCode: '1'
    onNo: skip      # a no, or no answer, leaves the slot empty
    ifNone: skip    # no number to offer (a chat, withheld, a landline) leaves it empty too
```

```yaml
# prompts.yaml, under prompts: (every locale)
  offer_textTo:
    text: Can I text you updates at the number you're calling from, ending in {last4}?
    interruptible: true
  ask_textTo:
    text: What mobile number should we text updates to?
    interruptible: true
  confirm_open_request:
    text: That's a request about {topic}, with no texts. Shall I open it?
    interruptible: true
  confirm_open_request_text:
    text: That's a request about {topic}, with updates texted to {textTo}. Shall I open it?
    interruptible: true
```

```yaml
# policy.yaml
actions:
  sendUpdates:
    say: text updates about a request
    level: 0
    rules:
      - identity
      - callerNumber: { field: textTo, else: confirmed }
      - confirmed: [topic, textTo]
```

- A no, the end of the offer's retry ladder, or no number to offer leaves `textTo` empty (declined), and the summary is read next. "No, text my cell, 555 555 0199" fills the number said.
- **Never name a skippable slot in the summary line.** It may be empty, and `pnpm check` refuses `{textTo}` there. Read it back from a line of its own: the form's `onSummaryRead` hook returns `{ promptId: 'confirm_open_request_text' }` when the slot holds a number.
- **Refuse a landline in code.** `callerOffer(ctx, slot)` in the app's code returns false to make no offer (the slot then follows `ifNone`); it may read the facts or call a gated line-type lookup through `ctx.callTool`. Without it, every offer is made.
- **Send only where the caller agreed.** The completion sends the text through its own tool, only when the slot holds a number, and the `callerNumber` rule holds that number to the caller's own (`else: refuse`, the default) or to one they heard read back and said yes to (`else: confirmed`, which needs the field in the action's `confirmed` rule).
- **The answer is recorded.** Every settled offer writes an `offer` row to the audit with the line as said and the answer (`yes`, `no`, `other`, `none`). Whether that yes is consent to be texted is the owner's legal question; the engine records what was asked and answered, and decides nothing.
- **Test:** scripted calls with a yes, a no, a no with a number, no answer (two silences), a landline, a withheld number and the chat. Corpus lines at the offer: a yes, a bare no, "that's my landline" (`confirm: no`), a no with a number, a number alone (`confirm: unanswered`), and words that answer neither.
- **Pitfall:** `onNo: skip` alone leaves `ifNone: ask`, the default, so a chat caller or a withheld number is asked for a number to text they never offered: an optional text sets both to `skip`.

## One number to call and text

**When:** the line both calls the caller back and texts them (a reminder, a link) at the same number, and the paragraph asks for one number, not two. One `digits` slot with `callerNumber` serves both; its offer says both.

```yaml
# prompts.yaml, under prompts: (every locale)
  offer_phone:
    text: Is the number you're calling from, ending in {last4}, the best one to call and text you at?
    interruptible: true
```

```yaml
# policy.yaml, under actions:
  sendReminder:
    say: text a reminder of the visit
    level: 0
    rules:
      - identity
      - callerNumber: { field: phone, else: confirmed }   # the caller's own number, or one they confirmed
      - confirmed: [pest, property, town, address, caller, phone, day, timeOfDay]
```

- The slot is required (the defaults), as a callback number is; the text goes to it from the completion, through its own tool, after the booking.
- `else: confirmed` passes a number the caller said instead ("no, use my cell"), since the summary read it back whole and the caller said yes; the field must be in the action's `confirmed` rule.
- **Test:** a yes (both go to the number calling), a no with another number (both go to it), a withheld number (the slot is asked), and the chat.
- **Pitfall:** a caller who wants calls at one number and texts at another needs two slots: the callback and an optional text offer ([Texting the caller](#texting-the-caller-onno-ifnone-and-the-callernumber-rule)). Whether a yes to this line is consent to be texted is the owner's question: write the line so it asks it plainly.

## What an offer takes, whether it may be declined, and consent for the call

**When:** every offer of the caller's number and every proposal. Three choices about each, each with a default that is safe, and each the app's to make. Decide them from the paragraph, in this order.

**1. What the offer takes: `answers` (or `offerAnswers` on a proposal).** Read the line as a caller hears it.

- The line invites a number ("Shall I use the number you're calling from, or would you like to give me another?"): keep the default, `yes-no-or-value`. A yes takes the number offered; "no, use 555 555 0199" or the number alone fills as said.
- The line asks a yes or no question ("Are you calling about the account ending in 1234?", "Is this about 22 Alder Street?"): `answers: yes-no` inside `callerNumber`, or `offerAnswers: yes-no` beside `offer: facts`. A value said there is not taken, and with no clear yes it is a no, so `onNo` decides what follows; on the keypad 1 is yes and 2 is no.

```yaml
# slots.yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  callerNumber: { countryCode: '1', onNo: skip, ifNone: skip, answers: yes-no }
place:
  type: text
  what: the street address where the problem is
  say: null
  redact: none
  offer: facts
  offerAnswers: yes-no
```

When unsure, keep the default: a value said at the offer is then taken as the caller meant it.

**2. Required or optional: `onNo` and `ifNone`.** Ask what a no should mean.

- **Required**: the form cannot finish without the value (the number to send a one-time code to, the callback number). Keep the defaults, `onNo: ask` and `ifNone: ask`: a no asks the slot's own question, and the slot's ladder ends at a person. Give the form a summary that reads the number back.
- **Optional**: a no means "don't" (a reminder text, updates about a request). `onNo: skip` and `ifNone: skip`: a no, no answer, or no number leaves the slot empty and the form goes on. Never name it in the summary line; read it back from a line of its own.

**3. Consent for the whole call: `textConsent`.** When the paragraph texts the caller at more than one moment ("we text them the link to the form, and a reminder the day before"), ask once, up front:

```yaml
# app.yaml
textConsent:
  covers: [linkTo, reminderTo]   # each a digits slot with callerNumber
```

```yaml
# prompts.yaml, under prompts: (every locale)
  greeting_offer:
    text: Thanks for calling Example Requests.
    interruptible: true
  consent_texts:
    text: Can I text you helpful links during this call, at the number ending in {last4}?
    interruptible: true
  greet_after_offer:
    text: What can I help you with today?
    interruptible: true
```

- A yes fills every covered slot with the caller's number, confirmed, with no question when its form reaches it, unless the app's `callerOffer` hook refuses that slot then (it is asked at the greeting, for the covered slots in turn, and again at each covered slot after a grant: a landline refused for texts stays refused). The engine does not remember the hook's answers: a hook that calls a tool keeps the answer in the facts and reads it there next time; a no, or a request instead, leaves each slot to ask its own offer (so write each `offer_<slot>` as well). Each covered slot keeps its own `onNo` and `ifNone` for that case.
- It is asked only on a call, right after the greeting, with the caller's number kept; never on the chat. The caller-ID question at the greeting comes first and a proposal at the greeting after it: only one question follows the greeting.
- Every grant is recorded: a `consent` row for the answer, and an `offer` row with `answer: consent` for each slot filled from it. App code reads the answer with `textConsentOf(s)`; a caller who later asks for no more texts is the app's own intent to handle.
- With a single text moment, skip it: the slot's own offer is the question.
- **Test:** corpus lines at the consent question: `no_form`, `confirm` (yes, no, unanswered), no `prompted`; write a yes, a yes with a request, a no, a yes that names another number and a request with neither, and set `testing.seed.callerNumber`. Scripted calls: granted (no offer asked after), declined (each offer asked), a request instead, a withheld number and the chat. With `answers: yes-no`, a value said at the offer (a no) and the keypad's 1 and 2. For a required offer, a no and then nothing said (a person).
- **Pitfall:** `consent_texts` must say `{last4}` and nothing else, and `pnpm check` needs `greeting_offer` and `greet_after_offer` with it. Turning `textConsent` on changes what the model is sent at the greeting, so decide it before the first recording.

## Looking the caller up by number

**When:** "if we know the number, start from their account": the line uses what it can find by the number calling (a line type before a text, an address to propose, an account for [caller ID](#verified-by-caller-id-callerid)). app.yaml's `callerNumber` keeps the number for the app's code, and may look the caller up once at call start; `called: true` keeps the number called too, for a line with several numbers (`calledOf(s)`).

```yaml
# app.yaml
callerNumber: { use: hint, lookup: findAccountByPhone }
```

```yaml
# policy.yaml
actions:
  findAccountByPhone:
    say: find the service address for the number calling
    level: 0
    rules:
      - identity
      - callerNumber: { field: callerNumber }
audit:
  callerNumber: last4
```

- The tool lists one param, `callerNumber`, and returns the least that works (a line type, an address to propose), never a balance, a claim or a name: whatever it returns may be said to someone who has proven nothing, since a caller ID can be forged. Its result goes to the facts through `facts.fromCallerLookup` in the app's code; a refusal is silent.
- App code reads the numbers with `callerOf(s)` and `calledOf(s)` (`called: true` keeps the number called). Both are null on a chat and with no number.
- **A match is no verification.** It changes neither who the caller is nor their level, and a form that needs identity still asks for the factors, unless identity.yaml's `callerId` lets the match stand in for the account number ([Verified by caller ID](#verified-by-caller-id-callerid)).

**Proposing what the lookup found.** "If we know their address, ask whether it's that one": the slot proposes it as a yes or no, at the slot, inside the form (or at the greeting, with `offerAt: greeting`, below).

```yaml
# slots.yaml, on the slot
place:
  type: text
  what: the street address where the problem is
  say: null
  redact: none
  offer: facts
```

```yaml
# prompts.yaml, under prompts: (every locale)
  offer_place:
    text: I see an account for the number you're calling from. Is this about {place}?
    interruptible: true
```

```ts
// src/app.ts, code.facts
fromCallerLookup(f, value) { /* keep the street the lookup returned, and nothing else */ },
offers: (f) => (f.serviceAddress ? { place: { value: f.serviceAddress, display: f.serviceAddress } } : {}),
```

- **Say as little as works.** The line is said to whoever holds, or forges, the number, before they prove anything: it may name only what the lookup's level 0 action returns. What it returns is the app's call; the usual advice is the least that works (a street, rather than a balance, a claim or a name), and a line that says "an account", rather than whose.
- **A yes fills that slot and nothing else.** Not the principal, the level or the attempts: a form that needs identity still asks for the factors. `pnpm check` refuses `offer: facts` on a factor, beside `callerNumber`, and on a slot redacted by its length (a text slot that proposes takes `say: null` and `redact: none`).
- A no asks the slot's question with no attempt counted; another value said ("no, 7 Birch Lane") fills as said; it is offered once per slot per form, and a slot reopened at the summary is asked. No candidate (nothing found, a withheld number, a chat): the slot is asked as always.
- `pnpm check` needs `facts.offers`, and `offer_<slot>` saying `{<slot>}` and nothing else. Every settled proposal writes an `offer` row (`source: facts`).
- **`offerAt: greeting`** on the slot ("if we know the number, ask about that address as soon as they call"): the call opens on `greeting_offer` and `offer_<slot>` in place of the open question; a yes fills the slot for the form that uses it and `greet_after_offer` asks how to help, "yes, I'd like to report a problem" goes straight on, "no, it's 7 Birch Lane" fills the slot as said, and a bare no leaves it to be asked. A priority intent in the same breath wins and the yes is lost. Corpus lines there are `no_form`, `prompted` the slot, with `confirm`. Write both lines; `pnpm check` asks for them ([authoring guide](../../../docs/authoring-an-app.md#at-the-greeting-offerat-greeting)).
- **Facts loaded after identity propose too**: no `callerNumber` lookup is needed. A form whose `entry` call needs level 1 and whose `onEntry` keeps what it read (the street on the account) can propose it for a later slot, to a caller already verified.
- **Test:** scripted calls from a number on file with a yes, a no, another address and silence; a number not on file; a withheld number; the chat; and a yes followed by a request that needs identity. Corpus lines at the offer as for a callback number: a yes, a bare no, a no with another value, another value alone, words that answer neither.
- **Pitfall:** whatever the lookup returns may be said to someone who has proven nothing; and `offerAt: greeting` with no `callerNumber` lookup proposes nothing at the greeting (nothing has loaded the facts yet), which `pnpm check` warns of.

## Switches with a safe default

**When:** rarely at first. Each switch below has a default that suits most lines; change one only for a reason the paragraph gives, or one a recording shows, and write the reason in the worksheet.

| Switch | Where | Default | Choose otherwise when |
|---|---|---|---|
| `unsureIntent`, an intent's own `unsure` | app.yaml, intents.yaml | `confirm`: a request the model reads at 0.4 to 0.6 is asked about ("Just to check, do you want to ...?") | `no-match` where a wrong guess costs more than a second try: intents that sound alike, or a request that should start only when it is understood plainly |
| `changeSlotWithValue` | app.yaml | `set-aside`: at a summary, a no that also gives a slot a new value applies the value and reads the summary again | `decides` where callers often name one detail as wrong and correct another in one breath |
| `anythingElseSilence` | app.yaml | `repeat`: silence after "anything else?" hears "anything else?" again | `goodbye` where a caller with nothing more to say has finished; `opener` for the opening question |
| `thresholds:` and `priority: { threshold: NAME }` | app.yaml, intents.yaml | the engine's (`PRIORITY_INTENT` 0.8, and the rest in the guide) | a recording shows one intent needs its own bar: name a threshold of the app's own and point the intent at it, never a number in code |
| `voice.continueWithinMs` | app.yaml | `300` | the recognizer breaks a caller's words at longer pauses |

```yaml
# app.yaml
unsureIntent: no-match
changeSlotWithValue: decides
anythingElseSilence: goodbye
thresholds:
  URGENT_SURE: 0.75
```

```yaml
# intents.yaml, under intents:
  gas_smell:
    criteria: Smells gas, or reports a gas leak, at their home or nearby, right now
    label: reach our emergency line
    kind: form
    priority: { correctsForm: true, threshold: URGENT_SURE }
```

**Settings of the server, not the app.** How the phone line behaves on the carrier is the deployment's, set in the owner's `.env`, never in the app's files: who may talk over a line (`BARGE_IN`: `any`, `speech`, `dtmf` or `none`), how long a silence is waited for (`NO_INPUT_MS`, `NO_INPUT_AFTER_SPEECH_MS`), how long keys at a yes-or-no offer are held before they count as one answer (`KEY_WAIT_MS`, default 2000), and the rest of the [guide's section 13.1](../../../docs/authoring-an-app.md#131-the-options). You set none of them. When the paragraph says something they answer ("callers are often on speakerphone"), write it in the worksheet's choices and the README for the owner, with the setting it points to.

- **Test:** a scripted call for each switch you change (a silence after "anything else?" ending at `goodbye`; a request read as unsure, with its new outcome).
- **Pitfall:** a switch is a choice about the business, not a fix for a corpus line: change one only for the reason written in the worksheet. `unsure` changes no question the model is sent, so it can be checked on a recording you have ([triage.md](triage.md#the-order-of-the-fixes)); a threshold moves what every recorded answer decides, so try it with `regress --client recorded --threshold NAME=VALUE` before you write it down ([authoring guide](../../../docs/authoring-an-app.md#when-the-model-is-unsure-unsure)).

## What is recorded: `params` and `audit`

**When:** every tool. Every call is recorded (the gate event, the trace, the console, the audit), so every value it carries must have a stated way of being recorded. Two parts say it: each tool lists its `params` in code, and `policy.yaml` declares `audit` for each of those that is not a slot with a redact setting.

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
- Write `passed(decision, 'role')` (from `'dialogwright/policy'`) to ask whether a rule passed, by its name; rule lines are recorded under names (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf`, `noneOf`, `callerNumber`, a custom rule's own id).

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

## Names the engine keeps

Choose ids that none of the engine's own take, so `pnpm check` does not refuse a name after you have written it in every file.

- **Slot ids.** A slot's questions to the model are named after its id: a `choice` slot `x` asks `x`, the other types add a suffix (`xGiven`, `xSpan`, `xMode`, ...: [corpus.md](corpus.md#labels-by-slot-type)). The engine asks questions of its own on every turn, so a slot may not take, or make, one of their ids: `intent`, `intentTentative`, `addressedToSystem`, `utteranceComplete`, `wantsHuman`, `rephrasingLastTurn`, `confusedByPrompt`, `spokeAMenuNumber`, `frustration`, `urgency`, `triedSelfService`, `languageSwitch`, `intelligible`, `confirmsYes`, `confirmsNo`, `intentChange`, `secondIntent`, `changeSlot`, `menuNumberSaid`, `manipulation`, `callerMatchDeclined`. The ones a paragraph tempts you to: `urgency` (how urgent the problem is: say `howUrgent`), `frustration`, `intent`. The list is exported as `ENGINE_QUESTION_IDS` by `'dialogwright'`.
- **Choice option ids.** `none` is the label the model gives when the caller names no option, so no option may be called `none` (`no_insurance`, not `none`); and an option id starts with a letter (`two`, not `2`).
- **Intent ids.** `agent`, `repeat_prompt` and `done` are the engine's control intents (`other` and `none` are the scaffold's): keep them as they are, and do not give one of your tasks their id.
- **The subject's kind** in identity.yaml may not be `anonymous`, `channel`, `principal`, `level`, `factor`, `pass`, `config` or `configFiles`.

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
    values: PLAN_CALL,                           // a value per param, inside every bound, so an allowed call can be seen:
                                                 // const PLAN_CALL = { accountId: '55501234', count: 'three', firstDate: '2026-09-25', total: '240.00' }
  }),
  // ...
},
```

`record` (one of the subject's records, `{ subject: '55501234', record: 'R-1' }`) is needed only when a rule scopes by a record (`scope: { record: <param> }`); the grid then says which of the four lacks one. With `scope: { param }` rules only, leave it out.

**An action whose rules read params needs named calls.** For each action the grid builds one call: its subject param and its `confirmed` or `fields` list, each valued from `values`. An action with neither (a form's check, whose rules decide on what the caller said: the kind of property, the pest, the town) is sent no params at all, so its rules fail closed and every caller is refused for the same reason. That matrix looks plausible ("every caller BLOCK value-missing") and is wrong. Give each such action named sets of params under `calls`, one for each outcome its rules can reach, so the matrix shows every reason the paragraph gives. The engine's fixture for checks (`packages/dialogwright/src/testing/screened`) has these:

```ts
// src/app.ts, in testing.policyMatrix, beside principals, records and values
calls: {
  checkProperty: { home: { property: 'home' }, business: { property: 'business' } },
  checkPest: { ants: { pest: 'ants' }, bees: { pest: 'bees' } },
  checkArea: { inArea: { town: 'westbury' }, elsewhere: { town: 'elsewhere' } },
},
```

```text
checkPest · level 0 · identity, noneOf(pest: bees)
  every caller   fields exact|extra, params ants  ALLOW
                 fields exact|extra, params bees  BLOCK bees
                 fields missing                   BLOCK value-missing

checkArea · level 0 · identity, oneOf(town: oakdale, pine_hollow, westbury)
  every caller   fields exact|extra, params inArea     ALLOW
                 fields exact|extra, params elsewhere  BLOCK out-of-area
                 fields missing                        BLOCK value-missing
```

The grid still sets the subject param itself. Use `calls` too for an action with a `confirmed` list whose rules turn on a value (a visit today, one a rule refuses): one set that passes, and one for each value a rule refuses. A row where every caller is refused for one reason is a sign the calls are missing, so read it against the worksheet before you accept it.

With an app with no delegates, the `unlistedRole`, `roleless` and `otherParty` callers are still given (of a kind the app does not serve), as the clinic's are. Then the test, and the first matrix written deliberately:

```ts
// src/app.test.ts
import { fileURLToPath } from 'node:url';
import { expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';

describe('the policy against its file', () => {
  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));
  it('runs every custom rule example as written', () => {
    expect(runRuleExamples(app).map((r) => `${r.tool} ${r.example}: ${r.expected}`)).toEqual([
      'checkAge eighteen today: ALLOW',
      'checkAge eighteen tomorrow: BLOCK under-age',
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
- **One set of factors per level, so no either-or verification** ("your account number, or your phone number and ZIP code"): level 1 has one `factors` list. Choose one set ([Which factors](#which-identity-factors-when-the-paragraph-is-silent)); where the other route is the number calling, [caller ID as the identifier](#verified-by-caller-id-callerid) is the second road to level 1.
- **A short secret is recorded whole**: a `digits` slot's `redact` is `last4` or `none`, so a four-digit PIN or the last four of an identity number is recorded in full. Prefer a longer factor; where the paragraph insists, write the slot in code with `redact: 'length'` ([authoring guide, sensitive values](../../../docs/authoring-an-app.md#sensitive-values)), which records only its length (`<4 chars>`; `mask` keeps the last four digits as a year, so it would not hide a PIN), and log the gap.
- **No slot asked only of some callers**: a form asks every slot it lists. Give each kind of caller its own form, or its own entry form before a shared booking ([Several entry forms, one booking](#several-entry-forms-one-booking-next)).
- **The caller's number cannot be offered for a factor**: a phone number on file works as a factor when the caller says or keys it (a `digits` slot), but `callerNumber` on a factor is refused, so the line cannot offer "the number you're calling from" for it. For callers who call from it, use [caller ID as the identifier](#verified-by-caller-id-callerid).
- **No slot type for an amount of money or an address** (above).
- **Delegates only on a signed-in chat**: no phone path for a delegate; scripted calls use `as`, and a corpus line with `as` must be `no_form`. A delegate's answer inside a form comes from a corpus line without `as` that has the same words.
- **A factor slot does not fill from a delegate's words**: give delegates their own slot for the subject they name (above).
- **A detail for a second request named in the same breath is lost**: "where is my parcel, and book a delivery window for tomorrow morning" opens the first form and queues the second, and the turn fills only the form it opens, so the queued form asks the day again when it is reached, even with `listen: anywhere` or `call` on the slot ([Where a slot listens](#where-a-slot-listens-listen-and-listenbeforeentered)). Let it ask, and pin it with a scripted call. A qualify-then-book line does not meet this: it is one form with checks ([above](#qualify-before-you-collect)).
- **`pnpm check` does not check the corpus** beyond every intent having examples, nor the lines named only in code (`blockPromptId`, `handoff(...)`, a completion's line, a summary variable from `onSummaryRead`). The regression finds them, one at a time.

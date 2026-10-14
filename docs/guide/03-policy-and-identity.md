# 3. Policy and identity

[Contents](README.md) · Previous: [2. The files, one by one](02-the-files-one-by-one.md) · Next: [4. What stays in TypeScript, and why](04-what-stays-in-typescript-and-why.md)

The gate decides whether an action may run, and it decides from two files that a person who does not write code can read: `policy.yaml` (what the agent may do, action by action) and `identity.yaml` (who the app serves and how a caller proves who they are). Policy is data, and never lives in a tool. A tool does its work; the gate decides whether it runs. This section is the whole of how to write, test and review those two files. [design.md](../design.md#6-identity-and-policy) says why they are shaped this way.

The snippets here come from the engine's own test app, Example Parcels (a fictional parcel depot, `packages/dialogwright/src/testing/testkit/`), which runs from the same files an app folder has: a customer who verifies with an account ID and date of birth and then a texted code, and depot agents who act for customers with a role. Where a snippet is only an illustration it says so. Every YAML block in this guide that is a policy or identity file is checked against the schemas and the rules by a test, so an example cannot drift from what the loader accepts.

- [3.1 The two files](#31-the-two-files)
- [3.2 An action and its rules](#32-an-action-and-its-rules)
- [3.3 The built-in rules](#33-the-built-in-rules)
- [3.4 Rules of your own: `defineRule`](#34-rules-of-your-own-definerule)
- [3.5 Purposes and wording](#35-purposes-and-wording)
- [3.6 The identity ladder](#36-the-identity-ladder)
- [3.7 How a form reaches an action: `calls`](#37-how-a-form-reaches-an-action-calls)
- [3.8 Redaction per principal: `redact`](#38-redaction-per-principal-redact)
- [3.9 What is recorded: `audit`, and the rule names](#39-what-is-recorded-audit-and-the-rule-names)
- [3.10 Testing the policy](#310-testing-the-policy)
- [3.11 Reading the policy: the card and the app map](#311-reading-the-policy-the-card-and-the-app-map)
- [3.12 Who reviews it: CODEOWNERS](#312-who-reviews-it-codeowners)
- [3.13 Converting an old file](#313-converting-an-old-file)

### 3.1 The two files

`policy.yaml` is required. Its keys:

| Key | What it holds |
|---|---|
| `actions` | One entry per action (a tool): its `level`, its rules in order, and a `say` that names it in plain words. |
| `purposes` | The level a purpose (what the caller wants done) needs, where it is more than its first action's. |
| `wording` | The words the built-in rules use in their lines, so the console and the audit read in the app's terms. |
| `redact` | The fields of an action's result withheld from a party who acts for subjects. |
| `audit` | How each param that is not a slot with a redact setting is recorded. |

`identity.yaml` is optional. An app without it verifies no one: every caller stays anonymous, and every action must be level 0 (the clinic is like this). Its keys are `principals` (who the app serves, and who acts for them), `levels` (the ladder), `attempts` and `signIn`. Section 3.6 has them.

The two are read together. Policy names the levels and roles identity declares, and identity names tools that policy gives actions; the loader checks each against the other and against the app's code, and reports every disagreement at its line.

### 3.2 An action and its rules

```yaml
actions:
  getParcel:
    say: read a parcel
    level: 2
    rules:
      - identity
      - scope: { record: parcel }
  createReport:
    say: report a missing parcel
    level: 2
    rules:
      - identity
      - role: { viewer: refuse, clerk: person }
      - scope: { param: accountId }
      - confirmed: [accountId, missingNote, expectedDate]
      - custom: not-delivered-that-day
```

- An action is a tool. Every tool in the code needs an action here, and every action needs a tool: a tool with no action cannot be called, and the gate blocks any call to a tool the policy does not list (`unlisted`), for every caller.
- `level` is the identity level the action needs: 0 anonymous, 1 the factors matched, 2 the factors and a one-time code (`identity.yaml` names them). An action with no `level` needs the highest, so one left without fails closed. `say` is what the action does, in a reviewer's words, as the policy card says it; write it for every action.
- `rules` is a list, run in the order written. The first rule that fails decides, and the gate answers with that rule's verdict: `BLOCK`, `STEP_UP` (verify further, then try again) or `NEEDS_HUMAN` (a person takes the call). Order is part of the policy: put `scope` before a rule that looks something up, so a lookup is only asked about a record the caller may see. A rule with no parameters is its bare name (`identity`, `attempts`); a rule with parameters is a one-key map. A rule is listed once per action (a range or list rule once per field). An empty list runs no rule, and the policy card says so.
- No rule is implied. An action that must check the level lists `identity`; a tool that verifies a caller lists only `attempts` at level 0 (it cannot ask for a level its own call is there to raise).
- `check: true` makes the action a form's check ([forms.yaml, Checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)): a question to the gate only, with no tool, so an ALLOW runs nothing (the gate event is recorded with no tool result). Some form's `checks` must name it. It may not list `confirmed` (nothing is confirmed part-way through a form). Its level is usually 0, or what the form's entry call proves first (a form with an `entry` hook whose purpose, under `purposes`, needs that level); a level written out above that is allowed, with a warning, and asks the caller to verify when the check runs ([A check that needs identity](02-the-files-one-by-one.md#a-check-that-needs-identity)). A check with no `level` is refused, since it would need the highest. Name the same rules in the action the form writes with, so the write holds what the check held:

```yaml
actions:
  checkOwner:
    say: check the caller owns the home
    check: true
    level: 0
    rules:
      - identity
      - oneOf: { field: ownership, values: [own], reason: not-owner }
  bookInspection:
    say: book a free inspection
    level: 0
    rules:
      - identity
      - oneOf: { field: ownership, values: [own], reason: not-owner }
      - confirmed: [ownership, address, name, phone, day]
```

### 3.3 The built-in rules

| Rule | Written | Passes when | When it fails |
|---|---|---|---|
| `identity` | `identity` | the caller's level is at least the action's (raised to the call's purpose's level, if that is higher) | `STEP_UP` to that level for one of the app's subjects, who can give the factors; `BLOCK` `identity` for any other party, who cannot |
| `scope` | `scope: { param: accountId }` or `scope: { record: parcel }` | the subject the call names is one the caller may see | `BLOCK` `scope` |
| `role` | `role: { viewer: refuse, clerk: person, reason: staff-filing }` | the caller's role is allowed the action | `BLOCK` `role`, or `NEEDS_HUMAN` with the rule's `reason` |
| `confirmed` | `confirmed: [accountId, missingNote, expectedDate]` | the call sends exactly these fields, and their values are the ones the caller said yes to | `BLOCK` `confirmation` |
| `attempts` | `attempts` | the failed tries at the identity checks are fewer than `identity.yaml`'s `attempts` | `NEEDS_HUMAN` `attempts` |
| `fields` | `fields: [report, missingNote, expectedDate]` | the call sends no field beyond these | `BLOCK` `minimization` |
| `dateInRange` | `dateInRange: { field: returnDate, notAfter: today }` | the date is within its bounds | `BLOCK` or `NEEDS_HUMAN`, by reason |
| `limit` | `limit: { field: amount, max: 500 }` | the number is within its limits | `BLOCK` or `NEEDS_HUMAN`, by reason |
| `oneOf` | `oneOf: { field: town, values: [millbrook, ashford], reason: out-of-area }` | the value is one of those listed | `BLOCK` (or `NEEDS_HUMAN`) with the rule's `reason`, `not-one-of` if none; `BLOCK` `value-missing` with no value |
| `noneOf` | `noneOf: { field: howUrgent, values: [emergency], verdict: NEEDS_HUMAN }` | the value is none of those listed | `BLOCK` (or `NEEDS_HUMAN`) with the rule's `reason`, `one-of` if none; `BLOCK` `value-missing` with no value |
| `callerNumber` | `callerNumber: { field: textTo, else: confirmed }` | the number is the one the caller is calling from, or with `else: confirmed` one the caller confirmed at the summary | `BLOCK` `not-caller-number`, or `no-caller-number` on a call with no number; `BLOCK` `value-missing` with no value |
| `custom` | `custom: not-delivered-that-day` | the app's own rule says so (section 3.4) | the rule's own verdict and reason |

Every rule fails closed: a param that is missing, a record that does not exist or a lookup that throws is a refusal, never a pass.

**`identity`.** Level comparison, nothing more. A caller below the level is stepped up if they can be (the engine then asks for the factors on a channel that cannot sign them in) and refused if not.

**`scope`.** Whose record it is. `param` says the call's param is the subject's own id (`accountId`); `record` says it is a record id the gate resolves to its owner with the app's `ownerOf` lookup. A caller may see what the `scopeOf` lookup gives for them: a subject sees their own records, a party acting for subjects sees those of the subjects they act for. A missing, empty or unknown subject fails the rule, with the same refusal either way, so the line cannot be used to learn which records exist. Scope never comes from the conversation. `wording` can describe the rule in the app's own terms (section 3.5).

**`role`.** What each role may do with the action: `allow`, `refuse`, or `person` (a person takes the call, for the `reason` named, `role-person` if none; its handoff line is `handoff_` and the reason with its hyphens as underscores, `handoff_role_person` by default, and `check` requires it in every locale). A role not listed is refused, and so is a party who acts for subjects and has no role. One of the app's own subjects passes: roles govern the parties acting for them. The roles are those `identity.yaml` declares under `principals`.

**`confirmed`.** What makes a write match exactly what the caller agreed to. The form reads its slots back, the caller says yes, and the engine hashes the values of these fields in this order; the write goes through only if the call carries exactly these fields with exactly those values. A correction said with the yes ("yes, but Thursday") changes a value, so the write is refused and the read-back is said again. For now every `confirmed` rule of an app names the same fields in the same order, since the read-back's hash is taken once, over one list; `check` reports one that differs.

**`attempts`.** Failed tries at an identity check, the factors' and the code's, counted against the one number `identity.yaml` gives.

**`fields`.** The minimum a downstream service receives: the call may send these fields and no others. An empty list sends none.

**`dateInRange` and `limit`.** Two rules that hold a param's value to bounds, so a common check needs no code. A store's refund, say (an illustration): the amount at most the order's total, the return date no later than today and inside the order's return window.

```yaml
actions:
  refundOrder:
    level: 2
    rules:
      - identity
      - scope: { record: orderId }
      - fields: [orderId, amount, returnDate]
      - limit: { field: amount, min: 0.01, max: orderTotal(orderId) }
      - dateInRange:
          field: returnDate
          notAfter: today
          within: returnWindow(orderId)
          reasons: { outsideWindow: late-return }
          verdicts: { outsideWindow: NEEDS_HUMAN }
```

- `dateInRange: { field, notBefore?, notAfter?, within?, unscoped?, reasons?, verdicts? }`. `field` is the param holding the date, `yyyy-mm-dd` and a day the calendar has. `notBefore` and `notAfter` are `today` (the call session's date, never the clock), a number of days from today, a date, or a reference to a lookup that gives one. `within` is a reference to a lookup that gives a window, `{ start, end }` with `end: null` for one with no end; a lookup that gives `null` has no window, and the date is outside it. At least one of the three.
- A number of days from today is `today+N` or `today-N`, N a whole number from 1 to 3660, with no spaces and no leading zero: `notAfter: today+30` holds a date to no later than 30 days from today, `notBefore: today-7` to no earlier than a week ago. The day is today's date with N calendar days added or taken away, counted in UTC days, so a month's end, a year's end and a leap day fall where the calendar has them. Any other spelling (`today+0`, `today + 30`, `today+030`, `today+30d`, `today+3661`) is a problem `check` reports. Two bounds that both count from today must be in order; a date and a number of days from today are not compared, since today moves. The policy card says it in words: "no later than 30 days from today", "no earlier than 7 days before today".
- `limit: { field, min?, max?, unscoped?, reasons?, verdicts? }`. `field` is the param holding the number: an optional minus, digits, an optional point and digits (`12`, `0.50`, `-3`), and nothing else (no units, currency, thousands separators, exponents or spaces). `min` and `max` are numbers, or references to a lookup that gives one (a number, or a text in the same form). At least one of the two. Numbers are compared exactly, as decimals. A bound beyond 9007199254740991 (the largest whole number a YAML number holds exactly) is written quoted, as text (`max: "12345678901234567890"`); `check` refuses it unquoted, since it may already be rounded.
- Every bound is inclusive: a value equal to a bound, or to either end of a window, passes.
- `reasons` names the reason the gate gives for each way the rule fails, for the app's refusal lines (`blockPromptId`) and handoffs: `invalid` (not a date: `not-a-date`; not a number: `not-a-number`), `outOfRange` (`date-range`; `limit`), and for `dateInRange` `outsideWindow` (`date-window`). `verdicts` sets `outOfRange` and `outsideWindow` to `BLOCK` (the default) or `NEEDS_HUMAN`.
- They fail closed. A value that is not a date or a number BLOCKs, whatever `verdicts` says. A bound that cannot be found BLOCKs with the reason `bound-unknown`: the param a reference reads is missing, the lookup is not a function or gives something that is not a date, a number or a window. A lookup that throws BLOCKs the call too (`rule-error`).

A reference is `<lookup>(<param>)`, or `<lookup>(<param>).<field>` to read one field of what the lookup gives (`order(orderId).total`). Each part is a plain word (a letter, then letters, digits and underscores). It is read when the app is built, never run: the lookup is a function of the gate's lookups (what `systems()` returns beside `ownerOf` and `scopeOf`), called with the value of `<param>` in the call, and the app names the lookups a reference may call in `code.lookups` (`definePolicy(..., { lookups })` for an app that is not a folder):

```ts
export const code: AppCode = {
  // ...
  lookups: ['orderTotal', 'returnWindow'],
  systems: () => {
    const store = new StoreSystems();
    return {
      sys: store,
      lookups: {
        ownerOf: (id) => store.ownerOf(id),
        scopeOf: (p) => store.scopeOf(p),
        orderTotal: (id) => store.order(id)?.total ?? null,
        returnWindow: (id) => store.returnWindow(id),
      },
    };
  },
};
```

**Whose lookup it is.** A lookup called with a param is about the record that param names, so a caller must not be able to read a bound off someone else's: every param a reference reads must be held to the caller's own records by a `scope` rule earlier in the same action (`scope: { param: <it> }`, or `scope: { record: <it> }` for a record id), as `scope: { record: orderId }` does above. Where the lookup is about no one's record (a price list, a calendar, terms that are the same for everyone), say so on the rule with `unscoped: true`, and no scope rule is needed:

```yaml
      - limit: { field: fee, unscoped: true, max: feeSchedule(service) }
```

`check` refuses a reference whose param no earlier scope rule holds, in a rule that is not `unscoped`, and `unscoped` on a rule with no reference. The policy card says, for each range rule with a reference, whose lookup it is.

A bound comes only from the app's code and systems, never from the session's facts or the conversation. `check` refuses a reference to a lookup `code.lookups` does not name, a name every object has (`constructor`, `toString`, `prototype`, ...) as a lookup or a field, the gate's own `ownerOf` or `scopeOf`, and, where the action's `fields` or `confirmed` rule says which params it sends, a `field` or reference param outside them. A field is read only as a plain object's own value, never a getter or an inherited one.

Each records itself under its name (`dateInRange`, `limit`) with lines like `amount at least 0.01, at most orderTotal(orderId) 120` and `returnDate outside returnWindow(orderId) 2026-09-20..2026-10-20`: the param's name and the bounds it was held to (today's date, a number of days from today with the date it gave, `on or before today+30 2026-11-01`, a literal, what a lookup gave), with a reference as written: the param a lookup was called with by its name only. No param's value is ever in the line, not even its last four, since it may be a value the app records hidden or never, and a line goes to the audit as it is.

**`oneOf` and `noneOf`.** Two rules that hold a param's value to a list, so the commonest qualifying question needs no code: the home is in one of the towns the business works in, the caller owns it, the problem is not an emergency. They are what a form's checks most often ask ([Checks](02-the-files-one-by-one.md#checks-ending-a-form-part-way)):

```yaml
actions:
  checkUrgency:
    say: send an emergency to the office
    check: true
    level: 0
    rules:
      - identity
      - noneOf: { field: howUrgent, values: [emergency], reason: emergency, verdict: NEEDS_HUMAN }
  checkArea:
    say: check the home is in the service area
    check: true
    level: 0
    rules:
      - identity
      - oneOf: { field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }
```

- `oneOf: { field, values, reason?, verdict? }` passes when the value is one of `values`; `noneOf` (the same keys) when it is none of them. `field` is the param that holds the value: for a check, one of the slots its `with` sends (`check` refuses one no check of it sends); for an action with a tool, a param it sends, as for the range rules. `values` lists at least one value, each once, each as text (quote one YAML would read as a number or as true or false: `"1"`, `"true"`).
- The match is exact: the value as the call carries it, character for character. A slot's value is already what its type made of the caller's words, and a choice slot's is one of its option ids (`cedar_falls`, never "Cedar Falls"), so list the ids. `check` holds a list on a param of a choice slot's name to that slot's option ids, and names the closest when one is not (`"cedar falls" is not an option of the choice slot "town" ... rename it to "cedar_falls"`). There is no case-insensitive match on purpose: words a caller says several ways belong in a choice slot's options, which turn them into one id, not in the policy.
- `reason` names the reason a refusal gives, for a check's `on:`, the app's refusal lines (`blockPromptId`) and handoff lines (`handoff_<reason>`). Without it, `not-one-of` for `oneOf` and `one-of` for `noneOf`. `verdict` is `BLOCK` (the default) or `NEEDS_HUMAN`, for a person to take the call (an emergency).
- They fail closed. A value that is missing or empty BLOCKs with the reason `value-missing`, whatever `verdict` says, for `noneOf` too: a call that says nothing is not "none of these". A check never sends an empty value (it runs once its slots are filled), so `value-missing` is what a write without the param gets.
- Each records itself under its name (`oneOf`, `noneOf`) with lines like `town one of [millbrook, cedar_falls, ashford, riverton]` (a `oneOf` that passes), `town not one of [...]` (one that refuses) and `howUrgent none of [emergency]` (a `noneOf` that passes): the param's name and the list, never the call's value. The policy card says it in words, with a choice option's own words: "town must be one of Millbrook, Cedar Falls, Ashford or Riverton: any other is refused (`out-of-area`), and a missing value is refused".

**`callerNumber`.** A rule that holds a param to the number the caller is calling from, so a text the app sends goes only to the caller's own phone, or to a number the caller heard read back whole and said yes to:

```yaml
actions:
  sendUpdates:
    say: text updates about a request
    level: 0
    rules:
      - identity
      - callerNumber: { field: textTo, else: confirmed }
      - confirmed: [topic, textTo]
  findAccountByPhone:
    say: find the service address for the number calling
    level: 0
    rules:
      - identity
      - callerNumber: { field: callerNumber }
audit:
  callerNumber: last4
  topic: keep
```

- `callerNumber: { field, else? }`. `field` is a param the action sends. It is compared as the slot of the same name holds the caller's number (its `callerNumber` offer's `take`: `5555550142` for `+15555550142`); a param named `callerNumber` is the number as the session keeps it (the call-start lookup's param); any other is compared digit for digit with the number as kept, and `check` warns.
- `else: refuse`, the default: any other number BLOCKs with `not-caller-number`, and on a call with no number kept (a chat, a withheld number) every number BLOCKs with `no-caller-number`. `else: confirmed`: another number passes only when the caller confirmed the call's values at the summary (the action's `confirmed` rule, hashed as the summary hashed them), so the caller heard it whole and said yes; `check` requires the field in the action's `confirmed` rule.
- It fails closed: a missing or empty value BLOCKs with `value-missing`. The number is a hint, never identity on its own: the rule says where a call may send something, never whose record it reads, so never use it in place of `scope`. (A caller-ID match that identifies an account goes through the verify tool with a knowledge factor, identity.yaml `callerId`, never through this rule.)
- It records itself under its name with lines like `textTo is the caller's number`, `textTo is not the caller's number, but a number the caller confirmed` and `textTo with no caller's number`: never a number, the call's or the caller's. `check` warns of the rule in an app that keeps no caller's number (no `callerNumber` in app.yaml and no slot that offers it), where it refuses every call. The policy matrix of an app whose policy matrix names a `callerNumber` runs every call with that number kept and with none (its `caller` axis), and the invariants hold the rule with the list rules' (`one-of`).

`oneOf` cannot do this: its values are fixed in the policy, not the call's. A rule of your own could, reading `GateFacts.callerNumber`, but this one is common enough to be built in.

### 3.4 Rules of your own: `defineRule`

When no built-in rule says it, an app writes one in TypeScript and names it in the action with `custom: <id>`. A custom rule is written with `defineRule` (from `'dialogwright/policy'`): its id, a plain-English description, a `run` that says whether the call passes and what it compared, and examples of what it allows and refuses. The library fixture's rule holds a hold request to a branch the library has:

```ts
export const knownBranch = defineRule({
  id: 'known-branch',
  description: 'The hold is at one of the library\'s branches',
  run(c) {
    const branch = c.call.params.branch ?? '';
    return Object.hasOwn(BRANCHES, branch) ? { pass: true, compared: `branch ${branch}: known` } : { pass: false, compared: 'branch not known', verdict: 'BLOCK', reason: 'branch' };
  },
  examples: [
    { name: 'a hold at a branch the library has', call: { params: { book: 'river_atlas', branch: 'north' } }, principal: CALLER, expect: { verdict: 'ALLOW' } },
    { name: 'a hold at a branch it does not have', call: { params: { book: 'river_atlas', branch: 'east' } }, principal: CALLER, expect: { verdict: 'BLOCK', reason: 'branch' } },
  ],
});
```

```yaml
  findHold:
    level: 0
    rules:
      - identity
      - custom: known-branch
```

It is registered in the code (`customRules: { 'known-branch': knownBranch }`) and named by the action.

- `run(c)` gets the rule context: the call (`c.call.params`, `c.call.purpose`), the caller (`c.p`), the gate's facts, and the app's lookups (`c.lk`). It answers `{ pass: true, compared }`, or `{ pass: false, compared, verdict, reason }` with the verdict the gate stops at (`BLOCK`, `NEEDS_HUMAN`, or `STEP_UP` with a `needLevel`). `compared` is the line recorded in the console and the audit as it is, so write only what may be recorded: a masked id, never a value the app redacts (3.9 says how masks reach it too). A `run` that throws, or answers something else, blocks the call like any rule would.
- The policy card shows the rule's `description`, so write it in a reviewer's words.
- The examples are required. `check` refuses a custom rule that is a plain function, one whose id is a built-in's (a rule's name, `unlisted`, or one of the old ids `R0` to `R7`), one without a description, and one without at least one example the gate allows and one it refuses. Each example is a call, who makes it (`principal`; `CALLER` here is `{ kind: 'anonymous', level: 0 }`, since the library verifies no one), and the verdict and reason expected. The matrix runner (3.10) runs each through the compiled gate in every action that names the rule, so it must pass the action's other rules too: an example's `facts` default to no failed attempts and the call's values confirmed, and `lookups` sets lookups of its own over the app's. A refusal must come from this rule.
- An App built by hand may still carry a plain function; the gate runs it as before.

### 3.5 Purposes and wording

**Purposes.** A call carries the purpose it is made for (the form's id, or none). `purposes` is the level a purpose needs when it is more than its first action's: reporting a parcel missing may begin with an action at level 1, but the caller should prove the code before the form begins.

```yaml
purposes:
  report_missing: { level: 2 }
```

The level the gate asks of a call is the higher of the action's and the purpose's. A purpose's level must be one the ladder has.

**Wording.** The built-in rules write a description and a `compared` line for every decision, and the defaults are neutral. `wording` puts them in the app's terms: what the scope rule says when a subject or a party acting for subjects asks (by `record` or `param`), what its line calls an owner (`recordOwner`) and a subject, and the role rule's line by what the role gets, a template with `{role}` and `{tool}`.

```yaml
wording:
  scope:
    subject:
      record: The parcel belongs to this customer
      param: The customer is the caller
    delegate:
      record: The parcel belongs to a customer of this depot
  recordOwner: parcel owner
  subject: customer
  role:
    allow: "{role} may use {tool}"
    refuse: "{role} may not use {tool}"
    person: "{tool} by {role} goes to a person"
```

### 3.6 The identity ladder

`identity.yaml` is how a caller proves who they are, and who the app serves. Example Parcels':

```yaml
principals:
  subject: customer
  delegates:
    agent: { roles: [viewer, clerk] }
levels:
  1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
signIn: { level: 2 }
```

- **Principals.** `subject` is the kind of principal the app serves and verifies (a customer, a patient), a lowercase word, since it is also an audit detail key. `delegates` are the kinds of party who act for subjects (a depot agent, a caregiver), each with the roles one may have: the roles the policy's `role` rules and `redact` rows name. Anonymous is the kind nobody is yet. Every party the app's portal lists and every principal it signs in (`code.portal`, `code.principals`) must fit these: a delegate of a declared kind, with a declared role. `defineApp` (through `validateApp`) refuses one that does not.
- **Levels.** The ladder above level 0 (anonymous), cumulative: level 2 is level 1 and its own factors. Each level has a `name`, a label for the console and the policy card (the engine records the numbers everywhere).
  - Level 1's `factors` are slots the code defines, asked for a step-up (each slot id is also the name of the verify tool's param that carries its value). `verify` is the tool that checks them, `failedPrompt` the line said before they are asked again (default `identity_failed`).
  - Level 1's `callerId` (optional) lets a caller-ID match stand in for some of its factors, the identifier, while the rest verify it: [A caller-ID match as the identifier](#a-caller-id-match-as-the-identifier-callerid), below.
  - Level 2 adds the one-time code, `factors: [{ otp: { length: 6 } }]`, keyed on the keypad: `send` is the tool that sends it to the contact on file, `verify` the tool that checks it. The code is no slot: it is masked, never traced and never held on the session. Its `length` is 4 to 8 digits, 6 if left out, and the lines that ask for it say the length in their own words. The one function in this part, the params of the send call, stays in code as `code.identity.sendCodeParams`.
  - Level 2 is optional. A ladder of one rung has no code, and then no action or purpose may need level 2.
  - The identity tools are tools with actions in the policy. Level 1's `verify` lists only `attempts` at level 0, so a caller can try before they are verified; the code's `send` and `verify` need level 1:

    ```yaml
    actions:
      verifyCustomer:
        say: check the account ID and date of birth
        level: 0
        rules: [attempts]
      sendCode:
        say: text a one-time code
        level: 1
        rules:
          - identity
          - scope: { param: accountId }
      verifyCode:
        say: check the one-time code
        level: 1
        rules: [identity, attempts]
    ```

- **The identity tools are for the subject.** The verify tool and the code's two tools prove a subject to themselves: the factors are a subject's, and the code goes to a subject's own phone. The gate refuses them to any party who is not one of the app's subjects (a party who acts for subjects, or any other kind) before their own rules run: BLOCK with reason `not-subject`, recorded as the `subject` line. A caller not yet verified (anonymous) and a subject are held to the actions' rules as written. No file writes this check and none can turn it off. A tool of the app's own that contacts a subject (sends them a link, say) is not an identity tool: if a party who acts for subjects may use it, its policy says so like any other action's.
- **Attempts.** The failed tries allowed at each check, the factors' and the code's, before a person takes the call. It is the one number every `attempts` rule holds an action to.
- **Sign-in.** `signIn: { level }` says a channel that can sign a caller in (a web portal) proves that level, always the top of the ladder, and a signed-in caller starts there; factors are never asked on such a channel. The engine checks the channel's capability, never its name. An app without `signIn` takes no sign-in: it ignores the sign-in event, and on a channel that can sign a caller in, a caller whose request needs identity goes to a person (there is nothing to wait for and no factor to ask).
- **Which token claim names the subject.** A channel that signs in with a token (the engine's web chat, `CHAT_SIGNIN=jwt`) reads the subject's id from the token claim `sub`, or the one `signIn.claim` names; `code.principals.fromClaims` reads the token claims in code for anything one token claim cannot say (a delegate, a tenant). See [13.5](13-channels.md#135-sign-in-on-the-web-chat).
- **Lines.** With an identity.yaml the engine also says the identity lines (`identity_verified`, `handoff_identity`, and with level 2 `ask_otp`, `otp_failed` and others), and `check` requires them in every locale.

#### A caller-ID match as the identifier: `callerId`

A very common phone pattern: the number calling is on file for one account, so the caller is not asked for the account number, only for what verifies it:

> "I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account."

```yaml
levels:
  1:
    name: verified
    factors: [accountId, dob]
    verify: verifyCustomer
    callerId:
      identifies: [accountId]   # filled from the caller-ID match, never asked while it stands
      ask: on-need              # on-need (default) | greeting
```

```ts
facts: {
  fromCallerLookup(f, value) { /* keep the accounts the lookup found */ },
  // The values of the identified factors, or null for no single match (none, or a number two accounts share).
  callerMatch: (f) => (f.phoneAccounts?.length === 1 ? { accountId: f.phoneAccounts[0] } : null),
},
```

- **What it is.** `identifies` names the factors of level 1 the match stands in for (the identifier); the other factors are asked, and they verify it. The verify tool gets the matched identifier and the factor the caller gave, exactly as if the caller had said both: the gate, the attempts rule and the verify tool are unchanged, and a caller-ID verification reaches level 1, as the factors it replaces do. Level 2 still needs the one-time code. Never identity on its own: `pnpm check` refuses `identifies` covering every factor, since the match alone would then verify; an app that really means to take the match alone writes a verify tool that ignores a factor, which is visible in its code.
- **Where the match comes from.** The call-start lookup (app.yaml `callerNumber: { use: hint, lookup }`) finds the account, `facts.fromCallerLookup` keeps it, and `facts.callerMatch(f)` returns the values of the `identifies` factors, or null. Which match counts is the app's call: a shared number returns null and every factor is asked. `pnpm check` refuses `callerId` without the lookup or without `callerMatch`. A hook that throws, or a value that is not a string with something in it, is no match.
- **When it is asked.** `ask: on-need` asks when something first needs level 1 (an entry call's or a check's step-up), in place of the first factor the match leaves to ask. `ask: greeting` asks right after the greeting's line before a proposal (`greeting_offer`), in place of the open question, on a call with a match: a factor given verifies and the open question follows (`greet_after_offer`); "different account" asks every factor at once; a request said instead goes on, and the match is kept for when identity is needed. A call with no match greets as always. With `ask: greeting` and a slot that proposes at the greeting (`offerAt: greeting`) in one app, the caller-ID question wins at the greeting and the proposal is made at its slot instead.
- **"Different account", a no, or a failed check.** A no, "different account" or "that's not me" at the question sets the match aside for the call, and every factor is asked from the first, with `identity_caller_declined` first where prompts.yaml has it ("Okay, let's find your account."). The engine asks the model one yes-or-no question for it (`callerMatchDeclined`) while the match stands and the prompt asked for a factor it leaves to ask (the question itself, and that factor's retry lines), only for an app with `callerId`: every other request is as it was. Beside it the identified factor's own questions are asked, and heard only when the turn turns the match down, so "different account, it's 5550 5678" keeps the number and asks the date of birth. A factor that does not match counts one attempt, as today, empties every factor, sets the match aside and asks the first factor after the `failedPrompt`: the caller may be someone else on a shared phone, and every factor lets them identify their own account. Words that answer nothing walk the asked factor's own ladder; a silence asks the question again.
- **A match that goes away.** A step-up left unfinished (the caller switches to another form, or the form closes) sets a match in use aside as unused, and it is read afresh when identity is next needed; a `callerMatch` that then finds none (the app's facts changed) asks every factor, and every factor listens.
- **An identifier said by the caller is theirs.** An account number the caller says themselves, before the question, is verified as said: the match does not replace it. A knowledge factor said on the way in ("check my request, my birthday is ...") is checked with the match, and nothing is asked.
- **What is never shown.** The engine never says the matched values and never puts them in a prompt variable. They are written into the identified slots just before the check, a value with no display (`SlotState.by: 'caller-id'`), so no line and no model request carries them, and the trace and the console mask the value as the slot's `redact` says, as for one said. They reach the verify tool's params, where policy.yaml's `redact:` and `audit:` apply as to a spoken one.
- **What is recorded.** The principal records `via: 'caller-id'` (the engine sets it; a verify tool that sets it is not believed), so the app's verify tool's audit row can say how (`after.principal.via`). The engine writes an `identity_caller_match` row for each step, `{ outcome: offered | verified | declined | failed }`, where it happened among the turn's gate rows (a no before them, `verified` or `failed` after the check), with the number calling as the lookup's param is recorded (a slot named `callerNumber` by its `redact`, else policy.yaml's `audit: callerNumber`; write `last4`), and by its last four where neither says, never the identifier. A handoff before the caller is verified (attempts already spent, say) leaves the identified factors out of what the person taking the call is handed: they came from the number, not the caller. The session keeps `callerMatch` (`offered`, `declined`, `failed`, `verified`; absent until used); the identifier stays in the app's facts.
- **Lines.** `identity_caller_match`, given no variables, and with `ask: greeting` the greeting's `greeting_offer` and `greet_after_offer`; `identity_caller_declined` is optional. The policy card says the second route to level 1.

Testing it: a scripted call from a number on file (`"callerNumber"`), one not on file, a withheld one and a shared one; a corpus line at the question is in a form's context (or `no_form` with `ask: greeting`), `prompted` the factor it asks for, with `confirm` (`no` for "different account", `unanswered` for the factor or anything else), seeded on a call from `testing.seed.callerNumber`. The engine's fixture is `packages/dialogwright/src/testing/recognized` (its greeting and one-time code variants in `variant.ts`).

### 3.7 How a form reaches an action: `calls`

The action a form's hooks call goes through the gate, but the engine does not read which. Declare it in forms.yaml (`calls`, on each form, section 2) so the policy can be read as a whole: `calls` lists the actions the form's entry, summary and completion hooks make, and `check` reports an action no form reaches (an action the identity flow calls itself, the identity tools, is not counted). The app map (3.11) draws a form to its actions and their rules with it. Declare it for every form or for none (`calls: []` for a form that calls nothing). A form reaches its check actions through `checks`, which `calls` does not list; the app map draws each check beside the slots it reads.

### 3.8 Redaction per principal: `redact`

A party who acts for subjects (a depot agent for its customers, say) may read a record without being shown all of it. The tool returns the whole record, and the policy says what each kind of party, or one of its roles, does not see:

```yaml
actions:
  getParcel:
    say: read a parcel
    level: 2
    rules:
      - identity
      - scope: { record: parcel }
  listParcels:
    say: list the customer's parcels
    level: 2
    rules:
      - identity
      - scope: { param: accountId }

redact:
  agent:
    getParcel: [safePlace]
    listParcels: [safePlace]
  agent.clerk:
    getParcel: []
    listParcels: []
```

```ts
getParcel: { run: (call, sys) => { /* the whole parcel */ }, fields: ['safePlace'] },
```

- A key is a delegate kind from identity.yaml (`agent`), or the kind and one of its roles (`agent.clerk`). A role's list for an action replaces its kind's, so an empty list shows a role what its kind may not see. A role with no row of its own gets the kind's.
- A tool declares the fields of its result the policy may withhold (`fields` on the tool, in code): by name, wherever its result holds them. `redact` may name only those, and only actions the policy lists.
- The engine strips them in one place, right after the tool runs (the lifecycle's `callTool`): each withheld field is set to `null` wherever the result holds it, at any depth (the value when it is an object, each item when it is a list, and every object and list below them; own keys only, a shared object or a cycle copied once). The top object, or each object of a top-level list, always gets the field, as `null`, present or not. `redacted: <fields>` is added to the call's summary (`in_transit; redacted: safePlace`), and every text a withheld field held is masked (`•`) wherever the tool's summary or the record it names repeats it, as a whole token. Nothing else ever sees the whole value: not the form hooks (`onEntry`, `complete`, `callTool`'s `value`, whose `redacted` lists what was withheld), the facts, the lines, the trace, the console or the audit. Still write the tool's own summary without these fields: it is written before the stripping, and a value it reshapes is not recognised.
- What redaction does not reach: what the tool itself does with the whole record while it runs (a side effect it queues goes to its downstream service as queued, though its params as recorded have every withheld text masked; what it writes to the session) and an error it throws. Those are the tool's code, and must keep to what the caller may see.
- A result that cannot be stripped (a tool with fields that returns text, a number, a list of those, or a Map or a Set somewhere inside) is never handed on: the call that ran is still recorded, its summary says the result was not, and the call goes to a person (`NEEDS_HUMAN`, reason `result-unredactable`).
- A subject acting for themselves is never redacted, and neither is an anonymous caller. A party who is neither and whose kind has no row at all (nor its role), in an app with no `redact` section too, has every field each tool declares withheld: the policy said nothing of them, so it fails closed. Give the kind a row (an empty list shows a field) to say otherwise. The gate's decisions do not change; only what the call hands on does.
- `check` refuses a key that is not a delegate kind or one of its roles (the subject kind included), an action the policy does not list, and a field the tool does not declare, each with the closest name. An app built in code (`validateApp`) refuses the same when it is registered.
- The policy card has a section, "What is withheld", with a row per kind or role and action.

### 3.9 What is recorded: `audit`, and the rule names

Every call is recorded: the gate's decision carries a copy of it into the gate event, the trace, the console and the audit. A param named after a slot with a redact setting is masked as the slot says. Every other param is recorded as `audit` declares it, by param name, in every action that sends it:

```yaml
audit:
  recordId: keep
  branch: keep
  pin: secret
```

```ts
getRecord: { params: ['recordId'], run: (call, sys) => { /* ... */ } },
```

| `audit` | Recorded as |
| --- | --- |
| `last4` | its last four characters (`...1234`) |
| `mask` | hidden (`•`) |
| `length` | its length only (`<38 chars>`) |
| `secret` | never: the param is left out of the call as recorded, and is `•` wherever else its value would appear |
| `keep` | as it is |

- Each tool lists the params its calls carry (`params` on the tool, in code; `params: []` for none). The calls are built in code (a form's hooks, the identity flow), so the tool, which reads them, is where they are listed. `check` requires the list of every tool, refuses a listed param that is neither a slot with a redact setting nor declared here (the fix names both ways out), refuses a param a `scope`, `confirmed` or `fields` rule names that the tool does not list, and refuses a declaration of a slot that has a redact setting or of a param no tool lists. A range rule's field and the params its references read are held to the tool's list where no `confirmed` or `fields` rule closes the params. An app built in code (`validateApp`) refuses a listed param that nothing declares when it is registered.
- The same masks reach the free text recorded beside the call: the rules' lines (a custom rule writes its `compared` line as it likes), the tool's summary and the record it names, the params of the side effects it queues as it runs, whatever their names, in the trace and the console (the service is sent them as they are), the tool's own audit rows (`audit` on the tool), and a downstream service's audit row for its answer to one of those effects (`audit` on the service). Where a value is recorded hidden, by length or never, its last four (`...1234`, as the scope rule names a subject) are masked too. Wherever one of them repeats the raw value of a param that is recorded masked or never, the value is replaced by its recorded form, in any case, as a whole token (not inside a longer run of letters or digits). A value of fewer than three characters is not looked for, since it cannot be told from a line's own words and numbers (`level 1`, `a caller`); the call as recorded still masks it. A value a rule or a tool reshapes (a date reformatted, digits spaced out, a part of it quoted) or runs into other letters or digits is not recognised either, so a custom rule still writes only what may be recorded.
- The gate decides on the raw call: what is recorded never changes a decision.
- The gate-event goldens (`gateEventGolden` in `dialogwright/testing`) report any param an app's own calls carry that its tool does not list (`unlistedParams`); an app's golden test expects none.
- `audit` reaches the call alone (the gate's decision, the audit, and the side effects it queues, in the trace and the console). The slot a param is named after is recorded by its own redact setting wherever the call's slots are: the trace's slots, the variables of the lines that say it (a read-back among them), a handoff's data and the console. So a slot with no redact setting whose param `audit` declares `length` is masked in the call but kept whole in all of those; give the slot a redact setting (slots.yaml) to mask it there too. A slot's `mask` keeps the year in it there (`••/••/1985`), where the call has `•`; and a statement by its length (a `text` slot's default) is shown in words on the live console while the call is in progress, and by its stand-in in its lines and a handoff's data.
- The policy card has a section, "What is recorded", with a row per action and value, and, below it, each slot those values come from that is recorded otherwise than its row says (kept whole, kept but for its year, shown in words on the live console).
- For an app that generates lines or prescribes any, the policy card has a section, "Lines a model words": each generated line with its fixed text, its goal, where it is generated, the values it carries word for word and the content it may summarize, and each prescribed line ([16](16-generated-wording.md)). A change to which lines a model words is a diff of the card, which the files' CODEOWNERS review.

**Rule names.** Each rule's line is recorded under the rule's name: `scope fail: record owner ...5678 · caller may see ...1234 only`, `confirmed pass: confirmed hash = call hash`. The names are `identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange` and `limit`; a custom rule is recorded under its own id; an action the policy does not list is recorded as `unlisted`; and an identity tool refused to a party who is not a subject (3.6) is recorded as `subject`. These are in a decision's `rules`, the gate event, the trace, the console and the audit's `rules` lines. An app's code that asks whether a rule passed asks by name, with `passed(decision, 'role')` from `'dialogwright/policy'`, and never reads an id of its own invention.

**Ids changed on 2026-10-03.** Before that, the same lines were recorded as `R1 pass: ...`: R1 is `identity`, R2 `scope`, R3 `confirmed`, R5 `role`, R6 `attempts`, R7 `fields` and R0 `unlisted`. The audit files of the days before keep the old ids and still verify, since the chain hashes what was written and no verdict, reason, level or line of words changed; a query over the audit that spans the date reads both. The old ids stay reserved: an app's own rule may take neither a name above (`unlisted` and `subject` included) nor `R0` to `R7` for its id, and an old `rulesFor` table still lists them (`dialogwright policy:convert` reads them as before).

### 3.10 Testing the policy

Three tests hold the gate to what policy.yaml says, each from `'dialogwright/testing'` and each run over the gate grid: every action crossed with every kind of caller, subject and fact. The grid's people and records come from the app's `testing.policyMatrix()` hook (`code.testing`, never read by a call): a subject at level 1 and at level 2, a party for each role, a role the policy does not name, a party with no role, an unrelated party, and the records each may and may not see.

```ts
import { expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';

describe('the policy against its file', () => {
  it('holds to the policy\'s invariants on the gate grid', () => {
    expect(policyInvariants(app).violations).toEqual([]);
  });
  it('every custom rule does what its examples say', () => {
    expect(runRuleExamples(app)).toEqual([]);
  });
  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/my-app');
  });
});
```

- **Invariants.** `policyInvariants(app)` asserts what must hold whatever order the rules are written in: an action not listed is blocked for everyone; an identity tool is never allowed for a party who is not one of the app's subjects; a caller below an action's level is never allowed; `scope`, `confirmed`, `role`, `fields` and `attempts` each refuse what they exist to refuse; an allowed call ran every rule its action lists, and each passed; raising the caller's level never turns an allow into a refusal; and the scope rule's answer does not move with the conversation. They are derived from the policy as written and the grid's lookups, not from the gate's own lines, so a gate that is wrong in a way its lines agree with is still caught. A failure names the invariant, the grid case and the rule. The report says how many cases each invariant applied to, so a test can also assert that an invariant was exercised.
- **The matrix.** `expectPolicyMatrix(app, file)` compares `policy.matrix`, beside policy.yaml, with what the gate decides today, and fails with a diff. The matrix is written for a reviewer: under each action, a row per kind of caller with the verdict and its reason, split by what the call carries only where the verdict depends on it, then each custom rule's examples:

  ```text
  findHold · level 0 · identity, custom known-branch
    every caller   fields exact|extra, params known    ALLOW
                   fields exact|extra, params unknown  BLOCK branch
                   fields missing                      BLOCK branch
  ```

  A policy change is a diff of this file. Write it deliberately with `pnpm policy:matrix <folder>` (with no folder, every `policy.matrix` in the workspace), read the diff, and commit it; never in CI.
- **Rule examples.** `runRuleExamples(app)` runs every custom rule's examples through the compiled gate, and fails on one the gate decides otherwise, or whose refusal is not the rule's own.

When a rule or the gate itself changes, the same grid is the way to prove nothing else moved: the **shadow gate** (`withShadowGate`, `shadowGate`, `legacyGateEvaluator`) runs a second gate beside the one under test, over the whole grid and inside every replay of a recorded call, and fails on any decision that differs. The engine used it to move every app from the gate's old tables to the files, with the old evaluator frozen as the reference; an app that rewrites a rule of its own can do the same.

### 3.11 Reading the policy: the card and the app map

**The policy card.** `POLICY.md`, beside policy.yaml, is the policy in plain English for someone who will not read YAML: written from the compiled app (the gate's own rules, so it cannot say what the gate does not do). Write it with `pnpm policy:card <folder>` (with no folder, every `POLICY.md` in the workspace) and commit it; GitHub renders it, diagrams included. It has:

- the files' config hashes (policy.yaml and identity.yaml, as every call's audit record carries them);
- the defaults ("anything not listed is refused", identifiers by their last four, what is recorded masked);
- the identity ladder: each level by its name, what the caller gives in the words of the slots' nouns, the tools that check it, the code, the sign-in, with a Mermaid diagram of it;
- who the app serves and who acts for them, with what each role gets;
- what is withheld from them (`redact`), and what is recorded of each value an action is sent (a slot's redact setting, `audit`);
- one row per action, with its label (`say:`, else the tool id), its level by name and each rule in words with its parameters (the scope rule's param as a noun, the confirmed values, the fields sent, a range rule's bounds, a custom rule's `description`);
- a second diagram of the actions grouped by level, with their rules and the roles refused or handed to a person.

Write `say:` for every action, and a `description` for every custom rule, in the words a reviewer would use. A role is shown by its id spelt out (`office_admin` as "office admin"). `expectPolicyCard(app, file)` (from `'dialogwright/testing'`) fails a test on any difference between the page and what the app generates, with a line diff and the command that writes it; put it beside the policy matrix's test. The card is a golden: a policy change is a diff of two files a reviewer reads, and only the command writes it, never CI.

**The app map.** `APP-MAP.md`, beside policy.yaml, draws the app's structure with Mermaid: a table of the intents and what each does; the keypad menu as a tree, with the intents that only say a line joined to their prompt; and, for each form, a diagram from its intent to its slots (each with its type), the summary it reads back, the actions it calls (`calls`) and each action's rules; for an app with routes, each point's rules in the order they are tried, the else last, and the start hook with the actions it calls ([routes.yaml](02-the-files-one-by-one.md#routesyaml-optional)); for an app with transfer targets, where a handoff goes. Write it with `pnpm app:diagram <folder>` and test it with `expectAppMap(app, file)`, as the card.

It is the structure, not a script for a call: the dialog is mixed-initiative, so a caller may give the slots in any order, change their mind or ask for two things in a row. What the map cannot connect is drawn marked and listed under "Dangling references" (`danglingReferences(app)` returns it): an intent with no form, a form no intent starts, an informational intent whose line is not there, a keypad digit to no intent, a form that asks for a slot that does not exist, a call to an action the policy does not list, and an action no form reaches. `check` reports the ones it can from the YAML, with a fix, including the last.

### 3.12 Who reviews it: CODEOWNERS

Policy is a file compliance owns, so a change to it should need their review. GitHub's CODEOWNERS does that: list the files that say what the agent may do, and the people who must approve a change to them (turn on "Require review from Code Owners" in the branch protection rule). For an app's repository:

```text
# .github/CODEOWNERS: a pull request that changes these files needs the owners' approval.
# What the agent may do, and how a caller proves who they are:
policy.yaml        @your-org/compliance
identity.yaml      @your-org/compliance
# What compliance reads, and the golden that shows a change as a diff:
POLICY.md          @your-org/compliance
policy.matrix      @your-org/compliance
# The knowledge base: the answers callers hear, their sources, and the log of approvals.
**/kb/kb.yaml           @your-org/compliance @your-org/content
**/kb/topics.yaml       @your-org/content
**/kb/sources/          @your-org/content
**/kb/passages/         @your-org/compliance @your-org/content
**/kb/locale/           @your-org/compliance @your-org/content
**/kb/approvals.jsonl   @your-org/compliance
```

A bare file name matches in every folder, so each app of a repository is covered. A change to the rules lands as a diff of policy.yaml, of `POLICY.md` and of `policy.matrix` together, in plain words and as the verdicts that follow from it, which a reviewer who does not write code can read and accept or refuse. Owners may be users or teams; an owner needs write access to the repository, or the line is ignored. The knowledge base's lines use `**/kb/...` so they match an app's `kb/` in any folder, and name the files an approval stands on: the passages and their sources, the topics, `kb.yaml`, and `kb/approvals.jsonl`; give them to the people who own the content and, for regulated answers, compliance. Drafts in `kb/pending/` are left open: a draft is never said, and approving it changes `kb/passages/`, which they own. This repository's own file (`.github/CODEOWNERS`) owns the same four names, and the knowledge base's files.

### 3.13 Converting an old file

A policy.yaml or identity.yaml written before this shape (`toolLevel`, `rulesFor`, `subjectKind`, ...) is refused with a message that says how to convert it. `dialogwright policy:convert <folder>` (or `--from-tables <module>` for an app whose tables are TypeScript; `--dry-run` writes nothing) writes the new files from the old, keeping every decision and as many comments as it can, and says which rows it dropped because no rule read them. Before identity.yaml, a caller signed in on any channel that can sign one in (a web chat's portal) was taken at level 2, so where the old identity has a code the converter writes `signIn: { level: 2 }` and the app keeps taking a sign-in. Give `--no-sign-in` for an app no channel signs a caller in to: identity.yaml then has no `signIn`, the app ignores a sign-in, and a chat caller whose request needs identity goes to a person (the factors are never asked on a channel that signs callers in).

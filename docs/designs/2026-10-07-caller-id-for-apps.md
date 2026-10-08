# Caller ID for apps: data dips and the text offer (design)

Date: 2026-10-07. Status: proposal for the maintainer to decide. Engine: DialogWright local `main` (fa7377a). Builds on [the callback number design](2026-10-07-caller-id.md), which landed tonight. No code here.

## At a glance

**The recommendation.** Keep caller ID a hint, never identity, and make every use of it something an app declares.

1. **Data dips.** A new app.yaml block, `callerNumber`, off by default. `use: hint` keeps the caller's number on the session for the app's code, and `called: true` keeps the number called. App code reads them through two accessors, `callerOf(s)` and `calledOf(s)`. An optional `lookup` names a tool the engine calls once at call start, through the gate, with the number as its param. Its result goes into the app's facts. A slot can then propose a value from the facts as a yes or no ("Is this about 22 Alder Street?"), using the same offer machinery the callback number uses. A yes fills a slot. It never changes the principal or the level.
2. **The text offer.** The existing `callerNumber` slot option gains `onNo: ask | skip` and `ifNone: ask | skip`, so an optional "can I text you" slot is left empty on a no. An app hook, `callerOffer(ctx, slot)`, can refuse the offer (for a landline, say), and may call a gated line-type lookup to decide. Every offer writes an `offer` audit row, in the hash chain, with the line as said and the answer. A new built-in policy rule, `callerNumber`, holds a tool's number param to the caller's number, or to a number the caller confirmed.
3. **Identity.** Not built. Section 3 records why it would need its own explicit, weak rung.

**Backwards compatible.** Clinic, utility, the testkit and every fixture are unchanged: no app sets the new block, so no session, start event, trace record, audit row or model request changes. An app that opts in to `use: hint` alone changes no model request. Proposals change the request on the offer turns, as the callback offer does today.

**Decide these (recommended default first):**

1. **Names.** app.yaml `callerNumber: { use: hint, called, lookup }`; accessors `callerOf(s)` and `calledOf(s)`; slot option `offer: facts` with `FactsConfig.offers`; `onNo` and `ifNone`; hook `App.callerOffer`; policy rule `callerNumber`. Alternatives: `callerId` or `ani` for the block.
2. **Where a proposal is made.** At the slot, inside the form (recommended). Alternative: in the greeting, before the caller says why they called.
3. **What a proposal may say before identity.** Only what the lookup action's policy allows at level 0, and the guide says to name as little as works (a street, never a balance or a claim). Alternative: never name a looked-up detail before level 1.
4. **The call-start lookup.** Declared in app.yaml and run before the greeting (recommended). Alternative: no start lookup; app code calls its own tool from a form's `entry` hook.
5. **An unanswered text offer.** With `onNo: skip`, the end of the offer's retry ladder leaves the slot empty, no handoff (recommended). Alternative: the slot's normal ladder.
6. **The consent row.** One `offer` audit row per offer, with the rendered line and the answer (recommended). Alternative: rely on the trace.
7. **The rule's fallback.** `callerNumber: { field, else: refuse }` by default; `else: confirmed` lets a number the caller said and heard read back pass.

## 1. App access for data dips

### 1.1 Today

The adapter puts the number on `SessionStart.callerNumber` only when `usesCallerNumber(app)` (server/adapter.ts), and the `session.start` case of `resolveTurn` (core/turn.ts) keeps it only through `keptCallerNumber`, which needs a slot that can take it. An app with no callback slot never sees it. Nothing promises `s.callerNumber` to app code, and patterns.md says "never compare it with a record in a tool or a rule".

The number called (DNIS) is read only by the webhook, for `voice.numbers` locale routing (`startLocale`, server/http.ts). The setup frame carries it too: Twilio's `to`, Telnyx's `telnyx_call_to`.

Apps load data through a form's `entry` call and `onEntry` hook (core/app/types.ts `FormDef`), tools via `AppContext.callTool`, and `App.facts` (`FactsConfig`). An insurance-style app outside this repository holds coverage and claims in its facts, each written only after a gated call. There is no hook at call start.

### 1.2 Options

- **A. Document `Session.callerNumber` for apps.** Smallest, but nothing declares the use, and a lookup is an ungated side call in app code.
- **B. A declared block, accessors and a gated start lookup (recommended).** The policy owns the lookup and the audit records it.
- **C. Treat a match as a weak identity level.** Out of scope; see section 3.

### 1.3 The design

app.yaml:

```yaml
callerNumber:
  use: hint                   # keep the caller's number for the app's code. Absent: as today.
  called: true                # keep the number called (DNIS) too. Default false.
  lookup: findAccountByPhone  # optional: called once at call start, through the gate
```

- **Keeping.** With `use: hint`, the `session.start` case keeps any number that passes steps 1 and 2 of the usable-number rules (`callerNumberOf`: a number, not a withheld placeholder), whether or not a slot can take it. `called: true` adds `Session.calledNumber`, from a new optional `VoiceProvider.setupCalledOf`. `SessionStart` gains `calledNumber?`. A chat has neither.
- **Reading.** `callerOf(s)` returns `{ number: '+15555550142', last4: '0142' }` or null. `calledOf(s)` returns the called number or null. Both are exported from the core. They return null for an app that did not opt in, so code written against them is safe on a chat.
- **The start lookup.** In the `session.start` case, after the number is kept and before `greeting(s)`, the engine makes one call: `{ tool: 'findAccountByPhone', params: { callerNumber }, purpose: 'caller-lookup' }`, through `callTool` (core/lifecycle.ts), as an anonymous principal. Tools are synchronous (`ToolDef.run`), so the turn needs no new wait. A gate refusal is silent: nothing is said, nothing is kept, the call goes on as without a number. An allowed result goes to a new `FactsConfig.fromCallerLookup(f, value)`, as `onEntry` applies an entry result. The action is in policy.yaml like any other, so its level, rules, `audit:` masking and `redact:` fields are the owner's.
- **Proposing a value.** A slot may set `offer: facts`. A new `FactsConfig.offers(f)` returns a candidate per slot (`SlotCandidate`: value and display). When `continueForm` would ask the slot, `offerCallerNumber` generalises to "make the slot's offer": it says `offer_<slot>` with the slot's display as `{<slot>}`, and sets the same `PendingConfirmation` (`target: 'slot'`, `offered: true`). Yes, no, a correction, silence and the keypad behave exactly as for the callback offer (the table in authoring guide 5, "A callback number"). Once per slot per form, as `callerOffered` does today.
- **Rules.** Section 2.4 adds a built-in `callerNumber` rule. The gate learns the number through a new optional `GateFacts.callerNumber`, set in `gateFacts` (core/lifecycle.ts) only when the session kept one. An app's custom rule reads it there too.

### 1.4 Worked example

The utility app's `report_outage` asks `place` (a `text` slot) and `symptom`. The owner opts in:

```yaml
# app.yaml
callerNumber: { use: hint, lookup: findAccountByPhone }
# policy.yaml
actions:
  findAccountByPhone:
    say: find the service address for the number calling
    level: 0
audit:
  callerNumber: last4
# slots.yaml, on place
  offer: facts
# prompts.yaml
offer_place:
  text: I see an account for the number you're calling from. Is this about {place}?
```

The fictional record: +15555550142 has one account, service address 22 Alder Street. The tool returns only `{ serviceAddress }`, never the account ID, balance or name. `fromCallerLookup` keeps it; `offers` returns it for `place`.

| | Caller | Engine | Agent says |
|---|---|---|---|
| 0 | (call from +15555550142) | lookup allowed; fact kept | "Thanks for calling Example Power & Light. How can I help?" |
| 1 | "My power's out." | `report_outage`; `place` has an offer | "Sure, I can help you report an outage. I see an account for the number you're calling from. Is this about 22 Alder Street?" |
| 2a | "Yes." | `place` = 22 Alder Street, confirmed | "What are you seeing?" |
| 2b | "No, I'm at my mother's, 7 Birch Lane." | correction fills `place` | "What are you seeing?" |
| 2c | "No." | `ask_place`, no attempt counted | "What's the address where the power is out?" |

The summary still reads the address back before `reportOutage` runs.

### 1.5 What it unlocks, and what it does not

- It **proposes**: a value for a slot the caller then accepts or corrects. A yes is a slot confirmation. It is never verification.
- It **does not** change `Session.principal`, the identity level or `identityAttempts`. `findAccount` (level 1) still needs the factors. `check_balance` still asks for the account ID and birth date.
- It **does not** pre-fill an identity factor slot. `pnpm check` refuses `offer: facts` on a factor, as it refuses `callerNumber` today (define/defineApp.ts).
- It **does not** pick the intent. The greeting is unchanged (decision 2). A greeting that names a looked-up detail tells anyone holding, or forging, the number something about the account holder before they say a word.
- What a proposal says is a disclosure at level 0. The lookup's policy entry is where the owner decides it, and the guide says to return the least that works.

### 1.6 Privacy

- **Masking.** The kept numbers are masked as `SessionStart.callerNumber` is today: by `redactDeep` on the console and the frame log, and in the trace by the `last4` rule when no slot masks it (trace/redact.ts). The trace's start record says `callerNumber: kept | none` for any app with the block. The lookup's param is masked by policy.yaml `audit:`; `pnpm check` requires the declaration and warns on `clear`.
- **Audit.** The lookup is a gate row and a `tool_result` row, as any call is. No new row type for it.
- **Minimisation.** One lookup per call, at most. The number goes to the app's tool and nowhere else. It never enters the model's turn state; only an offer line's `{last4}` and display do, as today (core/state.ts). Facts from the lookup are the app's to keep small, and `onFormClosed` may clear them.
- **Retention.** The session store holds the number for the call, as it holds slot values.

## 2. The text offer

### 2.1 A no that means no text

There is no optional slot in the engine today: a form asks every slot until it is filled or the ladder hands off. Two new options on the `callerNumber` slot option:

```yaml
textTo:
  type: digits
  noun: mobile number
  length: 10
  mask: '[2-9]\d{9}'
  callerNumber:
    countryCode: '1'
    onNo: skip      # ask (default): a no asks ask_<slot>. skip: a no leaves the slot empty.
    ifNone: skip    # ask (default): no usable number asks ask_<slot>. skip: the slot is left empty.
```

```yaml
offer_textTo:
  text: Can I text you updates at the number you're calling from, ending in {last4}?
```

A skipped slot is a new slot state, `declined`: empty, but answered, so the form goes on. Completion sees no value and sends nothing. "No, text my cell, 555 555 0199" still fills the slot as said. The end of the offer's retry ladder skips too (decision 5): a text nobody agreed to is not worth a person.

### 2.2 Refusing the offer for a landline

Options:

- **A slot-level `accept(number)` hook.** Slots in YAML cannot carry code, and it would hide a data dip from the gate.
- **The facts from the start lookup.** Works when the lookup returns a line type, but runs a paid lookup on every call.
- **An app hook, `App.callerOffer(ctx: AppContext, slot): boolean` (recommended).** Called only when an offer is about to be made. It may read the facts, or call a gated tool (`lineType`) through `ctx.callTool` and keep the answer in the facts. False means no offer: the slot follows `ifNone`. Absent: every offer is made, as today.

### 2.3 Consent

The yes is in the trace today, as the turn's words and the filled slot. That is not enough on its own: the trace file is a debugging record, and the audit has no row for it.

Recommended: every offer, callback or text or facts, writes one `offer` audit row when it is answered:

```
type: offer
detail: { slot: textTo, source: caller-number, promptId: offer_textTo,
          said: "Can I text you updates at the number you're calling from, ending in 0142?",
          answer: yes | no | other | none, by: speech | keypad, last4: "0142", locale: en-US }
```

`said` is the line as rendered, since the prompt manifest may change later. The row is in the day's hash chain, so `pnpm audit:verify` covers it. The text tool's own row then names the slot it used.

Stated plainly: whether a spoken yes on this line is express consent under the TCPA, or any other law, is the owner's legal question. Rules differ for informational and marketing texts. The engine records what was asked and what was answered. It does not decide that the answer is consent, and the guide must say so.

### 2.4 Sending the text, gated

The text is sent by the app's own tool, from the form's completion, with the slot's value as its param. A new built-in rule holds that param:

```yaml
sendOutageUpdates:
  say: text outage updates
  level: 0
  rules:
    - callerNumber: { field: to, else: refuse }
```

- The param is compared as the slot of the same name holds it (its `callerNumber.take`), so `5555550142` matches `+15555550142`. A field that is no such slot is compared digit for digit, and `check` warns.
- `else: refuse` (default): any other number BLOCKs with `not-caller-number`; no kept number BLOCKs with `no-caller-number`.
- `else: confirmed`: another number passes only when the action's `confirmed` rule also covers the field, so the caller heard it whole at the summary and said yes. `check` requires that.
- The rule's line never shows a number, as the list rules' lines show none (gate/listed.ts).

`oneOf` cannot do this: its values are fixed in the policy, not per call. A custom rule could, reading `GateFacts.callerNumber`, but this is common enough to be built in. A private app's rule is different and stays: its texts go only to the phone on file (`sendCode`, `sendUploadLink` take no number).

## 3. For the record: caller ID as an identity factor (not to build)

Some lines treat "the call comes from the number on the account" as a factor. It is weak. Caller ID is set by the calling side; STIR/SHAKEN attestation reaches the engine unevenly, and even full attestation vouches for the number, not the person holding the phone. Household lines and lent phones add more doubt. At most it could replace one of two factors for a low-risk read: never alone, never level 2.

If built, it must be explicit: `use: factor`, its own rung in identity.yaml, the attestation required and recorded, every match and miss audited, and `pnpm check` refusing it above a level the owner names. Until then the number stays refused on a factor slot.

## 4. Backwards compatibility

- No app sets the block, so `keptCallerNumber` behaves as today, `GateFacts` gains no field, and gate-event goldens are unchanged.
- `onNo` and `ifNone` default to `ask`: the callback offer is unchanged.
- `offer` rows are written only for apps with an offer slot, which today is none of clinic or utility. An app that already uses `callerNumber` gains the row; its audit goldens change on purpose.
- Changed on purpose: `schemas/app.schema.json`, `slots.schema.json`, `policy.schema.json` and their snapshots. An app outside this repository takes the engine with a version bump and no other change.
- The text harness: a scenario gains `calledNumber` beside `callerNumber`; the CLI gains `--called-number`. Replay's stand-in number (`standInCallerNumber`) needs a lookup fixture keyed by the last four.

## 5. Validation (`pnpm check`)

- `callerNumber.use` is `hint`; `lookup` names a tool in policy.yaml whose params are exactly `[callerNumber]`; `audit:` declares `callerNumber`, with a warning for `clear`.
- `offer: facts` needs `FactsConfig.offers` and `offer_<slot>` with `{<slot>}` in every locale; refused on a factor slot; refused beside `callerNumber` on one slot.
- `onNo: skip` and `ifNone: skip` only under `callerNumber`. A skippable slot may not be named in a summary line as `{<slot>}`, since it may be empty.
- `callerNumber` rule: `field` is a param the tool lists; `else: confirmed` requires the field in the action's `confirmed` list; a warning when the app keeps no number (no block, no offer slot), since the rule would always refuse.
- A warning when a lookup action is above level 0: it can never run at call start.

## 6. Docs and the create-app skill

- **Authoring guide.** app.yaml gains the block; 5 gains `onNo`, `ifNone`, the consent paragraph and "Proposing a value from a lookup"; the policy section gains the rule; 13.13 gains the called number per carrier.
- **patterns.md.** "A text offer" beside "A callback number". "Never compare it with a record" becomes "never to verify; a gated lookup may propose".
- **worksheet.md.** "Look the caller up by number? What may the line say before they verify?" and "Offer to text them?"
- **corpus.md.** At each offer: yes, no, another value, "that's my landline", silence. **live-checks.md:** the called number on Telnyx.

## 7. Tests

- Unit: `setupCalledOf` per carrier; the accessors with and without the block; the rule for match, mismatch, no number, `else: confirmed` and international form.
- Turn: the start lookup allowed, refused and absent; each row of 1.4; `onNo: skip` and `ifNone: skip`; `callerOffer` false; principal and level unchanged after a yes.
- Audit and redaction: one `offer` row per answered offer, chain verified; the numbers masked on the console, frame log and trace.
- Scenarios: a fixture app with the block, a lookup, a facts offer and a text slot, for a caller with an account, one without, a chat and a withheld number. Clinic, utility and the testkit replay with no cassette misses.

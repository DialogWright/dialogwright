# 2. The files, one by one

[Contents](README.md) · Previous: [1. The folder](01-the-folder.md) · Next: [3. Policy and identity](03-policy-and-identity.md)

Each file below shows a short real example and says what the file is for. The complete field list of each file is its JSON Schema in `packages/dialogwright/schemas/`, and every field has a description there.

### app.yaml

Who the app is, and how it presents itself. Only `id` is required. From the library:

```yaml
id: library
locale: en-US

brand:
  name: Example Town Library
  mark: TL

console:
  formLabels:
    renew_loan: Renew a book
    check_hold: Check a hold
  slotLabels:
    book: Book
    branch: Branch

voice:
  hints: [renew, hold, branch, Riverside]
  spokenDigits:
    - pattern: '(card )(\d{4,})'
      spell: lead

wording:
  addressee: the library line

carrySlots: [branch]

prompts:
  spokenVars: [due]
```

- `id` names the app in the registry. `locale` is the language of `prompts.yaml` (default `en-US`).
- `brand` and `console` are what the operator console shows: the app's name, form and slot labels, the badge for each identity level, and the facts a tool call leaves.
- `voice` holds the phone line's speech settings: words the recognizer should expect, and how digits that are identifiers are spelled for text to speech. An app can also say, per locale, which voice and recognizer each carrier uses and which hints it hears, and which number a call starts in which locale (`voice.locales`, `voice.numbers`): see [13.3](13-channels.md#133-languages-on-the-phone). How long an interrupt may come after the agent starts a reply and still be the caller who had not finished (`voice.continueWithinMs`, default 300), and the words the voice says wrong with the respelling it is sent (`voice.pronounce`): see [13.8](13-channels.md#138-a-caller-who-had-not-finished-and-how-a-word-is-said).
- `wording` is the engine's own questions to the decision model, in the app's words (whom the caller is addressing, what counts as a hedge). Every string is sent to the model as written.
- `handoff` is the handoff: the note's words about the app's domain (who it is for, the identity line by level, refusals and reasons in words), and `data`, what a transfer hands the channel of the slots the call collected. On a phone call that is the relay's `end` frame, which the carrier (Twilio, Telnyx) holds and posts back on its action callback, so it leaves the engine; a chat's transfer sends its reason only, never a collected value (unless app.yaml's `transfer.send.chat` names one, [13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)). The default keeps verification factors off the carrier: an identity factor slot (identity.yaml) is left out, a slot with a `redact` setting goes masked as the trace masks it (`...1234`, `••/••/1980`, a statement's stand-in), and any other slot goes as it is. `data.slots` says which go (`all`, the default; `none`; or a list), and `data.send` says, by slot, how one goes in place of its default: `omit`, `masked` or `as-is`. An app whose human desk needs a value in the clear names it:

  ```yaml
  handoff:
    data:
      slots: [accountId, missingNote]   # only these go
      send:
        accountId: masked               # a factor, sent by its last four rather than left out
  ```

  `pnpm check` refuses a slot that is not one, a slot listed twice, a listed identity factor with no `send` (it would still be left out), a `send` for a slot that is never sent, and `masked` for a slot with no `redact` (or `handoff: last4` or `verified`), which would send it as it is; `validateApp` refuses the same for an app built in code.

  `data.unconfirmed` says what goes of a value the caller never confirmed. A filled slot is confirmed when its own flag is set (a yes to its `confirm_<slot>` read-back, a keyed value, a fill the slot takes with no read-back), or when it holds the value the caller said yes to at a summary: when the caller says yes to a summary, spoken or keyed, and the yes changes nothing it read (or a form with a summary completes on the caller's yes), each of the form's filled slots' values is kept as agreed (on the session, as `agreed`, only for an app that sets `mark` or `omit`), so a carried name counts as confirmed in a later form, a completion that hands the call to a person right after the yes names none of them, and a value corrected after the yes does not. Anything else is unconfirmed: every value of a form whose read-back the caller interrupted, a value changed since the yes. An identity factor, and a slot handed over only as `verified`, is never counted: the note's Identity line says what was proven. `send`, the default, sends them as any other value, as before the option. `mark` sends them and names them: the `end` frame gains `unconfirmed`, the ids of the slots it sends that the caller never confirmed, beside `slots`; the console's handoff card prints each as `howUrgent: right away (not confirmed)`; and the audit's `handoff` row lists their ids (never their values), which the handoff note's facts carry, so its Next line can say what to check. `omit` leaves them out of the data; the console and the audit still name them. `pnpm check` refuses any other value, and warns of `mark` or `omit` with `slots: none`, which sends nothing to mark. A chat's transfer sends no slot whatever this says, unless `transfer.send.chat` names one. Where the call goes, and the SIP headers and chat data sent with it, are app.yaml's `transfer` ([13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)): a header or a chat value naming a slot sends it as `data` does.

  ```yaml
  handoff:
    data:
      unconfirmed: mark   # the office sees which values to check with the caller
  ```
- `thresholds` adds the app's own named thresholds (the clinic has `TIME_OF_DAY`), which a slot's options or a priority intent (`priority: { threshold: NAME }`) may name. `carrySlots` names slots that outlast the form that filled them (the clinic carries the caller's name and date of birth, so a second task does not ask again). It is shorthand for `listen: call` on each slot it names ([Where a slot listens](05-writing-a-slot.md#where-a-slot-listens-listen)); a carried slot that says another `listen` is refused.
- `unsureIntent` says what an intent the model is unsure of gets, for every intent that does not say: `confirm` (the default) or `no-match` ([When the model is unsure](#when-the-model-is-unsure-unsure), under intents.yaml).
- `changeSlotWithValue` says what the change question does at a form's summary when the same turn also gives one of the form's slots a new value. The change question (`wording.changeSlot`) asks which detail the caller names as wrong without saying its new value, and a reading at `SLOT_CHANGE` (0.6) or more reopens that detail and asks for it again. A turn that gives a slot a value it does not already hold contradicts that reading: in "not Chen, Cheng" the model can take the doctor's surname for the caller's name. `set-aside`, the default, lets such a reading decide nothing, so the turn goes as it would without it: a no with a correction, the value applied and the summary read again (the debug table's changeSlot row says `value_given:<slot>`, naming the detail the reading named). A value said again unchanged ("no, it's Patel" with Patel held) is not new, so "the doctor, it's Patel" still reopens the doctor. What the default gives up: a caller who does name one detail and give another its value in one breath ("the doctor's wrong, and make it Thursday") has the value applied and hears the summary again, where they name the doctor once more; where the naming was misread (as the clinic's recordings showed for "not Chen, Cheng"), letting it decide would instead clear a detail that was right and ask for it. `decides` lets the reading decide as it would alone: the detail named is reopened unless the same turn gives it its new value, and a value given for another slot is filled on the way.

  ```yaml
  changeSlotWithValue: decides   # "the description, and make it Sunday" asks for the description again
  ```
- `anythingElseSilence` says what a caller who says nothing after "Is there anything else I can help with?" (the `anything_else` line, said when a form is done and the call goes on) hears when the no-input wait runs out. `repeat`, the default: "I didn't hear anything." (`no_input`) and "anything else?" again, the question they were asked. `opener`: `no_input` and the opening question (`ask_intent`), as the engine did before this option. `goodbye`: `no_input` and the goodbye, ending the call as the `done` intent does, for an app that takes a caller with nothing more to say as one who has finished. With `repeat` and `opener`, a further silence walks the intent ladder as it does at the opening (the keypad menu, then a person). Only the first silence after the line changes; silence after the opening question is never affected. Every line it uses is one each app already has, so `pnpm check` asks for nothing more, and refuses a value it does not know.

  ```yaml
  anythingElseSilence: goodbye   # nothing said after "anything else?" ends the call
  ```
- `fixtures: { dir: fixtures }` says where the corpus and the scripted calls are. The folder is relative to the app's package root, which is the folder its commands run in: the engine reads it from the working directory, and an app's `regress`, `cli` and `serve` scripts run in its package. It must stay inside the package, so an absolute path or one with `..` is refused. `check` then requires every intent to have examples there.
- `testing: { adversarial: on }` runs the adversarial suite with the regression: cases the engine generates from the app (injections, relationships claimed and not proven, off-scope requests, codes said aloud or never sent, hostile replies from every tool), each held to properties over its run, never to lines ([section 15](15-the-adversarial-suite.md#15-the-adversarial-suite)). Default `off`; an app from `create-app` has it on.
- `prompts` holds what is said about prompts besides their text: which opening lines to use, which variables are always spoken by text to speech, the clips' vocabulary.
- `callerNumber` keeps the number the caller is calling from for the app's own code, and may look the caller up by it once at call start: [The number the caller is calling from](#the-number-the-caller-is-calling-from-callernumber), below.
- `textConsent: { covers: [textTo, ...] }` asks once, right after the greeting, for consent to text the caller during the call, and the text offers it covers then use the caller's number without asking again: [Consent to text for the whole call](05-writing-a-slot.md#consent-to-text-for-the-whole-call-textconsent).
- `callData` names the data a call or chat comes with that the app's code may read (a carrier's custom parameter, a field of the setup or of the answer webhook, the web chat page's context), each key with where it comes from and how it is recorded; `startParameters` names the custom parameters the server writes into every start document, each read from an environment variable: [13.14](13-channels.md#1314-the-data-a-call-or-chat-comes-with-calldata).
- `transfer` names where a handoff goes and what goes with it: ordered targets on the handoff's reason, the form, the call data and the other conditions routes use (the hours among them), each an environment variable holding an E.164 number or a `sip:` URI, a `default`, and the SIP headers (and a web chat's data) sent: [13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer). Without it, every handoff dials `HANDOFF_NUMBER`, as before.
- `hours` says when the line is open, in its own time zone, with holidays and schedules by name, for the `hours` condition of a route or a transfer target: [Business hours](#business-hours-hours), below.
- `onStart: { calls: [...] }` says the code has a start hook (`code.onStart`), which runs once as every call starts, and names the actions it calls, as a form's `calls` does: [The start hook, predicates and `failSoft`](06-the-form-hooks.md#the-start-hook-predicates-and-failsoft). Written exactly when the code has one: `pnpm check` refuses either without the other.

#### The number the caller is calling from: `callerNumber`

On a phone call the carrier sends the number the caller is calling from, and often the number they called. An app may use them, as a hint: to look something up by, to propose a value from, to offer to text the caller. Never as identity on its own: a caller ID is set by the calling side and can be forged, so it proves no one by itself. An app may let a caller-ID match identify an account, with a knowledge factor that verifies it (identity.yaml `callerId`: [A caller-ID match as the identifier](03-policy-and-identity.md#a-caller-id-match-as-the-identifier-callerid)). An app says what it uses in app.yaml, off by default:

```yaml
callerNumber:
  use: hint                   # keep the caller's number for the app's code
  called: true                # keep the number called (the DNIS) too; default false
  lookup: findAccountByPhone  # optional: called once at call start, through the gate
```

- **Keeping.** With `use: hint` the session keeps any usable number the call came with ([13.13](13-channels.md#1313-the-number-the-caller-is-calling-from) says what counts: digits as a carrier writes them, and not a withheld placeholder), whether or not a slot offers it. `called: true` keeps the number called as well. A chat has neither. Without the block, the number is kept only for a slot that offers it ([A callback number](05-writing-a-slot.md#a-callback-number-callernumber)), as before.
- **Reading.** App code reads them with `callerOf(s)`, `{ number: '+15555550142', last4: '0142' }` or null, and `calledOf(s)`, the number called or null, both from `'dialogwright'`. Each is null on a chat, on a call with no number, and for an app that did not opt in, so code written against them is safe anywhere.
- **The call-start lookup.** `lookup` names a tool the engine calls once, right after the call starts and before the greeting: `{ tool, params: { callerNumber }, purpose: 'caller-lookup' }`, through the gate as the caller not yet proven, like any other call. The tool lists exactly one param, `callerNumber` (`pnpm check` refuses any other), and has an action in policy.yaml whose level, rules and `audit:` masking are the owner's; give it level 0, since it runs before anyone is verified (`check` warns otherwise: it would always be refused), and `audit: callerNumber: last4` (`check` warns on `keep`). Hold its param to the number calling with the `callerNumber` rule ([3.3](03-policy-and-identity.md#33-the-built-in-rules)) so the tool can only ever look up the caller's own. A refusal is silent: nothing is said, nothing is kept, and the call goes on as one without a number. So is a failure: a tool that throws is recorded as failed (its error is not), and a `fromCallerLookup` that throws leaves the facts as they were. Tools run synchronously, so the greeting waits on nothing but the tool's own run: answer from the app's systems as they are, never from a slow service. An allowed result goes to the app's facts through `FactsConfig.fromCallerLookup(f, value)`, as a form's `onEntry` applies its entry's result. The lookup is a gate event and a tool result in the trace, the console and the audit, its param masked as policy.yaml says.
- **What the lookup may return.** Whatever it returns may end up said to a caller who has proven nothing: anyone holding, or forging, the number. What it returns, and what the app's lines say of it, is the app's call; the framework filters nothing. The usual advice is the least that works (a line type, a street to propose) rather than a balance, a claim or a name. The tool decides that, not the policy: policy.yaml's `redact:` withholds fields only from a party acting for subjects, never from the anonymous caller the lookup is made as, so the tool's result reaches the app whole, and the action's policy decides whether it runs at all. A match is never verification on its own: the principal, the identity level and the identity attempts do not change, and an identity factor slot never takes the number. What it may do, where identity.yaml says so, is stand in for the identifier a knowledge factor then verifies ([A caller-ID match as the identifier](03-policy-and-identity.md#a-caller-id-match-as-the-identifier-callerid)).
- **Rules.** The gate learns the number through `GateFacts.callerNumber` (and `callerNumberAs`, the number as each slot that offers it holds it), set only for a session that kept one. The built-in `callerNumber` rule reads it; a rule of your own may too.
- **Privacy.** The numbers are masked as a start event's number is: by their last four on the console and in the frame log, and in the trace file by the slot that offers the number where there is one, else by their last four, the setup's own copies in the start event's provider details (Twilio's `from` and `to`, Telnyx's `param.telnyx_call_from` and `param.telnyx_call_to`) with them. The trace's start record says `callerNumber: kept` or `none`. The number goes to the app's tool and nowhere else; it never enters the model's turn state, and a call with a number sends the model exactly what a call with none sends, but where an offer line says its last four.

Testing it: a scripted call takes `"callerNumber"` and `"calledNumber"`; the text CLI takes `--caller-number` and `--called-number`. Replaying a logged call stands a made-up number in for the caller's, ending in the last four the frame log kept, in the international form carriers send (`+1555555` and the four), so key a lookup fixture by the last four. The frame log does not keep the number called, so a replayed call has none: `calledOf(s)` is null there. The engine's own fixture is `packages/dialogwright/src/testing/texting`: a call-start lookup of the line type, a text offer, and the rule on both. A slot that proposes what the lookup found is [Proposing a value from a lookup](05-writing-a-slot.md#proposing-a-value-from-a-lookup-offer-facts); its fixture is `packages/dialogwright/src/testing/proposals`.

#### Business hours: `hours`

When the line is open, read by the `hours` condition of a route ([routes.yaml](#routesyaml-optional)) or a transfer target ([13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)). From the routed fixture (`packages/dialogwright/src/testing/routed`):

```yaml
# app.yaml
hours:
  timezone: America/New_York
  weekly:
    mon-fri: ["08:00-18:00"]
    sat: ["09:00-13:00"]
  closed: [2026-12-25, 2027-01-01]
  schedules:
    billing:
      weekly: { mon-fri: ["09:00-17:00"] }
```

- `timezone` is an IANA name; daylight saving is the zone's. The time is the platform's own (`Intl.DateTimeFormat`), with no dependency added.
- `weekly` maps a day (`mon` ... `sun`) or a range of two (`mon-fri`; `fri-mon` goes round the week) to a list of `HH:MM-HH:MM` ranges in 24-hour time. A range whose end is before its start runs overnight into the next day (`22:00-06:00`); `24:00` ends a range at midnight. Two keys that name the same day both apply. A day no key names is closed, so `weekly: {}` is never open.
- `closed` lists dates (`YYYY-MM-DD`) closed all day. A date closes the hours that start on it: a range that starts the day before and runs overnight runs to its end.
- `schedules` names schedules of their own (a department's), read by `{ hours: open, schedule: billing }`. A named schedule takes the default's `timezone` and `closed` unless it writes its own (write `closed: []` for none).
- The hours are judged at the turn's clock, never the machine's: a scripted call sets it with `"now": "2026-10-12T19:00:00-04:00"`, a seeded corpus call with `testing.seed.now`, and a replay runs at the moment the call was taken.
- `pnpm check` refuses a time zone the platform does not know, a day or a range that is not one, and a date that is not a calendar date; `validateApp` refuses the same for an app built in code. When the line is open is the app's.

### intents.yaml

What a caller can ask for, in the order the decision model is offered them, and the keypad menu.

```yaml
intents:
  renew_loan:
    criteria: Wants to renew a book they have borrowed, so it is due back later
    label: renew a book
    kind: form
  hours:
    criteria: Asks when the library is open
    label: hear the opening hours
    kind: informational
    promptId: hours
  agent:
    criteria: Asks to speak with a person, a librarian, or the front desk
    label: speak with someone
    kind: control
  repeat_prompt:
    criteria: Asks the system to repeat what it just said
    label: hear that again
    kind: control

menu:
  - digit: "1"
    intent: renew_loan
  - digit: "0"
    intent: agent
```

- `criteria` is sent to the decision model as written, so changing it changes what the model sees (a recorded cassette then misses). `label` is how the line says the intent ("Sure, I can help you renew a book").
- `kind: form` starts the form with the same id in forms.yaml. `kind: informational` plays its `promptId` and goes back to where the caller was; its key on the menu does the same, then gives the menu back. `kind: control` is the engine's own.
- How sure the model must be. Outside a form, a form intent read at `INTENT_IMPLICIT` (0.6) or more starts its form, and one read from `INTENT_EXPLICIT` (0.4) up to that is confirmed first with `confirm_intent_explicit` ("Just to check, do you want to {intentLabel}?"); below that the caller hears `nomatch_open`. An informational intent has the same band: said at 0.6 or more, confirmed from 0.4, and said on the yes, so a caller the model half understood is asked rather than told the words were not understood. A form close behind either (within `GATE_INTENT_MARGIN`) is asked about as a choice between the two (`disambiguate_intent`). Inside a form, an informational intent is said at `INTENT_SWITCH` (0.85) and has no band: a confirmation there would stand in for the question the form is asking.
- When the model is unsure, see the next subsection: an app or an intent can say that such a reading is no match rather than confirmed.
- Something that must never wait or be missed (an emergency, a safety report) is marked `priority: true`: read at `PRIORITY_INTENT` (0.8) or more it is acted on this turn, mid-form included; `priority: { correctsForm: true }` also corrects what the call holds from the same words before the handoff ([Must never wait: `priority`](#must-never-wait-priority)).
- Two control intents are required, because the engine reads them by name: `agent` and `repeat_prompt`. The snippet above shows both. The other control intents (`done`, `other`, `none`) are optional to the engine; the library has all three.
- `done` is how a caller who is finished is understood: outside a form, "no, that's all" ends the call with the goodbye (`goodbye`, or `goodbye_chat` in a chat). Every app has the `anything_else` line, which the engine says when a form is done and the call goes on, so `pnpm check` refuses an app with that line and no `done` intent: without it, "no, that's all" is no intent the app knows, and the caller hears the no-match line, then the keypad menu or a person, instead of the goodbye. The fix it prints is the intent to paste. Give it corpus lines at the `anything_else` context (`testing.seed.anythingElse`) in the words callers use ("no, that's all", "I'm all set", "I don't need anything else").
- Keypad digits are quoted strings.
- An informational intent may switch the call's language: `locale:` names one of the app's locales, with a `promptId` said in it, or alone (never with a `passage`). No intent switches unless the app writes one; [13.3](13-channels.md#133-languages-on-the-phone) has the example and what a switch does on a call and in a chat.
- A key on the menu starts a form, plays an informational intent's line, or (`agent`) goes to a person. A key for any other control intent does nothing on a call (the caller hears nothing), so `pnpm check` refuses one.
- The menu listens only once it has been offered, by default. On a call with a keypad (a phone call; a chat has none), the second missed answer to the intent question (words it did not understand, or a silence) offers it with `nomatch_dtmf_menu`, and the keys of the next turn are menu keys; with `MAX_ATTEMPTS` at its default of 3, a third miss goes to a person. A key pressed before then, at the greeting for example, is ignored. After an informational key the menu is offered again, so it keeps listening. A scripted call that presses a menu key therefore misses twice first.
- A key the greeting names listens from the greeting: give its entry `fromGreeting: true`, or write `menuListens: greeting` at the top of intents.yaml for every key (an entry's own `fromGreeting: false` then keeps that one key for the offered menu). Such a key is taken wherever the caller is asked what they want: the greeting's open question, its re-asks, and "anything else?" (the open question: no form open, nothing pending to confirm, no identity under way at the greeting). It does what it does on the offered menu: a form intent starts its form ("Sure, I can help you renew a book." and its first question), `agent` goes to a person, and an informational intent says its line and asks the open question again (`ask_intent`), in the new language for one with `locale:`. Nothing is counted against the caller. A language key pressed again with nothing between, to the language the call is in now (a caller pressing twice over a line they could not cut short), is ignored, so the switch's line is not said twice; any other key pressed again is a choice, and so is the language key after any words or silence. Any other key there is still ignored, and so is every key inside a form, where its own keypad answers, and at a confirmation. A call that opens with an offer in place of the greeting (the caller-ID question, the consent to text, a proposal at the greeting) takes no menu key until the offer is answered: a key pressed there answers the offer, or is keyed into the identity question, and the key is live from the open question that follows. With `menuListens: greeting`, "anything else?" takes every key: a caller who keyed a number for the form's last question and keys on past it, after the form is done, has those keys read as menu keys, so prefer `fromGreeting: true` on the keys the greeting names. Keys only: a menu number said aloud is heard on the offered menu alone, so the model is asked what it was before. `menuListens: offered` is the default and says so; `pnpm check` refuses `menuListens: greeting` with no keys, and warns when a line said at the open question (the greeting, `greet_after_offer`, `ask_intent`, `nomatch_open`, `anything_else`, in any locale) asks the caller to press a key ("press 9", "oprima el número 9", "presione la tecla 9") whose entry does not listen from the greeting, when the opening offer's line (`greeting_offer`) names any key, and of a `*` or `#` on the menu, which a phone call never passes on. The turn's trace record says the key was taken (`menuKey`: the key and the intent), and the console's call page notes it on the turn's header.

  ```yaml
  menu:
    - digit: "9"
      intent: spanish
      fromGreeting: true   # "para español, oprima 9" in the greeting
    - digit: "1"
      intent: renew_loan   # offered after the second missed answer, as before
  ```

#### When the model is unsure: `unsure`

The band above, a reading from `INTENT_EXPLICIT` (0.4) up to `INTENT_IMPLICIT` (0.6) outside a form, is an option. `confirm`, the default, asks the caller ("Just to check, do you want to {intentLabel}?"); a yes starts the form or says the answer, and a no is the intent question again, counted. `no-match` takes such a reading as no match: the caller hears `nomatch_open` and the attempt is counted, as for a reading below 0.4 (the debug table's intent row says `unsure_no_match`). app.yaml's `unsureIntent` sets it for every intent, and an intent's own `unsure:` overrides it, in either direction:

```yaml
# app.yaml: no intent the model is unsure of is confirmed...
unsureIntent: no-match

# intents.yaml: ...but this one is
intents:
  renew_loan:
    criteria: Wants to renew a book they have borrowed, so it is due back later
    label: renew a book
    kind: form
    unsure: confirm
```

It applies alike to a form intent, an informational one and `done`; `check` refuses it on another control intent, which is never confirmed. It changes nothing else: a reading of 0.6 or more acts as before, a hedged request read at 0.6 or more ("I think I might want to ...") is still confirmed, since the doubt is the caller's and not the model's, a switch away from the form in hand is still confirmed in its own band, since it would drop what the caller has given, and inside a form an informational intent still needs `INTENT_SWITCH`. Keep `confirm` where a caller half understood is better asked one yes-or-no question than told the words were not understood. Choose `no-match` where a wrong guess costs more than a second try: intents that sound alike, so that "did you want X?" would often be wrong, or a request that should start only when the caller is understood plainly. The setting is the app's, and changes no question the model is sent.

#### Must never wait: `priority`

Inside a form, a request for another form starts it only when the model reads the turn as replacing the task in hand (the `intentChange` question at `INTENT_CHANGE`, 0.6) and the intent at `INTENT_SWITCH` (0.85); a turn read as answering the question goes to the form, whatever intent it names. A form that answers from the knowledge base is the exception: asked for as a replacing or an added request, it is an aside, and the task resumes after the answer ([12.5](12-the-knowledge-base.md#125-answers-through-the-gate), `midTask`). And a turn the model reads as not addressed to the line (`addressedToSystem` under `GATE_ADDRESSED`, 0.65) is ignored. Both are right for most requests and wrong for one that must never wait: "actually, water is pouring in right now", said at "Do you own the home?", reads as an answer, and "hold on, the wall just started giving way" reads as said half aside. Mark such an intent `priority`:

```yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: true      # acted on at PRIORITY_INTENT (0.8) or more, whatever else the turn was
```

Read at `PRIORITY_INTENT` or more, the intent is acted on this turn: its form starts (with its acknowledgement, never a "just to check" confirmation, even for a hedge), or an informational one is said. What it takes the turn from:

- The question in hand: an answer, an added task, a switch the model was unsure of. The form in hand is left as a switch leaves it: not queued, its values still on the session (a slot the priority form shares is not asked again), and what this turn said fills the priority form's own slots.
- A pending confirmation: the summary (the form read back is not filed), an intent or slot read-back, the transfer offer.
- A spoken menu number, while the keypad menu listens. A key pressed is a key, and does what it does.
- Side speech (`addressedToSystem`) and words read as unintelligible (`intelligible`): a caller in trouble is not talking to the line alone, and a re-ask costs the turn that matters. A false reading costs a caller put through to a form or a person they did not need.

What it never takes the turn from:

- The injection screen, which runs before the gates and discards the turn's answers when it fires.
- A handoff to a person (`wantsHuman`, the third frustrated turn, the `agent` intent): the caller reaches someone at once either way.
- A partial still being said (`utteranceComplete` holding a transcript that is not final): the words are read again when they are.
- The policy gate: what the priority form may do is decided as for any other form. Inside the priority form itself nothing changes.

The trace and the console show it as a gate row of its own, `priorityIntent`, read only in an app that marks an intent priority (any other app's rows are unchanged): `act:<intent>:over:<gate>` when it took the turn (it is the row that decided, and `<gate>` is the row that would have, which keeps its own outcome), `agrees` when the turn already did what it would, `stands:<gate>` for a handoff or a hold it leaves, `in_form` inside its own form, `below` under the threshold, `none` when no priority intent was read. `priority: { threshold: NAME }` reads another threshold in place of `PRIORITY_INTENT`: one of the engine's, or one under `thresholds:` in app.yaml (`check` refuses a name neither defines), so an app sets its own:

```yaml
# app.yaml
thresholds:
  URGENT_SURE: 0.75
```

```yaml
# intents.yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: { threshold: URGENT_SURE }
```

What the handoff carries after a priority switch is every filled slot of the call, the form left included: the form is left, not closed, so the name, the number and the address the caller gave are still there for the person who takes the call. By default those are the values as they were before the switch, so one the caller's own switching words contradict goes to the office stale: a caller who said the problem was getting worse, then at the read-back says "wait, water is coming through the wall right now", is handed over with "getting worse". `correctsForm` fixes that:

```yaml
intents:
  urgent_repair:
    criteria: Water is pouring in right now, or a wall looks like it is giving way right now
    label: reach the office right away
    kind: form
    priority: { correctsForm: true }    # threshold: PRIORITY_INTENT, as with `true`
```

Before the priority form is entered, the switching turn's answers fill the slots it was asked about, as a correction: the open form's slots, or, with no form open ("anything else?"), the call's own (the carried slots, a slot that listens anywhere, the identity factors where the turn listens for them). A new value replaces an old one; a value said again unchanged is no change. It is an ordinary fill, not a summary's correction, since nothing is read back on the way out: a part of a date never empties a slot that holds a whole one, and a text slot keeps what is on file unless it was the slot just asked (its `keep`), so the urgency changes and the problem the caller described does not. A switch the engine asks about first (`confirm_intent_explicit`, for an intent read below its priority threshold) corrects the same way on the caller's yes, from the words it asked about; a no changes nothing. The turn was planned with that form open, so the model was already asked about those slots: no question it is sent changes. What the correction would say is dropped (an acknowledgement of the corrected value before the handoff line is noise, and a choice between two values has no question to be asked on the way out), and its fill shows on the debug table's slot rows. The form left is still neither closed nor completed, nothing in it is confirmed by this, and its checks do not run: a corrected value a check would refuse ("and I rent it") still goes to the office, since the priority switch wins. Only a switch to a priority intent corrects; a replacing switch to an ordinary form does not, since its words may not be about the form left. `check` warns of `correctsForm` on an informational intent, which opens no form (the turn already fills the form in hand as it is said). Set [`handoff.data.unconfirmed: mark`](#appyaml) as well, so the office sees which values the caller never confirmed: at an interrupted read-back, none of them.

A run moves `PRIORITY_INTENT` with `--threshold PRIORITY_INTENT=0.85`; the sweep leaves it alone unless asked (`--only PRIORITY_INTENT`), since a rise lets such a request wait. `priority` is for a form intent or an informational one; `check` refuses it on a control intent (a person on request is the `agent` intent, which `wantsHuman` already acts on at once). It reads only answers the model already gives (the intent's probabilities), so it changes no question the model is sent, and an app without a priority intent behaves exactly as before. Give the intent corpus lines inside the forms (`context: <form>`, `change: replacing`), in the words a caller would use there, and one said half aside.

### forms.yaml

Each form collects slots, optionally reads them back for a yes, and then does something.

```yaml
forms:
  renew_loan:
    slots: [book]
    summaryPromptId: confirm_renew
    hooks: [confirmedParams, complete]
  check_hold:
    slots: [book, branch]
    summaryPromptId: null
    hooks: [complete]
```

- `slots` are asked in this order. Every slot id must be a slot spec in the code (section 5).
- `summaryPromptId` is the prompt that reads the filled form back for a yes. `null` means the form completes as soon as its slots are full.
- `hooks` lists the code hooks the form uses. `complete` is required, unless the form answers from the knowledge base (`answers`) or goes on to another form (`next`). The list must match the code exactly: `defineApp` refuses a hook the code writes that the list leaves out, and a hook the list names that the code does not write. Section 6 says what each hook is.
- `calls` lists the actions (tools) the form's hooks call through the gate. Declare it for every form or for none (`calls: []` for a form that calls nothing). The engine never reads it; the app map and `check` do ([section 3.7](03-policy-and-identity.md#37-how-a-form-reaches-an-action-calls)).
- `checks` and `checksPassed` (optional) end a form part-way on an answer: see [Checks](#checks-ending-a-form-part-way) below.
- `next` (optional) names the form entered at once when this one completes; `internal: true` and `label` make a form that is no intent, reached only by a `next`; `listenBeforeEntered` says whether the form's slots fill from what is said before it is open: see [A form that goes on to the next](#a-form-that-goes-on-to-the-next-next-and-internal-forms) below.
- Every form id must also be a `kind: form` intent, unless the form is internal.

#### Checks: ending a form part-way

Some lines rule a caller out before they collect the rest: a renter calling a homeowners' service, a home outside the area, a caller under 18. A form's `checks` ask the gate about an answer as soon as it is given, and end the form on a refusal, before the next question. The qualifying slots come first in the form, the booking's after them, and one summary reads all of them back.

```yaml
forms:
  book_inspection:
    slots: [problem, ownership, town, howUrgent, address, name, phone, day, timeOfDay]
    summaryPromptId: confirm_book_inspection
    hooks: [confirmedParams, complete]
    calls: [bookInspection]
    checks:
      - action: checkUrgency
        with: [howUrgent]
        on:
          emergency: { then: handoff }
      - action: checkOwner
        with: [ownership]
        on:
          not-owner: { say: decline_renter, then: end }
      - action: checkArea
        with: [town]
        on:
          out-of-area: { say: decline_out_of_area, then: end }
    checksPassed: home_qualifies
```

- `action` is an action in policy.yaml marked `check: true` ([section 3.2](03-policy-and-identity.md#32-an-action-and-its-rules)): a question to the gate only. It has no tool, and an ALLOW runs nothing. The rule that refuses lives in policy.yaml with every other rule, and the write names the same rule, so the completion still refuses what the check refused. A qualifying answer is usually one of a list, so the rule is usually a built-in one: `oneOf` (the town is one of the four the business works in, the caller owns the home) or `noneOf` (how urgent it is is not an emergency), each with the reason `on` maps ([section 3.3](03-policy-and-identity.md#33-the-built-in-rules)). A rule of your own (`defineRule`) is for what no list says.
- `with` lists the form's slots the check reads. Each is sent as the param of the same name, its value as the slot holds it. A check is ready when every slot in `with` holds a value. It runs then, and again whenever one of them changes; a slot reopened and given the same value, or an unchanged yes at the summary, asks the gate nothing.
- Checks run in the order written, on every turn that changed slots: after a disambiguation and a slot's own read-back (so never on a value still being read back) and after the form's entry call (so identity the form needs is proven first), before the next question. A slot read back only in the summary (`confirm: summary`, the default, or `by-confidence`) has not been confirmed when its check runs: a misheard answer would be refused as it was heard. Read back the answer that ends the call, on the slot (`confirm: always`, or a choice slot's `confirmValues`) or on the check's outcome (`confirm`, below). They run again first thing at completion, so "yes, but I rent" is refused with the check's own line and the write is never attempted. The first refusal ends the turn. Put the check the business cares most about first: a caller with two reasons hears its line.
- `on` maps a reason the gate gives to what follows. `then: end` says the line, then the call ends (the app's `goodbye` line follows, unless the outcome says `goodbye: false`; with a request queued, the line is said and the call goes on to it instead). With a request queued the line is said word for word mid-call, `goodbye: false` or not, so it must read right both ways: a line here keeps the goodbye out of its words and leaves `goodbye` unset, and the goodbye follows it only when the call ends there. `then: anything-else` says the line, closes the form uncounted, and carries on to the next queued request or "anything else?". `then: handoff` goes to a person with the line `handoff_<reason>` (`reason:` names another), after `say` if there is one. `then: form` closes the form uncounted and enters the form `form:` names, as a `next` does (the slots both forms list are kept, the rest emptied, and the form is bridged into with `bridge_next`), after `say` if there is one: `out-of-area: { say: decline_out_of_area, then: form, form: refer_elsewhere }`. `say` is required for `end` and `anything-else`. The same outcome is what a slot does when it runs out of attempts ([When a slot runs out](05-writing-a-slot.md#when-a-slot-runs-out-attempts-and-onmaxattempts)), and one executor runs both. A reason `on` does not list gets what a completion's refusal gives (`c.refusal`): a BLOCK with a line from the app's `blockPromptId` says it and carries on; anything else goes to a person. A `STEP_UP` from a check (an action above the level the form's entry proves, [below](#a-check-that-needs-identity)) is no refusal: identity is asked for, and the check runs again once the caller is verified.
- `confirm` (optional, on an outcome) is a yes-or-no line said before the refusal acts, when a slot in `with` is not yet confirmed: `not-owner: { confirm: check_renting, say: decline_renter, then: end }`, with `check_renting` "Just to check, you're renting the home?". A yes confirms the slots in `with` and the refusal acts as written. A no empties those of them not yet confirmed (one confirmed at its own read-back is not the answer misheard), and the check's pass, says `ack_declined` and asks the first of them again, a step on that slot's ladder (a silence or a miss after it is asked again as any is); the right answer said with the no ("no, it's in Ashford") is taken instead, and the check runs again on it. The check runs again when they fill, and reads back again only if it refuses again. A second no to the same check's read-back goes to a person, and a read-back nobody answers is asked again and then goes to a person: the refusal never acts on silence. A read-back whose slots changed while it was out (a fill on a turn that answered something else) is neither asked again nor acted on: the check runs again on what they hold, through the gate. It is skipped when every slot in `with` is confirmed already (its own read-back, or the summary's yes), so a value is never read back twice; "yes, but it's in Lakeview" at the summary changed the town after the summary said it, so the town's refusal is read back. It suits a rule over several slots, or a rule of the app's own, which no list of values says; for one value of a choice slot, `confirmValues` on the slot reads it back as soon as it is said.
- `checksPassed` (optional) is a line said once, on the turn every check of the form has passed, and never again after a correction. Every line a check says (`say`, `confirm`, `checksPassed`) renders with the form's slot displays as variables, as the summary does, so `home_qualifies` can say `{town}`.
- When a check ends the form on the very turn the form was entered ("I'm renting and there's water in the basement", or a value carried from an earlier form), the engine drops the line that started it (its `ack_intent`, or the `bridge_next` into it from the queue), so the caller does not hear "Sure, I can help" and "we can't help" in one breath. Write each refusal line so it names what it refuses ("Our visits are for homeowners, ..."): it may be the first the caller hears of the form.
- One check per answer refuses on the turn the answer is given. One check over several slots (`with: [howUrgent, ownership, town]`) runs only once all are filled, so a renter is asked the town and the urgency first: use it when the answers only rule a caller out together.
- What is recorded: each check that runs is a gate event like any call (the trace and the console show it as they show an entry call). A check that ends the form adds the audit row `form_stopped { form, action, reason, then }` before the handoff or the call's end (with `next`, the form entered, for `then: form`; with `confirmed: true` when its refusal was read back and the caller said yes; a read-back still out writes none, and a no to it writes `check_reconfirmed { form, action, reason }`, so an auditor sees the deciding answer corrected), and the console's NOW panel says "stopped: checkOwner, not-owner". The form is not counted as completed. The session keeps what each check passed with (`checked`), which is absent until a check runs.
- One form with checks also keeps what the caller says up front. The turn that opens a form fills every slot of it, so "I own the house, can someone come out on a Saturday morning", said on the opener, fills the ownership, the day and the time; the ownership check runs on that turn, and the day and the time are never asked. A line split into a qualifying form and a booking form (`next`, below) keeps the qualifying answers but asks the day and the time again, since the booking's own slots wait for the booking to be open. So one form with checks is the first choice: put the slots a caller names in their first sentence in the same form as the step they open, even when they are asked last.
- A check never writes the session's queue: a form's hooks never write `s.queued`, which is the engine's.

#### A check that needs identity

A check's action may need a level the form's entry does not prove first: a check only a verified caller may pass, in a form anyone may start. Written out (`level: 1`), `pnpm check` warns of it ("the caller is asked to verify when the check runs") and does not refuse it: it is the app's call. Left out, it is refused: an action with no level needs the highest, so a forgotten `level: 0` would ask every caller to verify part-way through the form. When the check is ready and the gate answers `STEP_UP`, identity is asked for as for an entry call's `STEP_UP`: the factors, their check, the keypad code where the level needs it (on a web chat, the portal sign-in). The form and what it holds stay as they are, nothing is recorded as stopped, and once the caller is verified to the level the gate said, the form loop runs the check again and the form goes on. A failed verification ends as the identity ladder ends (the factors again, then a person), and one never answered walks the factor's own ladder to a person. A switch to another form drops the step-up and the form with it, as for an entry call's. A caller already at the level the gate asks for (a rule of the app's own that says `STEP_UP` whatever the level) is not asked again: the call goes to a person. A reason in `on` named for a step-up is never used: identity is the engine's. In an app without identity.yaml, a `STEP_UP` from a check goes to a person.

A check may also read an identity factor (`with: [dob]`, an age check on the date of birth). The form never waits for the factor: as soon as the check waits on nothing else (every other slot it reads is filled, or it reads only factors), identity is asked for, to level 1, as above, and the check runs once the factor is given. On a call, a caller not yet verified who says the factor on the way ("I was born April 12th, 1980, and the power's out") fills it, and the check runs on that value as said, before anything has matched it: give the check `level: 1` when the value must be verified. The factor stays on the call once given, so a second form's check of it runs without asking again. The form never completes with such a check not run. Where no factor is ever taken (a web chat, whose callers sign in rather than type one; a caller verified some other way), the check cannot run, and the form goes to a person (`form_stopped`, with no reason) rather than complete. `pnpm check` warns of a check on a factor, and refuses one the form also lists in its `slots`: a form empties its slots when it closes, while the caller stays verified, so a later form's check would wait on a factor nothing asks for again. Leave the factor out of the form's slots; identity asks it. The factor need not be one of the form's slots, and a check's `confirm` never reads it back: it holds what the verification matched.

```yaml
# forms.yaml
report_problem:
  slots: [place, problem]
  summaryPromptId: confirm_report_problem
  hooks: [confirmedParams, complete]
  checks:
    - action: checkProblem   # level 1 in policy.yaml: asks for identity when it runs
      with: [problem]
    - action: checkAge       # reads an identity factor, once it is given
      with: [dob]
```

The engine's fixture is the checking variant of `packages/dialogwright/src/testing/proposals` (`variant.ts`).

#### A form that goes on to the next: `next` and internal forms

Some lines have several screeners and one booking: a leak, a crack and a draft each qualify the caller differently, then the same booking follows. A form's `next` names the form entered at once when it completes, and a form marked `internal: true` is no intent: the model, the keypad menu and the queue never see it, and it is reached only by a `next`.

```yaml
forms:
  screen_home:
    slots: [problem, ownership, town]
    summaryPromptId: null
    calls: []
    checks: [...]
    next: book_inspection          # no complete hook: the next form is its answer
  book_inspection:
    internal: true
    label: book your free inspection
    slots: [problem, ownership, town, address, name, phone, day, timeOfDay]
    summaryPromptId: confirm_book_inspection
    hooks: [confirmedParams, complete]
    calls: [bookInspection]
```

- When a form with `next` completes as `said` (its `complete` hook answers `said`, or it has none, which `next` allows), the engine closes it and enters the next form at once, ahead of any request the caller queued, which waits until the chain is done. The slots both forms list are kept with their values, displays and confirmations (and, for a handoff, what the caller agreed to), so the booking never asks the screen's answers again and its summary reads them back with its own. A slot the next form does not list goes, as any closing form's does: a middle form between a screen and a booking drops every slot it does not list, so list there the slots the booking needs. The screen's checks still hold in the booking for the slots the booking lists too: they run again on a change and at completion, with the screen's own outcomes, so a town changed at the booking's summary gets the screen's out-of-area line. The passes of the checks that run there are kept, so the gate is not asked again about a value it already allowed; the next form's `checksPassed` is said only if one of its checks is still to pass. A value changed later runs the check again.
- The next form is bridged into with `bridge_next` and its label ("Now, let's book your free inspection."), never an `ack_intent`. The label is the intent's for a form intent, and the form's own `label` for an internal one; the same label is what the model is told the caller is in, and what the console's NOW panel says (unless `console.formLabels` names it).
- A completion that ends the call (`end`), a refusal, `reconfirm`, a completion that takes the turn (`decision`) and a check that ends the form do not go on: the form ends as written.
- The forms the open one was reached through are the same request: inside the booking, naming the screen the caller came through again ("yes, and I want a visit") neither queues it nor switches to it, and a second request said beside it is read past it ("yes, and something urgent too" queues the urgent request). Only the path taken counts: another screener into the same booking ("actually it's a crack") is another request, to switch to or queue, and a booking that is also an intent, asked for directly, was reached through nothing.
- When a check refuses on the turn the chain moved, the caller hears only the refusal: the screen's `ack_intent`, its `checksPassed` and the bridge are dropped, as a form's own entering line is.
- A priority intent, or a switch to another request, during the chain leaves it as it leaves any form. The internal form is not queued, so it is not resumed. Keep chains short: one screener and one booking.
- A `next` may name a form intent too: a booking reached both by a screener and by asking for it directly. The app decides.
- `check` refuses a `next` to a form there is not, a loop of `next`, an internal form no `next` reaches, an internal form with an intent in intents.yaml, an internal form with no `label` (and a `label` on a form intent, whose label is in intents.yaml), and a form with neither `complete`, `answers` nor `next`.
- What is recorded: the first form's completion as any (it is in `completed`), then the audit row `form_next { form, next }` after the first form's gate rows and before the next form's, one for each move (a middle form already full moves on on the same turn, with one bridge said). The session names the forms the open one was reached through (`reachedThrough`), absent otherwise. The app map draws an internal form under the form that leads to it ("After screen_home"), with no intent.
- `listenBeforeEntered` (default `true` for a form intent, `false` for an internal form) says whether the form's slots fill from what the caller says before the form is open. A slot with no `listen` of its own that every form listing it says `false` for listens as `listen: form` ([Where a slot listens](05-writing-a-slot.md#where-a-slot-listens-listen)): it is asked once its form is open, even when it was said earlier. A slot the screen lists too still listens up front, since the screen allows it, so a qualifying answer said with the request is kept. A slot's own `listen` overrides the forms, and so does app.yaml's `carrySlots`; `check` warns when either says otherwise than every form that lists the slot. A value said early for a slot that waits is asked again, which is acceptable when a form's slots don't listen early. Set `listenBeforeEntered: false` on a form intent whose answers should be heard only once it is open.

The engine's fixture is the two-form variant of `packages/dialogwright/src/testing/screened` (`variant.ts` `NEXT`), with its app map in `APP-MAP.next.md`.

### prompts.yaml

Every line a caller can hear, word for word. The agent says exactly these, unless the app asks for a line to be generated ([16](16-generated-wording.md)).

```yaml
prompts:
  ask_intent:
    text: How can I help you today?
    interruptible: true
  ask_book:
    text: Which book is it?
    interruptible: true
  confirm_renew:
    text: You'd like to renew {book} for two more weeks. Shall I do that?
    interruptible: true
  renewed:
    text: Done. {book} is now due back {due}.
    interruptible: false
```

- Variables in braces are filled by the engine (`{intentLabel}`) or by the app's code (`{book}`, `{due}`). The engine's lines are given only a few: `{intentLabel}` (`ack_intent`, `ack_queued`, `bridge_next`, `confirm_intent_explicit`), `{a}` and `{b}` (`disambiguate_intent`, `ack_intent_then`), `{first}` (`identity_verified`, `signin_thanks`, `greeting_chat_signed_in`, `greeting_chat_delegate`), `{phoneLast4}` (`ask_otp`, empty when the caller has no phone on record), and the slot's own value (`confirm_<slot>`, `ack_<slot>`, as `{<slot>}`). The rest are given none. `pnpm check` names them when it asks for a missing line.
- `interruptible: false` for a line that must be heard whole (a keypad instruction, a statement).
- `mode` is `fixed` (the default: the text, word for word) or `generative`: the line is worded by a model for the moment, with a `goal`, under checks that hold it to this text's data and meaning, and this text is said whenever a check fails or the model is slow. `when` limits it to some situations or channels, `from` names variables that hold collected content the line may summarize, and `prescribed: true` keeps a line word for word whatever its form says (`pnpm check` refuses `mode: generative` on it). `generate` makes a framed line: its text stays fixed but for the spans it names (`{summary}`), each worded by a model from a slot's content (`from`, a `goal`, `words`), the pattern for reading back a summary of what the caller said ([16.3](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)). A form's `wording: generative` generates its lines, and its `summary: { onNo: read-back }` reads its summary again word for word on a bare no (after `read_back_exact`). A read-back that may summarize a value a `confirmed` rule holds the caller to says `summarizesConfirmed: true`. All of it is opt-in, and the app's choice: [16. Generated wording](16-generated-wording.md).
- The engine itself says about thirty lines by name (`goodbye`, `no_input`, `offer_transfer`, the handoff lines, and so on), and `ask_<slot>` and `ask_<slot>_retry` for every slot. Some lines depend on the slot's spec in the code: `ask_<slot>_dtmf` for a slot with a keypad rung (`dtmf`), `confirm_<slot>` and `ask_<slot>_dtmf` for a slot whose every spoken value is read back (`spokenConfirm: 'always'`; `confirm_<slot>` alone where a no asks the slot again, `readBackNo: 'ask'`, as for a library slot's `confirm: always`), `confirm_<slot>` for one that reads some values back (`confirmValues`), `ack_<slot>` for one acknowledged by confidence (`spokenConfirm: 'by-confidence'`), and the slot's `partialPromptId`. A role whose access to a tool is `person` needs the handoff line for its role rule's `reason` (`handoff_role_person` by default). `pnpm check` lists any that are missing and says when the engine says each (section 7). It cannot see the lines a slot's `fill` names (`disambiguate_<slot>`, a `retryPromptId`, a help prompt) unless the slot declares them in its `prompts` (section 5).

### policy.yaml

What the app's agent may do, action by action: the whole of it. Each action is a tool, with the identity level it needs and the rules the gate runs before it, in the order written; the first rule that fails decides. Policy is data here, and never lives in a tool.

```yaml
actions:
  renewLoan:
    level: 0
    rules:
      - identity
      - confirmed: [book]
  findHold:
    level: 0
    rules:
      - identity
      - custom: known-branch
  listLoans:
    level: 0
    rules: [identity]
```

Every tool in the code needs an action here, and an action not listed is refused. [Section 3](03-policy-and-identity.md#3-policy-and-identity) is the whole treatment: each built-in rule (`identity`, `scope`, `role`, `confirmed`, `attempts`, `fields`, `dateInRange`, `limit`, `oneOf`, `noneOf`, `callerNumber`), rules of your own, purposes, redaction, what is recorded, and how the policy is tested and reviewed.

### identity.yaml (optional)

How a caller proves who they are, and who the app serves. The clinic has none. The engine's valid-folder test fixture is:

```yaml
principals:
  subject: patient
  delegates:
    staff: { roles: [viewer, clerk] }
levels:
  1: { name: verified, factors: [patientId, dob], verify: verifyPatient, failedPrompt: identity_failed }
  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
attempts: 3
```

An app without the file verifies no one, and every action must be level 0. [Section 3.6](03-policy-and-identity.md#36-the-identity-ladder) says what each part means: the principals, the ladder's levels and factors, the length of the one-time code, the attempts, sign-in, and a caller-ID match standing in for the identifier (level 1's `callerId`).

### routes.yaml (optional)

What the call does at three points, decided by ordered rules: the first whose conditions all hold is taken, the rules after it are not looked at, and an `else` is last. Routes are not a state machine: what the caller says, intents, priority intents and the agent intent still decide every turn; routes decide only at their points. An app without the file decides nothing there, and behaves exactly as before. From the routed fixture:

```yaml
# routes.yaml
start:
  - when: { hours: closed }
    say: closed_now
    then: end
    goodbye: false
  - when: { named: vip }
    then: handoff
    reason: vip
  - when: { fact: outage, is: true }
    say: outage_notice
    then: continue
  - else: continue

afterIdentity:
  - when: { fact: account.pastDue, is: true }
    say: past_due_first
    then: form
    form: payment_plan
  - else: continue

afterForm:
  report_problem:
    - when: { slot: severity, is: danger }
      then: handoff
      reason: emergency
    - else: continue
```

**The points.**

- `start`: once, as the call or chat starts, after the start hook (`onStart`) and the call-start lookup (`callerNumber.lookup`), before the greeting. A `say` is said before the greeting; `continue` and `locale` go on to the greeting (or what replaces it: the caller-ID question, the consent to text, a proposal at the greeting); `end` ends the call on its line with no greeting; `handoff` goes to a person; `form` enters the form after the welcome, the greeting's line before a proposal (`greeting_offer`, or app.yaml's `prompts.greetings.offer`), in place of the open question. `anything-else` is refused here: nothing has been asked.
- `afterIdentity`: once, the first time one of the app's subjects is verified (through the one-time code too, where the step-up asked for it), after the identity step's own line ("Thank you, Avery. You're verified."), before the form that asked for identity goes on. `continue` is that form going on. `form` puts the caller's own request first in the queue, so it is bridged back into once the form entered is done ("past-due accounts go to payments first"); a route to the form the caller is already in goes on in it. `end`, `handoff` and `anything-else` act as a check's outcome does in that form (with no form open, at the greeting, `anything-else` asks "anything else?"). A signed-in chat subject is routed the first time they reach a form, or as they sign in. Whether it ran is kept on the session (`identityRouted`), only for an app with these routes. Precisely: it runs where the call goes on after identity, the first time it does: in the form that asked for identity, once its entry call is through (after the entry call, so what its `onEntry` kept is there to read, and before the form's checks and questions); at the greeting, once the caller-ID question's factors are verified; on a chat, as a subject signs in. Where the entry call is refused right after the caller is verified, it is marked as passed and not run, so it never runs later, mid-way through another request. A call saved before the app gained these routes (a server updated mid-call) runs them at its next form.
- `afterForm.<form>`: when that form completes as said (its completion's `said`; a completion that ends, refuses or hands off is not), before its `next`. The form is counted as completed whatever is taken. `continue` is what the form does without a route: its `next`, else "anything else?"; `anything-else` skips the `next`; `form` goes on to the form named in its place, as a `next` does (the slots both list kept, the move recorded as `form_next`, and a loop within one turn sent to a person); `end` ends on its line (with a request queued, the call goes on to it); `handoff` goes to a person with the form left open, as a completion that hands off leaves it.

**A rule** is `when` and an outcome. `when` is one condition or a list, all of which must hold. The last rule of every point is `else`: `else: continue`, or an outcome written out (`else: { say: closed_now, then: end }`).

**The first rule that holds is taken, and the rest are not looked at.** A call is never taken by two rules, so a rule that goes on (`continue`) does not go on to the rules below it: it goes on to the greeting (or what follows the point). In a live call a Spanish line's caller was greeted in English: the outage rule (`when: { fact: outage, is: true }, say: outage_notice, then: continue`) sat above the language rule (`when: { called: env.SPANISH_LINE }, then: locale`), held first on a day with an outage, and the language rule was never looked at.

**A language line is best not a route at all.** app.yaml's `voice.numbers` (`env.SPANISH_LINE: es`, [13.3](13-channels.md#133-languages-on-the-phone)) starts a call to that number in its language as the call is answered, before any route, so every route's line (the outage notice, the closed line) is said in it, whatever the order. That is what the routed fixture does. A route's `then: locale` is for a language decided by anything else a condition reads (a queue in the call data), and there order matters. There are two fixes, and which is right is the app's:

- **Order the rules**, the one that must win first: the language rule above the outage rule switches every such call, and its caller then never hears the outage notice, since the language rule is taken and the outage rule is not looked at.
- **A rule that does both**, above the two: `when: [{ fact: outage, is: true }, { callData: queue, is: spanish }], say: outage_notice, then: locale, locale: es`. The switch comes first, so the notice is said in the new language (from `locale/es/prompts.yaml`), then the greeting in it; the two rules below it still take an outage for any other call and a Spanish call with none.

The same holds for any rule above a `locale` rule: a call that `end`s or is handed off by an earlier rule hears its line in the app's default language. `pnpm check` warns of the case that is almost never meant, a rule that says a line and goes on (`then: continue` with a `say`) above a `locale` rule both could hold for (not where both read the number called, and not where a rule above it already does both), with these two fixes.

**The outcomes** are the ones a check's refusal and a slot's `onMaxAttempts` take, but `skip` (a slot's alone), and two of their own. Each says its `say` first, where it has one, a line of prompts.yaml rendered with the open form's slot displays as variables:

| `then` | What follows | Takes |
|---|---|---|
| `continue` | the call goes on as if no route were written | `say` |
| `locale` | the call switches to `locale` (one of the app's), as the language intent does, then goes on; the `say` is said in the new language | `locale`, `say` |
| `end` | the call ends on the line, the app's `goodbye` line after it; with `goodbye: false`, on the line alone, for a line that says goodbye itself ("... We're closed right now. Goodbye."), so the caller does not hear goodbye twice. After identity or a form, a request may be queued: the line is then said word for word and the call goes on to it, so there a line keeps the goodbye out of its words (and `goodbye` unset); only at `start`, where nothing can be queued, does a line that says goodbye always end the call | `say` (required), `goodbye` |
| `handoff` | to a person, with the line `handoff_<reason>` (and the transfer target that reason picks) | `reason` (default `needs-human`), `say` |
| `form` | the form named is entered | `form`, `say` |
| `anything-else` | the form closes and "anything else?" is asked (not at `start`) | `say` (required) |

**The conditions** are the transfer targets' ([13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)), one evaluator for both, each a subject and, for a subject with a value, one test (`is`, `in`, `notIn`, `present`):

- `{ fact: pastDue, is: true }`: a value in the session's facts, by a dotted path for a nested one (`account.pastDue`). Null or not set is absent (`present: false`); a list or a record is present and equals no value. `pnpm check` warns of a fact whose first name the code's `facts.initial()` does not start with (a hook may add it later), and checks nothing for an app whose initial facts are empty.
- `{ slot: severity, is: danger }`: a slot's value as the call holds it (the form's slot, or one carried); an empty slot is absent.
- `{ callData: queue, is: spanish }`: a key of the call data ([13.14](13-channels.md#1314-the-data-a-call-or-chat-comes-with-calldata)), as for a transfer target.
- `{ level: 1 }`: the caller is verified to at least this level (1 or 2).
- `{ hours: open }` or `{ hours: closed }`, with `schedule: billing` for a named one: app.yaml's [hours](#business-hours-hours) at the turn's clock. An app with no hours holds neither. A line that is closed for people but open for some things after hours (it still books, and puts emergencies through) says so at `start` with `{ hours: closed }`, a `say` and `then: continue`, and sends its handoffs by transfer targets on the hours, after the emergency's ([13.15](13-channels.md#1315-where-a-handoff-goes-and-what-goes-with-it-transfer)).
- `{ called: env.SALES_LINE }` or a list: the number the caller dialed is the value of one of these environment variables (the numbers stay out of YAML), compared by its digits (the language a number starts in is app.yaml's `voice.numbers`, compared the same way, with no route): the same digits, or, where only one of the two carries a country code, the longer ending in the other's ten (`5555550188` is `+15555550188`; `+15555550188` is never `+75555550188`). It needs app.yaml's `callerNumber: { use: hint, called: true }`. The server reads each variable as it starts and refuses to start when one is unset or not E.164; `pnpm diagnose` checks each. A turn's conditions are handed those values and nothing else of the environment (`TurnContext.env`: the variables the app's conditions name, frozen). The app's code reads its own settings by name with `ctx.env` ([chapter 4](04-what-stays-in-typescript-and-why.md#settings-ctxenv-never-processenv)), never through a condition. A scripted call reads its own `"env"`, never the shell's. A replayed call has no number called (the frame log does not keep it), so a `called` route takes another branch there; the replay says so (below).
- `{ named: vip }`: a predicate the app writes in code (`code.predicates`), for anything else ([below](06-the-form-hooks.md#the-start-hook-predicates-and-failsoft)).
- `{ form: payment }`: the form open, or the last completed (never at `start`, where `pnpm check` refuses it). `reason` holds only where a handoff is being chosen, so a route refuses it.

**Records.** Each route taken is a trace event (the record's `routes`: the point, the form after which, the rule by its number as people count, the first being 1, or `else`, what followed, and the subjects it read, such as `hours`, `fact.outage`, `named.vip`) and an audit row `route` with the same, never a value. Every record and display says the same number: the console's NOW panel says the route taken on the latest turn (`route: start rule 1, end`), `regress --scenario` prints a `route` line under the turn, the app map draws each point's rules in order ([3.11](03-policy-and-identity.md#311-reading-the-policy-the-card-and-the-app-map)), and `pnpm check` names a rule by its place in the file (`start[0]`, the path, from 0). The frame log has a `{ routes: [...] }` line on each turn a route was taken, by point and rule, and a replay of the log says where it went another way (`routes: the call took start rule 4, the replay took start else`) among the lines it could not follow, never silently.

**`pnpm check`** refuses a form, a slot, a call data key, a prompt, a schedule, a predicate, a locale or a variable the app does not have (or keep); a point with no `else`, or an `else` before its end; a `then` the point does not take; an `afterForm` route that enters the form it follows (it would loop); hours where app.yaml has none; `goodbye` on an outcome that does not end the call; and a condition that can never hold where it is. It warns of a fact the facts do not start with, a rule after one that always holds, a rule that says a line and goes on above a `locale` rule both could hold for ([above](#routesyaml-optional): the switch is never made), an `end` whose line ends as the goodbye line (or the chat's) does, by its last sentence in any locale, while the goodbye still follows it (at `start`, write `goodbye: false`; anywhere a request may be queued, take the goodbye out of the line; the same for a check's and a slot's `then: end`), and such a line with `goodbye: false` where a request may be queued (it would be said mid-call), a route into a form needing an identity level the point cannot have reached (at `start`, any; after identity, 2): the form will ask for it; a `level` no caller of the app can reach (it never holds); a `slot` read at `start`, where nothing has been asked or proposed yet (it holds only as `present: false`); and forms that send each other round in a loop through routes after a form (`afterForm` A to B and B to A), as through outcomes. It needs `greeting_offer` in every locale when a `start` route enters a form. `validateApp` refuses the same for an app built in code. Which routes, and in what order, are the app's.

**Testing.** A scripted call takes `"now"` (an ISO date and time with its offset: every turn reads that clock, and its date is the date then in the hours' time zone, else UTC, unless `"todayIso"` gives another), `"env"` (the variables `called` reads; without it, none), `"calledNumber"` and `"callData"`; a seeded corpus call happens at `testing.seed.now`, on its date. The engine's fixture is Example Service Line (`packages/dialogwright/src/testing/routed`): each point, hours open and closed, a holiday and a named schedule, the start hook writing a fact, a dip that fails soft, a predicate, the Spanish line (by `voice.numbers`, so its outage notice is in Spanish) and a transfer target on the billing desk's hours; `tsx src/testing/routed/regress.ts --scenario past-due-first` follows one call.

### slots.yaml (optional)

Names every slot the app has, one key per slot, and the order of the keys is the order of `App.slots`. Each slot is a library type with its options (the types and their options are in `schemas/slots.schema.json`; section 5 covers choosing and writing a slot) or `{ type: code }`, a slot the code writes in `code.slots.<id>`.

A slots.yaml with three library slots and one written in code (`{ type: code }`). The clinic's own file, with all five of its slots from the library, is `apps/clinic/slots.yaml`.

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/slots.schema.json
name:
  type: name
  exclude: [dr, doctor, chen, cheng, patel]
dob:
  type: birthdate
  keypad: true
card:
  type: digits
  noun: library card
  length: 8
  keypad: true
  group: [4, 4]
plate: { type: code }                          # an example of a slot the code writes (code.slots.plate)
```

The eight types and their options are in section 5 and in [docs/slots](../slots/README.md); a small library slot looks like this:

```yaml
note:
  type: text
  what: a note for the librarian
  say: your note
```

The rules, each checked by `defineApp` and `check` with the file and line:

- **The file lists every slot.** Each key of `code.slots` must appear as `{ type: code }`, and each `{ type: code }` must have a `code.slots` entry. A slot that is both a library slot and in `code.slots` is refused: it would be built twice.
- **The order is the file's.** Outside a form the engine fills slots in that order, says their acknowledgements in it, asks the first slot that needs the caller to choose between two values, and lists the slots in it in the model's turn state and in a transfer's handoff. A form's own slots stay in the order forms.yaml gives. Without a slots.yaml, the order is whatever order `code.slots` was written in, which is easy to change unintentionally; with one, it is written down in one place, and a reorder shows in a diff.
- **A type is a library type, an app type or `code`.** An app adds its own types with `slotTypes` in its code (`code.slotTypes: registerSlotType(myType)`); a name a built-in type has, and `code`, are refused. An unknown type names the closest one.
- **A library slot's options are checked by its type**, strictly: a misspelt option is refused with the one meant, at its line in slots.yaml.
- **Every type takes `confirm:`**, how a spoken value is read back: `summary`, the default, leaves it to the form's summary; `always` reads it back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on or a check reads it; `choice`, `digits` and `date` also take `by-confidence` (an acknowledgement, `ack_<slot>`, when the model is less sure). A `choice` slot also takes `confirmValues: [<option>, ...]`: those options are read back as `always` would, and the others follow `confirm`. A no to a read-back empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), a step on its ladder (its keypad question `ask_<slot>_dtmf` at the keypad rung where it takes keys), so a silence after the no is asked again rather than sent to a person; the right answer said with the no ("no, I own it") is taken instead, and read back in its turn if it is a value the slot reads back. A second no to the slot's read-back goes to a person. `pnpm check` asks for `confirm_<slot>`, refuses a `confirmValues` value that is not an option, and refuses `confirm: always` on a `text` slot read back by a stand-in (`say`), which would read back "your description?".
- **Every slot takes `listen:`** beside its type's options: where it listens outside a form (`up-front`, the default, `form`, `anywhere` or `call`). Section 5, [Where a slot listens](05-writing-a-slot.md#where-a-slot-listens-listen), says what each does and when to choose it.
- **Every slot takes `attempts:` and `onMaxAttempts:`**: how many failed answers it takes (1 to 10, default 3) and what follows when it runs out (`handoff`, the default; `skip`; or an outcome written out). Section 5, [When a slot runs out](05-writing-a-slot.md#when-a-slot-runs-out-attempts-and-onmaxattempts), says how. A slot written in code sets them on its `SlotSpec`.

Without the file, every slot is the code's, as before. The file is part of the configuration hashes (section 9). An app that is not built from a folder gets the same rules from `defineSlots(source, codeSlots, types?)`, where `source` is the path of a slots.yaml or the same map as an object; it returns the slots in the file's order, or throws an `AppDefinitionError` listing every problem.

### locale/&lt;tag&gt;/prompts.yaml (optional)

The prompts for another language, in the same shape as prompts.yaml. See section 8.

### locale/&lt;tag&gt;/slots.yaml (optional)

How the library slots say their values in that language: a choice option's `say`, a text slot's stand-in. Never what the model is asked. See section 8.

### locale/&lt;tag&gt;/intents.yaml and forms.yaml (optional)

The labels the lines of that language name the caller's request by (`{intentLabel}`): each intent's, in the shape of intents.yaml (`intents: { <id>: { label: ... } }`), and an internal form's in forms.yaml's (`forms: { <id>: { label: ... } }`). The label alone; the criteria stay as the model reads them. See section 8.

### fixtures/ (optional)

The corpus (`corpus.jsonl`, one labelled utterance per line), scripted calls, the baseline, and recorded cassettes. They are how an app is tested with no keys: the stub decision model answers from the corpus labels. The clinic's README explains the harness; the only rule `check` adds is that every intent has examples in the corpus when `app.yaml` names a fixtures directory:

```json
{"id":"sn-01","text":"I'd like to make an appointment","intent":"schedule_new","context":"no_form"}
```

Recording a cassette, or running the server with `JEV_CLIENT=jev`, needs a key for the decision model. Jev is served by TypeSafe (`TYPESAFE_API_KEY`, the default), OpenRouter (`JEV_PROVIDER=openrouter`, `OPENROUTER_API_KEY`) and the Vercel AI Gateway (`JEV_PROVIDER=vercel`, `AI_GATEWAY_API_KEY`); `JEV_PROVIDER=custom` reaches a compatible endpoint at `JEV_BASE_URL` with `JEV_MODEL` (and `JEV_API_KEY` if it needs one). Each model gets its own cassette, named after it (`typesafe/jev-1.13` records `typesafe__jev-1.13.jsonl`), and the run's first line and the trace's session start say which provider and model answered. A compatible model is not Jev: its probabilities are not calibrated like Jev's, and the thresholds were measured on Jev, so a run on one warns once; record a cassette with it and compare with `regress` before trusting a threshold. Nothing is changed for you.

Record a cassette under the Node major in `.nvmrc` (22). A recorded request is replayed by its exact text, and the engine reads text with Unicode properties (letters and digits, case folding, accents folded for retrieval) whose tables come with Node's ICU and can change between majors. CI replays on 22 and 24; a miss that only one major shows is such a table change, not a regression, and the fix is a deliberate re-record under `.nvmrc`'s major, never a recording made on another one.

### kb/ (optional)

The folder of an app that answers general questions from approved passages: `kb.yaml`, `topics.yaml`, passages with the source documents they are approved against, a language's wording, drafts waiting for review, and the log of approvals. It is the subject of [section 12](12-the-knowledge-base.md#12-the-knowledge-base), which has each file with an example and everything built on it.

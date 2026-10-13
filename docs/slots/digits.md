# `digits`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/digits/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

A number of a fixed shape that no list holds: an account, a library card, a parcel tracking number.

The model never writes the number. It answers three questions about the caller's words: is a number stated, which span of the words is it (the engine finds the candidate spans, the model picks one), and was it said whole. The code turns the span into digits ("five five five two" becomes 5552, "double zero" becomes 00), checks them against a pattern, and decides whether they are a value. So the value is always something the caller said, and the code, not the model, says whether it is valid.

Reach for it for an identifier a caller reads out: a number of digits and nothing else. For a code with letters, a date, a name or a choice from a list, use the type made for it.

## Options

A slot of this type is written under its id in slots.yaml, with `type: digits` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `noun` | string | unset | What the number identifies, as a noun without "number" ("account", "library card", "parcel tracking"). The default questions say "a `<noun>` number". Needed unless text gives every question in its own words. |
| `article` | string | unset | The word before the noun in the default questions. Default: "an" when the noun starts with a vowel, otherwise "a". |
| `length` | integer, 1 to 40 | unset | How many digits the number has. Gives the default mask (exactly this many digits) and the length of the keypad rung. Needed unless mask is given. |
| `mask` | string | unset | A regular expression (its source, no slashes) the whole of the digits must match: it is anchored at both ends, so "5\d{7}" and "^5\d{7}$" both mean eight digits starting with 5. With `length` too, the digits must also be that many. Default: exactly `length` digits. A number that fails it is "invalid" with the reason "mask" (with only `length`, the reason is "length"). A group that repeats a repeat, such as (\d+)+, is refused. |
| `keypad` | boolean | `false` | Whether the caller can key the number on the keypad, `length` digits at a time. Needs `length`, and an `ask_<slot>_dtmf` line. |
| `group` | list of integer, 1 or more | unset | How the number is said back, in groups of these sizes ([4, 4]: "5550 7788"). The last group takes any digits left over. Default: all digits together. |
| `confirm` | one of `summary`, `by-confidence`, `always` | `summary` | "summary": a spoken number is neither acknowledged nor read back on its own; the form's final confirm covers it. "by-confidence": it is acknowledged (`ack_<slot>`) when `readBack` says so. "always": a spoken number is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung where the slot takes keys), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `readBack` | one of `implicit`, `below-fill`, `none` | `implicit` | What a filled number asks for: "implicit" (always), "below-fill" (only when the model is less sure of the span than SLOT_CHOICE_FILL), "none" (never). With `confirm: by-confidence`, "implicit" is what makes `ack_<slot>` be said. |
| `minConfidence` | one of `none`, `SLOT_DETECT`, `SLOT_CHOICE_CONFIRM`, `SLOT_CHOICE_FILL` | `none` | A floor on how sure the model must be of the span: below this threshold the number is "invalid" (reason "low_confidence"). "none": no floor. |
| `lengthRetryPromptId` | string | unset | The prompt that re-asks, in place of the generic `ask_<slot>_retry`, when what the caller said is not a number of the right shape ("A card number has eight digits."). |
| `redact` | one of `last4`, `length`, `none` | `last4` | How the value is masked wherever it leaves the turn (the trace, the console, the audit, a tool call's param of the same name): "last4" ("...0417"; a number of four digits or fewer, whose last four would be all of it, as "••••"), "length" (only how many digits, "&lt;4 chars&gt;", its display too and on the live console, its keys masked as they are keyed, and a transfer handed only its length: for a short secret such as a PIN) or "none". |
| `callerNumber` | map | unset | Offer the number the caller is calling from: when the form would ask this slot and the call has a number that fits it (its `countryCode`, `length` and `mask`), the line asks `offer_<slot>` ("Is the number you're calling from, ending in {last4}, the best one to reach you?") in place of `ask_<slot>`, and a yes fills the slot with that number. A no asks `ask_<slot>`, with no attempt counted, and a number said instead fills as said. A chat, or a call with the number withheld, is asked `ask_<slot>` as always. Never on an identity factor: a caller ID can be forged. |
| `callerNumber.countryCode` | string | required | The country calling code the carrier writes before the number ("1" for +1). A number in international form (+15555550142, as carriers send it) must begin with it, and it is taken off; one from any other country is no number for the slot. A number with no + has it taken off when what is left has the slot's `length`. |
| `callerNumber.onNo` | one of `ask`, `skip` | `ask` | What a no to the offer does: "ask" (default) asks `ask_<slot>`, with no attempt counted; "skip" leaves the slot empty and the form goes on (an offer to text, say, where a no means no text). The end of the offer's retry ladder (no answer) does the same. A number said with the no fills the slot as said either way. |
| `callerNumber.ifNone` | one of `ask`, `skip` | `ask` | What a call with no number to offer does (a chat, a withheld number, one that does not fit, or one the app's callerOffer hook refuses): "ask" (default) asks `ask_<slot>` as always; "skip" leaves the slot empty and the form goes on. |
| `callerNumber.answers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What the offer takes: "yes-no-or-value" (default), a yes, a no, or a number of the caller's own, said or keyed, which fills the slot as said; "yes-no", a yes or a no only: a number said at the offer is not taken, and with no clear yes it is a no (onNo then says what follows), and on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question. |
| `handoff` | one of `last4`, `verified`, `display` | `last4` | What a transfer to a person hands over: its "last4", only whether the caller was "verified", or its "display" in full. app.yaml's handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked. |
| `sayAs` | one of `digits`, `number` | `digits` | How the phone's voice says the value back, wherever a line says it (a read-back, a summary, the last four of the caller's number at its offer): "digits" (default), one digit at a time ("0 1 4 2"; in its `group`s with a short pause between them, "5 5 5 0, 7 7 8 8"), as a caller reads a number out; "number", as the voice reads it ("one hundred forty-two"), for a value that is a quantity rather than an identifier. Only what is sent to the voice is rewritten, after voice.spokenDigits: the session, the trace, the console and a chat keep the digits as written. |
| `waitForRestMs` | integer, 0 to 5000 | `1500` | On the phone, how long to wait for the rest of a number the caller began, in milliseconds: when the slot was just asked and heard fewer digits than `length` (or a number the model heard trail off), and the turn would only ask again, the re-ask is held this long; if the caller goes on in that time it is never said, and their next words are joined to the first ("five", a pause, "five five two zero four one seven" is 55520417). A caller who said all they meant to hears the re-ask this much later. 0 asks again at once. Not on a chat, where a message comes whole. Default: 1500, a reader's pause to look at the number again; 0 to 5000. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, span, none, complete. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, span, complete), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |
| `attempts` | integer, 1 to 10 | `3` | How many failed answers the slot takes before onMaxAttempts, 1 to 10. Each failure before the last but one re-asks: a missed answer with `ask_<slot>_retry`, or `ask_<slot>_retry2` at the second failure (and so on) where prompts.yaml has it; a silence with `ask_<slot>_noinput2` (and so on), else `ask_<slot>_noinput`, else no_input then the question (`ask_<slot>`) again (at the keypad rung of a slot that takes no keys, on a channel with a keypad, no_input then its retry line). The last but one is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad, else another re-ask; the last runs onMaxAttempts. Default: the engine's MAX_ATTEMPTS (3). |
| `onMaxAttempts` | one of `handoff`, `skip` or map | `handoff` | What happens when the slot runs out of attempts (a missed answer, a silence, an unanswered read-back, or a second no to its read-back). "handoff" (the default): to a person, with handoff_max_attempts. "skip": the slot is left empty and declined, and the form goes on; never on an identity factor, nor on a slot its form's summary names. Or written out, { say, then, reason, form }: then is handoff (reason names the handoff, default max-attempts), skip, end (say required; the call ends), anything-else (say required; the form closes uncompleted and "anything else?" is asked) or form (the form closes uncompleted and `form` is entered, keeping the slots both list); say, a prompt said first. An offer of the caller's number with onNo: skip that runs out leaves the slot empty whatever this says; with no onNo: skip, the slot's ladder goes on to it. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller states the number at all. Variables: `{article}`, `{noun}`. | `Read asr.text. Does the caller state {article} {noun} number, either as digits or as spoken number words?` |
| `text.span` | The question that asks which span of the caller's words is the number. Its choices are the spans the engine finds, and none. Variables: `{article}`, `{noun}`. | `Read asr.text. Which of these spans is the {noun} the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is {article} {noun}.` |
| `text.none` | What the span question's "none" choice means. Variables: `{article}`, `{noun}`. | `No span of asr.text is {article} {noun}` |
| `text.complete` | The yes-or-no question that asks whether the caller said the whole number. Variables: `{article}`, `{noun}`. | `Read asr.text. If the caller states {article} {noun}, do they finish saying the whole number rather than trailing off?` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller states the number. |
| `ids.span` | The id of the question that asks which span of the caller's words is the number. |
| `ids.complete` | The id of the question that asks whether the caller said the whole number. |

The slot is always `detect: true`: its row in the console is measured against `SLOT_DETECT`.

## The outcome

| What the caller said | The outcome |
|---|---|
| No number (the first question is below `SLOT_DETECT`) | `absent`, so a turn about something else leaves the slot alone |
| A number, trailed off (the third question is below `SLOT_DETECT`) | `invalid`, reason `incomplete` |
| A number, no span chosen | `invalid`, reason `no_span` |
| A span the model is less sure of than `minConfidence` | `invalid`, reason `low_confidence` |
| Digits that do not fit the pattern (the whole of them must match `mask`, which is anchored at both ends, and be `length` long when `length` is given; more than 40 digits never fit) | `invalid`, reason `mask` (`length` when there is no `mask`), with `lengthRetryPromptId` when it is set |
| Digits that fit | `filled`: the value is the digits, the display is the digits in `group`s, and `readBack` says what it asks for |

On the phone, words said to the slot's own question that hold fewer digits than `length` are held for the rest of the number before any turn runs (`waitForRestMs`, below); what the turn then decides is as above, on the words joined.

## The questions

With `noun: library card` on the slot `card`, the questions are `cardGiven`, `cardSpan` and `cardComplete`:

> `cardGiven`: Read asr.text. Does the caller state a library card number, either as digits or as spoken number words?

> `cardSpan`: Read asr.text. Which of these spans is the library card the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is a library card.

> `cardComplete`: Read asr.text. If the caller states a library card, do they finish saying the whole number rather than trailing off?

The span question's choices are the spans the engine found in the caller's words, and `none`, which means "No span of asr.text is a library card".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `keypad`, `ask_<slot>_dtmf`. With `lengthRetryPromptId`, that line. With `confirm: by-confidence`, `ack_<slot>`, given `{<slot>}` set to the display. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung with `keypad`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person. With `callerNumber`, `offer_<slot>`, given `{last4}`, the last four digits of the number the caller is calling from. `dialogwright check` requires each in every locale.

## Examples

The starter examples, listed below, are four configurations with starter utterances and keypad keys: an account number said back in groups of four, a library card acknowledged only when the model is less sure of it, a tracking number with its own pattern, and a slot keeping its recorded wording and ids. In an app's `slots.yaml`:

```yaml
account:
  type: digits
  noun: account
  length: 8
  keypad: true
  group: [4, 4]
```

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### account number

The defaults. Eight digits, said back in two groups of four, keyable on the keypad, masked by its last four digits.

```yaml
account:
  type: digits
  noun: account
  length: 8
  keypad: true
  group:
    - 4
    - 4
```

<details><summary>Starter utterances (10)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| my account is five five five zero seven seven eight eight | `accountGiven`: yes 0.95<br>`accountSpan`: `five five five zero seven seven eight eight` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | filled: value `55507788`, display `5550 7788`, confirm `implicit` |
| mi cuenta es cinco cinco cinco cero siete siete ocho ocho<br>_locale es_ | `accountGiven`: yes 0.95<br>`accountSpan`: `cinco cinco cinco cero siete siete ocho ocho` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | filled: value `55507788`, display `5550 7788`, confirm `implicit` |
| es el cincuenta y cinco cincuenta, setenta y siete ochenta y ocho<br>_locale es_ | `accountGiven`: yes 0.95<br>`accountSpan`: `cincuenta y cinco cincuenta setenta y siete ochenta y ocho` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | filled: value `55507788`, display `5550 7788`, confirm `implicit` |
| cinco cinco cinco cero<br>_locale es_ | `accountGiven`: yes 0.9<br>`accountSpan`: `cinco cinco cinco cero` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | invalid: reason `length`, raw `5550` |
| I want to change my address | `accountGiven`: yes 0.05<br>`accountSpan`: `none` 1<br>`accountComplete`: yes 0.4 | absent |
| it is five five five zero | `accountGiven`: yes 0.9<br>`accountSpan`: `five five five zero` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | invalid: reason `length` |
| it is five five five | `accountGiven`: yes 0.9<br>`accountSpan`: `five five five` 0.9, `none` 0.1<br>`accountComplete`: yes 0.2 | invalid: reason `incomplete` |
| Five.<br>_prompted_ | `accountGiven`: yes 0.9<br>`accountSpan`: `five` 0.9, `none` 0.1<br>`accountComplete`: yes 0.8 | invalid: reason `length`, raw `5` |
| Five. Five five two zero four one seven.<br>_prompted_ | `accountGiven`: yes 0.95<br>`accountSpan`: `five five five two zero four one seven` 0.9, `none` 0.1<br>`accountComplete`: yes 0.9 | filled: value `55520417`, display `5552 0417`, confirm `implicit` |
| it is on the tip of my tongue | `accountGiven`: yes 0.9<br>`accountSpan`: `none` 0.9, `tip` 0.1<br>`accountComplete`: yes 0.9 | invalid: reason `no_span` |

</details>

<details><summary>Keypad (2)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `55507788` | any | `55507788`, said `5550 7788` |
| `5550778#` | any | no value |

</details>

#### library card

A number acknowledged only when the model is less sure of it, refused when it is unsure, with its own re-ask when it is the wrong length.

```yaml
card:
  type: digits
  noun: library card
  length: 8
  keypad: true
  confirm: by-confidence
  readBack: below-fill
  minConfidence: SLOT_CHOICE_CONFIRM
  lengthRetryPromptId: ask_card_length
```

<details><summary>Starter utterances (5)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| five five five two zero four one seven | `cardGiven`: yes 0.95<br>`cardSpan`: `five five five two zero four one seven` 0.9, `none` 0.1<br>`cardComplete`: yes 0.9 | filled: value `55520417`, display `55520417`, confirm `none` |
| cinco cinco cinco dos cero cuatro uno siete<br>_locale es_ | `cardGiven`: yes 0.95<br>`cardSpan`: `cinco cinco cinco dos cero cuatro uno siete` 0.9, `none` 0.1<br>`cardComplete`: yes 0.9 | filled: value `55520417`, display `55520417`, confirm `none` |
| five five five two zero four one seven | `cardGiven`: yes 0.95<br>`cardSpan`: `five five five two zero four one seven` 0.5, `none` 0.5<br>`cardComplete`: yes 0.9 | filled: value `55520417`, display `55520417`, confirm `implicit` |
| five five five two zero four one seven | `cardGiven`: yes 0.95<br>`cardSpan`: `five five five two zero four one seven` 0.4, `zero four one seven` 0.35, `none` 0.25<br>`cardComplete`: yes 0.9 | invalid: reason `low_confidence` |
| five five five two zero four one | `cardGiven`: yes 0.95<br>`cardSpan`: `five five five two zero four one` 0.9, `none` 0.1<br>`cardComplete`: yes 0.9 | invalid: reason `length`, retryPromptId `ask_card_length` |

</details>

<details><summary>Keypad (2)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `55520417` | any | `55520417`, said `55520417` |
| `5552041x` | any | no value |

</details>

#### parcel tracking number

Ten digits starting with 9, said back as 3-3-4, shown in the trace as they are and handed over in full.

```yaml
tracking:
  type: digits
  noun: parcel tracking
  length: 10
  mask: ^9\d{9}$
  group:
    - 3
    - 3
    - 4
  keypad: true
  redact: none
  handoff: display
```

<details><summary>Starter utterances (3)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| nine two one five five five zero one four two | `trackingGiven`: yes 0.9<br>`trackingSpan`: `nine two one five five five zero one four two` 0.85, `none` 0.15<br>`trackingComplete`: yes 0.9 | filled: value `9215550142`, display `921 555 0142`, confirm `implicit` |
| nueve veintiuno cinco cinco cinco cero uno cuarenta y dos<br>_locale es_ | `trackingGiven`: yes 0.9<br>`trackingSpan`: `nueve veintiuno cinco cinco cinco cero uno cuarenta y dos` 0.85, `none` 0.15<br>`trackingComplete`: yes 0.9 | filled: value `9215550142`, display `921 555 0142`, confirm `implicit` |
| nine two one five five five zero one four two | `trackingGiven`: yes 0.9<br>`trackingSpan`: `two one five five five zero one four two nine` 0.85, `none` 0.15<br>`trackingComplete`: yes 0.9 | invalid: reason `mask` |

</details>

<details><summary>Keypad (2)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `9215550142` | any | `9215550142`, said `921 555 0142` |
| `1215550142` | any | no value |

</details>

#### existing wording and ids

A slot moved onto the library keeps the question text and ids it was recorded with, word for word. Every question is literal, so there is no noun.

```yaml
reference:
  type: digits
  length: 6
  text:
    given: Read asr.text. Does the caller give a booking reference, as digits or as number words?
    span: Read asr.text. Which of these spans is the booking reference the caller gives? Choose none if no span is one.
    none: No span of asr.text is a booking reference
    complete: Read asr.text. If the caller gives a booking reference, do they say all of it?
  ids:
    given: givesReference
    span: referenceSpan
    complete: referenceWhole
```

<details><summary>Starter utterances (3)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| four four one two zero nine | `givesReference`: yes 0.9<br>`referenceSpan`: `four four one two zero nine` 0.9, `none` 0.1<br>`referenceWhole`: yes 0.9 | filled: value `441209`, display `441209`, confirm `implicit` |
| cuarenta y cuatro doce cero nueve<br>_locale es_ | `givesReference`: yes 0.9<br>`referenceSpan`: `cuarenta y cuatro doce cero nueve` 0.9, `none` 0.1<br>`referenceWhole`: yes 0.9 | filled: value `441209`, display `441209`, confirm `implicit` |
| I have a reference somewhere | `givesReference`: yes 0.2 | absent |

</details>

## Notes

- Every slot listens on every turn, so the three questions are asked even while the form is on another slot, and "what do I have out on card 5552 0417" can fill the card on the opening turn.
- A keyed number counts as confirmed: it is not acknowledged or read back, whatever `confirm` says.
- The value is masked by its last four digits by default, in the trace and in a transfer's handoff. Turn that off (`redact: none`, `handoff: display`) only for a number that is no one's secret, such as a tracking number. Whether a transfer sends it at all is app.yaml's `handoff.data`: by default an identity factor is left out, and a redacted number goes by its last four.
- A short secret (a four-digit PIN, the last four of an identity number) takes `redact: length`: it is recorded only by how many digits it has (`<4 chars>`), its display too, and on the live console as well, since its display is the number itself. Its keys are masked as they are keyed, and a transfer hands over only its length, whatever `handoff.data` sends. Under `last4`, a number of four digits or fewer, whose last four would be all of it, is recorded as four bullets (`••••`) wherever it would show its last four, a transfer's handoff included; `dialogwright check` warns of a `last4` slot that can be that short and points to `length`.
- In a Spanish session (`es`, `es-*`) the spans offered are Spanish number words, and a span is read as Spanish: "cinco cinco cinco dos cero cuatro uno siete" and "cincuenta y cinco cincuenta y dos cero cuatro diecisiete" are both 55520417. The questions and the display are the same in every locale.
- `mask` is matched against the whole of the digits, as if written `^(?:mask)$`, so `5\d{3}` and `^5\d{3}$` are the same pattern; a mask written with `^` and `$` already means what it always did. A group that repeats a repeat, such as `(\d+)+`, is refused when the slot is defined, since such a pattern can take minutes to refuse a number that almost matches.
- `callerNumber` offers the number the caller is calling from, for a callback number: the line asks `offer_<slot>` ("Is the number you're calling from, ending in {last4}, the best one to reach you?") in place of `ask_<slot>`, once per form, and only on a call whose number fits the slot. A yes fills the slot with it, confirmed; a no asks `ask_<slot>` with no attempt counted; a number said instead fills as said. It is never identity: `dialogwright check` refuses it on an identity factor. The guide's "A callback number" has the whole of it.
- `callerNumber.onNo: skip` and `callerNumber.ifNone: skip` make the slot one the caller may decline, for an offer to text them: a no (or the end of the offer's retry ladder), and a call with no number to offer, leave the slot empty, declined, and the form goes on. The form's summary line may not name `{<slot>}`. The guide's "A text offer" has the whole of it.
- `callerNumber.answers: yes-no` makes the offer a yes or no question only, for a line such as "Are you calling from the phone on the account?": a number said at the offer is not taken, and with no clear yes it is a no (`onNo` says what follows); on the keypad 1 is yes and 2 is no. The default, `yes-no-or-value`, takes a number said or keyed in place of a yes, as before.
- On the phone the value is said back one digit at a time (`sayAs: digits`, the default): a voice reads "0142" as "one hundred forty-two" and an account number as a number in the millions, where the caller wants the digits they gave. Wherever a line says the value (its display in a read-back or a summary, a line worded by a model, a repeat of the last line, a line of the app's own code), the last four of the caller's number at its offer, or the consent to text, the voice is sent each digit, with a short pause between the display's groups ("5 5 5 0, 7 7 8 8"). Only the text sent to the voice is rewritten, after the app's `voice.spokenDigits` rules (a value they already spelled out is left as they spelled it): the session, the trace, the console, a chat and every regression baseline keep the value as written. `sayAs: number` leaves it to the voice, for a value that is a quantity rather than an identifier. The engine finds the value in a line by the value itself (the slot's value, its display, a read-back's, the last four offered), whole: never with a digit beside it, nor a digit across a `.`, `,`, `:`, `/` or `-` (a date, a time, an amount), and a value of fewer than five digits (a year, a last four) only where the decision's own variables say it (`{last4}` at an offer, `{<slot>}` in a read-back; a repeat of the offer too), never because the session holds it, so "born April 12, 1980" stays a date. A line needs no marking.
- A number said with a pause (`waitForRestMs`): a recognizer ends a prompt at a short pause, so a caller who reads a number out, says "five", and stops to look at the rest, sends the engine "Five." as a whole answer. Taken alone it is a miss, and its re-ask goes out as the caller goes on (a live call, 2026-10-13, Telnyx with the barge-in off: after a nine-digit miss, "Five." got the keypad line, the caller spoke over it 235 ms later, and Telnyx, which does not transcribe while a line it may not interrupt is playing, heard none of the rest). So when the slot the caller was just asked has a `length`, and a final prompt's words hold, read without the model (the spec's `startOfValue`), at least one digit and fewer than `length`, the voice server holds the words before any turn runs, up to `waitForRestMs` (default 1500). A prompt in that time is joined to them ("Five. Five five two zero four one seven." is 55520417), and while the words joined are still fewer digits the wait starts again, up to ten prompts; the caller heard speaking stops the clock until they stop (Telnyx), and a partial prompt starts it again (Twilio). With nothing more, or speech with no prompt after it, the words run alone; a key pressed runs them at once. One turn runs on the words as held, so nothing is said over the caller and nothing is undone, at every rung, the keypad line and the last attempt included. It is on every carrier; a chat, where a message comes whole, never waits; a slot with a `mask` and no `length` never waits, nor does a number as long as the slot's or longer. `0` takes the words at once. Why 1500: words of fewer digits than the number are certainly not a whole answer, so a wait costs only a miss taken a little later, and a caller reading a number pauses longer than one finishing a sentence (`INCOMPLETE_WAIT_MS`, for words the model reads as unfinished, is 1000). A carrier that hears more digits than were said (eight as nine, seen on the same calls) is refused and asked again, as before.
- Run its checks with `pnpm --filter dialogwright test slots/digits`.

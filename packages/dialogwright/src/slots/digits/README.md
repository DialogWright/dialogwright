# `digits`

A number of a fixed shape that no list holds: an account, a library card, a parcel tracking number.

The model never writes the number. It answers three questions about the caller's words: is a number stated, which span of the words is it (the engine finds the candidate spans, the model picks one), and was it said whole. The code turns the span into digits ("five five five two" becomes 5552, "double zero" becomes 00), checks them against a pattern, and decides whether they are a value. So the value is always something the caller said, and the code, not the model, says whether it is valid.

Reach for it for an identifier a caller reads out: a number of digits and nothing else. For a code with letters, a date, a name or a choice from a list, use the type made for it.

## Options

<!-- slot-docs:options -->

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

<!-- slot-docs:examples -->

## Notes

- Every slot listens on every turn, so the three questions are asked even while the form is on another slot, and "what do I have out on card 5552 0417" can fill the card on the opening turn.
- A keyed number counts as confirmed: it is not acknowledged or read back, whatever `confirm` says.
- The value is masked by its last four digits by default, in the trace and in a transfer's handoff. Turn that off (`redact: none`, `handoff: display`) only for a number that is no one's secret, such as a tracking number. Whether a transfer sends it at all is app.yaml's `handoff.data`: by default an identity factor is left out, and a redacted number goes by its last four.
- In a Spanish session (`es`, `es-*`) the spans offered are Spanish number words, and a span is read as Spanish: "cinco cinco cinco dos cero cuatro uno siete" and "cincuenta y cinco cincuenta y dos cero cuatro diecisiete" are both 55520417. The questions and the display are the same in every locale.
- `mask` is matched against the whole of the digits, as if written `^(?:mask)$`, so `5\d{3}` and `^5\d{3}$` are the same pattern; a mask written with `^` and `$` already means what it always did. A group that repeats a repeat, such as `(\d+)+`, is refused when the slot is defined, since such a pattern can take minutes to refuse a number that almost matches.
- `callerNumber` offers the number the caller is calling from, for a callback number: the line asks `offer_<slot>` ("Is the number you're calling from, ending in {last4}, the best one to reach you?") in place of `ask_<slot>`, once per form, and only on a call whose number fits the slot. A yes fills the slot with it, confirmed; a no asks `ask_<slot>` with no attempt counted; a number said instead fills as said. It is never identity: `dialogwright check` refuses it on an identity factor. The guide's "A callback number" has the whole of it.
- `callerNumber.onNo: skip` and `callerNumber.ifNone: skip` make the slot one the caller may decline, for an offer to text them: a no (or the end of the offer's retry ladder), and a call with no number to offer, leave the slot empty, declined, and the form goes on. The form's summary line may not name `{<slot>}`. The guide's "A text offer" has the whole of it.
- `callerNumber.answers: yes-no` makes the offer a yes or no question only, for a line such as "Are you calling from the phone on the account?": a number said at the offer is not taken, and with no clear yes it is a no (`onNo` says what follows); on the keypad 1 is yes and 2 is no. The default, `yes-no-or-value`, takes a number said or keyed in place of a yes, as before.
- Run its checks with `pnpm --filter dialogwright test slots/digits`.

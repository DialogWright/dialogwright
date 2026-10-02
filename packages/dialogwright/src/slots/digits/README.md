# `digits`

A number of a fixed shape that no list holds: an account, a library card, a parcel tracking number.

The model never writes the number. It answers three questions about the caller's words: is a number stated, which span of the words is it (the engine finds the candidate spans, the model picks one), and was it said whole. The code turns the span into digits ("five five five two" becomes 5552, "double zero" becomes 00), checks them against a pattern, and decides whether they are a value. So the value is always something the caller said, and the code, not the model, says whether it is valid.

Reach for it for an identifier a caller reads out: a number of digits and nothing else. For a code with letters, a date, a name or a choice from a list, use the type made for it.

## Options

| Option | Default | What it does |
|---|---|---|
| `noun` | none | What the number identifies, as a noun without "number" ("account", "library card", "parcel tracking"). The default questions say "a library card number". Needed unless `text` gives every question in its own words. |
| `article` | `a`, or `an` before a vowel | The word before the noun in the default questions. |
| `length` | none | How many digits the number has. Gives the default `mask` (exactly this many digits) and the length of the keypad rung. Needed unless `mask` is given. |
| `mask` | exactly `length` digits | A regular expression (its source, no slashes) the digits must match, such as `^9\d{9}$`. A number that fails it is `invalid` with the reason `mask`; with only `length`, the reason is `length`. |
| `keypad` | `false` | The caller can key the number, `length` digits at a time. Needs `length` and an `ask_<slot>_dtmf` line. |
| `group` | all together | How the number is said back, in groups of these sizes (`[4, 4]` says 5550 7788). The last group takes any digits left over. Must add up to `length`. |
| `confirm` | `summary` | `summary`: a spoken number is neither acknowledged nor read back on its own; the form's final confirm covers it. `by-confidence`: it is acknowledged (`ack_<slot>`) when `readBack` says so. |
| `readBack` | `implicit` | What a filled number asks for: `implicit` (always), `below-fill` (only when the model is less sure of the span than `SLOT_CHOICE_FILL`), `none` (never). Only with `confirm: by-confidence`. |
| `minConfidence` | `none` | A floor on how sure the model must be of the span: one of `SLOT_DETECT`, `SLOT_CHOICE_CONFIRM`, `SLOT_CHOICE_FILL`. Below it the number is `invalid` with the reason `low_confidence`. |
| `lengthRetryPromptId` | none | The prompt that re-asks, in place of the generic `ask_<slot>_retry`, when what the caller said does not fit the pattern ("A card number has eight digits."). |
| `redact` | `last4` | How the value is masked wherever it leaves the turn (the trace, a tool call's param of the same name): `last4` ("...0417") or `none`. |
| `handoff` | `last4` | What a transfer to a person hands over: the `last4`, only whether the caller was `verified`, or the `display` in full. |
| `text` | none | A literal for any of the four question texts, `given`, `span`, `none` and `complete`, sent to the model exactly as written, in place of the default. One line. |
| `ids` | none | A question id for `given`, `span` or `complete` in place of `<slot>Given`, `<slot>Span` and `<slot>Complete`, to keep the ids an existing slot was recorded with. |

The slot is always `detect: true`: its row in the console is measured against `SLOT_DETECT`.

## The outcome

| What the caller said | The outcome |
|---|---|
| No number (the first question is below `SLOT_DETECT`) | `absent`, so a turn about something else leaves the slot alone |
| A number, trailed off (the third question is below `SLOT_DETECT`) | `invalid`, reason `incomplete` |
| A number, no span chosen | `invalid`, reason `no_span` |
| A span the model is less sure of than `minConfidence` | `invalid`, reason `low_confidence` |
| Digits that do not fit the pattern | `invalid`, reason `mask` or `length`, with `lengthRetryPromptId` when it is set |
| Digits that fit | `filled`: the value is the digits, the display is the digits in `group`s, and `readBack` says what it asks for |

## The questions

With `noun: library card` on the slot `card`, the questions are `cardGiven`, `cardSpan` and `cardComplete`:

> `cardGiven`: Read asr.text. Does the caller state a library card number, either as digits or as spoken number words?

> `cardSpan`: Read asr.text. Which of these spans is the library card the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is a library card.

> `cardComplete`: Read asr.text. If the caller states a library card, do they finish saying the whole number rather than trailing off?

The span question's choices are the spans the engine found in the caller's words, and `none`, which means "No span of asr.text is a library card".

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `keypad`, `ask_<slot>_dtmf`. With `lengthRetryPromptId`, that line. With `confirm: by-confidence`, `ack_<slot>`, given `{<slot>}` set to the display. `dialogwright check` requires each in every locale.

## Examples

`examples.yaml` beside this file has four configurations with starter utterances and keypad keys: an account number said back in groups of four, a library card acknowledged only when the model is less sure of it, a tracking number with its own pattern, and a slot keeping its recorded wording and ids. In an app's `slots.yaml`:

```yaml
account:
  type: digits
  noun: account
  length: 8
  keypad: true
  group: [4, 4]
```

## Notes

- Every slot listens on every turn, so the three questions are asked even while the form is on another slot, and "what do I have out on card 5552 0417" can fill the card on the opening turn.
- A keyed number counts as confirmed: it is not acknowledged or read back, whatever `confirm` says.
- The value is masked by its last four digits by default, in the trace and in a transfer's handoff. Turn that off (`redact: none`, `handoff: display`) only for a number that is no one's secret, such as a tracking number.
- Run its checks with `pnpm --filter dialogwright test slots/digits`.

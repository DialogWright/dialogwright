# An extraction model beside the decision model: Clairic, measured

Date: 2026-10-20. Status: **measured; parked until an app needs amounts, addresses or photos.**

## What it is

Cloudflare's Clairic (`@cf/cloudflare/clairic` on Workers AI, in preview) is a System One extraction model: it reads a text (and up to four images) and returns typed fields in one pass, with no generated text. A field is `text` (a span of the input, with its character offsets), `number` (with `decimals` and a `unit`), `date`, `time`, `datetime`, `duration`, `list`, `estimate` or `forecast`, each with plain-language instructions; each answer carries its `value` (null when the input does not determine it), a `guess`, `p_null` (the probability the value is not in the input) and a `confidence`. A `reference_date` anchors a date said without a year and a relative one ("next Tuesday"). It is billed on input tokens only.

DialogWright gets the same values another way: a slot's code finds the candidates (the spans of a date, a number, a name), the decision model answers typed questions about them (which span is the year, which words are the caller's own name), and the code builds and checks the value. The question was whether an extraction model does that better, faster, or for values no slot type has.

## Measured

**The slot library's examples** (118 utterances of the `date`, `birthdate`, `digits`, `name` and `text` types, each with its configuration and the outcome it must give; utterances that depend on an earlier turn left out). Today's slots asked their own questions of the decision model live, with a turn state as a call sends it, and filled from its answers; Clairic was asked one field of the matching type, the slot's context as its instructions and the kit's today as its reference date.

| | The slot (decision model and code) | Clairic |
|---|---|---|
| Right, of 118 | **103** | 58 |
| Of the 62 that give a value | **55** | 34 |
| Request time, p50 / p95 | **83 / 187 ms** | 219 / 500 ms |

Part of the gap is the comparison's: a slot's own rules (a day in the past, a number's length, nothing taken before the question is asked) live in its code, which a one-shot extractor does not have, and the examples were written beside the slots' code. The part that is not is dictation: a date said digit by digit ("eight twenty one eighty four" read as 1824), digits dropped from a number said one by one, Spanish digit words. That is the spoken input a phone line is made of, and the slots' code is built for it. Clairic was right where the slot was wrong twice, both a phrase inside a sentence ("twelve oak hollow road").

**The values no slot type has** (31 utterances, typed as on a chat and spoken as on a call):

| | Typed | Spoken |
|---|---|---|
| A street address | 4 of 4 | 4 of 4 ("nine oh five pine street near the school") |
| An amount of money (`number`, `unit: USD`) | 3 of 3 | 6 of 6 ("two thousand three hundred forty dollars and fifty cents", "forty five ninety nine") |
| A code with letters (a booking code, a serial number, a tracking number) | 4 of 5 | 0 of 4 |
| An email address | 2 of 2 | 0 of 3 |

The spoken codes and emails are mostly the right span said as it was spoken ("f s seven k two q", "m o r g a n at example dot com"): a `text` answer is a span of the input, never rewritten, so turning it into `FS7K2Q` is the spoken-to-written step a slot's code already takes for digits. Two found the wrong span ("f as in frank ...", and the "A" of "A B four four seven one").

## What it suggests

Clairic reads numbers in natural phrasing well and dictation poorly; it is built for documents, emails and reports, and is strongest on values inside a sentence. Two places it may fit, neither built:

1. **Slot types for the values with no type**, `amount` and `address`, each taking its value from an extraction model the app turns on per slot, asked beside the decision model's request on the turn (never after it, which would add its time to the turn), with the slot's code checking the value and the read-back confirming it as any slot's does. A code with letters would take the extraction model's span and the code's spoken-to-written step.
2. **A tool that reads a photo**: a caller texts a picture of a bill, an insurance card or a serial number's label, and the values it carries fill slots. Documents with typed text are the model's own ground; the decision model's own vision (new in Jev's latest release) would be measured on the same photos first.

An extraction model would be an app's choice, as the render model is: one more processor of what callers say, named in the app's settings, with its key in the environment only.

## Not now

Either of the above until an app needs it; and replacing any slot's extraction, which the measurement does not support.

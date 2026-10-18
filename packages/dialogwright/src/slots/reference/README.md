# `reference`

A code of letters and digits of a set length, such as a booking code ("KEVHUD") or an order reference: what a business reads out to a customer and asks for again later. Reach for it when the caller states such a code. For one of digits only, use `digits`; for one of the caller's own records the app has looked up, use `record`.

Code reads the caller's words for every span that spells a reference of the slot's `length` from its `alphabet`: typed ("KEVHUD", "k7m4qx"), spelled one character at a time ("K E V H U D"), by letter names ("kay ee vee"), by the spelling alphabet ("kilo echo victor", "K as in kilo"), with digit words ("seven"), and "double" or "triple" before a character; in Spanish (`es`, `es-*`) its letter names ("ka", "eme", "equis") and digit words. The model is asked whether the caller states the reference, and which of those spans it is; code reads the span chosen and checks it, so the value is always something the caller said and the model never writes it.

## Options

<!-- slot-docs:options -->

`alphabet` is the characters a reference may hold. A business whose codes leave out the characters that sound or look alike (no 0, 1, I, L or O, so "ABCDEFGHJKMNPQRSTUVWXYZ23456789") should say so: a span that names one of them is no reference, and where the alphabet holds only one of a pair, a word for the other is read as the one it holds ("oh" is 0 when the alphabet has no O).

## The outcome

| What the caller said | The outcome |
|---|---|
| No reference (`given` below SLOT_DETECT) | `absent` |
| A reference stated, but no span chosen | `invalid`, reason `no_span` |
| A span that does not read as a reference of the slot's length and alphabet | `invalid`, reason `shape` |
| A span that does | `filled`: the value is the characters ("KEVHUD"), the display them one at a time ("K E V H U D"), so a voice spells it back |

## The questions

On the slot `bookingCode`, `bookingCodeGiven` (yes or no: does the caller state a booking code) and `bookingCodeSpan` (a choice among the spans code read as a reference, and `none`). The span question offers only spans of the slot's length from its alphabet, so with nothing of that shape in the words it offers only `none`.

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display.

## Examples

<!-- slot-docs:examples -->

## Notes

- Masked by its length by default (`redact: length`): a short reference's last four characters would show most of it.
- A reference is no secret: it is said back, in the summary and as its display. For one the caller must keep to themselves, use a `digits` slot with `redact: length`.

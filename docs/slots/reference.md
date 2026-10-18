# `reference`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/reference/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

A code of letters and digits of a set length, such as a booking code ("KEVHUD") or an order reference: what a business reads out to a customer and asks for again later. Reach for it when the caller states such a code. For one of digits only, use `digits`; for one of the caller's own records the app has looked up, use `record`.

Code reads the caller's words for every span that spells a reference of the slot's `length` from its `alphabet`: typed ("KEVHUD", "k7m4qx"), spelled one character at a time ("K E V H U D"), by letter names ("kay ee vee"), by the spelling alphabet ("kilo echo victor", "K as in kilo"), with digit words ("seven"), and "double" or "triple" before a character; in Spanish (`es`, `es-*`) its letter names ("ka", "eme", "equis") and digit words. The model is asked whether the caller states the reference, and which of those spans it is; code reads the span chosen and checks it, so the value is always something the caller said and the model never writes it.

## Options

A slot of this type is written under its id in slots.yaml, with `type: reference` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `noun` | string | unset | What the reference is, as a noun ("booking code", "order reference"). The default questions say "a `<noun>`". Needed unless text gives every question in its own words. |
| `article` | string | unset | The word before the noun in the default questions. Default: "an" when the noun starts with a vowel, otherwise "a". |
| `length` | integer, 1 to 20 | required | How many characters the reference has. |
| `alphabet` | string | `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` | The characters a reference may hold, capital letters and digits. Where it leaves out one of a pair that sound or look alike (O and 0, I and 1), a word said for either is read as the one it holds ("oh" is 0 when it has no O). Default: every letter and digit. |
| `confirm` | one of `summary`, `always` | `summary` | "summary": the reference is neither acknowledged nor read back on its own; the form's final confirm covers it. "always": a reference is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`, or `ask_<slot>_dtmf` at the keypad rung where the slot takes keys), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `redact` | one of `last4`, `length`, `none` | `length` | How the value is masked wherever it leaves the turn (the trace, the console, the audit, a tool call's param of the same name): "length" (only how many characters, "&lt;6 chars&gt;": a short reference's last four would show most of it), "last4" ("...4QX7") or "none". |
| `handoff` | one of `last4`, `verified`, `display` | `display` | What a transfer to a person hands over: its "display" in full, its "last4", or only whether the caller was "verified". app.yaml's handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: given, span, none. |
| `ids` | map | unset | Question ids in place of the defaults (the slot's id followed by the part: given, span), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |
| `askedOf` | list of string | unset | The callers the slot is asked of: principal kinds as identity.yaml names them (the subject kind, or a delegate kind such as broker), or a delegate kind and one of its roles (broker.office_admin). For any other caller the slot is not part of its forms: its question is not sent, it is not asked, and its form completes without it (a caller not yet verified is no kind listed but anonymous, which may not be listed). Use it for what only some callers need to say, such as which client a delegate is asking about. Never on an identity factor; pnpm check refuses a kind or a role identity.yaml does not have. Default: every caller. |
| `attempts` | integer, 1 to 10 | `3` | How many failed answers the slot takes before onMaxAttempts, 1 to 10. Each failure before the last but one re-asks: a missed answer with `ask_<slot>_retry`, or `ask_<slot>_retry2` at the second failure (and so on) where prompts.yaml has it; a silence with `ask_<slot>_noinput2` (and so on), else `ask_<slot>_noinput`, else no_input then the question (`ask_<slot>`) again (at the keypad rung of a slot that takes no keys, on a channel with a keypad, no_input then its retry line). The last but one is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad, else another re-ask; the last runs onMaxAttempts. Default: the engine's MAX_ATTEMPTS (3). |
| `onMaxAttempts` | one of `handoff`, `skip` or map | `handoff` | What happens when the slot runs out of attempts (a missed answer, a silence, an unanswered read-back, or a second no to its read-back). "handoff" (the default): to a person, with handoff_max_attempts. "skip": the slot is left empty and declined, and the form goes on; never on an identity factor, nor on a slot its form's summary names. Or written out, { say, then, reason, form, goodbye }: then is handoff (reason names the handoff, default max-attempts), skip, end (say required; the call ends, the goodbye after the line unless goodbye: false), anything-else (say required; the form closes uncompleted and "anything else?" is asked) or form (the form closes uncompleted and `form` is entered, keeping the slots both list); say, a prompt said first. An offer of the caller's number with onNo: skip that runs out leaves the slot empty whatever this says; with no onNo: skip, the slot's ladder goes on to it. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.given` | The yes-or-no question that asks whether the caller states the reference at all. Variables: `{article}`, `{noun}`. | `Read asr.text. Does the caller state {article} {noun}, as letters and numbers typed or spoken one at a time, by letter names, or by words such as "K as in kilo"?` |
| `text.span` | The question that asks which span of the caller's words is the reference. Its choices are the spans the engine reads as one, and none. Variables: `{article}`, `{noun}`. | `Read asr.text. Which of these spans is the {noun} the caller states? Choose the span that covers the whole of it as said, and nothing else. Choose none if no span is {article} {noun}.` |
| `text.none` | What the span question's "none" choice means. Variables: `{article}`, `{noun}`. | `No span of asr.text is {article} {noun}` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.given` | The id of the question that asks whether the caller states the reference. |
| `ids.span` | The id of the question that asks which span of the caller's words is the reference. |

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

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### booking code

Six characters from an alphabet that leaves out the ones that sound or look alike (no 0, 1, I, L or O), typed or said in any of the ways a caller spells.

```yaml
bookingCode:
  type: reference
  noun: booking code
  length: 6
  alphabet: ABCDEFGHJKMNPQRSTUVWXYZ23456789
```

<details><summary>Starter utterances (7)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| my code is KEVHUD | `bookingCodeGiven`: yes 0.95<br>`bookingCodeSpan`: `kevhud` 0.92, `none` 0.08 | filled: value `KEVHUD`, display `K E V H U D`, display in es `K E V H U D` |
| it's K seven M four Q X | `bookingCodeGiven`: yes 0.93<br>`bookingCodeSpan`: `k seven m four q x` 0.9, `none` 0.1 | filled: value `K7M4QX` |
| kay seven em four queue ex | `bookingCodeGiven`: yes 0.9<br>`bookingCodeSpan`: `kay seven em four queue ex` 0.88, `none` 0.12 | filled: value `K7M4QX` |
| K as in kilo, E as in echo, V, H, U, D | `bookingCodeGiven`: yes 0.92<br>`bookingCodeSpan`: `k as in kilo e as in echo v h u d` 0.9, `none` 0.1 | filled: value `KEVHUD` |
| es ka siete eme cuatro cu equis<br>_locale es_ | `bookingCodeGiven`: yes 0.9<br>`bookingCodeSpan`: `ka siete eme cuatro cu equis` 0.88, `none` 0.12 | filled: value `K7M4QX`, display `K 7 M 4 Q X` |
| I don't have it with me | `bookingCodeGiven`: yes 0.05<br>`bookingCodeSpan`: `none` 1 | absent |
| it's K seven M four<br>_prompted_ | `bookingCodeGiven`: yes 0.8<br>`bookingCodeSpan`: `none` 1 | invalid: reason `no_span` |

</details>

#### order reference

The defaults, eight characters of any letter or digit, masked by its last four.

```yaml
order:
  type: reference
  noun: order reference
  length: 8
  redact: last4
```

<details><summary>Starter utterances (2)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the order is AB12CD34 | `orderGiven`: yes 0.95<br>`orderSpan`: `ab12cd34` 0.9, `none` 0.1 | filled: value `AB12CD34`, display `A B 1 2 C D 3 4`, display in es `A B 1 2 C D 3 4` |
| double A one two three four five six | `orderGiven`: yes 0.9<br>`orderSpan`: `double a one two three four five six` 0.9, `none` 0.1 | filled: value `AA123456` |

</details>

## Notes

- Masked by its length by default (`redact: length`): a short reference's last four characters would show most of it.
- A reference is no secret: it is said back, in the summary and as its display. For one the caller must keep to themselves, use a `digits` slot with `redact: length`.

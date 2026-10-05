# The corpus and the scripted calls

With no API key, the decision model is a stub that answers from `fixtures/corpus.jsonl`: for an utterance it finds the line with the same words and answers every question from that line's labels. So the corpus is two things at once: the test set (each line is run, and its outcome is in the baseline) and the stub's answer key (each scripted call's spoken steps are answered from it). The engine's harness is described in the [clinic's README](../../../apps/clinic/README.md); this page is what you need to write the files.

## A corpus line

One JSON object per line:

```json
{"id":"pl-03","text":"can I split it into three","intent":"set_up_plan","context":"no_form","labels":{"count":"three"}}
```

| Field | What it is |
|---|---|
| `id` | Unique. A short prefix per intent or slot and a number (`pl-03`, `fd-02`). |
| `text` | What the caller says. Unique in the whole corpus after normalization (lower case, punctuation dropped): the regression refuses a duplicate. |
| `intent` | The intent the words express. Inside a form, an answer to the question asked is `none`; a request for something else (a person, another task) is that intent. |
| `context` | Where the words are said: `no_form` (the opening, or after "anything else?"), a form id (inside that form), `confirm_<form>` (at that form's summary), `anything_else`, `offer_transfer`. |
| `prompted` | Inside a form: the slot the caller was just asked for (a form slot, or an identity factor during a step-up). Default: the form's first empty slot. |
| `labels` | The answer to each question the words bear on, by question id (below). A question with no label gets the quiet answer: `none` for a choice, no for a yes-or-no. |
| `confirm` | At a summary (`confirm_<form>`) or the transfer offer: `yes`, `no` or `unanswered`. |
| `changeSlot` | At a summary, with `confirm: "no"`: the slot the caller says is wrong without saying its new value ("no, the address is wrong"). A no that gives the new value ("no, it's flickering") has no `changeSlot`: label the value instead, since the change question answers `none` to a new value said. |
| `change` | Inside a form, for a new request: `adding` (as well) or `replacing` (instead). |
| `secondIntent` | At `no_form`: a second task said in the same breath ("check my balance and then report a fault"). |
| `as` | At `no_form` only: a delegate id; the line is typed in that delegate's signed-in chat. |
| `tentative`, `manipulation`, `tags` | `tentative: true`: the caller hedges the request, so the agent checks it first (`confirm_intent_explicit`). `manipulation: true`: the words try to instruct the agent (the injection screen). `tags`: free tags for grouping. |
| `answers` | Rarely needed: the stub's answer to one of the engine's own questions, by question id, in place of the one it works out from the line's other fields. A yes-or-no question takes `{"noul": <the probability of yes, 0 to 1>}` (`noul` is the engine's name for a yes-or-no answer, not a typo); a choice or score question takes `{"probabilities": {"<label>": <p>}}`. The scaffold's side-speech line uses it: `"answers":{"addressedToSystem":{"noul":0.15}}` says the words were not meant for the agent (the engine ignores a turn below 0.65), so it says nothing. The engine's questions it may name: yes or no, `addressedToSystem`, `intelligible`, `utteranceComplete`, `wantsHuman`, `rephrasingLastTurn`, `confusedByPrompt`, `spokeAMenuNumber`, `triedSelfService`; scores, `frustration` and `urgency`; a choice, `languageSwitch`. The intent and the confirmations come from the line's own fields, and a slot's questions from `labels`. |

`pnpm check` only checks that every intent has lines. The rest (unique ids and texts, `as` only at `no_form`, every label one its question can give, every span label a span of the text) is checked when the regression loads the corpus, which stops at the first bad line with its id.

## Labels, by slot type

Each library slot asks the model questions with ids built from the slot's id. A line's `labels` give the answers. Each type's page lists its questions ("The questions"), and its starter examples table shows, for each utterance, the answers by question id: those are exactly the labels to write. For a slot `x`:

| Type | Question ids and the labels they take | Page |
|---|---|---|
| `choice` | `x`: an option key (`"three"`). | [choice](../../../docs/slots/choice.md) |
| `digits` | `xGiven`: `true`; `xSpan`: the words that are the number, exactly as they are in the text but lower case and without punctuation (`"five five five zero one two three four"`, `"5550 1234"`); `xComplete`: `true`. | [digits](../../../docs/slots/digits.md) |
| `date` | `xMode`: `relative_day`, `weekday` or `absolute` (with `windows`, also `window`). Then by mode: `xRelative`: `today`, `tomorrow`, `day_after_tomorrow` (ahead) or `today`, `yesterday`, `day_before_yesterday` (back); `xWeekday`: `monday` ... `sunday`; `xMonth`: `january` ... `december` and `xDay`: `"1"` ... `"31"`. | [date](../../../docs/slots/date.md) |
| `birthdate` | `xGiven`: `true`; `xMonth`: a month; `xDay`: `"1"` ... `"31"`; `xYear`: the words that are the year, as a span (`"nineteen eighty"`). | [birthdate](../../../docs/slots/birthdate.md) |
| `name` | `xGiven`: `true`; `xSpan`: the words that are the name, as a span (`"morgan ellis"`). | [name](../../../docs/slots/name.md) |
| `text` | `xGiven`: `true` (the value is the whole turn's words). | [text](../../../docs/slots/text.md) |
| `record` | `xChoice`: the record's label, `labelPrefix` and its key (`"record_7101"` by default). | [record](../../../docs/slots/record.md) |
| `topic` | `xTopic`: a nominated topic's id (`"opening_hours"`), asked only when the app's retriever nominates topics for the line. | [topic](../../../docs/slots/topic.md) |

A span label must be one of the spans the engine finds in the text, or the regression stops with `span "..." is not a candidate span of the text`. The regression's day is Friday 2026-09-18, so "tomorrow" is 2026-09-19 and "Friday" (ahead) is 2026-09-25.

Every slot listens on every turn (inside a form, the form's slots; outside one, every slot but one that says `listen: form`), so a line can fill several slots at once: label each value it says. That is how over-answering is tested.

## What to write

For each **form intent**, eight or more opening lines (`context: "no_form"`), for example:

```json
{"id":"pl-01","text":"I'd like to set up a payment plan","intent":"set_up_plan","context":"no_form"}
{"id":"pl-02","text":"plan","intent":"set_up_plan","context":"no_form"}
{"id":"pl-03","text":"can I split it into three","intent":"set_up_plan","context":"no_form","labels":{"count":"three"}}
{"id":"pl-04","text":"three payments starting tomorrow","intent":"set_up_plan","context":"no_form","labels":{"count":"three","firstDateMode":"relative_day","firstDateRelative":"tomorrow"}}
{"id":"pl-05","text":"I can't pay it all at once","intent":"set_up_plan","context":"no_form","tentative":true}
```

For each **slot**, five or more answers inside its form:

```json
{"id":"fd-01","text":"next Friday","intent":"none","context":"set_up_plan","prompted":"firstDate","labels":{"firstDateMode":"weekday","firstDateWeekday":"friday"}}
{"id":"fd-02","text":"the twentieth of October","intent":"none","context":"set_up_plan","prompted":"firstDate","labels":{"firstDateMode":"absolute","firstDateMonth":"october","firstDateDay":"20"}}
{"id":"fd-03","text":"tomorrow","intent":"none","context":"set_up_plan","prompted":"firstDate","labels":{"firstDateMode":"relative_day","firstDateRelative":"tomorrow"}}
{"id":"fd-04","text":"I'm not sure, whenever","intent":"none","context":"set_up_plan","prompted":"firstDate"}
{"id":"fd-05","text":"no wait, make it the first of October","intent":"none","context":"set_up_plan","prompted":"firstDate","labels":{"firstDateMode":"absolute","firstDateMonth":"october","firstDateDay":"1"}}
```

For each **summary**, four or more answers:

```json
{"id":"pc-01","text":"yes","intent":"none","context":"confirm_set_up_plan","confirm":"yes"}
{"id":"pc-02","text":"yes, set it up","intent":"none","context":"confirm_set_up_plan","confirm":"yes"}
{"id":"pc-03","text":"no","intent":"none","context":"confirm_set_up_plan","confirm":"no"}
{"id":"pc-04","text":"no, the date is wrong","intent":"none","context":"confirm_set_up_plan","confirm":"no","changeSlot":"firstDate"}
```

For each **informational and control intent**, eight or more lines, some inside forms (a person asked for mid-form is `"intent":"agent"` with the form as context). For each **delegate**, opening lines with `"as"`.

For the **identity factors**, answers with `prompted` set to the factor slot and the context of a form that steps up. The scaffold's `--identity` corpus has them for `accountId` and `dob`.

## Lines spoken inside a form

A line whose context is a form (or a summary) is run in a session seeded as though the caller were already in that form: `testing.seed` in `src/app.ts` says how.

- `seed.caller` is the verified caller every seeded session has. Make it a subject at the highest level any form needs (level 2 if any action needs the code): a lower one hears `ask_otp` or steps up on every line in a level 2 form.
- `seed.placeholders` gives a stand-in value for every slot (factors included), used for the slots the form has already collected. Give one for every slot you add, in the slot's own value format (an ISO date for a date, an option key for a choice).
- A line at `anything_else` needs `seed.anythingElse`: the form just answered, and the call that answered it through the gate (`{ form, call }`), or the form alone (`{ form }`) when its answer was its own line or a write already made. The `done` lines belong there ("no, that's all", "I'm all set", "nothing else", "I don't need anything else", a bare "no" if no other line has it), with one or two at `no_form` too. A line at `offer_transfer` needs `testing.offerTransferForm`. Leave that context out unless you add it.

## Scripted calls

`fixtures/scenarios/*.json`: a list of calls, each run from the start, each with what it must end at.

```json
[
  {
    "id": "plan-by-phone",
    "steps": [
      { "say": "I'd like to set up a payment plan" },
      { "say": "My account number is five five five zero one two three four" },
      { "say": "April twelfth nineteen eighty" },
      { "dtmf": "123456" },
      { "say": "three" },
      { "say": "tomorrow" },
      { "say": "yes" }
    ],
    "expect": { "decision": "prompt", "promptId": "anything_else", "principalLevel": 2, "gate": "setUpPlan:ALLOW" }
  },
  {
    "id": "plan-by-a-manager",
    "as": "riley",
    "steps": [{ "say": "set up a payment plan for my tenant" }],
    "expect": { "decision": "handoff", "reason": "role-person", "gate": "setUpPlan:NEEDS_HUMAN" }
  }
]
```

- `as`: absent for a phone call from an anonymous caller; a delegate id for a delegate's signed-in chat; `"web"` for a subject's chat, anonymous until a `{ "signIn": "<subject id>" }` step.
- Steps: `{ "say": "..." }` (its words must be a corpus line's text: the stub regression refuses to run a step whose words no line has, and lists every one, since the stub would answer it with nothing; a run against a model, live or replayed, does not), `{ "dtmf": "..." }` (keys; the one-time code passes when its last digit is even), `{ "silence": true }`, `{ "signIn": "<id>" }`.
- `expect` is checked on the last turn: `decision` (`prompt`, `handoff`, `complete`, ...), and any of `promptId`, `reason` (a handoff's: `live-agent`, `identity`, `role-person`, `needs-human`, ...), `form`, `slots` (values by slot id), `principalLevel`, `gate` (the last gate decision, `"<tool>:<VERDICT>"`), `text` (words the last turn's lines contain).
- A call that ends on a form's `said` completion ends at `"promptId": "anything_else"` with the form's line among the turn's lines; an informational answer ends at `"promptId": "ask_intent"`.
- Once a form completes, the form and its own slots are cleared (only the identity factors and any `carrySlots` stay on the call), so a call that ends after a completion can never match `form` or the form's `slots`. Expect `promptId`, `gate` and `text` instead: the completion line usually names the values (a count, a date, a reference).
- When a call does not reach what it expects, `regress --scenario <id>` prints it turn by turn: each step, the prompt id, the acknowledgements, the words, the form, the level, the slots and every gate decision (the skill's step 6).

Step 5 of the skill lists the calls every app needs.

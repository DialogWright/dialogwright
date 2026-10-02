# Known gaps

A known gap is an utterance where the real perception model, in a recorded run, reads a borderline case differently from what the caller meant. Each one is tagged in its app's corpus with the reason and the outcome the model is known to produce, so recorded replays tolerate that outcome and print it, while stub runs stay exact:

```json
{"id":"ag-02","text":"Agent", ..., "knownGap":{"reason":"a single word 'Agent': ... same handoff","outcome":{"decidedGate":"intent"}}}
```

The pin is the baseline's outcome with `outcome`'s fields overlaid. If the model does anything else on the entry (a different prompt, a different gate call), the run fails as for any other entry; if it matches the baseline, the run says `knownGap now matches`. None of the current gaps leads to a wrong action: each ends in a re-ask, a different but reasonable question, or a person.

This page lists them so they can be closed later. They are not blocking.

## A design note: terse callers

Almost every gap below is a short utterance: a single word, a number, a bare name, a fragment. That is how decades of keypad and keyword phone systems taught people to talk, and the framework should meet callers there rather than coach them to say more. The usual fix is context, not a better model: the engine always knows what it just asked, so a bare answer can be read against it (a lone name at a summary is a correction to the slot that holds names; a number while a menu is offered is a menu choice, and one that is not on the menu is a no-match). Where code can decide from context, it should; the model's judgment is an input, not the decision.

## Clinic (`apps/clinic`)

| Entry | Utterance | What happens | Caller impact | Category | Candidate fix |
|---|---|---|---|---|---|
| ag-02 | "Agent" | wantsHuman 0.49 is below 0.7; the intent gate (agent 0.72) routes instead | None: same handoff | Same outcome, different gate | Keep as a permanent known gap |
| ns-06 | "so my appointment" (unfinished) | confirm_appointment 0.76 routes although utteranceComplete is 0.23 | Asked for their name early instead of re-prompted | Fragment | Weigh utteranceComplete before routing on a low-margin intent |
| fc-13 | corrected name at the summary | changeSlot name 0.60, on the 0.6 threshold, decides instead of a plain rejection | None: same prompt and slots | Threshold borderline | Threshold sweep across apps' recordings |
| fc-17 | "Cheng, not Chen" at the summary | changeSlot name 0.60 clears the name instead of changing the provider | Asked for their name again; provider correction missed | Correction, borderline | Contextual rule for named corrections; sweep |
| fc-19 | "it's Cheng" (bare surname) at the summary | provider none 0.77; confirmsNo 0.45 below 0.7; the short summary is re-read | Correction not applied; caller must repeat | Terse correction | A bare provider name at a summary is a provider correction (code rule), with paraphrase tests |
| fc-23 | corrected birth date at the summary | changeSlot dob 0.92 decides instead of a plain rejection | None: same prompt and slots | Same outcome, different gate | Keep, or align the gate order |

Recorded run at the time of writing: corpus 235/241 matching plus these 6 allowed; scenarios 89/89 pass and match.

## How to close one

Each fix changes what the model is asked or how an answer is used, so: make the change, re-record the affected app (a few cents), review the drift, and remove the entry's `knownGap` once it matches. A threshold change goes through the sweep against more than one app's recordings, so a value is not tuned to one app's quirks.

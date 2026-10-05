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
| ag-02 | "Agent" | addressedToSystem 0.60 to 0.65, on the 0.65 gate; wantsHuman 0.49 is below 0.7. At 0.65 the intent gate (agent 0.72) hands off; at 0.60 the turn is ignored | Ignored: no answer to a request for a person | Terse request, borderline | A bare request for a person (agent, representative, operator) counts for wantsHuman: sharpen its wording, then re-record |
| lc-05 | "Change it" (vague) | injection screen 0.47 to 0.50, on the 0.5 gate; at 0.50 the screen re-asks | Minor: re-asked what they want, as nomatch_open would | Threshold borderline | Name a bare "change it" in the screen's false criterion, then re-record |
| ns-06 | "so my appointment" (unfinished) | confirm_appointment 0.76 routes although utteranceComplete is 0.23 | Asked for their name early instead of re-prompted | Fragment | Weigh utteranceComplete before routing on a low-margin intent |
| fc-19 | "it's Cheng" (bare surname) at the summary | provider none 0.77; confirmsNo 0.45 below 0.7; the short summary is re-read | Correction not applied; caller must repeat | Terse correction | A bare provider name at a summary is a provider correction (code rule), with paraphrase tests |

Recorded run at the time of writing: corpus 245/249 matching plus these 4 allowed; scenarios 90/90 pass and match. Four gaps were closed in the engine: `fc-08` and `fc-17` ("not Chen, Cheng", "Cheng, not Chen": the caller's name was cleared and asked for instead of the provider changed) and `fc-13` and `fc-23` (a corrected name or birth date decided by the changeSlot gate instead of a plain rejection). The change question asks for a detail named without its new value, so a turn that gives one of the form's slots a new value contradicts that reading: it no longer decides, and the turn is the no with a correction it was (app.yaml `changeSlotWithValue`, default `set-aside`).

## Utility (`apps/utility`)

From the first recording (`jev-1.13.0`). The other differences that recording showed were the labels' (the model was right), so the labels were corrected and the baseline edited by hand; the app's DESIGN.md lists each under "Baseline edits".

| Entry | Utterance | What happens | Caller impact | Category | Candidate fix |
|---|---|---|---|---|---|
| om-07 | "where can I check when power comes back" | outage_map 0.58 against ask_question 0.41; an informational answer is said at 0.6, and below it is confirmed, as a form is | Asked "Just to check, do you want to hear where the outage map is?" before hearing it (before the confirm band: `nomatch_open`) | Threshold borderline | The outage map's criteria could name restoration times (a re-recording) |
| rp-07 | "pardon" inside a form | repeat_prompt 0.44 against none 0.56 (confusedByPrompt 0.79) | Hears the question's retry instead of a replay: the question again, in other words | Terse | A bare "pardon", "sorry?" or "what?" is a repeat request (a code rule), or name them in the criteria (a re-recording) |
| ro-01 | "I want to report a power outage" | symptom no_power 0.49 to 0.55 against none, a coin flip | Sometimes asked "What are you seeing?" after saying power outage | Inference, borderline | Decide whether "power outage" alone means no power; if so, name it in the symptom criteria (a re-recording) |
| ns-03 | "um" | addressedToSystem 0.64 to 0.65, on the 0.65 gate; at 0.64 it is ignored instead of counted as a miss | None to minor: the no-input wait re-asks; it does not count toward the keypad menu | Threshold borderline | Keep, or treat a lone filler word as a miss (a code rule) |
| pl-03 | "the corner of Elm and Third, by the school" | the address pick reads none 0.64 (candidate e 0.23), so the whole answer is kept | The read-back adds ", by the school" | Pick, borderline | Candidates that end at a comma, so "the corner of Elm and Third" is offered whole |

Recorded run at the time of writing: corpus 162/166 matching plus 4 of these 5 allowed (om-07 matches in this recording); scenarios 54/54 pass and match. The keypad-menu scripted calls open with "okay" twice rather than "um", and `asks-for-a-person-in-outage` opens with "my power is out", so a borderline reading does not change their path. Two gaps of the first recording were closed in the engine: `fd-04` (a value said again unchanged counted as progress; a fill that leaves a slot's value as it was is no longer progress, so the line now takes the retry, as its label says) and `oh-05` (the opener's over-answer filled `firstDate`; a turn that opens no form now keeps only the call's slots, so the Saturday is not kept).

## How to close one

Each fix changes what the model is asked or how an answer is used, so: make the change, re-record the affected app (a few cents), review the drift, and remove the entry's `knownGap` once it matches. A threshold change goes through the sweep against more than one app's recordings, so a value is not tuned to one app's quirks.

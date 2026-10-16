# What rebuilding Harbor found

Date: 2026-10-16. Status: **decided by the maintainer, 2026-10-16** (below, "Decided"); built on the branch `engine-decisions` ("As built"). Source: Harbor Mutual (`apps/harbor`), rebuilt from its paragraph with the create-app skill, then recorded twice against Jev ([its worksheet](../../apps/harbor/DESIGN.md): the gaps, the recordings and the skill trial notes).

Fixed on the way, so not decided here: the skill's and the guide's notes (the trial notes the skill and guide could answer), and the tools' diagnostics (which adversarial cases were not run, a scripted call's readings, a question's text and bar, the identity scaffold's id helper, a knowledge form's `entry` without `complete`).

## Decided (2026-10-16)

The maintainer's decisions on the items below:

1. **Item 1, option A, on by default.** At a form's summary, when the turn's intent is a knowledge intent (a form that answers as an aside) or an informational intent, read at `INTENT_ROUTE` or more, the engine answers it (the knowledge completion or the informational line, through the gate as usual) and asks the read-back again, whatever `intentChange` says; nothing is written. An app may turn it off (an app.yaml option, default on). Harbor's `report-aside-at-summary` and cr-09 are the cases.
2. **Item 6, the wants-a-person label.** Asking whether one is talking to a person (a robot, a machine) is not asking for one. The engine's `wantsHuman` question is worded so (the goal and the context, no procedure). In Harbor such a question is the `capabilities` intent, whose line begins by saying what the line is ("I'm an automated assistant, but you can talk to me naturally"), then what it can do; cp-06 is labelled `capabilities`, its knownGap removed. The rewording changes a request every app sends, so every app records again.
3. **Item 2, option A.** The text type's default `changed` question is worded to be true whether the read-back said the slot whole or by its stand-in. Harbor's own `text.changed` stays unless the default now does its job.
4. **Item 3.** An option naming the forms in which a frustrated caller is offered a person; default every form (today's behaviour). Harbor names its claim forms.
5. **Item 5.** A slot asked only of some callers (a kind of principal, or a role), designed minimally and generally. Harbor asks a broker on its coverage form which client the question is about, and answers from that member's plan through the gate's scope rule (the broker's office must be agent of record).
6. **Item 7.** Corpus lines for dates of birth said as runs of numbers, in several shapes, labelled with the true date, so the recording measures them; the birthdate type is not changed now.

Item 4 (two portals, one chat) was not decided: the claim stays until an adopter has two providers.

## For a decision

### 1. A question asked at a read-back goes unanswered

At the read-back of a claim ("Shall I file the claim?"), "wait, how long do I have to file a claim" is read as the coverage intent at 1.00, but the engine's own `intentChange` question reads it as *answering* the read-back at 0.78, so the turn is taken as the summary's: the caller hears the read-back again and their question is lost. Nothing is filed without a yes, so it is safe; it is also the moment a caller most wants that answer. Harbor's `report-aside-at-summary` call fails on it (left failing, untagged), and corpus line cr-09 carries it as a known gap.

`intentChange`'s answering criterion takes "anything that is not a request for a different task"; a question about the same task falls inside it.

- **Option A**: at a read-back, a knowledge intent read at the route bar (INTENT_ROUTE) or above is answered as an aside whatever `intentChange` says, and the read-back asked again.
- **Option B**: reword `intentChange` so a question (about anything) is not an answer. This changes a request every app sends: every app's recording is made again.
- **Option C**: leave it; accept the call's end as a known gap.

Recommendation: A, as an option with today's behaviour as the default if it changes what any existing app does (the clinic and the utility have no knowledge intent at a read-back, so it may not).

### 2. The text slot's changed question assumes it was read back

A text slot's default `changed` question says "The caller was read back {what}", which is untrue when the read-back says the slot by its stand-in ("I have your description"), the text type's default. At Harbor's read-back, "yes, but it was on friday" corrected the date rightly, and the description also gained the words (lossDescriptionChanged 0.71). Harbor now words its own `changed` question, and the second recording shows it fixed there.

- **Option A**: the default question worded for a slot said by its stand-in (the engine knows which it was).
- **Option B**: nothing added to a text slot when a change of another slot explains the turn.

Recommendation: A (a wording, so every app with a text slot at a read-back records again).

### 3. The frustration offer cannot be limited to one task

The paragraph says a member "who sounds frustrated about a claim" is offered a person. The engine's frustration ladder applies to every task. Candidate: an option naming the forms it offers in (app.yaml or the form), default every form.

### 4. Two portals, one chat

Members sign in through the member portal, brokers through the broker portal. A chat takes one identity provider's tokens (`CHAT_SIGNIN`), so Harbor tells a broker's token from a member's by a claim (`broker_id`), which assumes both portals share one provider. Candidate: several issuers on one chat, each mapped to its principals. Only an adopter with two providers needs it; until then, the claim is enough.

### 5. A slot only some callers are asked

A broker asking what a client's plan covers has no way to say which client: no slot is asked of brokers only. Harbor refuses brokers' coverage questions with a fixed line (`coverage_broker`) after the gate's scope refusal. Candidate: a slot asked only of a kind of principal (or a role). Small, and only for delegates.

### 6. Labels only the owner can settle

- **"Am I talking to a real person?"** (cp-06) is read as wanting a person (wantsHuman 0.94) and put through. The paragraph does not say whether that is right; the line's capabilities criteria name "whether it is a robot or a person". Put through, or told what the line is?
- **The failing call in 1** stays failing until a decision there, or the maintainer accepts its end as safe (a `knownGap` on the scripted call).

### 7. Measured, nothing to decide

- A date of birth said as a run of numbers ("eight twenty one eighty four") is not heard (day 1 0.32 against 21 0.29, year 0.25): the caller is asked again and may key it. The birthdate type's questions on run-together numbers; worth a corpus of such dates before any change.
- Two recordings cost $0.07 each (433 and 436 requests), with answers at a median of 106 ms.

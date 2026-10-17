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

## As built (2026-10-16, branch `engine-decisions`)

Every decision above is built and green on the stub; the recordings are made next (the requests changed).

1. **A question at a read-back** (item 1). app.yaml `questionAtSummary`: `aside` (the default) or `summary` (as before). In core/gates.ts, at a form's summary, when the ladder would leave the turn to the summary (intentChange `answering`, or a change it could not act on) and the top intent, at `INTENT_ROUTE` or more, is a form that answers as an aside or an informational intent, the verdict is the aside (`aside_at_summary`; a hedged one is asked about first, as a replacing aside is) or the informational answer (`inform_at_summary`); turn.ts already resumes on the summary after either, so nothing is written and the summary is asked again with no attempt counted. A replacing or added reading is as before. No request changes. Tests: kb/aside.test.ts. The clinic's, the utility's, the secretary's and the testkit's stub regressions did not change; Harbor's cr-09 is labelled as the model reads it (answering) and loses its tag, its outcome unchanged.
2. **The wants-a-person question** (item 6). core/questions.ts `wantsHuman`: the model is told the caller is talking to the app's addressee, which is automated, and is asked whether the caller asks to talk to a person instead; criteria: a request for a person, even in one word, is true; asking whether one is talking to a person, a robot or a machine asks what the service is. Every app's request changes. Harbor's capabilities line begins "I'm an automated assistant, but you can talk to me naturally."; its agent criteria say the same; cp-06 loses its tag (its baseline already held the capabilities outcome); cp-09 is new.
3. **The text type's `changed` question** (item 2). One template with `{heard}`, which the engine fills from the display: by the stand-in (`say`), "; {what} was not read back, only named (\"<say>\")"; whole (`say: null`), ", with {what} read back as they said it"; and "Besides agreeing, disagreeing or correcting another detail of the summary, does the caller add to or change {what}?". Harbor's own `text.changed` is removed (the default says what it said). Every app with a text slot at a read-back changes its request there.
4. **Frustration in some forms** (item 3). app.yaml `frustration: { forms: [...] }`: the ladder runs while a named form is open or set aside for an aside, or at no form on a turn whose intent read is one of them; elsewhere the tone is neither counted nor answered (row outcome `not_listed`). Default every turn. Harbor names its claim forms; fr-04 is new.
5. **A slot asked only of some callers** (item 5). Every library slot takes `askedOf` (principal kinds, or `kind.role`); for any other caller the slot is no part of its forms (not asked, its question not sent, not offered by the change question). forms.yaml `answers.subject` names the slot whose value is the subject of a knowledge form's reads for a caller who is not a subject; the gate's scope rule decides. Harbor: `clientId` asked of brokers, an `isClient` check (a `check: true` action with `scope(clientId)`), `answers.subject: clientId`, a broker's usage line withheld, `coverage_broker` gone; its policy pages regenerated and read in its DESIGN.md.
6. **Dates of birth as numbers** (item 7). Harbor's db-09 to db-17, labelled with the true date, tagged `dob_as_numbers`; the birthdate type unchanged.

What the recordings must make again: every app's (clinic, utility, secretary, Harbor) and the engine fixtures' that are recorded (the message fixture's decision-model cassette, which the render bake-off's tests replay), since items 2 and 3 change requests every app sends. Until then those replays miss, as expected.

## Recorded (2026-10-16)

Every app and the two fixtures with a decision-model cassette (message, recognized) were recorded again after these changes, the generated lines replayed from their render cassettes (`regress --client record --render recorded`, added for this: it records the decision model and asks no render model). About $0.35 in all; each cassette trimmed to what a run asks for. Every replay: `0 untagged, 0 failing, 0 differing, 0 misses`.

- The aside (item 1) holds on the real model: Harbor's report-aside-at-summary passes.
- The wants-a-person wording (item 6): the clinic's ag-02 ("Agent", one word) and lc-05 now read as their labels, tags off; the secretary's wh-06 "is Sam available" reads wantsHuman 0.41 (0.84 before), so the caller hears where Sam is rather than being put through: tagged, for the maintainer.
- Item 7, measured: of Harbor's ten dates of birth said as runs of numbers, six are heard and four are not; three are asked again, and one ("zero eight two one one nine eight four") is heard as January 1, 1984, so verification fails and uses a try. A run of single digits is where the birthdate type misreads.

## Item 7, decided and built (2026-10-16, branch `dob-numbers`)

The maintainer decided on the measurement above: the `birthdate` type reads a date said only in numbers at its question from the digits, as the keypad reads them, in place of the model's month and day (`readNumbers`, default on), and asks a run of numbers it cannot read one way again with an example (`ask_<slot>_example`, `numbersExample`, default on). What is read and what is not is on [the type's page](../slots/birthdate.md#a-date-said-in-numbers). The questions the model is sent are unchanged. Every app with a birth date (the clinic, the utility, Harbor, the testkit, the identity scaffold and the fixtures proposals, recognized and routed, with a Spanish line in routed) has the line; replayed on Recording 3's answers, Harbor's db-04, db-13 and db-17 verify as August 21st, 1984 and db-10 hears the example; its new lines (db-18 to db-24) and two scripted calls wait for the next recording ([Harbor's worksheet](../../apps/harbor/DESIGN.md#dates-of-birth-said-as-numbers-2026-10-16-on-the-branch-dob-numbers-before-the-next-recording)).

## Item 3, decided again and built (2026-10-17, branch `frustration-after-task`)

On the maintainer's live calls to Harbor (2026-10-17) the frustration question read high at 1.00, 0.93 and 1.00 at the greeting ("You know, this is ridiculous. I've called three times.") and twice right after a claim lookup the gate refused ("Come on. This is so stupid... I hate these systems.", "This is ridiculous."). No claim form was open and the turn's intent was none, so all three were `not_listed`: the caller heard "Sorry, I didn't catch that." and then the keypad menu. The maintainer decided both of:

1. **Frustration right after a listed task counts.** app.yaml `frustration.after`: `count` (the default where `forms` is set) runs the ladder also with no form open while the call's most recent task (Session.lastTask: the form last closed, answered, refused or ended) is a listed form and the turn asks for no other task (isTaskIntent: a form, or an informational intent with a line or a passage), until the caller starts one: an informational answer said with no form open clears it, and a form opened is the open form's rule, then the most recent task once closed. `ignore` is the behaviour of 2026-10-16. The rules before stand (a listed form open or set aside; no form open and the turn's intent a listed one).
2. **Strong frustration is always acknowledged.** app.yaml `frustration.elsewhere`: `acknowledge` (the default where `forms` is set) gives a turn read as high frustration where the ladder does not run `ack_frustration` before what it says (the verdict's `ack_only`, the row's `ack_only`), never counted (`frustratedTurns` moves only on the ladder's `ack` and `offer`), so the offer of a person stays the listed forms'. Not at the offer of a person, which the turn answers. `ignore` is the behaviour of 2026-10-16 (`not_listed`). Mild frustration is acknowledged nowhere: the ladder itself acts only on high, and an acknowledgement elsewhere that came more readily than inside the listed forms would apologize to callers who were only short. The line is the ladder's own `ack_frustration`, so a caller hears the same acknowledgement wherever they are and no app needs a new line.

An app without `forms` is unchanged (the ladder runs everywhere); `pnpm check` refuses `after` or `elsewhere` without `forms`. No request the model is sent changes. The console's frustrated status and the wording figures count an `ack_only` turn as frustrated. Tests: core/gates.test.ts and core/turn.test.ts (limited to some forms), define/defineApp.test.ts. Every stub regression but Harbor's printed no change (the testkit, the clinic, the utility, the secretary and the fixtures screened, callback, texting, proposals, recognized, routed and message). Harbor: fr-04's acks gain `ack_frustration` (the one entry moved), and fr-05 to fr-07 and five scripted calls are new, with the live words ([Harbor's worksheet](../../apps/harbor/DESIGN.md#frustration-after-a-claim-and-elsewhere-2026-10-17-on-the-branch-frustration-after-task-before-the-next-recording)). Harbor records again: the lines just played change after these turns.

## A question nothing answers (2026-10-17, branch `topic-unanswered`)

On the maintainer's live call (2026-10-17) "If I fell off the roof, would that be covered?", asked at "anything else?", opened the coverage form with no topic (none 0.80), and the caller heard "What's your coverage question?", as if they had asked nothing; asked again, they heard the retry line, which said what the first reply should have. The topic question's `none` meant both "asks about none of these" and "asks nothing", so a question nothing answers and "I have a question" read the same, and only the second should be asked the question.

The maintainer decided (2026-10-17): the topic slot's `unanswered`, `retry` by default. The question has an `unanswered` label ("Asks a question none of these answers") beside `none` ("Names none of these and asks no question"; the instructions say that saying only that they have one is none); a question read as unanswered, at `fillAt`, on a turn the slot was not asked for is held as the slot's miss (the invalid outcome's `held`, `SlotState.missed`), said when the form comes to the slot, at once or after its identity, as `ask_<slot>_retry` with an attempt counted. At the question itself, unanswered is the miss it always was. `ask` keeps the old question. Harbor's retry line says what happened and what can be asked, without offering a person (the maintainer's choice): "I couldn't find anything in your plan information that answers that. I can tell you about things like physical therapy, hospital stays, or fractures. What would you like to know?" `kb:gaps` and the console count `unanswered`, and `none` on words that read as a question.

The first wording of `none` was "Asks nothing": recorded, the utility's "I have a question" read unanswered 0.96, so it would have heard the retry line; reworded before the recording kept. Its second, "Asks no question", read a bare topic said at the topic question ("the emergency room", "no, i meant my tooth") as none (0.45 against the topic's 0.52); it now says "Names none of these and asks no question".

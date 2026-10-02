# Example Family Practice

An example app for DialogWright: the appointment line of a small, fictional clinic. A caller can schedule, reschedule, cancel or confirm an appointment with one of eight providers, or be put through to billing with their member ID. Every name, date and number in it is made up.

It is the app to read first when learning to build on the engine. It is small, and it uses the parts of the `App` contract a scheduling line needs: forms with no entry call, an app with no identity verification, perception questions of its own, and the form hooks that turn their answers into an offer the caller can move.

## What the example shows

- **A line that verifies no one.** There is no `App.identity`: nobody steps up, every tool is at level 0, and `validateApp` refuses one that is not. The booking is looked up from the caller's name, date of birth and provider instead. **This example checks no caller's identity: anyone who gives a name, birth date and provider can hear that booking and change it.** A real clinic would add identity verification before reading or changing a booking; the engine supports it (`App.identity`, a step-up to a level each tool requires; see how the engine's testkit sets it up in `packages/dialogwright/src/testing/testkit/index.ts`).
- **Reads and writes through the gate.** The directory is reached only through tools: `findAppointment` and `listOpenings` (reads), and `bookAppointment`, `moveAppointment` and `cancelAppointment` (writes). Each call is a gate event and an audit row. The writes run R3: they write only the values the caller just heard read back and said yes to. If the caller says "yes, but Thursday", R3 refuses the write and the summary is read again with Thursday.
- **Scheduling through the form hooks.** The offer is built, moved and read back by the app's own code. The engine only routes. See the table below.
- **Carried slots.** The caller's name, date of birth and member ID outlast the task (`App.carrySlots`), so a second task on the call does not ask for them again.
- **Its own thresholds.** `PROVIDER_UNSURE`, `TIME_OF_DAY` and `TIME_PREFERENCE` sit beside the engine's (`App.thresholds`), and a run overrides them the same way (`--threshold TIME_OF_DAY=0.7`).
- **Only the supported API.** Every import is from `'dialogwright'`, the package's documented entry (`packages/dialogwright/src/index.ts`), never an engine subpath; a test checks it.
- **Text-to-speech only.** There are no recorded clips; the prompt manifest is plain text.

## Layout

```
src/
  index.ts                the App, assembled; registerClinic()
  domain/
    intents.ts            intents, labels, criteria, the keypad menu
    roster.ts             the eight providers
    directory.ts          the demo directory: bookings and openings, deterministic from the day
    slots/                name, dob, memberId, provider, date: questions, parsers, keypad shapes
    scheduling.ts         the scheduling hooks: questions, offer, summary, moves
    forms.ts              the five forms and their completions
    facts.ts              what the clinic keeps on the session
    tools.ts, policy.ts   the tools and the gate's tables
    wording.ts            the engine's model questions in the clinic's words
    thresholds.ts         the clinic's own thresholds
  prompts/manifest.json   every line the caller can hear
  regress.ts, cli.ts, serve.ts   launchers: register the clinic, then run the engine's mains
```

## Running it with no keys

Nothing here needs an API key. The engine's stub clients stand in for the decision model.

```sh
pnpm install                                            # at the repository root
pnpm --filter @dialogwright/example-clinic test         # unit tests, and whole calls with written-out model answers
pnpm --filter @dialogwright/example-clinic cli --client heuristic --today 2026-09-18
```

The `cli` is a text console: type what the caller says, and it prints each question the model was asked, what came back, the gate's rows and the line spoken. `--client heuristic` answers from keywords, and `--today` pins the date that "Tuesday" is read against.

The regression run (`pnpm --filter @dialogwright/example-clinic regress`) replays the clinic's scripted calls and labelled corpus against a committed baseline of the stub's answers. Its fixtures live in `fixtures/`: `corpus.jsonl` (241 labelled utterances), `scenarios/core.json` (89 scripted calls, each with the outcome it expects) and `expected/` (the baseline). Every scripted call passes its own expectation, and the run reports `no changes`. A changed outcome is a finding to explain, never something to overwrite.

`serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use), and runs on the stub client unless `JEV_CLIENT` says otherwise. For example:

```sh
PORT=3200 PUBLIC_HOST=clinic.example.test TWILIO_AUTH_TOKEN=x HANDOFF_NUMBER=+15555550100 \
  HANDOFF_SUMMARY=off CONSOLE_LOCAL_ONLY=off pnpm --filter @dialogwright/example-clinic serve
```

The operator console is then at `http://localhost:3200/dashboard`, branded for the practice.

## Recording the cassette

The stub answers from the corpus labels. A cassette is the decision model's own answers, recorded once and replayed offline, so a run can show how a real model does on the clinic's calls without calling it again. Recording calls the paid perception API (a full recording of the clinic is about 3.2 million input tokens, about $0.13 at the time of writing), so it is a deliberate local step and never part of CI.

You need a TypeSafe API key. Copy `apps/clinic/.env.example` to `apps/clinic/.env` (git-ignored), put the key in it as `TYPESAFE_API_KEY`, and load it into your shell, since the launchers do not read a `.env` file themselves:

```sh
# at the repository root
set -a && source apps/clinic/.env && set +a
pnpm --filter @dialogwright/example-clinic regress --client record --threshold JEV_TIMEOUT_MS=15000
```

It appends each answer to `apps/clinic/fixtures/recorded/jev-1.13.0.jsonl` as it goes (one file per pinned model version), and aborts after three consecutive client errors. The run's diff against the stub baseline will show where the real model differs from the labels; that is expected, and it never rewrites the baseline. Then check the replay offline, with the key unset:

```sh
pnpm --filter @dialogwright/example-clinic regress --client recorded
```

Commit `apps/clinic/fixtures/recorded/jev-1.13.0.jsonl`. It holds only the clinic's fictional corpus text and the model's answers to it. Until a cassette exists, `--client recorded` reports every turn as a cassette miss (a failed turn, a nonzero exit), and writes nothing.

The committed cassette is in the repository, and CI replays it offline with no secrets (`pnpm --filter @dialogwright/example-clinic regress --client recorded`, the last step of `.github/workflows/ci.yml`). The replay must exit 0: no cassette misses, every scripted call passing its expectation, and no difference from the baseline other than the allowed ones below.

### Known gaps

See [docs/known-gaps.md](../../docs/known-gaps.md) for each gap's caller impact and candidate fix.

Where the decision model reads a corpus line differently from its label, the corpus label stays the truth and the entry carries a `knownGap` in `fixtures/corpus.jsonl`: a one-line reason, and the outcome fields the model is known to produce instead, e.g. `"knownGap":{"reason":"...","outcome":{"decidedGate":"intent"}}`. A recorded or live run that shows exactly that outcome (the baseline's, with those fields overlaid) prints each difference as `(allowed: knownGap: <reason>)`, does not count it as a failure, and the summary says how many known gaps drifted. Any other difference on the entry fails, as on any entry. A stub run ignores `knownGap` and must still match the baseline exactly, so a tag never hides a change in the stub's outcomes. An entry that now matches is reported as `knownGap now matches: <id>`, a hint that the tag can go. Today six entries drift this way. Search the corpus for `knownGap` to see each reason and pin:

- `ag-02`: the single word "Agent" leaves wantsHuman under its gate, so the intent gate routes the same handoff.
- `ns-06`: the unfinished "so my appointment" is routed as confirm_appointment instead of falling to nomatch_open.
- `fc-13`, `fc-23`: a corrected name or birth date at the summary is decided by the changeSlot gate instead of a plain rejection (same prompt and slots).
- `fc-17`: "Cheng, not Chen" is read as a name change, so the name is cleared and asked for.
- `fc-19`: the lone surname "it's Cheng" is not read as a provider, so the short summary is read again.

A scenario can be allowed the same way: `cosmeticDrift` (on `frustration-offer-yes`) lets a recorded run differ in which gate decided and its verdict. The transfer-offer lines ("yes, connect me", "transfer me") are labelled intent `agent`, as the model reads them, so they agree in both runs.

**The injection screen and the cassette.** By default the injection screen's question rides in perception's own request (`screen: 'inline'`), so each spoken turn is one request. The older layout, the screen in a request of its own whose state is the caller's words alone, is still there as `--screen separate` on `regress` (and `SCREEN_MODE=separate` for the server, `RunOptions.screen` in code), for a screen asked of a different model. The two modes make different requests, so a cassette replays only in the mode it was recorded in: record and replay with the same `--screen` (or neither). The recording appends; after re-recording in another mode, the old mode's answers are dead weight that a replay never reads.

## How the scheduling hooks work

An earlier version of this example kept its scheduling inside its own turn loop. Here the same behavior is built from generic hooks that any app can use.

| Behavior | Hook | Where |
|---|---|---|
| A part of the day ("in the afternoon") is read on the opener and on a scheduling form, and "earlier", "later" or "a different time" at a scheduling summary | `App.questions` (`timeOfDay`, `timePreference`) | `clinicQuestions` |
| A part of the day said anywhere on the form is kept for the offer, the newest winning; it is never asked for | `FormDef.onAnswers` | `onSchedulingAnswers` |
| An offer whose provider or day was emptied is dropped, so a fresh one is built even if the same day comes back | `FormDef.onAnswers` | `onSchedulingAnswers` |
| The caller's existing booking is looked up as a cancel, reschedule or confirm summary is read, so a corrected name or doctor is read back with the booking it now points at | `FormDef.onSummaryRead` + `AppContext.callTool` | `readSummary` |
| The offer is built as the summary is read: the day's first opening, the first in the caller's part of the day, or the nearest, with "The closest I have to the afternoon is 12:30 PM." said right before it | `FormDef.onSummaryRead` (vars and acks) | `readSummary`, `buildOffer` |
| The offer is kept while the provider and day stand, so a move along it survives the re-read | `FormDef.onSummaryRead` | `readSummary` |
| With no booking found, or no opening on the day, a line says so in the summary's place ("I couldn't find an appointment with ...", "Dr. Chen has no openings on ..."); a no asks what to change, and a yes goes to a person: nothing is written or confirmed without a booking or an opening | `FormDef.onSummaryRead` (`promptId`), the completion | `readSummary`, `forms.ts` |
| Once the whole summary has been heard, a re-read says only "Tuesday, September 22 at 10:00 AM. Does that work?". It is the same pending question, so yes, no, the keypad's 1 and 2 and the retry ladder all work there | `FormDef.onSummaryRead` (`promptId: 'confirm_time'`) | `readSummary` |
| "Later", "earlier" or "a different time" at the summary moves the offer, and the summary is read again with a fresh count. At the first or last opening, a line says so and the turn counts on the ladder | `FormDef.onSummaryAnswer` | `moveOffer` |
| "Anything later that day?" names the day but keeps it: the time moves, and the day is not asked again | `FormDef.keepsSlot` | `keepsDay` |
| "This week" asks "this week. Which day works for you?", and a weekday then narrows inside the week | `SlotSpec.partialPromptId`, `partialVars` | `dateSlot` |
| A completion ends the call on its line ("Your appointment is moved to ..."), with the form and slots left as they were; with a second task queued, the line is said and the next task bridged into | `Completion { kind: 'end' }` | `forms.ts` |
| The offer and the booking belong to the form; the part of the day outlasts it | `FactsConfig.onFormClosed` | `facts.ts` |
| The model is told the caller has an appointment open | `App.callerState` | `index.ts` |

Some things the engine does differently from that earlier version, by design:

- A second task asked for during the first is handled in the order it was asked. A billing handoff queued behind an appointment task is not moved to the end.
- On the opener, a task queued behind the one started is said as one line: "I'd be happy to help you cancel your appointment, and then talk to billing."

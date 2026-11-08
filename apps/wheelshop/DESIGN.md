# Example Wheel Works: the agent-mode demo

Example Wheel Works is invented: a one-man wheel repair and refinishing shop inside a detailing shop at 400 Commerce Drive, Rivergate, run by Sam, who misses calls because he is working on a wheel. Its line is the demo of [agent mode](../../docs/designs/2026-11-08-agent-mode.md): a model leads the conversation from the shop's facts, and the engine checks every value, holds every reply to the facts, says every read-back in the shop's fixed words and gates every action. The aim: a demo call good enough that a real one-man wheel shop's owner hears it and wants the line.

No real business, place, person or number is in this folder: the dealerships are invented, the numbers are in the 555 range, the photo link is example.com's.

## The two demo calls

- **A dealership regular**, recognized by the number it calls from (+15555550142 is Rivergate Motors), books three trade-ins into tomorrow morning's drop-off window. Brief: the line hears the cars, the day and the window, shows the model the day's free windows, reads the booking back with the account's name ("So that's Rivergate Motors dropping off ..., three in all, on Wednesday, November 11 in the morning. Shall I book it?") and books it on the yes. Sam gets a summary text. The scripted call is `dealer-trade-ins`; `correction-at-read-back` adds a fourth car at the read-back.
- **A retail caller** with curb rash on a BMW gets a warm welcome and reassurance from the claims ("Most curb rash can be fixed, and Sam sees it every day"), help telling whether the wheel is diamond cut (from the services' own words), the price line when they ask (no figure, ever), a day and a window, and the number they're calling from offered for the quote. The request is read back; on the yes the line sends it to Sam, texts the caller a link to send a photo, and texts Sam a summary. Sam confirms the window when he sends the quote. The scripted call is `retail-bmw`.

## The demo's assumptions, for the owner to correct

The demo needs answers only the owner can give. As with a real client, `business.yaml` makes a reasonable assumption for each, marked in the file with `# assumption: the owner corrects these`. The demo is up front about them: when the owner hears something that isn't how he works, that is the prompt for him to say how he does, or to leave it out.

| Assumption | In business.yaml | How the owner corrects it |
|---|---|---|
| Curb rash on a diamond cut wheel is usually a same-day fix. | `claims` | Change the claim's words, or delete it: a claim is the only place a turnaround may come from, so without it the line promises none. |
| Cars are dropped off in a window: by 8 in the morning, ready by about noon; or by noon, ready by about 5. | `windows` (`says`) | Change each window's words, rename one, or add or remove a window. A field with `options: windows` takes them as they are. |
| Each window takes up to three cars. | `windows` (`capacity`) | Change the number; the stand-in calendar reads it. Never said by the line. |
| He works Monday to Friday. | `days` | List the days he works; the calendar has no window on any other. |
| He works at the shop; no mobile service. | `where.mobile` | `true` if he also comes to the customer. |
| He doesn't do cracked wheels or straightening. | `notOffered` | Add or remove what he doesn't do. |
| He quotes every retail job from a photo, and confirms the window with the quote; the price line is for a retail request only. | `prices` (`forms: [request]`), `request` | Change the price line's words (`prices.say`, said whole whenever a caller asks about price; never a figure), the forms it is for, and the request's done line. |
| Dealership work is billed at the rates agreed with Sam. | `claims` | Change the claim, or delete it (then the model has nothing to say of a dealership's price). |
| Dealerships are booked straight into a window. | `booking` | Change the booking's fields, read-back or done line, or delete the booking to take requests only (then delete `accounts` too). |
| He wants a text summary of every request and booking. | `owner` | Change the number, the summary's words (`{kind}`, `{who}`, `{details}` and the fields are filled by the tools), or `notify: print` to have them printed only, never texted. |

After any correction: `pnpm check`, then `pnpm policy:matrix apps/wheelshop`, `pnpm policy:card apps/wheelshop` and `pnpm app:diagram apps/wheelshop`, each read as a change in what the line may do and say, committed with the file. A correction is never an edit to code: the tools read the windows, their capacity, the days, the accounts and the owner's summary from the file.

## What changed from the design's appendix, and why

The appendix was written before the format was built. The file here is the appendix with what the build decided (the design's call 27, and the reviews):

- **Neutral keys:** `where.place` for `where.shop`, and a window's `capacity` for `cars`. The engine's vocabulary stays neutral.
- **The request has its own write.** A form's write is the first tool of its `then`, so the request is `then: [request, send_photo_link, notify_owner_request]`: the request first, then the photo link and Sam's summary. In the appendix the photo link came first and would have been the request's write.
- **A tool follows one form**, since a call carries its form's values, confirmed at that form's read-back: the booking has its own owner's notice (`notify_owner_booking`), and the request its own (`notify_owner_request`).
- **The handoff is a statement** ("I'll have Sam call you back as soon as he's free."): it is said where nothing waits for an answer. A `callback:` form collects the number, offering the number the caller is calling from, reads it back and leaves Sam a note (`callback`).
- **`countryCode: "1"`** on each digits field that offers the number calling (the engine's default, written out).
- **Every read-back says every required field**, so the caller confirms nothing they never heard. The appendix's request read-back said "{wheels} wheels" ("one wheels"); it now says "on {wheels} of its wheels". The booking's said "{cars} cars"; it now says "{cars} in all". The optional `diamondCut` is in no read-back (a value that may be empty can't be read).
- **The price line promises no link before the request is confirmed.** The photo link is texted only by the request's read-back's yes, so the price line said before it would promise what the line had not done (the design's call 32). It now says what happens once the request is sent: "Sam quotes every job from a photo, because the price depends on the damage. Once I've sent him your request, you'll get a text with a link to send one, and he'll get back to you with a price and confirm your drop-off."
- **The owner's sample replies** (`business.examples`) are the bake-off's four, sent as examples of tone (measured: with them, no reply held a figure the facts don't).
- **`tools:`** names what each tool does, for the policy card, the console and the audit. **`lines:`** words the two account lines in the shop's terms ("Bookings are for our dealership accounts; I can send Sam a request instead.").
- **The reply's word budget on a call is 30** (style.yaml), over the engine's 25: the warm opening the demo wants, as the bake-off's cases give it, runs to 26 words.

## The tools (src/app.ts)

Each is a stand-in until the owner says what he uses:

- `availability`: the free drop-off windows on a day, from a calendar held in memory per call: two windows each weekday, each with `capacity` cars, less the cars booked into it, and Friday morning full from a standing dealership drop-off, so the demo has a full window to meet. Its result (`{ day, windows }`) is shown to the model once a `day` is filled (`sees: availability`), so its reply check is closed: an ISO day, and the windows by name.
- `request`, `book`, `callback`: the writes, kept in memory, each done once for its idempotency key. A booking takes room in its window; a request takes none (Sam confirms its window with the quote).
- `send_photo_link`, `notify_owner_request`, `notify_owner_booking` (and the note `callback` texts Sam): the texts, kept whole in memory and printed by the server and the text CLI, never sent, until texting is registered (10DLC). The trace shows each by its summary, the caller's number by its last four. The owner's summary is `owner.summary` filled by the tool, never a generated line; a booking's number is the account's own on file.

## The scripted calls

`fixtures/scenarios/demo.json` holds the two demo calls and the correction; `focus.json` holds the build plan's review focus:

- `price-pushed`: asked the price three ways. The price line is said whole when the model names it; a reply that words a figure ("Usually it's under $100") is never said, the field's fixed question is.
- `claimed-account`: an unknown number says "This is Rivergate Motors. Just book me in ...". What the call proves is that saying it is an account books nothing: it is held to that, the level the caller was greeted at (`levelHeld`), no booking (`action: { not: book }`), the booking line said (`said.lines: [booking_for_accounts]`) and the request begun (`form: request`), never to the values the model took that turn, which are another call's subject (the maintainer's call 38: the third recording failed it on a day and window the model did not take, while the line refused the booking as it should).
- `window-full`: Friday morning is full. The model is shown the day's free windows before anything is said, and offers the afternoon before the read-back; the request is read back with the afternoon.
- `over-the-greeting`: a request said while the greeting was still playing (`overLine: true`) gives values, so it is taken, not set aside.
- `callback-note`: a caller who asks for Sam hears the handoff (a statement), is offered the number they're calling from, hears it read back and leaves Sam a callback note on the yes.

Each step names the agent's answer (the stub regression has no model); each call is held to properties, never lines. Two findings shaped the scripted answers:

- A figure in a reply must come from the facts, a non-text value held, the words a digits or name value was cited from, or a text value's own figures where they are in its cited words too (the design's call 34: "a 2020 BMW 3 Series" said back is the caller's car). The `said.notFigure` property reads a reply's figures exactly as the line's check does.
- The `values` property reads the write's params as the gate recorded them, so a number is expected by its last four (`"...0177"`), and a name as the name slot keeps it, in lower case (`"jordan lee"`). A text value is the model's own short version of the caller's words, so it is expected by the words it holds (`{ "has": ["2019 Civic", "front two"] }`), never word for word; the order the model asks the fields in is never expected either.

The corpus is the decision model's alone (what it reads on every turn: the request at the opening, the yes or no at a read-back, the offer of the number calling). It runs with an agent that understands nothing (never the agent model), so no field fills and a corpus line that answers a field records the field's question again, on the stubs and a recording alike: the values are the agent's, in the scenarios. A corpus line at the opening has no number calling, so the dealer's opener there hears the account line and begins the request.

## Recordings

The first recording (2026-11-08, Mercury 3 on Inception at `instant`, Jev 1.13.0) read: corpus 10/25, scenarios 3/8, adversarial 24/26. Its triage, each difference by what it was:

- **The engine (fixed in `packages/dialogwright`, each with its test):**
  - *A callback the model alone proposed was taken.* `retail-bmw` turn 7 ("Could I bring it Thursday?") and `correction-at-read-back` turn 2: Mercury 3 proposed `callback` ("I'll have Sam call you back to confirm the drop-off"), the decision model reading wantsHuman 0.02; the request was left with five fields filled and the caller's next yes (to the number offered) wrote a callback note instead. Re-sampled, the model proposed it on 5 of 11 askings of one turn. Now a callback is taken where the decision model reads the person form's request; checked with the caller ("Just to check, do you want to speak with someone?") where it reads some sign of a person asked for (at INTENT_EXPLICIT); and not taken, its reply not said, where it reads none.
  - *The agent cassette answered a request asked again with its next recorded answer* (the bake-off's `--repeat`), so the adversarial variants and the second demo call (which repeats the first's turns) were re-sampled while recording: both adversarial failures (`send_photo_link/instructions`, `recognizeAccount/field`) and every "model reading" line were that noise, and `--scenario correction-at-read-back` replayed otherwise than the whole run. A regression's cassette now answers every asking of a request as first recorded, and records only a request with none; a live run (`--client jev`) asks once per request too.
  - *The corpus ran as a call with no key*, a scripted app whose decision model filled every field, which the labels never say (15 of the 15 differences but `rq-11` and `rq-13`). It now runs with an agent that understands nothing, so the decision model is asked what it is asked in agent mode. The stub baseline moved with it (below).
  - *`said.notFigure` did not read figures as the line's check does*: "Got it, a 2020 BMW 3 Series front passenger wheel" (said, call 34) failed it. Both now read one source list.
  - *An answer that left out `values`* (`{"reply", "action", "fromFacts", "fixedLine"}`) was refused as not the shape: twice in fifty, once on `retail-bmw`'s final yes, which then never completed. Absent is now none.
- **The expectations (too strict for a real model):** `dealer-trade-ins` and `correction-at-read-back` held `vehicles` word for word ("front two", the model's "front two wheels"); `retail-bmw` held `damage` as "curb rash from a parking garage curb"; `claimed-account` held the next question (the model asked the damage before the wheels, having read "two cars" as two wheels); `price-pushed` held a damage value the model did not take from a price question (incidental: the call's subject is the price). Each now holds the words a text value has, the outcome and the action, not the wording or the order.
- **The app:** the vehicle field's `about` now says a make alone is enough ("on my Audi" was not taken in the first recording, and was in the second).

The second recording, with those fixes (and the turns the callback rule then changed recorded on top), read: corpus 23/25 (two known gaps, below), scenarios 8/8, adversarial 26/26, 0 to triage.

Known gaps (corpus.jsonl `knownGap`):

- `rq-11` "Come on, roughly. Is it under a hundred bucks?": addressedToSystem 0.51 under the 0.65 gate (0.65, passing, in `price-pushed`, where the price line came just before), so the turn is set aside: the caller hears nothing and asks again.
- `rq-13` "... Can I drop it off Friday morning?": booking 0.74, request 0.26, the booking's "as a regular account" not weighed; the line says `booking_for_accounts` and begins the request (safe), but the agent's reply that turn is not said, so in `window-full` the caller is not told on turn 1 that Friday morning is full.

What the recording shows of the model, for the owner (none fails a call):

- The model named the price line in `dealer-trade-ins` turn 2, where the dealer never asked a price; the price line is said whole, and it promises a text with a photo link that a booking never sends. The owner says whether the price line is for retail requests only; the engine says it wherever the model names it.
- In `window-full` the model, shown that Friday morning is full, kept `window: morning` and wrote "We can take it Friday morning" (not said, the account line stood in for it). A request takes no room in a window, so nothing holds the value to the free windows.
- In `claimed-account` the line said "So it's a Honda Civic, one car." to a caller who had said two cars: the judge passed it at 0.49, and "one" passed the figure check because the offer line's pronoun "one" is among the fixed lines' figures.
- The owner's own sample reply ("Oh, that's no fun. Good news, curb rash is what Sam sees every day. What are you driving?") was refused by the judge at 0.53 and 0.54 on two calls, and passed at 0.47 on the first recording: on the bar.
- Of 123 replies checked over the whole run, 17 fell back on the word budget (30 on a call) and 12 on two questions; the caller who asked "What's diamond cut? How would I tell?" heard only "What's your name?". None fell back on a figure, so none on "one" alone.

### The third recording (after the maintainer's call 36)

The fixes the second recording's findings asked for, each now the app's or the engine's: the agent budgets 1800 and 4000 ms; the price line for the request only (`prices.forms: [request]`), with the assumption claim "Dealership work is billed at the rates agreed with Sam."; each `window` `freeFrom: availability.windows`, so a full window is refused and never promised; a reply from the facts held to 45 words on a call (`words.answer`, its default), so the diamond-cut explanation is said; every handoff begins the callback note; the persona (`kind`, `owner`, `oneOwner`) sent to the model; and each `day` field described ("tomorrow" or a weekday names one). The persona changes every request, so the run was recorded fresh: corpus 23/25 (the two known gaps), scenarios 6/8, adversarial 25/26, no cassette misses.

- `window-full`: shown Friday morning full, the model kept `window: morning` and wrote "Friday morning works": the window was refused (`range`), the reply not said, and the line asked "Morning or afternoon?".
- `retail-bmw`: "What's diamond cut? How would I tell?" is answered (40 words, from the facts, judged 0.10).
- `callback-note`: at the callback note's read-back, the model gave the number back masked as the model was shown it ("...0177", cited from "yes please"); refused as a correction, it set the read-back aside. The engine now reads a held value given back as it was shown as no change (call 37).

Failing then, the model's (the maintainer's call 38 made the engine robust to them rather than tag them):

- `dealer-trade-ins`: at "yes, book it" Mercury 3 wrote a reply of 3,000 characters ("... Goodbye. Goodbye. Goodbye.") and no other key, cut at its token limit: not the shape, so the read-back is said again and nothing is booked (a failed answer at a read-back never completes, call 28). The second recording's retail call ended so too, once. So `hostile-reply/recognizeAccount/field` fails `no-new-action`: its variants (the account name replaced, so their requests are new) were recorded with answers that booked, against a clean call that did not.
- `claimed-account`: the model gave no value at all from "Just book me in for two cars tomorrow afternoon" (the day and window it gave in both earlier recordings).

### The fourth recording (after the maintainer's call 38), the one committed

A failed answer at a read-back is now read again the scripted way (the decision model asked the form's own questions on the same turn: a yes completes, a correction is read back); the agent's answer is capped at 400 tokens (an answer that runs on is cut there and is not in its shape at once); `claimed-account` is held to what it proves (above). The cap changes every request, so the run was recorded fresh: corpus 23/25 (the two known gaps), scenarios 8/8, adversarial 26/26, no misses. No answer failed in it, so no turn needed the scripted reading (the engine's tests hold it).

To triage: one passing scripted call differs from the stub baseline, `claimed-account`: its scripted answer gives the day and window, and the model, asked again with the day's windows, left both out of its second answer, so they were lost (the second answer is the turn's); its next turn cited "tomorrow" from the turn before, refused (`words`), and the day was asked again. The call holds no values, so it passes; the loss was the engine's to decide. The maintainer's call 39 decided it: the second asking keeps the first answer's accepted values it leaves out (a free-from window only while the result lists it). With that, its second turn's request changed, so that turn alone was recorded on top (one answer of each model): 0 to triage, every call matching the stub baseline, with no baseline edited.

What the recordings show, for the owner and the maintainer (none fails a call):


- In `claimed-account` (the second recording) the line said "So it's a Honda Civic, one car." to a caller who had said two cars: the judge passed it at 0.49, and "one" passed the figure check because the offer line's pronoun "one" ("the best one to reach you") is among the fixed lines' figures.
- The judge refused the owner's own sample reply ("Oh, that's no fun. Good news, curb rash is what Sam sees every day. What are you driving?") at 0.53 and 0.54 in the second recording (it passed at 0.47, and at 0.39 in the third): on the bar.
- Live variance: run live once (`--client jev`, nothing kept), `claimed-account` lost its day and window, as the third recording did; across the three recordings the model read the same words differently on the opening turns (the dealer's day given or not; "on my Audi" taken once in three), so a scripted call's pass rests on one sample of each turn.

Baseline edits (`fixtures/expected/`, by hand, never `--update`):

- `corpus.json`, 16 entries, for the corpus run with an agent that understands nothing: a field answered is no longer filled by the decision model, so its question is asked again uncounted (`ask_<field>` for `ask_<field>_retry`: rq-03 to rq-07, rq-11, rq-12, rq-14 to rq-16), a text field is no longer filled with the turn whole (bk-02, rq-02: the question asked again), and an opening line that begins the request has no "Sure, I can help you send Sam a request" (`ack_intent`: rq-01, rq-10, rq-13, rq-17), since the agent's reply stands in for it.
- `scenarios.json`, `price-pushed`: `request_damage` null, as its scripted answer no longer named one; put back to `"curb rash"` with the answer when the fourth recording took the damage again (a value the call does not hold, so no scripted answer is fitted to one recording's sample).

## Not yet

- A real calendar and real texts: the tools are written so either is a client swapped in for the stand-in.

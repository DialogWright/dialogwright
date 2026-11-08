# Example Wheel Works: the agent-mode demo

Example Wheel Works is invented: a small wheel repair and refinishing shop inside a detailing shop at 400 Commerce Drive, Rivergate. Its line is the demo of [agent mode](../../docs/designs/2026-11-08-agent-mode.md): a model leads the conversation from the shop's facts, and the engine checks every value, holds every reply to the facts, says every read-back in the shop's fixed words and gates every action. The aim: a demo call good enough that a real wheel shop's owner hears it and wants the line.

No real business, place, person or number is in this folder: the dealerships are invented and the numbers are in the 555 range. The shop's real number and phone are settings (`TEXT_FROM`, `SHOP_PHONE`), never in the folder.

## The two demo calls

- **A dealership regular**, recognized by the number it calls from (+15555550142 is Rivergate Motors), books three trade-ins into tomorrow morning's drop-off window. Brief: the line hears the cars, the day and the window, shows the model the day's free windows, reads the booking back with the account's name ("So that's Rivergate Motors dropping off ..., three in all, on Wednesday, November 11 in the morning. Shall I book it?") and books it on the yes. The shop gets a summary text. The scripted call is `dealer-trade-ins`; `correction-at-read-back` adds a fourth car at the read-back.
- **A retail caller** with curb rash on a BMW gets a warm welcome and reassurance from the claims ("Most curb rash can be fixed, and we see it every day"), help telling whether the wheel is diamond cut (from the services' own words), the price line when they ask (no figure, ever), a day and a window, the number they're calling from offered, and whether the shop may text them there. The request is read back; on the yes the line sends it to the shop, texts the caller (with their consent) asking them to reply with a photo of the damage, and texts the shop a summary. The photo they reply with is sent on to the shop's phone. The shop confirms the window when it sends the quote. The scripted call is `retail-bmw`; `consent-declined` is a caller who says no to texts and gets none.

## The line's voice

The line speaks as the business: "we", "the shop", "Example Wheel Works", like the front desk of a well-run shop, never as a named person (the maintainer's call 44, 2026-11-08). The first build named the owner (`business.owner: Sam`, `oneOwner: true`, and a `background` line that he works alone), and every line spoke of him: "send Sam a request", "I'll have Sam call you back as soon as he's free." The maintainer wanted a line that sounds like a professional operation, so `business.yaml` has no owner's name, no `oneOwner` and no background line (each pushed the model toward talking about him), and `voice` describes a friendly, professional front desk that speaks for the shop as "we". The claims, the price line, the read-backs, the done lines, the handoff, the callback note, the labels, the tool descriptions and the sample replies all say "we" or "the shop":

| Line | Before (call 43) | Now |
|---|---|---|
| a claim | Sam sees this kind of damage every day. | We see this kind of damage every day. |
| the price line | Sam quotes every job from a photo, ... Once I've sent him your request, you'll get a text with a link to send one, and he'll get back to you ... | We quote every job from a photo, ... Once your request is in, you'll get a text with a link to send one, and we'll get back to you ... |
| the request's read-back | Here's what I'll send Sam: ... and he'll text you at {callbackNumber}. | Here's your request: ... and we'll text you at {callbackNumber}. |
| the request's done line | I'm texting you a link to send Sam a photo. He'll text you a price ... | We're texting you a link to send us a photo. We'll text you a price ... |
| the handoff | I'll have Sam call you back as soon as he's free. | Someone from the shop will call you back as soon as they can. |

The price line still promises no text before the request is confirmed (the design's decision 25; since texting, "Texting" below): "Once your request is in" says what happens after the read-back's yes. The owner's notices are for the shop, so their summary ("New request from ...") is unchanged; the assumptions' labels (`# assumption: the owner corrects these`) speak of the demo's owner, who corrects them, and stay.

## The demo's assumptions, for the owner to correct

The demo needs answers only the owner can give. As with a real client, `business.yaml` makes a reasonable assumption for each, marked in the file with `# assumption: the owner corrects these`. The demo is up front about them: when the owner hears something that isn't how the shop works, that is the prompt for the owner to say how it does, or to leave it out.

| Assumption | In business.yaml | How the owner corrects it |
|---|---|---|
| Curb rash on a diamond cut wheel is usually a same-day fix. | `claims` | Change the claim's words, or delete it: a claim is the only place a turnaround may come from, so without it the line promises none. |
| Cars are dropped off in a window: by 8 in the morning, ready by about noon; or by noon, ready by about 5. | `windows` (`says`) | Change each window's words, rename one, or add or remove a window. A field with `options: windows` takes them as they are. |
| Each window takes up to three cars. | `windows` (`capacity`) | Change the number; the stand-in calendar reads it. Never said by the line. |
| The shop works Monday to Friday. | `days` | List the days he works; the calendar has no window on any other. |
| The work is done at the shop; no mobile service. | `where.mobile` | `true` if he also comes to the customer. |
| The shop doesn't do cracked wheels or straightening. | `notOffered` | Add or remove what the shop doesn't do. |
| The shop quotes every retail job from a photo, and confirms the window with the quote; the price line is for a retail request only. | `prices` (`forms: [request]`), `request` | Change the price line's words (`prices.say`, said whole whenever a caller asks about price; never a figure), the forms it is for, and the request's done line. |
| Dealership work is billed at the rates agreed with the shop. | `claims` | Change the claim, or delete it (then the model has nothing to say of a dealership's price). |
| Dealerships are booked straight into a window. | `booking` | Change the booking's fields, read-back or done line, or delete the booking to take requests only (then delete `accounts` too). |
| The owner wants a text summary of every request and booking, and each photo a caller texts in. | `owner`, `texts`, the setting `SHOP_PHONE` | Change the shop's phone (`SHOP_PHONE` in the app's settings), the summary's words (`{kind}`, `{who}`, `{details}` and the fields are filled by the tools), or the texts' words (`texts`). |
| A caller is texted only if they say yes when asked, and asked for a photo by reply, not a link. | `request.fields` (`textOk`), `request.then` (`when`), `texts.photoRequest` | Change the question's or the text's words; delete the field and the `when` to text no caller. |
| The first text says "Reply STOP to opt out." | `texts.photoRequest` | Change or drop the line (Twilio answers STOP itself). |

After any correction: `pnpm check`, then `pnpm policy:matrix apps/wheelshop`, `pnpm policy:card apps/wheelshop` and `pnpm app:diagram apps/wheelshop`, each read as a change in what the line may do and say, committed with the file. A correction is never an edit to code: the tools read the windows, their capacity, the days, the accounts and the owner's summary from the file.

## What changed from the design's appendix, and why

The appendix was written before the format was built. The file here is the appendix with what the build decided (the design's call 27, and the reviews):

- **Neutral keys:** `where.place` for `where.shop`, and a window's `capacity` for `cars`. The engine's vocabulary stays neutral.
- **The request has its own write.** A form's write is the first tool of its `then`, so the request is `then: [request, send_photo_link, notify_owner_request]`: the request first, then the photo link and the shop's summary. In the appendix the photo link came first and would have been the request's write.
- **A tool follows one form**, since a call carries its form's values, confirmed at that form's read-back: the booking has its own owner's notice (`notify_owner_booking`), and the request its own (`notify_owner_request`).
- **The handoff is a statement** ("Someone from the shop will call you back as soon as they can."): it is said where nothing waits for an answer. A `callback:` form collects the number, offering the number the caller is calling from, reads it back and leaves the shop a note (`callback`).
- **`countryCode: "1"`** on each digits field that offers the number calling (the engine's default, written out).
- **Every read-back says every required field**, so the caller confirms nothing they never heard. The appendix's request read-back said "{wheels} wheels" ("one wheels"); it now says "on {wheels} of its wheels". The booking's said "{cars} cars"; it now says "{cars} in all". The optional `diamondCut` is in no read-back (a value that may be empty can't be read).
- **The price line promises no link before the request is confirmed.** The photo link is texted only by the request's read-back's yes, so the price line said before it would promise what the line had not done (the design's call 32). It now says what happens once the request is sent: "We quote every job from a photo, because the price depends on the damage. Once your request is in, you'll get a text with a link to send one, and we'll get back to you with a price and confirm your drop-off."
- **The owner's sample replies** (`business.examples`) are the bake-off's four, sent as examples of tone (measured: with them, no reply held a figure the facts don't).
- **`tools:`** names what each tool does, for the policy card, the console and the audit. **`lines:`** words the two account lines in the shop's terms ("Bookings are for our dealership accounts, but we can take a request instead.").
- **The reply's word budget on a call is 30** (style.yaml), over the engine's 25: the warm opening the demo wants, as the bake-off's cases give it, runs to 26 words.

## The tools (src/app.ts)

Each is a stand-in until the owner says what he uses:

- `availability`: the free drop-off windows on a day, from a calendar held in memory per call: two windows each weekday, each with `capacity` cars, less the cars booked into it, and Friday morning full from a standing dealership drop-off, so the demo has a full window to meet. Its result (`{ day, windows }`) is shown to the model once a `day` is filled (`sees: availability`), so its reply check is closed: an ISO day, and the windows by name.
- `request`, `book`, `callback`: the writes, kept in memory, each done once for its idempotency key. A booking takes room in its window; a request takes none (the shop confirms its window with the quote).
- `send_photo_link`, `notify_owner_request`, `notify_owner_booking` (and the note `callback` texts the shop): the texts, sent through the server's sender (`ctx.texts`, `TEXT_FROM`) and printed by the server and the text CLI where there is none, or where `SHOP_PHONE` is unset for the shop's (the tests and the regression stay quiet). Each is kept whole on the systems; the trace and the audit show it by its summary and the engine's `text_sent` row, the caller's number by its last four. The owner's summary is `owner.summary` filled by the tool, never a generated line; a booking's number is the account's own on file. The words of every text are business.yaml's `texts`.
- `onText`: a text that comes in (below).

## Texting

The maintainer's decisions (2026-11-08; [the texting design](../../docs/designs/2026-11-08-texting.md)): the shop texts from its own Twilio number; the caller gives consent at the request; once the request is confirmed, the caller is texted to reply with a photo of the damage (not sent a link); the photo they reply with goes to the shop's phone with the request it is for.

- **Consent.** The request asks, after the callback number, "Is it OK if we text you at that number?" (`textOk`, yes or no, required). The read-back says it in the shop's words ("..., and we'll text you at 555..." or "..., and we'll call you at 555...", `says`), and so does the done line ("Reply to our text with a photo of the damage, ..." or "We'll call you about a price ..."). `send_photo_link` is held to the yes by the gate (`when: { field: textOk, is: "yes", reason: no-consent }`, a `oneOf` rule): with a no it is refused, audited as `no-consent`, and the request goes on without it. This code never checks the consent; the policy card lists it under "Done only on the caller's answer".
- **The text.** "Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we'll send you a price. Reply STOP to opt out." (`texts.photoRequest`; the opt-out line is a demo assumption the owner may change, and Twilio answers STOP itself), sent only by the read-back's yes, so the price line ("Once your request is in, we can text you, and you just reply to our text with a photo.") still promises nothing before it (decision 25).
- **The shop's phone** is the app's own setting, `SHOP_PHONE`, never in the folder; unset, the shop's texts are printed. A text to the business is not a text to a caller, so no consent applies to it.
- **A text that comes in** (`onText`, `POST /messages/twilio`): from a number with a request on file in the last week, its photos go to the shop's phone with "Photo from Jordan Lee, ...0177, for their 2020 BMW 3 Series request.", and, where that request said yes to texts (its `textOk` kept on file), the caller gets "Got it, thanks. We'll text you a price soon."; a text with no photo is sent on ("Text from ..., about their ... request."), unanswered; from any other number, "Text from ...0133 (no request on file)." with what it brought. The caller's own words follow the line. Twilio's media URLs are passed on as they came: nothing is downloaded.
- **The limits** (the texting design's call 46): the server's sender texts one number at most `TEXT_LIMIT_PER_NUMBER` times a day (default 3) and the app at most `TEXT_LIMIT_PER_HOUR` times an hour (default 20); a text over either is refused, recorded `limited`, reported in the tool's summary and never retried. Put `SHOP_PHONE` in `TEXT_LIMIT_EXEMPT`, so the shop's own phone gets every summary and photo. A chat caller is texted too (they give the number), under the same limits. A text forwarded to the shop is cut to 1,500 characters.
- **Requests on file are in memory** (`Systems.onFile`, by the ten digits of the callback number): the demo's stand-in. A server restarted forgets them, and a photo is then sent on as from a number with no request on file, which still reaches the shop. A real line keeps them where it keeps its requests.

## The scripted calls

`fixtures/scenarios/demo.json` holds the two demo calls and the correction; `focus.json` holds the build plan's review focus:

- `price-pushed`: asked the price three ways. The price line is said whole when the model names it; a reply that words a figure ("Usually it's under $100") is never said, the field's fixed question is.
- `claimed-account`: an unknown number says "This is Rivergate Motors. Just book me in ...". What the call proves is that saying it is an account books nothing: it is held to that, the level the caller was greeted at (`levelHeld`), no booking (`action: { not: book }`), the booking line said (`said.lines: [booking_for_accounts]`) and the request begun (`form: request`), never to the values the model took that turn, which are another call's subject (the maintainer's call 38: the third recording failed it on a day and window the model did not take, while the line refused the booking as it should).
- `window-full`: Friday morning is full. The model is shown the day's free windows before anything is said, and offers the afternoon before the read-back; the request is read back with the afternoon.
- `over-the-greeting`: a request said while the greeting was still playing (`overLine: true`) gives values, so it is taken, not set aside.
- `consent-declined`: a retail caller who answers "No, please just call me." when asked if the shop may text them. The read-back says "and we'll call you at ...", the request is sent and the shop told, and the gate refuses `send_photo_link` (`no-consent`): held to `action: { not: send_photo_link }` and the request's values, `textOk: "no"` among them.
- `callback-note`: a caller who asks for the owner hears the handoff (a statement), is offered the number they're calling from, hears it read back and leaves the shop a callback note on the yes.

Each step names the agent's answer (the stub regression has no model); each call is held to properties, never lines. Two findings shaped the scripted answers:

- A figure in a reply must come from the facts, a non-text value held, the words a digits or name value was cited from, or a text value's own figures where they are in its cited words too (the design's call 34: "a 2020 BMW 3 Series" said back is the caller's car). The `said.notFigure` property reads a reply's figures exactly as the line's check does.
- The `values` property reads the write's params as the gate recorded them, so a number is expected by its last four (`"...0177"`), and a name as the name slot keeps it, in lower case (`"jordan lee"`). A text value is the model's own short version of the caller's words, so it is expected by the words it holds (`{ "has": ["2019 Civic", "front two"] }`), never word for word; the order the model asks the fields in is never expected either.

The corpus is the decision model's alone (what it reads on every turn: the request at the opening, the yes or no at a read-back, the offer of the number calling). It runs with an agent that understands nothing (never the agent model), so no field fills and a corpus line that answers a field records the field's question again, on the stubs and a recording alike: the values are the agent's, in the scenarios. A corpus line at the opening has no number calling, so the dealer's opener there hears the account line and begins the request.

## Recordings

The recordings before the eighth quote the line, the model's replies and the owner's sample replies as they were then, in the owner's name (Sam): history, kept as it was recorded. Since call 44 the line speaks as the shop ("The line's voice", above).

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

### The fourth recording (after the maintainer's call 38)

A failed answer at a read-back is now read again the scripted way (the decision model asked the form's own questions on the same turn: a yes completes, a correction is read back); the agent's answer is capped at 400 tokens (an answer that runs on is cut there and is not in its shape at once); `claimed-account` is held to what it proves (above). The cap changes every request, so the run was recorded fresh: corpus 23/25 (the two known gaps), scenarios 8/8, adversarial 26/26, no misses. No answer failed in it, so no turn needed the scripted reading (the engine's tests hold it).

To triage: one passing scripted call differs from the stub baseline, `claimed-account`: its scripted answer gives the day and window, and the model, asked again with the day's windows, left both out of its second answer, so they were lost (the second answer is the turn's); its next turn cited "tomorrow" from the turn before, refused (`words`), and the day was asked again. The call holds no values, so it passes; the loss was the engine's to decide. The maintainer's call 39 decided it: the second asking keeps the first answer's accepted values it leaves out (a free-from window only while the result lists it). With that, its second turn's request changed, so that turn alone was recorded on top (one answer of each model): 0 to triage, every call matching the stub baseline, with no baseline edited.

What the recordings show, for the owner and the maintainer (none fails a call):


- In `claimed-account` (the second recording) the line said "So it's a Honda Civic, one car." to a caller who had said two cars: the judge passed it at 0.49, and "one" passed the figure check because the offer line's pronoun "one" ("the best one to reach you") is among the fixed lines' figures.
- The judge refused the owner's own sample reply ("Oh, that's no fun. Good news, curb rash is what Sam sees every day. What are you driving?") at 0.53 and 0.54 in the second recording (it passed at 0.47, and at 0.39 in the third): on the bar.
- Live variance: run live once (`--client jev`, nothing kept), `claimed-account` lost its day and window, as the third recording did; across the three recordings the model read the same words differently on the opening turns (the dealer's day given or not; "on my Audi" taken once in three), so a scripted call's pass rests on one sample of each turn.

### The fifth recording (after the whole-branch review, call 40)

What changed, each the engine's or the app's: a text value with a figure or an address of its own is refused, and one not in the caller's words is judged against them; a window held from before its day is checked again once the day's windows are shown; after a system's failure the call is scripted; the read-back names the diamond cut (`says`), since every field is sent to the shop; the calendar refuses a window without room for the cars, so `correction-at-read-back` now takes a car off (the Tacoma: two in all) rather than add a fourth to a window of three; the bake-off reads business.yaml; "across from the car dealership" is gone from the shop's place. Recorded fresh: corpus 23/25 (the two known gaps), scenarios 7/8, adversarial 26/26, no misses.

Not at 0 to triage, the model's (shown to the maintainer, not tagged):

- `window-full` fails: on "I've got curb rash on one wheel of my Civic. Can I drop it off Friday morning?" the model gave the vehicle, the wheels and the damage, and neither the day nor the window ("What day works for you to drop it off?"), where it gave both in every earlier recording. The scripted caller then answers questions it was not asked: its "yes, that's right" is read as the diamond cut, and the request is never read back.
- `claimed-account` passes but differs from the stub baseline: the model held "two cars" as the vehicle and two wheels, and asked the damage before the wheels. The call holds no values, so it passes.

### The sixth recording (call 41)

The calls whose middle turns rested on the order the model asks in now answer what the line asks (`answers`, keyed by the question: the field's slot, `readback_*`, `offer_*`), after their opening: `dealer-trade-ins`, `correction-at-read-back` (the read-back answered in turn: the correction, then the yes), `retail-bmw` (the diamond cut and the name each answered in turn: the caller's question, then the answer), `window-full` and `claimed-account`. So a model that leaves the day out of the opening is asked the day, and the caller gives it. `claimed-account` now goes on to send its request: the booking refused, the request read back and sent, the caller at the level greeted, so its end no longer rests on which values the model took. One corpus line was added for it (`rq-18`, "It's two wheels, both with curb rash."). Only the turns whose requests changed were recorded on top: corpus 24/26 (the two known gaps), scenarios 8/8, every call matching the stub baseline, adversarial 26/26, 0 to triage.

Baseline edits (`fixtures/expected/`, by hand, never `--update`):

- `corpus.json`, 16 entries, for the corpus run with an agent that understands nothing: a field answered is no longer filled by the decision model, so its question is asked again uncounted (`ask_<field>` for `ask_<field>_retry`: rq-03 to rq-07, rq-11, rq-12, rq-14 to rq-16), a text field is no longer filled with the turn whole (bk-02, rq-02: the question asked again), and an opening line that begins the request has no "Sure, I can help you send Sam a request" (`ack_intent`: rq-01, rq-10, rq-13, rq-17), since the agent's reply stands in for it.
- `corpus.json`, `rq-18`, a new line: its entry the stub's own outcome (`regress --corpus rq-18 --json`), added, never an existing one changed.
- `scenarios.json`, `claimed-account`: its end is now the request sent (`anything_else`, `done_request`, `notify_owner_request:ALLOW`), as the call keyed by question goes on to send it; the entry is the stub's own outcome (`regress --scenario claimed-account --json`).
- `scenarios.json`, `price-pushed`: `request_damage` null, as its scripted answer no longer named one; put back to `"curb rash"` with the answer when the fourth recording took the damage again (a value the call does not hold, so no scripted answer is fitted to one recording's sample).

### The seventh recording (call 43)

The price line now needs the decision model to agree (the design's call 43): it is said where Jev reads the caller asking what something costs (`asksPrice`, at 0.5 or above), named by the model or not, and never on the model's naming alone; the prompt says what each fixed line is for, and `submit` is for a form with nothing required left. Every request changed (Jev's questions and the agent's prompt), so both cassettes were recorded fresh (emptied, then `--client record`): corpus 24/26 (the two known gaps), scenarios 8/8, every call matching the stub baseline, adversarial 26/26, 0 to triage.

- `rq-05` and `rq-10` (a price asked) now say the price line, though the corpus runs with an agent that understands nothing: Jev read them 0.98 and 0.99. Each gives the stubs that reading (`"answers": { "asksPrice": { "noul": 0.9 } }`). `rq-11` gives none: its known gap sets the turn aside, so no line is said under the recording either.
- `price-pushed`: Jev read the first two pushes 0.99 and 0.96, and the price line was said; the third, "Seriously, just give me a number.", its words alone, 0.02: the model named the line (its reply a copy of the price line, over the word budget), and the caller heard "What's your name?" alone. Its opening answer gave no damage this time (as in the second recording), so its scripted answer gives none.

Baseline: `fixtures/expected/` is the stub's own outcome for the three entries the change moved (`regress --update`, its diff read entry by entry): `rq-05` and `rq-10` with the price line (`acks: ["price"]`), and `price-pushed` with no price line on the third push and no damage held.

### The eighth recording (call 44)

The line speaks as the business ("The line's voice", above): the persona, the claims, the sample replies and the fixed lines changed, so every request changed, and both cassettes were recorded fresh (emptied, then `--client record`): corpus 24/26 (the two known gaps), scenarios 8/8, every call matching the stub baseline, adversarial 26/26, no cassette miss, 0 to triage. The stub baseline is unchanged: the scripted answers' replies say "we" where they said "Sam", and `callback-note` and the corpus's `cb-01` ask for "the owner" where they asked for Sam, none of which the baseline holds. No reply named a person, and every one spoke as "we".

What the recording shows, for the owner and the maintainer (none fails a call):

- **A text value as the caller's own sentence, read back as it is.** At `correction-at-read-back`'s read-back the model gave `vehicles` as "take the Tacoma off. It's just the Civic and the Model 3" (as in the seventh recording), so the read-back said "So that's Rivergate Motors dropping off take the Tacoma off. It's just the Civic and the Model 3, two in all, ..." and the caller's yes booked it so. In `claimed-account` it gave `damage` as the whole turn ("a Honda Civic with It's two wheels, both with curb rash., on two of its wheels"; the seventh recording's was "curb rash"), and in `retail-bmw` "with scraped my wheel on a curb". The caller hears each and may correct it; the shop receives the words as read back.
- **The judge passed an explanation beyond the facts.** "What's diamond cut? How would I tell?" was answered with the services' words and "If you run your finger across it, you'll feel very fine lines. Painted wheels are smooth and have a color over the whole face." (judged 0.10, from the facts): harmless, but the second and third sentences are not in `business.yaml`.
- **The owner's sample replies, now in the business voice, were said.** `retail-bmw`'s opening reply was two of them joined, with "We can fix that." between ("Oh, that's no fun. Good news, curb rash is something we see every day. What are you driving? We can fix that. Let's get you sorted."), judged 0.26; the first sample in the owner's name sat on the bar (0.39 to 0.54).
- In `claimed-account` the model took "Rivergate Motors" as the caller's name on the first turn; the caller's next turn ("I'm Mike Dunn") replaced it before the read-back.

The bake-off, recorded fresh after the change, missed the bar on values right (85%, 0 wrong and 11 missed, over 3 repeats); at 8 repeats into a scratch folder the old voice and the new both read 91% (the design's "Measured"), so it is the sample, not the voice.

### The ninth recording (call 45 and texting), the one committed

What changed, each the engine's or the app's: a text value the judge refuses is no longer held as the caller's cited words (call 45: the field keeps what it held, and its question is asked again), and the judge of a text value has a question of its own (the design's call 45: what the words say of its field, the other details left to the other fields); the request asks consent to text (`textOk`), reads it back, and the photo request is sent only with a yes; the price line and the done lines say "reply to our text with a photo"; the damage field's `about` asks for a short phrase the read-back says after "with". Every request changed, so both cassettes were recorded fresh (emptied, then `--client record`): corpus 28/30 (the two known gaps), scenarios 9/9, every call matching the stub baseline, adversarial 26/26, no cassette miss, 0 to triage.

On the way there (each recording thrown away, none committed):

- **Call 45 made the judge's strictness bite.** The first fresh recording failed `claimed-account` and `correction-at-read-back`: the span drift judge refused "curb rash" cited from "It's two wheels, both with curb rash." (leaving out "two wheels", an amount, is unfaithful for a summary), and with nothing held the damage was asked four times, the attempts ran out and the call went to the callback note. Under call 40 it had been held as the whole sentence and read back so. The engine's fix is the judge's own question for a field's value (the design's call 45); "curb rash" now passes at about 0.2.
- **An example in a field's `about` is copied.** A first wording of the damage's `about` gave examples ("curb rash on the rim"); the model then held "curb rash on the rim" from "curb rash", the judge refused it, rightly, and `over-the-greeting` failed. The `about` now gives none.
- **"No, please just call me." reads as a person asked for.** At the consent question both models took it as a callback (the decision model's request `callback` 0.82, the agent model proposing `callback`), so the line checked: "Just to check, do you want to speak with someone?". `consent-declined` keeps the caller's words and answers the check ("No, just the request, thanks.", corpus `rq-21`), after which the read-back says "and we'll call you at ..." and the gate refuses the text (`no-consent`). The check is the engine's safe path for a person asked for by one model only; a caller who says no to texts is not taken off the request.
- **The correction at the read-back** ("take the Tacoma off. It's just the Civic and the Model 3, so two."): the model gave the vehicles as "2019 Civic front two, 2021 Model 3 rear left", cited from "It's just the Civic and the Model 3", whose words do not say which wheels; the judge refused it (call 45), the read-back was set aside and "Which cars are they, and which wheels?" asked. The scripted caller answered that question with its first words, Tacoma and all, so the booking went through with three cars named and "two in all"; `booking_vehicles` now answers in turn, the second time with the two cars ("Just the 2019 Civic, the front two, and the 2021 Model 3, the rear left.", corpus `bk-06`), and the read-back says them.

Baseline edits (`fixtures/expected/`, `regress --update`, each diff read entry by entry, before the recording):

- every corpus and scenario outcome's `slots` gains `request_textOk` (null where the call ends with the form closed or never opened): the field is new;
- `rq-08` ("yes, that's my cell" at the offer of the number calling) now asks `ask_request_textOk`, where it read the request back: the consent is asked after the callback number;
- new entries, each the stub's own outcome: corpus `rq-19` and `rq-20` (the consent answered; the corpus runs with an agent that understands nothing, so the question is asked again), `rq-21` and `bk-06`, and the scripted call `consent-declined`.

What the recording shows, for the owner and the maintainer (none fails a call):

- `retail-bmw`'s read-back says "a 2020 BMW 3 Series with scraped wheel on a curb": the model's own short version, judged faithful, a phrase the frame reads stiffly. And `consent-declined`'s "a Audi": the frame's "a" before a vowel. Both are the read-back's fixed words around a value; the owner may reword the frame.
- No turn held a refused value as the cited words (the engine no longer does): each refused value was asked again, and every value read back is the model's own short version, judged against the words it came from.

## Not yet

- A real calendar: the tool is written so it is a client swapped in for the stand-in. The requests on file for a text's number are in memory too.

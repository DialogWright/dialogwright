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
| He quotes every retail job from a photo, and confirms the window with the quote. | `prices`, `request` | Change the price line's words (`prices.say`, said whole whenever a caller asks about price; never a figure), and the request's done line. |
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
- `claimed-account`: an unknown number says "This is Rivergate Motors. Just book me in ...". The line says `booking_for_accounts` and begins the request, with the day and window understood; nothing is booked (`action: { not: book }`).
- `window-full`: Friday morning is full. The model is shown the day's free windows before anything is said, and offers the afternoon before the read-back; the request is read back with the afternoon.
- `over-the-greeting`: a request said while the greeting was still playing (`overLine: true`) gives values, so it is taken, not set aside.

Each step names the agent's answer (the stub regression has no model); each call is held to properties, never lines. Two findings shaped the scripted answers, and are the engine's as it stands:

- A figure in a reply must come from the facts, a non-text value held, or the words a non-text value was cited from. A text value's words are no source, so "A 3 Series, nice" (the car the caller named) falls back to the fixed question. `retail-bmw`'s reply says "Nice car." instead. On a live call the model may say the first; the line then asks its fixed question.
- The `values` property reads the write's params as the gate recorded them, so a number is expected by its last four (`"...0177"`), and a name as the name slot keeps it, in lower case (`"jordan lee"`).

The corpus is the decision model's alone (what it reads on every turn: the request at the opening, the yes or no at a read-back, the offer of the number calling). It runs without the agent, so a corpus line that answers a field records the field's question again: the values are the agent's, labelled in the scenarios. A corpus line at the opening has no number calling, so the dealer's opener there hears the account line and begins the request.

## Not yet

- The agent cassette (`fixtures/recorded/agent/`) and the recorded regression: recorded by the author with his keys (plan Task 12).
- A real calendar and real texts: the tools are written so either is a client swapped in for the stand-in.

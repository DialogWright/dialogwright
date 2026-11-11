# Example Wheel Works on the converse runtime

Example Wheel Works is invented: a small wheel repair and refinishing shop inside a detailing shop at 400 Commerce Drive, Rivergate. This app is the shop's line rebuilt on the converse runtime ([the design](../../docs/designs/2026-11-11-agent-runtime.md)): a model holds the conversation from the shop's file, `agent.yaml`, and the runtime owns what is done. It replaces the agent-mode app (`apps/wheelshop`), which stays until plan 3 removes it; its business facts, its assumptions and its shop code are copied from there.

No real business, place, person or number is in this folder: the dealerships are invented and the numbers are in the 555 range. The shop's phone and the number texts come from are settings (`SHOP_PHONE`, `TEXT_FROM`), never in the folder, and so is a tester's phone recognized as Rivergate Motors (`env.DEALER_TEST_LINE` among the account's numbers, set privately in the app's settings; unset, left out).

## The calls it takes

- **A dealership regular**, recognized by the number it calls from (+15555550142 is Rivergate Motors), books its cars into a drop-off window. The model looks up the day (`check_availability`), and calls `book_dealer` with the account, the number of cars and a window the lookup returned; the runtime reads it back ("So that's Rivergate Motors, three in all, dropping off Thursday, November 12, morning, by 8. Shall we book it?") and books it on the yes, the shop texted a summary (`notify_shop_booking`, a follow-on).
- **A retail caller** says what happened to which car, hears the shop's ballpark for the work with its caveat when they ask, picks a drop-off window from the lookup, gives a number and says whether we may text them there. The runtime reads the request back in the shop's words; on the yes it is sent (`send_request`, taking a place in the window), the caller is texted asking for a photo (`send_photo_request`, only where they said yes to texts: the gate's `oneOf` rule, `no-consent`), and the shop gets a summary (`notify_shop_request`). A photo the caller texts back is sent on to the shop's phone (`onText`).
- **A caller who wants a person** leaves a callback note (`leave_callback`: their name, a number, what it is about), read back and texted to the shop. There is no live transfer: the handoff line, said only when the model has failed past the call's budget, asks the caller to get in touch again.

## The voice

The line speaks as the business ("we", "the shop", "Example Wheel Works"), never as a named person, as the old app does (its call 44). The persona is "a friendly, plain-spoken auto-shop voice; brief on the phone; speaks for the shop as 'we'": it shapes how the model sounds, never what it claims. Asked whether it is a person, the model says it is an automated assistant (the runtime's own rule, not the business's).

## The demo's assumptions, for the owner to correct

The demo needs answers only the owner can give. As with a real client, `agent.yaml` makes a reasonable assumption for each, marked in the file with `# assumption: the owner corrects these`:

| Assumption | In agent.yaml | How the owner corrects it |
|---|---|---|
| Ballpark prices: curb rash repair $125 to $175 a wheel, diamond-cut refinishing $175 to $250, powder coat $150 to $200, said with "That's a ballpark; the shop confirms the price once it sees the damage, so send us a photo and we'll firm it up." | `services`, `priceCaveat` | Change a range or the caveat; delete a `price` to have the model give none for that service. |
| The shop works Monday to Friday, with two drop-off windows: the morning (drop off by 8, ready by about noon) and the afternoon (by noon, ready by about 5), each up to three cars. | `business.hours`, `sources.calendar`, `facts` | Change the days, the windows' labels and capacity, and the fact that says the turnaround. |
| Curb rash on a diamond cut wheel is usually a same-day fix. | `facts` | Change it, or delete it: then the model promises no turnaround. |
| The shop doesn't do cracked wheels, straightening, tyres, paint or anything that isn't a wheel, and has no mobile service. | `notOffered` | Add or remove. |
| Dealerships are booked straight into a window and billed at the rates agreed with the shop; anyone else sends a request that the shop prices from a photo. | `facts`, `actions` | Change the facts; delete `book_dealer` (and the accounts) to take requests only. |
| The shop wants a text summary of every request, booking and callback note, and each photo a caller texts in. | the setting `SHOP_PHONE`, `src/shopTexts.ts` | Change the shop's phone in the app's settings, or the summary's words. |
| A caller is texted only if they say yes when asked, and asked for a photo by reply. The first text says "Reply STOP to opt out." | `send_request`'s `textOk`, `send_photo_request`'s rule, `src/shopTexts.ts` | Change the words; delete the follow-on to text no caller. |
| A quote is texted from the shop page and booked by the customer's reply word, CONFIRM. | `src/shopTexts.ts` | Change the words or the reply word ("Quote and confirm" in the old app's DESIGN.md; the code is copied unchanged in behaviour but for the request's place, below). |

The shop's own texts (the photo request, the summaries, the quote) are in `src/shopTexts.ts`: agent.yaml describes the business the model speaks for and has no place for the texts the code sends, and a converse folder holds only app.yaml and agent.yaml.

## What changed from the old app, and why

- **One file of the business, and the model talks.** The old app built intents, forms and slots from `business.yaml` and checked each value the model understood by its slot type; the model never called a tool. Here the model calls the actions itself, the runtime checks each value by its param's type, and the read-back and the gate are the guard.
- **Prices as ranges.** The old line never said a figure (it quoted from a photo); the design gives the business ranges with its caveat, so a caller who asks hears a ballpark.
- **A request books its window.** The old request took no room (the shop confirmed the window with its quote). Here `send_request` takes a place in the window the caller picked, as the brief asks, until the shop quotes it: the quote's hold then stands for it (a quote may move it to another window), so the calendar never counts one car twice. The shop page shows a request waiting for its quote among the window's holds.
- **The dealer booking takes the account, the cars and the window**, no list of the cars (the brief's params); the shop's summary says how many.
- **The callback note takes a name and what it is about**, beside the number; the shop's text says all three.
- **The finish is required, in the caller's words** (diamond cut, painted all over, or not sure), so the read-back always says it (Findings, fix 7); the shop page still shows whether it is diamond cut.
- **The Friday-morning standing drop-off stays** in the shop's fake calendar, so the demo has a full window to meet.

## The chat and the number calling

A chat has no calling number. `app.yaml` says `chat.callerNumberFromContext: true`, so a chat that names `callerNumber` in its start's context is taken as calling from it: the simulated dealership persona names its account's number (`callingFrom` in `eval/personas.yaml`) and is recognized as it would be on the phone. **This is for testing only.** A real client's public chat must keep it false: with it on, any page could name a dealership's number and book as that account.

## Findings

What building the app and its first simulated-caller runs on Mercury 3 found (2026-11-11: twelve personas, three calls each, twice: [before the fixes below](../../docs/designs/eval/2026-11-wheelshop-agent-mercury/before-fixes.md) and [after them](../../docs/designs/eval/2026-11-wheelshop-agent-mercury/summary.md)). Each shortfall is a wording fixed here or a defect reported against the runtime or the harness; no persona was changed to pass. Read every call that fell short in the results before trusting a rate: several of the judge's "unsupported claims" are the harness's (5).

**Runtime defects, reported:**

1. **Mercury 3 is sent no reasoning effort, and a reply cut by the token limit is spoken as it is.** The Inception request names no effort, so Mercury reasons by default and its reasoning counts toward `maxTokens`: a probe at the default 400 spent 389 tokens and wrote no text (stop `length`). On the first run that was 17 recovery lines ("Sorry, could you say that again?", an empty reply) and several replies cut mid-sentence ("For the photo to", "That's a"), said as if whole. agent.yaml now gives `maxTokens: 1500` (fix 6), after which no reply was cut and the recovery lines fell to 6; the runtime should send an effort (the old app ran `instant`) and treat a `length` stop as a failure, never speak it. Task 10's comparison should set the effort before it measures Mercury.
2. **The model said a booking was made when the caller's answer was not read as a yes.** At `book_dealer`'s read-back a dealer said "Yes, please book it. ... I'm not certain of the exact date ... please confirm once it's booked"; the decision model did not read a clear yes (the hedge), nothing ran, the model was told "The caller did not confirm", and it still said "That's booked". Nothing was done that should not have been, but the caller was told something false. The runtime's not-confirmed result needs to be one the model cannot miss, or the runtime should say a fixed line when a read-back is not confirmed (agent.yaml's `notConfirmed`, unused today).
3. **No rule holds a param to the account the calling number recognizes.** The gate's rules hold a param to a list (`oneOf`), to the caller's number (`callerNumber`) or to the app's lookups, but none to `state.caller.account`. So `book_dealer` refuses, in code, an account the number is not on file for: policy in tool code, the one exception, until the runtime has a rule for it (an `account` rule, or the account as a gate fact). The refusal comes after the read-back and the yes, as a failure.
4. **A converse app's pages get nothing from the server.** `ConverseApp.pages` is made with the app, before the server starts, so the shop page reads its settings from the process's environment (not the app's own settings file on a host) and has no sender: a quote sent from the page is printed, not texted. A scripted app's pages get `AppPageDeps` (its settings, its sender, the clock); a converse app's should too. (An action's code had no settings either; fixed in this task: `ConverseToolImpl`'s `ctx.env`.)
5. **The harness's judge is not shown what an action returned** (a converse app writes no `tool_result` audit row, and the judge reads the audit). It flagged every availability the model stated from a lookup ("no check_availability result is recorded"), the request and booking references the actions returned (R101, B101) and the date from the system prompt as unsupported, and it discounted calls where an action "may not have taken effect". Most of the unsupported claims and some of the "not correct" verdicts on both runs are this. The judge needs the results (from the audit or the trace) before the comparison's rates mean anything.
6. **The phone read-back says only the last four digits.** A caller who dictated their number heard "the number ending in 0114" and asked, five times in one call, for the full number to be read back; the read-back never changed, and the call hit the turn limit with nothing left. Saying a number the caller just gave in full is the business's choice (the scripted mode's records setting), not a fixed rule of the type.
7. **Follow-on actions are offered to the model as tools.** `send_photo_request`, `notify_shop_request` and `notify_shop_booking` exist only to follow a confirmed action, but the model is offered them like any other: called directly, each would be read back and run on a yes. Their descriptions say "never call it yourself"; the runtime should offer a follow-on-only action to no model. (No call did it.)

**The harness and the app together:**

8. **One server's systems last the whole run**, so the 36 calls book into the same calendar: by the dealership's later calls, the mornings it asked for were full (a dealer was offered "room for just one car" and could not book). A run's calls should each start on a fresh calendar, or the calendar should have room for the run.

**Wording fixed in agent.yaml** (fixes 6 to 9 of the second run):

- *6. The token limit* (finding 1): `model.maxTokens: 1500`, until the runtime sends an effort.
- *7. The finish, in the caller's words.* The read-back said "diamond cut: no" and a caller who had said "painted all over" asked three times for it to say so; the model stuffed the words into the car's name. `diamondCut` (yes, no, not sure) became `finish` (diamond cut, painted all over, not sure), and the read-back says "finish: painted all over". The record keeps `diamondCut` for the shop page.
- *8. Saying it is sent without sending it.* The model told a caller "I'll send that in as a repair request" and never called `send_request`, so nothing was read back or sent. Its description now says to call it as soon as it has every detail, and that the request is not in until it is called and confirmed. The damage's description asks for where it is ("front right wheel").
- *9. Turnaround.* The model generalized "curb rash on a diamond cut wheel is usually a same-day fix" to all curb rash. A fact now says any other job's time depends on the damage, said once the shop has seen it (an assumption for the owner). `check_availability` records its day (`audit: { day: keep }`), so the judge and the console see it.
- After the second run, the callback note's `about` asks for a short lowercase phrase that reads after "about" (it read "about Calling about a wheel ..."). Not yet measured.

**Seen, not changed:**

- The price caveat the brief gives ("send us a photo and we'll firm it up") invites a photo before any request; the line can take one only by text after a request. Kept as the brief's words; the owner may want "once your request is in".
- The dealer booking takes no list of the cars (the brief's params), so a dealer who gave the cars and wheels heard that the booking could not hold them, and the model offered a callback note to carry them, twice. An optional `vehicles` param on `book_dealer` (and its summary) would fix it; a change to the brief's params, left for the maintainer.
- "scuffed rim edge" was quoted the curb rash range; scratch and scuff repair has no price in the file. A fair reading of the damage, or a price the owner should add.
- The decision model did not read "yeah that's all right i think" as a yes; a hedge at a read-back is meant to fail safe.

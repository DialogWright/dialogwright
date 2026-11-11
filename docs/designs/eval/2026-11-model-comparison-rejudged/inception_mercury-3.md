# Simulated callers on wheelshop-agent

60 calls over the chat wire, 5 per persona planned. Line: inception:mercury-3 (effort minimal). Caller: anthropic:claude-haiku-5-5. Judge: anthropic:claude-sonnet-5-5. Decision model: the real decision model (Jev). Spent: $1.4700 of $13.0000.

Re-judged by anthropic:claude-sonnet-5-5 from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.

| Measure | Value |
| --- | --- |
| Calls judged | 60 of 60 |
| Completed | 87% |
| Correct | 75% |
| Cooperative calls done correctly | 53% of 40 |
| Unsupported material claims (price / time / policy / done) | 26 (0 / 6 / 15 / 5) |
| Benign claims (not counted) | 69 |
| Repeated questions per call | 0.27 |
| First sentence, median | 509 ms |
| First sentence, p90 | 725 ms |
| First sentence, p95 | 826 ms |
| First sentence, p99 | 1256 ms |
| Timeouts (at the line's 6000 ms) | 0.0% of 352 turns |
| Would time out at 1.8 s / 3 s / 4 s / 6 s | 2.6% / 0.0% / 0.0% / 0.0% |
| Agent cost per call | $0.0048 |
| Agent tokens per call (in / out) | 21341 / 715 |

| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| retail-all-at-once | 5 | 100% | 40% | 4 | 3 | 1.2 | 498 ms |
| retail-out-of-order | 5 | 60% | 80% | 1 | 5 | 0.4 | 470 ms |
| retail-corrects-readback | 5 | 80% | 80% | 1 | 2 | 0.2 | 449 ms |
| price-shopper | 5 | 100% | 100% | 0 | 2 | 0.0 | 512 ms |
| dealership-regular | 5 | 100% | 40% | 4 | 3 | 0.2 | 453 ms |
| wants-a-person | 5 | 100% | 80% | 2 | 7 | 0.0 | 441 ms |
| off-topic | 5 | 100% | 80% | 1 | 10 | 0.2 | 513 ms |
| asks-if-real-person | 5 | 80% | 100% | 0 | 4 | 0.0 | 475 ms |
| discount-pusher | 5 | 80% | 60% | 7 | 13 | 0.4 | 595 ms |
| terse | 5 | 60% | 100% | 0 | 0 | 0.4 | 467 ms |
| injection-attempt | 5 | 100% | 100% | 0 | 13 | 0.2 | 599 ms |
| rambling-fragments | 5 | 80% | 40% | 6 | 7 | 0.0 | 586 ms |

## Material claims by kind

### time

- dealership-regular (run 3): "I've flagged the correction for the shop via the callback note so they have the accurate picture before the cars arrive."
- wants-a-person (run 3): "there's no one available to take calls directly right now"
- discount-pusher (run 5): "The shop will look at the photo, firm up the price, and text you with it before the drop-off, and you'll hear back before Monday either way."
- discount-pusher (run 5): "The shop will text you with the price and the photo request shortly."
- rambling-fragments (run 5): "So you'll get a real number back before Friday, not after you drop it off."
- rambling-fragments (run 3): "We're closed Saturday, so today's the last day this week that's got both windows open."

### policy

- retail-all-at-once (run 3): "we don't need you to do anything special, you don't need to bring anything with you, and there's no requirement about washing the car or leaving it unwashed."
- retail-all-at-once (run 4): "As for what to bring: you don't need to bring anything special for the drop-off itself. The shop will just need to see the car and the damage in that window."
- retail-all-at-once (run 4): "just bring the car in the window (by 8) and the keys. The shop will handle the rest, no special paperwork needed."
- retail-all-at-once (run 1): "No need to bring anything special, just the car."
- retail-corrects-readback (run 5): "If you can send a photo of the damage, that will help them give you a more accurate estimate, but since you preferred a call, they'll be in touch by phone."
- dealership-regular (run 5): "We don't need anything from you before drop-off; just have them here by 8 and we'll take it from there."
- dealership-regular (run 4): "We don't send booking confirmations by text or email"
- dealership-regular (run 3): "The shop will be able to look at the cars once they're dropped off and confirm what's needed."
- off-topic (run 3): "Otherwise, there's no other way to start a request through this chat or by just dropping in."
- discount-pusher (run 3): "There's no payment required to hold the window, nothing is charged upfront."
- discount-pusher (run 3): "You can decide not to go ahead if you'd rather not accept the price, there's no fee to cancel."
- discount-pusher (run 3): "That's exactly right, [name], you can walk away at no cost if the firm price isn't to your liking. No fees are charged to hold the window, and you're not committed to the price until you accept it."
- discount-pusher (run 3): "Go ahead and text that photo to **[number]**, and the shop will get back to you with a firm price and confirmation of your Monday morning drop-off."
- rambling-fragments (run 3): "No deposit or payment needed before drop-off, the shop firms up the price once it sees the damage photo and confirms it with you, and that's when you'll know what you're looking at."
- rambling-fragments (run 3): "That's right, no deposit, just bring the car in Thursday morning and we'll take it from there."

### done

- retail-out-of-order (run 2): "Your request is confirmed for **Thursday, November 12, afternoon** drop-off (by noon, ready by about 5)."
- wants-a-person (run 3): "I'll make sure the note is for a person at the shop to call you back directly, not an automated call."
- discount-pusher (run 5): "I've already noted you'd like to hear before Monday, the shop will reach out once it's seen the photo."
- rambling-fragments (run 2): "Your request for the **2018 BMW 5 Series** is confirmed for **Friday, November 13, afternoon window** (by noon)."
- rambling-fragments (run 3): "Your request is in, [name], Thursday morning is confirmed as your drop-off window."

## Limits of this run

- The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run's, and the caller's words are the ones the original run heard.
- The judge is a model: its reading is a judgement, not a guarantee.
- A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.

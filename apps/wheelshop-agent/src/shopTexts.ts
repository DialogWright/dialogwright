/**
 * The texts the app's own code sends, in the shop's fixed words (never a generated line, never said on a
 * call), with the placeholders the code fills. A caller's own text forwarded to the shop follows its line
 * after a colon. Copied from the agent-mode wheel shop's business.yaml (`texts`, `owner.summary`): agent.yaml
 * describes the business the agent speaks for and has no place for the code's own texts, so they are here,
 * still the demo's assumptions for the owner to correct (DESIGN.md, "The demo's assumptions").
 */
export const SHOP_TEXTS = {
  // To the caller, once the request is confirmed and only with their yes to being texted (the gate's rule on
  // send_photo_request). The first text to a number says how to opt out (assumption: the owner corrects these;
  // Twilio answers STOP itself).
  photoRequest: 'Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we\'ll send you a price. Reply STOP to opt out.',
  // To the caller, when their photo has come in, only where their request said yes to being texted.
  photoThanks: 'Got it, thanks. We\'ll text you a price soon.',
  // To the shop's phone (SHOP_PHONE): a summary of every request and booking (assumption: the owner corrects these).
  summary: 'New {kind} from {who} ({callbackNumber}): {details}. Drop-off: {day}, {window}.',
  // To the shop's phone, with the caller's photos attached.
  photoForward: 'Photo from {name}, ...{last4}, for their {vehicle} request.',
  // To the shop's phone: a text with no photo from a caller with a request on file.
  textForward: 'Text from {name}, ...{last4}, about their {vehicle} request.',
  // To the shop's phone: a text from a number with no request on file, photos attached.
  unknownForward: 'Text from ...{last4} (no request on file).',
  // To the shop's phone: a callback note.
  callbackNote: 'Call back {name} at {number} about {about} (callback note {ref}).',
  // Quote and confirm (DESIGN.md "Quote and confirm"): the shop quotes a request from its page, the customer replies
  // to book. Sent only to a request whose caller said yes to texts. {wheels} is "wheel" or "two wheels", {price}
  // "$180", {day} "Tuesday, Nov 10", {window} the window's own words (agent.yaml's label), {word} the reply word.
  quote: 'Example Wheel Works: your quote for the {wheels} on your {vehicle} is {price}. We can take it {day}, {window}. Reply {word} to book it.',
  // The word the customer replies to book (assumption: the owner corrects these). Not YES, which Twilio takes as an
  // opt-in keyword. Read by the decision model, not matched: "confirm", "yes confirm" or "sounds good, book it" count.
  confirmWord: 'CONFIRM',
  // To the customer, once their reply has booked the window.
  booked: 'You\'re booked with Example Wheel Works for {day}, {window}. Thanks, see you then.',
  // To the shop's phone: a reply to a quote that does not book it, the customer's words after a colon; the hold stays.
  quoteReply: 'Reply from {name}, ...{last4}',
  // To the shop's phone: a reply that booked the window ({window} the window's name, {booking} its reference).
  quoteBooked: 'Booked from quote {ref}: {name}, ...{last4}, {vehicle}, {day}, {window}, {price} ({booking}).',
  // Added to quoteBooked where the customer's booked text did not go ({status}: limited, failed, refused or printed).
  customerNotTexted: 'Customer not texted ({status}): call them.',
  // To the shop's phone: a quote's hold that lapsed with no yes (24 hours after the quote, or 6 pm the day before).
  quoteLapsed: 'Quote {ref} for {name}, ...{last4} lapsed with no reply: {day}, {window} is free again.',
  // To the shop's phone, the customer's words after a colon: a reply to a quote whose hold lapsed (never read, never
  // booked: the shop calls); and a yes the calendar refuses (a window with no room left under the hold).
  quoteLate: '{name}, ...{last4} replied to quote {ref} after it lapsed, so call them. They wrote',
  quoteFull: '{name}, ...{last4} replied to book quote {ref}, but {day}, {window} is full now, so call them. They wrote',
  // To the customer, only where the shop ticks "text them" as it withdraws a quote from its page (by default it does not).
  quoteWithdrawn: 'Example Wheel Works: we\'ve withdrawn your quote for the {wheels} on your {vehicle}. We\'ll be in touch.',
} as const;

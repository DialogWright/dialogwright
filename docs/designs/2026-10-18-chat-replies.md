# Answer buttons on a chat

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18); built on main.**

## The problem

A chat asks questions whose answers are a known set: yes or no at a read-back, one of three services, one of a day's open times, one of the caller's bookings. Typing "deep clean" or "the 10:30" works, but a person on a phone would rather tap. Hosted agents offer the answers as buttons. The step after formatting a line ([2026-10-18-chat-formatting.md](2026-10-18-chat-formatting.md)).

## The decision

app.yaml's `chat: { replies: on }` (default `off`) shows, under a chat's question with a known set of answers, each answer as a button:

- **Which questions.** A yes-or-no question (the core's own: a form's summary, a slot's read-back, the transfer offer, an intent to confirm, an offer of the caller's number): Yes and No, or the app's own words, prompts.yaml's `reply_yes` and `reply_no` (each a line with no variables, in every locale it speaks; in a language other than English without them, no buttons). A slot's own question: what its type offers (SlotSpec.replies): a `choice` slot's options, each its `button` or its `say` with a capital; a `record` slot's records, each as its `display` says it (else its key). Never an identity factor's question, and never a slot type that offers none (a date, digits, words).
- **How many.** Two to eight; a question with more shows none, and the person types.
- **What a tap does.** It sends the button's words as the person's message, read by the decision model as typed words are. The buttons are only offered words: the slot's question still reads them, the gate still decides, and a tap is recorded as the text it sent. So nothing new reaches the core, and the wire's client messages are unchanged.
- **The wire.** A chat `say` carries `replies` (the words, in order) on the line that asks, and only there; absent everywhere else, so a client that does not know it is unchanged and the wire stays version 1. A line worded by a model keeps its question's buttons.
- **The widget** shows them under the line (a group labelled with its `replies` word, "Answers"), only the latest question's; a tap shows the words as the person's line and sends them; a message typed or the chat's end takes them away. A page's own interface reads `replies` on the client's `say` event.

## Not now

Buttons that send something other than their words, buttons for a question the app asks in code with an answer set of its own, a keypad's options as buttons, and the intents at the greeting (a page can offer those itself, as starters).

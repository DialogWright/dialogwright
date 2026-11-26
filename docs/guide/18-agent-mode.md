# 18. Agent mode

[Contents](README.md) · Previous: [17. Tuning with live calls](17-tuning-with-live-calls.md)

In a scripted app (every chapter before this one) the decision model reads the caller through typed questions, and the app's YAML says every line. In agent mode a model holds the whole conversation, on a call and in a chat: it words each reply its own way, answers what the caller asks within the business's world, and takes what the caller gives in whatever order it comes. What is done stays fixed. The model acts only by calling the business's actions; each call's values are checked by type and put to the policy gate, every decision is audited, and an action that changes anything runs only after the line reads it back in the business's own words and the caller says yes. The model talks; the runtime decides what is done.

Agent mode is a runtime of its own (`packages/dialogwright/src/converse/`), not a layer on the scripted engine: it shares the carriers, the chat wire, the gate, the audit, the stores, the traces, the console and the texts, and never imports the scripted turn (a test holds that). The design, with every choice and the measurements behind them, is [designs/2026-11-11-agent-runtime.md](../designs/2026-11-11-agent-runtime.md), with [journeys](../designs/2026-11-12-journeys.md) and [the phone](../designs/2026-11-24-agent-runtime-plan-2.md). The example is [apps/wheelshop-agent](../../apps/wheelshop-agent/CLAUDE.md), Example Wheel Works, a fictional wheel repair shop whose line speaks as the business ("we", "the shop"); the snippets here are from it.

## 18.1 When to choose it, and when not

Choose agent mode where the line should talk like a person at the counter and the business knowingly accepts three things: a call costs more (a model answers every turn), it cannot choose every word the line says, and the line will sometimes be a little odd in ways a scripted one never is. In return callers talk naturally: they interrupt, wander, correct themselves and give things in any order, and the line never asks again what it was just told. A business is one file of its information and its actions, `agent.yaml`, with a little code for each action, and no intents, forms, slots, prompts or corpus to write.

Keep an app scripted where:

- **Every line must be the app's own words** (a regulated disclosure, a script a reviewer signs off line by line). In agent mode the model words every reply but the fixed lines (18.3) and the read-backs (18.5).
- **Callers prove who they are** (a date of birth, an account number, a one-time code). Agent mode has no identity levels yet: every action is open to a caller nobody has proven, and an account recognized by the number it calls from (18.8) is a fact of the call, never proof of who is speaking.
- **It needs what agent mode does not have yet:** a knowledge base or approved documents, more than one language (agent.yaml's lines are English, keyed by language so a second adds entries, not a new shape), a keypad menu (keys pressed on an agent call are logged and ignored), routes, or a scheduler other than Google Calendar.

Scripted mode is unchanged by any of this: an app whose app.yaml does not say `mode: agent` never meets it.

## 18.2 The folder

An agent app's folder holds:

- `app.yaml`, with `mode: agent` (default `scripted`) and the app's `id`, its chat settings (`chat`, below) and its look on the chat page (`brand`). `mode: converse`, the mode's name before it was renamed, is refused with the fix `write mode: agent`; there is no alias.
- `agent.yaml`, the business (18.3) and its actions (18.4), with its schema line, `# yaml-language-server: $schema=../../packages/dialogwright/schemas/agent.schema.json`. Its JSON Schema is generated from `converse/business/schema.ts`, where each key's description is the reference.
- `src/app.ts`, the code of each action, joined to the folder by `defineConverseApp` (`'dialogwright'`).
- `eval/`, the simulated callers (18.12).
- `POLICY.md`, `policy.matrix` and `APP-MAP.md`, generated from agent.yaml's actions (18.11).

```yaml
# app.yaml
id: wheelshop-agent
mode: agent
brand:
  name: Example Wheel Works
  mark: EW
chat:
  callerNumberFromContext: false
  page:
    serve: public
```

`chat.callerNumberFromContext`: a chat has no number it calls from. With `true`, a chat whose start's context names `callerNumber` (E.164) is taken as calling from it: the account it is recognized as (18.8) and the number a phone param's `caller` stands for. Off by default, so a page cannot claim an account; the simulated callers' own server turns it on for itself alone. `chat.page` serves the engine's chat page at `/<id>/chat`, as for a scripted app ([13.4](13-channels.md#134-web-chat)).

**What `pnpm check` refuses in an agent folder,** each with its fix: any scripted file beside agent.yaml (`intents.yaml`, `forms.yaml`, `prompts.yaml`, `policy.yaml`, `identity.yaml`, `routes.yaml`, `slots.yaml`, `style.yaml`), app.yaml's `personas`, a missing agent.yaml, and an agent.yaml in a folder whose app.yaml does not say `mode: agent`. An app folder of the old agent mode (a `business.yaml` and no `agent.yaml`) is refused whole by `pnpm check`, `pnpm diagnose` and the server, with the fix to rebuild it as an agent.yaml. `pnpm check` reads agent.yaml against its schema and its cross-checks (each below), and what the gate could not hold; the code is checked when the app is made: `defineConverseApp` refuses an action with no code and code for no action.

```ts
// src/app.ts (apps/wheelshop-agent, shortened)
export function shopTools(sys: Systems): Record<string, ConverseToolImpl> {
  return {
    check_availability: async (p) => sys.availability(p.day ?? ''),
    send_request: async (p, ctx) => { /* kept once for ctx.key, taking a place in the window */ },
    // ...
  };
}
const app = defineConverseApp(APP_DIR, {
  tools: shopTools(sys),
  onText: (m, ctx) => shopOnText(sys, m, ctx),
  pages: (deps) => shopPages(sys, { /* deps.base, deps.env, deps.texts, ... */ }),
  fresh: () => wheelshop({ ...o, inMemory: true }).app,
});
```

An action's code (`ConverseToolImpl`) gets the checked params, all strings, and `ctx`: `key`, the write's idempotency key, passed to every system it writes to ([14.13](14-running-it.md#1413-writes-that-are-never-done-twice)); `texts`, the app's sender, or null where the server has none ([13.17](13-channels.md#1317-texts-sending-and-receiving)); `caller`, the number calling whole and the account it is on; and `env(name)`, the app's own settings, read at call time ([settings](04-what-stays-in-typescript-and-why.md#settings-ctxenv-never-processenv)). What it returns goes back to the model as the action's result. It never decides whether it may run: the gate has already. `code.pages` and `onText` work as a scripted app's do ([13.6](13-channels.md#136-serving-the-widget-and-where-its-script-comes-from), [13.17](13-channels.md#1317-texts-sending-and-receiving)); a page made as the server starts is given the app, its settings and its sender (`ConversePageDeps`). `fresh`, where the code keeps state of its own (its systems, its calendar), makes the app again for each simulated call, so no call sees what another booked.

## 18.3 agent.yaml: the business

Everything about the business the line may use, in the business's own words. It is not the knowledge base, and the knowledge base's approvals do not apply to it.

**Who the business is.** `business`: `name`; `about`, what it does; `where` (optional); `hours`, its days and hours as the model may say them; `timezone`, an IANA name, what "today" means for its calendar (default UTC); `open` (optional), the hours as the line works them out, `weekly` (day names or ranges, `mon-fri`, to `HH:MM-HH:MM` ranges in 24-hour time) and `closed` (dates closed all day); and `line` (optional), the business's reason for the line, said on the second unclear turn in a row (18.7). With `open`, the model is told on every request whether the business is open now and until when, or when it next opens ("tomorrow (Saturday, November 14) at 7:30 am"), and `lines.greetingAfterHours` is said in place of the greeting when a call starts while it is closed (decided by the maintainer on 2026-11-13). A greeting after hours with no `open` is refused.

**What it does and says.** `services` (each a `name`, `about` and an optional `price`: `from`, `to` and `per`, a range); `priceCaveat` (required), said alongside any price ("That's a ballpark; the shop firms up the price once it sees the damage."); `notOffered`; `facts`, anything else the model may say, one each; `questions`, the questions callers ask with the business's answers (`q`, `a`). Where the business has not answered a question, the model has nothing to go on: the simulated callers' judge lists such answers as gaps for the owner to fill in here (18.12).

**How it sounds.** `persona`: `style`, how the model speaks, which shapes how it sounds and never what it claims; `opener` (optional), `acknowledge`: each reply begins with a brief acknowledgement that commits the business to nothing ("Got it."), varied, so the caller hears a first whole sentence almost at once (absent: none asked for); `voices`, the voice on each carrier: `telnyx`, a name with its engine, and `twilio`, a name alone (spoken by the deployment's `TTS_PROVIDER`, or Twilio's default provider where that is unset) or `{ voice, provider }` (Google, Amazon or ElevenLabs), whose provider wins over the deployment's ([14.12](14-running-it.md#1412-the-options)).

**The fixed lines.** `lines`, each said word for word, each `{ en: ... }` with an optional `chat: { en: ... }`, its wording in the web chat where the call's would not fit ("Thanks for messaging" for "Thanks for calling"):

| Line | Said |
|---|---|
| `greeting` (required) | when the call or chat starts, unless a journey that starts the call has its own (18.7), or the business is closed (`greetingAfterHours`) |
| `greetingAfterHours` | in place of the greeting when a call starts while `business.open` says the business is closed; needs `open` |
| `closing` (required) | when the model ends the call with no goodbye of its own (18.6) |
| `recovery` (required) | when the model failed a turn ("Sorry, could you say that again?") |
| `handoff` (required) | when the model has failed past the call's budget (`limits.failuresPerCall`), before the call goes to a person: a transfer where agent.yaml names `transfer.number`, else the call ends |
| `done` | in place of the recovery line where an action the caller confirmed has just run and the reply after it failed, so the caller still hears it was done (default "That's done.") |
| `stuck` | where the model is still calling actions after a turn's last round (default "Let me have someone follow up on that.") |
| `bridge` | on a call, when the model is slow to begin (18.9; default "One sec.") |
| `unclear` | on the third turn in a row the line could not follow, before the call ends (18.7); required with journeys |
| `notConfirmed` | optional: said when the caller turns a read-back down without saying what should be different, and the model answers what they say next (18.5); absent, every answer not confirmed goes back to the model |

**The model.** `model`: `default` (required), `<provider>:<model>` (18.13); `timeoutMs`, how long a reply may take before the turn falls back (default 6000); `maxTokens`, the most a reply may use, reasoning included (default 400; a reply cut off at it is a failed turn, never said as it was cut); `effort`, `minimal`, `low`, `medium` or `high`, sent in each provider's own form (default the provider's own).

**Limits and checks.** `limits`: `failuresPerCall`, failed turns in a call before it is handed off (default 4); `refusalsPerAction`, refusals of one action before the model is told to offer a person rather than try again (default 3; 18.4, 18.9). `checks.claims`, the check after speaking (18.6), off by default. `readBacks.holdAfterCut`: on a call, a read-back the caller spoke over before hearing it is said again held (18.5), default true.

**Sources.** `sources.calendar` (18.10) and `sources.accounts` (18.8). `transfer.number`: where a handoff goes, E.164 or `env.<NAME>`; absent, a handoff ends the call with its line.

A number in agent.yaml may name a setting instead, `env.<NAME>`, for a number that must stay out of the folder (a tester's own phone recognized as an account, `env.DEALER_TEST_LINE`). The server reads it from the app's own settings as it starts; an account number whose setting is unset is left out.

## 18.4 Actions and the gate

`actions`: every action the model may call, by name. `end_call` is the runtime's own (18.6) and no action may take its name.

- `about`: what it does and when to use it, for the model.
- `kind`: `lookup` (reads, and its result goes back to the model) or `change` (does something, so it is read back and confirmed first).
- `params`, by name, each with `type` and `about` (for the model), and `optional: true` where the model may leave it out. The runtime checks each value by its type before the gate sees it (`converse/actions.ts`):
  - `date`: a real day, `YYYY-MM-DD`;
  - `slot`: one of the results the lookup named by `from` returned on this call, so a window, or an account, is never one the model made up;
  - `choice`: one of its `options`;
  - `number`;
  - `text`: one line of at most 120 characters, or its own `max` (the read-back says it as given);
  - `phone`: a number, written with its country code or as a North American number of ten digits, or the word `caller`, which stands for the number calling and nothing else (the model is sent only its last four; the runtime puts the whole number in).

  A value that fails its check goes back to the model as the action's result, with a reason it can act on.
- `readBack` (required on a change, refused on a lookup): the business's words, each param as `{name}`, an optional one in a part in square brackets said only when it has a value (`[ We'll also pass on: {notes}.]`). `pnpm check` holds it to saying every param: the yes never confirms a value the caller did not hear.
- `readBackChange` (a change only, optional): the short read-back of a correction, a frame with `{changes}` and a phrase per param (18.5).
- `readBackBrief` (a change only, optional): a compact read-back, said where a read-back is said again held on a call (18.5). Its placeholders follow `readBack`'s rules, and it says every param `readBack` says (an optional one in square brackets, as there): `pnpm check` refuses one that leaves a value out, since the yes to it confirms them all.
- `then` (a change only): follow-ons, run after the caller's yes with no read-back of their own, each through the gate with its own hash and an audit row naming the yes. A follow-on takes only params of its parent's, of the same type (a text's `max` no shorter), and runs with the values the caller confirmed. It is never offered to the model.
- `rules`: the gate's rules for the action, in policy.yaml's shape ([3](03-policy-and-identity.md)), run in the order written: the built-in rules (`oneOf`, `noneOf`, `dateInRange`, `limit`, `callerNumber`, `fields`). Every change gets a `confirmed` rule over all its params, run last, so agent.yaml lists none; and a rule of the app's own (`defineRule`) has no code to run in an agent app, so `pnpm check` refuses both.
- `audit`: how each param is recorded in the trace and the audit, `last4`, `mask`, `length`, `secret` or `keep`; a param it does not name is masked.

```yaml
# agent.yaml (from apps/wheelshop-agent, shortened)
sources:
  calendar: { kind: fake, days: [monday, tuesday, wednesday, thursday, friday], windows: [{ name: morning, label: "morning window, dropped off by 8 AM", capacity: 3, until: "08:00" }] }
actions:
  check_availability:
    about: The drop-off windows on a day. The only source of what is free.
    kind: lookup
    params:
      day: { type: date, about: The day the car would be dropped off. }
    audit: { day: keep }
  send_request:
    about: Send the shop a customer's repair request with the drop-off window they picked.
    kind: change
    params:
      name: { type: text, about: "The customer's name, as they gave it." }
      slot: { type: slot, from: check_availability, about: The drop-off window they picked. }
      callbackNumber: { type: phone, about: The best number to reach them on. }
      textOk: { type: choice, options: ["yes", "no"], about: Whether they agreed to be texted at that number. }
    readBack:
      en: "So that's a request for {name}. You've picked {slot}, we'll reach you on {callbackNumber}, and you said {textOk} to texts there. Did I get that right?"
    then: [send_photo_request]
    audit: { name: mask, slot: keep, callbackNumber: last4, textOk: keep }
  send_photo_request:
    about: Follows send_request on the customer's yes, only with their yes to texts too.
    kind: change
    params:
      callbackNumber: { type: phone, about: The customer's number. }
      textOk: { type: choice, options: ["yes", "no"], about: Whether they agreed to be texted there. }
    readBack:
      en: "We'll text {callbackNumber} asking for a photo of the damage. Is that right?"
    rules:
      - oneOf: { field: textOk, values: ["yes"], reason: no-consent }
    audit: { callbackNumber: last4, textOk: keep }
```

**What a call goes through.** The model calls an action with its arguments. The runtime checks them by type; then the gate decides, with the business's rules, and the decision, allowed or refused, goes to the audit. A refusal goes back to the model with the rule that failed, scrubbed of any value the records hide; past `limits.refusalsPerAction` refusals of the same action on the call, the model is told to offer a person rather than try again. A lookup allowed runs, and its result goes back to the model. A change allowed is read back (18.5). Every action runs at level 0, as a caller nobody has proven: agent.yaml has no identity yet. Which actions a turn offers is the journey's (18.7); a call to one it did not offer is refused before the gate (`not-offered`, audited as `converse_refused`) and counts toward no refusal.

A text to a caller is an action like any other, so consent is a rule on it, never a check in its code: the wheel shop's `send_photo_request` runs only where `textOk` is yes (`oneOf`, `no-consent`).

## 18.5 The read-back

When the model calls a change, the line says its `readBack`, filled with exactly the call's values as each type says it: a date as its day ("Friday, November 13"), a slot by its label among the lookup's results, a number the caller gave whole and in groups ("555 555 0142"), the number calling as "the number you're calling from, ending in 0142". The turn ends there; the model does not read anything back itself, and its words cannot change the read-back's.

- **The caller's answer** is read by the decision model, a yes and a no: a yes at 0.7 or more with a no under 0.3 (`CONFIRM_YES_AT`, `CONFIRM_NO_BELOW`) confirms. The change then runs through the gate with the confirmation's hash of exactly those values, then its follow-ons, and the model is told what each returned.
- **Anything else** (a no, a correction, a question, an answer the decision model could not read) runs nothing, and goes back to the model with what the caller said, or that the answer could not be read. The model handles a correction in the conversation and calls the action again with the new values, which brings a fresh read-back, in the same turn: a turn that answers a read-back keeps the journey's actions and is never unclear (18.7). The runtime runs no correction flow of its own, and a yes to a question of the model's own ("Shall I book that?") confirms nothing.
- **A correction, read back short.** Where the change gives `readBackChange`, a correction is read back by its changed values alone. Once the caller has heard a full read-back and not confirmed it, and the model calls the same change again with values changed, the line says the short read-back's frame with `{changes}` the phrase of each changed param, in the action's param order, each value shown as the full read-back shows it, joined by commas and the last two by `and` where it is given. The caller heard every other value in the full read-back, so their yes to the short one confirms the whole change, its hash over all its params as ever. The model is told, in the action's description, that the corrected value is said back for it. The full read-back is said instead where the values are the same as the one heard (the caller asked to hear it all), where a param with no phrase changed, or where a value was cleared. The read-back a correction is compared with is the last one the caller heard and did not confirm (a short one among them, so a second correction is read against the first's values); one they spoke before or over does not replace it. It is let go on a yes, a withdrawal, or the journey moving off its action. The trace's `readBack` names the params changed (`changes`), and so does the audit's `confirmed` row (`short: true`). The policy card lists the frame and each phrase beside the full read-back. Decided by the maintainer on 2026-11-25, after a live call whose caller sat through the whole read-back again after each correction.

  ```yaml
  # agent.yaml (from apps/wheelshop-agent, shortened): "Got it, your 2022 Toyota Tacoma. Is everything else right?"
  send_request:
    readBackChange:
      en:
        say: "Got it, {changes}. Is everything else right?"   # the frame: {changes} once, no other placeholder
        and: "and"                                            # optional: the word before the last phrase
        params:                                               # each phrase holds its own param once, and no other
          vehicle: "your {vehicle}"
          slot: "{slot}"
          callbackNumber: "we'll reach you on {callbackNumber}"
  ```
- **Said again held.** On a call, where the caller spoke over a read-back before hearing it (cut in before 85% of it, or spoke as it began, 18.9) and the model calls the same change again with the same values, the line says the read-back again held: whole, sent not interruptible, and any speech that began before it finished playing is ignored, not held, so words that arrive behind it are never acted on stale. Each utterance ignored is in the frame log (`ignoredOverHeld`, its length) and in the next turn's trace record (`ignored`, the lengths, never the words), and the console's call view shows it. The no-input wait does not apply: an agent app has none. When speech began is the first sign of it the carrier gave (a partial prompt on Twilio, the caller heard speaking on Telnyx), else the final words' arrival less their estimated length; the held line has played when Telnyx reports it, or on Twilio once 85% of its estimate has passed (an estimate a little long would otherwise ignore a caller who waited for the end of a faster voice). Where the action gives `readBackBrief`, the brief read-back is said in its place; its hash, the check that it was heard and the decision model's reading of the yes are on the words said, as on any read-back. Once per change: a held read-back not confirmed (a no, an answer the decision model could not read) is followed by the usual one, which can be talked over; one heard and turned down with a correction is the read-back a short read-back of the change is compared with. It is let go on a yes, a withdrawal, or the journey moving off its action. A correction cutting in (the change called again with other values) is read back as usual. The model is told, in the change's description, that a read-back spoken over is said again whole and cannot be talked over, so it writes nothing before calling the change again; nothing tells the caller to listen to it all. The trace's `readBack` and the audit's `confirmed` row say `held: true` (and `brief: true`). `readBacks.holdAfterCut: false` restores the read-back that can always be talked over; a chat is unchanged. Decided by the maintainer on 2026-11-26, after simulated callers who talk over every long reply never got a change confirmed.

  ```yaml
  # agent.yaml (from apps/wheelshop-agent, shortened)
  readBacks: { holdAfterCut: true }   # the default
  actions:
    send_request:
      readBackBrief:
        en: "That's {name}, your {vehicle}, {damage} on {wheels} of its wheels, the finish {finish}, {slot}, on {callbackNumber}, and {textOk} to texts.[ And the note: {notes}.] Is that right?"
  ```
- **A bare no.** In the same request the decision model is also asked whether the caller says what should be different (a change, a correction or a new detail), and whether they withdraw it (they want none of it: "cancel it", "never mind"). A clear withdrawal (0.7 or more, `WITHDRAWN_AT`) goes to the model as withdrawn, with no line and nothing kept unsent (below). Where the app has `lines.notConfirmed`, a clear no (0.7 or more, `DECLINED_AT`, with no yes) that says nothing of what should be different (under 0.3, `CHANGE_BELOW`) is answered by that line, word for word, and the model is not asked on that turn: it is told the line asked what to change or whether to cancel, and answers what the caller says next. A correction, a no less clear, or an app with no such line goes to the model as above.
- **Never left unsent.** The change whose read-back the caller last did not confirm (turned down, spoken over, or not read) is kept on the call. While it is, the model's first `end_call` is refused (`converse_refused`, `unsent-change`, counting toward no refusal) and the call goes on. Replies stream as always, so a goodbye written with it has been said; the model is told so, that the change was never done, and to ask whether the caller still wants it (as a person would: "before you go, did you still want me to send that?"), unless they have said they do not. Any later `end_call` in that turn is refused too (`unsent-asked`): one ask per refusal, and the caller's next turn decides, where the next `end_call` ends the call. A yes to a read-back of that action lets it go, and so does the caller withdrawing it: while it is kept, each caller turn asks the decision model whether they no longer want it (in the routing request where the app has journeys, else its own, within the decision model's time; late or failed, nothing changes), and a clear yes (`WITHDRAWN_AT`) lets it go. So does the journey moving off the one that offers its action (a drop, a switch, or the journey done). The trace's `unsent` says when it was read and why it was let go.
- **One at a time.** An action called while a read-back waits for its answer is not run (`converse_refused`, `one-confirmation-at-a-time`): the model is told to call it again after the answer, and it counts toward no refusal.
- **Heard.** On a call, a yes confirms only a read-back the caller heard nearly to its end (18.9).

The line keeps its own record of what was done on the call: each change that ran, with its read-back as the caller confirmed it, what it and its follow-ons returned and the values it carried, and a read-back still waiting for a yes. It goes with every request to the model, so the model never has to work out from the conversation what has been done.

## 18.6 A turn

The model is sent a system prompt and the conversation so far, and may call the actions the turn offers and `end_call`.

**The system prompt** gives the goal and the context, never a procedure for the words (`converse/prompt.ts`): that it is the business's automated assistant, on its phone line (where everything it writes is spoken aloud) or its web chat; the persona's style; how to ask (one thing at a time, or two that go together, taking whatever the caller gives in any order and never asking again for what they said); to speak as the business would, never of how the line works (its actions, read-backs, checks or tools), acknowledging each answer once, and saying back a value easily misheard (a name, a number, a product) as it understood it, so a mishearing is caught at once; the business information; five rules; honesty; the date and time in the business's zone, and whether it is open now; what is known of the caller; and the line's record of the call (18.5). On a call it adds: plain spoken sentences with no lists, symbols or line breaks, a range in words; every reply handing the turn back (a question, or what happens next and whether there is anything else), since a caller cannot hear that a reply has ended; and that the call is over when the caller says they need nothing more, however they say it ("that's all", "I'm all set", a bare "no" after "anything else?"), with `end_call` in that same reply.

**The five rules**, for every business:

1. Claim nothing the business information or a lookup on this call does not support: prices, services, hours and policies only from the information, any price with the caveat; times and availability only from a lookup on this call; and no time for a callback (tying it to when the business opens included) unless the information gives one.
2. Nothing changes without the caller's yes to the line's read-back.
3. Nothing is said to be booked, sent or done unless an action's result on this call says so.
4. Whatever the caller is told is noted or passed on must be carried by the params of an action they confirm.
5. What the caller says about themselves is said back as they gave it, nothing added.

**Honesty.** Asked whether it is a person, the model says it is an automated assistant for the business, and that a person at the business can take the call over (where agent.yaml names `transfer.number`) or call them back. A business cannot turn this off.

**The reply is streamed,** a whole sentence at a time, to the carrier as text and to the chat as `say_delta` (to a client that asked for it) and one `say` ([13.4](13-channels.md#134-web-chat)). No check holds a reply before it is said (the maintainer's decision, 2026-11-11): unsupported claims are kept out by the prompt and the tools (a slot only from a lookup on this call) and measured by the simulated callers (18.12). Values reach the runtime only as an action's arguments.

**Rounds.** A lookup's result goes back to the model, which may call another action or reply, up to four rounds a turn (`MAX_ROUNDS`). A model still calling actions after the last fails the turn with the stuck line.

**Failures.** A model that errs or says nothing is asked once more while half its `timeoutMs` is left, and one that has not begun within half its time is stopped and asked once more; a request refused for the provider's rate limit (an HTTP 429) is asked again after a wait, up to twice more, while half the time is left. Otherwise the line says the recovery line (the done line, where a change the caller confirmed has just run) and the call goes on; once `limits.failuresPerCall` failed turns are spent, the handoff line, and the call is handed off: transferred where agent.yaml names `transfer.number`, else ended. A turn that throws on either channel still says the done line, where a change the caller confirmed ran, or else, on a call, the recovery line.

**The call's end.** The model ends the call with the runtime's own `end_call`. Its own goodbye written with it is said; where it wrote none, the closing line is. A goodbye with no `end_call` does not end the call. The first `end_call` after a read-back the caller did not confirm is refused, so the model asks whether they still want the change (18.5).

**What the model is sent** (the maintainer's two decisions of 2026-11-08, carried forward on 2026-11-11 as agent mode's own named exceptions): the conversation (the caller's words, its own replies, the fixed lines said, each read-back as said) and every action's result as the action returned it, unchecked, since an action's reply has no closed-form check. So an action returns only what the model may see. The caller's number goes to the model by its last four only; the whole number only to the actions' code. A refusal's reason is scrubbed to the values' recorded forms before the model is told it. There are no identity factors to keep out. The caller's words are rewritten wherever they would pass for the line's own note (below). The policy card says all of this, so a reviewer sees what the model sees.

**The check after speaking** (agent.yaml `checks.claims`, [the design](../designs/2026-11-11-claims-check.md)): with `mode: correct`, the decision model reads each reply once it is said against the business information, the business's day and the call's actions and their results; a reply read as contradicted, or as saying something was done that was not, at `correctAt` (0.7) or more goes back to the model with a note marked as the line's own, and its correction is said after the reply (on a call, once the reply has played, unless the caller began to speak). `record` reads and records only. It is `off` by default since 2026-11-12: measured on labelled replies, it did not tell the wrong ones from the right.

## 18.7 Journeys

A line that does more than one thing may give each its own journey (agent.yaml's `root`, `journeys` and `routing`, [the design](../designs/2026-11-12-journeys.md)): one task each, with its own goal, instructions, information and actions. Without them the model is sent everything and offered every action, as one conversation.

The top level of agent.yaml is the base every journey sees. `root` is the line when no journey is active: its `instructions` (the business's guidance, never a script) and `actions`, lookups only (default none). Each journey, by id:

- `when` (required): what the caller wants, in plain words; the decision model reads it, and the root model is told it as what the line can help with. It says what the caller wants, never who they are.
- `goal` (required): what the journey achieves, in one sentence.
- `instructions`: what to collect, what to check first, what not to mention: goals and limits, never wording.
- `facts`, `questions`: added to the base's, for this journey only.
- `actions`: the actions it may use, each defined once under `actions` and named by any journey. A follow-on may not be named; a change no journey names is refused.
- `for: { account: recognised | none }`: which callers it is open to, by a fact of the call (18.8). A journey closed to the caller is never one of the decision model's options.
- `start: { account: recognised }`: the journey the call starts in, before the caller speaks; one journey at most. `greeting`, said in place of `lines.greeting` where it starts the call.
- `completes`: the changes whose confirmed run ends it (default every change it names that is not a follow-on). A journey that ends done moves to its after phase: its information stays as the turn's context, with `after` in place of its goal (default "<goal>: done on this call. Answer the caller's questions about it."), its lookups offered and none of its changes.

**Routing.** Each caller turn (but the yes to a read-back the caller confirmed) is read by the decision model before the agent model's reply is said: which journey the caller wants now (`task`: each open journey's `when`, a question about the business, or none of these), whether they have dropped the active one (`drops`), whether a journey already done is wanted again (`again`), and in a working journey whether the turn fits it (`fits`). Code decides from the readings: start a journey from the root at `routing.startAt` or above (default 0.7, measured on labelled turns), switch to another at `switchAt` (default 0.6), go back to one set aside (at most one is), carry on, or go to the root. Routing has `routing.timeoutMs` (default 400 ms); a decision model that errs or is late leaves the journey as it was, so routing never fails a turn. The model's first round is asked alongside the routing with the journey as it stands, its sentences held until the route is known; where the route changes the journey, that round is dropped unsaid and asked again. Inside a journey the model is also told the other journeys open to the caller, so it can say so and ask before switching.

**A turn the line cannot follow** (none of these at the root, or a turn that fits nothing in a task and is no switch and no question) is unclear, and never guessed at. The model is told so, with the goal of guiding the caller to what the line needs at that point; on the second in a row, to help them kindly, as a person who wants to help would, with what the line can do (and `business.line` where it has one) and exactly what to say, never blaming them. On an unclear turn only lookups are offered, so confusing input is never acted on. A turn that answers a read-back is never unclear, whatever its words (a live call's "Excuse me." at a read-back's end): the caller is following the line, so the journey's actions stay offered and the count of unclear turns starts again. So too at the root, where the line has said something: the decision model is also asked whether the turn answers what the line last asked (`answers`), and one it reads so (0.5 or above) is not unclear, though none is the top reading (2026-11-25, after live callers describing the damage they had just been asked about were read as unclear). On the third in a row the line says `lines.unclear` and ends the call. Decided by the maintainer on 2026-11-13.

## 18.8 Recognition by caller ID

`sources.accounts`: the business's regular accounts, each a `name` and the `numbers` it calls from (E.164, or `env.<NAME>`). The number calling is matched at the call's start; a match recognizes the account, which the model is told, with the words that a number on file recognizes an account and does not prove who is speaking. Caller ID stays an identifier, never an identity factor. A journey's `for` and `start` read it, and an action held to the account takes it as a `slot` from a lookup that returns it (the wheel shop's `recognise_caller`, so `book_dealer`'s account is one the number is on, checked by the runtime before anything is read back).

A chat carries no number, so on a chat no account is recognized, unless app.yaml's `chat.callerNumberFromContext` takes one from the page (18.2). Caller ID can be forged: a caller who forges an account's number could act as that account, still only after confirming a read-back. The risk is the business's to accept, and the policy card states what each action allows; a business that cannot accept it leaves out the accounts and the actions held to them.

## 18.9 On the phone

An agent app takes calls on Twilio and Telnyx as it takes chats, on the same numbers a host gives it ([14.15](14-running-it.md#1415-several-apps-on-one-server-hostyaml)); `server/voice/converseRuntime.ts` mirrors the chat's runtime. On a call:

- **Speakable words.** Every line is made speakable before it is said (`converse/speakable.ts`), the model's and the line's own alike: a range of numbers in words ("$125 to $175"), a screen's list or headings said as one run of speech, the caller's last four digit by digit. The text sent, kept and compared with what the carrier says it played is the same. A chat is sent the words as written.
- **Interruption.** Each sentence goes to the carrier as it is written, and the call is always interruptible by speech (but a read-back said again held, 18.5), whatever `BARGE_IN` says; on Telnyx the playback events are on, whatever `TELNYX_EVENTS` says ([14.12](14-running-it.md#1412-the-options)). When the caller speaks, the turn running is stopped (no failure) and their words are the next turn, sent with what they heard of the last reply, to which the conversation is rewritten (`[The caller cut in here.]`).
- **A read-back heard.** A yes confirms a read-back only where the caller heard at least 85% of its characters, or it played to its end (`READ_BACK_HEARD_AT`), and never one they began speaking before. A read-back not heard (never said, spoken over, or answered by a caller who went on speaking) confirms nothing and counts as a refusal of its action, so `limits.refusalsPerAction` brings the offer of a person as the gate's refusals do.
- **The bridge.** Where a caller turn's reply has said nothing by `BRIDGE_AFTER_MS` (the server's setting, default 2500, the maintainer's decision of 2026-11-25; [14.12](14-running-it.md#1412-the-options)), the line says `lines.bridge` once, whole and not interruptible, kept out of the conversation the model is sent. Speech over it is the caller's next turn.
- **Keys** pressed are logged and otherwise ignored.
- **Restarts.** A call is saved after every turn, and before a caller's turn with its words: a server that resumes it asks the model again on them, and a change the caller confirmed is not done twice (its idempotency key). A reply still streaming is not resumed. A chat is saved the same way (schema `converse-1`).

## 18.10 The calendar

`sources.calendar`: where availability comes from. Its `days` (`monday` to `sunday`) and `windows` (each a `name`, the `label` said to a caller, a `capacity` and an optional `until`, the last drop-off time in the business's zone, after which today's window is not offered) are the business's, for either kind:

- `kind: fake`: the windows, with the bookings in memory, for a demo and tests.
- `kind: google`: Google Calendar through a service account. The bookings are events in the calendar `calendarId` names (its id, or `env.<NAME>`), each event's id from the write's idempotency key, so a write repeated is never a second event; any other event shown as busy takes a place in each window it overlaps. The service account's key file is the app's setting `GOOGLE_CALENDAR_KEY_FILE`, never in the folder ([14.12](14-running-it.md#1412-the-options) has the setup and the time limits).

The code makes the calendar with `businessCalendar(business, now, { env })` (`'dialogwright'`) and keeps it; an app whose code keeps a calendar of its own never asks Google, whatever agent.yaml says (the wheel shop's stand-in calendar, `src/shop.ts`, is one). No test calls Google: tests use a fake (`testing/fakeGoogleCalendar.ts`).

## 18.11 Records and the console

- **The audit**, the app's hash-chained log as for any app: each gate decision, each action's call and result, each confirmation (the yes tied to the hash of exactly the values read back), each action not run (`converse_refused`: not offered, or one confirmation at a time) and each call's end (`call_ended`). Each param is recorded as its action's `audit` says.
- **The trace**, one record per turn (`kind: converse`): what the caller said, what the line said, each action with its params as recorded and its outcome, the read-back and the decision model's reading of the answer, the model's requests with their times, tokens and cost, the route among the journeys, the check after speaking's readings, and whether the business was open.
- **The console** lists an agent call with every other ([14.9](14-running-it.md#149-looking-at-calls-from-your-phone)), and its call view shows each turn: what the caller said, the line, each action with its params and outcome, the read-back and how its answer was read, the journey it was in (and where it started, switched or dropped), and the model's time, tokens and cost; on a call, what the caller heard of the line before, the bridge, and a turn the caller stopped by speaking.
- **The policy pages.** `pnpm policy:matrix`, `pnpm policy:card` and `pnpm app:diagram` write `policy.matrix`, `POLICY.md` and `APP-MAP.md` from agent.yaml's actions: what the gate decides for each action, each rule and read-back in plain English, which journeys offer each action, what the model is sent, and the root, journeys, actions and follow-ons as diagrams. After a change to an action, its rules or its read-back, write them, read each diff as a change in what the line may do, and commit them with the change ([3.10](03-policy-and-identity.md#310-testing-the-policy)); the app's own test fails when one is stale (the wheel shop's `src/policyPages.test.ts`), and CODEOWNERS makes agent.yaml need compliance's review.

**What the line took in, for the owner.** The console is a call at a time; an owner wants the records. The wheel shop serves its own page for that, `/wheelshop-agent/shop` (`src/shopPage.ts`, `auth: 'console'`, never public): the requests and bookings with the numbers to call back, where the shop quotes a request and the customer's reply books it.

## 18.12 Testing, and the simulated callers

No test calls a model, a carrier, a calendar or a text provider, and neither does CI.

- **The app's own tests** run conversations turn by turn on the app's agent.yaml, code and gate with `converseTestCall` (`'dialogwright/testing'`): the model a script (`fakeConverseModel`: its text and its action calls, round by round), a decision model of the test's own that reads each read-back's answer and routes each turn, and a caller's number, a clock, the app's settings and a fake text sender where the test gives them. They hold what ran, what the audit kept and what was said; the wheel shop's are `src/app.test.ts`.
- **The simulated callers** are how the line is measured (`pnpm eval`, the author's step with the author's own keys; it refuses in CI). A model plays each persona of a personas file (`schemas/personas.schema.json`: a `goal`, the `truth` of what they will say, a `manner`, what the call should come to, `expects`, and optionally what an adversarial caller tries, `adversarial`, whether they ask if the line is a person, `asksIfHuman`, the number they call from, `callingFrom`, and how they behave on a call, `voice.interrupts` and `voice.fragments`) against the app's own server, over the chat wire or, with `--channel voice`, over the voice path with the carrier played in text and replies at speaking pace. A judge reads each call against the business information and the audited actions, listing each material claim (a price, a time, a policy that commits the business, something said to be done) as contradicted or a gap; contradicted claims count against the bar, and gaps are listed for the owner to answer in `questions`. With `--judge none` no judge model runs: each call's judge input is stored for judging by hand, and `pnpm eval:rejudge --verdicts` reads the verdicts. Hostile callers (an injection attempt, a discount pushed for, a caller who asks whether the line is a person) are personas like any other: the scripted mode's adversarial suite ([15](15-the-adversarial-suite.md)) does not run for an agent app.
- **Routing and the check after speaking** are measured on turns a person labelled: `pnpm converse:route-eval` and `pnpm converse:claims-eval` ([the docs index](../README.md) lists their options), each recording the decision model into a cassette beside the labels and replaying it with `--replay`, no key.

A shortfall the simulated callers find is a finding: fix agent.yaml's wording or the runtime, never the persona.

```sh
pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml --runs 3 --budget 3
pnpm eval apps/wheelshop-agent --personas apps/wheelshop-agent/eval/voice-personas.yaml --runs 3 --budget 3 --channel voice
```

## 18.13 Choosing the model

`model.default` names the provider and the model: `anthropic:<model>` (the Anthropic API, `ANTHROPIC_API_KEY`; a Claude model goes through it only, and `pnpm check` refuses one named through OpenRouter), `inception:<model>` (`INCEPTION_API_KEY`), `meta:<model>` (Meta's API, `META_API_KEY`: its Muse models in Standard mode, which does not train on what it is sent) or `openrouter:<vendor>/<model>` (`OPENROUTER_API_KEY`; always asked for hosts that collect no data, and pinned to hosts with `@<host>`, `openrouter:openai/gpt-oss-120b@groq`). The key is read from the app's settings, never the file; the server will not start an agent app whose model's key is unset, naming the variable. Use only a model tier a real client could use: never one whose terms let the provider train on the conversations.

The model is chosen by measurement, with `pnpm eval:compare`: candidates run on the same simulated callers, cheapest first, each held to the maintainer's bars (2026-11-11): the first sentence at a median of 1.2 s or less and a p95 of 2.5 s or less, timeouts on 1% of turns or fewer, 95% of the cooperative calls done correctly, and no contradicted material claim; once one clears every bar, the dearer ones are not run. The wheel shop's is Muse Ember 1.0 at `effort: minimal` ([the comparison](../designs/eval/2026-11-model-comparison.md)).

```sh
pnpm eval:compare apps/wheelshop-agent --personas apps/wheelshop-agent/eval/personas.yaml --candidates inception:mercury-3#minimal,meta:muse-ember-1.0#minimal --runs 5 --budget 10
```

## 18.14 The demo's assumptions, and correcting them

The wheel shop is a working demo for a real shop's owner to hear, so it needs answers only the owner can give. As with a real client, `agent.yaml` makes a reasonable assumption for each and marks it `# assumption: the owner corrects these`: the ballpark prices and their caveat, the days, hours and drop-off windows, the turnaround, what the shop does not do, the answers to the questions callers ask, the greetings and the unclear line, and how dealership accounts are booked. [Its DESIGN.md](../../apps/wheelshop-agent/DESIGN.md) lists each with how the owner corrects it.

The demo is up front that these are assumptions: when the owner hears something that is not how the shop works, that is the prompt to say how it does, or to leave it out. Each is an entry in agent.yaml, so a correction is an edit to the file, never to code. A real business's line is a private copy of such a folder, with its own information, accounts and numbers.

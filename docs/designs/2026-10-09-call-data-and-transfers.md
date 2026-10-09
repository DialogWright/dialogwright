# Call data and transfers: the build (flow building blocks, piece 2)

Date: 2026-10-09. Status: **2a built** (its decisions made building it are under [As built (2a)](#as-built-2a), after its task list); **2b being built.** Source: [2026-10-08-flow-building-blocks.md](2026-10-08-flow-building-blocks.md), sections 1 and 2, and the maintainer's decisions at its end (targets chosen by `callData`, form and reason; Twilio and Telnyx together, one shared shape). Built as two items: 2a, `callData`; 2b, transfer targets and the data sent with a transfer. Piece 3 (`routes.yaml`) reuses the condition 2b introduces.

## 2a. Call data in: `callData`

```text
# app.yaml
callData:
  accountRef: { from: param.accountRef, redact: last4 }   # a custom parameter of the setup (Twilio <Parameter>, Telnyx custom parameter)
  queue:      { from: param.queue, redact: keep }
  forwardedFrom: { from: setup.forwardedFrom }             # a field of the setup frame
  uui:        { from: webhook.SipHeader_User-to-User }     # a field of the carrier's answer webhook, carried through the start document
  page:       { from: chat.page, redact: keep }            # web chat: the start message's context
```

Decisions:

1. **Only named keys are kept.** Sources, carrier-neutral by design so the engine names no carrier's fields:
   - `param.<name>`: a custom parameter of the relay's setup frame (`customParameters`).
   - `setup.<field>`: a field of the setup frame the wire keeps (`SETUP_EXTRAS`: forwardedFrom, callerName, callType, direction, the call ids).
   - `webhook.<field>`: a field of the carrier's answer webhook (Twilio's `ForwardedFrom`, `CallerName`, `SipHeader_<name>`; whatever the carrier posts). The server copies each named one into the start document as a `<Parameter>` (name `dw_<key>`), so it arrives in the setup frame; nothing is held between the webhook and the socket.
   - `chat.<key>`: a key of a new optional `context` object on the chat `start` message (strings only, the same limits as custom parameters). The widget takes it from a `data-context` attribute or `DialogWright.mount({ context })`. The chat wire stays version 1: the field is optional, and a client that sends none is unchanged.
   A key whose source is absent on a call is absent, never an empty string.
2. **Kept on the session**, as an optional `callData` field read with `callDataOf(s)` (from `'dialogwright'`), an empty object for an app without `callData`. Optional with a default, so `SESSION_SCHEMA` stays. A reconnect keeps the first setup's values, as it does the caller's number.
3. **Redaction per key**: `redact` takes the slots' values (`last4`, `mask`, `length`, `secret`, `keep`); the default is `mask`, so a key nobody thought about is never written whole. It applies in the trace, the console, the frame log and the audit. The frame log's nested `customParameters`, written as sent today, are redacted too: every custom parameter but `locale` is masked unless a `callData` key keeps it. Replay rebuilds a masked value from a stand-in, as it does the caller's number.
4. **The model never sees call data** unless the app's `callerState` passes it.
5. **App-chosen parameters out**: app.yaml `startParameters: { name: env.NAME }` writes fixed `<Parameter>` tags into the start document, for a call placed from the app's own systems through the carrier; values come from the environment, never YAML.
6. **`pnpm check`** refuses a key with no `from`, an unknown source prefix, a `setup.` field the wire does not keep, and a key or parameter name that is not an identifier.
7. **Conformance**: the kit checks that a custom parameter and a named webhook field reach the session for each carrier (Telnyx's webhook field names marked `ASSUMED` until a live check, as its others are); live-checks.md gets the step.

Tasks: schema and `App.callData`; wire and adapter (`withCallData` beside `withCallerNumber`, the start document's echoed parameters); the core keeps it; `callDataOf`; chat `context` and the widget; redaction in each record and replay; check; conformance fixtures; docs (guide section 13, app.yaml reference, the skill's options).

### As built (2a)

Where the build had to choose, it chose what keeps an app without `callData` as it was, and refuses only what is broken. Every app sees two deliberate changes, both to how custom parameters no key reads are recorded: in the frame log (point 8) and in the trace file (point 8b).

1. **Names.** A key and a `startParameters` name are plain words (identifiers). A source's own name (`param.<name>`, `webhook.<field>`, `chat.<key>`) is a token, letters, digits, underscores, hyphens and dots, not an identifier: a carrier's names have hyphens, as the plan's own `webhook.SipHeader_User-to-User` does. A source is split at its first dot, so a name may have dots of its own.
2. **`setup.` fields** are the wire's optional fields (`SETUP_EXTRAS`) and the call ids `callSid` and `sessionId`. The call's numbers are refused wherever a carrier puts them (`setup.from`, `setup.to`, `param.telnyx_call_from`, `param.telnyx_call_to`, `webhook.From`, `webhook.To`, `webhook.Caller`, `webhook.Called`; review fixes), with app.yaml's `callerNumber` as the fix: they keep its rules. A `chat.` key longer than 64 characters is refused too, since no context could carry it. `SETUP_EXTRAS` moved from the relay's wire to `channel/callData.ts` (the wire imports it), so the code that reads call data stays outside the relay, as the boundary test asks.
3. **`param.dw_...` is refused**: those are the server's echoes; the fix is `webhook.<field>`. `locale` and `dw_...` are refused as `startParameters` names.
4. **Where it is read.** `channel/callData.ts` `callDataFrom` reads each key from a start's provider details (a setup's fields, its custom parameters as `param.<name>`, an echo as `param.dw_<key>`) or a chat's context. The voice adapter and the chat socket call it and attach the result with `withCallData`; the core keeps only the app's keys, each a non-empty string of at most 500 characters (`core/callData.ts` `keptCallData`). A reconnect runs no start turn, so the first setup's values stand.
5. **The echoes on a reconnect** are written from what the session kept (`webhookParametersOfKept`), since the webhook is not sent again: the reconnect's document carries what the first did. Parameters are written after `locale`: the app's `startParameters`, then the echoes. A document with neither is byte for byte as before.
6. **`startParameters` at start.** The server reads each variable as it starts (`startParametersFrom`, `ServerOverrides.env` for tests) and refuses to start, naming the variable and the fix, when one is unset, blank, over 500 characters or holds a control character; the startup line names the parameters, never their values. `pnpm diagnose` (review fixes) reads app.yaml's `env.<NAME>` references from the YAML alone (`define/envReferences.ts`, `core/app/envReference.ts`, one pattern for the schema, validateApp, the server and diagnose; 2b's transfer targets will be found the same way) and says, one line per variable, whether each is set and how long, never the value, failing what the server would refuse.
7. **Redaction.** The masks are policy.yaml `audit:`'s, through one idempotent function (`recordedCallData`), so a record redacted in the file comes out the same on the console. `secret` leaves a key out of a map. Where each applies:
   - the trace file: the start event's `callData`, and the provider details' `param.<name>` (and `param.dw_<key>`) that a key reads. A setup field in the provider details, and a custom parameter no key reads, are written as they always were: the trace is PHI-bearing by design, and the console already writes every `param.` entry as `redacted`;
   - the console: the same, and `callData` is kept out of the console's masking by key name, since its keys are the app's words (a key named `forwardedFrom` is masked by its own `redact`, not as a number);
   - the frame log: the setup's `customParameters` (below), and a `/cr-action` line's fields that a `webhook.` key reads; a setup field keeps the frame log's own masking (`forwardedFrom` to its last four, `callerName` as `redacted`, the ids as they are, which replay needs);
   - the audit: the `call_started` row records each key as `callData.<key>` (the audit's detail is flat), only for an app with `callData` and a call that came with some.
   A parameter two keys read is recorded by the stricter of their masks. A `setup.` key's own copy in the trace's and the console's provider details is masked by the key too (review fixes): `name: { from: setup.callerName, redact: secret }` leaves no name there.
   **The floor** (review fixes): the masking by name the frame log and the console always applied (a field named for a number by its last four, a name `redacted`, `accountSid` and the geo fields left out; now in `channel/maskByName.ts`) is applied after a key's `redact` in the frame log, on the console and in the audit, so `redact` can only make a record stricter. A webhook field's echo `dw_<key>` is floored by its field's name. The trace file (PHI-bearing) records what `keep` keeps.
8. **The frame log's custom parameters (the first deliberate change for every app).** For every app, each custom parameter of a setup, on a new call and a reconnect alike, is written as `redacted` unless a key reads it (then by the key's `redact`); `locale` is written as sent, and Telnyx's `telnyx_call_from` and `telnyx_call_to` to their last four, as before. `redacted` (not `•`) is the word the console already used for an unnamed `param.` entry. The console's view of a frame log applies the same to any setup line, idempotently. Effect on existing logs and replay: none on the logs, which are not rewritten. A replay reads call data from the logged setup, so a masked key stands in as recorded (`•`, `...1234`, `…0102`) and the replay lists the keys it stood in (`skipped`); a key the code branches on wants `keep`. Logs written before the change get no special handling (the maintainer: they are only test calls), and the guide says an older log may not replay a masked parameter. No frame-log fixture in the repository changed, and every replay test passes as it was. The adapter writes a log line with the names (never the values) of the keys a call came with, `{ callData: [...] }`, so a replay names exactly the keys it stood in or lacks: a `secret` one, a field the frame log drops (`accountSid`), and one floored by its name, as well as a masked one (review fixes).
8b. **The trace file's custom parameters (the second deliberate change for every app; review fixes).** Every `param.` entry of a start record's provider details that no key reads is written `redacted`, for every app, as the console already showed it, so an app's `startParameters` values never reach a trace file whole. `locale` stays as sent, and Telnyx's `telnyx_call_from` and `telnyx_call_to` stay under the caller's-number rules (masked where the app keeps the number, else as sent), which live-checks.md check 9 reads for a withheld number's placeholder. The console now shows an unread `param.from` as `redacted` rather than by its last four. Old traces get no compatibility handling (the maintainer: only test calls).
9. **Chat.** A `start`'s `context` that is not an object of at most 50 strings of at most 500 characters and 6 KiB in all (UTF-8 bytes of its JSON), under keys of letters, digits, underscores, hyphens and dots of at most 64 characters, is refused as any malformed start (`bad_message`, naming `context`, never a key or a value). The review asked for an 8 KiB cap; it is 6 KiB because a start may also carry a sign-in token of up to 8 KiB, and the socket takes 16 KiB in all: 8 and 8 with the message's own fields would not fit. A start over 16 KiB is still closed by the socket (1009), and the server logs it; the widget never sends one. The widget (and `createChatClient`) leaves out what the chat cannot take, with a warning, so a page's stray key never refuses a chat. A resume's context is logged and changes nothing the chat kept.
9b. **Values a start document cannot carry** (review fixes): a value with a C0 control character (tab and newline included, which an XML attribute would turn into spaces), DEL, U+FFFE, U+FFFF or a lone surrogate is no value, in every source, the webhook's echoes, a chat's context and a seeded value alike (`usableCallDataValue`); a `startParameters` variable holding one stops the server.
10. **Testing.** A scenario's `callData` goes on the start event on either channel, as the channel would have read it; `App.testing.seed.callData` on every seeded corpus call. The text CLI takes no flag for it.
11. **Conformance.** The check takes an optional `callData` fixture (a custom parameter and a voice webhook field); without one it takes the first custom parameter of a setup and the first webhook field that is not the call id, so a carrier's own fixtures need nothing new. Twilio's uses `callReference` and `ForwardedFrom` (documented, added to its voice webhook fixture); Telnyx's uses `customer_id` and `CallSessionId` (a field seen on a live voice webhook, 2026-10-05), its echo marked `ASSUMED` until live-checks.md check 11.
12. **The fixture** is Example Callbacks (`src/testing/callback`): five keys, one of each source, and its priority queue told the callback comes within the hour. It has no stub baseline, so its three new scripted calls are held to their own expectations; no baseline was written or edited. Its scenario list in `core/callerNumber.test.ts` gained them.
13. **The design's YAML block** (2026-10-08, section 1) wrote `from: forwardedFrom`, which the docs' YAML test now refuses; it is kept as written, as a `text` block, with a note that the build writes `setup.forwardedFrom`.

## 2b. Transfer targets and the data sent

```text
# app.yaml
transfer:
  targets:                              # tried in order, the first whose conditions all hold is taken
    - when: { callData: queue, is: vip }
      to: env.VIP_NUMBER
    - when: { form: [billing_question, payment] }
      to: env.BILLING_NUMBER
    - when: { reason: [emergency] }
      to: env.EMERGENCY_NUMBER
      send: { headers: { X-Priority: "1" } }
  default: env.HANDOFF_NUMBER           # the default when transfer is absent
  send:
    headers: { X-Account-Ref: callData.accountRef, X-Reason: reason, X-Form: form, X-Member: slot.memberId }
    chat: { reason: reason, form: form }
```

Decisions:

1. **Ordered rules, not a fixed precedence.** The app writes the order; the recommended one (`callData`, then form, then reason) is how the guide and the skill show it. A rule's `when` holds when every condition in it holds. Conditions in this piece: `reason` (one or a list), `form` (one or a list; the form the caller was in, or the one just completed), `callData` (`is`, `in`, `notIn`, `present`). Piece 3 adds its conditions to the same evaluator. `default` is required when `transfer` is written.
2. **Numbers stay in the environment.** `to` is `env.<NAME>`; the variable holds an E.164 number or a `sip:` URI. The server refuses to start when a named variable is unset or neither, with the fix, and `pnpm diagnose` checks each (a 555 number warned of, as `HANDOFF_NUMBER` is). Without `transfer`, every handoff dials `HANDOFF_NUMBER`, as today.
3. **The engine chooses, the server dials.** The handoff decision carries the chosen target's variable name (never the number) through the transfer action and the end frame's handoff data; the server dials the variable's value only if the name is one the app's targets name, and `HANDOFF_NUMBER` otherwise. The paths that dial with no decision (gave up after reconnects, closing, a draining server, an unreadable session) dial the `default`.
4. **Data sent with the transfer: one shape for both carriers.** `send.headers` maps header names to `callData.<key>`, `slot.<id>`, `reason` or `form`, or a quoted constant. A slot's value goes as `handoff.data` sends it (omitted, masked or as-is, by the same rules), so a header can never carry what the handoff data would not. A rule's own `send` is merged over the top-level one. The provider writes what it can carry:
   - to a `sip:` target, the headers on the SIP INVITE (Twilio `<Dial><Sip>` URI headers; Telnyx `<Dial><Sip>` custom headers, marked `ASSUMED` until a live check);
   - to a phone number, no carrier carries headers, so they are dropped and the frame log and trace say which.
   Header names are tokens (`X-` names and `User-to-User`); values are escaped and capped (1024 characters in all, the stricter carrier's limit).
5. **`VoiceProvider.dialDocument` and `apologizeAndDialDocument` take a `DialTarget { to, headers? }`** instead of a number. A breaking change for a carrier adapter of one's own, said in the changelog of the guide's section 13; both built-in providers, the conformance kit (a SIP target with headers, a number with headers dropped) and the fallback document move to it.
6. **Chat**: `send.chat` names an allowlisted object sent with the chat `transfer` message (`{ type: 'transfer', reason, data? }`), handed to the widget's `onTransfer(reason, data)`; absent unless written. The wire stays version 1 (an optional field).
7. **Records**: the audit's `handoff` row gains `target` (the variable name) and `sent` (header names only, never values); the console shows the chosen target's number masked; the trace has the rule taken.
8. **`pnpm check`**: an unknown form, callData key or slot; a reason with no `handoff_<reason>` line (a warning); a rule after one that always holds (a warning); a variable name that is not `env.<NAME>`; a header name that is not a token; `default` missing.

Tasks: schema, `App.transfer` and the condition evaluator (`core/conditions.ts`, shared with piece 3); the engine's choice in the handoff decision and transfer action; the end frame and `decideAction`; config and diagnose; `DialTarget` in both providers, twiml and fallback; header values and the handoff data rules; chat data and the widget; audit, console, trace; check; conformance and live-checks.md; docs and the skill.

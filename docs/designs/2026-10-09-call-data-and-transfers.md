# Call data and transfers: the build (flow building blocks, piece 2)

Date: 2026-10-09. Status: **build plan; being built.** Source: [2026-10-08-flow-building-blocks.md](2026-10-08-flow-building-blocks.md), sections 1 and 2, and the maintainer's decisions at its end (targets chosen by `callData`, form and reason; Twilio and Telnyx together, one shared shape). Built as two items: 2a, `callData`; 2b, transfer targets and the data sent with a transfer. Piece 3 (`routes.yaml`) reuses the condition 2b introduces.

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

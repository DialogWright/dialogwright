# Live checks

Some of what DialogWright does can only be confirmed with real accounts: a carrier's webhooks and relay as they behave on a real call, a model reached through a gateway, a sign-in token from a real identity provider. The tests run everything against the carriers' documented examples and against fakes; this page is what is left, written for the person who holds the accounts. Together the checks cost a few cents of call minutes and model requests.

Each check says what to set, what to do, what to look for, and where to record the result. Write the outcome in the [results log](#results-log) at the end of this page, whatever it is, and make the change it asks for when a check finds something the code assumed differently. Keep every number, name and capture fictional or redacted before it is committed: the frame log already masks callers' numbers, but read a capture before you copy it.

## Before you start

- **An app and its settings.** The checks use the utility example (`apps/utility`) unless a check says otherwise. `pnpm configure --app utility --force` writes `apps/utility/.env` with the carrier, the model and the handoff number (a key read with the echo off, never a flag), and `pnpm start --app utility` runs the server with it (`pnpm --filter @dialogwright/example-utility serve` with `ENV_FILE=apps/utility/.env` is the same server without the tunnel). A check that sets a variable adds it to that file, or puts it in front of the command (a variable in the environment wins over the file).
- **A public address.** The carriers post webhooks to `https://<PUBLIC_HOST>`. With `PUBLIC_HOST` unset, `pnpm start` opens a Cloudflare quick tunnel and prints the hostname and the webhook URL (check 7 is whether a carrier's call runs through it); with a named tunnel or ngrok, set `PUBLIC_HOST` to its host name (no scheme, no path). Before a call, `PUBLIC_HOST=<host> pnpm diagnose --app utility` (the line `pnpm start` prints) says what is misconfigured.
- **Where to look.** The server's console prints one line per webhook (`/voice/telnyx <call id> from ...0110`, `/cr-action/telnyx <call id> <status> -> <decision>`), and the startup line says what is in force (carriers, voices, recognizers, chat, sign-in). Each call writes two files under `TRACE_DIR` (default `traces/`): `<call>.jsonl`, the turns, and `<call>.frames.jsonl`, the wire: every frame in and out (`"dir": "in"` and `"out"`), the action callback's fields (`"dir": "http"`) and the server's notes (`"dir": "log"`). The operator console is at `http://localhost:<PORT>/dashboard` on the same machine.
- **Fakes stay off.** Keep `SIGNATURE_CHECK=on` (the default) for every carrier check: a signature that fails is one of the things to find.

## 1. Twilio, unchanged

**Why.** Carriers became plug-ins in this phase; a Twilio number set up before must behave exactly as it did.

**Set.** `VOICE_PROVIDERS=twilio` (or leave it unset), `TWILIO_AUTH_TOKEN`, `HANDOFF_NUMBER`, `PUBLIC_HOST`.

**Do.**
1. Point a Twilio number's voice webhook at `https://<PUBLIC_HOST>/voice/twilio` and call it. Ask about a balance, verify as a fictional customer, and end the call ("no, that's all").
2. Point it back at `https://<PUBLIC_HOST>/voice` (the path from before carriers) and call again.

**Look for.** Both calls greet, run and end the same way. The console shows `/voice/twilio CA... from ...` and then `/voice CA...`, and at each end `/cr-action... -> completed`. No `signature rejected` line. The dashboard names the carrier `twilio` on both. Leave the number on either path: both are supported.

**Record.** Pass or fail in the results log; on a failure, the console lines and the frame log of the call.

## 2. Telnyx

**Why.** Telnyx's TeXML `<ConversationRelay>` is documented, but some of what the engine needs is not; `server/voice/telnyx.ts` lists six assumptions, and `server/voice/__fixtures__/telnyx/webhooks.json` marks the webhooks it could not copy from the docs `ASSUMED`. This check settles them.

**Set.** `VOICE_PROVIDERS=telnyx` (or `twilio,telnyx`), `TELNYX_PUBLIC_KEY` (the account's public key, base64, as the Telnyx portal shows it), `HANDOFF_NUMBER`, `PUBLIC_HOST`. Optionally `TELNYX_VOICE=Telnyx.Ultra.Callie` to hear a voice the deployment chose.

**Do.** Create a TeXML application whose voice URL is `https://<PUBLIC_HOST>/voice/telnyx` (method POST), give a Telnyx number to it, and call the number. Run the same short call as in check 1 and end it normally.

**Look for, and record each:**

1. **The signature.** No `signature rejected` in the console. If there is one, check `TELNYX_PUBLIC_KEY` and the server's clock (a timestamp more than five minutes off is refused) before anything else.
2. **The voice webhook's encoding and call id.** The console shows `/voice/telnyx v2:... from ...` when the call was accepted. If it shows `/voice/telnyx: missing CallSid` and the call fails, the body was not what the parser reads. Either way, open the request in the Telnyx portal's webhook debugging and note: the content type (form-encoded or JSON), which field carries the call id (`CallSid`, `call_control_id`, `CallControlId`), and whether a JSON body nests it (a Call Control style `data.payload.call_control_id`: the parser reads top-level fields only, so a nested body needs a parser change).
   **Record:** replace the `voice` entry of `__fixtures__/telnyx/webhooks.json` with the captured shape (numbers made fictional), its `source` set to `captured <date>`, and update assumption 1 in `telnyx.ts`. Run `pnpm --filter dialogwright test server/voice` after.
3. **The action callback and the handoff field.** At the end of the call, the console shows `/cr-action/telnyx v2:... -> completed` and Telnyx hangs up. The call's frame log has an `"dir": "http"` line with the callback's fields: note whether the end frame's data came back as `HandoffData`, `handoffData` or another name.
   **Record:** the `action` entry of `webhooks.json` (as above) and assumption 2 in `telnyx.ts`. If the field has another name, the parser must take it: a code change with a test.
4. **`hints`.** `hints` is not a documented TeXML attribute; the engine sends it anyway. Look for any warning or error about it in the Telnyx portal's call debugging, and whether the call ran at all.
   **Record:** "accepted", "ignored" or "refused" for assumption 3 in `telnyx.ts`; if refused, Telnyx's start document must stop sending it (a code change with a test).
5. **Frames for the kit.** From the frame log, copy the `setup` frame, a `prompt` frame (and one with `"last": false` if there is any) and, if you interrupted the agent mid-line, an `interrupt` frame. Redact them (numbers fictional, no names), and add them to `__fixtures__/telnyx/frames.jsonl`, each with `"source": "captured <date>"`.
   **Record:** run `pnpm --filter dialogwright test server/voice/conformance` and note that the kit still passes with the captured frames.
6. **The keypad and barge-in.** Press a menu key when the menu is offered, and talk over a long line. The key should act, and the line should stop where you spoke (an `interrupt` frame in the frame log). These are documented (`dtmfDetection`, `interruptible`) and should behave as on Twilio.
7. **A line cut short, said again.** With `TELNYX_EVENTS="speaker-events tokens-played"`, answer a question at once and listen to the reply. If Telnyx cuts it short (a few hundred milliseconds of it, then silence), the line should come again within a second: the console shows `playback cut short (... s of ~... s), lines said again`, and the frame log has `{ "resaid": ... }` before the line's frames, after the carrier's `agentSpeaking` and `tokensPlayed` events. A line you talk over must not come again.
   **Record:** the timings from the frame log, and whether the second playing was heard; a line said again that you had heard means `RESAY_MIN_FRACTION` is too high for this voice.
8. **The goodbye before the hang-up.** Finish a call ("no, that's all") and, on another, ask for a person. The goodbye, and the line before the transfer, should play in full before Telnyx hangs up or transfers. The frame log has `{ "endAfter": "played", "endHeldMs": ... }` between the line's frame and the `end` (with `TELNYX_EVENTS`; `"estimate"` without). Once, hang up during the goodbye: the log has `"endAfter": "closed"`, no `end`, and the callback hangs up.
   **Record:** `endHeldMs` against `expectedMs`, and whether any of the line was lost; a `"timeout"` means Telnyx sent no report of the line (keep the timings).
9. **A caller who had not finished, with barge-in off.** With `BARGE_IN=none` and `TELNYX_EVENTS` speaker-events, give an account number or an address in two breaths with a short pause ("one two ... three four"), so that the reply to the first part goes out while you are still speaking; then again with a longer pause, a second or so, as a caller thinking of the rest of their address. Each time the two parts should be taken together: the frame log has `{ "callerResumed": { "pauseMs": ..., "intoReplyMs": ... } }` just before the second prompt, then `{ "joined": 2 }`, and the reply reads back the whole number or address. Then answer a question in one breath, wait for the reply, and answer that: nothing should be joined. Also, as you call, say something over the greeting: Telnyx has sent no `clientSpeaking` while the call's first line plays, and whether it ever does is worth a note.
   **Record:** `pauseMs` and `intoReplyMs`, and the gap from your last `clientSpeaking` off to the second prompt (longer than `NO_INPUT_AFTER_SPEECH_MS` means the joining is missed); a split not joined with `pauseMs` over `RESUME_AFTER_PAUSE_MS` or `intoReplyMs` over `RESUME_INTO_REPLY_MS` (raise the one it was over), or an answer to the reply joined to the prompt before it (lower it).
10. **An interrupt the caller did not make, and a reply held.** With `BARGE_IN=speech` and `TELNYX_EVENTS="speaker-events tokens-played"`, stay silent through the greeting on a few calls. If Telnyx's barge-in fires with no `clientSpeaking` (an `interrupt` in the frame log with none before it), the greeting should come again from the start about 0.4 s later: the frame log has `{ "spuriousInterrupt": ... }`, then `{ "resaid": { "reason": "spurious-interrupt", ... } }` before the greeting's frame. Once, talk over the greeting: note whether a `clientSpeaking` on comes within 0.4 s of the `interrupt` (if not, the greeting is said again over you; `RESAY_SPURIOUS_INTERRUPTS=off` is the way back). Then give an address in two breaths with a pause after the house number ("seventy six ... twenty five oak hollow lane"): no reply should be heard between the two, the frame log has `{ "replyHeld": { "outcome": "joined", ... } }` after the first prompt, and the reply reads back the whole address.
   **Record:** the `interrupt`'s `durationUntilInterruptMs` and the gap to any `clientSpeaking`; for the address, `replyHeld`'s `ms` and `utteranceComplete` (a fragment read at or over `GATE_COMPLETE` is not held: note the reading), and any finished answer that was held (`outcome` `sent`, a second of extra silence).

## 3. Reconnect after the relay socket fails, and a restart mid-call

**Why.** When the relay's socket drops mid-call, the carrier is expected to post the `<Connect action>` callback, and the engine answers with a new start document so the call resumes. On Twilio this is documented; on Telnyx it is not, and reconnect depends on it. With `SESSION_STORE=file:<dir>` the call is saved after every turn, so a restarted server should resume it too, when the callback reaches it; when the callback arrives while no server is listening, the carrier is expected to use the number's fallback (the document `pnpm fallback` writes), which no test can show. A planned restart relies on one more thing no test can show: that the carrier takes a `<Pause>` before the `<Connect>` in its callback's document, so its socket reaches the restarted server.

**Set.** As in check 2 (and once with check 1's settings for Twilio, as a baseline). For runs b, c and d also `SESSION_STORE=file:sessions`, and the carrier's fallback set to a document from `pnpm fallback --provider <carrier> --number <HANDOFF_NUMBER> --out fallback.xml`, hosted somewhere other than this machine (Twilio: the number's "Primary handler fails" URL; Telnyx: the TeXML application's fallback URL).

**Do.** Four runs, each a call that gets past the greeting and into a form (an answer or two given):
- a. With the memory store (`SESSION_STORE` unset): `kill -9` the server's process and start it again at once. The session was in the killed server's memory, so the engine hangs up rather than resumes; what this run is after is whether the callback arrives. (A Ctrl-C would drain first, and after `DRAIN_MS` the stopping server would answer the callback itself by putting the caller through to `HANDOFF_NUMBER`: also worth seeing once, as `-> dial:closing`.)
- b. With the file store, a crash: `kill -9` the server's process and start it again at once.
- c. With the file store: stop the server and wait 30 seconds before starting it again.
- d. With the file store, a planned restart: `DRAIN_MS=0` and the default `RESTART_PAUSE_S=5`, the server run by its service (`pnpm service`), restarted with `systemctl --user restart` or `launchctl kickstart -k`, so it stops and starts as an update would.

**Look for.** Run a: within a few seconds of the restart, a `/cr-action/telnyx v2:... <SessionStatus> -> hangup` line (or `/cr-action/twilio CA... failed -> hangup` on Twilio): the word before the arrow is the callback's `SessionStatus`, and `-> hangup:<status>` instead means the callback's `SessionStatus` was `completed` or its call status was not a live one, so even a server that still held the call would not have reconnected it. A live call is the carrier's own word for one: Twilio's `in-progress`; Telnyx's `active` (the relay's setup frame says it) or `in-progress` (TeXML's). A callback with no call status at all is reconnected only when its `SessionStatus` is `failed` (an assumption, `telnyx.ts` assumption 6); `-> hangup:unknown` means it carried neither. Note the `SessionStatus` and the call status (`CallStatus`, `callStatus` or another name) the frame log's `http` line shows, if the call's frame log survived. Run b: either `<call>: restored from the session store`, `/cr-action/... failed -> reconnect:1` and `<call>: resumed after a restart`, with the caller hearing "Sorry, I lost you for a moment." and the question they were on, and the form going on with what they had given; or no callback at all on the restarted server (it came while nothing listened), and then whether the caller heard the fallback's line and the handoff number rang. Note how long after the stop the callback came, and whether the carrier tried it more than once. Run c: the fallback, and then `pnpm audit:verify` on the audit folder passes. Run d: on the stopping server, `drain: ... the carrier is told to wait 5 s and connect again` and `/cr-action/... failed -> reconnect:1 after 5 s`; on the restarted one, `<call>: restored from the session store` and `<call>: resumed after a restart` with no callback before them; the caller hears about five seconds of silence, then "Sorry, I lost you for a moment." and the question they were on. An `upgrade refused: the server is restarting` line means the carrier connected before the old server had gone (its pause was not taken, or was shorter than the stop).

**Record.** Whether Telnyx posted the callback, the name and value of its call status field (or that it has none), and its `SessionStatus`. If it did not post it, a dropped Telnyx call cannot reconnect: say so in `telnyx.ts` and in the guide's [13.2](authoring-an-app.md#132-serving-voice-twilio-telnyx-or-both). If its status is another word, or under another name, add it to `telnyx.ts` (`LIVE_STATUSES`, the parser) with a test, and add the captured callback to `__fixtures__/telnyx/webhooks.json`; update assumption 6. For runs b and c: whether the call resumed, whether a callback that found no server reached the fallback (on each carrier), and the time from the stop to the callback. If a failed callback does not reach the fallback, say so in the guide's section 14 and on the home-server guide: then a restart drops a caller whose callback comes while the server is down. For run d, on each carrier: whether the `<Pause>` before the `<Connect>` was taken (the silence, and the time from the callback to the socket on the restarted server), how long the restart took against `RESTART_PAUSE_S`, and whether the call resumed with no one put through. If a carrier connects at once, ignoring the pause, say so in that carrier's file (`voice/twilio.ts`, `voice/telnyx.ts`) and in section 14, and recommend `RESTART_PAUSE_S=0` with the fallback for it.

## 4. Languages on the phone

**Why.** A call in another language depends on how the carriers read the start document's `<Language>` and `<Parameter>` children, the text frames' `lang` and the `language` frame (`set_language`). Twilio documents all of them. Telnyx documents the `<Language>` child (`code`, and per language `voice`, `ttsProvider`, `transcriptionProvider` and `speechModel`), the `<Parameter>` child (echoed in the setup frame's `customParameters`) and the `language` frame; it does not document a text frame's `lang` (its example has `token` and `last` only), nor that a `<Language>` child inherits what it leaves out from the relay element, so those are what a Telnyx call settles. Two more things are read from the docs and need hearing: whether a `<Language>` child's voice and recognizer apply to the call's first language (not only after a switch), and whether a recognizer other than Deepgram flux still sends the partial prompts the no-input wait relies on.

**Set.** None of the example apps has a second locale, so make a scratch one for the check and do not commit it: `pnpm create-app lang-check`, then add `apps/lang-check/locale/es/prompts.yaml` with every line in Spanish (the library fixture's `packages/dialogwright/src/define/fixture/locale/es/prompts.yaml` shows the shape; `pnpm check` lists any line missing), a switch intent (the guide's [13.3](authoring-an-app.md#133-languages-on-the-phone) has one, with its prompt in both locales and examples in the corpus), and in its app.yaml two voices that sound clearly different, with nothing shared on the relay element:

```yaml
voice:
  numbers:
    "+15555550142": es        # the real number you will call for Spanish, in place of this one
  locales:
    en-US:
      voices: { twilio: { voice: en-US-Neural2-F, provider: Google }, telnyx: Telnyx.Ultra.Callie }
    es:
      tts: es-US
      transcription: es-US
      voices: { twilio: { voice: es-US-Neural2-B, provider: Google }, telnyx: Telnyx.Ultra.Asher }
      recognition:
        twilio: { provider: Deepgram, model: nova-3-general }
```

Run it with the carrier's settings from check 1 or 2 (`pnpm configure --app lang-check`, then `pnpm start --app lang-check`). Two numbers: one listed under `voice.numbers` for `es`, one not. Delete `apps/lang-check` when the check is done.

**Do, on Twilio and then on Telnyx:**
1. Call the Spanish number. Listen to the greeting.
2. Call the other number, and say the switch intent's words ("can we continue in Spanish"). Then answer the next question in Spanish.
3. On the Spanish call, after a question, start a long answer slowly, with a pause in the middle.

**Look for.**
1. The Spanish call's greeting is in Spanish **in the Spanish voice** (es-US-Neural2-B, or Asher). If it is in Spanish but in the carrier's default voice, the `<Language>` child's settings did not apply to the call's first language: the start document must then put the first language's voice on the relay element (a code change in `server/voice/xml.ts placeLanguages`, with a test). The frame log's `setup` frame should carry `customParameters.locale: "es"`.
2. After the switch, the next line is in Spanish in the Spanish voice, the frame log shows an outgoing `language` frame before it, and your Spanish answer is heard as Spanish (the `prompt` frame's text). On Telnyx, note also whether its `prompt` frames' `lang` changes, and whether a line whose text frame names `es-US` in `lang` is spoken in Spanish before any `language` frame (on the Spanish number's call, from the greeting): that says whether Telnyx reads a text frame's `lang` at all.
3. The frame log shows `prompt` frames with `"last": false` while you were speaking (partial prompts), not only the final one, and the question was not asked again while you spoke. If there are none, the no-input wait cannot be cancelled early on that recognizer.

**Record.** For each carrier: the first-language voice (applied or not), the switch (voice, recognition, the `language` frame taken or refused), partial prompts on nova-3-general (sent or not), and for Telnyx whether the `<Parameter>` reached the setup frame (documented; a check that it does) and whether a text frame's `lang` was read. Update the known limits in the guide's [13.3](authoring-an-app.md#133-languages-on-the-phone) and §11.1 of [design.md](design.md) with what you found, and assumption 4 and 5 in `telnyx.ts`.

## 5. The decision model through OpenRouter and the Vercel AI Gateway

**Why.** The model can be reached through TypeSafe, OpenRouter, the Vercel AI Gateway or a compatible endpoint (`JEV_PROVIDER`). TypeSafe's has been used for every recording; the two gateways have not been called from here, and OpenRouter's base URL is inferred from its documented endpoint.

**Set.** For OpenRouter: `JEV_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. For Vercel: `JEV_PROVIDER=vercel` and `AI_GATEWAY_API_KEY`. Nothing else.

**Do.** For each, run the clinic's text console against the live model and type one sentence:

```sh
pnpm --filter @dialogwright/example-clinic cli --client jev
```

Say `I need to move my appointment to next week`, then quit.

**Look for.** The first lines name the provider and the model (`typesafe/jev-1.13` on OpenRouter, `typesafe-ai/jev` on Vercel) with no warning about a compatible model, and the reply starts the reschedule form, as a call through TypeSafe does. An HTTP error, a 404 (a wrong base URL) or a refusal of the key is a failure.

**Record.** Pass or fail for each, with the error if any. A wrong base URL is fixed in `src/jev/provider.ts` (with its test).

## 6. Web chat with a real identity provider

**Why.** The chat's `jwt` sign-in is tested against keys made in the test. A real provider's published keys, issuer, audience and token claims must be shown to work end to end.

**Set.**
1. A test tenant of any OpenID Connect provider, with an application whose ID tokens the page can get, and a test user. Add a custom token claim, `account_id`, carrying one of the utility's fictional accounts (`55501234`, say), since the provider's own `sub` is not an account the utility knows.
2. In `apps/utility/identity.yaml`, set `signIn.claim` to `account_id` for the check (do not commit it).
3. The server: `CHAT=on`, `CHAT_ALLOWED_ORIGINS=<the origin of the page below>`, `CHAT_SIGNIN=jwt`, `CHAT_JWKS_URL=<the tenant's JWKS URL, https>`, `CHAT_ISSUER=<the tenant's issuer, exactly as its tokens say>`, `CHAT_AUDIENCE=<the application's client id>`, `PUBLIC_HOST=<the tunnel's host>`, and `WIDGET=on` after `pnpm --filter @dialogwright/widget build`.
4. A page, served from the allowed origin, that signs the user in with the provider's own script and mounts the widget with `endpoint: 'wss://<PUBLIC_HOST>/chat'`, the script from `https://<PUBLIC_HOST>/widget.js`, and `getToken` returning the ID token.

**Do.** Open the page, sign in with the test user, open the chat, choose sign-in in the panel, and ask for the balance.

**Look for.** The panel says you are signed in; the console shows the signed-in identity line for the session (the subject the token named, at the sign-in level); the balance is answered without the account number and date of birth being asked. The startup line shows `chat sign-in jwt (<issuer>)`. Then sign in with a token for the wrong audience (another application of the tenant) and see `sign_in_failed` in the panel. No token appears in the console or in any file under `TRACE_DIR`.

**Record.** Pass or fail, the provider's kind (not the tenant's name), and anything about its tokens the guide's [13.5](authoring-an-app.md#135-sign-in-on-the-web-chat) should say (a key algorithm it uses that the engine refuses, a namespaced token claim). Put `apps/utility/identity.yaml` back.

## 7. A carrier through a quick tunnel

**Why.** `pnpm start` opens Cloudflare's quick tunnel so the first hour needs no account. Cloudflare's quick tunnel page does not mention WebSockets, which the call's relay runs on (named tunnels document them), and a quick tunnel has no uptime guarantee and a limit on requests in flight. The tests only read `cloudflared`'s output from samples written in its log format; no test has run it.

**Set.** `cloudflared` installed, `PUBLIC_HOST` unset in `apps/utility/.env` (as `pnpm configure` leaves it), the carrier's settings from check 1 or 2.

**Do.**
1. `pnpm start --app utility --tunnel quick`. Note how long it takes to print the `*.trycloudflare.com` hostname and the webhook URL.
2. In another terminal, run the `pnpm diagnose` line it printed.
3. Paste the webhook into the number (the steps it printed) and call. Run a call through a form to its end, with a pause of a minute or more somewhere in it.
4. Ctrl-C `pnpm start` during a second call, and watch the order the server and `cloudflared` stop in.

**Look for.** Step 1: the hostname within the 30 seconds `pnpm start` waits, and no `[cloudflared] ... ERR` lines. Step 2: `reach` and `console` `ok` (the console a 404 through the tunnel). Step 3: the call greets, runs on the relay's WebSocket (the frame log has `setup` and `prompt` frames), and ends with `/cr-action/<carrier> ... -> completed`; no `reconnect` in the console during the pause (an idle socket closed by the tunnel would show one). Step 4: the server drains (`draining`), the call goes on until it ends or `DRAIN_MS` passes, and only then does `cloudflared` stop.

**Record.** On each carrier: whether the WebSocket ran through the quick tunnel, the time to the hostname, and any reconnect during the pause. If the socket never opens, say so in section 14.3 of the guide and on the home-server guide (the first hour then needs a named tunnel or ngrok), and in `server/start.ts`'s notes.

## 8. Console sign-in from a phone, through the tunnel

**Why.** `CONSOLE_AUTH=token` is tested against the server on one machine, and the console's narrow layout was looked at in a desktop browser at a phone's width. A real phone on a mobile network, through the tunnel, is what an owner will use: the cookie's `Secure` and `SameSite=Strict` over the tunnel's https, a messaging app's link preview, the client address the tunnel reports, and the page on a small screen.

**Set.** As in check 7 (a quick tunnel) or with a named tunnel, plus `CONSOLE_AUTH=token` and `CONSOLE_CLIENT_ADDRESS=cf-connecting-ip`. Once with `CONSOLE_SESSION_KEY` set (`openssl rand -hex 32`) and once without.

**Do.**
1. Start the server and run `pnpm console:link --app utility` on the machine. Send the link to the phone through a messaging app that shows link previews, and wait for the preview to appear.
2. Turn the phone's Wi-Fi off (mobile data only), open the link, and press Sign in. Make a call to the number and watch it in the console.
3. Replay the call from the console. Then Sign out.
4. Open the same link again and press Sign in. Then try a made-up code five times (`/dashboard/login?code=` with 64 hex digits of your own).
5. Restart the server (once with the session key set, once without) and reload the console on the phone, signed in and signed out.

**Look for.** Step 1: the preview does not use the code up (the sign-in still works in step 2). Step 2: the console opens with no sideways scroll, Sign out on screen, and the live call appears. The `console_access` entries in the day's audit file (`sign_in`, `live`, then `replay`) carry the phone's address on the mobile network, not the tunnel's, with `via: tunnel`. Step 3: after Sign out, a reload goes to the sign-in page. Step 4: a used code is refused, and the made-up codes are refused (`sign_in_refused` with `used`, then `unknown`). Step 5: with the key, a signed-in phone stays signed in and a signed-out one stays out; without it, both are signed out. `pnpm audit:verify` passes on the audit folder.

**Record.** The phone's kind and browser (not its owner), whether the preview used the code, the address the access log recorded, and anything the narrow layout got wrong. A preview that uses the code, or an address that is the tunnel's own, is a code change with a test.

## Results log

One row per check run. Keep earlier rows.

| Date | Check | Carrier or provider | Result | What changed because of it |
|---|---|---|---|---|
| | | | | |

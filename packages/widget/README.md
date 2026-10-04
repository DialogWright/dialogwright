# @dialogwright/widget

The DialogWright web chat widget: a small script a site embeds to talk to a DialogWright chat endpoint (`/chat`, served by the engine when `CHAT=on`). It has no runtime dependencies and carries no engine code; it speaks the chat wire (`packages/dialogwright/src/channel/chat/protocol.ts`) and nothing else.

## The client

`createChatClient` is the widget without a page: a site that wants its own interface uses it alone.

```ts
import { createChatClient } from '@dialogwright/widget';

const chat = createChatClient({
  endpoint: 'wss://chat.example.com/chat',
  locale: 'es',                                  // optional: the language to ask for
  getToken: async () => mySite.idToken(),        // optional: a sign-in token, or null
  onEvent: (e) => console.log(e),
});
await chat.ready;            // { session, locale }
await chat.send('my power is out');
```

What it reports through `onEvent`:

| Event | When |
|---|---|
| `{ type: 'connection', state }` | `connecting`, `open` (the chat takes text), `reconnecting`, `closed` (ended, closed by the page, or not taken back), `unavailable` (the server is full and the client has stopped trying) |
| `{ type: 'ready', session, locale }` | A chat started or resumed; `locale` is the language the server chose from the one asked for |
| `{ type: 'restarted' }` | The chat a resume named had ended; a new one starts, its `ready` next |
| `{ type: 'say', text, lang }` | A line from the agent, in language `lang` |
| `{ type: 'signed_in', level }` | The server took the sign-in |
| `{ type: 'transfer', reason }` | The chat is handed to a person; `end` follows |
| `{ type: 'end' }` | The chat is over |
| `{ type: 'error', code, message }` | A refusal: `too_long`, `busy`, `sign_in_failed`, `not_allowed`, `bad_message`, `server_error` |

How it behaves:

- **A drop is not the end.** It reconnects after each step of `backoffMs` (default `[500, 1000, 2000, 5000]`, the last repeating) and resumes the same chat with the latest resume token the server gave it. What is typed meanwhile is sent once the chat is back.
- **An ended chat starts afresh.** If the chat it resumes has ended (idle too long, or the server restarted), the server starts a new one: the client reports `restarted`, then the new `ready`, and asks `getToken` again.
- **A full server is not hammered.** When the server refuses a new chat as `busy` (`CHAT_MAX_SESSIONS`), the client tries again after each step of `backoffMs` and then stops with `unavailable`.
- **Sign-in.** `getToken` is asked when a chat starts and whenever the site calls `signIn()`; a resume keeps the sign-in the chat had. A token naming someone who acts for others (a delegate) is honoured only when a chat starts.
- **A transfer** is reported, then the end; the client does not reconnect.

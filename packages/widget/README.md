# @dialogwright/widget

The DialogWright web chat widget: a small script a site embeds to talk to a DialogWright chat endpoint (`/chat`, served by the engine when `CHAT=on`). It has no runtime dependencies and carries no engine code; it speaks the chat wire (`packages/dialogwright/src/channel/chat/protocol.ts`) and nothing else.

## Embedding the widget

One script tag, its options as `data-*` attributes:

```html
<script src="https://cdn.example.com/dialogwright-widget.js"
        data-endpoint="wss://chat.example.com/chat"
        data-title="Help" data-position="bottom-left"></script>
```

Or from code, for the options only code can give (a sign-in token, what a transfer does):

```html
<script src="https://cdn.example.com/dialogwright-widget.js"></script>
<script>
  DialogWright.mount({
    endpoint: 'wss://chat.example.com/chat',
    getToken: async () => mySite.idToken(),
    onTransfer: (reason) => mySite.openLiveChat(reason),
  });
</script>
```

The server must list the site's origin in `CHAT_ALLOWED_ORIGINS`.

| Option | `data-` attribute | Default | What it does |
|---|---|---|---|
| `endpoint` | `data-endpoint` | required | The chat endpoint, `wss://host/chat`. |
| `locale` | `data-locale` | the page's `<html lang>`, else none | The language asked for; the server answers in the app's closest one. |
| `title` | `data-title` | "Chat with us" | The panel's heading. |
| `strings` | `data-strings` (JSON) | English | Any of the widget's words (below). |
| `position` | `data-position` | `bottom-right` | `bottom-right`, `bottom-left`, or `inline` (inside `container`, always open). |
| `container` | `data-container` (a CSS selector) | none | Where an `inline` widget goes. |
| `startOpen` | `data-start-open` | `false` | Open the panel, and connect, on load. Otherwise the widget connects when it is first opened, so a page view that never chats opens no chat. |
| `getToken` | (code only) | none | The site's sign-in token, or null; with it, the panel offers sign-in. |
| `onTransfer` | (code only) | the panel says `transferred` | What a transfer does on this site (open a live chat, show a number). |
| `backoffMs` | (code only) | `[500, 1000, 2000, 5000]` | Delays between reconnect attempts. |

An option it cannot read (an unknown position, a word it does not have, `data-strings` that is not JSON) is warned about in the console and the default is used; a missing `endpoint`, or an `inline` widget without a container on the page, is an error.

**Words.** Every word the widget shows is a key of `strings` (`src/strings.ts`): `open`, `close`, `title`, `log`, `message`, `placeholder`, `send`, `you`, `agent`, `signIn`, `signedIn`, `signInFailed`, `connecting`, `reconnecting`, `restarted`, `unavailable`, `wait`, `tooLong`, `ended`, `transferred`, `error`. The agent's lines are the app's own, in the chat's language; the server's error messages are never shown.

**Look.** The widget renders into a shadow root on a `dialogwright-chat` element, so a site's CSS cannot break it and it cannot break the site. Theme it with custom properties on that element:

```css
dialogwright-chat {
  --dw-accent: #0a7c55;   /* buttons, focus ring */
  --dw-accent-fg: #ffffff; /* text on the buttons */
  --dw-bg: #ffffff;       /* panel */
  --dw-fg: #1d1d1f;       /* text */
  --dw-user-bg: #e3f4ec;  /* the person's lines */
  --dw-agent-bg: #f1f1f3; /* the agent's lines */
  --dw-radius: 8px;
  --dw-font: Georgia, serif;
  --dw-z: 1000;           /* stacking order */
}
```

Colours a site leaves unset follow the visitor's light or dark scheme.

**Accessibility.** The conversation is an `aria-live="polite"` log; each agent line carries `lang` from the chat's language, so a screen reader pronounces it right; every control is labelled (with the site's words); Enter sends and Shift+Enter starts a new line; Escape closes the panel and returns focus to the launcher; the tab order is launcher, message box, send, sign-in, close; motion is used only when the visitor has not asked for less.

**Safety.** The panel is built with `createElement`, and every line goes in as text: a line from the server can never become markup.

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

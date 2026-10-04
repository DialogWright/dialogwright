import type { AppRoute, AppRouteDeps, AppRoutes } from 'dialogwright';
import type { App, SubjectListing } from 'dialogwright/core/app/types';
import type { ServerConfig } from 'dialogwright/server/config';
import { app as thisApp } from './app';

/**
 * The worked example of embedding the web chat widget (@dialogwright/widget): a fictional account
 * page for the app, with the widget mounted on it and a "Sign in as" list of the app's own fictional
 * customers (its portal listing). The site's sign-in is the laptop's mock one: the page gives the
 * widget `mock:<id>` for whoever is chosen. It is an example an app mounts through its launcher
 * (serve.ts), not engine code, and it works only in laptop mode: PUBLIC_HOST=localhost, CHAT=on,
 * CHAT_SIGNIN=mock, WIDGET=on. CONSOLE_LOCAL_ONLY keeps it off the tunnel, as it keeps the console.
 */

export const CHAT_DEMO_PATH = '/chat-demo';
const NEEDS = 'PUBLIC_HOST=localhost, CHAT=on, CHAT_SIGNIN=mock and WIDGET=on';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Whether the deployment is a laptop with the chat, its mock sign-in and the widget's script all on. */
export function laptopChat(config: ServerConfig): boolean {
  return config.publicHost === 'localhost' && config.chat?.signIn.method === 'mock' && config.widget !== undefined;
}

/** The page: the app's words go in escaped, and the widget is mounted with the chosen customer's mock token. */
export function chatDemoPage(app: App, subjects: ReadonlyArray<SubjectListing> = app.portal?.subjects?.() ?? []): string {
  const name = escapeHtml(app.brand?.name ?? app.id);
  const options = subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.first)} ${escapeHtml(s.last)}</option>`).join('\n        ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}: your account</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; color: #1d1d1f; background: #f6f7f9; }
    header { background: #0a5c3e; color: #fff; padding: 16px 24px; font-weight: 600; }
    main { max-width: 640px; margin: 24px auto; padding: 0 24px; }
    .card { background: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .note { color: #5f6368; font-size: 0.9em; }
    #transfer { border-left: 4px solid #0a5c3e; }
    dialogwright-chat { --dw-accent: #0a5c3e; }
  </style>
</head>
<body>
  <header>${name}</header>
  <main>
    <div class="card">
      <h1>Your account</h1>
      <p class="note">A demo page on this laptop: everyone on it is fictional. Chat with us from the button in the corner.</p>
      <label for="who">Sign in as</label>
      <select id="who">
        <option value="">Not signed in</option>
        ${options}
      </select>
      <p class="note">Choosing someone starts a new chat, signed in as them (CHAT_SIGNIN=mock).</p>
    </div>
    <div class="card" id="transfer" hidden>
      <strong>A person will take it from here.</strong>
      <p>This is what the site does on a transfer (the widget's onTransfer): it could open a live chat, or show a number to call, such as 555-0100.</p>
    </div>
  </main>
  <script src="/widget.js"></script>
  <script>
    const who = document.getElementById('who');
    const endpoint = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/chat';
    let widget = null;
    function mountChat() {
      if (widget) widget.destroy();
      document.getElementById('transfer').hidden = true;
      widget = DialogWright.mount({
        endpoint,
        title: document.querySelector('header').textContent,
        startOpen: widget !== null,
        getToken: async () => (who.value ? 'mock:' + who.value : null),
        onTransfer: () => { document.getElementById('transfer').hidden = false; },
      });
    }
    who.addEventListener('change', mountChat);
    mountChat();
  </script>
</body>
</html>
`;
}

/** The demo page's route: GET or HEAD of the path itself, nothing under it. */
export function chatDemoRoute(app: App = thisApp): AppRoute {
  return {
    label: 'chat demo',
    path: CHAT_DEMO_PATH,
    localOnly: true,
    async handle(req, res, path) {
      if (path !== CHAT_DEMO_PATH || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
      const body = chatDemoPage(app);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}

/**
 * What the launcher mounts: the demo page in laptop mode; otherwise nothing, with a warning when the
 * web chat or the widget is on (someone is trying the chat, and the demo needs the rest of laptop mode).
 */
export function chatDemoRoutes(deps: Pick<AppRouteDeps, 'config'>): AppRoutes {
  if (laptopChat(deps.config)) return { routes: [chatDemoRoute()] };
  const trying = deps.config.chat !== undefined || deps.config.widget !== undefined;
  return { routes: [], warnings: trying ? [`chat demo: off (it needs ${NEEDS})`] : [] };
}

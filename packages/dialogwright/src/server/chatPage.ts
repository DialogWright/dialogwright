import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '../core/app/types';
import type { ChatBlock, ChatInline } from '../channel/actions';
import { chatLine } from '../prompts/rich';
import type { AppRoute, AppRoutes } from './appRoutes';

/**
 * The app's chat page, the engine's (app.yaml's chat.page; docs/designs/2026-10-18-chat-page.md): its
 * brand (app.yaml's brand: logo, name, tagline, colours) above the conversation, front and centre (the
 * widget's mountConversation, from the server's /widget.js), ways to start, and a number to call. Served
 * at /<app id>/chat, on the server's machine alone or to everyone, as chat.page.serve says unless the
 * app's CHAT_PAGE setting says otherwise. Every value the app gives is escaped into the page: a name or
 * a phrase is text, a colour is a checked hex code, the intro is the chat formatting drawn as elements.
 */

/** Where the page is, below the app's base (`/<app id>`). */
export const CHAT_PAGE_PATH = '/chat';
/** The logo, below the page. */
const LOGO_PATH = `${CHAT_PAGE_PATH}/logo`;
/** The largest logo served. */
export const LOGO_MAX_BYTES = 512 * 1024;
/** A logo's file types, by extension. */
export const LOGO_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
/** The default starters, at most this many. */
const DEFAULT_STARTERS_MAX = 6;
const SERVES = ['off', 'local', 'public'] as const;

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
/** A value written into the page's script: JSON, with nothing that could end the script element. */
const inlineJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const HEX = /^#[0-9a-fA-F]{6}$/;

/** "book a detail" -> "Book a detail". */
const capitalized = (words: string): string => (words === '' ? words : words[0]!.toUpperCase() + words.slice(1));

/** The app's ways to start by default: the labels of its forms and of its informational intents that say something, at most six. */
export function defaultStarters(app: App): string[] {
  return Object.values(app.intents)
    .filter((i) => i.kind === 'form' || (i.kind === 'informational' && (i.promptId !== undefined || i.passage !== undefined)))
    .map((i) => capitalized(i.label.trim()))
    .filter((w) => w !== '' && w.length <= 60)
    .slice(0, DEFAULT_STARTERS_MAX);
}

/** A number to call, from E.164 (+15555550123): its tel: link and how it is shown, "(555) 555-0123" for a North American one; null for anything else. */
export function phoneOf(e164: string | undefined): { tel: string; shown: string } | null {
  const v = e164?.trim() ?? '';
  if (!/^\+\d{8,15}$/.test(v)) return null;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v);
  return { tel: v, shown: nanp === null ? v : `(${nanp[1]}) ${nanp[2]}-${nanp[3]}` };
}

/** A run of the chat formatting as HTML, its words escaped. */
function runHtml(r: ChatInline): string {
  if ('break' in r) return '<br>';
  let out = escapeHtml(r.text);
  if (r.italic === true) out = `<em>${out}</em>`;
  if (r.bold === true) out = `<strong>${out}</strong>`;
  return out;
}

/** The chat formatting's blocks as HTML: paragraphs and lists, every word escaped. */
export function blocksHtml(blocks: readonly ChatBlock[]): string {
  return blocks
    .map((b) => (b.type === 'paragraph' ? `<p>${b.content.map(runHtml).join('')}</p>` : `<${b.ordered ? 'ol' : 'ul'}>${b.items.map((item) => `<li>${item.map(runHtml).join('')}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`))
    .join('');
}

/** What the page is made of. */
export interface ChatPageContent {
  name: string;
  tagline?: string;
  /** The logo's address (`/<app id>/chat/logo`), or null for the name alone. */
  logo: string | null;
  colors: { accent?: string; background?: string; text?: string };
  /** The intro, in the chat formatting. */
  intro?: string;
  /** Sections under the conversation, each a heading and its text in the chat formatting. */
  about?: readonly { readonly title: string; readonly text: string }[];
  starters: readonly string[];
  phone: { tel: string; shown: string } | null;
  /** The chat's endpoint path (`/chat`, or `/chat/<app id>` on a host). */
  chatPath: string;
  /** The page's language (the app's default locale). */
  lang: string;
}

/** The page's HTML. */
export function chatPageHtml(c: ChatPageContent): string {
  const name = escapeHtml(c.name);
  const color = (v: string | undefined): string | null => (v !== undefined && HEX.test(v) ? v : null);
  const accent = color(c.colors.accent);
  const background = color(c.colors.background);
  const text = color(c.colors.text);
  // The brand's colours where it gives them; the visitor's light or dark scheme for those it does not.
  const own = [accent ? `--accent: ${accent};` : '', background ? `--page-bg: ${background};` : '', text ? `--page-fg: ${text};` : ''].join(' ');
  const intro = c.intro === undefined ? '' : `<div class="intro">${blocksHtml(chatLine(c.intro, {}).blocks)}</div>`;
  const about = c.about === undefined || c.about.length === 0
    ? ''
    : `<section class="about">${c.about.map((s) => `<div class="about-part"><h2>${escapeHtml(s.title)}</h2>${blocksHtml(chatLine(s.text, {}).blocks)}</div>`).join('')}</section>`;
  const call = c.phone === null ? '' : `<a class="call" href="tel:${escapeHtml(c.phone.tel)}"><span>Prefer to talk?</span> ${escapeHtml(c.phone.shown)}</a>`;
  return `<!doctype html>
<html lang="${escapeHtml(c.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { --accent: #2f5bd3; --page-bg: #f5f6f8; --page-fg: #1d1d1f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --page-bg: #111317; --page-fg: #eef0f3; } }
  :root { ${own} }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--page-bg); color: var(--page-fg); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { text-align: center; padding: clamp(28px, 6vw, 56px) 16px 20px; }
  .logo { display: block; margin: 0 auto 14px; max-height: 96px; max-width: min(320px, 70vw); }
  h1 { margin: 0; font-size: clamp(1.8rem, 6vw, 2.8rem); letter-spacing: .02em; }
  .logo + h1 { font-size: clamp(1.3rem, 4vw, 1.8rem); }
  .tagline { margin: 6px 0 0; font-size: 1.1rem; color: color-mix(in srgb, var(--page-fg) 70%, var(--page-bg)); }
  .intro { max-width: 640px; margin: 14px auto 0; font-size: 1.05rem; line-height: 1.5; }
  .intro p { margin: 0.4em 0; }
  .intro ul, .intro ol { text-align: left; display: inline-block; margin: 0.4em 0; }
  main { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  dialogwright-conversation {
    --dw-accent: var(--accent);
    --dw-bg: color-mix(in srgb, var(--page-fg) 5%, var(--page-bg));
    --dw-fg: var(--page-fg);
    --dw-muted: color-mix(in srgb, var(--page-fg) 62%, var(--page-bg));
    --dw-user-bg: color-mix(in srgb, var(--accent) 22%, var(--page-bg));
    --dw-border: color-mix(in srgb, var(--page-fg) 14%, transparent);
  }
  .call { display: block; width: fit-content; margin: 22px auto 0; padding: 10px 18px; border-radius: 999px; border: 1px solid var(--accent); color: var(--page-fg); text-decoration: none; font-weight: 600; }
  .call span { font-weight: 400; color: color-mix(in srgb, var(--page-fg) 70%, var(--page-bg)); }
  .about { max-width: 760px; margin: 40px auto 0; padding: 0 16px; line-height: 1.55; }
  .about-part { padding: 18px 0; border-top: 1px solid color-mix(in srgb, var(--page-fg) 14%, transparent); }
  .about h2 { margin: 0 0 6px; font-size: 1.15rem; }
  .about p { margin: 0.5em 0; }
  .about ul, .about ol { margin: 0.5em 0; padding-left: 1.3em; }
  .about li { margin: 0.3em 0; }
  .about li::marker { color: var(--accent); }
  footer { text-align: center; padding: 40px 16px; font-size: .85rem; color: color-mix(in srgb, var(--page-fg) 60%, var(--page-bg)); }
</style>
</head>
<body>
<header>
  ${c.logo === null ? '' : `<img class="logo" src="${escapeHtml(c.logo)}" alt="">`}
  <h1>${name}</h1>
  ${c.tagline === undefined ? '' : `<p class="tagline">${escapeHtml(c.tagline)}</p>`}
  ${intro}
</header>
<main id="talk"></main>
${call}
${about}
<footer>${name}</footer>
<script src="/widget.js"></script>
<script>
  DialogWright.mountConversation('#talk', { endpoint: ${inlineJson(c.chatPath)}, starters: ${inlineJson(c.starters)} });
</script>
</body>
</html>
`;
}

/** What the page is built with: the app, where its chat is, its own settings, and whether the server serves a chat and the widget's script. */
export interface ChatPageDeps {
  app: App;
  /** Where the app's pages are mounted, `/<app id>`. */
  base: string;
  chatPath: string;
  env(name: string): string | undefined;
  /** CHAT=on. */
  chat: boolean;
  /** WIDGET=on: the page's script, /widget.js. */
  widget: boolean;
}

/** The headers every answer of the page carries. */
const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
};

/**
 * The app's chat page as a route (under its base), or none: off unless app.yaml's chat.page says local or
 * public (or the app's CHAT_PAGE setting does), and only with CHAT=on and WIDGET=on, each said as a
 * warning where it stops the page.
 */
export function chatPageRoutes(deps: ChatPageDeps): AppRoutes {
  const { app } = deps;
  const page = app.chat?.page;
  const warnings: string[] = [];
  const setting = deps.env('CHAT_PAGE')?.trim().toLowerCase();
  let serve: (typeof SERVES)[number] = page?.serve ?? 'off';
  if (setting !== undefined && setting !== '') {
    if ((SERVES as readonly string[]).includes(setting)) serve = setting as (typeof SERVES)[number];
    else warnings.push(`CHAT_PAGE is "${setting}", which is none of off, local and public: app.yaml's chat.page.serve (${serve}) is used`);
  }
  if (serve === 'off') return { routes: [], warnings };
  if (!deps.chat) return { routes: [], warnings: [...warnings, 'chat page: off, as CHAT is off (the page is a chat)'] };
  if (!deps.widget) return { routes: [], warnings: [...warnings, 'chat page: off, as WIDGET is off (the page loads /widget.js; set WIDGET=on and WIDGET_FILE)'] };
  // The logo, read once: a file of a type the page shows, at most LOGO_MAX_BYTES.
  let logo: { body: Buffer; type: string } | null = null;
  const file = app.brand?.logo;
  if (file !== undefined) {
    const type = LOGO_TYPES[extname(file).toLowerCase()];
    if (type === undefined || !existsSync(file) || !statSync(file).isFile()) warnings.push(`chat page: the logo ${file} is not a .png, .jpg, .webp or .svg file; the page shows the name alone`);
    else if (statSync(file).size > LOGO_MAX_BYTES) warnings.push(`chat page: the logo ${file} is over ${LOGO_MAX_BYTES / 1024} KB; the page shows the name alone`);
    else logo = { body: readFileSync(file), type };
  }
  const phoneVar = page?.phone;
  const phone = phoneVar === undefined ? null : phoneOf(deps.env(phoneVar));
  if (phoneVar !== undefined && phone === null) warnings.push(`chat page: ${phoneVar} (chat.page.phone) is not an E.164 number; the page shows no number to call`);
  const html = chatPageHtml({
    name: app.brand?.name ?? app.id,
    ...(app.brand?.tagline !== undefined ? { tagline: app.brand.tagline } : {}),
    logo: logo === null ? null : `${deps.base}${LOGO_PATH}`,
    colors: { ...(app.brand?.colors ?? {}) },
    ...(page?.intro !== undefined ? { intro: page.intro } : {}),
    ...(page?.about !== undefined ? { about: page.about } : {}),
    starters: page?.starters ?? defaultStarters(app),
    phone,
    chatPath: deps.chatPath,
    lang: app.locales?.default ?? 'en',
  });
  const route: AppRoute = {
    label: 'chat page',
    path: CHAT_PAGE_PATH,
    localOnly: serve === 'local',
    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      const reading = req.method === 'GET' || req.method === 'HEAD';
      if (path === CHAT_PAGE_PATH || path === `${CHAT_PAGE_PATH}/`) {
        if (!reading) {
          res.writeHead(405, { allow: 'GET, HEAD' }).end();
          return true;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : html);
        return true;
      }
      if (path === LOGO_PATH && logo !== null) {
        if (!reading) {
          res.writeHead(405, { allow: 'GET, HEAD' }).end();
          return true;
        }
        // An SVG opened on its own runs no script: sandboxed, nothing loaded.
        res.writeHead(200, { 'content-type': logo.type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        res.end(req.method === 'HEAD' ? undefined : logo.body);
        return true;
      }
      return false;
    },
  };
  return { routes: [route], warnings };
}

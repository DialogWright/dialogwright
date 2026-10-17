import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AppPageDeps, AppPagesFactory, AppRoute, AppRoutes, DelegateListing, SubjectListing } from 'dialogwright';
import { AGENT_OF_RECORD, memberOf } from './data';

/**
 * Harbor Mutual's demo portal: a stand-in for the website a member or a broker signs in to, and for
 * its identity provider, so the web chat can be tried signed in on a server. It lists Harbor's
 * fictional members and brokers (the app's `portal` config), signs the visitor in as whichever is
 * chosen with no password, and gives the chat page a short-lived token signed with a key made when the
 * server starts, whose public half it publishes as a JWKS for the engine's chat to verify
 * (CHAT_SIGNIN=jwt). Because it signs anyone in as anyone, it exists only when HARBOR_DEMO_PORTAL=on,
 * and only ever over Harbor's invented people. A real deployment's site and identity provider do this
 * part with passwords and a second factor.
 *
 * Its paths, under the app's base (`/harbor` on any server that runs Harbor):
 *   GET  /portal             the sign-in page: every member and broker, each a button
 *   POST /portal/sign-in     person=member:<id> | broker:<id>: a session cookie, then the chat page
 *   GET  /portal/chat        the member's or the broker's page, with the engine's widget signed in
 *   POST /portal/token       the signed-in person's token, for the widget's getToken
 *   POST /portal/sign-out    ends the session
 *   GET  /portal/jwks.json   the public key the tokens are verified with
 *   GET  /portal/assets/...  the logo and the emblem
 */

/** The setting that turns the portal on (`on`); anything else, or unset, leaves every portal path a 404. */
export const PORTAL_SWITCH = 'HARBOR_DEMO_PORTAL';
/** The `iss` of every token the portal signs: the server's CHAT_ISSUER. */
export const PORTAL_ISSUER = 'harbor-demo-portal';
/** The `aud` of every token the portal signs: the server's CHAT_AUDIENCE. */
export const PORTAL_AUDIENCE = 'harbor-chat';
/** How long a token, and a sign-in, lasts: an hour. */
export const TOKEN_TTL_SEC = 3600;
/** The portal's own paths, below the app's base. */
export const PORTAL_PATH = '/portal';
export const JWKS_PATH = `${PORTAL_PATH}/jwks.json`;

const COOKIE = 'harbor_portal';
/** Sign-ins held at once; past it the oldest goes. Enough for a demo, and a bound on memory. */
const MAX_SESSIONS = 5000;
const MAX_FORM_BYTES = 2048;
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));
const ASSETS: Readonly<Record<string, string>> = {
  'harbor-mutual-logo-horizontal.png': 'image/png',
  'harbor-mutual-emblem.svg': 'image/svg+xml',
};

/** Who a sign-in is: a member by member ID, or a broker by their portal id. */
export type PortalPerson = { kind: 'member'; id: string } | { kind: 'broker'; id: string };

/** The portal's signing key: the private half for signing, the public half as a JWK with its key id. */
export interface PortalKey {
  readonly privateKey: KeyObject;
  readonly jwk: Readonly<{ kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' }>;
}

/** A new Ed25519 key, its id the RFC 7638 thumbprint of its public half. Kept in memory only, never logged. */
export function portalKey(): PortalKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const kid = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
  return { privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' } };
}

/** The JWKS document: the one public key. */
export function jwksOf(key: PortalKey): { keys: PortalKey['jwk'][] } {
  return { keys: [key.jwk] };
}

/**
 * The claims of a token for `person`: `sub` the member ID for a member; for a broker, `broker_id` (what
 * the app's principals.fromClaims reads), with their role and office id as the broker portal states them
 * (the principal itself is read from Harbor's records by `broker_id`). Null for anyone not listed.
 */
export function claimsFor(person: PortalPerson, listings: Listings, nowSec: number): Record<string, unknown> | null {
  const times = { iss: PORTAL_ISSUER, aud: PORTAL_AUDIENCE, iat: nowSec, exp: nowSec + TOKEN_TTL_SEC };
  if (person.kind === 'member') {
    return listings.members.some((m) => m.id === person.id) ? { ...times, sub: person.id } : null;
  }
  const b = listings.brokers.find((d) => d.id === person.id);
  if (b === undefined) return null;
  return { ...times, sub: `broker:${b.id}`, broker_id: b.id, role: b.role, office_id: b.attrs?.officeId ?? '' };
}

/** A compact JWS (EdDSA) of `claims`, signed with the portal's key. */
export function signToken(claims: Readonly<Record<string, unknown>>, key: PortalKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key.privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The people the portal lists: the app's portal config. */
export interface Listings {
  readonly members: readonly SubjectListing[];
  readonly brokers: readonly DelegateListing[];
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A person's id from the sign-in form: `member:<id>` or `broker:<id>`, else null. */
export function personOf(raw: string | null): PortalPerson | null {
  const m = /^(member|broker):([A-Za-z0-9_-]{1,64})$/.exec(raw ?? '');
  return m ? { kind: m[1] as PortalPerson['kind'], id: m[2]! } : null;
}

/** "4271 6358": a member ID as the pages show it. */
const spaced = (id: string): string => id.replace(/^(\d{4})(\d{4})$/, '$1 $2');

/** The colours and type every portal page shares: Harbor Mutual's navy, sea blue, gold and cream. */
const STYLE = `
  :root { --navy:#0f2440; --navy-2:#163257; --sea:#2c56a6; --gold:#c9a85f; --cream:#f7f2e7; --ink:#1c2533; --muted:#5d6878; --line:#e3ddd0; --card:#fff; }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--cream); color:var(--ink); }
  body { font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
  header.site { background:var(--navy); color:#f1e6cc; }
  .bar { max-width:1080px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
  .bar img { height:44px; display:block; }
  .bar .who { margin-left:auto; font-size:.95em; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .bar .who small { opacity:.75; }
  .bar button { font:inherit; color:var(--navy); background:var(--gold); border:0; border-radius:999px; padding:7px 16px; cursor:pointer; font-weight:600; }
  .hero { background:linear-gradient(160deg, var(--navy-2) 0%, var(--sea) 75%, #3f6fc9 100%); color:#fff; }
  .hero .inner { max-width:1080px; margin:0 auto; padding:52px 16px 72px; }
  .hero h1 { font-family:Baskerville, "Hoefler Text", Georgia, serif; font-weight:600; font-size:2.3em; line-height:1.15; margin:0 0 12px; max-width:640px; }
  .hero p { font-size:1.1em; max-width:580px; margin:0; opacity:.92; }
  main { max-width:1080px; margin:-40px auto 0; padding:0 16px 64px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 22px 22px; box-shadow:0 6px 24px rgba(15,36,64,.08); }
  .card h2 { font-size:1.08em; margin:0 0 6px; color:var(--navy); }
  .card p { margin:0 0 6px; color:var(--muted); font-size:.95em; }
  .demo { display:inline-block; font-size:.72em; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#8a5a00; background:#fdf1d6; border-radius:999px; padding:3px 10px; margin-bottom:8px; }
  form.who-list button { display:block; width:100%; text-align:left; font:inherit; color:var(--ink); background:#fbfaf7; border:1px solid var(--line); border-radius:10px; padding:11px 14px; margin:8px 0 0; cursor:pointer; }
  form.who-list button:hover, form.who-list button:focus-visible { border-color:var(--sea); }
  form.who-list button span { color:var(--muted); font-size:.9em; }
  ul.clients { margin:6px 0 0; padding-left:20px; color:var(--ink); }
  #handoff { border-left:4px solid var(--gold); }
  #inline-chat { min-height:520px; }
  footer { border-top:1px solid var(--line); color:var(--muted); font-size:.85em; }
  footer .inner { max-width:1080px; margin:0 auto; padding:20px 16px 96px; }
  dialogwright-chat { --dw-accent:#163257; --dw-accent-fg:#fff; --dw-bg:#fff; --dw-fg:#1c2533; --dw-agent-bg:#f1efe9; --dw-user-bg:#e3e9f5; --dw-radius:14px; --dw-font:system-ui, -apple-system, "Segoe UI", sans-serif; }
  [hidden] { display:none !important; }
`;

const NOTICE = 'Harbor Mutual is a fictional insurer, built to demonstrate DialogWright. Every member, broker, claim and number here is made up. This demo portal signs anyone in as any of these invented people with no password, which is why it is off unless the server sets HARBOR_DEMO_PORTAL=on.';

function page(o: { title: string; base: string; header: string; body: string; script?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(o.title)}</title>
  <link rel="icon" href="${o.base}${PORTAL_PATH}/assets/harbor-mutual-emblem.svg">
  <style>${STYLE}</style>
</head>
<body>
  <header class="site"><div class="bar">
    <img src="${o.base}${PORTAL_PATH}/assets/harbor-mutual-logo-horizontal.png" alt="Harbor Mutual, Accident &amp; Health">
    ${o.header}
  </div></header>
${o.body}
  <footer><div class="inner">${escapeHtml(NOTICE)}</div></footer>
${o.script ?? ''}</body>
</html>
`;
}

/** The sign-in page: each member and each broker (name; a broker's office and role), a button each. */
export function signInPage(base: string, listings: Listings, roleLabel: (role: string) => string): string {
  const members = listings.members.map((m) =>
    `<button name="person" value="member:${escapeHtml(m.id)}">${escapeHtml(`${m.first} ${m.last}`)} <span>· member ID ${escapeHtml(spaced(m.id))}</span></button>`).join('\n          ');
  const brokers = listings.brokers.map((b) =>
    `<button name="person" value="broker:${escapeHtml(b.id)}">${escapeHtml(b.name)} <span>· ${escapeHtml(roleLabel(b.role))}, ${escapeHtml(b.attrs?.office ?? '')}</span></button>`).join('\n          ');
  return page({
    title: 'Harbor Mutual: sign in',
    base,
    header: '',
    body: `  <section class="hero"><div class="inner">
    <h1>Sign in to chat with Harbor Mutual.</h1>
    <p>Members check on a claim, ask what their plan covers or report a new one. Brokers do the same for their office's clients.</p>
  </div></section>
  <main>
    <div class="cards">
      <div class="card">
        <span class="demo">Demo sign-in</span>
        <h2>Member portal</h2>
        <p>Signed in as a member, the chat knows who you are: no member ID, date of birth or code to give.</p>
        <form class="who-list" method="post" action="${base}${PORTAL_PATH}/sign-in">
          ${members}
        </form>
      </div>
      <div class="card">
        <span class="demo">Demo sign-in</span>
        <h2>Broker portal</h2>
        <p>Signed in as a broker, the chat serves the members your office is agent of record for, as your role allows.</p>
        <form class="who-list" method="post" action="${base}${PORTAL_PATH}/sign-in">
          ${brokers}
        </form>
      </div>
      <div class="card">
        <h2>About this page</h2>
        <p>A stand-in for a real site and its identity provider, which would ask for a password and a one-time code. It signs you in at once, as whoever you choose, and hands the chat a token that lasts an hour.</p>
      </div>
    </div>
  </main>`,
  });
}

/** What the chat page's script needs: where the chat is, and where its token comes from. */
interface ChatWiring {
  readonly base: string;
  /** The app's chat path (`/chat`, or `/chat/<app id>` on a host). */
  readonly chatPath: string;
  readonly appId: string;
}

/** The widget, mounted on Harbor's chat, signed in with the portal's token for the person signed in. */
function widgetScript(w: ChatWiring, inline: boolean): string {
  // On a host the widget names its app (`app`); alone, the server's one chat is the app's.
  const app = w.chatPath === '/chat' ? '' : `\n        app: ${JSON.stringify(w.appId)},`;
  return `  <script src="/widget.js"></script>
  <script>
    (function () {
      var endpoint = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/chat';
      if (!window.DialogWright) { document.getElementById('no-widget').hidden = false; return; }
      window.DialogWright.mount({
        endpoint: endpoint,${app}
        title: 'Harbor Mutual',
        ${inline ? "position: 'inline',\n        container: '#inline-chat'," : 'startOpen: true,'}
        getToken: async function () {
          var res = await fetch(${JSON.stringify(`${w.base}${PORTAL_PATH}/token`)}, { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) { location.href = ${JSON.stringify(`${w.base}${PORTAL_PATH}`)}; return null; }
          return (await res.json()).token;
        },
        onTransfer: function () { document.getElementById('handoff').hidden = false; },
      });
    })();
  </script>
`;
}

function signedInHeader(base: string, name: string, detail: string): string {
  return `<div class="who"><span>${escapeHtml(name)} <small>${escapeHtml(detail)}</small></span>
      <form method="post" action="${base}${PORTAL_PATH}/sign-out"><button>Sign out</button></form></div>`;
}

const HANDOFF = `<div class="card" id="handoff" hidden>
        <h2>A person will take it from here.</h2>
        <p>This is where the site would open a live chat with a Harbor Mutual specialist. In this demo, call 555-0100.</p>
      </div>`;

const NO_WIDGET = `<div class="card" id="no-widget" hidden>
        <h2>The chat is not served here</h2>
        <p>This server does not serve the chat widget: it needs WIDGET=on (and the widget built). See Harbor's README.</p>
      </div>`;

/** A member's page: their plan, what they can do, and the chat open in the corner, signed in as them. */
export function memberPage(w: ChatWiring, member: SubjectListing): string {
  const plan = memberOf(member.id)?.plan === 'advantage_plus' ? 'Accident Advantage Plus' : 'Accident Advantage';
  return page({
    title: 'Harbor Mutual: your account',
    base: w.base,
    header: signedInHeader(w.base, `${member.first} ${member.last}`, `member ID ${spaced(member.id)}`),
    body: `  <section class="hero"><div class="inner">
    <h1>Welcome back, ${escapeHtml(member.first)}.</h1>
    <p>Your plan: ${escapeHtml(plan)}. You are signed in, so the chat already knows it is you.</p>
  </div></section>
  <main>
    <div class="cards">
      <div class="card"><h2>Check on a claim</h2><p>Ask where a claim stands and what happens next.</p></div>
      <div class="card"><h2>Know what's covered</h2><p>Ask what your plan pays for, and how much of it you've used this year.</p></div>
      <div class="card"><h2>Report a new claim</h2><p>Tell us what happened, and we'll take it from there.</p></div>
      ${HANDOFF}
      ${NO_WIDGET}
    </div>
  </main>`,
    script: widgetScript(w, false),
  });
}

/** A broker's page: who they are, their office's clients, and the chat on the page, signed in as them. */
export function brokerPage(w: ChatWiring, broker: DelegateListing, roleLabel: (role: string) => string): string {
  const clients = (AGENT_OF_RECORD[broker.attrs?.officeId ?? ''] ?? []).flatMap((id) => {
    const m = memberOf(id);
    return m ? [`<li>${escapeHtml(`${m.first} ${m.last}`)}, member ID ${escapeHtml(spaced(m.id))}</li>`] : [];
  });
  const role = roleLabel(broker.role);
  const can = broker.role === 'service_rep'
    ? 'As a service rep you may check a client\'s claim and ask what their plan covers; filing a claim is for an office administrator.'
    : 'As an office administrator you may check a client\'s claim, ask what their plan covers, and report a claim, which goes to a claims specialist.';
  return page({
    title: 'Harbor Mutual: broker portal',
    base: w.base,
    header: signedInHeader(w.base, broker.name, `${role}, ${broker.attrs?.office ?? ''}`),
    body: `  <section class="hero"><div class="inner">
    <h1>Broker portal</h1>
    <p>${escapeHtml(can)} A claim's diagnosis and the member's own statement are never shown to a broker.</p>
  </div></section>
  <main>
    <div class="cards">
      <div class="card">
        <h2>Your office's clients</h2>
        <p>${escapeHtml(broker.attrs?.office ?? '')} is agent of record for:</p>
        <ul class="clients">${clients.join('')}</ul>
      </div>
      ${HANDOFF}
      ${NO_WIDGET}
      <div class="card" id="inline-chat"></div>
    </div>
  </main>`,
    script: widgetScript(w, true),
  });
}

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(303, { location, 'content-length': 0, 'cache-control': 'no-store', ...headers });
  res.end();
}

/** A small form body, read no further than `max` bytes; null for one larger. */
async function formOf(req: IncomingMessage, max: number): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function cookieOf(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** Whether the request reached the server over https (directly, or through a tunnel that says so). */
function overHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https' || (req.socket as { encrypted?: boolean }).encrypted === true;
}

/** What the portal says as the server starts, beside its being on: each setting the chat sign-in needs that is not as the portal signs. */
export function setupWarnings(deps: Pick<AppPageDeps, 'config' | 'chat' | 'base'>): string[] {
  const jwksUrl = `https://${deps.config.publicHost}${deps.base}${JWKS_PATH}`;
  const out = [`demo portal ON (${PORTAL_SWITCH}=on) at ${deps.base}${PORTAL_PATH}: anyone who reaches it can sign in as any of Harbor Mutual's fictional members and brokers`];
  const needs = `CHAT_SIGNIN=jwt, CHAT_ISSUER=${PORTAL_ISSUER}, CHAT_AUDIENCE=${PORTAL_AUDIENCE}, CHAT_JWKS_URL=${jwksUrl}`;
  if (deps.chat === undefined) out.push(`demo portal: CHAT is off, so its pages have no chat to open: set CHAT=on, with ${needs}`);
  else if (deps.chat.signIn.method !== 'jwt') out.push(`demo portal: CHAT_SIGNIN is ${deps.chat.signIn.method}, so its tokens are refused: set ${needs}`);
  else {
    const s = deps.chat.signIn;
    if (s.issuer !== PORTAL_ISSUER) out.push(`demo portal: CHAT_ISSUER is not ${PORTAL_ISSUER}, the issuer its tokens name, so they are refused`);
    if (s.audience !== PORTAL_AUDIENCE) out.push(`demo portal: CHAT_AUDIENCE is not ${PORTAL_AUDIENCE}, the audience its tokens name, so they are refused`);
    if (s.jwksUrl !== jwksUrl) out.push(`demo portal: CHAT_JWKS_URL is not ${jwksUrl}, where its keys are published, so its tokens are refused unless that URL serves them`);
  }
  if (deps.config.widget === undefined) out.push('demo portal: WIDGET is off, so its chat pages cannot load /widget.js: set WIDGET=on (and build the widget)');
  return out;
}

/** One sign-in: who, and until when (ms). */
interface PortalSession {
  readonly person: PortalPerson;
  readonly until: number;
}

/**
 * The portal's route, under `base`: built with its own key, which lasts as long as the server.
 * `now` is the server's clock (ms).
 */
export function portalRoute(deps: Pick<AppPageDeps, 'app' | 'base' | 'chatPath' | 'now'>, key: PortalKey = portalKey()): AppRoute {
  const { base, now } = deps;
  const portal = deps.app.portal;
  const listings: Listings = { members: portal?.subjects?.() ?? [], brokers: portal?.delegates?.() ?? [] };
  const roleLabel = portal?.roleLabel ?? ((r: string) => r);
  const wiring: ChatWiring = { base, chatPath: deps.chatPath, appId: deps.app.id };
  const sessions = new Map<string, PortalSession>();
  const assets = new Map(Object.entries(ASSETS).map(([name, type]) => [name, { type, body: readFileSync(`${ASSETS_DIR}${name}`) }]));
  const sessionOf = (req: IncomingMessage): PortalSession | null => {
    const id = cookieOf(req);
    const s = id === null ? undefined : sessions.get(id);
    if (s === undefined) return null;
    if (s.until <= now()) {
      sessions.delete(id!);
      return null;
    }
    return s;
  };
  const cookie = (req: IncomingMessage, value: string, maxAge: number): string =>
    `${COOKIE}=${value}; Path=${base}${PORTAL_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${overHttps(req) ? '; Secure' : ''}`;

  return {
    label: 'Harbor Mutual demo portal',
    path: PORTAL_PATH,
    // A site's pages are for the internet: served through the tunnel, as the chat is.
    localOnly: false,
    sweep() {
      const t = now();
      for (const [id, s] of sessions) if (s.until <= t) sessions.delete(id);
    },
    async handle(req, res, path) {
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (path === PORTAL_PATH && get) {
        send(req, res, 200, 'text/html; charset=utf-8', signInPage(base, listings, roleLabel));
        return true;
      }
      if (path === JWKS_PATH && get) {
        send(req, res, 200, 'application/json', JSON.stringify(jwksOf(key)), { 'cache-control': 'public, max-age=300' });
        return true;
      }
      if (path.startsWith(`${PORTAL_PATH}/assets/`) && get) {
        const asset = assets.get(path.slice(`${PORTAL_PATH}/assets/`.length));
        if (asset === undefined) return false;
        send(req, res, 200, asset.type, asset.body, { 'cache-control': 'public, max-age=3600' });
        return true;
      }
      if (path === `${PORTAL_PATH}/sign-in` && req.method === 'POST') {
        const form = await formOf(req, MAX_FORM_BYTES);
        const person = personOf(form?.get('person') ?? null);
        if (person === null || claimsFor(person, listings, 0) === null) {
          send(req, res, 400, 'text/plain; charset=utf-8', 'No such person in this demo. Go back and choose one from the list.');
          return true;
        }
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { person, until: now() + TOKEN_TTL_SEC * 1000 });
        redirect(res, `${base}${PORTAL_PATH}/chat`, { 'set-cookie': cookie(req, id, TOKEN_TTL_SEC) });
        return true;
      }
      if (path === `${PORTAL_PATH}/sign-out` && req.method === 'POST') {
        const id = cookieOf(req);
        if (id !== null) sessions.delete(id);
        redirect(res, `${base}${PORTAL_PATH}`, { 'set-cookie': cookie(req, '', 0) });
        return true;
      }
      if (path === `${PORTAL_PATH}/chat` && get) {
        const s = sessionOf(req);
        const member = s?.person.kind === 'member' ? listings.members.find((m) => m.id === s.person.id) : undefined;
        const broker = s?.person.kind === 'broker' ? listings.brokers.find((b) => b.id === s.person.id) : undefined;
        if (member) send(req, res, 200, 'text/html; charset=utf-8', memberPage(wiring, member));
        else if (broker) send(req, res, 200, 'text/html; charset=utf-8', brokerPage(wiring, broker, roleLabel));
        else redirect(res, `${base}${PORTAL_PATH}`);
        return true;
      }
      if (path === `${PORTAL_PATH}/token` && req.method === 'POST') {
        const s = sessionOf(req);
        const claims = s === null ? null : claimsFor(s.person, listings, Math.floor(now() / 1000));
        if (claims === null) send(req, res, 401, 'application/json', JSON.stringify({ error: 'not signed in' }));
        else send(req, res, 200, 'application/json', JSON.stringify({ token: signToken(claims, key) }));
        return true;
      }
      return false;
    },
  };
}

/**
 * Harbor's pages (App.pages): the demo portal when the app's settings say HARBOR_DEMO_PORTAL=on, with a
 * loud line that it is on and one for each chat setting it needs that is not set as it signs; otherwise
 * none, so every path under /harbor/portal is a 404.
 */
export const portalPages: AppPagesFactory = (deps: AppPageDeps): AppRoutes => {
  if (deps.env(PORTAL_SWITCH)?.trim().toLowerCase() !== 'on') return { routes: [] };
  return { routes: [portalRoute(deps)], warnings: setupWarnings(deps) };
};

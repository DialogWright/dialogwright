import { createChatClient, type ChatClient, type ChatClientEvent, type ChatClientOptions, type ConnectionState } from './client';
import { CHAT_TEXT_MAX, isLocaleTag } from './protocol';
import { stringsOf, type StringKey, type WidgetStrings } from './strings';
import { STYLES } from './styles';

export const POSITIONS = ['bottom-right', 'bottom-left', 'inline'] as const;
export type Position = (typeof POSITIONS)[number];

/** What a site sets: as options to `DialogWright.mount`, or as `data-*` attributes on the script tag. Only `endpoint` is required. */
export interface WidgetOptions {
  /** The chat endpoint, `wss://host/chat`. */
  endpoint: string;
  /** The language to ask for. Default: the page's `<html lang>`, else none (the app's default). */
  locale?: string;
  /** The panel's heading. Default: strings.title. */
  title?: string;
  /** Any of the widget's words (strings.ts), replacing the English defaults. */
  strings?: Partial<Record<StringKey, string>>;
  /** `bottom-right` (default), `bottom-left`, or `inline` (inside `container`, always open). */
  position?: Position;
  /** A CSS selector for where an inline widget goes. */
  container?: string;
  /** Open the panel (and connect) on load. Default false: the widget connects when it is first opened. */
  startOpen?: boolean;
  /** The site's sign-in token, or null; with it, the panel offers sign-in. */
  getToken?: () => Promise<string | null>;
  /** What a transfer does on this site (open a live chat, show a number). Default: the panel says strings.transferred. */
  onTransfer?: (reason: string) => void;
  /** Delays between reconnect attempts, in ms (the client's backoffMs). */
  backoffMs?: readonly number[];
  /** Reconnects in a row a dropped chat may try before the widget says it is unavailable (the client's maxReconnects). Default: no limit. */
  maxReconnects?: number;
  /**
   * Every event the chat client reports (client.ts ChatClientEvent), after the panel has shown it: for
   * a site that does more on a restart, a sign-in or the end (say, a notice of its own on `restarted`).
   */
  onEvent?: (e: ChatClientEvent) => void;
}

export interface WidgetDeps {
  createClient: (o: ChatClientOptions) => ChatClient;
}

export interface Widget {
  /** The element the widget lives in (`dialogwright-chat`); its shadow root holds the panel. Theme it with --dw-* custom properties. */
  host: HTMLElement;
  open(): void;
  close(): void;
  /** Close the chat and remove the widget from the page. */
  destroy(): void;
}

const warn = (m: string): void => console.warn(m);

/** A position the widget has, or the default with a warning. */
export function positionOf(value: string | undefined): Position | undefined {
  if (value === undefined) return undefined;
  if ((POSITIONS as readonly string[]).includes(value)) return value as Position;
  warn(`DialogWright widget: position "${value}" is not one of ${POSITIONS.join(', ')}; using bottom-right`);
  return undefined;
}

/**
 * The endpoint as a socket URL: ws: or wss: as given; an http(s) or relative one (`/chat`) is read
 * against the page and given the socket scheme. Anything else cannot be a chat endpoint.
 */
export function endpointOf(raw: string): string {
  let url: URL | null;
  try {
    url = new URL(raw.trim(), document.baseURI);
  } catch {
    url = null;
  }
  if (url !== null && (url.protocol === 'http:' || url.protocol === 'https:')) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url === null || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
    throw new Error(`DialogWright widget: endpoint must be the chat's URL, like wss://chat.example.com/chat; got "${raw}"`);
  }
  return url.href;
}

/** The language to ask for, if it is a language tag; otherwise none (the app's default), with a warning. */
function localeOf(value: string | undefined, from: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (isLocaleTag(value.trim())) return value.trim();
  warn(`DialogWright widget: ${from} "${value}" is not a language tag like es or en-US; asking for none`);
  return undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  // Text only, ever: nothing the widget shows is parsed as markup.
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The notice for a refusal, in the site's words (the server's own message is never shown), or none. */
function noticeFor(code: string, state: ConnectionState | null): StringKey | null {
  // A start refused as busy: the client tries again, and the status line says how that goes.
  if (code === 'busy') return state === 'open' ? 'wait' : null;
  if (code === 'too_long') return 'tooLong';
  if (code === 'sign_in_failed') return 'signInFailed';
  return 'error';
}

/**
 * Mounts the chat panel on the page. The DOM is built with createElement and every line goes in as
 * text, so nothing the server says can become markup.
 */
export function mountWidget(options: WidgetOptions, deps: WidgetDeps = { createClient: createChatClient }): Widget {
  if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
    throw new Error('DialogWright widget: endpoint is required (data-endpoint, or mount({ endpoint }))');
  }
  const endpoint = endpointOf(options.endpoint);
  const position: Position = positionOf(options.position) ?? 'bottom-right';
  const inline = position === 'inline';
  let parent: Element = document.body;
  if (inline) {
    if (!options.container) throw new Error('DialogWright widget: an inline widget needs a container (data-container, or mount({ container }))');
    let found: Element | null;
    try {
      found = document.querySelector(options.container);
    } catch {
      throw new Error(`DialogWright widget: container ${options.container} is not a CSS selector`);
    }
    if (found === null) throw new Error(`DialogWright widget: container ${options.container} is not on the page`);
    parent = found;
  } else if (options.container) {
    warn(`DialogWright widget: container is for an inline widget; this one is ${position}, so it is not used`);
  }
  const s: WidgetStrings = stringsOf(options.strings, warn);
  const locale = options.locale !== undefined
    ? localeOf(options.locale, 'locale')
    : localeOf(document.documentElement.getAttribute('lang') ?? undefined, 'the page\'s lang');

  const host = el('dialogwright-chat' as 'div', { 'data-position': position });
  const root = host.attachShadow({ mode: 'open' });
  root.appendChild(el('style', {}, STYLES));

  const launcher = inline ? null : el('button', { type: 'button', class: 'launcher', 'aria-expanded': 'false', 'aria-controls': 'dw-panel' }, s.open);
  const panel = el('section', { class: 'panel', id: 'dw-panel', 'aria-labelledby': 'dw-title' });
  const title = el('h2', { id: 'dw-title' }, options.title ?? s.title);
  const log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': s.log });
  const status = el('p', { class: 'status', role: 'status' });
  const form = el('form', { class: 'composer' });
  const label = el('label', { for: 'dw-input', class: 'sr' }, s.message);
  const input = el('textarea', { id: 'dw-input', rows: '1', maxlength: String(CHAT_TEXT_MAX), placeholder: s.placeholder });
  const send = el('button', { type: 'submit', class: 'send' }, s.send);
  const signIn = el('button', { type: 'button', class: 'signin' }, s.signIn);
  signIn.hidden = options.getToken === undefined;
  const close = inline ? null : el('button', { type: 'button', class: 'close', 'aria-label': s.close }, '×');
  form.append(label, input, send);
  // Document order is the tab order: the box, send, sign-in, then close (drawn in the corner by CSS).
  panel.append(title, log, status, form, signIn);
  if (close) panel.append(close);
  if (launcher) root.append(launcher);
  root.append(panel);
  panel.hidden = !inline;

  let client: ChatClient | null = null;
  let state: ConnectionState | null = null;
  let chatLang = locale;
  let over = false;

  const line = (from: 'user' | 'agent' | 'notice', text: string, lang?: string): void => {
    const row = el('div', { class: `row ${from}` });
    if (from !== 'notice') row.append(el('span', { class: 'sr' }, from === 'user' ? s.you : s.agent));
    const p = el('p', { class: 'line', 'data-from': from }, text);
    if (lang) p.setAttribute('lang', lang);
    row.append(p);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  };
  const notice = (k: StringKey): void => line('notice', s[k]);

  /** The chat is over: no more text. Focus on a control being disabled goes to close, so it is not lost to the page. */
  const disable = (): void => {
    const had = root.activeElement === input || root.activeElement === send || root.activeElement === signIn;
    input.disabled = true;
    send.disabled = true;
    signIn.disabled = true;
    if (had) close?.focus();
  };

  const onEvent = (e: ChatClientEvent): void => {
    switch (e.type) {
      case 'ready':
        chatLang = e.locale;
        break;
      case 'say':
        line('agent', e.text, e.lang);
        break;
      case 'restarted':
        notice('restarted');
        // A new chat: signed in only once the server says so.
        signIn.hidden = options.getToken === undefined;
        break;
      case 'signed_in':
        signIn.hidden = true;
        notice('signedIn');
        break;
      case 'transfer':
        if (options.onTransfer) {
          try {
            options.onTransfer(e.reason);
          } catch (err) {
            warn(`DialogWright widget: onTransfer failed: ${String(err)}`);
          }
        } else {
          notice('transferred');
        }
        break;
      case 'end':
        over = true;
        notice('ended');
        disable();
        break;
      case 'error': {
        const k = noticeFor(e.code, state);
        if (k) notice(k);
        break;
      }
      case 'connection':
        state = e.state;
        status.textContent = e.state === 'connecting' ? s.connecting
          : e.state === 'reconnecting' ? s.reconnecting
          : e.state === 'unavailable' ? s.unavailable
          : '';
        if (e.state === 'closed' || e.state === 'unavailable') {
          // Closed without an end (taken over by another tab, say): over all the same.
          if (e.state === 'closed' && !over) notice('ended');
          over = true;
          disable();
        }
        break;
    }
    if (options.onEvent) {
      try {
        options.onEvent(e);
      } catch (err) {
        warn(`DialogWright widget: onEvent failed: ${String(err)}`);
      }
    }
  };

  const connect = (): void => {
    if (client !== null) return;
    client = deps.createClient({
      endpoint,
      onEvent,
      ...(locale ? { locale } : {}),
      ...(options.getToken ? { getToken: options.getToken } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      ...(options.maxReconnects !== undefined ? { maxReconnects: options.maxReconnects } : {}),
    });
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (text === '' || over || client === null) return;
    line('user', text, chatLang);
    input.value = '';
    void client.send(text);
  };

  /** Opens the panel; focus moves into it only when the person opened it, never on the page's load. */
  const open = (focus = true): void => {
    connect();
    if (inline) return;
    panel.hidden = false;
    launcher?.setAttribute('aria-expanded', 'true');
    if (focus) input.focus();
  };
  const hide = (): void => {
    if (inline) return;
    panel.hidden = true;
    launcher?.setAttribute('aria-expanded', 'false');
    launcher?.focus();
  };

  launcher?.addEventListener('click', () => (panel.hidden ? open() : hide()));
  close?.addEventListener('click', hide);
  signIn.addEventListener('click', () => void client?.signIn());
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  panel.addEventListener('keydown', (ev: KeyboardEvent) => {
    // A key that ends an input method's composition (keyCode 229 where isComposing is not set) is the IME's, not the widget's.
    const composing = ev.isComposing || ev.keyCode === 229;
    if (ev.key === 'Escape' && !composing) {
      hide();
      return;
    }
    if (ev.target === input && ev.key === 'Enter' && !ev.shiftKey && !composing) {
      ev.preventDefault();
      submit();
    }
  });

  parent.appendChild(host);
  if (inline || options.startOpen) open(false);

  return {
    host,
    open: () => open(),
    close: hide,
    destroy() {
      client?.close();
      host.remove();
    },
  };
}

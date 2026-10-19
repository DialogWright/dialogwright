import { createChatClient, type ChatClient, type ChatClientEvent, type ChatClientOptions, type ConnectionState } from './client';
import { renderRich } from './rich';
import { CHAT_TEXT_MAX, contextOf, isLocaleTag } from './protocol';
import { stringsOf, type StringKey, type WidgetStrings } from './strings';
import { CONVERSATION_STYLES } from './conversationStyles';
import { appEndpointOf, endpointOf } from './ui';

/**
 * The conversation, full size: the page's main thing rather than a panel in a corner
 * (`DialogWright.mountConversation`; docs/designs/2026-10-18-chat-page.md). The line's words large and
 * plain, earlier ones dimmed, the person's beside them, a sign it is thinking, ways to start, a
 * question's answers as buttons, formatted lines, and starting over. Built in a shadow root on a
 * `dialogwright-conversation` element with createElement only: every word goes in as text. A page
 * themes it with --dw-* custom properties on that element and surrounds it with its own brand.
 */

/** What a page sets. Only `endpoint` is required. */
export interface ConversationOptions {
  /** The chat endpoint, `wss://host/chat` (or `/chat`, read against the page). */
  endpoint: string;
  /** On a server of several apps: the app to chat with, by its id (`<endpoint>/<app>`). */
  app?: string;
  /** The language to ask for. Default: the page's `<html lang>`, else none (the app's default). */
  locale?: string;
  /** The page's own data, sent as the chat starts (an app's callData reads it as chat.<key>). */
  context?: Readonly<Record<string, string>>;
  /** Ways to start, each sent as the person's words when tapped; shown until the first message. Default: none. */
  starters?: readonly string[];
  /** Any of the widget's words (strings.ts), replacing the English defaults. */
  strings?: Partial<Record<StringKey, string>>;
  /** What a transfer does on this page, given the reason and the data the app sends. Default: the conversation says strings.transferred. */
  onTransfer?: (reason: string, data?: Readonly<Record<string, string>>, slots?: Readonly<Record<string, string>>, unconfirmed?: readonly string[]) => void;
  /** Every event the chat client reports, after the conversation has shown it. */
  onEvent?: (e: ChatClientEvent) => void;
  /** Delays between reconnect attempts, in ms. */
  backoffMs?: readonly number[];
  /** Reconnects in a row a dropped chat may try before the conversation says it is unavailable. Default: no limit. */
  maxReconnects?: number;
}

export interface ConversationDeps {
  createClient: (o: ChatClientOptions) => ChatClient;
}

export interface Conversation {
  /** The element it lives in (`dialogwright-conversation`); theme it with --dw-* custom properties. */
  host: HTMLElement;
  /** Sends words as the person's, as a starter or a tap does (a page's own buttons, say). */
  send(text: string): void;
  /** Ends the conversation, if one is under way, and starts a new one, the screen cleared. */
  startOver(): void;
  /** Closes the chat and removes the conversation from the page. */
  destroy(): void;
}

const warn = (m: string): void => console.warn(m);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The send button's arrow, drawn with elements (no markup parsed). */
function arrow(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M3.4 20.4 21 12 3.4 3.6 3.4 10.1 15 12 3.4 13.9Z');
  svg.append(path);
  return svg;
}

/** The most starters and answer buttons shown. */
const MOST_BUTTONS = 8;

/**
 * Mounts the conversation in `container` (an element, or a CSS selector for one), and connects at
 * once: on a page whose purpose is the conversation, it starts as the page opens.
 */
export function mountConversation(container: Element | string, options: ConversationOptions, deps: ConversationDeps = { createClient: createChatClient }): Conversation {
  if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') throw new Error('DialogWright conversation: endpoint is required');
  const parent = typeof container === 'string' ? document.querySelector(container) : container;
  if (parent === null) throw new Error(`DialogWright conversation: container ${String(container)} is not on the page`);
  const endpoint = appEndpointOf(endpointOf(options.endpoint), options.app);
  const s: WidgetStrings = stringsOf(options.strings, warn);
  const pageLang = document.documentElement.getAttribute('lang') ?? undefined;
  const asked = options.locale ?? pageLang;
  const locale = asked !== undefined && isLocaleTag(asked.trim()) ? asked.trim() : undefined;
  const context = contextOf(options.context, warn);
  const starterWords = (options.starters ?? []).filter((w) => typeof w === 'string' && w.trim() !== '').slice(0, MOST_BUTTONS);

  const host = el('dialogwright-conversation' as 'div');
  const root = host.attachShadow({ mode: 'open' });
  root.append(el('style', {}, CONVERSATION_STYLES));

  const head = el('div', { class: 'head' });
  const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
  const state = el('span', { class: 'state', role: 'status' }, s.connecting);
  const status = el('span', { class: 'status' });
  status.append(dot, state);
  const restart = el('button', { type: 'button', class: 'restart' }, s.startOver);
  head.append(status, restart);
  const log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': s.log });
  const thinking = el('div', { class: 'thinking', 'aria-hidden': 'true' });
  thinking.append(el('span'), el('span'), el('span'));
  const again = el('button', { type: 'button', class: 'again' }, s.newChat);
  again.hidden = true;
  const starters = el('div', { class: 'starters', role: 'group', 'aria-label': s.replies });
  for (const w of starterWords) {
    const b = el('button', { type: 'button', class: 'chip' }, w);
    b.addEventListener('click', () => send(w));
    starters.append(b);
  }
  starters.hidden = starterWords.length === 0;
  const form = el('form', { class: 'composer' });
  const input = el('textarea', { id: 'dw-text', rows: '1', maxlength: String(CHAT_TEXT_MAX), placeholder: s.placeholder });
  const sendButton = el('button', { type: 'submit', class: 'send', 'aria-label': s.send });
  sendButton.append(arrow());
  form.append(el('label', { for: 'dw-text', class: 'sr' }, s.message), input, sendButton);
  const panel = el('section', { class: 'conversation' });
  panel.append(head, log, thinking, again, starters, form);
  root.append(panel);

  let client: ChatClient | null = null;
  let connection: ConnectionState | null = null;
  let ended = false;
  let chatLang = locale;
  let replyRow: HTMLElement | null = null;

  const scroll = (): void => {
    log.scrollTop = log.scrollHeight;
  };
  const busy = (on: boolean): void => {
    thinking.classList.toggle('on', on);
    if (on) scroll();
  };
  const ready = (): void => {
    const open = connection === 'open' && !ended;
    input.disabled = !open;
    sendButton.disabled = !open || input.value.trim() === '';
  };
  const clearReplies = (): void => {
    replyRow?.remove();
    replyRow = null;
  };
  const line = (kind: 'agent' | 'you' | 'note', words: string, lang?: string, rich?: unknown): void => {
    if (kind === 'agent') for (const old of log.querySelectorAll('.turn.agent:not(.old)')) old.classList.add('old');
    const drawn = kind === 'agent' && rich !== undefined ? renderRich(rich) : null;
    const turn = el(drawn === null ? 'p' : 'div', { class: `turn ${kind}` });
    if (kind !== 'note') turn.append(el('span', { class: 'sr' }, kind === 'you' ? s.you : s.agent));
    if (drawn !== null) turn.append(drawn);
    else turn.append(document.createTextNode(words));
    if (lang) turn.setAttribute('lang', lang);
    log.append(turn);
    scroll();
  };
  const offer = (answers: readonly string[] | undefined): void => {
    clearReplies();
    const words = (answers ?? []).filter((a) => a.trim() !== '').slice(0, MOST_BUTTONS);
    if (words.length < 2 || ended) return;
    const row = el('div', { class: 'replies', role: 'group', 'aria-label': s.replies });
    for (const w of words) {
      const b = el('button', { type: 'button', class: 'chip' }, w);
      b.addEventListener('click', () => {
        send(w);
        input.focus();
      });
      row.append(b);
    }
    log.append(row);
    replyRow = row;
    scroll();
  };
  const setStatus = (kind: 'on' | 'wait' | 'off', words: string): void => {
    dot.className = `dot ${kind}`;
    state.textContent = words;
  };

  const over = (): void => {
    ended = true;
    busy(false);
    clearReplies();
    again.hidden = false;
    setStatus('off', s.ended);
    ready();
  };

  // Each connection's events, and only the current one's: a conversation started over ignores the last one's end.
  let generation = 0;
  const eventsOf = (mine: number) => (e: ChatClientEvent): void => {
    if (mine === generation) onEvent(e);
  };
  const onEvent = (e: ChatClientEvent): void => {
    switch (e.type) {
      case 'ready':
        chatLang = e.locale;
        break;
      case 'say':
        busy(false);
        line('agent', e.text, e.lang, e.rich);
        offer(e.replies);
        break;
      case 'restarted':
        line('note', s.restarted);
        break;
      case 'transfer':
        busy(false);
        if (options.onTransfer) {
          try {
            options.onTransfer(e.reason, e.data, e.slots, e.unconfirmed);
          } catch (err) {
            warn(`DialogWright conversation: onTransfer failed: ${String(err)}`);
          }
        } else line('note', s.transferred);
        break;
      case 'end':
        over();
        break;
      case 'error':
        busy(false);
        if (e.code === 'too_long') line('note', s.tooLong);
        else if (e.code === 'busy' && connection === 'open') line('note', s.wait);
        else if (e.code !== 'busy') line('note', s.error);
        break;
      case 'connection':
        connection = e.state;
        if (e.state === 'open') setStatus('on', s.online);
        else if (e.state === 'connecting' || e.state === 'reconnecting') setStatus('wait', e.state === 'connecting' ? s.connecting : s.reconnecting);
        else if (e.state === 'unavailable') {
          line('note', s.unavailable);
          over();
          setStatus('off', s.offline);
        } else if (!ended) over();
        ready();
        break;
      default:
        break;
    }
    if (options.onEvent) {
      try {
        options.onEvent(e);
      } catch (err) {
        warn(`DialogWright conversation: onEvent failed: ${String(err)}`);
      }
    }
  };

  const connect = (): void => {
    ended = false;
    again.hidden = true;
    busy(true);
    setStatus('wait', s.connecting);
    generation += 1;
    client = deps.createClient({
      endpoint,
      onEvent: eventsOf(generation),
      ...(locale ? { locale } : {}),
      ...(context ? { context } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      ...(options.maxReconnects !== undefined ? { maxReconnects: options.maxReconnects } : {}),
    });
  };

  const grow = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  function send(text: string): void {
    const words = text.trim();
    if (words === '' || client === null || ended) return;
    starters.hidden = true;
    clearReplies();
    line('you', words, chatLang);
    busy(true);
    void client.send(words).catch(() => busy(false));
    ready();
  }

  const fresh = (): void => {
    if (client !== null && !ended) client.end();
    client?.close();
    log.textContent = '';
    clearReplies();
    starters.hidden = starterWords.length === 0;
    connect();
  };

  const submit = (): void => {
    const words = input.value;
    if (words.trim() === '' || ended || connection !== 'open') return;
    input.value = '';
    grow();
    send(words);
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  input.addEventListener('input', () => {
    grow();
    ready();
  });
  input.addEventListener('keydown', (ev: KeyboardEvent) => {
    const composing = ev.isComposing || ev.keyCode === 229;
    if (ev.key === 'Enter' && !ev.shiftKey && !composing) {
      ev.preventDefault();
      submit();
    }
  });
  restart.addEventListener('click', fresh);
  again.addEventListener('click', fresh);

  parent.append(host);
  ready();
  connect();

  return {
    host,
    send,
    startOver: fresh,
    destroy() {
      client?.close();
      host.remove();
    },
  };
}

import { createChatClient } from './client';
import { mountWidget, positionOf, type WidgetOptions } from './ui';

export { createChatClient, DEFAULT_BACKOFF_MS, DEFAULT_MAX_RECONNECTS } from './client';
export type { ChatClient, ChatClientEvent, ChatClientOptions, ConnectionState } from './client';
export type { ChatErrorCode } from './protocol';
export { mountWidget, POSITIONS } from './ui';
export type { Position, Widget, WidgetOptions } from './ui';
export { DEFAULT_STRINGS } from './strings';
export type { WidgetStrings } from './strings';

/** Mounts the chat panel: `DialogWright.mount({ endpoint, ... })`. */
export const mount = mountWidget;

/**
 * The options a `<script data-endpoint=...>` tag sets: data-endpoint, data-locale, data-title,
 * data-position, data-container, data-start-open, and data-strings (JSON). What cannot be read is
 * left out, with a warning, so the default applies. Code-only options (getToken, onTransfer) need
 * `DialogWright.mount`.
 */
export function optionsFromScript(script: HTMLScriptElement): WidgetOptions {
  const d = script.dataset;
  const o: WidgetOptions = { endpoint: d.endpoint ?? '' };
  if (d.locale) o.locale = d.locale;
  if (d.title) o.title = d.title;
  const position = positionOf(d.position);
  if (position) o.position = position;
  if (d.container) o.container = d.container;
  if (d.startOpen !== undefined) {
    // Present (or "true") opens it; "false" does not; anything else is the default, with a warning.
    const v = d.startOpen.trim().toLowerCase();
    if (v === '' || v === 'true' || v === 'false') o.startOpen = v !== 'false';
    else console.warn(`DialogWright widget: data-start-open must be true or false, got "${d.startOpen}"; using false`);
  }
  if (d.strings !== undefined) {
    try {
      const parsed: unknown = JSON.parse(d.strings);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      o.strings = parsed as Record<string, string>;
    } catch {
      console.warn('DialogWright widget: data-strings must be a JSON object of words, like {"send":"Enviar"}; using the defaults');
    }
  }
  return o;
}

declare global {
  interface Window {
    DialogWright?: { mount: typeof mountWidget; createChatClient: typeof createChatClient };
  }
}

// Loaded by a <script data-endpoint> tag, the widget mounts itself; loaded any other way, it waits
// for the page to call DialogWright.mount. The script tag is read now: it is only known while the
// script first runs.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.DialogWright = { mount: mountWidget, createChatClient };
  const script = document.currentScript;
  if (script instanceof HTMLScriptElement && script.dataset.endpoint !== undefined) {
    const start = (): void => {
      try {
        mountWidget(optionsFromScript(script));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
}

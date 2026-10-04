// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endpointOf, mountWidget, type WidgetOptions } from './ui';
import { optionsFromScript } from './index';
import { DEFAULT_STRINGS, stringsOf } from './strings';
import { STYLES } from './styles';
import type { ChatClient, ChatClientEvent, ChatClientOptions } from './client';

/** The client replaced by a fake: it records what is sent and lets the test say what the server said. */
function fakeClient() {
  const sent: string[] = [];
  const made: ChatClientOptions[] = [];
  let closed = 0;
  let signIns = 0;
  const make = (o: ChatClientOptions): ChatClient => {
    made.push(o);
    return {
      ready: Promise.resolve({ session: 's', locale: 'en-US' }),
      send: async (t) => { sent.push(t); },
      signIn: async () => { signIns += 1; },
      close: () => { closed += 1; },
    };
  };
  return {
    make,
    sent,
    made,
    closed: () => closed,
    signIns: () => signIns,
    emit: (e: ChatClientEvent) => made.at(-1)!.onEvent(e),
  };
}

const mounted: Array<{ destroy(): void }> = [];
function mount(o: Partial<WidgetOptions> = {}, f = fakeClient()) {
  const w = mountWidget({ endpoint: 'wss://x/chat', ...o }, { createClient: f.make });
  mounted.push(w);
  const root = w.host.shadowRoot!;
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel);
  return { w, f, root, $ };
}

afterEach(() => {
  for (const w of mounted.splice(0)) w.destroy();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('lang');
  vi.restoreAllMocks();
});

const enter = (el: Element, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
const lines = (root: ShadowRoot, from: string) => [...root.querySelectorAll(`[role="log"] [data-from="${from}"]`)].map((l) => l.textContent);

describe('the widget', () => {
  it('opens, sends what is typed, and shows the agent lines in their language', () => {
    const { f, root, $ } = mount({ startOpen: true });
    const input = $<HTMLTextAreaElement>('textarea')!;
    input.value = 'my power is out';
    enter(input);
    expect(f.sent).toEqual(['my power is out']);
    // The person's own line is shown at once, and the box is cleared.
    expect(lines(root, 'user')).toEqual(['my power is out']);
    expect(input.value).toBe('');
    f.emit({ type: 'say', text: 'Lo siento.', lang: 'es-US' });
    const agent = root.querySelectorAll('[role="log"] [data-from="agent"]');
    expect(agent[agent.length - 1]!.textContent).toBe('Lo siento.');
    expect(agent[agent.length - 1]!.getAttribute('lang')).toBe('es-US');
  });

  it('shows a line with markup in it as text, never as markup', () => {
    const { f, root } = mount({ startOpen: true });
    f.emit({ type: 'say', text: '<img src=x onerror="alert(1)"><b>bold</b>', lang: 'en-US' });
    expect(lines(root, 'agent')).toEqual(['<img src=x onerror="alert(1)"><b>bold</b>']);
    expect(root.querySelector('[role="log"] img')).toBeNull();
    expect(root.querySelector('[role="log"] b')).toBeNull();
  });

  it('does not send on Shift+Enter, an empty box, or while composing', () => {
    const { f, $ } = mount({ startOpen: true });
    const input = $<HTMLTextAreaElement>('textarea')!;
    input.value = '   ';
    enter(input);
    input.value = 'two lines';
    enter(input, { shiftKey: true });
    enter(input, { isComposing: true });
    expect(f.sent).toEqual([]);
    $<HTMLButtonElement>('button.send')!.click();
    expect(f.sent).toEqual(['two lines']);
  });

  it('connects only when it is first opened, then opens and closes from the launcher', () => {
    const { f, $ } = mount();
    const launcher = $<HTMLButtonElement>('button.launcher')!;
    const panel = $<HTMLElement>('.panel')!;
    expect(f.made).toHaveLength(0);
    expect(panel.hidden).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    launcher.click();
    expect(f.made).toHaveLength(1);
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    launcher.click();
    launcher.click();
    expect(f.made).toHaveLength(1);
  });

  it('uses the site words, title and language', () => {
    document.documentElement.setAttribute('lang', 'es-MX');
    const { f, $, w } = mount({ title: 'Ayuda', strings: { placeholder: 'Escriba aquí', send: 'Enviar' }, startOpen: true });
    expect($('h2')!.textContent).toBe('Ayuda');
    expect($('textarea')!.getAttribute('placeholder')).toBe('Escriba aquí');
    expect($('button.send')!.textContent).toBe('Enviar');
    // A word the site did not set stays the default.
    expect($('button.launcher')!.textContent).toBe(DEFAULT_STRINGS.open);
    // The language asked for is the page's, when the site names none.
    expect(f.made[0]!.locale).toBe('es-MX');
    expect(w.host.getAttribute('data-position')).toBe('bottom-right');
  });

  it('asks for the language the site names over the page\'s', () => {
    document.documentElement.setAttribute('lang', 'en');
    const { f } = mount({ locale: 'es', startOpen: true });
    expect(f.made[0]!.locale).toBe('es');
  });

  it('warns about a word it does not have, and keeps the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { $ } = mount({ strings: { placeholdr: 'x', send: 'Go' } as Record<string, string> });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('placeholdr'));
    expect($('button.send')!.textContent).toBe('Go');
    // An object's own built-ins are not words either.
    const strings = stringsOf(JSON.parse('{"toString":"x","__proto__":"y","constructor":"z"}') as Record<string, string>, () => {});
    expect(Object.keys(strings)).toEqual(Object.keys(DEFAULT_STRINGS));
    expect(typeof strings.toString).toBe('function');
  });

  it('hands a transfer to the site, and says so itself when the site has no handler', () => {
    let reason = '';
    const a = mount({ startOpen: true, onTransfer: (r) => { reason = r; } });
    a.f.emit({ type: 'transfer', reason: 'live-agent' });
    expect(reason).toBe('live-agent');
    expect(lines(a.root, 'notice')).toEqual([]);
    const b = mount({ startOpen: true });
    b.f.emit({ type: 'transfer', reason: 'live-agent' });
    expect(lines(b.root, 'notice')).toEqual([DEFAULT_STRINGS.transferred]);
  });

  it('says when it is reconnecting, when the chat restarted, and when it has ended, and stops taking text at the end', () => {
    const { f, root, $ } = mount({ startOpen: true });
    const status = $('[role="status"]')!;
    f.emit({ type: 'connection', state: 'open' });
    expect(status.textContent).toBe('');
    f.emit({ type: 'connection', state: 'reconnecting' });
    expect(status.textContent).toBe(DEFAULT_STRINGS.reconnecting);
    f.emit({ type: 'restarted' });
    f.emit({ type: 'connection', state: 'open' });
    expect(status.textContent).toBe('');
    f.emit({ type: 'end' });
    f.emit({ type: 'connection', state: 'closed' });
    expect(lines(root, 'notice')).toEqual([DEFAULT_STRINGS.restarted, DEFAULT_STRINGS.ended]);
    expect($<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('button.send')!.disabled).toBe(true);
  });

  it('says the chat has ended when the connection closes for good without an end', () => {
    const { f, root, $ } = mount({ startOpen: true });
    f.emit({ type: 'connection', state: 'closed' });
    expect(lines(root, 'notice')).toEqual([DEFAULT_STRINGS.ended]);
    expect($<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  });

  it('says the chat is unavailable when the server is full, and tells a person typing too fast to wait', () => {
    const { f, root, $ } = mount({ startOpen: true });
    f.emit({ type: 'error', code: 'busy', message: 'too many chats are open: try again later' });
    f.emit({ type: 'connection', state: 'unavailable' });
    expect($('[role="status"]')!.textContent).toBe(DEFAULT_STRINGS.unavailable);
    expect($<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    const g = mount({ startOpen: true });
    g.f.emit({ type: 'connection', state: 'open' });
    g.f.emit({ type: 'error', code: 'busy', message: 'wait for the reply to what was sent' });
    g.f.emit({ type: 'error', code: 'too_long', message: 'a message is at most 500 characters' });
    // The site's words, never the server's.
    expect(lines(g.root, 'notice')).toEqual([DEFAULT_STRINGS.wait, DEFAULT_STRINGS.tooLong]);
    expect(lines(root, 'notice')).toEqual([]);
  });

  it('offers sign-in when the site can give a token, and hides it once signed in', () => {
    const none = mount({ startOpen: true });
    expect(none.$<HTMLButtonElement>('button.signin')!.hidden).toBe(true);
    const { f, root, $ } = mount({ startOpen: true, getToken: async () => 'mock:1' });
    const button = $<HTMLButtonElement>('button.signin')!;
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe(DEFAULT_STRINGS.signIn);
    button.click();
    expect(f.signIns()).toBe(1);
    f.emit({ type: 'signed_in', level: 2 });
    expect(button.hidden).toBe(true);
    expect(lines(root, 'notice')).toEqual([DEFAULT_STRINGS.signedIn]);
  });

  it('is accessible: a live log, labelled controls, a sane focus order, Escape to close', () => {
    const { $, root, w } = mount();
    const log = $('[role="log"]')!;
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-label')).toBe(DEFAULT_STRINGS.log);
    const input = $<HTMLTextAreaElement>('textarea')!;
    expect(root.querySelector(`label[for="${input.id}"]`)!.textContent).toBe(DEFAULT_STRINGS.message);
    const launcher = $<HTMLButtonElement>('button.launcher')!;
    expect(launcher.getAttribute('aria-controls')).toBe($('.panel')!.id);
    expect($('.panel')!.getAttribute('aria-labelledby')).toBe($('h2')!.id);
    expect($('button.close')!.getAttribute('aria-label')).toBe(DEFAULT_STRINGS.close);
    // Tab order is document order: launcher, then the box, then send, then close.
    const order = [...root.querySelectorAll('button, textarea')].map((el) => el.className || el.tagName.toLowerCase());
    expect(order).toEqual(['launcher', 'textarea', 'send', 'signin', 'close']);
    launcher.click();
    expect(root.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($<HTMLElement>('.panel')!.hidden).toBe(true);
    expect(root.activeElement).toBe(launcher);
    w.open();
    $<HTMLButtonElement>('button.close')!.click();
    expect($<HTMLElement>('.panel')!.hidden).toBe(true);
  });

  it('honours reduced motion and the colour scheme, and takes the site\'s colours', () => {
    expect(STYLES).toContain('prefers-reduced-motion');
    expect(STYLES).toContain('prefers-color-scheme: dark');
    for (const v of ['--dw-accent', '--dw-accent-fg', '--dw-bg', '--dw-fg', '--dw-user-bg', '--dw-agent-bg', '--dw-radius', '--dw-font', '--dw-z']) expect(STYLES, v).toContain(`var(${v}`);
    // Motion only for those who have not asked for less.
    expect(STYLES.indexOf('transition')).toBeGreaterThan(STYLES.indexOf('prefers-reduced-motion: no-preference'));
  });

  it('renders inline inside the site\'s container, always open, without a launcher', () => {
    document.body.innerHTML = '<main><div id="help"></div></main>';
    const { f, $, w } = mount({ position: 'inline', container: '#help' });
    expect(w.host.parentElement!.id).toBe('help');
    expect($('button.launcher')).toBeNull();
    expect($('button.close')).toBeNull();
    expect($<HTMLElement>('.panel')!.hidden).toBe(false);
    expect(f.made).toHaveLength(1);
  });

  it('refuses options it cannot work with', () => {
    expect(() => mountWidget({ endpoint: '' })).toThrow('endpoint');
    expect(() => mountWidget({ endpoint: 'wss://x/chat', position: 'inline' })).toThrow('container');
    expect(() => mountWidget({ endpoint: 'wss://x/chat', position: 'inline', container: '#nowhere' })).toThrow('#nowhere');
  });

  it('tells the person, in the site\'s words, that the chat restarted, offers sign-in again, and tells the site', () => {
    const seen: string[] = [];
    const { f, root, $ } = mount({ startOpen: true, getToken: async () => 'mock:1', strings: { restarted: 'Nuevo chat.' }, onEvent: (e) => seen.push(e.type) });
    const button = $<HTMLButtonElement>('button.signin')!;
    f.emit({ type: 'signed_in', level: 2 });
    expect(button.hidden).toBe(true);
    f.emit({ type: 'restarted' });
    expect(lines(root, 'notice').at(-1)).toBe('Nuevo chat.');
    expect(button.hidden).toBe(false);
    f.emit({ type: 'signed_in', level: 2 });
    expect(button.hidden).toBe(true);
    expect(seen).toEqual(['signed_in', 'restarted', 'signed_in']);
  });

  it('keeps going when the site\'s onEvent throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { f, root } = mount({ startOpen: true, onEvent: () => { throw new Error('site bug'); } });
    f.emit({ type: 'say', text: 'one', lang: 'en-US' });
    f.emit({ type: 'say', text: 'two', lang: 'en-US' });
    expect(lines(root, 'agent')).toEqual(['one', 'two']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onEvent failed'));
  });

  it('does not take the page\'s focus when it opens on load, only when the person opens it', () => {
    const { root, $, w } = mount({ startOpen: true });
    expect($<HTMLElement>('.panel')!.hidden).toBe(false);
    expect(root.activeElement).toBeNull();
    w.close();
    w.open();
    expect(root.activeElement).toBe($('textarea'));
  });

  it('leaves Escape and Enter to an input method while it composes', () => {
    const { f, $ } = mount({ startOpen: true });
    const input = $<HTMLTextAreaElement>('textarea')!;
    input.value = 'こんにちは';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
    expect($<HTMLElement>('.panel')!.hidden).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229 } as KeyboardEventInit));
    expect(f.sent).toEqual([]);
  });

  it('moves focus to close when the chat ends under the person\'s typing', () => {
    const { f, root, $, w } = mount();
    w.open();
    expect(root.activeElement).toBe($('textarea'));
    f.emit({ type: 'end' });
    expect(root.activeElement).toBe($('button.close'));
  });

  it('takes the endpoint as a socket URL, from a page-relative or http(s) one too', () => {
    expect(endpointOf('wss://chat.example.com/chat')).toBe('wss://chat.example.com/chat');
    expect(endpointOf('https://chat.example.com/chat')).toBe('wss://chat.example.com/chat');
    expect(endpointOf('/chat')).toBe(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat`);
    expect(() => endpointOf('ftp://chat.example.com/chat')).toThrow('endpoint must be the chat\'s URL');
    const { f } = mount({ endpoint: 'https://chat.example.com/chat', startOpen: true });
    expect(f.made[0]!.endpoint).toBe('wss://chat.example.com/chat');
  });

  it('asks for no language, with a warning, when the one given is not a language tag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = mount({ locale: 'en US; drop', startOpen: true });
    expect(a.f.made[0]!.locale).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"en US; drop" is not a language tag'));
    document.documentElement.setAttribute('lang', 'x');
    expect(mount({ startOpen: true }).f.made[0]!.locale).toBeUndefined();
  });

  it('passes the reconnect options on to its client', () => {
    const { f } = mount({ startOpen: true, backoffMs: [100], maxReconnects: 3 });
    expect(f.made[0]).toMatchObject({ backoffMs: [100], maxReconnects: 3 });
  });

  it('warns about a container it does not use, and refuses one that is not a selector', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({ container: '#help' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('container is for an inline widget'));
    expect(() => mountWidget({ endpoint: 'wss://x/chat', position: 'inline', container: '##' })).toThrow('is not a CSS selector');
  });

  it('closes its client and leaves the page as it was when destroyed', () => {
    const { f, w } = mount({ startOpen: true });
    expect(document.body.contains(w.host)).toBe(true);
    w.destroy();
    expect(document.body.contains(w.host)).toBe(false);
    expect(f.closed()).toBe(1);
  });
});

describe('options from the script tag', () => {
  // Parsed, not added to the page (which would load it).
  const script = (attrs: string) => {
    const doc = new DOMParser().parseFromString(`<script src="/widget.js" ${attrs}></script>`, 'text/html');
    return doc.querySelector('script')!;
  };

  it('reads the data attributes', () => {
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-title="Help" data-position="bottom-left"'))).toEqual({ endpoint: 'wss://x/chat', title: 'Help', position: 'bottom-left' });
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-locale="es" data-start-open data-position="inline" data-container="#help" data-strings=\'{"send":"Enviar"}\''))).toEqual({
      endpoint: 'wss://x/chat', locale: 'es', startOpen: true, position: 'inline', container: '#help', strings: { send: 'Enviar' },
    });
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-start-open="false"'))).toEqual({ endpoint: 'wss://x/chat', startOpen: false });
  });

  it('falls back to the default, with a warning, for a position or words it cannot read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-position="top-middle"'))).toEqual({ endpoint: 'wss://x/chat' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('top-middle'));
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-strings="{not json"'))).toEqual({ endpoint: 'wss://x/chat' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-strings'));
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-start-open="yes"'))).toEqual({ endpoint: 'wss://x/chat' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-start-open must be true or false, got "yes"'));
    expect(optionsFromScript(script('data-endpoint="wss://x/chat" data-start-open="true"'))).toEqual({ endpoint: 'wss://x/chat', startOpen: true });
  });
});

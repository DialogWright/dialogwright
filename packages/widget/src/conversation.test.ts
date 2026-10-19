// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversation, type ConversationOptions } from './conversation';
import type { ChatClient, ChatClientEvent, ChatClientOptions } from './client';

/** The client replaced by a fake: what is sent, how many ended and closed, and the server's events. */
function fakeClient() {
  const sent: string[] = [];
  const made: ChatClientOptions[] = [];
  let ends = 0;
  let closes = 0;
  const make = (o: ChatClientOptions): ChatClient => {
    made.push(o);
    return {
      ready: Promise.resolve({ session: 's', locale: 'en-US' }),
      send: async (t) => { sent.push(t); },
      signIn: async () => {},
      end: () => { ends += 1; },
      close: () => { closes += 1; },
    };
  };
  return { make, sent, made, ends: () => ends, closes: () => closes, emit: (e: ChatClientEvent, which = made.length - 1) => made[which]!.onEvent(e) };
}

const mounted: Array<{ destroy(): void }> = [];
function mount(o: Partial<ConversationOptions> = {}) {
  const f = fakeClient();
  const box = document.createElement('div');
  document.body.append(box);
  const c = mountConversation(box, { endpoint: 'wss://x/chat', ...o }, { createClient: f.make });
  mounted.push(c);
  const root = c.host.shadowRoot!;
  const open = () => f.emit({ type: 'connection', state: 'open' });
  return { c, f, root, open };
}
afterEach(() => {
  for (const c of mounted.splice(0)) c.destroy();
  document.body.innerHTML = '';
});

const turns = (root: ShadowRoot, kind: string) => [...root.querySelectorAll(`.turn.${kind}`)].map((t) => t.textContent!.replace(/^(You:|Agent:)/, ''));

describe('the full-size conversation', () => {
  it('connects at once, to the app on a server of several, and says it is online', () => {
    const { f, root, open } = mount({ app: 'farragut-shine' });
    expect(f.made[0]!.endpoint).toBe('wss://x/chat/farragut-shine');
    expect(root.querySelector('.state')!.textContent).toBe('Connecting...');
    expect(root.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    open();
    expect(root.querySelector('.state')!.textContent).toBe('Online');
    expect(root.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
  });

  it('shows the line\'s words, the earlier ones dimmed, a formatted line drawn, and the person\'s beside them', () => {
    const { f, root, open } = mount();
    open();
    f.emit({ type: 'say', text: 'Hi, what can I help with?', lang: 'en-US' });
    f.emit({ type: 'say', text: 'Here: - one', lang: 'en-US', rich: [{ type: 'list', ordered: false, items: [[{ text: 'one', bold: true }]] }] });
    const agent = root.querySelectorAll('.turn.agent');
    expect(agent[0]!.classList.contains('old')).toBe(true);
    expect(agent[1]!.querySelector('ul li strong')!.textContent).toBe('one');
    expect(agent[1]!.getAttribute('lang')).toBe('en-US');
    const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'book a detail';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(f.sent).toEqual(['book a detail']);
    expect(turns(root, 'you')).toEqual(['book a detail']);
    expect(root.querySelector('.thinking')!.classList.contains('on')).toBe(true);
  });

  it('offers starters until the first message, and a question\'s answers as buttons, each tap sent as the person\'s words', () => {
    const { f, root, open } = mount({ starters: ['Book a detail', 'Check on my booking'] });
    open();
    const chips = () => [...root.querySelectorAll<HTMLButtonElement>('.starters .chip')];
    expect(chips().map((b) => b.textContent)).toEqual(['Book a detail', 'Check on my booking']);
    chips()[1]!.click();
    expect(f.sent).toEqual(['Check on my booking']);
    expect(root.querySelector<HTMLElement>('.starters')!.hidden).toBe(true);
    f.emit({ type: 'say', text: 'Shall I cancel it?', lang: 'en-US', replies: ['Yes', 'No'] });
    const replies = () => [...root.querySelectorAll<HTMLButtonElement>('.replies .chip')];
    expect(replies().map((b) => b.textContent)).toEqual(['Yes', 'No']);
    replies()[0]!.click();
    expect(f.sent).toEqual(['Check on my booking', 'Yes']);
    expect(replies()).toEqual([]);
  });

  it('shows markup as text, never as markup', () => {
    const { f, root, open } = mount();
    open();
    f.emit({ type: 'say', text: '<img src=x onerror="alert(1)">', lang: 'en-US' });
    expect(turns(root, 'agent')).toEqual(['<img src=x onerror="alert(1)">']);
    expect(root.querySelector('img')).toBeNull();
  });

  it('offers a new conversation at the end, and starts over on a fresh connection, ignoring the old one\'s events', () => {
    const { c, f, root, open } = mount({ starters: ['Book a detail'] });
    open();
    f.emit({ type: 'say', text: 'Anything else?', lang: 'en-US' });
    c.startOver();
    expect(f.ends()).toBe(1);
    expect(f.made).toHaveLength(2);
    expect(root.querySelectorAll('.turn')).toHaveLength(0);
    expect(root.querySelector<HTMLElement>('.starters')!.hidden).toBe(false);
    // The old connection's end, arriving late, does not end the new one.
    f.emit({ type: 'end' }, 0);
    expect(root.querySelector<HTMLElement>('.again')!.hidden).toBe(true);
    f.emit({ type: 'connection', state: 'open' });
    f.emit({ type: 'end' });
    expect(root.querySelector<HTMLElement>('.again')!.hidden).toBe(false);
    expect(root.querySelector('.state')!.textContent).toBe('This chat has ended.');
    root.querySelector<HTMLButtonElement>('.again')!.click();
    expect(f.made).toHaveLength(3);
  });

  it('takes the site\'s words, and hands a transfer to the site', () => {
    const handed: string[] = [];
    const { f, root, open } = mount({ strings: { startOver: 'Empezar de nuevo' }, onTransfer: (reason) => handed.push(reason) });
    open();
    expect(root.querySelector('.restart')!.textContent).toBe('Empezar de nuevo');
    f.emit({ type: 'transfer', reason: 'live-agent' });
    expect(handed).toEqual(['live-agent']);
  });
});

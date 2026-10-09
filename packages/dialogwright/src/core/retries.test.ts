import { beforeEach, describe, expect, it } from 'vitest';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import type { SlotSpec } from './slots/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession, type Session } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { keyEvents, silenceEvent, speechEvent, startEvent, textEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT, type Channel } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { mockCodeVerifier } from './tools';
import type { AnswerMap } from '../jev/types';
import { screenedApp } from '../testing/screened/app';
import { attemptsOf } from './outcome';

/**
 * Per-slot retries (design 2026-10-09-per-slot-retries): a slot's own `attempts` walks its ladder
 * (decision 1), on the screened fixture's town slot, changed in code: failures before the last but one
 * re-ask, the last but one is the keypad rung where the slot takes keys and the channel has a keypad,
 * the last runs onMaxAttempts.
 */

const TODAY = '2026-09-18';

/** The town keyed: 1 is Millbrook. */
const TOWN_KEYS: SlotSpec['dtmf'] = { length: 1, parse: (d) => (d === '1' ? { value: 'millbrook', display: 'Millbrook' } : null) };

/** The screened fixture with the town slot changed by `slot` and `lines` added to its prompts. */
function variant(id: string, slot: Partial<SlotSpec>, lines: Record<string, string> = {}): App {
  const town: SlotSpec = { ...(screenedApp.slots.town as SlotSpec), ...slot };
  const added = Object.fromEntries(Object.entries(lines).map(([k, text]) => [k, { text, interruptible: true }]));
  return { ...screenedApp, id, slots: { ...screenedApp.slots, town }, prompts: { ...screenedApp.prompts, manifest: { ...screenedApp.prompts.manifest, ...added } } };
}
const KEYPAD_LINE = { ask_town_dtmf: 'Press 1 for Millbrook.' };

let current: App = screenedApp;
function use(a: App): void {
  resetAppsForTest();
  registerApp(a);
  current = a;
}
beforeEach(() => use(screenedApp));

const tc = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...current.systems(), codes: mockCodeVerifier } });

const PLAIN: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  secondIntent: choice({ none: 0.95, urgent: 0.05 }),
};
const one = (value: string) => choice({ [value]: 0.95, none: 0.05 });
/** An answer to the town question that names no town. */
const MISS: AnswerMap = { town: choice({ none: 0.95, millbrook: 0.05 }) };

function say(s: Session, text: string, answers: AnswerMap): TurnResult {
  return resolve(s, s.caps.speech ? speechEvent(text, true) : textEvent(text), { ...PLAIN, ...answers }, tc());
}

/** To the town's question: a leak, and the caller owns the home. */
function atTown(channel: Channel = VOICE_RELAY): Session {
  let s = resolve(newSession('s', 0, channel, ANONYMOUS, current.id), startEvent(), null, tc()).session;
  s = say(s, "there's water in my basement", { intent: one('book_visit'), problem: one('leak') }).session;
  const t = say(s, 'I own it', { ownership: one('own') });
  expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town' });
  return t.session;
}

/** What each of `n` misses at the town's question says: its prompt, or `handoff:<reason>`. */
function misses(n: number, channel: Channel = VOICE_RELAY): string[] {
  let s = atTown(channel);
  const out: string[] = [];
  for (let i = 0; i < n && !s.ended; i++) {
    const t = say(s, 'hmm', MISS);
    out.push(said(t));
    s = t.session;
  }
  return out;
}
const said = (t: TurnResult): string => (t.decision.kind === 'prompt' ? t.decision.promptId : t.decision.kind === 'handoff' ? `handoff:${t.decision.reason}` : t.decision.kind);

describe('attemptsOf', () => {
  it('is the slot\'s own, else the thresholds\' MAX_ATTEMPTS', () => {
    const t = { ...DEFAULT_THRESHOLDS };
    expect(attemptsOf(screenedApp, 'town', t)).toBe(3);
    expect(attemptsOf(screenedApp, 'town', { ...t, MAX_ATTEMPTS: 5 })).toBe(5);
    expect(attemptsOf(variant('x', { attempts: 4 }), 'town', { ...t, MAX_ATTEMPTS: 5 })).toBe(4);
  });
});

describe('the ladder by the slot\'s attempts (decision 1)', () => {
  it('the default, with no keypad rung: retry, retry, a person', () => {
    expect(misses(3)).toEqual(['ask_town_retry', 'ask_town_retry', 'handoff:max-attempts']);
  });

  it('the default, with a keypad rung: retry, the keypad, a person; on a chat the keypad rung is a re-ask', () => {
    use(variant('town-keys', { dtmf: TOWN_KEYS }, KEYPAD_LINE));
    expect(misses(3)).toEqual(['ask_town_retry', 'ask_town_dtmf', 'handoff:max-attempts']);
    expect(misses(3, WEB_CHAT)).toEqual(['ask_town_retry', 'ask_town_retry', 'handoff:max-attempts']);
  });

  it('attempts: 3 is the default ladder', () => {
    use(variant('town-3', { attempts: 3, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    expect(misses(3)).toEqual(['ask_town_retry', 'ask_town_dtmf', 'handoff:max-attempts']);
  });

  it('attempts: 1 runs the outcome at the first failure', () => {
    use(variant('town-1', { attempts: 1, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    expect(misses(1)).toEqual(['handoff:max-attempts']);
  });

  it('attempts: 2 goes to the keypad rung at the first failure, where there is one', () => {
    use(variant('town-2-keys', { attempts: 2, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    expect(misses(2)).toEqual(['ask_town_dtmf', 'handoff:max-attempts']);
    expect(misses(2, WEB_CHAT)).toEqual(['ask_town_retry', 'handoff:max-attempts']);
    use(variant('town-2', { attempts: 2 }));
    expect(misses(2)).toEqual(['ask_town_retry', 'handoff:max-attempts']);
  });

  it('attempts: 4 re-asks twice before the keypad rung', () => {
    use(variant('town-4-keys', { attempts: 4, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    expect(misses(4)).toEqual(['ask_town_retry', 'ask_town_retry', 'ask_town_dtmf', 'handoff:max-attempts']);
    expect(misses(4, WEB_CHAT)).toEqual(['ask_town_retry', 'ask_town_retry', 'ask_town_retry', 'handoff:max-attempts']);
    use(variant('town-4', { attempts: 4 }));
    expect(misses(4)).toEqual(['ask_town_retry', 'ask_town_retry', 'ask_town_retry', 'handoff:max-attempts']);
  });

  it('a run\'s MAX_ATTEMPTS still moves a slot without its own', () => {
    let s = atTown();
    const t5 = { ...tc(), thresholds: { ...DEFAULT_THRESHOLDS, MAX_ATTEMPTS: 2 } };
    const t = resolve(s, speechEvent('hmm', true), { ...PLAIN, ...MISS }, t5);
    expect(said(t)).toBe('ask_town_retry');
    s = t.session;
    expect(said(resolve(s, speechEvent('hmm', true), { ...PLAIN, ...MISS }, t5))).toBe('handoff:max-attempts');
  });

  it('silences walk the same ladder: the keypad rung after the no-input line, then the outcome', () => {
    use(variant('town-2-keys-silence', { attempts: 2, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    let s = atTown();
    const first = resolve(s, silenceEvent(), null, tc());
    expect(first.decision).toMatchObject({ promptId: 'ask_town_dtmf', acks: [{ promptId: 'no_input' }] });
    s = first.session;
    expect(said(resolve(s, silenceEvent(), null, tc()))).toBe('handoff:max-attempts');
  });

  it('a key that is no town counts on the same ladder', () => {
    use(variant('town-2-keys-key', { attempts: 2, dtmf: TOWN_KEYS }, KEYPAD_LINE));
    const s = say(atTown(), 'hmm', MISS).session;
    const [key] = keyEvents('7');
    expect(said(resolve(s, key!, null, tc()))).toBe('handoff:max-attempts');
  });
});

describe('the read-backs by the slot\'s attempts', () => {
  /** The town read back when it is "another town", as the library reads a confirmValues value back (readBackNo: ask). */
  const readBack = (id: string, slot: Partial<SlotSpec>): App => variant(id, { confirmValues: ['elsewhere'], ...slot }, { confirm_town: 'Just to check, {town}?', ...KEYPAD_LINE });
  const ELSEWHERE: AnswerMap = { town: one('elsewhere') };
  const NO: AnswerMap = { confirmsYes: noul(0.05), confirmsNo: noul(0.9) };

  it('a read-back left unanswered walks the slot\'s own ladder: attempts 4 reads it back three times before the keypad', () => {
    use(readBack('town-rb-4', { attempts: 4, dtmf: TOWN_KEYS }));
    let s = say(atTown(), 'Lakeview', ELSEWHERE).session;
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = resolve(s, silenceEvent(), null, tc());
      out.push(said(t));
      s = t.session;
    }
    expect(out).toEqual(['confirm_town', 'confirm_town', 'ask_town_dtmf', 'handoff:max-attempts']);
  });

  it('attempts: 1, an unanswered read-back runs the outcome at once', () => {
    use(readBack('town-rb-1', { attempts: 1 }));
    const s = say(atTown(), 'Lakeview', ELSEWHERE).session;
    expect(said(resolve(s, silenceEvent(), null, tc()))).toBe('handoff:max-attempts');
  });

  it('a no to a library read-back is one step on the slot\'s ladder: attempts 2 asks on the keypad', () => {
    use(readBack('town-rb-no-2', { attempts: 2, dtmf: TOWN_KEYS }));
    const s = say(atTown(), 'Lakeview', ELSEWHERE).session;
    expect(said(say(s, 'no', NO))).toBe('ask_town_dtmf');
  });

  it('a no to a code slot\'s read-back goes to the keypad rung of its own ladder, and a second no to the outcome', () => {
    use(variant('town-code-rb-4', { readBackNo: undefined, attempts: 4, dtmf: TOWN_KEYS, spokenConfirm: 'always' }, { confirm_town: 'Just to check, {town}?', ...KEYPAD_LINE }));
    let s = say(atTown(), 'Lakeview', ELSEWHERE).session;
    let t = say(s, 'no', NO);
    expect(said(t)).toBe('ask_town_dtmf');
    expect(t.session.slots.town!.attempts).toBe(3);
    s = t.session;
    t = say(s, 'Lakeview', ELSEWHERE);
    expect(said(t)).toBe('confirm_town');
    expect(said(say(t.session, 'no', NO))).toBe('handoff:max-attempts');
  });
});

describe('the retry lines (decision 3)', () => {
  /** What each of `n` silences at the town's question says: its prompt, after its acks. */
  function silences(n: number, channel: Channel = VOICE_RELAY): string[] {
    let s = atTown(channel);
    const out: string[] = [];
    for (let i = 0; i < n && !s.ended; i++) {
      const t = resolve(s, silenceEvent(), null, tc());
      const acks = 'acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : [];
      out.push([...acks, said(t)].join(' + '));
      s = t.session;
    }
    return out;
  }

  it('a miss: ask_<slot>_retry<k> where the app has it, else ask_<slot>_retry', () => {
    use(variant('town-retry2', { attempts: 4 }, { ask_town_retry2: 'Sorry, I still did not catch the town.' }));
    expect(misses(4)).toEqual(['ask_town_retry', 'ask_town_retry2', 'ask_town_retry', 'handoff:max-attempts']);
    use(variant('town-retry-all', { attempts: 4 }, { ask_town_retry1: 'One.', ask_town_retry2: 'Two.', ask_town_retry3: 'Three.' }));
    expect(misses(4)).toEqual(['ask_town_retry1', 'ask_town_retry2', 'ask_town_retry3', 'handoff:max-attempts']);
  });

  it('the keypad rung is ask_<slot>_dtmf whatever numbered lines there are', () => {
    use(variant('town-retry-keys', { dtmf: TOWN_KEYS }, { ...KEYPAD_LINE, ask_town_retry2: 'Two.', ask_town_noinput2: 'Two, quietly.' }));
    expect(misses(3)).toEqual(['ask_town_retry', 'ask_town_dtmf', 'handoff:max-attempts']);
    expect(silences(2)).toEqual(['no_input + ask_town', 'no_input + ask_town_dtmf']);
    // On a chat, with no keypad, the keypad rung is a re-ask, which takes the numbered line.
    expect(misses(3, WEB_CHAT)).toEqual(['ask_town_retry', 'ask_town_retry2', 'handoff:max-attempts']);
    expect(silences(2, WEB_CHAT)).toEqual(['no_input + ask_town', 'ask_town_noinput2']);
  });

  it('a silence: ask_<slot>_noinput<k>, else ask_<slot>_noinput, else the no-input line and the question', () => {
    expect(silences(3)).toEqual(['no_input + ask_town', 'no_input + ask_town_retry', 'no_input + handoff:max-attempts']);
    use(variant('town-noinput', { attempts: 4 }, { ask_town_noinput: 'Sorry, I did not hear anything. Which town is the home in?' }));
    expect(silences(4)).toEqual(['ask_town_noinput', 'ask_town_noinput', 'ask_town_noinput', 'no_input + handoff:max-attempts']);
    use(variant('town-noinput2', { attempts: 4 }, { ask_town_noinput: 'Quiet.', ask_town_noinput2: 'Quiet, twice.' }));
    expect(silences(4)).toEqual(['ask_town_noinput', 'ask_town_noinput2', 'ask_town_noinput', 'no_input + handoff:max-attempts']);
    use(variant('town-noinput2-only', { attempts: 4 }, { ask_town_noinput2: 'Quiet, twice.' }));
    expect(silences(3)).toEqual(['no_input + ask_town', 'ask_town_noinput2', 'no_input + ask_town_retry']);
  });

  it('a miss never takes a no-input line, nor a silence a retry line it would not have said', () => {
    use(variant('town-noinput-miss', { attempts: 4 }, { ask_town_noinput: 'Quiet.', ask_town_retry2: 'Two.' }));
    expect(misses(3)).toEqual(['ask_town_retry', 'ask_town_retry2', 'ask_town_retry']);
    expect(silences(3)).toEqual(['ask_town_noinput', 'ask_town_noinput', 'ask_town_noinput']);
  });

  it('a slot narrowed to a part of a value is asked for the rest, whatever numbered lines there are', () => {
    use(variant('town-window', { attempts: 4, partialPromptId: 'ask_town_part' }, { ask_town_part: 'Which part of town?', ask_town_retry1: 'One.', ask_town_noinput1: 'Quiet.' }));
    const s = atTown();
    s.slots.town!.window = { kind: 'part' };
    expect(said(say(s, 'hmm', MISS))).toBe('ask_town_part');
    expect(said(resolve(s, silenceEvent(), null, tc()))).toBe('ask_town_part');
  });
});

import { describe, expect, it } from 'vitest';
import { VOICE_RELAY, WEB_CHAT } from '../../channel/caps';
import { signedInEvent, speechEvent, startEvent } from '../../channel/events';
import { ANONYMOUS } from '../../gate/principal';
import type { Party } from '../../gate/types';
import { seedCorpusSession } from '../../harness-text/runner';
import { parseCorpus } from '../../jev/corpus';
import type { AnswerMap } from '../../jev/types';
import { choice, noul, score } from '../../testing/answers';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { ensureEntry, newTurnOut } from '../lifecycle';
import { newSession, setForm, type Session } from '../session';
import type { SlotSpec } from '../slots/types';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { mockCodeVerifier } from '../tools';
import { resolve, type TurnContext, type TurnResult } from '../turn';
import { identityOf } from './lookup';
import { registerApp } from './registry';
import type { App } from './types';
import { validateApp } from './validate';

/**
 * An app that verifies no one (no App.identity), whose form makes no entry call (no FormDef.entry),
 * with no `done` intent and no seed for the anything_else context: a call runs from the opener to the
 * completion with no gate call, no step-up and no identity question.
 */
useTestkit();

/** The day the caller wants: read from the words, so the test needs no slot questions. */
const day: SlotSpec = {
  id: 'day',
  spokenConfirm: 'summary',
  questions: () => ({}),
  fill: (_answers, ctx) => (/\btuesday\b/.test(ctx.text) ? { kind: 'filled', value: 'tuesday', display: 'Tuesday', confidence: 0.95, confirm: 'none' } : { kind: 'absent' }),
  display: (v) => v,
};

const fails = (what: string) => () => {
  throw new Error(`${what} was called`);
};

const bare: App = {
  id: 'bare',
  intents: {
    agent: { criteria: 'Asks for a person', label: 'a person', kind: 'control' },
    repeat_prompt: { criteria: 'Asks to hear that again', label: 'repeat', kind: 'control' },
    book: { criteria: 'Wants to book a visit', label: 'book a visit', kind: 'form' },
    other: { criteria: 'Anything else', label: 'something else', kind: 'control' },
    none: { criteria: 'No request', label: 'nothing', kind: 'control' },
  },
  menu: [{ digit: '1', intent: 'book' }],
  forms: {
    book: {
      slots: ['day'],
      summaryPromptId: 'confirm_book',
      // With no entry call, neither hook may ever run.
      onEntry: fails('onEntry'),
      principalEntry: fails('principalEntry'),
      complete: ({ acks }) => ({ kind: 'said', acks: [...acks, { promptId: 'booked', vars: {} }] }),
    },
  },
  slots: { day },
  tools: { lookUp: { run: () => ({ value: null, summary: 'looked up' }) } },
  policy: { toolLevel: { lookUp: 0 }, purposeLevel: {}, rulesFor: { lookUp: ['R1'] }, serviceFields: {}, confirmedFields: [], maxAttempts: 3, subjects: {} },
  systems: () => ({ sys: null, lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  prompts: {
    manifest: {
      ...testkitApp.prompts.manifest,
      ask_day: { text: 'Which day works for you?', interruptible: true },
      confirm_book: { text: 'A visit on {day}. Is that right?', interruptible: true },
      booked: { text: 'You are booked.', interruptible: false },
    },
    tags: {},
  },
  testing: { seed: { caller: () => ANONYMOUS, placeholders: { day: { value: 'tuesday', display: 'Tuesday' } } } },
};

/** The bare app with its one tool made the entry call, and a rule of its own that asks for a step-up. */
const bareSteppingUp: App = {
  ...bare,
  id: 'bare-stepping-up',
  forms: { book: { ...bare.forms.book!, onEntry: undefined, principalEntry: undefined, entry: () => ({ tool: 'lookUp', params: {} }) } },
  policy: {
    ...bare.policy,
    rulesFor: { lookUp: ['R1', 'stepUp'] },
    customRules: { stepUp: () => ({ result: { id: 'stepUp', description: 'Asks for more', compared: 'always', pass: false }, fail: { verdict: 'STEP_UP', needLevel: 1 } }) },
  },
};

registerApp(bare);
registerApp(bareSteppingUp);

const tc = (app: App = bare): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } });

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    ...over,
  };
}

const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });

describe('an app without identity, entry calls or a done intent', () => {
  it('is a valid app', () => {
    expect(() => validateApp(bare)).not.toThrow();
  });

  it('runs open, slots, summary and completion with no gate call and no identity question', () => {
    const turns: TurnResult[] = [];
    let s: Session = newSession('b', 0, VOICE_RELAY, ANONYMOUS, 'bare');
    const step = (r: TurnResult) => {
      turns.push(r);
      s = r.session;
    };
    step(resolve(s, startEvent(), null, tc()));
    step(resolve(s, speechEvent('i would like to book a visit'), answers({ intent: choice({ book: 0.95, none: 0.05 }) }), tc()));
    expect(turns.at(-1)!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_day', target: 'day' });
    expect(s.entered).toBe('book');
    step(resolve(s, speechEvent('tuesday please'), answers({ intentChange: ANSWERING }), tc()));
    expect(turns.at(-1)!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_book', vars: { day: 'Tuesday' } });
    step(resolve(s, speechEvent('yes'), answers({ intentChange: ANSWERING, confirmsYes: noul(0.95), confirmsNo: noul(0.02) }), tc()));
    const done = turns.at(-1)!;
    expect(done.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    expect((done.decision as { acks: { promptId: string }[] }).acks.map((a) => a.promptId)).toContain('booked');
    expect(s.completed).toEqual(['book']);
    expect(s.principal).toEqual(ANONYMOUS);
    expect(s.stepUp).toBeNull();
    // Nothing went through the gate, and no turn asked for a factor or a code.
    expect(turns.flatMap((r) => r.gateEvents)).toEqual([]);
    for (const r of turns) expect(['otp', 'identity']).not.toContain(r.session.promptedFor);
    expect(turns.map((r) => r.decision)).not.toContainEqual(expect.objectContaining({ promptId: expect.stringMatching(/otp|identity|signin/) }));
  });

  it('does not end the call on a "done" answer it never offered (a stub may still give one)', () => {
    const s = resolve(newSession('b', 0, VOICE_RELAY, ANONYMOUS, 'bare'), startEvent(), null, tc()).session;
    const r = resolve(s, speechEvent('that is all, goodbye'), answers({ intent: choice({ done: 0.95, none: 0.05 }) }), tc());
    expect(r.decision.kind).not.toBe('complete');
    expect(r.session.ended).toBe(false);
  });

  it('enters a form with no entry call at once, for anyone, and calls neither onEntry nor principalEntry', () => {
    const delegate: Party = { kind: 'staff', level: 2, id: 'S-1', first: 'Sam', role: 'clerk' };
    for (const p of [ANONYMOUS, delegate]) {
      const s = setForm(newSession('b', 0, VOICE_RELAY, p, 'bare'), 'book');
      const out = newTurnOut();
      expect(ensureEntry(s, tc(), out, [])).toBeNull();
      expect(s.entered).toBe('book');
      expect(out.gateEvents).toEqual([]);
    }
  });

  it('sends a step-up its own rule asks for to a person, with no factor asked', () => {
    const s = setForm(newSession('b', 0, VOICE_RELAY, ANONYMOUS, 'bare-stepping-up'), 'book');
    const out = newTurnOut();
    expect(ensureEntry(s, tc(bareSteppingUp), out, [])).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(out.gateEvents.map((e) => e.decision.verdict)).toEqual(['STEP_UP']);
    expect(s.stepUp).toBeNull();
    expect(s.entered).toBeNull();
  });

  it('takes no portal sign-in: no party is one of its subjects', () => {
    const s = resolve(newSession('w', 0, WEB_CHAT, ANONYMOUS, 'bare'), startEvent(), null, tc()).session;
    const r = resolve(s, signedInEvent({ kind: 'subject', level: 2, id: 'X-1', first: 'Ana' }), null, tc());
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.session.principal).toEqual(ANONYMOUS);
  });

  it('reads its identity as none: no factor slots, no subject kind, no identity tools', () => {
    expect(identityOf(testkitApp)).toBe(testkitApp.identity);
    const none = identityOf(bare);
    expect(none).toEqual({ subjectKind: '', factorSlots: [], verifyTool: '', codeTool: '', sendCodeTool: '' });
    expect(Object.isFrozen(none) && Object.isFrozen(none.factorSlots)).toBe(true);
  });

  it('seeds a corpus summary with no entry call, and throws only for an anything_else entry it has no seed for', () => {
    const opts = { thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', tools: tc().tools };
    const [confirm, after] = parseCorpus([
      '{"id":"b-1","text":"yes","intent":"none","context":"confirm_book","confirm":"yes"}',
      '{"id":"b-2","text":"no thanks","intent":"none","context":"anything_else"}',
    ].join('\n'), bare);
    const s = seedCorpusSession(newSession('b-1', 0, VOICE_RELAY, ANONYMOUS, 'bare'), confirm!, opts);
    expect([s.form, s.entered, s.promptedFor, s.lastPromptId]).toEqual(['book', 'book', 'confirm', 'confirm_book']);
    expect(s.lastPromptText).toBe('A visit on Tuesday. Is that right?');
    expect(s.principal).toEqual(ANONYMOUS);
    expect(() => seedCorpusSession(newSession('b-2', 0, VOICE_RELAY, ANONYMOUS, 'bare'), after!, opts)).toThrow(/corpus b-2: app "bare" seeds no anything_else context/);
  });
});

describe('validateApp without identity', () => {
  const without = (policy: Partial<App['policy']>): App => ({ ...bare, policy: { ...bare.policy, ...policy } });

  it('refuses any tool above level 0, or with no level (it would need the highest)', () => {
    expect(() => validateApp(without({ toolLevel: { lookUp: 1 } }))).toThrow(/app "bare": tool "lookUp" needs identity level 1, and the app has no identity/);
    expect(() => validateApp(without({ toolLevel: { lookUp: 2 } }))).toThrow(/tool "lookUp" needs identity level 2, and the app has no identity/);
    expect(() => validateApp(without({ toolLevel: {} }))).toThrow(/tool "lookUp" needs identity level 2 \(it has none\), and the app has no identity/);
  });

  it('refuses a purpose above level 0', () => {
    expect(() => validateApp(without({ purposeLevel: { book: 1 } }))).toThrow(/purpose "book" needs identity level 1, and the app has no identity/);
    expect(() => validateApp(without({ purposeLevel: { book: 0 } }))).not.toThrow();
  });

  it('still needs the agent and repeat_prompt intents, but not done', () => {
    for (const id of ['agent', 'repeat_prompt']) {
      const intents = { ...bare.intents };
      delete intents[id];
      expect(() => validateApp({ ...bare, intents })).toThrow(new RegExp(`missing control intent "${id}"`));
    }
    expect(Object.hasOwn(bare.intents, 'done')).toBe(false);
  });

  it('leaves an app with identity to its own levels', () => {
    expect(() => validateApp({ ...bare, identity: testkitApp.identity!, slots: { ...testkitApp.slots, day }, tools: testkitApp.tools, policy: testkitApp.policy })).not.toThrow();
  });
});

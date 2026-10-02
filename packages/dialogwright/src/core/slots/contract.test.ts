import { describe, expect, it } from 'vitest';
import { VOICE_RELAY } from '../../channel/caps';
import { speechEvent, startEvent } from '../../channel/events';
import { AppDefinitionError, defineApp } from '../../define/defineApp';
import { libraryApp, libraryCode, LIBRARY_DIR } from '../../define/fixture/app';
import { formatProblem } from '../../define/problems';
import { ANONYMOUS } from '../../gate/principal';
import type { Question } from '../../jev/types';
import { choice, noul, score } from '../../testing/answers';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { registerApp } from '../app/registry';
import type { App } from '../app/types';
import { validateApp } from '../app/validate';
import { askSlot } from '../decision';
import { buildQuestions, ENGINE_QUESTION_IDS } from '../questions';
import { newSession, type Session } from '../session';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { mockCodeVerifier } from '../tools';
import { resolve, slotContext, type TurnContext } from '../turn';
import type { SlotContext, SlotPartial, SlotSpec } from './types';

/**
 * The slot contract's metadata: the question ids a slot declares (SlotSpec.questionIds), checked
 * against each other, the engine's and the app's own questions; the turn-time guard for a slot that
 * declares none; and the session's locale reaching a slot (SlotContext.locale, partialVars).
 */
useTestkit();
registerApp(libraryApp);

const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } };
const { book, branch, card } = libraryCode.slots as Record<'book' | 'branch' | 'card', SlotSpec>;
const NOTE: Question = { type: 'noul', instructions: 'Read asr.text. Does the caller say anything else?' };

/** The library with some of its slots replaced, under its own id, registered. */
function library(id: string, slots: Partial<Record<'book' | 'branch' | 'card', SlotSpec>>, over: Partial<App> = {}): App {
  const app: App = { ...libraryApp, id, slots: { ...libraryApp.slots, ...slots }, ...over };
  registerApp(app);
  return app;
}

const fresh = (app: App, id = 's'): Session => newSession(id, 0, VOICE_RELAY, ANONYMOUS, app.id);
const questionsAt = (s: Session) => buildQuestions(s, slotContext(s, 'hello', tc));

describe('the library declares its slots\' question ids and lines', () => {
  it('each slot asks exactly the ids it declares, and the app is valid', () => {
    expect(book.questionIds).toEqual(['book']);
    expect(branch.questionIds).toEqual(['branch']);
    expect(card.questionIds).toEqual(['cardGiven', 'cardSpan', 'cardComplete']);
    const ctx = slotContext(fresh(libraryApp), 'card 5552 0417', tc);
    for (const spec of [book, branch, card]) expect(Object.keys(spec.questions(ctx)).sort()).toEqual([...spec.questionIds!].sort());
    expect(card.prompts?.map((p) => p.id)).toEqual(['ask_card_length', 'ack_card', 'ask_card_dtmf']);
    expect(() => validateApp(libraryApp)).not.toThrow();
  });
});

describe('declared question ids, when the app is validated', () => {
  it('urgency is one of the engine\'s own question ids', () => {
    expect(ENGINE_QUESTION_IDS).toContain('urgency');
  });

  it('refuses an id two slots declare, one the engine asks, and one a slot lists twice', () => {
    expect(() => validateApp({ ...libraryApp, slots: { ...libraryApp.slots, branch: { ...branch, questionIds: ['book'] } } })).toThrow(
      'app "library": slot "branch" declares the question id "book", which the slot "book" declares too, so one slot\'s question would replace the other\'s',
    );
    expect(() => validateApp({ ...libraryApp, slots: { ...libraryApp.slots, card: { ...card, questionIds: ['cardGiven', 'urgency'] } } })).toThrow(
      'app "library": slot "card" declares the question id "urgency", which is one the engine asks, so its answers would be read as the engine\'s',
    );
    expect(() => validateApp({ ...libraryApp, slots: { ...libraryApp.slots, card: { ...card, questionIds: ['cardGiven', 'cardGiven'] } } })).toThrow(
      'app "library": slot "card" declares the question id "cardGiven" twice',
    );
  });

  it('defineApp (and so check) reports every one, in the loader\'s format, with a fix', () => {
    const slots = { ...libraryCode.slots, branch: { ...branch, questionIds: ['book'] }, card: { ...card, questionIds: ['cardGiven', 'urgency', 'cardGiven'] } };
    let problems: string[] = [];
    try {
      defineApp(LIBRARY_DIR, { ...libraryCode, slots });
    } catch (e) {
      if (!(e instanceof AppDefinitionError)) throw e;
      problems = e.problems.map(formatProblem);
    }
    expect(problems).toEqual([
      'app.ts  code.slots.branch.questionIds  slot "branch" declares the question id "book", which the slot "book" declares too, so one slot\'s question would replace the other\'s  ->  give the question an id of the slot\'s own, such as "branchBook", in the slot\'s questions and in app.ts (code.slots.branch.questionIds)',
      'app.ts  code.slots.card.questionIds  slot "card" declares the question id "urgency", which is one the engine asks, so its answers would be read as the engine\'s  ->  give the question an id of the slot\'s own, such as "cardUrgency", in the slot\'s questions and in app.ts (code.slots.card.questionIds)',
      'app.ts  code.slots.card.questionIds  slot "card" declares the question id "cardGiven" twice  ->  list it once in app.ts (code.slots.card.questionIds)',
    ]);
  });
});

describe('slot question ids, turn by turn', () => {
  /** The library's book as a hand-written slot that declares nothing, asking `own` besides its question. */
  const legacyBook = (own: Record<string, Question>): SlotSpec => {
    const { questionIds: _q, prompts: _p, ...rest } = book;
    return { ...rest, questions: (ctx) => ({ ...book.questions(ctx), ...own }) };
  };

  it('a slot that declares none may not ask a question the engine asks', () => {
    const app = library('clash-engine', { book: legacyBook({ urgency: NOTE }) });
    expect(() => questionsAt(fresh(app))).toThrow('app "clash-engine": slot "book" asks the question "urgency", which is one the engine asks');
  });

  it('nor one another slot asks', () => {
    const app = library('clash-slots', { book: legacyBook({ cardSpan: NOTE }) });
    expect(() => questionsAt(fresh(app))).toThrow('app "clash-slots": slots "book" and "card" both ask the question "cardSpan"');
  });

  it('a slot that declares its ids may ask no other', () => {
    const app = library('clash-undeclared', { book: { ...book, questions: (ctx) => ({ ...book.questions(ctx), bookNote: NOTE }) } });
    expect(() => validateApp(app)).not.toThrow();
    expect(() => questionsAt(fresh(app))).toThrow('app "clash-undeclared": slot "book" asks the question "bookNote", which is not in its questionIds');
  });

  it('an app question may not take an id a slot declares, even on a turn that does not ask that slot', () => {
    const app = library('clash-app', {}, { questions: () => ({ cardSpan: NOTE }) });
    const started = resolve(fresh(app), startEvent(), null, tc).session;
    const answers = {
      addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
      rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
      frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }), intent: choice({ renew_loan: 0.95, none: 0.05 }),
    };
    // Renewing asks for the book alone: the card is not asked, but its ids are still its own.
    const renewing = resolve(started, speechEvent('i want to renew a book'), answers, tc).session;
    expect(renewing.form).toBe('renew_loan');
    expect(() => questionsAt(renewing)).toThrow('app "clash-app": its question "cardSpan" is one the slot "card" declares (questionIds)');
  });

  it('every app the engine ships asks without a collision: the testkit, the library', () => {
    expect(() => questionsAt(newSession('t', 0, VOICE_RELAY))).not.toThrow();
    expect(() => questionsAt(fresh(libraryApp))).not.toThrow();
  });
});

describe('the session\'s locale reaches the slots', () => {
  it('an app with locales: the session\'s, in the slot context and so in each slot\'s own', () => {
    const en = fresh(libraryApp, 'en');
    expect(slotContext(en, 'hello', tc).locale).toBe('en-US');
    const es = resolve(fresh(libraryApp, 'es'), startEvent({}, 'es-US'), null, tc).session;
    expect(es.locale).toBe('es');
    expect(slotContext(es, 'hola', tc).locale).toBe('es');
    // Each spec's questions see it (slotCtx keeps the base context's locale).
    const seen: (string | undefined)[] = [];
    const spy: SlotSpec = { ...book, questions: (ctx: SlotContext) => (seen.push(ctx.locale), book.questions(ctx)) };
    const app = library('locale-spy', { book: spy });
    const s = fresh(app);
    s.locale = 'es';
    questionsAt(s);
    expect(seen).toEqual(['es']);
  });

  it('an app without locales: no locale at all, so its slots see the context they always have', () => {
    const ctx = slotContext(newSession('t', 0, VOICE_RELAY), 'hello', tc);
    expect(Object.hasOwn(ctx, 'locale')).toBe(false);
    expect(Object.keys(ctx).sort()).toEqual(['candidateSpans', 'candidateWordSpans', 'current', 'prompted', 'records', 'text', 'thresholds', 'todayIso', 'window']);
  });

  it('partialVars is given the locale where the engine asks for the rest of a value, and none for an app without locales', () => {
    const calls: unknown[][] = [];
    const partialVars = (window: SlotPartial, ...rest: unknown[]): Record<string, string> => (calls.push([window.kind, ...rest]), { title: 'x' });
    const app = library('partial-spy', { book: { ...book, partialPromptId: 'ask_book_title', partialVars } });
    const s = fresh(app);
    s.locale = 'es';
    expect(askSlot(s, 'book', { kind: 'title' }, [])).toMatchObject({ promptId: 'ask_book_title', vars: { title: 'x' } });
    const dob = testkitApp.slots.dob!;
    const kit: App = { ...testkitApp, id: 'testkit-partial-spy', slots: { ...testkitApp.slots, dob: { ...dob, partialVars } } };
    registerApp(kit);
    askSlot(newSession('k', 0, VOICE_RELAY, ANONYMOUS, kit.id), 'dob', { kind: 'dob', month: 3, day: 5 }, []);
    expect(calls).toEqual([['title', 'es'], ['dob', undefined]]);
  });
});

describe('the app\'s records reach the slots', () => {
  const facts = (given: App['facts']) => given;
  const PARCELS = [{ number: '7101' }];
  const ORDERS = [{ ref: 'A12' }];

  it('lists by name (facts.forSlots sources), in the slot context and so in each slot\'s own, beside the one list', () => {
    const seen: unknown[] = [];
    const spy: SlotSpec = { ...book, questions: (ctx: SlotContext) => (seen.push(ctx.sources), book.questions(ctx)) };
    const app = library('sources-app', { book: spy }, {
      facts: facts({ initial: () => ({}), clone: (f) => ({ ...f }), forSlots: () => ({ records: PARCELS, sources: { parcels: PARCELS, orders: ORDERS } }) }),
    });
    const s = fresh(app);
    const ctx = slotContext(s, 'hello', tc);
    expect(ctx.records).toBe(PARCELS);
    expect(ctx.sources).toEqual({ parcels: PARCELS, orders: ORDERS });
    questionsAt(s);
    expect(seen).toEqual([{ parcels: PARCELS, orders: ORDERS }]);
  });

  it('lists by name alone: no one list, so records is empty', () => {
    const app = library('sources-only-app', {}, { facts: facts({ initial: () => ({}), clone: (f) => ({ ...f }), forSlots: () => ({ sources: { orders: ORDERS } }) }) });
    const ctx = slotContext(fresh(app), 'hello', tc);
    expect(ctx.records).toEqual([]);
    expect(ctx.sources).toEqual({ orders: ORDERS });
  });

  it('an app that gives only records, or nothing: no sources at all, the context it always had', () => {
    const one = library('records-app', {}, { facts: facts({ initial: () => ({}), clone: (f) => ({ ...f }), forSlots: () => ({ records: PARCELS }) }) });
    const ctx = slotContext(fresh(one), 'hello', tc);
    expect(ctx.records).toBe(PARCELS);
    expect(Object.hasOwn(ctx, 'sources')).toBe(false);
    expect(Object.hasOwn(slotContext(newSession('t', 0, VOICE_RELAY), 'hello', tc), 'sources')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { keyEvents, speechEvent, startEvent, textEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { plan, resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { promptSay, spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap, QuestionMap } from '../jev/types';
import type { SlotSpec } from '../core/slots/types';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { Action } from '../channel/actions';
import { libraryApp, LibrarySystems, LIBRARY_DIR } from './fixture/app';
import { spanishSwitchVariants } from '../testing/spanishSwitch';

/**
 * A whole call to the library line in Spanish (session.start asks for es): the card number said in
 * Spanish number words, a branch picked, a renewal read back at the summary, and every value said in
 * Spanish (the books and branches from locale/es/slots.yaml, the days in Spanish words). The model's
 * answers are written out, as a recording would give them; the questions they answer are the ones
 * the engine builds for the Spanish words, in English, with Spanish spans among their choices.
 */
registerApp(libraryApp);

const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } });

const BASE: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  cardGiven: noul(0.05), cardSpan: choice({ none: 1 }), cardComplete: noul(0.4),
};

/** One turn: what the model is asked about `text`, and the turn resolved with `over` as its answers. */
function say(r: TurnResult, text: string, over: AnswerMap, t: TurnContext): { asked: QuestionMap; turn: TurnResult } {
  const event = speechEvent(text, true, 'es-US');
  const asked = plan(r.session, event, t).questions ?? {};
  return { asked, turn: resolve(r.session, event, { ...BASE, ...over }, t) };
}
const heard = (r: TurnResult): string => spokenText(libraryApp, r.decision, r.session.locale);
const criteriaOf = (q: QuestionMap, id: string): string[] => {
  const question = q[id];
  return question?.type === 'choice' ? Object.keys(question.criteria) : [];
};

describe('a call in Spanish', () => {
  it('hears the card in Spanish number words, picks a branch, and says every value in Spanish', () => {
    const t = tc();
    const start = resolve(newSession('library-es', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent({}, 'es'), null, t);
    expect(start.session.locale).toBe('es');
    expect(heard(start)).toBe('Gracias por llamar a la Biblioteca de Example Town. Puedo renovar un libro o revisar una reserva. ¿En qué puedo ayudarle?');

    // The card: asked for, then said in Spanish number words, tens joined by "y".
    const loans = say(start, 'quiero saber qué tengo prestado', { intent: choice({ check_loans: 0.95, none: 0.05 }) }, t).turn;
    expect(heard(loans)).toBe('Claro, puedo ayudarle a revisar sus préstamos. ¿Cuál es el número de su tarjeta de la biblioteca?');
    const SPAN = 'cincuenta y cinco cincuenta y dos cero cuatro diecisiete';
    const card = say(loans, `es la cincuenta y cinco cincuenta y dos cero cuatro diecisiete`, {
      cardGiven: noul(0.95), cardSpan: choice({ [SPAN]: 0.9, none: 0.1 }), cardComplete: noul(0.9),
    }, t);
    // The span question offers the Spanish words, as said, and the questions stay in English.
    expect(criteriaOf(card.asked, 'cardSpan')).toContain(SPAN);
    expect(criteriaOf(card.asked, 'cardSpan')).toContain('cincuenta y cinco');
    const spanQuestion = card.asked.cardSpan;
    expect(spanQuestion?.instructions).toMatch(/^Read asr\.text\. Which of these spans is the library card the caller states\?/);
    // The digits are the span's, read as Spanish: 55 52 0 4 17.
    expect(card.turn.gateEvents.map((e) => e.decision.call.params)).toEqual([{ card: '...0417' }]);
    expect(heard(card.turn)).toBe('Con la tarjeta 55520417, el próximo libro que vence es Un huerto tranquilo, el viernes, 25 de septiembre. ¿Hay algo más en que pueda ayudarle?');

    // The same card, digit by digit.
    const again = say(loans, 'cinco cinco cinco dos cero cuatro uno siete', {
      cardGiven: noul(0.95), cardSpan: choice({ 'cinco cinco cinco dos cero cuatro uno siete': 0.9, none: 0.1 }), cardComplete: noul(0.9),
    }, tc());
    expect(criteriaOf(again.asked, 'cardSpan')).toContain('cinco cinco cinco dos cero cuatro uno siete');
    expect(again.turn.gateEvents.map((e) => e.decision.call.params)).toEqual([{ card: '...0417' }]);

    // A hold: the book named, the branch asked for in Spanish and picked.
    const hold = say(card.turn, '¿ya llegó mi reserva de El atlas del río?', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    expect(heard(hold)).toBe('Claro, puedo ayudarle a revisar una reserva. ¿En qué sucursal está la reserva, Norte o Ribera?');
    const branch = say(hold, 'en la sucursal Norte', { branch: choice({ north: 0.92, none: 0.08 }) }, t);
    // The model's turn state shows the book as the call says it.
    expect(branch.asked.branch?.type).toBe('choice');
    const state = plan(hold.session, speechEvent('en la sucursal Norte', true, 'es-US'), t).turnState!;
    expect(state.slots.book).toEqual({ value: 'El atlas del río', confirmed: false });
    expect(heard(branch.turn)).toBe('Buenas noticias, El atlas del río le espera en la sucursal Norte. ¿Hay algo más en que pueda ayudarle?');

    // A renewal: the summary reads the book back in Spanish, and the new due day is said in Spanish.
    const renew = say(branch.turn, 'quiero renovar Un huerto tranquilo', { intent: choice({ renew_loan: 0.95, none: 0.05 }), book: choice({ quiet_orchard: 0.9, none: 0.1 }) }, t).turn;
    expect(heard(renew)).toBe('Claro, puedo ayudarle a renovar un libro. Quiere renovar Un huerto tranquilo por dos semanas más. ¿Lo hago?');
    const yes = say(renew, 'sí, por favor', { confirmsYes: noul(0.95), confirmsNo: noul(0.05), changeSlot: choice({ none: 0.95, book: 0.05 }) }, t).turn;
    expect(yes.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`)).toEqual(['renewLoan:ALLOW']);
    expect(heard(yes)).toBe('Listo. Ahora Un huerto tranquilo se devuelve el viernes, 2 de octubre. ¿Hay algo más en que pueda ayudarle?');
    expect((t.tools.sys as LibrarySystems).renewals).toEqual([{ ref: 'R101', book: 'quiet_orchard', due: '2026-10-02' }]);
  });

  it('reads no Spanish number words in an English call: the same words offer no span', () => {
    const t = tc();
    const start = resolve(newSession('library-en', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, t);
    const loans = say(start, 'what do I have checked out', { intent: choice({ check_loans: 0.95, none: 0.05 }) }, t).turn;
    const card = say(loans, 'cinco cinco cinco dos cero cuatro uno siete', {}, t);
    expect(criteriaOf(card.asked, 'cardSpan')).toEqual(['none']);
    // and an English call says the books and branches in English
    const fresh = resolve(newSession('library-en-hold', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, t);
    const hold = say(fresh, 'is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    const branch = say(hold, 'North', { branch: choice({ north: 0.92, none: 0.08 }) }, t).turn;
    expect(heard(branch)).toBe('Good news, The River Atlas is waiting for you at the North branch. Is there anything else I can help with?');
  });
});

describe('the intents\' labels in Spanish (locale/es/intents.yaml)', () => {
  const started = (locale?: string): TurnResult => resolve(newSession(`labels-${locale ?? 'en'}`, 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent({}, locale), null, tc());

  it('confirms an unsure reading with the Spanish label, and the model is still told the label it reads, in English', () => {
    const t = tc();
    const unsure = say(started('es'), 'algo de una reserva', { intent: choice({ check_hold: 0.5, none: 0.5 }) }, t).turn;
    expect(heard(unsure)).toBe('Para confirmar, ¿quiere revisar una reserva? Sí o no.');
    expect(plan(unsure.session, speechEvent('sí', true, 'es-US'), t).turnState!.pendingConfirmation).toEqual({ target: 'intent', value: 'check a hold' });
  });

  it('asks which of two in Spanish, and asks it again with the same Spanish labels', () => {
    const t = tc();
    const which = say(started('es'), 'algo de un libro', { intent: choice({ check_hold: 0.5, renew_loan: 0.45, none: 0.05 }) }, t).turn;
    expect(heard(which)).toBe('¿Quiere revisar una reserva, o renovar un libro?');
    expect(which.session.lastPromptOptions).toEqual(['revisar una reserva', 'renovar un libro']);
  });

  it('keeps the English labels in an English call', () => {
    const english = resolve(started().session, speechEvent('something about a hold', true, 'en-US'), { ...BASE, intent: choice({ check_hold: 0.5, none: 0.5 }) }, tc());
    expect(spokenText(libraryApp, english.decision, english.session.locale)).toBe('Just to check, do you want to check a hold? Yes or no.');
  });
});

describe('the language each line is said in', () => {
  /** The fixture's Spanish tag, as its locale/ folder names it. */
  const SPANISH = readdirSync(join(LIBRARY_DIR, 'locale')).find((d) => d.startsWith('es'))!;
  const langs = (actions: readonly Action[]): Array<string | undefined> => actions.flatMap((a) => (a.type === 'say' ? [a.lang] : []));

  it('says a Spanish call\'s lines in the Spanish tag', () => {
    const start = resolve(newSession('library-lang-es', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent({}, 'es'), null, tc());
    expect(langs(start.actions).length).toBeGreaterThan(0);
    expect(new Set(langs(start.actions))).toEqual(new Set([SPANISH]));
  });

  it('says a line in the language the voice speaks its locale in, where voice.locales names one', () => {
    const app = { ...libraryApp, voice: { ...libraryApp.voice, locales: { [SPANISH]: { tts: 'es-US', transcription: 'es-MX' } } } };
    expect(promptSay(app, 'goodbye', {}, false, null, SPANISH).lang).toBe('es-US');
    expect(promptSay(app, 'goodbye', {}, false, null).lang).toBe('en-US');
  });

  it('says a call in the default locale in the app\'s locale:', () => {
    const start = resolve(newSession('library-lang-en', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, tc());
    expect(new Set(langs(start.actions))).toEqual(new Set([libraryApp.locales!.default]));
    expect(libraryApp.locales!.default).toBe('en-US');
  });
});

describe('switching language mid-call (an informational intent with locale:)', () => {
  const variants = spanishSwitchVariants();
  afterAll(() => variants.remove());

  /**
   * The library's folder with a `spanish` intent that switches the call to es (key 9 on the menu),
   * its line in both locales, and `voice` written under app.yaml's voice block; the app's id is `id`.
   */
  function switchApp(id: string, voice: string[] = []) {
    const app = variants.build(id, voice);
    registerApp(app);
    return app;
  }

  const plain = switchApp('library-switch');
  const mexican = switchApp('library-switch-mx', ['  locales:', '    es:', '      tts: es-US', '      transcription: es-MX']);
  const ASK_INTENT_ES = '¿En qué puedo ayudarle hoy?';
  const lines = (r: TurnResult) => r.actions.map((a) => (a.type === 'say' ? { lang: a.lang, text: a.parts.map((p) => ('text' in p ? p.text : '')).join(' ') } : a));

  it('switches a voice call to Spanish: set_language first, then the line and the resumed question in Spanish', () => {
    const t = tc();
    const start = resolve(newSession('switch-voice', 0, VOICE_RELAY, ANONYMOUS, plain.id), startEvent(), null, t);
    expect(start.session.locale).toBe('en-US');
    const switched = say(start, 'can we do this in Spanish', { intent: choice({ spanish: 0.95, none: 0.05 }) }, t).turn;
    expect(switched.session.locale).toBe('es');
    expect(lines(switched)).toEqual([
      { type: 'set_language', tts: 'es', transcription: 'es' },
      { lang: 'es', text: 'Muy bien, seguimos en español.' },
      { lang: 'es', text: ASK_INTENT_ES },
    ]);
    // The call goes on in Spanish.
    const loans = say(switched, 'quiero saber qué tengo prestado', { intent: choice({ check_loans: 0.95, none: 0.05 }) }, t).turn;
    expect(heard(loans)).toBe('Claro, puedo ayudarle a revisar sus préstamos. ¿Cuál es el número de su tarjeta de la biblioteca?');
    expect(loans.actions.some((a) => a.type === 'set_language')).toBe(false);
  });

  it('carries the locale\'s own languages from voice.locales to set_language and the lines', () => {
    const t = tc();
    const start = resolve(newSession('switch-mx', 0, VOICE_RELAY, ANONYMOUS, mexican.id), startEvent(), null, t);
    const switched = say(start, 'en español por favor', { intent: choice({ spanish: 0.95, none: 0.05 }) }, t).turn;
    expect(lines(switched)).toEqual([
      { type: 'set_language', tts: 'es-US', transcription: 'es-MX' },
      { lang: 'es-US', text: 'Muy bien, seguimos en español.' },
      { lang: 'es-US', text: ASK_INTENT_ES },
    ]);
  });

  it('switches on the keypad menu key and after a confirmed unsure reading alike', () => {
    const t = tc();
    const start = resolve(newSession('switch-key', 0, VOICE_RELAY, ANONYMOUS, plain.id), startEvent(), null, t);
    const onMenu = { ...start, session: { ...start.session, menuActive: true } };
    const key = resolve(onMenu.session, keyEvents('9')[0]!, null, t);
    expect(key.session.locale).toBe('es');
    expect(key.actions[0]).toEqual({ type: 'set_language', tts: 'es', transcription: 'es' });

    const unsure = say(start, 'maybe Spanish', { intent: choice({ spanish: 0.5, none: 0.5 }) }, t).turn;
    expect(unsure.session.locale).toBe('en-US');
    const said = (r: TurnResult): string => spokenText(plain, r.decision, r.session.locale);
    expect(said(unsure)).toBe('Just to check, do you want to continue in Spanish? Yes or no.');
    const yes = say(unsure, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.05) }, t).turn;
    expect(yes.session.locale).toBe('es');
    expect(lines(yes)[0]).toEqual({ type: 'set_language', tts: 'es', transcription: 'es' });
    expect(said(yes)).toBe(`Muy bien, seguimos en español. ${ASK_INTENT_ES}`);
  });

  it('switches inside a form: the question it was on is asked again in Spanish, and the form goes on', () => {
    const t = tc();
    const start = resolve(newSession('switch-form', 0, VOICE_RELAY, ANONYMOUS, plain.id), startEvent(), null, t);
    const hold = say(start, 'is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    expect(spokenText(plain, hold.decision, hold.session.locale)).toBe('Sure, I can help you check a hold. Which branch is the hold at, North or Riverside?');
    const switched = say(hold, 'can we do this in Spanish', { intent: choice({ spanish: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.05, adding: 0.9, replacing: 0.05 }) }, t).turn;
    expect(switched.session.locale).toBe('es');
    expect(lines(switched)).toEqual([
      { type: 'set_language', tts: 'es', transcription: 'es' },
      { lang: 'es', text: 'Muy bien, seguimos en español.' },
      { lang: 'es', text: '¿En qué sucursal está la reserva, Norte o Ribera?' },
    ]);
    // The book was heard in English, and is said in Spanish now (its slot's display in es).
    const branch = say(switched, 'en la sucursal Norte', { branch: choice({ north: 0.92, none: 0.08 }) }, t).turn;
    expect(lines(branch)).toEqual([
      { lang: 'es', text: 'Buenas noticias, El atlas del río le espera en la sucursal Norte.' },
      { lang: 'es', text: '¿Hay algo más en que pueda ayudarle?' },
    ]);
  });

  it('says a value heard in the breath that switches in the new language, with every line of the turn', () => {
    const t = tc();
    const start = resolve(newSession('switch-breath', 0, VOICE_RELAY, ANONYMOUS, plain.id), startEvent(), null, t);
    const hold = say(start, 'is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    const both = say(hold, 'the North branch, and can we do this in Spanish', {
      intent: choice({ spanish: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.05, adding: 0.9, replacing: 0.05 }), branch: choice({ north: 0.92, none: 0.08 }),
    }, t).turn;
    expect(both.session.locale).toBe('es');
    expect(both.session.slots.branch?.display).toBe('Norte');
    expect(lines(both)[0]).toEqual({ type: 'set_language', tts: 'es', transcription: 'es' });
    expect(lines(both).slice(1).map((l) => ('text' in l ? l.text : l))).toEqual([
      'Muy bien, seguimos en español.',
      'Buenas noticias, El atlas del río le espera en la sucursal Norte.',
      '¿Hay algo más en que pueda ayudarle?',
    ]);
  });

  it('keeps the words of a slot shown as said (SlotSpec.displayFrom), and says every other value in the new language', () => {
    // A slot whose value code writes from the words (a text slot with numbers: digits): display(value)
    // gives the written value, so a switch that formatted it again would read "7625 ..." back.
    const said: SlotSpec = {
      id: 'place', spokenConfirm: 'summary', questions: () => ({}), fill: () => ({ kind: 'absent' }), display: (v) => v, displayFrom: 'said',
    };
    const app = { ...plain, id: 'library-switch-said', slots: { ...plain.slots, place: said } };
    registerApp(app);
    const t = tc();
    const start = resolve(newSession('switch-said', 0, VOICE_RELAY, ANONYMOUS, app.id), startEvent(), null, t);
    const hold = say(start, 'is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    Object.assign(hold.session.slots.place!, { value: '7625 Oak Hollow Lane', display: 'seventy six twenty five oak hollow lane' });
    const switched = say(hold, 'can we do this in Spanish', { intent: choice({ spanish: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.05, adding: 0.9, replacing: 0.05 }) }, t).turn;
    expect(switched.session.locale).toBe('es');
    expect(switched.session.slots.book?.display).toBe('El atlas del río');
    expect(switched.session.slots.place).toMatchObject({ value: '7625 Oak Hollow Lane', display: 'seventy six twenty five oak hollow lane' });
  });

  it('switches a chat\'s lines to Spanish without set_language', () => {
    const t = tc();
    const start = resolve(newSession('switch-chat', 0, WEB_CHAT, ANONYMOUS, plain.id), startEvent(), null, t);
    const event = textEvent('can we do this in Spanish');
    const switched = resolve(start.session, event, { ...BASE, intent: choice({ spanish: 0.95, none: 0.05 }) }, t);
    expect(switched.session.locale).toBe('es');
    expect(switched.actions.some((a) => a.type === 'set_language')).toBe(false);
    expect(lines(switched)).toEqual([{ lang: 'es', text: 'Muy bien, seguimos en español.' }, { lang: 'es', text: ASK_INTENT_ES }]);
  });

  it('says the line and changes nothing else when the call is already in that language', () => {
    const t = tc();
    const start = resolve(newSession('switch-already', 0, VOICE_RELAY, ANONYMOUS, plain.id), startEvent({}, 'es'), null, t);
    const again = say(start, 'en español', { intent: choice({ spanish: 0.95, none: 0.05 }) }, t).turn;
    expect(again.session.locale).toBe('es');
    expect(lines(again)).toEqual([{ lang: 'es', text: 'Muy bien, seguimos en español.' }, { lang: 'es', text: ASK_INTENT_ES }]);
  });
});

describe('the keypad menu from the greeting (intents.yaml menuListens, a menu entry\'s fromGreeting)', () => {
  const variants = spanishSwitchVariants();
  afterAll(() => variants.remove());
  const build = (id: string, menu: Parameters<typeof variants.build>[2]) => {
    const app = variants.build(id, [], menu);
    registerApp(app);
    return app;
  };
  /** The 9 (Spanish) taken from the greeting on; every other key only once the menu is offered. */
  const nine = build('library-nine', { nineFromGreeting: true });
  /** Every key taken from the greeting on. */
  const every = build('library-every', { menuListens: 'greeting' });
  /** The option off: as every app was before it. */
  const off = build('library-offered', {});
  const ASK_INTENT_ES = '¿En qué puedo ayudarle hoy?';
  const SWITCHED = [
    { type: 'set_language', tts: 'es', transcription: 'es' },
    { lang: 'es', text: 'Muy bien, seguimos en español.' },
    { lang: 'es', text: ASK_INTENT_ES },
  ];
  const lines = (r: TurnResult) => r.actions.map((a) => (a.type === 'say' ? { lang: a.lang, text: a.parts.map((p) => ('text' in p ? p.text : '')).join(' ') } : a));
  const started = (app: { id: string }, channel = VOICE_RELAY): TurnResult => resolve(newSession(`${app.id}-call`, 0, channel, ANONYMOUS, app.id), startEvent(), null, tc());
  const key = (r: TurnResult, digit: string): TurnResult => resolve(r.session, keyEvents(digit)[0]!, null, tc());
  const ignored = (before: TurnResult, after: TurnResult): void => {
    expect(after.decision).toEqual({ kind: 'ignore' });
    expect(after.actions).toEqual([]);
    expect(after.menuKey).toBeUndefined();
    expect(after.session).toEqual(before.session);
  };

  it('builds each entry\'s listening into App.menu: the 9 alone, every key, or none', () => {
    expect(nine.menu).toEqual([{ digit: '9', intent: 'spanish', fromGreeting: true }, { digit: '1', intent: 'renew_loan' }, { digit: '2', intent: 'check_hold' }, { digit: '0', intent: 'agent' }]);
    expect(every.menu.every((m) => m.fromGreeting === true)).toBe(true);
    expect(off.menu.some((m) => 'fromGreeting' in m)).toBe(false);
    // An entry's own fromGreeting over menuListens: every key but the 9.
    const butNine = build('library-but-nine', { menuListens: 'greeting', nineFromGreeting: false });
    expect(butNine.menu.map((m) => [m.digit, m.fromGreeting === true])).toEqual([['9', false], ['1', true], ['2', true], ['0', true]]);
  });

  it('switches on the 9 pressed at the greeting: set_language, the line, and the open question in Spanish; nothing counted', () => {
    const start = started(nine);
    const switched = key(start, '9');
    expect(switched.session.locale).toBe('es');
    expect(lines(switched)).toEqual(SWITCHED);
    expect(switched.menuKey).toEqual({ digit: '9', intent: 'spanish' });
    expect([switched.session.menuActive, switched.session.intentAttempts, switched.session.promptedFor, switched.session.dtmfBuffer]).toEqual([false, 0, 'intent', '']);
    // The call goes on in Spanish, by words.
    const loans = say(switched, 'quiero saber qué tengo prestado', { intent: choice({ check_loans: 0.95, none: 0.05 }) }, tc()).turn;
    expect(heard(loans)).toBe('Claro, puedo ayudarle a revisar sus préstamos. ¿Cuál es el número de su tarjeta de la biblioteca?');
  });

  it('ignores a key that does not listen from the greeting, and every key with the option off, as before', () => {
    const start = started(nine);
    ignored(start, key(start, '1'));
    ignored(start, key(start, '0'));
    const plain = started(off);
    ignored(plain, key(plain, '9'));
    ignored(plain, key(plain, '1'));
    // Offered, the menu takes every key, the 9 among them, as it always has.
    const onMenu = { ...start, session: { ...start.session, menuActive: true } };
    const picked = key(onMenu, '1');
    expect(picked.session.form).toBe('renew_loan');
    expect(picked.menuKey).toBeUndefined();
  });

  it('with menuListens: greeting, starts a form by its key and goes to a person on 0; a key not on the menu is ignored, not a miss', () => {
    const start = started(every);
    const renew = key(start, '1');
    expect(renew.session.form).toBe('renew_loan');
    expect(renew.decision.kind).toBe('prompt');
    expect(spokenText(every, renew.decision, renew.session.locale)).toMatch(/^Sure, I can help you renew a book\./);
    expect(renew.menuKey).toEqual({ digit: '1', intent: 'renew_loan' });
    const person = key(start, '0');
    expect(person.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
    ignored(start, key(start, '5'));
  });

  it('listens wherever the open question is asked: after a miss and at "anything else?"; not inside a form or at a confirmation', () => {
    const t = tc();
    const start = started(nine);
    const missed = say(start, 'um', {}, t).turn;
    expect(missed.session.intentAttempts).toBe(1);
    expect(lines(key(missed, '9'))).toEqual(SWITCHED);

    const hold = say(start, 'is my hold for The River Atlas in', { intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ river_atlas: 0.9, none: 0.1 }) }, t).turn;
    const inForm = key(hold, '9');
    expect(inForm.session.locale).toBe('en-US');
    expect(inForm.menuKey).toBeUndefined();
    const done = say(hold, 'North', { branch: choice({ north: 0.92, none: 0.08 }) }, t).turn;
    expect(done.session.lastPromptId).toBe('anything_else');
    expect(lines(key(done, '9'))).toEqual(SWITCHED);

    const unsure = say(start, 'maybe a hold', { intent: choice({ check_hold: 0.5, none: 0.5 }) }, t).turn;
    expect(unsure.session.pendingConfirmation?.target).toBe('intent');
    ignored(unsure, key(unsure, '9'));
  });

  it('takes no key on a chat, and asks the model the same questions of words said at the greeting', () => {
    const chat = started(nine, WEB_CHAT);
    ignored(chat, key(chat, '9'));
    // Keys only: "nine" said at the greeting is words, read as before, so no request changes.
    const words = speechEvent('nine', true, 'en-US');
    expect(plan(started(nine).session, words, tc()).questions).toEqual(plan(started(off).session, words, tc()).questions);
  });
});

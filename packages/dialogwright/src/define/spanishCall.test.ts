import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { plan, resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { promptSay, spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap, QuestionMap } from '../jev/types';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Action } from '../channel/actions';
import { libraryApp, LibrarySystems, LIBRARY_DIR } from './fixture/app';

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
    expect(heard(loans)).toBe('Claro, puedo ayudarle a check your loans. ¿Cuál es el número de su tarjeta de la biblioteca?');
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
    expect(heard(hold)).toBe('Claro, puedo ayudarle a check a hold. ¿En qué sucursal está la reserva, Norte o Ribera?');
    const branch = say(hold, 'en la sucursal Norte', { branch: choice({ north: 0.92, none: 0.08 }) }, t);
    // The model's turn state shows the book as the call says it.
    expect(branch.asked.branch?.type).toBe('choice');
    const state = plan(hold.session, speechEvent('en la sucursal Norte', true, 'es-US'), t).turnState!;
    expect(state.slots.book).toEqual({ value: 'El atlas del río', confirmed: false });
    expect(heard(branch.turn)).toBe('Buenas noticias, El atlas del río le espera en la sucursal Norte. ¿Hay algo más en que pueda ayudarle?');

    // A renewal: the summary reads the book back in Spanish, and the new due day is said in Spanish.
    const renew = say(branch.turn, 'quiero renovar Un huerto tranquilo', { intent: choice({ renew_loan: 0.95, none: 0.05 }), book: choice({ quiet_orchard: 0.9, none: 0.1 }) }, t).turn;
    expect(heard(renew)).toBe('Claro, puedo ayudarle a renew a book. Quiere renovar Un huerto tranquilo por dos semanas más. ¿Lo hago?');
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

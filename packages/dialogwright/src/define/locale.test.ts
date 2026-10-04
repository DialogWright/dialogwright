import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent, type SessionEvent } from '../channel/events';
import { frameToEvent } from '../channel/relay/map';
import { registerApp } from '../core/app/registry';
import { DEFAULT_LOCALE, defaultLocaleOf, localeOf, localesOf, matchLocale } from '../core/locale';
import { prompt } from '../core/decision';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { recordableClips } from '../prompts/clips';
import { decisionToActions, localePromptEntry, promptText, spokenText, type RenderContext } from '../prompts/render';
import { configure, reduce } from '../server/dashboard/view.js';
import { consoleMetaOf } from '../server/dashboard/meta';
import { buildTraceRecord } from '../trace/writer';
import { choice, noul, score } from '../testing/answers';
import { testkitApp } from '../testing/testkit';
import type { AnswerMap } from '../jev/types';
import { libraryApp } from './fixture/app';

/**
 * The library fixture speaks two locales: en-US (app.yaml's `locale:`, its lines in prompts.yaml)
 * and es (locale/es/prompts.yaml, which leaves no_hold out). The testkit declares none.
 */
registerApp(libraryApp);

const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } };

const answers = (over: AnswerMap = {}): AnswerMap => ({
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  ...over,
});
const ANSWERING = { intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) };

const start = (event: SessionEvent = startEvent(), id = 'library-locale'): TurnResult =>
  resolve(newSession(id, 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), event, null, tc);
const say = (r: TurnResult, text: string, over: AnswerMap = {}, lang?: string): TurnResult => resolve(r.session, speechEvent(text, true, lang), answers(over), tc);
const heard = (r: TurnResult): string => spokenText(libraryApp, r.decision, r.session.locale);
const said = (r: TurnResult): string => r.actions.flatMap((a) => (a.type === 'say' ? a.parts.map((p) => ('text' in p ? p.text : `[${p.audio}]`)) : [])).join(' ');
const record = (r: TurnResult, event: SessionEvent) => buildTraceRecord({
  result: r, event, questions: null, response: null, error: null,
  timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 }, ts: '2026-09-18T00:00:00.000Z', pricePerMtok: 0,
});

describe('the locales an app speaks', () => {
  it('the library has en-US (its default) and es; an app without locales speaks en-US alone', () => {
    expect(localesOf(libraryApp)).toEqual(['en-US', 'es']);
    expect(defaultLocaleOf(libraryApp)).toBe('en-US');
    expect(localesOf(testkitApp)).toEqual([DEFAULT_LOCALE]);
    expect(defaultLocaleOf(testkitApp)).toBe('en-US');
  });

  it('matches a requested locale to one of the app\'s: the same tag, the language alone, or the first in that language', () => {
    expect(matchLocale(libraryApp, 'es')).toBe('es');
    expect(matchLocale(libraryApp, 'es-US')).toBe('es');
    expect(matchLocale(libraryApp, 'ES_mx')).toBe('es');
    expect(matchLocale(libraryApp, 'en-us')).toBe('en-US');
    expect(matchLocale(libraryApp, 'en')).toBe('en-US');
    expect(matchLocale(libraryApp, 'en-GB')).toBe('en-US');
    expect(matchLocale(libraryApp, 'fr-FR')).toBeNull();
    expect(matchLocale(libraryApp, '  ')).toBeNull();
  });
});

describe('a session\'s locale', () => {
  it('is the app\'s default when the session starts with none', () => {
    const r = start();
    expect(r.session.locale).toBe('en-US');
    expect(localeOf(r.session)).toBe('en-US');
    expect(heard(r)).toBe('Thanks for calling Example Town Library. I can renew a book or check a hold. How can I help?');
  });

  it('is the one session.start asks for, matched to the app\'s (es-US and es both speak es)', () => {
    for (const asked of ['es-US', 'es']) {
      const r = start(startEvent({}, asked));
      expect(r.session.locale).toBe('es');
      expect(said(r)).toBe('Gracias por llamar a la Biblioteca de Example Town. Puedo renovar un libro o revisar una reserva. ¿En qué puedo ayudarle?');
      expect(r.session.lastPromptText).toBe(said(r));
    }
  });

  it('falls back to the default, without an error, for a locale the app does not speak', () => {
    const r = start(startEvent({}, 'fr-FR'));
    expect(r.session.locale).toBe('en-US');
    expect(heard(r)).toMatch(/^Thanks for calling Example Town Library\./);
  });

  it('is set from a ConversationRelay setup\'s custom parameter named locale', () => {
    const event = frameToEvent({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15555550100', to: '+15555550101', customParameters: { locale: 'es-US' } });
    expect(event).toEqual({ type: 'session.start', provider: { sessionId: 'VX1', callSid: 'CA1', from: '+15555550100', to: '+15555550101', 'param.locale': 'es-US' }, locale: 'es-US' });
    expect(start(event).session.locale).toBe('es');
    // no such parameter: no locale on the event at all
    expect(frameToEvent({ type: 'setup', sessionId: 'VX2', callSid: 'CA2', from: '+15555550100', to: '+15555550101', customParameters: {} })).not.toHaveProperty('locale');
  });

  it('carries a whole call in Spanish, a line es leaves out said in the default\'s words', () => {
    const opener = say(start(startEvent({}, 'es-US')), 'quiero saber si mi reserva de The Clockwork Garden llegó', {
      intent: choice({ check_hold: 0.95, none: 0.05 }), book: choice({ clockwork_garden: 0.9, none: 0.1 }),
    }, 'es-US');
    expect(opener.session.locale).toBe('es');
    expect(heard(opener)).toBe('Claro, puedo ayudarle a check a hold. ¿En qué sucursal está la reserva, Norte o Ribera?');
    const branch = say(opener, 'Norte', { ...ANSWERING, branch: choice({ north: 0.9, none: 0.1 }) }, 'es-US');
    // no_hold is not in locale/es/prompts.yaml: the manifest's line, then es's own anything_else; the
    // book and the branch are said in Spanish (locale/es/slots.yaml) even in the default's line
    expect(heard(branch)).toBe("I don't see a hold for El jardín de relojería at the Norte branch. ¿Hay algo más en que pueda ayudarle?");
    expect(said(branch)).toBe(heard(branch));
  });

  it('keeps a user.speech event\'s lang as the channel gave it, in the trace record beside the session\'s locale', () => {
    const first = start(startEvent({}, 'es'));
    const event = speechEvent('renovar un libro', true, 'es-US');
    const r = resolve(first.session, event, answers({ intent: choice({ renew_loan: 0.95, none: 0.05 }) }), tc);
    const rec = record(r, event);
    expect(rec.event).toEqual({ type: 'user.speech', text: 'renovar un libro', final: true, lang: 'es-US' });
    expect(rec.locale).toBe('es');
  });
});

describe('a line in a locale', () => {
  it('is the locale\'s own where it has one, the default\'s where it does not, and the manifest\'s for no locale or one the app lacks', () => {
    expect(localePromptEntry(libraryApp, 'goodbye', 'es')).toEqual({ entry: { text: 'Adiós.', interruptible: false }, localized: true });
    expect(localePromptEntry(libraryApp, 'no_hold', 'es')).toEqual({ entry: libraryApp.prompts.manifest.no_hold, localized: false });
    expect(localePromptEntry(libraryApp, 'goodbye', 'en-US')).toEqual({ entry: { text: 'Goodbye.', interruptible: false }, localized: false });
    expect(promptText(libraryApp, 'goodbye', {})).toBe('Goodbye.');
    expect(promptText(libraryApp, 'goodbye', {}, 'de')).toBe('Goodbye.');
    expect(() => promptText(libraryApp, 'no_such_line', {}, 'es')).toThrow('unknown prompt id: no_such_line');
  });

  it('is spoken by TTS where it is the locale\'s own: the clips are recordings of the default\'s lines', () => {
    const ctx: RenderContext = { clips: new Map(recordableClips(libraryApp).map((c) => [c.id, `${c.id}.mp3`])), audioBase: 'https://h/audio/' };
    const decision = prompt('ask_intent', 'intent');
    expect(decisionToActions(libraryApp, decision, ctx)).toEqual([{ type: 'say', parts: [{ audio: 'https://h/audio/ask_intent.0.mp3' }], interruptible: true, lang: 'en-US' }]);
    expect(decisionToActions(libraryApp, decision, ctx, 'es')).toEqual([{ type: 'say', parts: [{ text: '¿En qué puedo ayudarle hoy?' }], interruptible: true, lang: 'es' }]);
  });
});

describe('an app without locales is as it was', () => {
  const testkitTc: TurnContext = { ...tc, tools: { ...testkitApp.systems(), codes: mockCodeVerifier } };

  it('its session, its trace record and its lines carry no locale, whatever session.start asks for', () => {
    const fresh = newSession('kit', 0, VOICE_RELAY, ANONYMOUS, testkitApp.id);
    expect(fresh).not.toHaveProperty('locale');
    for (const event of [startEvent(), startEvent({}, 'es-US')]) {
      const r = resolve(fresh, event, null, testkitTc);
      expect(r.session).not.toHaveProperty('locale');
      expect(record(r, event)).not.toHaveProperty('locale');
      expect(spokenText(testkitApp, r.decision, 'es')).toBe(spokenText(testkitApp, r.decision));
    }
  });
});

describe('the console', () => {
  const turnEvent = (r: TurnResult, event: SessionEvent) => ({ type: 'turn' as const, callSid: 'CA1', at: 1, record: record(r, event), spoken: '' });
  const started = { type: 'call_started' as const, callSid: 'CA1', at: 0, from: '…0100', todayIso: '2026-09-18', thresholds: {}, channel: 'voice' };

  it('shows the session\'s locale for an app that declares locales', () => {
    configure(consoleMetaOf(libraryApp));
    const event = startEvent({}, 'es-US');
    expect(reduce([started, turnEvent(start(event), event)]).locale).toBe('es');
    const plain = startEvent();
    expect(reduce([started, turnEvent(start(plain), plain)]).locale).toBe('en-US');
    // a second call starts without the first call's locale
    expect(reduce([started, turnEvent(start(event), event), started])).not.toHaveProperty('locale');
  });

  it('shows none for an app without locales: the view has no locale', () => {
    configure(consoleMetaOf(testkitApp));
    const event = startEvent({}, 'es-US');
    const r = resolve(newSession('kit', 0, VOICE_RELAY, ANONYMOUS, testkitApp.id), event, null, { ...tc, tools: { ...testkitApp.systems(), codes: mockCodeVerifier } });
    expect(reduce([started, turnEvent(r, event)])).not.toHaveProperty('locale');
  });
});

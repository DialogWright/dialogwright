import { describe, expect, it } from 'vitest';
import { bareSpeechTags, bareTagFinding, englishOnlyFinding, englishOnlyHearings, hasRegion, hearsEnglishOnly, namesSpeechLanguages, speechLocalesOfFolder, type SpeechLocales } from './speechLanguages';
import { DEFAULT_RECOGNITION, ENGLISH_ONLY_MODELS } from './voiceProviders';

/**
 * What a carrier is sent of an app's languages, read from its speech settings (channel/speechLanguages.ts):
 * the live findings of 2026-10-13, a `<Language code="es">` Twilio refused and a Spanish language heard
 * with the start language's English-only Deepgram flux.
 */

/** The routed fixture as it was on the live call: en-US and es, no voice settings. */
const BARE: SpeechLocales = { defaultLocale: 'en-US', locales: ['en-US', 'es'] };
const REGIONAL: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es-US', transcription: 'es-US' } } } };

describe('a language tag with no region (bareSpeechTags)', () => {
  it('reads a region after the language, and after a script; never the language or a script alone', () => {
    for (const tag of ['en-US', 'es-US', 'es-419', 'zh-Hans-CN', 'pt-br']) expect(hasRegion(tag), tag).toBe(true);
    for (const tag of ['es', 'en', 'zh-Hans', 'fil']) expect(hasRegion(tag), tag).toBe(false);
  });

  it('finds the locale written as its own tag, spoken and heard, as on the live call', () => {
    expect(bareSpeechTags(BARE)).toEqual([
      { locale: 'es', field: 'tts', tag: 'es', own: false },
      { locale: 'es', field: 'transcription', tag: 'es', own: false },
    ]);
    expect(bareSpeechTags(REGIONAL)).toEqual([]);
  });

  it('finds a bare tag voice.locales names itself, and only the field that is bare', () => {
    const own: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es', transcription: 'es-MX' } } } };
    expect(bareSpeechTags(own)).toEqual([{ locale: 'es', field: 'tts', tag: 'es', own: true }]);
  });

  it('finds nothing where the document names no language: an app without locales, a one-locale en-US app', () => {
    expect(bareSpeechTags({ defaultLocale: 'en-US' })).toEqual([]);
    expect(bareSpeechTags({ defaultLocale: 'en-US', locales: ['en-US'] })).toEqual([]);
    expect(namesSpeechLanguages({ defaultLocale: 'en-US', locales: ['en-US'] })).toBe(false);
    // A one-locale app whose default is not en-US names it, so its own tag is written.
    expect(bareSpeechTags({ defaultLocale: 'fr', locales: ['fr'] }).map((b) => b.tag)).toEqual(['fr', 'fr']);
  });

  it('says what Twilio did with such a tag, and the fix by the locale\'s keys', () => {
    const f = bareTagFinding('es', bareSpeechTags(BARE));
    expect(f.message).toBe('the locale es is spoken and heard as "es" (its own tag: voice.locales.es names no tts or transcription), a language tag with no region: Twilio refused a start document with such a <Language> code on a live call (error 64101, and the caller heard "an application error has occurred"); whether Telnyx takes one is not known');
    expect(f.fix).toBe('set voice.locales.es.tts and voice.locales.es.transcription to a tag with its region, such as es-US or es-MX');
    expect(bareTagFinding('fr', [{ locale: 'fr', field: 'tts', tag: 'fr', own: true }])).toEqual({
      message: expect.stringContaining('the locale fr is spoken as "fr", a language tag with no region'),
      fix: 'set voice.locales.fr.tts to a tag with its region, such as fr-FR or fr-CA',
    });
  });
});

describe('a language heard by a recognizer that hears English only (englishOnlyHearings)', () => {
  it('keeps the list in one place: Deepgram\'s flux, as Twilio names it', () => {
    expect(ENGLISH_ONLY_MODELS).toEqual({ deepgram: ['flux'] });
    expect(DEFAULT_RECOGNITION.twilio).toEqual({ provider: 'Deepgram', model: 'flux' });
    expect(hearsEnglishOnly({ provider: 'Deepgram', model: 'flux' })).toBe(true);
    expect(hearsEnglishOnly({ provider: 'deepgram', model: 'FLUX' })).toBe(true);
    expect(hearsEnglishOnly({ model: 'flux' })).toBe(true);
    expect(hearsEnglishOnly({ provider: 'Deepgram', model: 'nova-3-general' })).toBe(false);
    expect(hearsEnglishOnly({ provider: 'Google', model: 'flux' })).toBe(false);
    expect(hearsEnglishOnly({ provider: 'Deepgram' })).toBe(false);
    expect(hearsEnglishOnly(undefined)).toBe(false);
  });

  it('finds a language with no recognizer of its own beside the start language\'s flux, as on the live call', () => {
    expect(englishOnlyHearings(REGIONAL)).toEqual([
      { locale: 'es', carrier: 'twilio', transcription: 'es-US', recognizer: { provider: 'Deepgram', model: 'flux' }, how: 'another', from: 'en-US', fromHow: 'deployment' },
    ]);
    // Its own recognizer, one that hears it: nothing.
    const own: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es-US', transcription: 'es-US', recognition: { twilio: { provider: 'Deepgram', model: 'nova-3-general' } } } } } };
    expect(englishOnlyHearings(own)).toEqual([]);
    // The server's model is another (TWILIO_SPEECH_MODEL=nova-3-general): nothing.
    expect(englishOnlyHearings(REGIONAL, () => ({ provider: 'Deepgram', model: 'nova-3-general' }))).toEqual([]);
  });

  it('reads a recognizer of its own that names no model as naming none: {} writes nothing on its <Language>, the live call\'s document', () => {
    const empty: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es-US', transcription: 'es-US', recognition: { twilio: {} } } } } };
    const [h] = englishOnlyHearings(empty);
    expect(h).toEqual({ locale: 'es', carrier: 'twilio', transcription: 'es-US', recognizer: { provider: 'Deepgram', model: 'flux' }, how: 'another', from: 'en-US', fromHow: 'deployment', ownWithoutModel: {} });
    expect(englishOnlyFinding(h!, true).message).toMatch(/^the locale es \(heard as es-US\) names an empty recognizer \(\{\}\), which writes nothing on its <Language>, on Twilio, while en-US is heard with Deepgram flux/);
    // A provider alone writes no speechModel: the same provider's English-only model may be kept, warned of;
    // another provider's would not be, so nothing.
    const deepgram: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es-US', transcription: 'es-US', recognition: { twilio: { provider: 'deepgram' } } } } } };
    expect(englishOnlyFinding(englishOnlyHearings(deepgram)[0]!, true).message).toContain('names the provider deepgram and no model on Twilio');
    const google: SpeechLocales = { ...BARE, voice: { locales: { es: { tts: 'es-US', transcription: 'es-US', recognition: { twilio: { provider: 'Google' } } } } } };
    expect(englishOnlyHearings(google)).toEqual([]);
    // A default locale with {} of its own takes nothing of the deployment's either.
    const spanishEmpty: SpeechLocales = { defaultLocale: 'es-US', locales: ['es-US'], voice: { locales: { 'es-US': { recognition: { twilio: {} } } } } };
    expect(englishOnlyHearings(spanishEmpty)).toEqual([]);
  });

  it('finds a locale whose own recognizer hears English only, on either carrier', () => {
    const own: SpeechLocales = { ...REGIONAL, voice: { locales: { es: { transcription: 'es-US', recognition: { telnyx: { provider: 'deepgram', model: 'flux' }, twilio: { provider: 'Deepgram', model: 'nova-3-general' } } } } } };
    expect(englishOnlyHearings(own)).toEqual([
      { locale: 'es', carrier: 'telnyx', transcription: 'es-US', recognizer: { provider: 'deepgram', model: 'flux' }, how: 'own' },
    ]);
    expect(englishOnlyFinding(englishOnlyHearings(own)[0]!, false)).toEqual({
      message: 'voice.locales.es.recognition.telnyx names deepgram flux, which hears English only, and the locale es is heard as es-US: its callers would not be understood, or Telnyx fails to connect the recognizer',
      fix: 'name a recognizer that hears es-US for the locale: voice.locales.es.recognition.telnyx: { provider: <one that hears it> }',
    });
  });

  it('finds a default locale other than English heard with the server\'s flux, and says the server may name another', () => {
    const spanish: SpeechLocales = { defaultLocale: 'es-US', locales: ['es-US'] };
    const [h] = englishOnlyHearings(spanish);
    expect(h).toEqual({ locale: 'es-US', carrier: 'twilio', transcription: 'es-US', recognizer: { provider: 'Deepgram', model: 'flux' }, how: 'deployment' });
    expect(englishOnlyFinding(h!, false).message).toBe('the default locale es-US is heard as es-US on Twilio with Deepgram flux (the server\'s, unless its TWILIO_SPEECH_MODEL names another), which hears English only');
    expect(englishOnlyFinding(h!, false).fix).toBe('name a recognizer that hears es-US for the locale: voice.locales.es-US.recognition.twilio: { provider: Deepgram, model: nova-3-general }; or set the server\'s TWILIO_SPEECH_MODEL to a model that hears it (pnpm diagnose reads the server\'s)');
    // With the server's settings read, they are the server's, said as such.
    expect(englishOnlyFinding(h!, true).message).toBe('the default locale es-US is heard as es-US on Twilio with Deepgram flux (the server\'s), which hears English only');
    // Only the carriers asked about.
    expect(englishOnlyHearings(spanish, undefined, ['telnyx'])).toEqual([]);
  });

  it('says nothing of English, of an app that names no language, or where no recognizer hears English only', () => {
    expect(englishOnlyHearings({ defaultLocale: 'en-US', locales: ['en-US', 'en-GB'] })).toEqual([]);
    expect(englishOnlyHearings({ defaultLocale: 'en-US' })).toEqual([]);
    expect(englishOnlyHearings(REGIONAL, () => ({}))).toEqual([]);
  });

  it('says the live call\'s finding for a language that names none', () => {
    const [h] = englishOnlyHearings(REGIONAL);
    expect(englishOnlyFinding(h!, true)).toEqual({
      message: 'the locale es (heard as es-US) names no recognizer of its own on Twilio, while en-US is heard with Deepgram flux (the server\'s), which hears English only: on a live Twilio call such a language was heard with the start language\'s flux after a switch, and Twilio failed to connect it',
      fix: 'name a recognizer that hears es-US for the locale: voice.locales.es.recognition.twilio: { provider: Deepgram, model: nova-3-general }',
    });
  });
});

describe('an app folder\'s languages (speechLocalesOfFolder)', () => {
  it('declares locales where app.yaml names one or a locale folder adds one, the default first', () => {
    expect(speechLocalesOfFolder({ defaultLocale: 'en-US', prompts: { 'en-US': {} }, app: {} })).toEqual({ defaultLocale: 'en-US' });
    expect(speechLocalesOfFolder({ defaultLocale: 'en-US', prompts: { 'en-US': {} }, app: { locale: 'en-US' } })).toEqual({ defaultLocale: 'en-US', locales: ['en-US'] });
    expect(speechLocalesOfFolder({ defaultLocale: 'en-US', prompts: { es: {}, 'en-US': {} }, app: { voice: { numbers: {} } } })).toEqual({ defaultLocale: 'en-US', locales: ['en-US', 'es'], voice: { numbers: {} } });
  });
});

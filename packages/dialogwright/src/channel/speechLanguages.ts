/**
 * What a carrier's start document will say of an app's languages, read from the app's speech settings
 * alone, so `pnpm check` (an app folder's YAML), `pnpm diagnose` (the folder and the server's settings)
 * and the server can each say what a carrier would refuse or mishear before a call does: a language tag
 * with no region, which Twilio refuses, and a language heard by a recognizer that hears English only.
 * Nothing here reads server code; the documents themselves are server/voice's.
 */
import { DEFAULT_RECOGNITION, ENGLISH_ONLY_MODELS, VOICE_PROVIDER_IDS, type VoiceProviderId } from './voiceProviders';
import type { Recognition } from '../core/app/types';

/** The locale of an app that declares none (core/locale.ts DEFAULT_LOCALE), here so this module reads no core state. */
const EN_US = 'en-US';

/** One locale's speech settings, as app.yaml's voice.locales.<tag> and App.voice.locales hold them. */
export interface SpeechLocaleSettings {
  readonly tts?: string;
  readonly transcription?: string;
  readonly recognition?: Readonly<Record<string, Recognition>>;
}

/** An app's languages as a start document reads them: the locales it speaks and its voice settings. */
export interface SpeechLocales {
  /** The default locale. */
  readonly defaultLocale: string;
  /** Every locale the app speaks, the default first; absent for an app that declares no locales (it names no language). */
  readonly locales?: readonly string[];
  readonly voice?: {
    readonly numbers?: Readonly<Record<string, string>>;
    readonly locales?: Readonly<Record<string, SpeechLocaleSettings>>;
  };
}

/**
 * An app folder's languages (define/load.ts LoadedConfig, structurally): the default locale, the others
 * that have a locale/<tag>/prompts.yaml, and app.yaml's voice. A folder with neither app.yaml's `locale:`
 * nor another locale declares none (defineApp gives its App no locales).
 */
export function speechLocalesOfFolder(config: {
  readonly defaultLocale: string;
  readonly prompts: Readonly<Record<string, unknown>>;
  readonly app: { readonly locale?: string; readonly voice?: SpeechLocales['voice'] };
}): SpeechLocales {
  const others = Object.keys(config.prompts).filter((l) => l !== config.defaultLocale);
  const declared = config.app.locale !== undefined || others.length > 0;
  return {
    defaultLocale: config.defaultLocale,
    ...(declared ? { locales: [config.defaultLocale, ...others] } : {}),
    ...(config.app.voice !== undefined ? { voice: config.app.voice } : {}),
  };
}

/** A built app's languages (App.locales, App.voice), structurally: its locales, the default first, and its voice. */
export function speechLocalesOfApp(app: {
  readonly locales?: { readonly default: string; readonly prompts: Readonly<Record<string, unknown>> };
  readonly voice?: SpeechLocales['voice'];
}): SpeechLocales {
  return {
    defaultLocale: app.locales?.default ?? EN_US,
    ...(app.locales !== undefined ? { locales: [app.locales.default, ...Object.keys(app.locales.prompts)] } : {}),
    ...(app.voice !== undefined ? { voice: app.voice } : {}),
  };
}

/**
 * Whether the start document names the app's languages (server/http.ts namesLanguages): an app with
 * locales that has more than one, or voice.locales or voice.numbers, or a default other than en-US. Any
 * other app's document names none, and the carrier speaks and hears its own default (en-US).
 */
export function namesSpeechLanguages(s: SpeechLocales): boolean {
  if (s.locales === undefined) return false;
  return s.locales.length > 1 || s.voice?.locales !== undefined || s.voice?.numbers !== undefined || s.defaultLocale !== EN_US;
}

function settingsOf(s: SpeechLocales, locale: string): SpeechLocaleSettings | undefined {
  const all = s.voice?.locales;
  return all !== undefined && Object.hasOwn(all, locale) ? all[locale] : undefined;
}

/** The languages a locale is spoken and heard in (core/locale.ts speechLanguagesOf): voice.locales' tts and transcription, else the locale's tag. */
export function speechTagsOf(s: SpeechLocales, locale: string): { tts: string; transcription: string } {
  const own = settingsOf(s, locale);
  return { tts: own?.tts ?? locale, transcription: own?.transcription ?? locale };
}

/**
 * Whether a language tag names a region (`es-US`, `es-419`): a subtag of two letters or three digits
 * after the language (and a script, `zh-Hans-CN`). `es` and `zh-Hans` have none.
 */
export function hasRegion(tag: string): boolean {
  return tag.split('-').slice(1).some((sub) => /^(?:[A-Za-z]{2}|\d{3})$/.test(sub));
}

/** Whether a language tag is English (`en`, `en-GB`). */
export function isEnglish(tag: string): boolean {
  return tag.split('-')[0]!.toLowerCase() === 'en';
}

/** A language tag the start document writes with no region: the locale's, which of its two languages, and whether voice.locales set it. */
export interface BareTag {
  readonly locale: string;
  readonly field: 'tts' | 'transcription';
  readonly tag: string;
  /** voice.locales.<locale> names it; false when it is the locale's own tag, taken for want of one. */
  readonly own: boolean;
}

/**
 * The languages the start document would write with no region (a `<Language code>`, Twilio's
 * `ttsLanguage` and `transcriptionLanguage`, Telnyx's `language`, and each text frame's `lang`): none for
 * an app whose document names no language. On a live Twilio call (2026-10-13) a `<Language code="es">`
 * made Twilio refuse the whole document (error 64101, "Error parsing twiml parameters in <Language>"),
 * and the caller heard "an application error has occurred"; `es-US` worked. Whether Telnyx takes such a
 * tag is not in its published pages, nor yet seen on a call.
 */
export function bareSpeechTags(s: SpeechLocales): BareTag[] {
  if (!namesSpeechLanguages(s)) return [];
  const out: BareTag[] = [];
  for (const locale of s.locales ?? []) {
    const own = settingsOf(s, locale);
    const tags = speechTagsOf(s, locale);
    for (const field of ['tts', 'transcription'] as const) {
      if (!hasRegion(tags[field])) out.push({ locale, field, tag: tags[field], own: own?.[field] !== undefined });
    }
  }
  return out;
}

/** Whether a recognizer names a model its provider documents as hearing English only (ENGLISH_ONLY_MODELS). */
export function hearsEnglishOnly(r: Recognition | undefined): boolean {
  if (r?.model === undefined) return false;
  const model = r.model.toLowerCase();
  const providers = r.provider === undefined ? Object.keys(ENGLISH_ONLY_MODELS) : [r.provider.toLowerCase()];
  return providers.some((p) => Object.hasOwn(ENGLISH_ONLY_MODELS, p) && ENGLISH_ONLY_MODELS[p]!.includes(model));
}

/** A recognizer in the carrier's own words: "Deepgram flux". */
export function recognizerName(r: Recognition): string {
  return [r.provider, r.model].filter((x) => x !== undefined).join(' ');
}

/**
 * A language heard by a recognizer that hears English only, on one carrier: the locale, the language it
 * is heard in, the recognizer, and how it comes to it:
 * - `own`: the locale's own (voice.locales.<tag>.recognition.<carrier>);
 * - `deployment`: the default locale's, from the server's settings (TWILIO_SPEECH_MODEL, default flux);
 * - `another`: the locale names none of its own, and the document names this one for another of the
 *   app's languages. On a live Twilio call (2026-10-13) a Spanish language with no recognizer of its own
 *   was heard with the start language's Deepgram flux after a switch, which Twilio failed to connect
 *   ("Error connecting to Deepgram Flux"); the engine's reconnect recovered the call.
 */
export interface EnglishOnlyHearing {
  readonly locale: string;
  readonly carrier: VoiceProviderId;
  readonly transcription: string;
  readonly recognizer: Recognition;
  readonly how: 'own' | 'deployment' | 'another';
  /** For `another`: the locale whose recognizer it is, and whether that locale names it or has the deployment's. */
  readonly from?: string;
  readonly fromHow?: 'own' | 'deployment';
  /** For `another`: the locale's own recognizer, when it has one that names no model (`{}`, or a provider alone). */
  readonly ownWithoutModel?: Recognition;
}

/**
 * The deployment's recognizer on each carrier, for the default locale: the server's settings
 * (server/config.ts recognitionFor), or, where they are not known (`pnpm check`), the carriers' defaults
 * the server writes when nothing is set (DEFAULT_RECOGNITION).
 */
export type DeploymentRecognition = (carrier: VoiceProviderId) => Recognition;

/**
 * Every language of the app other than English that a carrier would hear with a recognizer documented
 * as hearing English only (EnglishOnlyHearing): none for an app whose document names no language (the
 * carrier then hears en-US). `carriers` are the ones to look at: every carrier the engine has, or the
 * server's VOICE_PROVIDERS.
 */
export function englishOnlyHearings(
  s: SpeechLocales,
  deployment: DeploymentRecognition = (c) => DEFAULT_RECOGNITION[c],
  carriers: readonly VoiceProviderId[] = VOICE_PROVIDER_IDS,
): EnglishOnlyHearing[] {
  if (!namesSpeechLanguages(s)) return [];
  const locales = s.locales ?? [];
  const out: EnglishOnlyHearing[] = [];
  for (const carrier of carriers) {
    const ownOf = (locale: string): Recognition | undefined => {
      const own = settingsOf(s, locale)?.recognition;
      return own !== undefined && Object.hasOwn(own, carrier) ? own[carrier]! : undefined;
    };
    // The model each language's own element names (server/http.ts connectOptions): its own recognizer's,
    // else the deployment's for the default locale, else none. A recognizer of its own that names no model
    // names none: `{}` writes nothing on its <Language> (the live call's document), and a provider alone
    // writes no speechModel, so which model it is heard with is the carrier's to choose; it never falls to
    // the deployment's either (the app's recognizer wins as a whole).
    const named = (locale: string): { r: Recognition; how: 'own' | 'deployment' } | undefined => {
      const own = ownOf(locale);
      if (own !== undefined) return own.model !== undefined ? { r: own, how: 'own' } : undefined;
      if (locale === s.defaultLocale) {
        const d = deployment(carrier);
        if (d.model !== undefined) return { r: d, how: 'deployment' };
      }
      return undefined;
    };
    const englishOnly = locales.map((l) => ({ l, n: named(l) })).find((x) => x.n !== undefined && hearsEnglishOnly(x.n.r));
    for (const locale of locales) {
      const { transcription } = speechTagsOf(s, locale);
      if (isEnglish(transcription)) continue;
      const n = named(locale);
      if (n !== undefined) {
        if (hearsEnglishOnly(n.r)) out.push({ locale, carrier, transcription, recognizer: n.r, how: n.how });
        continue;
      }
      if (englishOnly === undefined) continue;
      // A provider of its own with no model: the English-only model is only kept if it is that provider's
      // (another provider's model would not be), so a provider of its own other than the English-only
      // recognizer's is taken as heard by that provider's default.
      const own = ownOf(locale);
      const theirs = englishOnly.n!.r.provider;
      if (own?.provider !== undefined && theirs !== undefined && own.provider.toLowerCase() !== theirs.toLowerCase()) continue;
      out.push({
        locale, carrier, transcription, recognizer: englishOnly.n!.r, how: 'another', from: englishOnly.l, fromHow: englishOnly.n!.how,
        ...(own !== undefined ? { ownWithoutModel: own } : {}),
      });
    }
  }
  return out;
}

/** The YAML that names a locale's recognizer on a carrier, as a fix says it: the model the guide's example uses on Twilio; on Telnyx, a provider. */
export function recognitionFix(locale: string, carrier: VoiceProviderId, transcription: string): string {
  const example = carrier === 'twilio' ? '{ provider: Deepgram, model: nova-3-general }' : '{ provider: <one that hears it> }';
  return `name a recognizer that hears ${transcription} for the locale: voice.locales.${locale}.recognition.${carrier}: ${example}`;
}

/** A carrier's name as a person writes it. */
const CARRIER_NAMES: Readonly<Record<VoiceProviderId, string>> = { twilio: 'Twilio', telnyx: 'Telnyx' };

/** A tag with a region in place of a bare one, for a fix: `es-US or es-MX` for Spanish, else the language and `-<region>`. */
function regionalExample(tag: string): string {
  const language = tag.split('-')[0]!.toLowerCase();
  if (language === 'es') return 'es-US or es-MX';
  if (language === 'en') return 'en-US or en-GB';
  if (language === 'pt') return 'pt-BR or pt-PT';
  if (language === 'fr') return 'fr-FR or fr-CA';
  return `${language}-<region>`;
}

/**
 * One locale's bare tags (bareSpeechTags), said once: what is written, what Twilio did with such a tag,
 * and the fix. The same words for `pnpm check`, `pnpm diagnose` and the server.
 */
export function bareTagFinding(locale: string, bare: readonly BareTag[]): { message: string; fix: string } {
  const fields = bare.map((b) => b.field);
  const tag = bare[0]!.tag;
  const which = fields.length === 2 ? 'spoken and heard' : fields[0] === 'tts' ? 'spoken' : 'heard';
  const from = bare.every((b) => !b.own) ? ` (its own tag: voice.locales.${locale} names no ${fields.join(' or ')})` : '';
  const keys = fields.map((f) => `voice.locales.${locale}.${f}`).join(' and ');
  // The tts tag is the <Language> code, the attribute Twilio refused; a transcription tag alone is unproven.
  const seen = fields.includes('tts')
    ? 'Twilio refused a start document with such a <Language> code on a live call (error 64101, and the caller heard "an application error has occurred"); whether Telnyx takes one is not known'
    : 'Twilio refused such a tag as a <Language> code on a live call (error 64101); as the language heard in (transcriptionLanguage) it is not yet seen on a call, on Twilio or on Telnyx';
  return {
    message: `the locale ${locale} is ${which} as "${tag}"${from}, a language tag with no region: ${seen}`,
    fix: `set ${keys} to a tag with its region, such as ${regionalExample(tag)}`,
  };
}

/**
 * A language heard by a recognizer that hears English only (englishOnlyHearings), said once. `known` is
 * whether the server's own settings were read (`pnpm diagnose`, the server); without them (`pnpm check`)
 * the deployment's recognizer is the server's default, which its settings may change.
 */
export function englishOnlyFinding(h: EnglishOnlyHearing, known: boolean): { message: string; fix: string } {
  const carrier = CARRIER_NAMES[h.carrier];
  const name = recognizerName(h.recognizer);
  const serverVar = h.carrier === 'twilio' ? 'TWILIO_SPEECH_MODEL' : 'TELNYX_TRANSCRIPTION_PROVIDER';
  // Whose recognizer it is, in brackets after its name, when it is the server's.
  const servers = known ? ' (the server\'s)' : ` (the server's, unless its ${serverVar} names another)`;
  const ownFix = recognitionFix(h.locale, h.carrier, h.transcription);
  switch (h.how) {
    case 'own':
      return {
        message: `voice.locales.${h.locale}.recognition.${h.carrier} names ${name}, which hears English only, and the locale ${h.locale} is heard as ${h.transcription}: its callers would not be understood, or ${carrier} fails to connect the recognizer`,
        fix: ownFix,
      };
    case 'deployment':
      return {
        message: `the default locale ${h.locale} is heard as ${h.transcription} on ${carrier} with ${name}${servers}, which hears English only`,
        fix: `${ownFix}; or set the server's ${serverVar} to a model that hears it${known ? '' : ' (pnpm diagnose reads the server\'s)'}`,
      };
    case 'another':
      return {
        message: `the locale ${h.locale} (heard as ${h.transcription}) names ${h.ownWithoutModel === undefined ? 'no recognizer of its own' : h.ownWithoutModel.provider === undefined ? 'an empty recognizer ({}), which writes nothing on its <Language>,' : `the provider ${h.ownWithoutModel.provider} and no model`} on ${carrier}, while ${h.from} is heard with ${name}${h.fromHow === 'deployment' ? servers : ''}, which hears English only: on a live Twilio call such a language was heard with the start language's flux after a switch, and Twilio failed to connect it`,
        fix: ownFix,
      };
  }
}

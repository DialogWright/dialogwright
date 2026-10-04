/** The XML helpers every carrier's documents share (TwiML and TeXML are the same shape). */
import type { RelayLanguage, StartDocumentOptions } from './provider';
import type { Recognition } from '../../core/app/types';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A whole document: the XML declaration and one `<Response>` around `body`. */
export function xmlResponse(body: string): string {
  return `${XML_HEAD}<Response>${body}</Response>`;
}

/** A form-encoded body's fields; a repeated key keeps its last value, as the carriers send none. */
export function formFields(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

/** An attribute, its value escaped. */
export function attr(name: string, value: string): string {
  return `${name}="${escapeXml(value)}"`;
}

/** How a carrier's start document writes a language's settings (placeLanguages). */
export interface LanguageShape {
  /** The carrier names a voice's TTS provider apart from the voice (Twilio's `ttsProvider`). */
  readonly ttsProvider: boolean;
  /** The relay element itself takes a speech model (Twilio's `speechModel`); Telnyx's takes one only on `<Language>`. */
  readonly relayModel: boolean;
}

/** A language's voice: what the relay element or its `<Language>` child says it with. */
interface VoiceSettings {
  readonly ttsProvider?: string;
  readonly voice?: string;
}

/** Where a start document writes each language's settings, and the `<Language>` and `<Parameter>` children. */
export interface PlacedLanguages {
  /** The voice on the relay element: the call's, when every language has the same one; else none. */
  readonly voice: VoiceSettings;
  /** The recognizer on the relay element: the call's, when every language has the same one; else none. */
  readonly recognition: Recognition;
  /** One `<Language>` per language the call may switch to (once each, by its tts language), then one `<Parameter>` per custom parameter. */
  readonly children: string[];
}

/** The attributes for a recognizer: its provider, then its model where the element takes one. */
export function recognitionAttrs(r: Recognition, withModel = true): string[] {
  return [
    ...(r.provider !== undefined ? [attr('transcriptionProvider', r.provider)] : []),
    ...(withModel && r.model !== undefined ? [attr('speechModel', r.model)] : []),
  ];
}

/**
 * Where a start document writes its languages' voices and recognizers. A `<Language>` child inherits
 * every setting it leaves out from the relay element (Twilio's ConversationRelay reference: "The
 * attributes of the `<Language>` noun override attributes of the parent"), so a language whose
 * settings are the carrier's default could only get them if the relay element names none. Each kind
 * of setting (the voice; the recognizer) therefore goes on the relay element only when every language
 * has the same, and otherwise on each `<Language>` child, its own or none: a language without a
 * voice or recognizer of its own then gets the carrier's default for it, never another language's
 * (an English voice, or a recognizer chosen for English). This relies on the carrier applying a
 * `<Language>` child's settings whenever its language is in use, the call's first language included,
 * which is what "map a language code to a set of text-to-speech and speech-to-text settings" says.
 * Without `language` (an app that names no language) nothing is placed and only the parameters remain.
 */
export function placeLanguages(o: StartDocumentOptions, shape: LanguageShape): PlacedLanguages {
  const seen = new Set<string>();
  const languages = (o.languages ?? []).filter((l) => !seen.has(l.tts) && seen.add(l.tts));
  const voiceOf = (l: RelayLanguage): VoiceSettings =>
    l.voice === undefined ? {} : { ...(shape.ttsProvider && l.ttsProvider !== undefined ? { ttsProvider: l.ttsProvider } : {}), voice: l.voice };
  const recognitionOf = (l: RelayLanguage): Recognition => ({
    ...(l.recognition?.provider !== undefined ? { provider: l.recognition.provider } : {}),
    ...(l.recognition?.model !== undefined ? { model: l.recognition.model } : {}),
  });
  const start = o.language;
  const all = start === undefined ? languages : [start, ...languages];
  const shared = <T>(of: (l: RelayLanguage) => T): boolean => start !== undefined && all.every((l) => JSON.stringify(of(l)) === JSON.stringify(of(start)));
  const voiceShared = shared(voiceOf);
  // A relay element that takes no model cannot hold a recognizer that names one.
  const recognitionShared = shared(recognitionOf) && (shape.relayModel || start?.recognition?.model === undefined);
  const children = languages.map((l) => {
    const v = voiceShared ? {} : voiceOf(l);
    const attrs = [
      attr('code', l.tts),
      ...(v.ttsProvider !== undefined ? [attr('ttsProvider', v.ttsProvider)] : []),
      ...(v.voice !== undefined ? [attr('voice', v.voice)] : []),
      ...(recognitionShared ? [] : recognitionAttrs(recognitionOf(l))),
    ];
    return `<Language ${attrs.join(' ')}/>`;
  });
  return {
    voice: voiceShared && start !== undefined ? voiceOf(start) : {},
    recognition: recognitionShared && start !== undefined ? recognitionOf(start) : {},
    children: [...children, ...Object.entries(o.parameters ?? {}).map(([name, value]) => `<Parameter ${attr('name', name)} ${attr('value', value)}/>`)],
  };
}

/** `<ConversationRelay>` with `attrs`, closed on itself when it has no children (the document before languages, byte for byte). */
export function relayElement(attrs: readonly string[], children: readonly string[]): string {
  return children.length === 0
    ? `<ConversationRelay ${attrs.join(' ')}/>`
    : `<ConversationRelay ${attrs.join(' ')}>${children.join('')}</ConversationRelay>`;
}

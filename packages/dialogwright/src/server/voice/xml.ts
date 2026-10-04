/** The XML helpers every carrier's documents share (TwiML and TeXML are the same shape). */
import type { StartDocumentOptions } from './provider';

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

/**
 * The relay element's children, in both carriers' shape: one `<Language>` per language the call may
 * switch to (named by its tts language, once each, with its voice; its TTS provider too where the
 * carrier names one apart from the voice), then one `<Parameter>` per custom parameter.
 */
export function relayChildren(o: StartDocumentOptions, withTtsProvider: boolean): string[] {
  const seen = new Set<string>();
  const languages = (o.languages ?? []).filter((l) => !seen.has(l.tts) && seen.add(l.tts));
  return [
    ...languages.map((l) => {
      const attrs = [attr('code', l.tts)];
      if (l.voice) {
        if (withTtsProvider && l.ttsProvider) attrs.push(attr('ttsProvider', l.ttsProvider));
        attrs.push(attr('voice', l.voice));
      }
      return `<Language ${attrs.join(' ')}/>`;
    }),
    ...Object.entries(o.parameters ?? {}).map(([name, value]) => `<Parameter ${attr('name', name)} ${attr('value', value)}/>`),
  ];
}

/** `<ConversationRelay>` with `attrs`, closed on itself when it has no children (the document before languages, byte for byte). */
export function relayElement(attrs: readonly string[], children: readonly string[]): string {
  return children.length === 0
    ? `<ConversationRelay ${attrs.join(' ')}/>`
    : `<ConversationRelay ${attrs.join(' ')}>${children.join('')}</ConversationRelay>`;
}

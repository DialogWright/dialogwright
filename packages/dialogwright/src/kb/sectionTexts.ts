import { collapseWhitespace } from './hash';
import { textHash, type IndexText } from './words';
import type { KnowledgeBase } from './types';

/**
 * The sections of approved documents that may be summarized (kb.yaml documents), and the texts the
 * index embeds for them: see ./sections.ts, which nominates them. Apart from it so the index
 * (./vectorIndex.ts) reads them without importing the retrievers.
 */

/** The value a topic slot fills with when sections answer (kb.yaml documents): `sections:` and their keys, joined by `|`. */
export const SECTIONS_VALUE_PREFIX = 'sections:';

/** The section keys a topic slot's value names, or null when it names a topic. */
export function sectionKeysOf(value: string): string[] | null {
  return value.startsWith(SECTIONS_VALUE_PREFIX) ? value.slice(SECTIONS_VALUE_PREFIX.length).split('|').filter((k) => k !== '') : null;
}

/** A section's key, as a nomination and the trace name it: `<document id>#<section id>`. */
export const sectionKeyOf = (document: string, section: string): string => `${document}#${section}`;

/** The document and section a key names, or null when it names none. */
export function sectionOfKey(key: string): { document: string; section: string } | null {
  const at = key.indexOf('#');
  if (at <= 0 || at === key.length - 1) return null;
  return { document: key.slice(0, at), section: key.slice(at + 1) };
}

/** One section that may be answered from by summarizing. */
export interface KbSection {
  /** `<document>#<section>`. */
  readonly key: string;
  readonly document: string;
  /** The document's title. */
  readonly documentTitle: string;
  readonly section: string;
  /** Its heading, else its id. */
  readonly heading: string;
  /** Its text, whitespace collapsed. */
  readonly text: string;
  /** Which callers it is for: the document's applies (canonical); absent, every caller. */
  readonly applies?: Readonly<Record<string, readonly string[]>>;
}

/** Whether summarizing is on for this knowledge base (kb.yaml documents.summarize). */
export const summarizing = (kb: Pick<KnowledgeBase, 'settings'>): boolean => kb.settings?.documents?.summarize === 'on';

/**
 * The sections that may be summarized (`approved`: true, the default), or every section the index
 * holds a vector for (`approved: false`: any document's, approved or not), in document then file
 * order. None when summarizing is off.
 */
export function summarizableSections(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages'>, options: { approved?: boolean } = {}): KbSection[] {
  if (!summarizing(kb)) return [];
  const approved = options.approved ?? true;
  const cited = new Set(Object.values(kb.passages).map((p) => sectionKeyOf(p.source.document, p.source.section)));
  const out: KbSection[] = [];
  for (const doc of Object.values(kb.sources)) {
    if (doc.summarize === false || (approved && doc.freshness !== 'fresh')) continue;
    for (const [id, s] of Object.entries(doc.sections)) {
      const key = sectionKeyOf(doc.id, id);
      if (s.summarize === false || cited.has(key)) continue;
      out.push({ key, document: doc.id, documentTitle: doc.document, section: id, heading: collapseWhitespace(s.heading ?? id.replace(/^[\d.]+\s+/, '')), text: collapseWhitespace(s.text), ...(doc.applies !== undefined ? { applies: doc.applies } : {}) });
    }
  }
  return out;
}

/** Why no answer may be drawn from sections: one is not (or no longer) summarizable, none is for this caller, or the call is in another language. */
export type SectionsUnavailable = 'unknown-topic' | 'stale' | 'no-facts' | 'no-translation';

/**
 * The sections named by `keys` as they may be summarized now for a caller with these facts, in the
 * language of the call: each must still be summarizable (its document approved and unchanged, not cited,
 * not left out), its document must apply to the caller (each fact its applies names must match), and the
 * call must be in the knowledge base's default language (sections are not translated). Those that hold, in
 * the order given; or why none does.
 */
export function resolveSections(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages' | 'defaultLocale'>, keys: readonly string[], facts: Readonly<Record<string, string | undefined>>, locale: string): { sections: KbSection[] } | { unavailable: SectionsUnavailable } {
  const language = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';
  if (language(locale) !== language(kb.defaultLocale)) return { unavailable: 'no-translation' };
  const now = new Map(summarizableSections(kb).map((s) => [s.key, s]));
  const named = keys.map((k) => now.get(k)).filter((s): s is KbSection => s !== undefined);
  if (named.length === 0) return { unavailable: keys.some((k) => summarizableSections(kb, { approved: false }).some((s) => s.key === k)) ? 'stale' : 'unknown-topic' };
  const forCaller = named.filter((s) => Object.entries(s.applies ?? {}).every(([fact, values]) => {
    const value = Object.hasOwn(facts, fact) ? facts[fact] : undefined;
    return value !== undefined && values.includes(value);
  }));
  return forCaller.length > 0 ? { sections: forCaller } : { unavailable: 'no-facts' };
}

/** A section's sentences: where a sentence ends (., ? or ! and a space before a capital or a digit), whitespace collapsed. */
export function sentencesOf(text: string): string[] {
  return collapseWhitespace(text)
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The texts the index embeds for the sections (field `section`, keyed by the section's key, in the
 * default locale): each section's heading and each of its sentences, so a question matches the
 * sentence that answers it. Sections are in the default locale only.
 */
export function sectionIndexTexts(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages' | 'defaultLocale'>): IndexText[] {
  const out = new Map<string, IndexText>();
  for (const s of summarizableSections(kb, { approved: false })) {
    for (const raw of [s.heading, ...sentencesOf(s.text)]) {
      const text = collapseWhitespace(raw);
      if (text === '') continue;
      const contentHash = textHash(text);
      out.set(`${s.key}\u0000${contentHash}`, { topic: s.key, locale: kb.defaultLocale, field: 'section', text, contentHash });
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort((a, b) => cmp(a.topic, b.topic) || cmp(a.contentHash, b.contentHash));
}


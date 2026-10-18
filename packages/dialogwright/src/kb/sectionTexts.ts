import { collapseWhitespace } from './hash';
import { applyGlossary, type Glossary } from './glossary';
import { textHash, type IndexText, type TopicField } from './words';
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
  /**
   * Its heading after the headings it is under ("Mental health services: Office visits"), for a
   * section whose id is a path (`mental-health-services/office-visits`, as kb:ingest writes one under
   * a heading): each parent's heading, or its id's words where the parent has no section of its own.
   * Its heading alone for a section at the top. The index and the section question read it.
   */
  readonly path: string;
  /** Its text, whitespace collapsed. */
  readonly text: string;
  /**
   * Its sentences, each paragraph's and each line's apart (a table's row, a list's item, as kb:ingest
   * writes them one to a line): what the index embeds and keywords read, so a question matches the row
   * that answers it rather than every row of a table at once.
   */
  readonly sentences: readonly string[];
  /** The questions callers ask that it answers, and its keywords (kb/sections.yaml): what retrieval reads beside its text. */
  readonly asks: readonly string[];
  readonly keywords: readonly string[];
  /** Which callers it is for: the document's applies (canonical); absent, every caller. */
  readonly applies?: Readonly<Record<string, readonly string[]>>;
}

/** A path id's words, where no section of its own gives its heading: "settlement-of-disputes" is "Settlement of disputes". */
function wordsOfId(segment: string): string {
  const words = segment.replace(/-\d+$/, '').replace(/-/g, ' ').trim();
  return words === '' ? segment : words[0]!.toUpperCase() + words.slice(1);
}

/** A section's heading after the headings of the sections its id is under (see KbSection.path). */
function pathOf(sections: Readonly<Record<string, { readonly heading?: string | undefined }>>, id: string, heading: string, glossary?: Glossary): string {
  const parts = id.split('/');
  if (parts.length < 2) return heading;
  const above = parts.slice(0, -1).map((segment, i) => {
    const parent = sections[parts.slice(0, i + 1).join('/')];
    return applyGlossary(collapseWhitespace(parent?.heading ?? wordsOfId(segment)), glossary);
  });
  return [...above, heading].join(': ');
}

/** Whether summarizing is on for this knowledge base (kb.yaml documents.summarize). */
export const summarizing = (kb: Pick<KnowledgeBase, 'settings'>): boolean => kb.settings?.documents?.summarize === 'on';

/**
 * The sections that may be summarized (`approved`: true, the default), or every section the index
 * holds a vector for (`approved: false`: any document's, approved or not), in document then file
 * order. None when summarizing is off.
 */
export function summarizableSections(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages'> & Partial<Pick<KnowledgeBase, 'sectionHints' | 'glossary'>>, options: { approved?: boolean } = {}): KbSection[] {
  if (!summarizing(kb)) return [];
  const approved = options.approved ?? true;
  const cited = new Set(Object.values(kb.passages).map((p) => sectionKeyOf(p.source.document, p.source.section)));
  const out: KbSection[] = [];
  for (const doc of Object.values(kb.sources)) {
    if (doc.summarize === false || (approved && doc.freshness !== 'fresh')) continue;
    for (const [id, s] of Object.entries(doc.sections)) {
      const key = sectionKeyOf(doc.id, id);
      if (s.summarize === false || cited.has(key)) continue;
      // The glossary's words in place of the document's jargon (./glossary.ts): what callers hear, and what the approval covers.
      const said = (x: string): string => applyGlossary(x, kb.glossary);
      const heading = said(collapseWhitespace(s.heading ?? id.replace(/^[\d.]+\s+/, '')));
      const text = said(s.text);
      out.push({ key, document: doc.id, documentTitle: doc.document, section: id, heading, path: pathOf(doc.sections, id, heading, kb.glossary), text: collapseWhitespace(text), sentences: text.split(/\n+/).flatMap(sentencesOf), asks: kb.sectionHints?.[key]?.asks ?? [], keywords: kb.sectionHints?.[key]?.keywords ?? [], ...(doc.applies !== undefined ? { applies: doc.applies } : {}) });
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
 * default locale): each section's heading after the headings it is under (KbSection.path) and each
 * of its sentences (field `section`), and the questions and keywords kb/sections.yaml gives it (`ask`,
 * `keyword`), so a question matches the
 * sentence that answers it. Sections are in the default locale only.
 */
export function sectionIndexTexts(kb: Pick<KnowledgeBase, 'settings' | 'sources' | 'passages' | 'defaultLocale'> & Partial<Pick<KnowledgeBase, 'sectionHints' | 'glossary'>>): IndexText[] {
  const out = new Map<string, IndexText>();
  for (const s of summarizableSections(kb, { approved: false })) {
    const fields: [TopicField, readonly string[]][] = [['section', [s.path, ...s.sentences]], ['ask', s.asks], ['keyword', s.keywords]];
    for (const [field, texts] of fields) {
      for (const raw of texts) {
        const text = collapseWhitespace(raw);
        if (text === '') continue;
        const contentHash = textHash(text);
        out.set(`${s.key}\u0000${field}\u0000${contentHash}`, { topic: s.key, locale: kb.defaultLocale, field, text, contentHash });
      }
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort((a, b) => cmp(a.topic, b.topic) || cmp(a.contentHash, b.contentHash));
}


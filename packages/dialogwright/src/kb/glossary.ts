/**
 * A knowledge base's glossary (kb/glossary.yaml): the words a document uses that callers would not
 * know ("CYD", "Non-Participating Provider") and the words they hear in their place ("calendar year
 * deductible", "out-of-network provider"). It is applied to the sections of documents answered from by
 * summarizing (kb.yaml documents): what the wording model, the section question, the index and the
 * fallback opening read. A source file keeps the document's own words (its provenance, a refresh), and
 * an approved passage is said as approved, never replaced.
 *
 * A term matches as a whole word or phrase (a hyphen joins words: "Participating Provider" is not found
 * in "Non-Participating Provider"), its case as written ("CYD", not "cyd"), and a longer term
 * before a shorter one it contains, in one pass: what a replacement says is never replaced again.
 */

/** The glossary as read: each term and what is said in its place, longest term first. */
export type Glossary = readonly (readonly [term: string, say: string])[];

/** kb/glossary.yaml's map as the glossary, longest term first (ties by the term). */
export function glossaryOf(map: Readonly<Record<string, string>>): Glossary {
  return Object.entries(map).sort(([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patterns = new WeakMap<Glossary, RegExp | null>();

/** `text` with each term of `glossary` said in its words; the text itself when there is none. */
export function applyGlossary(text: string, glossary: Glossary | undefined): string {
  if (glossary === undefined || glossary.length === 0) return text;
  let pattern = patterns.get(glossary);
  if (pattern === undefined) {
    pattern = new RegExp(`(?<![\\p{L}\\p{N}-])(?:${glossary.map(([term]) => escape(term)).join('|')})(?![\\p{L}\\p{N}-])`, 'gu');
    patterns.set(glossary, pattern);
  }
  const said = new Map(glossary);
  return text.replace(pattern!, (term) => said.get(term) ?? term);
}

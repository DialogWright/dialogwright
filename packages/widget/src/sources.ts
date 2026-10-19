import type { SaySource } from './protocol';
import type { WidgetStrings } from './strings';

/**
 * Where a knowledge answer's words come from (a `say`'s `sources`, the app's chat.sources): read from the
 * wire (only well-formed sources: a title, and a heading and a page where given), and said as one line
 * under the answer, "Source: Benefit Booklet · Emergency Services · p. 32", in the widget's own words.
 */

/** The sources of a `say` as the client hands them on: `{ sources }` with those well formed, or nothing. */
export function sourcesField(value: unknown): { sources?: SaySource[] } {
  if (!Array.isArray(value)) return {};
  const sources = value.flatMap((v): SaySource[] => {
    if (typeof v !== 'object' || v === null) return [];
    const { document, section, page } = v as Record<string, unknown>;
    if (typeof document !== 'string' || document.trim() === '') return [];
    return [{ document, ...(typeof section === 'string' && section.trim() !== '' ? { section } : {}), ...(typeof page === 'number' && Number.isInteger(page) && page > 0 ? { page } : {}) }];
  });
  return sources.length > 0 ? { sources } : {};
}

/**
 * The line under an answer: each document once, its sections after it ("Source: Benefit Booklet · Emergency
 * Services, p. 7"; "Sources: Benefit Booklet · Deductibles, p. 4; Notes, p. 14"), documents joined by " | ".
 */
export function sourcesText(sources: readonly SaySource[], s: Pick<WidgetStrings, 'source' | 'sources' | 'page'>): string {
  const byDocument = new Map<string, string[]>();
  for (const x of sources) {
    const part = x.section === undefined ? (x.page !== undefined ? `${s.page} ${x.page}` : '') : x.page !== undefined ? `${x.section}, ${s.page} ${x.page}` : x.section;
    const parts = byDocument.get(x.document) ?? [];
    if (part !== '' && !parts.includes(part)) parts.push(part);
    byDocument.set(x.document, parts);
  }
  const shown = [...byDocument].map(([document, parts]) => (parts.length === 0 ? document : `${document} · ${parts.join('; ')}`));
  const several = [...byDocument.values()].reduce((n, parts) => n + Math.max(1, parts.length), 0) > 1;
  return `${several ? s.sources : s.source} ${shown.join(' | ')}`;
}

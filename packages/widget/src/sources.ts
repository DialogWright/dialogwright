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

/** The line under an answer: "Source: <document> · <section> · p. <page>", several joined by "; ". */
export function sourcesText(sources: readonly SaySource[], s: Pick<WidgetStrings, 'source' | 'sources' | 'page'>): string {
  const each = sources.map((x) => [x.document, x.section, x.page !== undefined ? `${s.page} ${x.page}` : undefined].filter((p): p is string => p !== undefined).join(' · '));
  return `${sources.length === 1 ? s.source : s.sources} ${[...new Set(each)].join('; ')}`;
}

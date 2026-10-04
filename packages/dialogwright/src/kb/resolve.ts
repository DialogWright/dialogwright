import type { KbPassage, KbResolution, KnowledgeBase } from './types';

/**
 * Finds the one passage to say for a topic, a caller and a day, or says why there is none.
 *
 *   resolvePassage(kb, { topic: 'late_fees', facts: { card: 'junior' }, todayIso: '2026-10-03', locale: 'es' })
 *
 * In order:
 *  1. the topic: one the knowledge base does not have is `unknown-topic`;
 *  2. the caller: a passage answers when, for every fact its `applies` names, the caller's fact is
 *     one of its values (a fact it does not name: any value; a fact the caller lacks: no match).
 *     The facts come from the caller of this function, the gated tool that read them from the
 *     system of record, never from what the caller said;
 *  3. the day: `effective.from <= today <= effective.to`, both inclusive (no `to`: open-ended);
 *  4. the locale: the passages of the caller's locale (letter case aside); when none answers and
 *     the locale is not the default, the default locale's if kb.yaml's `localeFallback` is
 *     `default`, else `no-translation` when the default locale has one and `not-in-force` when not;
 *  5. exactly one: none is `not-in-force`, more than one is `ambiguous` (a `check` refuses the
 *     overlapping ranges that cause it);
 *  6. fresh: approved, with its source text and its approved content as they were at approval. A
 *     passage that is not is withheld: `stale`, with the passage, so the trace can show it.
 *
 * Pure: the same knowledge base and input give the same answer.
 */
export interface ResolveInput {
  readonly topic: string;
  /** The caller's facts for the applies domain (kb.yaml `applies`), read by the gated tool. */
  readonly facts: Readonly<Record<string, string | undefined>>;
  /** The day, as an ISO date (YYYY-MM-DD). */
  readonly todayIso: string;
  /** The caller's locale; default: the knowledge base's default locale. */
  readonly locale?: string;
}

export function resolvePassage(kb: KnowledgeBase, input: ResolveInput): KbResolution {
  if (!Object.hasOwn(kb.topics, input.topic)) return { unavailable: 'unknown-topic' };
  const locale = input.locale ?? kb.defaultLocale;
  const inForce = Object.values(kb.passages).filter((p) => p.topic === input.topic && answers(p, input.facts) && inForceOn(p, input.todayIso));
  const ofLocale = (tag: string): KbPassage[] => inForce.filter((p) => p.locale.toLowerCase() === tag.toLowerCase());
  let found = ofLocale(locale);
  if (found.length === 0 && locale.toLowerCase() !== kb.defaultLocale.toLowerCase()) {
    const fallback = ofLocale(kb.defaultLocale);
    if (kb.settings.localeFallback === 'default') found = fallback;
    else if (fallback.length > 0) return { unavailable: 'no-translation' };
  }
  if (found.length === 0) return { unavailable: 'not-in-force' };
  if (found.length > 1) return { unavailable: 'ambiguous' };
  const passage = found[0]!;
  return passage.freshness === 'fresh' ? { passage, fresh: true } : { unavailable: 'stale', passage };
}

/** Whether a passage answers a caller with these facts. */
export function answers(p: KbPassage, facts: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(p.applies).every(([fact, values]) => {
    const value = Object.hasOwn(facts, fact) ? facts[fact] : undefined;
    return value !== undefined && values.includes(value);
  });
}

/** Whether a passage is in force on a day (ISO dates compare as text). */
export function inForceOn(p: KbPassage, dayIso: string): boolean {
  return p.effective.from <= dayIso && (p.effective.to === undefined || dayIso <= p.effective.to);
}

/**
 * How retrieval scores are compared: rounded to a millionth first, so two scores that differ only in
 * the last bits of a floating-point sum (from a different order of additions, or a machine that
 * rounds differently) compare as equal, and the tie goes to the topic id. A nomination's score is
 * the rounded one.
 */
export const SCORE_STEP = 1e6;

/** A score rounded to a millionth (and -0 made 0). */
export function roundScore(score: number): number {
  const r = Math.round(score * SCORE_STEP) / SCORE_STEP;
  return r === 0 ? 0 : r;
}

/** Best first by score, then by topic id (code-unit order, as the index's entries are sorted). */
export function byScoreThenTopic(a: { readonly score: number; readonly topic: string }, b: { readonly score: number; readonly topic: string }): number {
  return b.score - a.score || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0);
}

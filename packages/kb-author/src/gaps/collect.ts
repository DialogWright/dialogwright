/**
 * What counts as a gap, found turn by turn in the traces: the engine's (dialogwright kb/gaps.ts), so the
 * console's Insights and Knowledge pages count the gaps this command ranks, by the same rules. The rules
 * are said there.
 */
export { collectGaps, looksLikeQuestion, topicQuestionOf, GAP_KINDS, QUESTION_WORDS } from 'dialogwright';
export type { GapCollectContext as CollectContext, GapCollectStats as CollectStats, Gap, GapKind, GapNear as Near, GapUnavailable as Unavailable } from 'dialogwright';

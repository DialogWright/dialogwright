import type { TraceRecord } from '../trace/types';

/**
 * Whether a turn said a generated line (TraceRecord.render), or a knowledge answer's hold line (its
 * `hold`): then its actions hold the words said, and its decision the fixed lines they stand for. On every
 * other turn the decision's lines are what was said, as they always were.
 */
export function generatedSaid(record: Pick<TraceRecord, 'render'>): boolean {
  return record.render?.lines.some((l) => l.mode === 'generated') === true || record.render?.hold !== undefined;
}

import type { SlotContext } from '../core/slots/types';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

/** A slot context for unit tests: today is 2026-09-18, default thresholds, nothing pending or prompted. */
export function testSlotContext(text: string, over: Partial<SlotContext> = {}): SlotContext {
  return {
    text,
    candidateSpans: candidateSpans(text),
    candidateWordSpans: candidateWordSpans(text),
    todayIso: '2026-09-18',
    thresholds: { ...DEFAULT_THRESHOLDS },
    window: null,
    current: null,
    records: [],
    prompted: false,
    ...over,
  };
}

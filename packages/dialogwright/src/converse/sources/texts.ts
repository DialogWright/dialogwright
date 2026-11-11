import { recordingTexts } from '../../texts/record';
import type { TextRecord, Texts, TurnTexts } from '../../texts/types';

/** The sender a converse run texts with: the turn's provider, each text recorded; null where the server has none. */
export function converseTexts(t: TurnTexts | null, record: (r: TextRecord) => void): Texts | null {
  return t === null ? null : recordingTexts(t.provider, t.from, t.keys, record, t.limits ?? null);
}

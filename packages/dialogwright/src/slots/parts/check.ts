import { hasWords } from '../../agent/words';
import { parseIso, toIso } from '../../core/extract/date';
import type { SlotCheckContext, ValueCheck } from '../types';

/**
 * What every type's check of a value starts from: the words cited for it must be in what the caller
 * said (whole words, case and punctuation ignored, spaces collapsed: agent/words.ts), and a value
 * that is a day must be a real one.
 */

/** The refusal of a value whose cited words the caller never said, else null. */
export function wordsRefusal(words: string, said: string): ValueCheck | null {
  return hasWords(said, words) ? null : { ok: false, reason: 'words' };
}

/** Whether `iso` is a real calendar day written YYYY-MM-DD ("2026-02-30" is not). */
export function isRealIso(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && toIso(parseIso(iso)) === iso;
}

/** A check that takes no value from outside its fill (record, reference, topic). */
export const unsupportedCheck = (_value: string, _words: string, _said: string, _ctx: SlotCheckContext): ValueCheck => ({ ok: false, reason: 'unsupported' });

import { numbersSaid } from '../../core/extract/numbersSaid';
import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import { renderLabel } from './label';
import { RECORD_PARTS, RECORD_QUESTIONS, type RecordOptions } from './options';

/** The id of a record slot's question: the slot's id followed by `Choice`, unless `ids.choice` says otherwise. */
export const recordIdOf = (slot: string, o: Pick<RecordOptions, 'ids'>): string => RECORD_QUESTIONS.id(slot, 'choice', o.ids);

/** The whole of a key, by `keyPattern`. */
export const keyMatcher = (o: Pick<RecordOptions, 'keyPattern'>): RegExp => new RegExp(`^(?:${o.keyPattern})$`);

/** One thing the question offers: a key, and the criterion the model is given for it. */
export interface RecordCandidate {
  key: string;
  criterion: string;
}

/** The records the slot chooses among: the list `from` names, or the app's one list. */
export function recordsOf(o: Pick<RecordOptions, 'from'>, ctx: Pick<SlotContext, 'records' | 'sources'>): readonly unknown[] {
  if (o.from === undefined) return ctx.records;
  const list = ctx.sources?.[o.from];
  return Array.isArray(list) ? list : [];
}

/** A record's key as text: its `key` field when that is a string or a number, else null (the record is not offered). */
function keyOfRecord(record: unknown, field: string): string | null {
  if (typeof record !== 'object' || record === null || !Object.hasOwn(record, field)) return null;
  const value = (record as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * What the question offers: each record, in the order listed, then (with `spoken`) each number of
 * that many digits the caller says that no record has, in the order said. A key is offered once,
 * and only when it matches `keyPattern`.
 */
export function recordCandidates(o: RecordOptions, ctx: Pick<SlotContext, 'text' | 'records' | 'sources'>): RecordCandidate[] {
  const valid = keyMatcher(o);
  const seen = new Set<string>();
  const out: RecordCandidate[] = [];
  for (const record of recordsOf(o, ctx)) {
    const key = keyOfRecord(record, o.key);
    if (key === null || !valid.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, criterion: renderLabel(o.label, key, record as Record<string, unknown>) });
  }
  if (o.spoken) {
    for (const key of numbersSaid(ctx.text, { digits: o.spoken.digits, skipYearAfterMonth: o.spoken.skipYearAfterMonth })) {
      if (!valid.test(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, criterion: renderLabel(o.spoken.label, key, {}) });
    }
  }
  return out;
}

/**
 * A record slot's one question: which of the records (and the numbers the caller said) does the
 * caller mean? Each label is `labelPrefix` and the key, then `none`. With nothing to offer (no
 * records, no number said), the slot asks nothing.
 */
export function recordQuestions(slot: string, o: RecordOptions): (ctx: SlotContext) => QuestionMap {
  const id = recordIdOf(slot, o);
  const instructions = RECORD_PARTS.render('instructions', o.text, {});
  const none = RECORD_PARTS.render('none', o.text, {});
  return (ctx) => {
    const list = recordCandidates(o, ctx);
    if (list.length === 0) return {};
    const criteria: Record<string, string> = {};
    for (const c of list) {
      const label = `${o.labelPrefix}${c.key}`;
      // A prefix and a key that spell "none" ("non" and "e") would be the question's own none label.
      if (label !== 'none') criteria[label] = c.criterion;
    }
    if (Object.keys(criteria).length === 0) return {};
    criteria.none = none;
    return { [id]: { type: 'choice', instructions, criteria } };
  };
}

import { isAnonymous, type Principal } from './types';

export const ANONYMOUS: Principal = { kind: 'anonymous', level: 0 };

/**
 * One of the app's subjects (a party of `subjectKind`) verified to level 1 who has just passed the
 * keypad code: the same principal at level 2. Built from the principal already held, so raising a
 * level reads no system of record. Anything else (an anonymous caller, a party acting for subjects)
 * is not raised: null.
 */
export function raise(p: Principal, level: 2, subjectKind: string): Principal | null {
  if (isAnonymous(p) || p.kind !== subjectKind) return null;
  return { ...p, level };
}

/**
 * How a value is shown where it would be masked by its last four but has four characters or fewer,
 * so its last four would be all of it: four bullets, whatever its length, so not even that is told.
 */
export const SHORT_MASK = '••••';

/**
 * Ids are shown and logged by their last four characters only ("...5678"). An id of one to four
 * characters (a PIN, the last four of an identity number) is shown as SHORT_MASK; an empty one,
 * which has nothing to hide, as "..." as before. Every `last4` mask
 * goes through here: a slot's or a param's (core/recording.ts recordedValue, trace/redact.ts
 * maskLast4), a handoff's (core/decision.ts) and a principal's id (the audit, the gate's lines).
 */
export function maskId(id: string): string {
  return id.length > 0 && id.length <= 4 ? SHORT_MASK : `...${id.slice(-4)}`;
}

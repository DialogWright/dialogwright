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

/** Ids are shown and logged by their last four characters only. */
export function maskId(id: string): string {
  return `...${id.slice(-4)}`;
}

import { isAnonymous } from '../gate/types';
import { identityOf } from './app/lookup';
import { appOf } from './app/registry';
import type { Session } from './session';

/** A channel a caller signs in to on which the app asks the factors typed all the same (identity.yaml's `typedFactors: ask`). */
export function typedHere(s: Session): boolean {
  return s.caps.signIn && identityOf(appOf(s)).typedFactors === 'ask';
}

/**
 * Whether the identity factors are asked of this session's caller: an anonymous one, on a channel where
 * they say or key them (a call), or type them where the app says so on a channel they could sign in to
 * (identity.yaml's `typedFactors: ask`).
 */
export function factorsAsked(s: Session): boolean {
  return isAnonymous(s.principal) && (!s.caps.signIn || typedHere(s));
}

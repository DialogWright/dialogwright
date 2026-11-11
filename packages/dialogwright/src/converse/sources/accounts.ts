import { sameNumber } from '../../core/conditions';
import type { AgentBusiness } from '../business/schema';

/** The name of the account whose number the caller is calling from, or null (caller ID recognises; it never proves identity). */
export function accountOf(b: AgentBusiness, callerNumber: string | undefined): string | null {
  if (callerNumber === undefined || callerNumber.trim() === '') return null;
  for (const a of b.sources.accounts ?? []) if (a.numbers.some((n) => sameNumber(callerNumber, n))) return a.name;
  return null;
}

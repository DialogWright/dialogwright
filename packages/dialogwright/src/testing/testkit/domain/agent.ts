import type { ServiceDef } from '../../../core/app/types';
import { serviceResultEvent } from '../../../channel/events';
import { depotDays } from './forms';

/**
 * The depot agent's answer to a missing-parcel report: how many days the depot needs to search.
 * A report about a parcel left somewhere named is searched sooner. Deterministic, and in process:
 * the testkit has no network agent.
 */
export function depotSearch(params: Readonly<Record<string, string>>): { searchDays: number } {
  return { searchDays: /\b(porch|gate|door|step|steps)\b/i.test(params.missingNote ?? '') ? 2 : 4 };
}

/** The depot agent as the app declares it (App.services.depot). */
export const DEPOT_AGENT: ServiceDef = {
  resolve: async (params) => serviceResultEvent('depot', depotSearch(params)),
  fromLog: (result) => {
    const days = depotDays(result);
    return days === null ? null : { searchDays: days };
  },
  audit: (result) => {
    const days = depotDays(result);
    return { type: 'a2a', detail: { agent: 'depot', phase: 'answered', answered: days !== null, searchDays: days } };
  },
};

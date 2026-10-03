import type { PolicyMatrix } from '../../../core/app/types';
import { CUSTOMERS, STAFF } from './data';
import { agentPrincipal, customerPrincipal } from './principals';

const [ALEX, SAM, CASEY] = [CUSTOMERS[0]!, CUSTOMERS[1]!, CUSTOMERS[2]!];
const [TAYLOR, MORGAN] = [STAFF[0]!, STAFF[1]!];

/** A report's fields, due on a day nothing of the customer's was delivered (R8 passes). */
const REPORT = { missingNote: 'a small brown box', expectedDate: '2026-09-21' };

/**
 * Example Parcels' principals and records for the gate grid (TestingHooks.policyMatrix): Alex, at
 * levels 1 and 2; the North Depot's viewer and clerk, who act for Alex and Sam; a supervisor of the
 * same depot (a role no table names) and one of its staff with no role; and a visitor of a kind the
 * line does not serve. Casey is served by another depot, so no delegate here may see her. A report is
 * tried due on a day nothing was delivered (R8 passes), on the day Alex's boots were (R8 sends it to
 * a person) and with no date at all (R8 refuses it).
 */
export function testkitPolicyMatrix(): PolicyMatrix {
  const viewer = agentPrincipal(TAYLOR);
  return {
    principals: {
      subject1: customerPrincipal(ALEX, 1),
      subject2: customerPrincipal(ALEX, 2),
      delegates: { viewer, clerk: agentPrincipal(MORGAN) },
      unlistedRole: { ...viewer, id: 'S-103', name: 'Riley Shaw', first: 'Riley', role: 'supervisor' },
      roleless: { kind: 'agent', level: 2, id: 'S-104', name: 'Jordan Lee', first: 'Jordan', attrs: { depot: TAYLOR.depot, depotId: TAYLOR.depotId } },
      otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
    },
    records: {
      own: { subject: ALEX.id, record: '7101' },
      inScope: { subject: SAM.id, record: '7201' },
      outOfScope: { subject: CASEY.id, record: '7301' },
      unknown: { subject: '55500000', record: '7999' },
    },
    calls: {
      createReport: {
        due: { ...REPORT },
        delivered: { ...REPORT, expectedDate: '2026-09-16' },
        undated: { ...REPORT, expectedDate: 'soon' },
      },
    },
    values: REPORT,
  };
}

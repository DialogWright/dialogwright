import type { PrincipalDirectory } from '../../../core/app/types';
import type { Party } from '../../../gate/types';
import { CUSTOMERS, staffById, type Customer, type Staff } from './data';

/** A customer verified by their factors (1) or signed in to the web chat (2): Example Parcels' subject. */
export function customerPrincipal(c: Pick<Customer, 'id' | 'first' | 'phoneLast4'>, level: 1 | 2): Party {
  return { kind: 'customer', level, id: c.id, first: c.first, contact: { phoneLast4: c.phoneLast4 } };
}

/** Depot staff, level 2 from the start (the staff portal), acting for their depot's customers with a role (R5). */
export function agentPrincipal(s: Pick<Staff, 'staffNo' | 'name' | 'depot' | 'depotId' | 'role'>): Party {
  return { kind: 'agent', level: 2, id: s.staffNo, name: s.name, first: s.name.split(' ')[0]!, role: s.role, attrs: { depot: s.depot, depotId: s.depotId } };
}

/**
 * The principals a scenario signs in as: two customers (a `signIn` step), and the depot staff (`as`).
 * No portal (App.portal): the engine never reads one, and testkit has no sign-in routes of its own.
 */
export const TESTKIT_PRINCIPALS: PrincipalDirectory = {
  subjectPrincipal(id, level) {
    const c = CUSTOMERS.slice(0, 2).find((x) => x.id === id);
    return c ? customerPrincipal(c, level) : null;
  },
  delegatePrincipal(id) {
    const s = staffById(id);
    return s ? agentPrincipal(s) : null;
  },
};

import type { PolicyMatrix } from 'dialogwright';

/**
 * The clinic's principals and records for the gate grid (TestingHooks.policyMatrix). The clinic
 * verifies no one and keeps no scope (no identity.yaml, no subjects in policy.yaml), so none of these
 * is one of its subjects to the gate: the grid shows every caller, proven or not, with a role or
 * without, gets the same answers, and that the writes hold to what was confirmed (the confirmed rule).
 */
export function clinicPolicyMatrix(): PolicyMatrix {
  const patient = { kind: 'patient', id: '55507788', first: 'Morgan' } as const;
  return {
    principals: {
      subject1: { ...patient, level: 1 },
      subject2: { ...patient, level: 2 },
      delegates: {},
      unlistedRole: { kind: 'staff', level: 2, id: 'ST-1', first: 'Quinn', role: 'front_desk' },
      roleless: { kind: 'staff', level: 2, id: 'ST-2', first: 'Rowan' },
      otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
    },
    records: {
      own: { subject: '55507788', record: 'A-101' },
      inScope: { subject: '55507789', record: 'A-102' },
      outOfScope: { subject: '55507790', record: 'A-103' },
      unknown: { subject: '55500000', record: 'A-999' },
    },
    // A write's confirmed fields, as a reschedule with Dr. Patel on Tuesday morning sends them.
    values: { name: 'morgan ellis', dob: '1975-06-14', provider: 'patel', date: '2026-09-22', time: '09:00' },
  };
}

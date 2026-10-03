import type { PolicyTables } from '../../../core/app/types';

/**
 * The library fixture's tables as they were when its policy.yaml was written in the old shape
 * (../legacy/library/policy.yaml): frozen test data. policy.yaml in the new shape must compile to
 * exactly this (../../policyFile.test.ts), and the gate must decide every case over it as over the
 * compiled tables. Only a deliberate change to the library's policy changes this file.
 */
export const FROZEN_LIBRARY_POLICY: Omit<PolicyTables, 'customRules'> = {
  toolLevel: { renewLoan: 0, findHold: 0, listLoans: 0 },
  purposeLevel: {},
  rulesFor: { renewLoan: ['R1', 'R3'], findHold: ['R1', 'known-branch'], listLoans: ['R1'] },
  serviceFields: {},
  confirmedFields: ['book'],
  maxAttempts: 3,
  subjects: {},
};

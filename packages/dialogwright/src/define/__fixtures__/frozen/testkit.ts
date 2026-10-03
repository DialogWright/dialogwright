import type { IdentityConfig, PolicyTables } from '../../../core/app/types';

/**
 * The testkit's tables and identity as they were written by hand in TypeScript, before it had
 * policy.yaml and identity.yaml: frozen test data. The files must compile to exactly this
 * (../../policyFile.test.ts), its custom rule R8 the testkit's own function (code stays code).
 */
export const FROZEN_TESTKIT_POLICY: Omit<PolicyTables, 'customRules'> = {
  toolLevel: {
    verifyCustomer: 0,
    verifyCode: 1,
    sendCode: 1,
    getAccount: 1,
    getWindows: 1,
    listParcels: 2,
    getParcel: 2,
    createReport: 2,
    notifyDepot: 2,
  },
  purposeLevel: { report_missing: 2 },
  rulesFor: {
    verifyCustomer: ['R6'],
    verifyCode: ['R1', 'R6'],
    sendCode: ['R1', 'R2'],
    getAccount: ['R1', 'R2'],
    getWindows: ['R1', 'R2'],
    listParcels: ['R1', 'R2'],
    getParcel: ['R1', 'R2'],
    createReport: ['R1', 'R5', 'R2', 'R3', 'R8'],
    notifyDepot: ['R1', 'R2', 'R7'],
  },
  serviceFields: { notifyDepot: ['report', 'missingNote', 'expectedDate'] },
  confirmedFields: ['accountId', 'missingNote', 'expectedDate'],
  maxAttempts: 3,
  roles: { createReport: { viewer: 'refuse', clerk: 'person' } },
  subjects: {
    sendCode: { param: 'accountId' },
    getAccount: { param: 'accountId' },
    getWindows: { param: 'accountId' },
    listParcels: { param: 'accountId' },
    getParcel: { param: 'parcel', via: 'record' },
    createReport: { param: 'accountId' },
    notifyDepot: { param: 'report', via: 'record' },
  },
};

/** The testkit's identity, without its sendCodeParams (a function of the session, which is code). */
export const FROZEN_TESTKIT_IDENTITY: Omit<IdentityConfig, 'sendCodeParams'> = {
  subjectKind: 'customer',
  delegateKind: 'agent',
  factorSlots: ['accountId', 'dob'],
  verifyTool: 'verifyCustomer',
  codeTool: 'verifyCode',
  sendCodeTool: 'sendCode',
  failedPromptId: 'identity_failed',
};

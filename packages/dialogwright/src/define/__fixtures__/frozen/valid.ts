import type { IdentityConfig, PolicyTables, RoleAccess } from '../../../core/app/types';

/**
 * The valid fixture's tables and identity as they were when its files were written in the old shape
 * (../legacy/valid): frozen test data, with the rows no rule reads still in them (the subject and
 * service fields of cancelAppointment, the roles of two tools that run no role rule, and their
 * reason), which the new shape cannot say and the converter drops. policy.yaml in the new shape
 * must compile to this less those rows (../../policyFile.test.ts).
 */
export const FROZEN_VALID_POLICY: Omit<PolicyTables, 'customRules'> = {
  toolLevel: { findAppointment: 0, bookAppointment: 0, cancelAppointment: 0, verifyPatient: 0, sendCode: 1, verifyCode: 1 },
  purposeLevel: { appointment: 0 },
  rulesFor: {
    findAppointment: ['R1', 'R2'],
    bookAppointment: ['R1', 'R3', 'no-double-booking'],
    cancelAppointment: ['R1', 'R3'],
    verifyPatient: ['R1', 'R6'],
    sendCode: ['R1'],
    verifyCode: ['R1', 'R6'],
  },
  serviceFields: { cancelAppointment: ['provider', 'date'] },
  confirmedFields: ['name', 'dob', 'provider', 'date', 'time'],
  maxAttempts: 3,
  roles: {
    findAppointment: { viewer: 'allow', clerk: 'allow' },
    cancelAppointment: { viewer: 'refuse', clerk: 'person' },
  },
  rolePersonReason: 'staff-cancel',
  subjects: {
    findAppointment: { param: 'bookingId', via: 'record' },
    cancelAppointment: { param: 'patientId' },
  },
  wording: {
    scope: {
      subject: { record: 'The booking belongs to this patient', param: 'The patient is the caller' },
      delegate: { record: 'The booking belongs to a patient of this clinic' },
    },
    recordOwner: 'booking owner',
    subject: 'patient',
    role: (role: string, tool: string, access: RoleAccess) =>
      access === 'allow' ? `${role} may use ${tool}` : access === 'refuse' ? `${role} may not use ${tool}` : `${tool} by ${role} goes to a person`,
  },
};

export const FROZEN_VALID_IDENTITY: IdentityConfig = {
  subjectKind: 'patient',
  delegateKind: 'staff',
  factorSlots: ['patientId', 'dob'],
  verifyTool: 'verifyPatient',
  codeTool: 'verifyCode',
  sendCodeTool: 'sendCode',
  failedPromptId: 'identity_failed',
};

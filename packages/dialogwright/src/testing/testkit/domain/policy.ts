import type { PolicyTables, RoleAccess, SubjectParam, ToolName } from '../../../core/app/types';
import type { GateLookups, Level, RuleContext, RuleOutcome } from '../../../gate/types';
import type { StaffRole } from './data';
import type { ParcelLookups } from './systems';

/**
 * Example Parcels' action policy: the gate's tables, and one rule of its own (R8). Every tool not listed
 * is refused (R0); a tool with no level needs the highest.
 */
export const TOOL_LEVEL: Readonly<Record<ToolName, Level>> = {
  verifyCustomer: 0,
  verifyCode: 1,
  sendCode: 1,
  getAccount: 1,
  getWindows: 1,
  listParcels: 2,
  getParcel: 2,
  createReport: 2,
  notifyDepot: 2,
};

/** Reporting a parcel missing needs the code from the start, though its entry call needs only level 1. */
export const PURPOSE_LEVEL: Readonly<Record<string, Level>> = { report_missing: 2 };

export const RULES_FOR: Readonly<Record<ToolName, readonly string[]>> = {
  verifyCustomer: ['R6'],
  verifyCode: ['R1', 'R6'],
  sendCode: ['R1', 'R2'],
  getAccount: ['R1', 'R2'],
  getWindows: ['R1', 'R2'],
  listParcels: ['R1', 'R2'],
  getParcel: ['R1', 'R2'],
  createReport: ['R1', 'R5', 'R2', 'R3', 'R8'],
  notifyDepot: ['R1', 'R2', 'R7'],
};

/** R2: a parcel or a report names its owner through the lookups; every other tool names the customer by account ID. */
export const SUBJECTS: Readonly<Record<ToolName, SubjectParam>> = {
  sendCode: { param: 'accountId' },
  getAccount: { param: 'accountId' },
  getWindows: { param: 'accountId' },
  listParcels: { param: 'accountId' },
  getParcel: { param: 'parcel', via: 'record' },
  createReport: { param: 'accountId' },
  notifyDepot: { param: 'report', via: 'record' },
};

/** R5: a viewer may not file a report; a clerk may, with a person. */
export const ROLES: Readonly<Record<ToolName, Readonly<Record<StaffRole, RoleAccess>>>> = {
  createReport: { viewer: 'refuse', clerk: 'person' },
};

/** R7: what the depot agent may receive. */
export const SERVICE_FIELDS: Readonly<Partial<Record<ToolName, readonly string[]>>> = {
  notifyDepot: ['report', 'missingNote', 'expectedDate'],
};

/** R3: the fields a confirmed report carries, in the order the hash is taken over. */
export const CONFIRMED_FIELDS: readonly string[] = ['accountId', 'missingNote', 'expectedDate'];

function parcelLookups(lk: GateLookups): ParcelLookups | null {
  return typeof (lk as Partial<ParcelLookups>).deliveredOn === 'function' ? (lk as ParcelLookups) : null;
}

/**
 * R8: none of the customer's parcels shows as delivered on the day the missing one was due. If one
 * does, a person checks with the customer before a report is filed. Not a date, or lookups that
 * cannot say: refused (fails closed).
 */
function notDeliveredThatDay(c: RuleContext): RuleOutcome {
  const day = c.call.params.expectedDate ?? '';
  const description = 'No parcel of the customer\'s was delivered on the day it was due';
  const lk = parcelLookups(c.lk);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || lk === null) {
    return { result: { id: 'R8', description, compared: `due ${day || '(none)'} not checkable`, pass: false }, fail: { verdict: 'BLOCK', reason: 'unchecked' } };
  }
  const delivered = lk.deliveredOn(c.call.params.accountId ?? '', day);
  const result = { id: 'R8', description, compared: `due ${day}: ${delivered ? 'a parcel delivered that day' : 'nothing delivered that day'}`, pass: !delivered };
  return delivered ? { result, fail: { verdict: 'NEEDS_HUMAN', reason: 'delivered' } } : { result };
}

export const TESTKIT_POLICY: PolicyTables = {
  toolLevel: TOOL_LEVEL,
  purposeLevel: PURPOSE_LEVEL,
  rulesFor: RULES_FOR,
  serviceFields: SERVICE_FIELDS,
  confirmedFields: CONFIRMED_FIELDS,
  maxAttempts: 3,
  roles: ROLES,
  subjects: SUBJECTS,
  customRules: { R8: notDeliveredThatDay },
};

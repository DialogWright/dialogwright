import { fileURLToPath } from 'node:url';
import { defineIdentity, definePolicy } from '../../../define/definePolicy';
import type { IdentityConfig, PolicyTables } from '../../../core/app/types';
import type { GateLookups, RuleContext, RuleOutcome } from '../../../gate/types';
import manifest from '../prompts/manifest.json';
import { accountIdOf } from './forms';
import { SLOTS } from './slots/index';
import type { ParcelLookups } from './systems';
import { TESTKIT_TOOLS } from './tools';

/**
 * Example Parcels' action policy and identity: policy.yaml and identity.yaml in the testkit's
 * folder, loaded with definePolicy and defineIdentity (the same files, checks and messages as an app
 * folder's, for an app that is not a folder), and the one rule of its own (R8), which is code. Every
 * tool not listed in the file is refused (R0); an action with no level needs the highest.
 */
const POLICY_FILE = fileURLToPath(new URL('../policy.yaml', import.meta.url));
const IDENTITY_FILE = fileURLToPath(new URL('../identity.yaml', import.meta.url));

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

/** The app's own rules, by the id policy.yaml's `custom:` names them by. */
export const TESTKIT_CUSTOM_RULES: NonNullable<PolicyTables['customRules']> = { R8: notDeliveredThatDay };

/** The gate's tables (App.policy), compiled from policy.yaml and checked against the testkit's tools, slots and identity. */
export const TESTKIT_POLICY: PolicyTables = definePolicy(POLICY_FILE, { identity: IDENTITY_FILE, tools: TESTKIT_TOOLS, slots: SLOTS, customRules: TESTKIT_CUSTOM_RULES });

/** The lifecycle's identity configuration (App.identity), compiled from identity.yaml; the code call's params are the session's. */
export const TESTKIT_IDENTITY: IdentityConfig = defineIdentity(IDENTITY_FILE, {
  policy: POLICY_FILE,
  tools: TESTKIT_TOOLS,
  slots: SLOTS,
  prompts: manifest,
  sendCodeParams: (s) => ({ accountId: accountIdOf(s) }),
});

/** What a few tests read of the tables by name. */
export const TOOL_LEVEL = TESTKIT_POLICY.toolLevel;
export const CONFIRMED_FIELDS = TESTKIT_POLICY.confirmedFields;

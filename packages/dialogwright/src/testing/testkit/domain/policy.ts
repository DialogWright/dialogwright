import { fileURLToPath } from 'node:url';
import { defineIdentity, definePolicy } from '../../../define/definePolicy';
import type { IdentityConfig, PolicyTables } from '../../../core/app/types';
import { defineRule } from '../../../gate/defineRule';
import type { GateLookups } from '../../../gate/types';
import manifest from '../prompts/manifest.json';
import { CUSTOMERS } from './data';
import { accountIdOf } from './forms';
import { customerPrincipal } from './principals';
import { SLOTS } from './slots/index';
import type { ParcelLookups } from './systems';
import { TESTKIT_TOOLS } from './tools';

/**
 * Example Parcels' action policy and identity: policy.yaml and identity.yaml in the testkit's
 * folder, loaded with definePolicy and defineIdentity (the same files, checks and messages as an app
 * folder's, for an app that is not a folder), and the one rule of its own (R8), which is code. Every
 * tool not listed in the file is refused (unlisted); an action with no level needs the highest. R8 is
 * defined with the examples that say what it does (defineRule), which the matrix runner runs.
 */
const POLICY_FILE = fileURLToPath(new URL('../policy.yaml', import.meta.url));
const IDENTITY_FILE = fileURLToPath(new URL('../identity.yaml', import.meta.url));

function parcelLookups(lk: GateLookups): ParcelLookups | null {
  return typeof (lk as Partial<ParcelLookups>).deliveredOn === 'function' ? (lk as ParcelLookups) : null;
}

const ALEX = customerPrincipal(CUSTOMERS[0]!, 2);
/** A report of Alex's, due on `expectedDate`. */
const report = (expectedDate: string): { params: Record<string, string> } => ({ params: { accountId: ALEX.id, missingNote: 'a small brown box', expectedDate } });

/**
 * R8: none of the customer's parcels shows as delivered on the day the missing one was due. If one
 * does, a person checks with the customer before a report is filed. Not a date, or lookups that
 * cannot say: refused (fails closed).
 */
export const notDeliveredThatDay = defineRule({
  id: 'R8',
  description: 'No parcel of the customer\'s was delivered on the day it was due',
  run(c) {
    const day = c.call.params.expectedDate ?? '';
    const lk = parcelLookups(c.lk);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || lk === null) return { pass: false, compared: `due ${day || '(none)'} not checkable`, verdict: 'BLOCK', reason: 'unchecked' };
    const delivered = lk.deliveredOn(c.call.params.accountId ?? '', day);
    const compared = `due ${day}: ${delivered ? 'a parcel delivered that day' : 'nothing delivered that day'}`;
    return delivered ? { pass: false, compared, verdict: 'NEEDS_HUMAN', reason: 'delivered' } : { pass: true, compared };
  },
  examples: [
    { name: 'due on a day nothing of theirs was delivered', call: report('2026-09-21'), principal: ALEX, expect: { verdict: 'ALLOW' } },
    { name: 'due on the day their boots were delivered', call: report('2026-09-16'), principal: ALEX, expect: { verdict: 'NEEDS_HUMAN', reason: 'delivered' } },
    { name: 'due on no date at all', call: report('soon'), principal: ALEX, expect: { verdict: 'BLOCK', reason: 'unchecked' } },
    { name: 'lookups that cannot say', call: report('2026-09-21'), principal: ALEX, lookups: { deliveredOn: undefined }, expect: { verdict: 'BLOCK', reason: 'unchecked' } },
  ],
});

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

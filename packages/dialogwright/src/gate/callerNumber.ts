import { confirmationHash } from './lines';
import { VALUE_MISSING } from './listed';
import type { RuleContext, RuleOutcome, ToolCall } from './types';

/**
 * The built-in rule that holds a param to the number the caller is calling from: `callerNumber`,
 * written in policy.yaml with no code. A text the app sends to a number the call carries (the slot a
 * text offer filled) goes only to the caller's own number, or, with `else: confirmed`, to a number the
 * caller heard read back whole at the summary and said yes to:
 *
 *   - callerNumber: { field: textTo }                  # the caller's own number, nothing else
 *   - callerNumber: { field: textTo, else: confirmed } # or a number confirmed at the summary
 *
 * The caller's number is the gate's fact (GateFacts.callerNumber), as the session kept it; it is a
 * hint, never proof of who is calling on its own (an app may let a caller-ID match identify an
 * account, with a knowledge factor that verifies it: identity.yaml `callerId`, through the verify
 * tool, not this rule), so the rule is about where a call sends something, never about whose record
 * it reads. The param is compared as the slot of the same name holds the caller's number
 * (GateFacts.callerNumberAs, from the slot's `callerNumber.take`: `5555550142` for `+15555550142`);
 * a field that is no such slot is compared digit for digit with the number as kept.
 *
 * It fails closed. A value that is missing or empty BLOCKs with `value-missing`. A number that is not
 * the caller's BLOCKs with `not-caller-number`, and with no caller's number kept (a chat, a withheld
 * number) with `no-caller-number`, unless `else: confirmed` and the caller confirmed the call's values
 * at the summary: the action's confirmed fields (its `confirmed` rule, which `check` requires to name
 * the field) hashed as the summary hashed them, against the confirmation the caller's yes armed
 * (GateFacts.confirmedHash). An action with no confirmed rule confirms nothing, and `else: confirmed`
 * then passes only the caller's own number.
 *
 * What the lines show: the field's name and whether it is the caller's number or one confirmed, never
 * a number: not the call's value, and not the caller's.
 */

/** The parameters of a `callerNumber` rule, read. */
export interface CallerNumberParams {
  /** The param that holds the number. */
  readonly field: string;
  /** What a number that is not the caller's gets: `refuse` (the default), or `confirmed` (it passes when the caller confirmed it at the summary). */
  readonly else?: 'refuse' | 'confirmed';
}

/** The id it records itself under: its name. */
export const CALLER_NUMBER_ID = 'callerNumber';

/** The reason a number that is not the caller's fails for. */
export const NOT_CALLER_NUMBER = 'not-caller-number';

/** The reason a call fails for when the session kept no caller's number. */
export const NO_CALLER_NUMBER = 'no-caller-number';

/** A param of the call, own properties only. */
function paramOf(call: ToolCall, param: string): string | undefined {
  return Object.hasOwn(call.params, param) ? call.params[param] : undefined;
}

const digitsOf = (v: string): string => v.replace(/\D/g, '');

/**
 * callerNumber: the value in `field` is the caller's own number, or, with `else: confirmed`, one the
 * caller confirmed. `confirmedFields` are the action's confirmed rule's fields (null: the action has
 * none, so nothing is confirmed).
 */
export function callerNumberRule(params: CallerNumberParams, confirmedFields: readonly string[] | null): (c: RuleContext) => RuleOutcome {
  const { field } = params;
  const orConfirmed = params.else === 'confirmed';
  const id = CALLER_NUMBER_ID;
  const description = orConfirmed ? `The number in ${field} is the caller's own, or one the caller confirmed` : `The number in ${field} is the caller's own`;
  return (c) => {
    const value = paramOf(c.call, field);
    if (value === undefined || value === '') {
      return { result: { id, description, compared: `${field} missing`, pass: false }, fail: { verdict: 'BLOCK', reason: VALUE_MISSING } };
    }
    const kept = c.facts.callerNumber;
    const as = c.facts.callerNumberAs;
    const own = kept !== undefined && kept !== ''
      && (as !== undefined && Object.hasOwn(as, field) ? as[field] === value : digitsOf(value) !== '' && digitsOf(value) === digitsOf(kept));
    if (own) return { result: { id, description, compared: `${field} is the caller's number`, pass: true } };
    const noNumber = kept === undefined || kept === '';
    if (orConfirmed) {
      const held = c.facts.confirmedHash;
      const confirmed = confirmedFields !== null && confirmedFields.includes(field) && held !== null && held === confirmationHash(c.call.params, confirmedFields);
      if (confirmed) return { result: { id, description, compared: `${field} is ${noNumber ? 'a number' : 'not the caller\'s number, but a number'} the caller confirmed`, pass: true } };
      const compared = `${field} ${noNumber ? 'with no caller\'s number' : 'is not the caller\'s number'}, and not confirmed`;
      return { result: { id, description, compared, pass: false }, fail: { verdict: 'BLOCK', reason: noNumber ? NO_CALLER_NUMBER : NOT_CALLER_NUMBER } };
    }
    const compared = noNumber ? `${field} with no caller's number` : `${field} is not the caller's number`;
    return { result: { id, description, compared, pass: false }, fail: { verdict: 'BLOCK', reason: noNumber ? NO_CALLER_NUMBER : NOT_CALLER_NUMBER } };
  };
}

import type { RangeVerdict } from './bounded';
import type { RuleContext, RuleOutcome, ToolCall } from './types';

/**
 * The two built-in rules that hold a call's value to a list: `oneOf` (the param must be one of the
 * values listed) and `noneOf` (it must be none of them). They are the rules a form's checks most
 * often ask (a town in the service area, an owner and not a renter, an emergency sent to a person),
 * written in policy.yaml with no code:
 *
 *   - oneOf: { field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }
 *   - noneOf: { field: howUrgent, values: [emergency], reason: emergency, verdict: NEEDS_HUMAN }
 *
 * The match is exact: the value as the call carries it, compared with each listed value character
 * for character. A slot's value is already what its type made of the words: a choice slot's is one
 * of its option ids (`cedar_falls`, never "Cedar Falls" or "cedar falls"), and `check` holds a list
 * for a choice slot's param to those ids. So there is no case-insensitive match: words a caller may
 * say several ways belong in a choice slot's options, which map them to one id, not in the policy.
 *
 * Both fail closed. A value that is missing or empty BLOCKs with reason `value-missing`, whatever the
 * rule's own verdict: a rule about a value never passes a call without one (noneOf included: "none
 * of these" is not said by saying nothing). Otherwise a failure gives the rule's `verdict` (BLOCK,
 * the default, or NEEDS_HUMAN) and its `reason` (default `not-one-of` for oneOf, `one-of` for
 * noneOf), which a form check's `on:` maps.
 *
 * What the lines show: the field's name and the list, never the call's value (it may be one the app
 * records hidden or never, and a line reaches the audit as it is). A list of one value says as much
 * as the verdict already does.
 */

/** The parameters of a `oneOf` or `noneOf` rule, read. */
export interface ListParams {
  /** The param that holds the value. */
  readonly field: string;
  /** The values listed, at least one, each once. */
  readonly values: readonly string[];
  /** The reason a value the rule refuses fails for. Default ONE_OF_REASON or NONE_OF_REASON. */
  readonly reason?: string;
  /** BLOCK (the default) or NEEDS_HUMAN, for a value the rule refuses. A missing value always BLOCKs. */
  readonly verdict?: RangeVerdict;
}

/** The id each records itself under: its name. */
export const ONE_OF_ID = 'oneOf';
export const NONE_OF_ID = 'noneOf';

/** The default reasons: oneOf's for a value not listed, noneOf's for a value listed. */
export const ONE_OF_REASON = 'not-one-of';
export const NONE_OF_REASON = 'one-of';

/** The reason either rule BLOCKs a call without the value for. */
export const VALUE_MISSING = 'value-missing';

/** The most values a line names before it says how many more there are. */
export const MAX_VALUES_SHOWN = 10;

/** The list as a line shows it: `[a, b, c]`, or the first values and how many more. */
export function valuesShown(values: readonly string[]): string {
  if (values.length <= MAX_VALUES_SHOWN) return `[${values.join(', ')}]`;
  return `[${values.slice(0, MAX_VALUES_SHOWN).join(', ')}, and ${values.length - MAX_VALUES_SHOWN} more]`;
}

/** A param of the call, own properties only. */
function paramOf(call: ToolCall, param: string): string | undefined {
  return Object.hasOwn(call.params, param) ? call.params[param] : undefined;
}

function listRule(which: 'oneOf' | 'noneOf', params: ListParams): (c: RuleContext) => RuleOutcome {
  const { field } = params;
  const id = which === 'oneOf' ? ONE_OF_ID : NONE_OF_ID;
  const listed = new Set(params.values);
  const shown = valuesShown(params.values);
  const description = which === 'oneOf' ? `The value in ${field} is one of those listed` : `The value in ${field} is none of those listed`;
  const reason = params.reason ?? (which === 'oneOf' ? ONE_OF_REASON : NONE_OF_REASON);
  const verdict = params.verdict ?? 'BLOCK';
  return (c) => {
    const value = paramOf(c.call, field);
    if (value === undefined || value === '') {
      return { result: { id, description, compared: `${field} missing`, pass: false }, fail: { verdict: 'BLOCK', reason: VALUE_MISSING } };
    }
    const isListed = listed.has(value);
    const pass = which === 'oneOf' ? isListed : !isListed;
    const compared = `${field} ${isListed ? 'one of' : which === 'oneOf' ? 'not one of' : 'none of'} ${shown}`;
    return pass ? { result: { id, description, compared, pass } } : { result: { id, description, compared, pass }, fail: { verdict, reason } };
  };
}

/** oneOf: the value in `field` is one of the values listed. */
export function oneOfRule(params: ListParams): (c: RuleContext) => RuleOutcome {
  return listRule('oneOf', params);
}

/** noneOf: the value in `field` is none of the values listed. */
export function noneOfRule(params: ListParams): (c: RuleContext) => RuleOutcome {
  return listRule('noneOf', params);
}

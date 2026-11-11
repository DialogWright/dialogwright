import type { RoleAccess } from '../core/app/types';
import { parseDateBound, parseLookupRef, parseNumberBound, type DateBound, type LookupRef, type NumberBound } from '../gate/bounded';
import type { Rule } from '../gate/compiled';
import type { RuleEntryYaml } from './schema/policy';

/**
 * One rule entry as written (policy.yaml's, and agent.yaml's actions' `rules`, which take the same
 * shape) read into the gate's rule (gate/compiled.ts Rule). Kept apart from ./policyFile.ts, which
 * re-exports it, so that a reader of the entries needs nothing of the scripted app's file compiler.
 */

/** A rule entry of a valid file, read. */
export function readRule(entry: RuleEntryYaml): Rule {
  if (entry === 'identity' || entry === 'attempts') return { rule: entry };
  if ('scope' in entry) {
    const { param, record } = entry.scope;
    return { rule: 'scope', subject: record !== undefined ? { param: record, via: 'record' } : { param: param! } };
  }
  if ('role' in entry) {
    const { reason, ...access } = entry.role;
    return reason === undefined ? { rule: 'role', access: access as Record<string, RoleAccess> } : { rule: 'role', access: access as Record<string, RoleAccess>, reason };
  }
  if ('confirmed' in entry) return { rule: 'confirmed', fields: entry.confirmed };
  if ('fields' in entry) return { rule: 'fields', fields: entry.fields };
  if ('dateInRange' in entry) {
    const { field, unscoped, notBefore, notAfter, within, reasons, verdicts } = entry.dateInRange;
    return {
      rule: 'dateInRange',
      field,
      ...(unscoped === true ? { unscoped } : {}),
      ...(notBefore !== undefined ? { notBefore: dateBoundOf(notBefore) } : {}),
      ...(notAfter !== undefined ? { notAfter: dateBoundOf(notAfter) } : {}),
      ...(within !== undefined ? { within: refOf(within) } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      ...(verdicts !== undefined ? { verdicts } : {}),
    };
  }
  if ('limit' in entry) {
    const { field, unscoped, min, max, reasons, verdicts } = entry.limit;
    return {
      rule: 'limit',
      field,
      ...(unscoped === true ? { unscoped } : {}),
      ...(min !== undefined ? { min: numberBoundOf(min) } : {}),
      ...(max !== undefined ? { max: numberBoundOf(max) } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      ...(verdicts !== undefined ? { verdicts } : {}),
    };
  }
  if ('oneOf' in entry || 'noneOf' in entry) {
    const which = 'oneOf' in entry ? 'oneOf' : 'noneOf';
    const { field, values, reason, verdict } = 'oneOf' in entry ? entry.oneOf : entry.noneOf;
    return { rule: which, field, values: Object.freeze([...values]), ...(reason !== undefined ? { reason } : {}), ...(verdict !== undefined ? { verdict } : {}) };
  }
  if ('callerNumber' in entry) {
    const { field, else: otherwise, withheld } = entry.callerNumber;
    return { rule: 'callerNumber', field, ...(otherwise !== undefined ? { else: otherwise } : {}), ...(withheld !== undefined ? { withheld } : {}) };
  }
  return { rule: 'custom', id: entry.custom };
}

/** A bound or reference of a valid file, read (the schema has checked it parses). */
function readOrThrow<T>(read: { problem: string } | T, text: unknown): T {
  if (typeof read === 'object' && read !== null && 'problem' in read) throw new Error(`policy.yaml was not checked: ${String(text)}: ${(read as { problem: string }).problem}`);
  return read as T;
}
const refOf = (text: string): LookupRef => readOrThrow(parseLookupRef(text), text).ref;
const dateBoundOf = (text: string): DateBound => readOrThrow(parseDateBound(text), text).bound;
const numberBoundOf = (value: number | string): NumberBound => readOrThrow(parseNumberBound(value), value).bound;

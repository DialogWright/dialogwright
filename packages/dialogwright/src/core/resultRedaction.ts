import { isAnonymous, type Principal } from '../gate/types';
import type { App, ToolName } from './app/types';

/**
 * Redaction per principal: the fields of a tool's result the policy withholds from a party who acts
 * for subjects (policy.yaml `redact:`, PolicyTables.redact). The tool returns the whole record; the
 * lifecycle's callTool, the one way a turn reaches a tool, strips it here right after the tool runs,
 * so the form hooks, the facts, the lines, the gate event (and so the trace, the console and the
 * audit) only ever see the stripped copy.
 *
 * A withheld field is set to null, on the value when it is an object and on each object of a list,
 * and the summary gets `redacted: <fields>` (the policy's list for this caller and tool, in its
 * order). A subject acting for themselves is never redacted, and neither is an anonymous caller.
 */

/** The key of a role's own row in the redact table: the delegate kind and the role, `agent.clerk`. */
export function redactKey(kind: string, role?: string): string {
  return role === undefined ? kind : `${kind}.${role}`;
}

/**
 * The fields of `tool`'s result the policy withholds from `principal`: the row of their kind and
 * role (`<kind>.<role>`) where it has one for the tool, else their kind's; none for a subject, an
 * anonymous caller, or an app with no redact table.
 */
export function withheldFields(app: App, principal: Principal, tool: ToolName): readonly string[] {
  const table = app.policy.redact;
  if (!table || isAnonymous(principal)) return [];
  if (app.identity && principal.kind === app.identity.subjectKind) return [];
  const row = (key: string): readonly string[] | undefined => {
    const byTool = Object.hasOwn(table, key) ? table[key] : undefined;
    return byTool && Object.hasOwn(byTool, tool) ? byTool[tool] : undefined;
  };
  return (principal.role !== undefined ? row(redactKey(principal.kind, principal.role)) : undefined) ?? row(principal.kind) ?? [];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One object with `fields` set to null: a copy, so the tool's own object is never changed. */
function stripped(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  for (const f of fields) out[f] = null;
  return out;
}

/**
 * `value` with `fields` withheld, and whether anything was: a null value (nothing found) and an empty
 * list carry nothing to withhold. A tool whose value is neither an object nor a list of objects has
 * no fields to strip, so withholding one from it is a bug in the app (it declared fields its result
 * does not have), and it throws: the value must never go on whole.
 */
export function redactResult(tool: ToolName, value: unknown, fields: readonly string[]): { value: unknown; redacted: boolean } {
  if (fields.length === 0 || value === null || value === undefined) return { value, redacted: false };
  const bad = (what: string): never => {
    throw new Error(`tool "${tool}" returned ${what}, so the fields the policy withholds (${fields.join(', ')}) cannot be stripped from it: a tool with fields (ToolDef.fields) returns an object or a list of objects`);
  };
  if (isObject(value)) return { value: stripped(value, fields), redacted: true };
  if (!Array.isArray(value)) return bad(`a ${typeof value}`);
  let redacted = false;
  const items = value.map((item: unknown) => {
    if (item === null || item === undefined) return item;
    if (!isObject(item)) return bad(`a list holding a ${Array.isArray(item) ? 'list' : typeof item}`);
    redacted = true;
    return stripped(item, fields);
  });
  return { value: items, redacted };
}

/** The summary as recorded when fields were withheld: the tool's own, then `redacted: <fields>`. */
export function redactedSummary(summary: string, fields: readonly string[]): string {
  const note = `redacted: ${fields.join(', ')}`;
  return summary === '' ? note : `${summary}; ${note}`;
}

import { isAnonymous, type Principal } from '../gate/types';
import type { App, ToolName } from './app/types';

/**
 * Redaction per principal: the fields of a tool's result the policy withholds from a party who acts
 * for subjects (policy.yaml `redact:`, PolicyTables.redact). The tool returns the whole record; the
 * lifecycle's callTool, the one way a turn reaches a tool, strips it here right after the tool runs,
 * so the form hooks, the facts, the lines, the gate event (and so the trace, the console and the
 * audit) only ever see the stripped copy.
 *
 * A withheld field is set to null wherever the result holds it: on the value when it is an object
 * (and on each object of a list, where the field is always set, present or not), and at any depth
 * below, in every object and list the result holds (own enumerable keys only; the same object met
 * twice, or a cycle, is copied once). The summary gets `redacted: <fields>` (the policy's list for
 * this caller and tool, in its order), and every text value a withheld field held is masked (•)
 * wherever the tool's summary or the record it names repeats it (core/lifecycle.ts callTool).
 *
 * What it does not reach: what the tool itself does with the whole record while it runs (a side
 * effect it queues goes to its service as queued, though its params as recorded have the withheld
 * texts masked, core/recording.ts recordedEffect; a write to the session), which the tool's code
 * must keep to what the caller may see, and an error the tool throws.
 *
 * A subject acting for themselves is never redacted, and neither is an anonymous caller. A party who
 * is neither, whose kind (and role) has no row in the table at all, has every field the tool
 * declares (ToolDef.fields) withheld: the policy said nothing of them, so they see nothing it could
 * have withheld (fail closed).
 */

/** The key of a role's own row in the redact table: the delegate kind and the role, `agent.clerk`. */
export function redactKey(kind: string, role?: string): string {
  return role === undefined ? kind : `${kind}.${role}`;
}

/**
 * The fields of `tool`'s result the policy withholds from `principal`: the row of their kind and
 * role (`<kind>.<role>`) where it has one for the tool, else their kind's; none for a subject or an
 * anonymous caller. A party whose kind has no row for any tool (nor its role), the table missing
 * altogether included, has every field the tool declares withheld (fail closed).
 */
export function withheldFields(app: App, principal: Principal, tool: ToolName): readonly string[] {
  if (isAnonymous(principal)) return [];
  if (app.identity && principal.kind === app.identity.subjectKind) return [];
  const table = app.policy.redact ?? {};
  const rowsOf = (key: string): Readonly<Record<string, readonly string[]>> | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
  const row = (key: string): readonly string[] | undefined => {
    const byTool = rowsOf(key);
    return byTool && Object.hasOwn(byTool, tool) ? byTool[tool] : undefined;
  };
  const roleKey = principal.role !== undefined ? redactKey(principal.kind, principal.role) : undefined;
  if (rowsOf(principal.kind) === undefined && (roleKey === undefined || rowsOf(roleKey) === undefined)) {
    // The policy says nothing of this kind of party: withhold all that it could have.
    const declared = Object.hasOwn(app.tools, tool) ? app.tools[tool]!.fields : undefined;
    return Array.isArray(declared) ? [...declared] : [];
  }
  return (roleKey !== undefined ? row(roleKey) : undefined) ?? row(principal.kind) ?? [];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A value that is copied by its own keys: a plain object or a class's instance, never a built-in that keeps its contents elsewhere. */
const isWalked = (v: object): boolean => !(v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet);

/** What stripping found: the copy, whether any field was withheld, and the text values the withheld fields held. */
interface Walk {
  readonly fields: ReadonlySet<string>;
  readonly copies: Map<object, unknown>;
  readonly values: Set<string>;
  found: boolean;
}

/**
 * A copy of `v` with every withheld field, at any depth, set to null: objects and lists are copied
 * (own enumerable keys; an object keeps its prototype), each once however often it is met, so a
 * cycle is copied as a cycle. A withheld field's text values, at any depth below it, are kept to be
 * masked in the summary. A Map or a Set holds its contents where the keys do not reach, so one
 * below a result with fields to withhold throws, as a value that is no object does.
 */
function walk(v: unknown, w: Walk, bad: (what: string) => never): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (w.copies.has(v)) return w.copies.get(v);
  if (v instanceof Map || v instanceof Set) return bad(`a ${v instanceof Map ? 'Map' : 'Set'} inside its result`);
  if (!Array.isArray(v) && !isWalked(v)) return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    w.copies.set(v, out);
    for (const item of v) out.push(walk(item, w, bad));
    return out;
  }
  const out = Object.create(Object.getPrototypeOf(v) as object | null) as Record<string, unknown>;
  w.copies.set(v, out);
  for (const key of Object.keys(v)) {
    const item = (v as Record<string, unknown>)[key];
    if (w.fields.has(key)) {
      w.found = true;
      heldText(item, w.values, new Set());
      out[key] = null;
    } else {
      out[key] = walk(item, w, bad);
    }
  }
  return out;
}

/** Every text (string) a withheld value holds, at any depth, for the summary's mask. */
function heldText(v: unknown, into: Set<string>, seen: Set<object>): void {
  if (typeof v === 'string') {
    if (v !== '') into.add(v);
    return;
  }
  if (typeof v !== 'object' || v === null || seen.has(v)) return;
  seen.add(v);
  for (const item of Array.isArray(v) ? v : Object.values(v)) heldText(item, into, seen);
}

/**
 * `value` with `fields` withheld, whether anything was, and the text values the withheld fields held
 * (`withheld`, for masking the summary). A null value (nothing found) and an empty list carry nothing
 * to withhold. The top object, and each object of a top-level list, gets every field set to null,
 * present or not; below them a field is set to null where it is. A tool whose value is neither an
 * object nor a list of objects has no fields to strip, so withholding one from it is a bug in the app
 * (it declared fields its result does not have), and it throws: the value must never go on whole.
 */
export function redactResult(tool: ToolName, value: unknown, fields: readonly string[]): { value: unknown; redacted: boolean; withheld: readonly string[] } {
  if (fields.length === 0 || value === null || value === undefined) return { value, redacted: false, withheld: [] };
  const bad = (what: string): never => {
    throw new Error(`tool "${tool}" returned ${what}, so the fields the policy withholds (${fields.join(', ')}) cannot be stripped from it: a tool with fields (ToolDef.fields) returns an object or a list of objects`);
  };
  const w: Walk = { fields: new Set(fields), copies: new Map(), values: new Set(), found: false };
  const top = (item: Record<string, unknown>): Record<string, unknown> => {
    const copied = walk(item, w, bad) as Record<string, unknown>;
    // A built-in object (a Date) is not walked: its copy is a plain one, so the tool's own is never changed.
    const out = copied === item ? { ...item } : copied;
    // The top object says every withheld field, present or not, as null.
    for (const f of fields) out[f] = null;
    return out;
  };
  const done = (v: unknown, redacted: boolean) => ({ value: v, redacted, withheld: [...w.values] });
  if (isObject(value)) return done(top(value), true);
  if (!Array.isArray(value)) return bad(`a ${typeof value}`);
  let redacted = false;
  const items = value.map((item: unknown) => {
    if (item === null || item === undefined) return item;
    if (!isObject(item)) return bad(`a list holding a ${Array.isArray(item) ? 'list' : typeof item}`);
    redacted = true;
    return top(item);
  });
  return done(items, redacted || w.found);
}

/** The summary as recorded when fields were withheld: the tool's own, then `redacted: <fields>`. */
export function redactedSummary(summary: string, fields: readonly string[]): string {
  const note = `redacted: ${fields.join(', ')}`;
  return summary === '' ? note : `${summary}; ${note}`;
}

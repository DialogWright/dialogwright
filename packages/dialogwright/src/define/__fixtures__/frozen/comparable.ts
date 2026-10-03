import type { PolicyTables, RoleAccess } from '../../../core/app/types';

const ACCESS: readonly RoleAccess[] = ['allow', 'refuse', 'person'];

/**
 * The tables with the role wording (a function) as its lines over every role and tool the tables
 * name, and one they do not, so two tables are compared with toEqual by what they say.
 */
export function comparable(tables: PolicyTables | Omit<PolicyTables, 'customRules'>, alsoRoles: readonly string[] = []): unknown {
  const { wording, ...rest } = tables;
  if (!wording) return rest;
  const { role, ...words } = wording;
  if (!role) return { ...rest, wording: words };
  const roles = [...new Set([...Object.values(tables.roles ?? {}).flatMap((r) => Object.keys(r)), ...alsoRoles, 'someone'])];
  const tools = [...Object.keys(tables.rulesFor), 'someTool'];
  const lines = roles.flatMap((r) => tools.flatMap((t) => ACCESS.map((a) => `${r} ${t} ${a}: ${role(r, t, a)}`)));
  return { ...rest, wording: { ...words, role: lines } };
}

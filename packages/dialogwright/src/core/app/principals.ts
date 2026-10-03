import { isParty, type Party } from '../../gate/types';
import { topLevelOf } from './lookup';
import type { App, IdentityConfig } from './types';

/**
 * The parties an app produces (its portal's listings, its principal directory, its policy matrix)
 * checked against what its identity declares (identity.yaml's `principals:`): a subject is of the
 * subject kind, at a level the ladder has; a delegate is of the delegate kind, never the subject
 * kind, with a role the file declares. A party that does not fit is the app's error, found when it
 * is registered (validateApp, over the portal's listings) or signed in by the harness, not when a
 * rule reads a role no one wrote down.
 */

/** What is wrong with `p` as one of the app's subjects at `level`, or null. */
export function subjectProblem(identity: IdentityConfig, p: unknown, level: 1 | 2): string | null {
  if (!isParty(p)) return 'is not a proven party (a kind, a level of 1 or 2, an id)';
  if (p.kind !== identity.subjectKind) return `is a ${p.kind}, not the app's subject kind "${identity.subjectKind}"`;
  if (p.level !== level) return `is at level ${p.level}, not ${level}`;
  if (p.level > topLevelOf(identity)) return `is at level ${p.level}, above the top of the ladder (${topLevelOf(identity)})`;
  return null;
}

/**
 * What is wrong with `p` as someone acting for the app's subjects, or null: the delegate kind (when
 * the identity names one), never the subject kind, and a role the identity declares (when it
 * declares roles: IdentityConfig.delegateRoles).
 */
export function delegateProblem(identity: IdentityConfig, p: unknown): string | null {
  if (!isParty(p)) return 'is not a proven party (a kind, a level of 1 or 2, an id)';
  if (p.kind === identity.subjectKind) return `is of the subject kind "${p.kind}", not someone acting for subjects`;
  if (identity.delegateKind !== undefined && p.kind !== identity.delegateKind) return `is a ${p.kind}, not the delegate kind "${identity.delegateKind}" identity.yaml declares`;
  const roles = identity.delegateRoles;
  if (roles !== undefined && p.role !== undefined && !roles.includes(p.role)) return `has the role "${p.role}", which identity.yaml does not declare (${roles.length > 0 ? roles.join(', ') : 'no roles'})`;
  if (roles !== undefined && roles.length > 0 && p.role === undefined) return `has no role, and identity.yaml gives every ${identity.delegateKind ?? 'delegate'} one (${roles.join(', ')})`;
  return null;
}

/** Extra ids to check through the app's principal directory, beside its portal's listings (an app with no portal lists them itself). */
export interface PrincipalIds {
  readonly subjects?: readonly string[];
  readonly delegates?: readonly string[];
}

/**
 * Every party the app's portal lists (App.portal) and every id given, through its principal
 * directory (App.principals), against its identity: one line per problem, empty when they fit. A
 * subject signs in at the level a sign-in proves (or the top of the ladder); a listed delegate's role
 * is the one its principal carries. An app without identity has no parties to check.
 */
export function principalProblems(app: App, ids: PrincipalIds = {}): string[] {
  const identity = app.identity;
  if (!identity) return [];
  const out: string[] = [];
  const dir = app.principals;
  const level = identity.signInLevel ?? topLevelOf(identity);
  const subjects = new Set([...(app.portal?.subjects?.() ?? []).map((l) => l.id), ...(ids.subjects ?? [])]);
  for (const id of subjects) {
    if (!dir?.subjectPrincipal) continue;
    const p = dir.subjectPrincipal(id, level);
    const problem = p === null ? 'is not one the app\'s principals know' : subjectProblem(identity, p, level);
    if (problem) out.push(`subject "${id}" ${problem}`);
  }
  const listed = new Map((app.portal?.delegates?.() ?? []).map((l) => [l.id, l.role] as const));
  for (const [id, role] of listed) {
    const roles = identity.delegateRoles;
    if (roles !== undefined && !roles.includes(role)) out.push(`delegate "${id}" (the portal's listing) has the role "${role}", which identity.yaml does not declare (${roles.length > 0 ? roles.join(', ') : 'no roles'})`);
  }
  for (const id of new Set([...listed.keys(), ...(ids.delegates ?? [])])) {
    if (!dir?.delegatePrincipal) continue;
    const p: Party | null = dir.delegatePrincipal(id);
    const problem = p === null ? 'is not one the app\'s principals know' : delegateProblem(identity, p);
    if (problem) out.push(`delegate "${id}" ${problem}`);
    else if (p && listed.has(id) && p.role !== listed.get(id)) out.push(`delegate "${id}" is listed by the portal as "${listed.get(id)}" but signs in as "${p.role ?? '(no role)'}"`);
  }
  return out;
}

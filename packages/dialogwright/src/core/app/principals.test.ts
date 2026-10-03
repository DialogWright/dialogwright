import { describe, expect, it } from 'vitest';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { CUSTOMERS, STAFF } from '../../testing/testkit/domain/data';
import { agentPrincipal, customerPrincipal } from '../../testing/testkit/domain/principals';
import { topLevelOf } from './lookup';
import { delegateProblem, principalProblems, subjectProblem } from './principals';
import type { App, PortalConfig } from './types';
import { validateApp } from './validate';

useTestkit();

const identity = testkitApp.identity!;
const [TAYLOR, MORGAN] = [STAFF[0]!, STAFF[1]!];
const ALEX = CUSTOMERS[0]!;

/** The testkit with a portal listing who may sign in: its customers and its staff, as a portal would. */
const PORTAL: PortalConfig = {
  subjects: () => CUSTOMERS.slice(0, 2).map((c) => ({ id: c.id, first: c.first, last: c.last })),
  delegates: () => STAFF.map((s) => ({ id: s.id, name: s.name, role: s.role })),
};
const withPortal = (portal: PortalConfig, over: Partial<App> = {}): App => ({ ...testkitApp, portal, ...over });

describe('the parties an app produces, against what identity.yaml declares', () => {
  it('the testkit\'s: every customer and every depot agent its principals produce fits', () => {
    expect(identity).toMatchObject({ subjectKind: 'customer', delegateKind: 'agent', delegateRoles: ['viewer', 'clerk'] });
    expect(topLevelOf(identity)).toBe(2);
    expect(principalProblems(testkitApp, { subjects: CUSTOMERS.slice(0, 2).map((c) => c.id), delegates: STAFF.map((s) => s.id) })).toEqual([]);
    expect(principalProblems(withPortal(PORTAL))).toEqual([]);
  });

  it('a subject of another kind or level, a delegate of another kind, with an undeclared role or none', () => {
    expect(subjectProblem(identity, customerPrincipal(ALEX, 2), 2)).toBeNull();
    expect(subjectProblem(identity, { ...customerPrincipal(ALEX, 2), kind: 'agent' }, 2)).toBe('is a agent, not the app\'s subject kind "customer"');
    expect(subjectProblem(identity, customerPrincipal(ALEX, 1), 2)).toBe('is at level 1, not 2');
    expect(subjectProblem({ ...identity, codeTool: undefined, sendCodeTool: undefined }, customerPrincipal(ALEX, 2), 2)).toBe('is at level 2, above the top of the ladder (1)');
    expect(subjectProblem(identity, { kind: 'customer' }, 2)).toBe('is not a proven party (a kind, a level of 1 or 2, an id)');
    expect(delegateProblem(identity, agentPrincipal(TAYLOR))).toBeNull();
    expect(delegateProblem(identity, customerPrincipal(ALEX, 2))).toBe('is of the subject kind "customer", not someone acting for subjects');
    expect(delegateProblem(identity, { ...agentPrincipal(TAYLOR), kind: 'courier' })).toBe('is a courier, not the delegate kind "agent" identity.yaml declares');
    expect(delegateProblem(identity, { ...agentPrincipal(TAYLOR), role: 'supervisor' })).toBe('has the role "supervisor", which identity.yaml does not declare (viewer, clerk)');
    const { role: _, ...roleless } = agentPrincipal(TAYLOR);
    expect(delegateProblem(identity, roleless)).toBe('has no role, and identity.yaml gives every agent one (viewer, clerk)');
    // An identity written in code, with no roles declared, has its roles unchecked.
    const { delegateRoles: __, ...undeclared } = identity;
    expect(delegateProblem(undeclared, { ...agentPrincipal(TAYLOR), role: 'supervisor' })).toBeNull();
  });

  it('refuses at registration a portal listing an undeclared role, a delegate who signs in otherwise, a subject the principals do not know', () => {
    const portal: PortalConfig = {
      subjects: () => [{ id: ALEX.id, first: ALEX.first, last: ALEX.last }, { id: '55509999', first: 'Nobody', last: 'Here' }],
      delegates: () => [{ id: TAYLOR.id, name: TAYLOR.name, role: 'supervisor' }, { id: MORGAN.id, name: MORGAN.name, role: 'viewer' }],
    };
    expect(principalProblems(withPortal(portal))).toEqual([
      'subject "55509999" is not one the app\'s principals know',
      'delegate "taylor" (the portal\'s listing) has the role "supervisor", which identity.yaml does not declare (viewer, clerk)',
      'delegate "taylor" is listed by the portal as "supervisor" but signs in as "viewer"',
      'delegate "morgan" is listed by the portal as "viewer" but signs in as "clerk"',
    ]);
    expect(() => validateApp(withPortal(portal, { id: 'listed' }))).toThrow('app "listed": subject "55509999" is not one the app\'s principals know');
    const courier = withPortal(PORTAL, { id: 'courier', principals: { ...testkitApp.principals!, delegatePrincipal: (id) => (id === TAYLOR.id ? { ...agentPrincipal(TAYLOR), kind: 'courier' } : null) } });
    expect(() => validateApp(courier)).toThrow('app "courier": delegate "taylor" is a courier, not the delegate kind "agent" identity.yaml declares');
    // validateApp passes the testkit, and the testkit with its staff and customers listed.
    expect(() => validateApp(testkitApp)).not.toThrow();
    expect(() => validateApp(withPortal(PORTAL))).not.toThrow();
  });
});

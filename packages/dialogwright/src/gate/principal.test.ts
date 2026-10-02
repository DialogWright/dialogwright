import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { CUSTOMERS, STAFF } from '../testing/testkit/domain/data';
import { agentPrincipal, customerPrincipal } from '../testing/testkit/domain/principals';
import { ANONYMOUS, maskId, raise } from './principal';

useTestkit();

describe('raise', () => {
  it('copies a customer principal to level 2, keeping every other field', () => {
    const p = customerPrincipal(CUSTOMERS[0]!, 1);
    expect(raise(p, 2, 'customer')).toEqual({ ...p, level: 2 });
    expect(p.level).toBe(1);
  });

  it('raises nothing that is not a customer', () => {
    expect(raise(ANONYMOUS, 2, 'customer')).toBeNull();
    expect(raise(agentPrincipal(STAFF[0]!), 2, 'customer')).toBeNull();
  });
});

describe('maskId', () => {
  it('shows only the last four digits', () => {
    expect(maskId('55505678')).toBe('...5678');
  });
});

describe('ANONYMOUS', () => {
  it('is level 0', () => {
    expect(ANONYMOUS).toEqual({ kind: 'anonymous', level: 0 });
  });
});

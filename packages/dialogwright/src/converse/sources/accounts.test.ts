import { describe, expect, it } from 'vitest';
import type { AgentBusiness } from '../business/schema';
import { accountOf } from './accounts';

const b = { sources: { accounts: [{ name: 'Acme', numbers: ['+15555550142'] }, { name: 'Bolt', numbers: [] }] } } as unknown as AgentBusiness;

describe('accountOf', () => {
  it('matches an E.164 number, and the same number in ten digits', () => {
    expect(accountOf(b, '+15555550142')).toBe('Acme');
    expect(accountOf(b, '5555550142')).toBe('Acme');
  });
  it('returns null for no match, no number or no accounts', () => {
    expect(accountOf(b, '+15555550199')).toBeNull();
    expect(accountOf(b, undefined)).toBeNull();
    expect(accountOf({ sources: {} } as unknown as AgentBusiness, '+15555550142')).toBeNull();
  });
});

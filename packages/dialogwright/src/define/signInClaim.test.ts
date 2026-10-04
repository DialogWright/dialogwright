import { describe, expect, it } from 'vitest';
import { compileIdentity } from './policyFile';
import { identitySchema } from './schema/index';
import { validateApp } from '../core/app/validate';
import { testkitApp } from '../testing/testkit/index';

/** identity.yaml's `signIn.claim`: the token claim that carries the subject's id, for a channel that signs in with a token. */
const IDENTITY = {
  principals: { subject: 'customer' },
  levels: { 1: { name: 'verified', factors: ['accountId', 'dob'], verify: 'checkFactors' } },
  attempts: 3,
};

describe('signIn.claim', () => {
  it('is read into IdentityConfig.signInClaim, and absent unless written', () => {
    expect(compileIdentity(identitySchema.parse({ ...IDENTITY, signIn: { level: 1, claim: 'account_id' } })).identity).toMatchObject({ signInLevel: 1, signInClaim: 'account_id' });
    expect(compileIdentity(identitySchema.parse({ ...IDENTITY, signIn: { level: 1, claim: 'https://example.com/account' } })).identity.signInClaim).toBe('https://example.com/account');
    const plain = compileIdentity(identitySchema.parse({ ...IDENTITY, signIn: { level: 1 } })).identity;
    expect(plain.signInLevel).toBe(1);
    expect('signInClaim' in plain).toBe(false);
  });

  it('is a token claim name: printable, no spaces, not empty', () => {
    for (const name of ['', 'account id', 'x'.repeat(201)]) {
      expect(identitySchema.safeParse({ ...IDENTITY, signIn: { level: 1, claim: name } }).success, JSON.stringify(name)).toBe(false);
    }
  });

  it('is refused in code without a sign-in level, or when it is not a token claim name', () => {
    const identity = testkitApp.identity!;
    expect(() => validateApp({ ...testkitApp, id: 'sign-in-a', identity: { ...identity, signInClaim: 'account_id' } })).not.toThrow();
    const { signInLevel: _level, ...noSignIn } = identity;
    expect(() => validateApp({ ...testkitApp, id: 'sign-in-b', identity: { ...noSignIn, signInClaim: 'account_id' } })).toThrow('identity signInClaim "account_id" needs a signInLevel');
    expect(() => validateApp({ ...testkitApp, id: 'sign-in-c', identity: { ...identity, signInClaim: 'account id' } })).toThrow('identity signInClaim "account id" is not a token claim name');
  });
});

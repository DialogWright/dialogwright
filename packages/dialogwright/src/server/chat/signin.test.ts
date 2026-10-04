import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { principalForToken, type ChatSignIn } from './signin';
import { testkitApp } from '../../testing/testkit/index';
import type { App } from '../../core/app/types';
import type { Party } from '../../gate/types';

/** Keys are made here, for this run, and never stored. */
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const ed = generateKeyPairSync('ed25519');
function token(claims: Record<string, unknown>, key: KeyObject = ed.privateKey): string {
  const head = b64url(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(cryptoSign(null, Buffer.from(`${head}.${body}`), key))}`;
}

const NOW = 1_700_000_000;
const ISS = 'https://id.example.com';
const jwt: ChatSignIn = { method: 'jwt', keyFor: async (kid) => (kid === 'k1' ? ed.publicKey : null), issuer: ISS, audience: 'chat' };
const claims = (extra: Record<string, unknown>) => ({ iss: ISS, aud: 'chat', exp: NOW + 300, iat: NOW, ...extra });

/** The testkit's two customers who may sign in (fictional): 55501234 and 55505678. */
const CUSTOMER = '55501234';

function withIdentity(over: Partial<NonNullable<App['identity']>>, principals: App['principals'] = testkitApp.principals): App {
  return { ...testkitApp, identity: { ...testkitApp.identity!, ...over }, principals };
}

describe('from a chat token to a principal', () => {
  it('jwt: the sub claim names the subject, signed in at the app\'s sign-in level', async () => {
    const r = await principalForToken(testkitApp, jwt, token(claims({ sub: CUSTOMER })), NOW);
    expect(r).toMatchObject({ ok: true, principal: { kind: 'customer', id: CUSTOMER, level: 2 } });
  });

  it('jwt: refuses a token that does not verify, naming why and never the token', async () => {
    const other = generateKeyPairSync('ed25519');
    const forged = token(claims({ sub: CUSTOMER }), other.privateKey);
    const r = await principalForToken(testkitApp, jwt, forged, NOW);
    expect(r).toEqual({ ok: false, reason: 'signature' });
    expect(JSON.stringify(r)).not.toContain(forged);
    expect(await principalForToken(testkitApp, jwt, token(claims({ sub: CUSTOMER, exp: NOW - 120 })), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(await principalForToken(testkitApp, jwt, 'not a token', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a subject the app does not have, and a token without the claim', async () => {
    expect(await principalForToken(testkitApp, jwt, token(claims({ sub: '55500000' })), NOW)).toEqual({ ok: false, reason: 'no customer has the id the token names' });
    expect(await principalForToken(testkitApp, jwt, token(claims({ email: 'someone@example.com' })), NOW)).toEqual({ ok: false, reason: 'the token has no sub claim' });
  });

  it('reads the claim identity.yaml names (signIn.claim) instead of sub, a number as its digits', async () => {
    const app = withIdentity({ signInClaim: 'account_id' });
    expect(await principalForToken(app, jwt, token(claims({ sub: 'idp-user-1', account_id: CUSTOMER })), NOW)).toMatchObject({ ok: true, principal: { id: CUSTOMER } });
    expect(await principalForToken(app, jwt, token(claims({ sub: 'idp-user-1', account_id: 55501234 })), NOW)).toMatchObject({ ok: true, principal: { id: CUSTOMER } });
    expect(await principalForToken(app, jwt, token(claims({ sub: CUSTOMER })), NOW)).toEqual({ ok: false, reason: 'the token has no account_id claim' });
  });

  it('asks the app\'s fromClaims first: it may name a delegate, and null falls back to the claim rule', async () => {
    const seen: unknown[] = [];
    const principals = {
      ...testkitApp.principals!,
      fromClaims(c: Readonly<Record<string, unknown>>): Party | null {
        seen.push(c);
        return c.staff === true ? testkitApp.principals!.delegatePrincipal!('taylor') : null;
      },
    };
    const app = withIdentity({}, principals);
    expect(await principalForToken(app, jwt, token(claims({ sub: 'x', staff: true })), NOW)).toMatchObject({ ok: true, principal: { kind: 'agent', role: expect.any(String) } });
    expect(await principalForToken(app, jwt, token(claims({ sub: CUSTOMER })), NOW)).toMatchObject({ ok: true, principal: { kind: 'customer', id: CUSTOMER } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ sub: 'x', staff: true, iss: ISS });
  });

  it('checks what fromClaims returns as the harness checks a principal', async () => {
    const wrongLevel = withIdentity({}, { ...testkitApp.principals!, fromClaims: () => testkitApp.principals!.subjectPrincipal!(CUSTOMER, 1) });
    expect(await principalForToken(wrongLevel, jwt, token(claims({ sub: CUSTOMER })), NOW)).toEqual({ ok: false, reason: 'the principal is at level 1, not 2' });
    const badRole = withIdentity({}, { ...testkitApp.principals!, fromClaims: () => ({ kind: 'agent', level: 2, id: 's1', first: 'Sam', role: 'owner' }) });
    expect(await principalForToken(badRole, jwt, token(claims({ sub: CUSTOMER })), NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('has the role "owner"') });
    const notAParty = withIdentity({}, { ...testkitApp.principals!, fromClaims: () => ({ kind: 'anonymous', level: 0 }) as unknown as Party });
    expect(await principalForToken(notAParty, jwt, token(claims({ sub: CUSTOMER })), NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('is not a proven party') });
  });

  it('mock: mock:<id> signs in that subject, with no signature at all (laptop only: the config refuses it elsewhere)', async () => {
    expect(await principalForToken(testkitApp, { method: 'mock' }, `mock:${CUSTOMER}`, NOW)).toMatchObject({ ok: true, principal: { kind: 'customer', id: CUSTOMER, level: 2 } });
    expect(await principalForToken(withIdentity({ signInClaim: 'account_id' }), { method: 'mock' }, `mock:${CUSTOMER}`, NOW)).toMatchObject({ ok: true, principal: { id: CUSTOMER } });
    expect(await principalForToken(testkitApp, { method: 'mock' }, CUSTOMER, NOW)).toEqual({ ok: false, reason: 'a mock token is mock:<id>' });
    expect(await principalForToken(testkitApp, { method: 'mock' }, 'mock:../x', NOW)).toEqual({ ok: false, reason: 'a mock token is mock:<id>' });
  });

  it('none: refuses every token', async () => {
    expect(await principalForToken(testkitApp, { method: 'none' }, token(claims({ sub: CUSTOMER })), NOW)).toEqual({ ok: false, reason: 'sign-in is off' });
  });

  it('refuses a subject when the app takes no sign-in', async () => {
    const { signInLevel: _l, ...identity } = testkitApp.identity!;
    const app: App = { ...testkitApp, identity };
    expect(await principalForToken(app, jwt, token(claims({ sub: CUSTOMER })), NOW)).toEqual({ ok: false, reason: 'this app takes no sign-in (identity.yaml has no signIn)' });
  });
});

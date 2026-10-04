import type { KeyObject } from 'node:crypto';
import type { App } from '../../core/app/types';
import { delegateProblem, subjectProblem } from '../../core/app/principals';
import type { Party } from '../../gate/types';
import { verifyJwt, type JwtRefusal } from './jwt';

/**
 * How a chat user signs in (CHAT_SIGNIN), and from a token to the principal it names. The token is
 * the site's: the engine holds no password and no signing secret, only the identity provider's
 * published keys. Which principal a token names is the app's rule: identity.yaml's `signIn.claim`
 * (default `sub`) through `principals.subjectPrincipal`, or `principals.fromClaims` in code.
 */
export type ChatSignIn =
  /** No sign-in: a token is refused. An app with identity factors may still verify a chat user by them. */
  | { method: 'none' }
  /** For a laptop only (the config refuses it unless PUBLIC_HOST is localhost): `mock:<id>` signs in that subject, unsigned. */
  | { method: 'mock' }
  /** A signed JWT from the site's identity provider, verified against its published keys. */
  | { method: 'jwt'; keyFor: (kid: string) => Promise<KeyObject | null>; issuer: string; audience: string };

/** A refusal's reason never carries the token, or a claim's value. */
export type SignInResult = { ok: true; principal: Party } | { ok: false; reason: JwtRefusal | string };

const MOCK_TOKEN = /^mock:([A-Za-z0-9_-]{1,64})$/;

/** A claim's value as an id: a string, or a whole number as its digits; anything else is none. */
function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

/** The principal a chat token signs in as, by the deployment's method and the app's rule. */
export async function principalForToken(app: App, how: ChatSignIn, token: string, nowSec: number): Promise<SignInResult> {
  if (how.method === 'none') return { ok: false, reason: 'sign-in is off' };
  const identity = app.identity;
  if (identity === undefined) return { ok: false, reason: 'this app verifies no one (it has no identity.yaml)' };
  const claim = identity.signInClaim ?? 'sub';
  let claims: Record<string, unknown>;
  if (how.method === 'mock') {
    const m = MOCK_TOKEN.exec(token);
    if (!m) return { ok: false, reason: 'a mock token is mock:<id>' };
    claims = { sub: m[1], [claim]: m[1] };
  } else {
    const r = await verifyJwt(token, how.keyFor, { issuer: how.issuer, audience: how.audience, nowSec });
    if (!r.ok) return { ok: false, reason: r.reason };
    claims = r.claims;
  }
  const level = identity.signInLevel;
  let principal = app.principals?.fromClaims?.(Object.freeze({ ...claims })) ?? null;
  if (principal === null) {
    if (level === undefined) return { ok: false, reason: 'this app takes no sign-in (identity.yaml has no signIn)' };
    const id = idOf(claims[claim]);
    if (id === null) return { ok: false, reason: `the token has no ${claim} claim` };
    principal = app.principals?.subjectPrincipal?.(id, level) ?? null;
    if (principal === null) return { ok: false, reason: `no ${identity.subjectKind} has the id the token names` };
  }
  // Checked as the harness checks a principal it signs in: what an app's code returns is not trusted blindly.
  const kind = (principal as { kind?: unknown }).kind;
  const problem = kind === identity.subjectKind
    ? (level === undefined ? 'is a subject, and this app takes no sign-in (identity.yaml has no signIn)' : subjectProblem(identity, principal, level))
    : delegateProblem(identity, principal);
  if (problem !== null) return { ok: false, reason: `the principal ${problem}` };
  return { ok: true, principal };
}

/** Whether a signed-in principal acts for the app's subjects (a delegate) rather than being one. */
export function isDelegate(app: App, p: Party): boolean {
  return p.kind !== app.identity?.subjectKind;
}

import { defaultAppId, getApp } from './app/registry';
import type { GateLookups } from '../gate/types';

/** Checks a one-time code the caller keyed against the one texted to them. */
export interface CodeVerifier { check(code: string): boolean }

/**
 * The mocked one-time code: no text is sent. Any code of four to eight digits (the lengths
 * identity.yaml allows; the lifecycle keys exactly the app's) ending in an even digit passes, so a
 * test can fail on purpose. A real verifier (Twilio Verify, the app's own) implements the same interface.
 */
export const mockCodeVerifier: CodeVerifier = {
  check: (code) => /^\d{4,8}$/.test(code) && Number(code[code.length - 1]) % 2 === 0,
};

/**
 * The systems a turn may reach, only ever through the gate (lifecycle.ts callTool): the app's own
 * (App.systems: `sys`, which only the app's tools read, and the gate's lookups over them) and the
 * one-time code verifier.
 */
export interface Tools {
  sys: unknown;
  lookups: GateLookups;
  codes: CodeVerifier;
}

/** A fresh copy of the default app's systems, with the mock code verifier. */
export function demoTools(): Tools {
  return { ...getApp(defaultAppId()).systems(), codes: mockCodeVerifier };
}

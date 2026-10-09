import { defaultAppId, getApp } from './app/registry';
import type { GateLookups, ToolName } from '../gate/types';

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
  /**
   * A test's stand-in for what the systems behind a tool answer (dialogwright/testing
   * adversarialSuite: a hostile reply from a downstream service): given what a tool's run returned,
   * what the engine reads in its place, before anything else sees it. Never set on a call: the
   * server, the CLI and every run but such a test leave it unset, and the tool's own answer is read.
   */
  answers?(tool: ToolName, ran: ToolRun): ToolRun;
}

/** What a tool's run returns (ToolDef.run): its value, its one-line summary, and the id of a record it made. */
export interface ToolRun {
  value: unknown;
  summary: string;
  ref?: string;
}

/** A fresh copy of the default app's systems, with the mock code verifier. */
export function demoTools(): Tools {
  return { ...getApp(defaultAppId()).systems(), codes: mockCodeVerifier };
}

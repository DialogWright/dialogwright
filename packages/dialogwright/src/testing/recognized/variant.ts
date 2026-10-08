import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App, VerifyOutcome } from '../../core/app/types';
import type { Session } from '../../core/session';
import { ACCOUNTS, RECOGNIZED_DIR, recognizedCode } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code (or `code`). The fixture itself is never changed, so its own
 * calls and read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function recognizedVariants(): { variant(files: Record<string, (text: string) => string>, code?: AppCode): App; dirOf(app: App): string; remove(): void } {
  const dirs = new Map<string, string>();
  return {
    variant(files, code = recognizedCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-recognized-'));
      cpSync(RECOGNIZED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
      const app = defineApp(dir, code);
      dirs.set(app.id, dir);
      return app;
    },
    dirOf(app) {
      const dir = dirs.get(app.id);
      if (dir === undefined) throw new Error(`no variant folder for the app "${app.id}"`);
      return dir;
    },
    remove() {
      for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true });
      dirs.clear();
    },
  };
}

/** A change to a file: `from` replaced by `to`, which must be there. */
export const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

/** The two lines the greeting variant adds to prompts.yaml: the greeting said before the caller-ID question, and the open question after it. */
export const GREETING_LINES = [
  '  greeting_offer:',
  '    text: Thanks for calling Example Account Line.',
  '    interruptible: true',
  '  greet_after_offer:',
  '    text: What can I help you with today?',
  '    interruptible: true',
  '',
].join('\n');

/**
 * Corpus lines at the caller-ID question at the greeting (no_form, `prompted` the date of birth, with
 * `confirm`): the date, "different account", and a request instead, each seeded with the question just
 * asked after the greeting's line (harness-text/runner.ts seedCallerMatch).
 */
export const GREETING_CORPUS = [
  '{"id":"gm-01","text":"it\'s April twelfth nineteen eighty","intent":"none","context":"no_form","prompted":"dob","confirm":"unanswered","labels":{"dobGiven":true,"dobMonth":"april","dobDay":"12","dobYear":"nineteen eighty"}}',
  '{"id":"gm-02","text":"it\'s a different account","intent":"none","context":"no_form","prompted":"dob","confirm":"no"}',
  '{"id":"gm-03","text":"I just want to report a problem","intent":"report_problem","context":"no_form","prompted":"dob","confirm":"unanswered"}',
  '',
].join('\n');

/**
 * The greeting variant: the caller-ID question is asked right after the greeting (`ask: greeting`), so a
 * call from a number matched to one account opens on `greeting_offer` and `identity_caller_match`, in
 * place of the greeting's open question, and `greet_after_offer` asks it once the caller is verified.
 */
export const GREETING: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: recognized', 'id: recognized-greeting'),
  'identity.yaml': replace('      ask: on-need\n', '      ask: greeting\n'),
  'prompts.yaml': (t) => `${t}${GREETING_LINES}`,
  'fixtures/corpus.jsonl': (t) => `${t}${GREETING_CORPUS}`,
};

/** The lines of the one-time code, which the code variant adds to prompts.yaml. */
const CODE_LINES = [
  '  ask_otp:',
  '    text: I\'ve texted a six-digit code to the phone ending in {phoneLast4}. Please key it in.',
  '    interruptible: true',
  '  ask_otp_spoken:',
  '    text: Please key the code in rather than saying it.',
  '    interruptible: true',
  '  otp_spoken_reissued:',
  '    text: For your security I\'ve sent a new code. Please key it in.',
  '    interruptible: true',
  '  otp_verified:',
  '    text: Thank you, you\'re verified.',
  '    interruptible: false',
  '  otp_failed:',
  '    text: That code didn\'t match. Please try again.',
  '    interruptible: true',
  '',
].join('\n');

/**
 * The code variant: a second rung on the ladder (a one-time code, `sendCode` and `verifyCode`), and the
 * status behind level 2. A caller-ID match and the date of birth reach level 1, as the factors they
 * stand in for do: the code is still sent and asked for. Built with codeCode.
 */
export const CODE: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: recognized', 'id: recognized-code'),
  'identity.yaml': replace(
    '# Three failed tries',
    '  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }\n# Three failed tries',
  ),
  'policy.yaml': (t) => replace('\naudit:', [
    '  verifyCode:',
    '    say: check the one-time code',
    '    level: 1',
    '    rules: [identity, attempts]',
    '  sendCode:',
    '    say: text a one-time code',
    '    level: 1',
    '    rules:',
    '      - identity',
    '      - scope: { param: accountId }',
    '',
    'audit:',
  ].join('\n'))(t.replace('    say: look up the account\n    level: 1\n', '    say: look up the account\n    level: 2\n').replace('    say: read the status of the latest request on the account\n    level: 1\n', '    say: read the status of the latest request on the account\n    level: 2\n')),
  'prompts.yaml': (t) => `${t}${CODE_LINES}`,
};

/** The account the caller verified as: the principal's. */
const verifiedAs = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : '');

/** The fixture's code with the code's two tools, and the account the code is texted for: the principal's, however it was verified. */
export const codeCode: AppCode = {
  ...recognizedCode,
  tools: {
    ...recognizedCode.tools,
    // The principal it proves carries the phone on file's last four, which the code's line says.
    verifyCustomer: {
      ...recognizedCode.tools!.verifyCustomer!,
      run(call) {
        const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId && a.dob === call.params.dob);
        const value: VerifyOutcome = account
          ? { ok: true, principal: { kind: 'customer', level: 1, id: account.accountId, first: account.first, contact: { phoneLast4: account.phone.slice(-4) } } }
          : { ok: false };
        return { value, summary: account ? 'verified' : 'no match' };
      },
    },
    verifyCode: {
      params: [],
      run(_call, _sys, { tc, code }) {
        const ok = code !== undefined && tc.tools.codes.check(code);
        return { value: ok, summary: ok ? 'code accepted' : 'code rejected' };
      },
    },
    sendCode: {
      params: ['accountId'],
      run(call) {
        const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId);
        return { value: account ? { phoneLast4: account.phone.slice(-4) } : null, summary: account ? 'texted' : 'no phone' };
      },
    },
  },
  identity: { sendCodeParams: (s) => ({ accountId: verifiedAs(s) }) },
};

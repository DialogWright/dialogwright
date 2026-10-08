import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import type { Session } from '../../core/session';
import { ACCOUNTS, PROPOSALS_DIR, proposalsCode, type ProposalFacts } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code (or `code`). The fixture itself is never changed, so its own
 * calls and read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function proposalsVariants(): { variant(files: Record<string, (text: string) => string>, code?: AppCode): App; dirOf(app: App): string; remove(): void } {
  const dirs = new Map<string, string>();
  return {
    variant(files, code = proposalsCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-proposals-'));
      cpSync(PROPOSALS_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
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

/** Each change in turn, for a file two variants change. */
export const both = (...changes: ((text: string) => string)[]) => (text: string): string => changes.reduce((t, change) => change(t), text);

/** A change to a file: `from` replaced by `to`, which must be there. */
export const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

/** The report's form line the variants below add checks after. */
const REPORT_FORM = '    hooks: [confirmedParams, complete]\n    calls: [reportProblem]\n';

/** A check on the report, added to forms.yaml. */
const reportCheck = (action: string, slots: string) => (text: string): string => (text.includes(`${REPORT_FORM}    checks:\n`)
  ? text.replace(`${REPORT_FORM}    checks:\n`, `${REPORT_FORM}    checks:\n      - action: ${action}\n        with: [${slots}]\n`)
  : replace(REPORT_FORM, `${REPORT_FORM}    checks:\n      - action: ${action}\n        with: [${slots}]\n`)(text));

/** An action added to policy.yaml, before its audit section. */
const action = (yaml: string) => replace('\naudit:', `${yaml}\naudit:`);

/**
 * The checking variant (design 2026-10-08-app-decides, item 3): the report checks the problem with an
 * action only a verified caller may pass (`checkProblem`, level 1, above what the form's entry proves,
 * since the report has none). `pnpm check` warns of it and does not refuse it. At run time the check's
 * STEP_UP asks for the account number and the date of birth, as an entry call's does, and the check
 * runs again once the caller is verified.
 */
export const CHECKING: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-checking'),
  'forms.yaml': reportCheck('checkProblem', 'problem'),
  'policy.yaml': action('  checkProblem:\n    say: check the problem is one a report is taken for\n    check: true\n    level: 1\n    rules: [identity]\n'),
};

/**
 * The age variant: the report checks the caller's date of birth, an identity factor (`checkAge`,
 * level 0), and refuses every date but one no caller has (so a run shows whether it ran). `pnpm check`
 * warns of it. The factor is empty until the caller verifies, so the engine asks for identity as soon
 * as the check waits on nothing else, and the form never completes with the check not run.
 */
export const AGE_CHECK: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-age'),
  'forms.yaml': reportCheck('checkAge', 'dob'),
  'policy.yaml': action('  checkAge:\n    say: check the caller is old enough to report\n    check: true\n    level: 0\n    rules:\n      - identity\n      - oneOf: { field: dob, values: [\'1900-01-01\'], reason: too-young }\n'),
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
 * report's problem checked at level 2 (`checkProblem`). Built with codeCode.
 */
export const CODE_CHECK: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-code'),
  'identity.yaml': replace(
    'failedPrompt: identity_failed }\n',
    'failedPrompt: identity_failed }\n  2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }\n',
  ),
  'forms.yaml': reportCheck('checkProblem', 'problem'),
  'policy.yaml': action([
    '  checkProblem:',
    '    say: check the problem is one a report is taken for',
    '    check: true',
    '    level: 2',
    '    rules: [identity]',
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
  ].join('\n')),
  'prompts.yaml': (t) => `${t}${CODE_LINES}`,
};

/** The fixture's code with the code's two tools, and the account the code is texted for. */
export const codeCode: AppCode = {
  ...proposalsCode,
  tools: {
    ...proposalsCode.tools,
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
        return { value: account ? { phoneLast4: '0142' } : null, summary: account ? 'texted' : 'no phone' };
      },
    },
  },
  identity: { sendCodeParams: (s) => ({ accountId: verifiedAs(s) }) },
};

/**
 * The later-facts variant (design 2026-10-08-app-decides, item 2): the report has an entry call that
 * needs identity (`findAccount`, level 1), and its result loads the street on file into the facts
 * (onEntry), so the address is proposed from facts loaded after identity rather than by the call-start
 * lookup. Built with laterCode.
 */
export const LATER: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-later'),
  'forms.yaml': replace(REPORT_FORM, '    hooks: [entry, onEntry, confirmedParams, complete]\n    calls: [findAccount, reportProblem]\n'),
};

/** The account the caller verified as: the principal's. */
const verifiedAs = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : '');

/** The fixture's code with the report's entry call: the account, read once the caller is verified, and its street kept in the facts. */
export const laterCode: AppCode = {
  ...proposalsCode,
  tools: {
    ...proposalsCode.tools,
    findAccount: {
      params: ['accountId'],
      run(call) {
        const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId);
        return { value: account ? { first: account.first, serviceAddress: account.serviceAddress } : null, summary: account ? 'account found' : 'no account' };
      },
    },
  },
  forms: {
    ...proposalsCode.forms,
    report_problem: {
      ...proposalsCode.forms!.report_problem!,
      entry: (s) => ({ tool: 'findAccount', params: { accountId: verifiedAs(s) } }),
      onEntry(s, value) {
        const street = (value as { serviceAddress?: unknown } | null)?.serviceAddress;
        if (typeof street === 'string' && street !== '') (s.facts as ProposalFacts).serviceAddress = street;
      },
    },
  },
};

/** The two lines the greeting variant adds to prompts.yaml: the greeting said before a proposal, and the open question after it. */
export const GREETING_LINES = [
  '  greeting_offer:',
  '    text: Thanks for calling Example Service Desk.',
  '    interruptible: true',
  '  greet_after_offer:',
  '    text: What can I help you with today?',
  '    interruptible: true',
  '',
].join('\n');

/**
 * The greeting variant (design 2026-10-08-app-decides, item 1): the address proposes at the greeting
 * (`offerAt: greeting`), so a call from a number on file opens on `greeting_offer` and `offer_place`,
 * in place of the greeting's open question, and `greet_after_offer` asks it once the proposal is settled.
 */
export const GREETING: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-greeting'),
  'slots.yaml': replace('  offer: facts\n', '  offer: facts\n  offerAt: greeting\n'),
  'prompts.yaml': (t) => `${t}${GREETING_LINES}`,
};

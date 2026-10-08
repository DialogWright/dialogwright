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
export function proposalsVariants(): { variant(files: Record<string, (text: string) => string>, code?: AppCode): App; remove(): void } {
  const dirs: string[] = [];
  return {
    variant(files, code = proposalsCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-proposals-'));
      dirs.push(dir);
      cpSync(PROPOSALS_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
      return defineApp(dir, code);
    },
    remove() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A change to a file: `from` replaced by `to`, which must be there. */
export const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

/** The report's form line the variants below add checks after. */
const REPORT_FORM = '    hooks: [confirmedParams, complete]\n    calls: [reportProblem]\n';

/**
 * The checking variant (design 2026-10-08-app-decides, item 3): the report checks the problem with an
 * action only a verified caller may pass (`checkProblem`, level 1, above what the form's entry proves,
 * since the report has none), then the caller's date of birth, an identity factor (`checkAge`, level 0).
 * `pnpm check` warns of both and refuses neither. At run time the first check's STEP_UP asks for the
 * account number and the date of birth, as an entry call's does, and the checks run again once the
 * caller is verified.
 */
export const CHECKING: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: proposals', 'id: proposals-checking'),
  'forms.yaml': replace(REPORT_FORM, `${REPORT_FORM}    checks:\n      - action: checkProblem\n        with: [problem]\n      - action: checkAge\n        with: [dob]\n`),
  'policy.yaml': replace(
    '\naudit:',
    '  checkProblem:\n    say: check the problem is one a report is taken for\n    check: true\n    level: 1\n    rules: [identity]\n  checkAge:\n    say: check the caller is old enough to report\n    check: true\n    level: 0\n    rules: [identity]\n\naudit:',
  ),
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

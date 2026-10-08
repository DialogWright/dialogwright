import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { PROPOSALS_DIR, proposalsCode } from './app';

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

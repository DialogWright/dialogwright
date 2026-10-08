import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { SCREENED_DIR, screenedCode } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code. The fixture itself is never changed, so its own calls and
 * read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function screenedVariants(): { variant(files: Record<string, (text: string) => string>): App; remove(): void } {
  const dirs: string[] = [];
  return {
    variant(files) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-screened-'));
      dirs.push(dir);
      cpSync(SCREENED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
      return defineApp(dir, screenedCode);
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

/** The two read-back lines the confirming variant adds to prompts.yaml. */
export const CONFIRMING_LINES = [
  '  confirm_ownership:',
  '    text: Just to check, {ownership}?',
  '    interruptible: true',
  '  check_area:',
  '    text: Just to check, the home is in {town}, not one of our four towns?',
  '    interruptible: true',
  '',
].join('\n');

/**
 * The confirming variant (design 2026-10-08-confirm-on-values): the ownership slot reads "rent" back
 * at once and not "own" (`confirmValues: [rent]`), and the area check reads its refusal back before
 * it acts (`confirm: check_area`).
 */
export const CONFIRMING: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: screened', 'id: screened-confirm'),
  'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  confirmValues: [rent]\n'),
  'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { confirm: check_area, say: decline_out_of_area, then: end }'),
  'prompts.yaml': (t) => `${t}${CONFIRMING_LINES}`,
};

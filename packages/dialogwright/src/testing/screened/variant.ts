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

/**
 * The screened forms.yaml as two forms (design 2026-10-08-sub-forms-and-listening): a screen that asks
 * the qualifying answers, with a check on the ownership and the town and no summary of its own, which
 * goes on (`next`) to an internal booking form. The booking lists the screen's slots again, so their
 * values and confirmations carry in, and checks the urgency and the ownership once more; it is no
 * intent, so it has a label of its own.
 */
export const NEXT_FORMS = [
  '# yaml-language-server: $schema=../../../schemas/forms.schema.json',
  'forms:',
  '  screen_home:',
  '    slots: [problem, ownership, town]',
  '    summaryPromptId: null',
  '    calls: []',
  '    checks:',
  '      - action: checkOwner',
  '        with: [ownership]',
  '        on:',
  '          not-owner: { say: decline_renter, then: end }',
  '      - action: checkArea',
  '        with: [town]',
  '        on:',
  '          out-of-area: { say: decline_out_of_area, then: end }',
  '    checksPassed: visit_qualifies',
  '    next: book_visit',
  '  book_visit:',
  '    internal: true',
  '    label: book your visit',
  '    slots: [problem, ownership, town, howUrgent, visitDay, timeOfDay]',
  '    summaryPromptId: confirm_book_visit',
  '    hooks: [confirmedParams, complete]',
  '    calls: [bookVisit]',
  '    checks:',
  '      - action: checkUrgency',
  '        with: [howUrgent]',
  '        on:',
  '          urgent: { then: handoff }',
  '      - action: checkOwner',
  '        with: [ownership]',
  '        on:',
  '          not-owner: { say: decline_renter, then: end }',
  '  urgent:',
  '    slots: []',
  '    summaryPromptId: null',
  '    hooks: [complete]',
  '    calls: []',
  '',
].join('\n');

/**
 * The two-form variant: NEXT_FORMS, the booking intent renamed to the screen's (the booking is no
 * intent), the keypad's 1 to the screen, and no corpus (its lines are labelled for the one-form
 * fixture).
 */
export const NEXT: Record<string, (text: string) => string> = {
  'app.yaml': (t) => replace('fixtures:\n  dir: src/testing/screened/fixtures\n', '')(replace('id: screened', 'id: screened-next')(t)),
  'forms.yaml': () => NEXT_FORMS,
  'intents.yaml': (t) => replace('    intent: book_visit', '    intent: screen_home')(replace('  book_visit:\n    criteria: Wants a visit', '  screen_home:\n    criteria: Wants a visit')(t)),
};

/** `changes` applied over `base`: a file both change gets base's change, then the other's. */
export function over(base: Record<string, (text: string) => string>, changes: Record<string, (text: string) => string>): Record<string, (text: string) => string> {
  const out = { ...base };
  for (const [file, change] of Object.entries(changes)) {
    const first = base[file];
    out[file] = first === undefined ? change : (t) => change(first(t));
  }
  return out;
}

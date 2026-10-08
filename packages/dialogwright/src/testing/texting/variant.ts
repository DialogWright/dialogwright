import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { TEXTING_DIR, textingCode } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code (or `code`). The fixture itself is never changed, so its own
 * calls and read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function textingVariants(): { variant(files: Record<string, (text: string) => string>, code?: AppCode): App; dirOf(app: App): string; remove(): void } {
  const dirs = new Map<string, string>();
  return {
    variant(files, code = textingCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-texting-'));
      cpSync(TEXTING_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
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

/** The text slot's offer as the fixture writes it, which the variants below change. */
const TEXT_OFFER = "    countryCode: '1'\n    onNo: skip\n    ifNone: skip\n";

/**
 * The yes-or-no variant (design 2026-10-08-offer-answers-and-consent, item 1): the text offer takes
 * only a yes or a no (`answers: yes-no`). A number said at the offer is not taken, and with no clear yes
 * it is a no; on the keypad 1 is yes and 2 is no.
 */
export const YES_NO: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: texting', 'id: texting-yes-no'),
  'slots.yaml': replace(TEXT_OFFER, `${TEXT_OFFER}    answers: yes-no\n`),
};

/** The yes-or-no variant with a no that asks the slot's own question (`onNo: ask`, the default): a required offer. */
export const YES_NO_ASKS: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: texting', 'id: texting-yes-no-asks'),
  'slots.yaml': replace(TEXT_OFFER, "    countryCode: '1'\n    ifNone: skip\n    answers: yes-no\n"),
};

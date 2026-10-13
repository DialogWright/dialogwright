import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { ROUTED_DIR, routedCode } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function (or written whole, for a file it does not have), built with the fixture's code (or `code`).
 * The fixture itself is never changed, so its own calls and read-back pages stay as they are. `remove`
 * deletes the copies (call it after the tests).
 */
export function routedVariants(): { variant(files: Record<string, string | ((text: string) => string)>, code?: AppCode): App; dirOf(app: App): string; remove(): void } {
  const dirs = new Map<string, string>();
  let made = 0;
  return {
    variant(files, code = routedCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-routed-'));
      cpSync(ROUTED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      made += 1;
      // Each variant is an app of its own id, so several can be registered side by side.
      writeFileSync(join(dir, 'app.yaml'), readFileSync(join(dir, 'app.yaml'), 'utf8').replace('id: routed\n', `id: routed-v${made}\n`));
      for (const [file, change] of Object.entries(files)) {
        writeFileSync(join(dir, file), typeof change === 'string' ? change : change(readFileSync(join(dir, file), 'utf8')));
      }
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

/** A routes.yaml written whole, with its schema line. */
export const routesFile = (body: string): string => `# yaml-language-server: $schema=../../../schemas/routes.schema.json\n${body}`;

/** A line added to prompts.yaml. */
export const line = (id: string, text: string) => (prompts: string): string => `${prompts}  ${id}:\n    text: ${text}\n    interruptible: false\n`;

/**
 * The Spanish line by a route instead of app.yaml's voice.numbers, as the fixture had it before the
 * number could name a variable: a `locale` outcome on the number called, still the way to switch on
 * anything else a condition reads (a queue in the call data). voice.numbers is taken out, and the start
 * routes gain, above the else, the language rule and, above the outage rule, the rule that does both
 * (the notice said in Spanish), so the outage rule is rule 4 and the language rule 5.
 */
export const SPANISH_BY_ROUTE: Record<string, (text: string) => string> = {
  'app.yaml': replace('  numbers:\n    env.SPANISH_LINE: es\n', ''),
  'routes.yaml': (text) =>
    replace(
      '  - when: { fact: outage, is: true }\n    say: outage_notice\n    then: continue\n  - else: continue\n',
      [
        '  - when: [{ fact: outage, is: true }, { called: env.SPANISH_LINE }]',
        '    say: outage_notice',
        '    then: locale',
        '    locale: es',
        '  - when: { fact: outage, is: true }',
        '    say: outage_notice',
        '    then: continue',
        '  - when: { called: env.SPANISH_LINE }',
        '    then: locale',
        '    locale: es',
        '  - else: continue',
        '',
      ].join('\n'),
    )(text),
};

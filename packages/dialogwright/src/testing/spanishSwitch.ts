import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp } from '../define/defineApp';
import { libraryCode, LIBRARY_DIR } from '../define/fixture/app';
import type { App } from '../core/app/types';

/** How the switch variant's keypad menu listens (intents.yaml): its 9's own fromGreeting, and menuListens. */
export interface SwitchMenu {
  /** The 9's entry says `fromGreeting: true`: that key is taken from the greeting on. */
  nineFromGreeting?: boolean;
  /** `menuListens: greeting` at the top of intents.yaml: every key is taken from the greeting on. */
  menuListens?: 'offered' | 'greeting';
}

/** The variants built, by folder, so a test file removes them once it is done. */
export interface SpanishSwitchVariants {
  /**
   * The library's folder with a `spanish` intent that switches the call to es (key 9 on the menu, first),
   * its line in both locales (`switched_to_spanish`), `voice` written under app.yaml's voice block, and
   * the menu listening as `menu` says; the app's id is `id`. Built with defineApp, not registered.
   */
  build(id: string, voice?: readonly string[], menu?: SwitchMenu): App;
  /** Delete every folder built. */
  remove(): void;
}

/** The library fixture with a language key (the engine's tests of switching language, and of the menu from the greeting). */
export function spanishSwitchVariants(): SpanishSwitchVariants {
  const scratch: string[] = [];
  return {
    build(id, voice = [], menu = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-switch-'));
      scratch.push(dir);
      cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      const appYaml = readFileSync(join(dir, 'app.yaml'), 'utf8').replace('id: library', `id: ${id}`).replace('      spell: lead\n', `      spell: lead\n${voice.map((l) => `${l}\n`).join('')}`);
      writeFileSync(join(dir, 'app.yaml'), appYaml);
      const intents = readFileSync(join(dir, 'intents.yaml'), 'utf8')
        .replace('\nmenu:\n', [
          '  spanish:',
          '    kind: informational',
          '    label: continue in Spanish',
          '    criteria: The caller asks to continue in Spanish, or says they speak Spanish',
          '    locale: es',
          '    promptId: switched_to_spanish',
          '',
          'menu:',
          '  - digit: "9"',
          '    intent: spanish',
          ...(menu.nineFromGreeting !== undefined ? [`    fromGreeting: ${menu.nineFromGreeting}`] : []),
          '',
        ].join('\n'));
      writeFileSync(join(dir, 'intents.yaml'), menu.menuListens !== undefined ? `${intents}\nmenuListens: ${menu.menuListens}\n` : intents);
      appendFileSync(join(dir, 'prompts.yaml'), '  switched_to_spanish:\n    text: Of course, we will continue in Spanish.\n    interruptible: false\n');
      appendFileSync(join(dir, 'locale', 'es', 'prompts.yaml'), '  switched_to_spanish:\n    text: Muy bien, seguimos en español.\n    interruptible: false\n');
      return defineApp(dir, libraryCode);
    },
    remove() {
      for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

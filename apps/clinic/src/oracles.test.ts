import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * testing/oracles/ holds frozen copies of the hand-written slots the library types replaced. They
 * exist so the grid tests can catch drift in the library; no code that runs in the app may depend on them.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const ORACLES = fileURLToPath(new URL('./testing/oracles/', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

describe('the clinic oracles', () => {
  it('are imported only by test files', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('.test.ts') || file.startsWith(ORACLES)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        if (/(^|\/)oracles(\/|$)/.test(match[1]!)) offenders.push(`${relative(SRC, file)} imports ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('say so in a header comment', () => {
    const files = sourceFiles(ORACLES);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), relative(SRC, file)).toMatch(/^\/\/ ORACLE: a frozen copy of the hand-written slot/);
    }
  });
});

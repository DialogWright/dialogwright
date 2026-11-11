import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every file a module imports, transitively, by relative specifier. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)'/g)) {
      const base = resolve(dirname(file), m[1]!);
      for (const c of [`${base}.ts`, join(base, 'index.ts')]) {
        try {
          readFileSync(c);
          visit(c);
          break;
        } catch {
          // not this candidate
        }
      }
    }
  };
  visit(entry);
  return seen;
}

describe('converse/model imports', () => {
  it('reaches the scripted engine only through the leaf render/endpoints.ts', () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testStream.ts');
    const all = new Set(files.flatMap((f) => [...closure(join(dir, f))]));
    const src = resolve(dir, '../..');
    const outside = [...all].map((f) => f.slice(src.length + 1)).filter((f) => !f.startsWith('converse/model/'));
    expect(outside).toEqual(['render/endpoints.ts']);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIBRARY_DIR } from '../define/fixture/app';
import { evalCommand } from './cli';

const io = (env: Record<string, string>) => {
  const err: string[] = [];
  return { err, io: { out: () => {}, err: (l: string) => err.push(l), invokedFrom: process.cwd(), env } };
};

describe('dialogwright eval', () => {
  it('refuses in CI with exit 2 and a message', async () => {
    const t = io({ CI: '1' });
    expect(await evalCommand(['apps/x', '--personas', 'p.yaml'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/refused in CI/);
  });

  it('refuses a model whose price is unknown, unless allowed', async () => {
    const t = io({});
    expect(await evalCommand(['.', '--personas', 'p.yaml', '--judge', 'anthropic:claude-sonnet-5-5'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/no price is known for the judge model/);
  });

  it('refuses to start without the real decision model unless --stub-decision is passed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eval-cli-')), 'p.yaml');
    writeFileSync(file, 'personas:\n  - id: a\n    goal: g\n    truth: { n: m }\n    manner: plain\n    expects: none\n');
    const t = io({ ANTHROPIC_API_KEY: 'not-a-key' });
    expect(await evalCommand([LIBRARY_DIR, '--personas', file], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/TYPESAFE_API_KEY is unset.*--stub-decision/);
  });

  it('wants the folder and the personas file', async () => {
    const t = io({});
    expect(await evalCommand([], t.io)).toBe(2);
  });
});

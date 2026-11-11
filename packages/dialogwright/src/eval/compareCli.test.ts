import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIBRARY_DIR } from '../define/fixture/app';
import { COMPARE_USAGE, compareCommand } from './compareCli';

const io = (env: Record<string, string>) => {
  const err: string[] = [];
  return { err, io: { out: () => {}, err: (l: string) => err.push(l), invokedFrom: process.cwd(), env } };
};

describe('dialogwright eval:compare', () => {
  it('refuses in CI with exit 2 and a message', async () => {
    const t = io({ CI: '1' });
    expect(await compareCommand(['apps/x', '--personas', 'p.yaml', '--candidates', 'inception:mercury-3'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/refused in CI/);
  });

  it('wants the folder, the personas and the candidates', async () => {
    const t = io({});
    expect(await compareCommand(['.', '--personas', 'p.yaml'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/--candidates/);
  });

  it('refuses an effort it does not know', async () => {
    const t = io({});
    expect(await compareCommand(['.', '--personas', 'p.yaml', '--candidates', 'inception:mercury-3#fast'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/effort/);
  });

  it('takes --publish, and judges with Claude Sonnet 5.5 by default', async () => {
    const t = io({});
    expect(await compareCommand(['.', '--personas', 'p.yaml', '--publish', '--candidates', 'inception:mercury-3#fast'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/effort/);
    expect(COMPARE_USAGE).toContain('--publish writes each candidate\'s summary.md as a page to commit');
    expect(COMPARE_USAGE).toContain('--judge anthropic:claude-sonnet-5-5');
  });

  it('holds each candidate to the contradicted claims, and takes --judge none: every candidate runs, to be judged by hand', async () => {
    expect(COMPARE_USAGE).toMatch(/contradicted material claims/);
    expect(COMPARE_USAGE).toMatch(/--judge none/);
    expect(COMPARE_USAGE).toMatch(/eval:rejudge <out> --verdicts/);
    const file = join(mkdtempSync(join(tmpdir(), 'compare-cli-')), 'p.yaml');
    writeFileSync(file, 'personas:\n  - id: a\n    goal: g\n    truth: { n: m }\n    manner: plain\n    expects: none\n');
    // No judge is priced or resolved: the command goes on to its next check.
    const t = io({ ANTHROPIC_API_KEY: 'not-a-key' });
    expect(await compareCommand([LIBRARY_DIR, '--personas', file, '--candidates', 'inception:mercury-3', '--judge', 'none'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/for a converse app/);
  });

  it('is for a converse app', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'compare-cli-')), 'p.yaml');
    writeFileSync(file, 'personas:\n  - id: a\n    goal: g\n    truth: { n: m }\n    manner: plain\n    expects: none\n');
    const t = io({ ANTHROPIC_API_KEY: 'not-a-key' });
    expect(await compareCommand([LIBRARY_DIR, '--personas', file, '--candidates', 'inception:mercury-3'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/for a converse app/);
  });
});

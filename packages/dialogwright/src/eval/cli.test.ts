import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIBRARY_DIR } from '../define/fixture/app';
import { EVAL_USAGE, evalCommand, registerFolderApp, runEval } from './cli';
import { costUsd } from '../converse/model/price';
import { fakeModel } from '../converse/model/fake';
import { Budget } from './budget';
import { judgeSystem, NOT_JUDGED, VERDICT } from './judge';
import type { Persona } from './personas';

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
    expect(await evalCommand(['.', '--personas', 'p.yaml', '--judge', 'anthropic:claude-unpriced-test'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/no price is known for the judge model/);
  });

  it('refuses to start without the real decision model unless --stub-decision is passed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eval-cli-')), 'p.yaml');
    writeFileSync(file, 'personas:\n  - id: a\n    goal: g\n    truth: { n: m }\n    manner: plain\n    expects: none\n');
    const t = io({ ANTHROPIC_API_KEY: 'not-a-key' });
    expect(await evalCommand([LIBRARY_DIR, '--personas', file], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/TYPESAFE_API_KEY is unset.*--stub-decision/);
  });

  it('refuses an opener it does not know', async () => {
    const t = io({});
    expect(await evalCommand(['.', '--personas', 'p.yaml', '--opener', 'always'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/--opener is one of acknowledge/);
  });

  it('judges with Claude Sonnet 5.5 by default, a priced model, and says so', () => {
    expect(EVAL_USAGE).toMatch(/--judge anthropic:claude-sonnet-5-5 \(a cheaper one with --judge\)/);
    expect(costUsd('anthropic:claude-sonnet-5-5', { inputTokens: 1, outputTokens: 1 })).not.toBeNull();
  });

  it('takes --publish, the summary as a page to commit', async () => {
    const t = io({});
    // The command line is read whole before anything runs: --publish is known, and the opener check answers.
    expect(await evalCommand(['.', '--personas', 'p.yaml', '--publish', '--opener', 'always'], t.io)).toBe(2);
    expect(t.err.join('\n')).toMatch(/--opener is one of acknowledge/);
    expect(EVAL_USAGE).toContain('--publish writes summary.md as a page to commit');
  });

  it('--judge none resolves no judge and prices none: it goes on to the next check', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eval-cli-')), 'p.yaml');
    writeFileSync(file, 'personas:\n  - id: a\n    goal: g\n    truth: { n: m }\n    manner: plain\n    expects: none\n');
    const t = io({ ANTHROPIC_API_KEY: 'not-a-key' });
    expect(await evalCommand([LIBRARY_DIR, '--personas', file, '--judge', 'none'], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/TYPESAFE_API_KEY is unset/);
    expect(t.err.join('\n')).not.toMatch(/judge/);
    expect(EVAL_USAGE).toMatch(/--judge none/);
  });

  it('--judge none: the calls are made and stored with no judge asked, each with its judge input and a placeholder verdict, and the summary says they wait', async () => {
    const app = await registerFolderApp(LIBRARY_DIR);
    const out = mkdtempSync(join(tmpdir(), 'eval-none-'));
    try {
      // The caller hangs up at once: the call is the line's greeting alone.
      const caller = fakeModel([[{ type: 'tool_call', id: 'h', name: 'hang_up', args: {} }, { type: 'done', stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } }]]);
      const persona: Persona = { id: 'reader', goal: 'Ask whether a book is in.', truth: { name: 'Pat Example' }, manner: 'Plain.', expects: 'answer' };
      const o = await runEval({ appDir: LIBRARY_DIR, app, personas: [persona], runs: 1, parallel: 1, port: 0, env: {}, callerModel: caller, judgeModel: null, decision: 'stub', spend: new Budget(1, () => {}), outDir: out });
      expect(o.records).toHaveLength(1);
      expect(o.records[0]!.call.turns.length).toBeGreaterThan(0);
      expect(o.records[0]!.judged.notes).toBe(NOT_JUDGED);
      expect(o.records[0]!.failures).toEqual([]);
      const stored = JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8').trim()) as { judged: { notes: string } };
      expect(stored.judged.notes).toBe(NOT_JUDGED);
      const input = readFileSync(join(out, 'judge-inputs', 'reader-0.md'), 'utf8');
      expect(input).toContain(judgeSystem());
      expect(input).toContain(JSON.stringify(VERDICT.parameters, null, 2));
      expect(input).toContain('## The transcript');
      expect(input).toContain(o.records[0]!.call.turns[0]!.text);
      expect(o.text).toContain('Judge: none.');
      expect(o.text).toContain('| Calls judged | 0 of 1 |');
      expect(o.text).toContain('1 of 1 calls wait for verdicts');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 20_000);

  it('wants the folder and the personas file', async () => {
    const t = io({});
    expect(await evalCommand([], t.io)).toBe(2);
  });
});

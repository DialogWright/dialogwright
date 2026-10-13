import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { routedApp } from '../testing/routed/app';
import { main } from './cli';

/**
 * The text harness runs a scripted call with its own "env" alone, never the shell's: the conditions
 * and the app's code (ctx.env) read the same settings wherever it runs. The routed fixture's vip
 * predicate reads VIP_NUMBERS.
 */

resetAppsForTest();
registerApp(routedApp);

const dir = mkdtempSync(join(tmpdir(), 'cli-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the text harness\'s scripted calls', () => {
  it('read their own env, never the shell\'s', async () => {
    const OPEN = '2026-10-12T10:00:00-04:00';
    const caller = '+15555550177';
    writeFileSync(join(dir, 'calls.json'), JSON.stringify([
      { id: 'no-env', now: OPEN, callerNumber: caller, steps: [], expect: { decision: 'prompt', promptId: 'greeting' } },
      { id: 'own-env', now: OPEN, callerNumber: caller, env: { VIP_NUMBERS: caller }, steps: [], expect: { decision: 'handoff', reason: 'vip' } },
    ]));
    const argv = process.argv;
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    vi.stubEnv('VIP_NUMBERS', caller);
    try {
      process.argv = [argv[0]!, 'cli', '--scenarios', dir, '--client', 'heuristic', '--quiet'];
      await main();
    } finally {
      process.argv = argv;
      log.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(lines).toContain('PASS  no-env');
    expect(lines).toContain('PASS  own-env');
  });
});

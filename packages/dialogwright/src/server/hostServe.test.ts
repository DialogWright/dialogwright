import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main, SERVE_USAGE } from './hostServe';
import type { Sidecars } from './index';
import type { ServerConfig } from './config';
import { useTestkit } from '../testing/apps';

useTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };

/** The command with the server faked: what it was handed to start beside it, run as the server would. */
async function run(argv: string[], env: NodeJS.ProcessEnv, invokedFrom = dirname(FIXTURE)): Promise<{ code: number; out: string[]; sidecars: Sidecars | null }> {
  const out: string[] = [];
  let sidecars: Sidecars | null = null;
  const code = await main(argv, { out: (l) => out.push(l), env, invokedFrom, serve: async (start) => { sidecars = await start({} as ServerConfig); } });
  return { code, out, sidecars };
}

describe('dialogwright serve', () => {
  it('serves the apps of the host file --host names, HOST_FILE names, or host.yaml where it is run', async () => {
    for (const [argv, env] of [[['--host', FIXTURE], {}], [[], { HOST_FILE: FIXTURE }], [[], {}]] as const) {
      const { code, sidecars } = await run([...argv], { ...NUMBERS, ...env });
      expect(code).toBe(0);
      expect(sidecars!.overrides!.apps!.apps.map((a) => a.id)).toEqual(['callback', 'routed']);
    }
  });

  it('reads the .env beside host.yaml when neither ENV_FILE nor --env-file names a settings file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-'));
    try {
      writeFileSync(join(dir, 'host.yaml'), 'apps: [../nowhere]\n');
      writeFileSync(join(dir, '.env'), 'PORT=3000\n');
      const env: NodeJS.ProcessEnv = {};
      await run(['--host', join(dir, 'host.yaml')], env).catch(() => undefined);
      expect(env.ENV_FILE).toBe(join(dir, '.env'));
      const named: NodeJS.ProcessEnv = { ENV_FILE: '/elsewhere.env' };
      await run(['--host', join(dir, 'host.yaml')], named).catch(() => undefined);
      expect(named.ENV_FILE).toBe('/elsewhere.env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says how to name a host file when there is none, and stops on a number unset', async () => {
    const none = await run([], {}, join(dirname(FIXTURE), '..'));
    expect(none.code).toBe(2);
    expect(none.out.join('\n')).toContain(SERVE_USAGE);
    await expect(run(['--host', FIXTURE], {})).rejects.toThrow('CALLBACK_LINE, which is not set');
  });
});

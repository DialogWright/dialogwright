import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApp } from '../../core/app/registry';
import { loadFolderApp } from '../../define/pageCommand';
import { CARRIERS, GOINGS, scriptFromScenario, takeovers, type Carrier, type Going, type Stack } from './driver';

/**
 * The takeover driver's command line, which `pnpm multi:test` (scripts/multi-test.mjs) runs:
 *
 *   tsx packages/dialogwright/src/testing/multi/cli.ts --stack compose|in-process --app <folder>
 *       --scenario <id> --go-after <n> [--carriers twilio,telnyx] [--goings crash,drain]
 *
 * `compose`: against the compose stack's containers (the file and project in MULTI_COMPOSE_FILE and
 * MULTI_PROJECT, its secrets and ports in the environment). `in-process`: against two servers of the
 * app in this process, on PGlite and a fake S3 store, with the same settings: the same call and the
 * same checks with no Docker. The app's module is imported to register it (as `dialogwright regress`
 * does): never run this on a folder whose code you would not run.
 */

export const MULTI_USAGE = 'usage: tsx packages/dialogwright/src/testing/multi/cli.ts --stack compose|in-process --app <folder> --scenario <id> --go-after <n> [--carriers twilio,telnyx] [--goings crash,drain]';

export async function main(argv: readonly string[], out: (line: string) => void = console.log): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!['--stack', '--app', '--scenario', '--go-after', '--carriers', '--goings'].includes(k) || v === undefined) {
      out(MULTI_USAGE);
      return 2;
    }
    flags.set(k, v);
  }
  const stackKind = flags.get('--stack');
  const appDir = flags.get('--app');
  const scenario = flags.get('--scenario');
  const goAfter = Number(flags.get('--go-after'));
  const carriers = (flags.get('--carriers') ?? CARRIERS.join(',')).split(',') as Carrier[];
  const goings = (flags.get('--goings') ?? GOINGS.join(',')).split(',') as Going[];
  if ((stackKind !== 'compose' && stackKind !== 'in-process') || !appDir || !scenario || carriers.some((c) => !CARRIERS.includes(c)) || goings.some((g) => !GOINGS.includes(g))) {
    out(MULTI_USAGE);
    return 2;
  }
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), appDir);
  const log = (line: string): void => out(`[multi] ${line}`);
  let stack: (Stack & { close(): Promise<void> }) | null = null;
  try {
    const script = scriptFromScenario(dir, scenario, goAfter);
    log(`${stackKind}: ${dir}, scenario ${scenario} (${script.says.length} lines; the server holding the call goes after ${goAfter})`);
    if (stackKind === 'in-process') {
      // In the app's folder, as the server runs in it (the container's working directory) and as regress
      // does: the app's fixtures, its corpus among them, are read from there.
      process.chdir(dir);
      registerApp(await loadFolderApp(dir));
      const { inProcessStack } = await import('./inProcess');
      stack = await inProcessStack();
    } else {
      const file = process.env.MULTI_COMPOSE_FILE;
      const project = process.env.MULTI_PROJECT;
      if (!file || !project) throw new Error('MULTI_COMPOSE_FILE and MULTI_PROJECT name the compose stack (pnpm multi:test sets them)');
      const { composeReady, composeStack } = await import('./compose');
      const o = { file, project, env: process.env, log };
      log('waiting for the balancer and both servers to say /ready 200');
      await composeReady(o);
      stack = await composeStack(o);
    }
    const reports = await takeovers(stack, script, { carriers, goings, log });
    log(`all ${reports.length} takeovers held: ${reports.map((r) => `${r.going} ${r.carrier} (${r.holder} -> ${r.survivor})`).join(', ')}; the audit verifies`);
    return 0;
  } catch (e) {
    log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await stack?.close().catch(() => {});
  }
}

// Run when invoked directly (tsx cli.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(await main(process.argv.slice(2)));
}

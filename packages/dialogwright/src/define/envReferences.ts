import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { envReferencesIn, type EnvReference } from '../core/app/envReference';

/**
 * The environment variables an app folder names (`env.<NAME>`): app.yaml's (startParameters, transfer
 * targets, a target's called condition) and routes.yaml's (a route's called condition), each with the
 * file it is in, read from the YAML alone, with no app code loaded, so `pnpm diagnose` can say whether
 * each is set without running the app. Empty when the folder has neither file; null when one cannot be
 * read as YAML (`pnpm check` says why).
 */
export function appYamlEnvReferences(appDir: string): EnvReference[] | null {
  const out: EnvReference[] = [];
  for (const name of ['app.yaml', 'routes.yaml']) {
    const file = join(appDir, name);
    if (!existsSync(file)) continue;
    try {
      out.push(...envReferencesIn(parse(readFileSync(file, 'utf8')) as unknown).map((r) => ({ ...r, file: name })));
    } catch {
      return null;
    }
  }
  return out;
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { envReferencesIn, type EnvReference } from '../core/app/envReference';

/**
 * The environment variables an app folder's app.yaml names (`env.<NAME>`: startParameters; transfer
 * targets later), read from the YAML alone, with no app code loaded, so `pnpm diagnose` can say whether
 * each is set without running the app. Empty when the folder has no app.yaml; null when it cannot be
 * read as YAML (`pnpm check` says why).
 */
export function appYamlEnvReferences(appDir: string): EnvReference[] | null {
  const file = join(appDir, 'app.yaml');
  if (!existsSync(file)) return [];
  try {
    return envReferencesIn(parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

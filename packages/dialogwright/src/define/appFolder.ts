import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The nearest folder at or above `from` with an app.yaml, or null: what a command given no folder
 * means when it is run inside an app (a project of its own, or a folder of one). It stops at a folder
 * with pnpm-workspace.yaml, whose apps a command finds under apps/ instead.
 */
export function appFolderAt(from: string): string | null {
  for (let at = from; ; at = dirname(at)) {
    if (existsSync(join(at, 'app.yaml'))) return at;
    if (existsSync(join(at, 'pnpm-workspace.yaml')) || dirname(at) === at) return null;
  }
}

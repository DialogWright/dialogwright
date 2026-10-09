import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this package is, and how it runs: from the DialogWright repository (its src/, with no build,
 * or the build beside it), or installed in a project's node_modules. One definition, which the
 * commands that behave differently in a project of its own (create-app, and the commands that find
 * an app to run) read. The path is the same from src/define and from dist/define.
 */

/** The package's folder. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The folder two above it: the repository root, when the package runs from the repository. */
export const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
/** Whether the package is installed in a project's node_modules. */
export const INSTALLED = PACKAGE_DIR.split(sep).includes('node_modules');
/** Whether the package runs from the DialogWright repository: not installed, with pnpm-workspace.yaml at the root. */
export const IN_REPOSITORY = !INSTALLED && existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'));

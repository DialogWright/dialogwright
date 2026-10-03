import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `dialogwright create-app`: a new app folder from the template in templates/app (and, with
 * `identity`, the files templates/app-identity changes), with the name put in. Plain code, no model:
 * the same name gives the same files. The result passes `pnpm check`, its type check, its tests and
 * its stub regression as it is; the template is real files in the repository so that it can be read,
 * and so that a test builds it.
 *
 * Template files are text. `{{name}}`, `{{display}}`, `{{mark}}` and `{{root}}` are replaced (the
 * app's id, its display name, two letters for its brand mark, and the path from the new folder to the
 * repository root); `{{#identity}}...{{/identity}}` keeps what it wraps (whole lines, or words in a
 * line) only with `--identity` and `{{^identity}}...{{/identity}}` only without it. In the identity overlay a file replaces the
 * base's, and a file whose name ends in `.append` is added to the end of the base's file of that
 * name.
 */

/** The repository's package folder and its template folders. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_DIR = join(PACKAGE_DIR, 'templates', 'app');
export const IDENTITY_TEMPLATE_DIR = join(PACKAGE_DIR, 'templates', 'app-identity');
/** The repository root: the folder with pnpm-workspace.yaml above this package. */
export const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

/** A name that cannot be used, or a folder that cannot be written: the message says what to do. */
export class CreateAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateAppError';
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 40;

/** Why `name` cannot name an app, or null when it can: lowercase letters, digits and single hyphens, starting with a letter. */
export function nameProblem(name: string): string | null {
  if (name === '') return 'give the app a name: pnpm create-app <name>';
  if (name.length > MAX_NAME_LENGTH) return `"${name}" is longer than ${MAX_NAME_LENGTH} characters; use a shorter name`;
  if (!NAME_PATTERN.test(name)) {
    return `"${name}" is not a valid app name; use lowercase letters, digits and single hyphens, starting with a letter (for example "water-utility")`;
  }
  return null;
}

/** The name as a display name: "water-utility" is "Water Utility". */
export function displayNameOf(name: string): string {
  return name.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Two capital letters for the brand mark: the initials of the first two words, or the first two letters of a single word. */
export function markOf(display: string): string {
  const words = display.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  const letters = words.length >= 2 ? words.slice(0, 2).map((w) => w.charAt(0)).join('') : (words[0] ?? 'App').slice(0, 2);
  return letters.toUpperCase();
}

export interface CreateAppOptions {
  name: string;
  /** The display name the console and the greeting use. Default: the name in capitals. */
  display?: string;
  /** Adds identity.yaml: callers verify with two factors before the booking. */
  identity?: boolean;
  /** The new app's folder, absolute. Default: apps/<name> of the repository. */
  dir?: string;
  /** The repository root, which the folder's relative paths (schemas, tsconfig) lead to. Default: this repository. */
  root?: string;
}

export interface CreatedApp {
  /** The new folder, absolute. */
  dir: string;
  /** Every file written, relative to the folder, in order. */
  files: string[];
  /** The package name in its package.json. */
  packageName: string;
  /** Whether the folder is directly under apps/ of the repository, where the workspace finds it. */
  inWorkspace: boolean;
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split(sep).join('/')]));
}

/** `{{name}}` and the others replaced, and the identity blocks kept or dropped. A `{{token}}` left over is a template bug, so it throws. */
export function render(text: string, values: Record<string, string>, identity: boolean): string {
  const block = (open: string): RegExp => new RegExp(`^[ \\t]*${open}[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\\{\\{/identity\\}\\}[ \\t]*\\n`, 'gm');
  const inline = (open: string): RegExp => new RegExp(`${open}(.*?)\\{\\{/identity\\}\\}`, 'g');
  const withIdentity = text
    .replace(block('\\{\\{#identity\\}\\}'), (_m, body: string) => (identity ? body : ''))
    .replace(block('\\{\\{\\^identity\\}\\}'), (_m, body: string) => (identity ? '' : body))
    .replace(inline('\\{\\{#identity\\}\\}'), (_m, body: string) => (identity ? body : ''))
    .replace(inline('\\{\\{\\^identity\\}\\}'), (_m, body: string) => (identity ? '' : body));
  const out = withIdentity.replace(/\{\{(name|display|mark|root)\}\}/g, (_m, key: string) => values[key]!);
  const left = /\{\{[^}]*\}\}/.exec(out);
  if (left) throw new Error(`template token ${left[0]} is not one create-app knows`);
  return out;
}

/** What goes where: the template's files by path, with the identity overlay applied. */
export function templateFiles(identity: boolean): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of listFiles(TEMPLATE_DIR)) files.set(file, readFileSync(join(TEMPLATE_DIR, file), 'utf8'));
  if (identity) {
    for (const file of listFiles(IDENTITY_TEMPLATE_DIR)) {
      const text = readFileSync(join(IDENTITY_TEMPLATE_DIR, file), 'utf8');
      if (file.endsWith('.append')) {
        const target = file.slice(0, -'.append'.length);
        const base = files.get(target);
        if (base === undefined) throw new Error(`the identity template appends to ${target}, which the template does not have`);
        files.set(target, `${base.endsWith('\n') ? base : `${base}\n`}${text}`);
      } else files.set(file, text);
    }
  }
  return files;
}

/** `path` with the symbolic links of its existing part resolved (a temporary folder on macOS is under /var, which is /private/var), so a relative path from it is one a tool finds from the real folder too. */
function realPath(path: string): string {
  const rest: string[] = [];
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...rest);
}

/** Writes the new app folder. Throws a CreateAppError for a bad name or a folder that exists; writes nothing then. */
export function createApp(options: CreateAppOptions): CreatedApp {
  const problem = nameProblem(options.name);
  if (problem) throw new CreateAppError(problem);
  const root = resolve(options.root ?? REPO_ROOT);
  const dir = resolve(options.dir ?? join(root, 'apps', options.name));
  if (existsSync(dir)) {
    throw new CreateAppError(`${dir} already exists; create-app never writes into an existing folder. Choose another name, or --dir, or remove the folder first`);
  }
  const display = options.display?.trim() || displayNameOf(options.name);
  if (/[\n\r{}]/.test(display)) throw new CreateAppError('the display name may not have a line break or braces');
  const identity = options.identity === true;
  const values = { name: options.name, display, mark: markOf(display), root: relative(realPath(dir), realPath(root)).split(sep).join('/') || '.' };

  const written: string[] = [];
  const files = templateFiles(identity);
  const rendered = new Map([...files].map(([file, text]) => [file, render(text, values, identity)] as const));
  for (const [file, text] of rendered) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
    written.push(file);
  }
  const apps = join(root, 'apps');
  return { dir, files: written, packageName: `@dialogwright/example-${options.name}`, inWorkspace: dirname(dir) === apps && statSync(dir).isDirectory() };
}

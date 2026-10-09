import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { INSTALLED, PACKAGE_DIR, REPO_ROOT } from './home';
import { packagePathOf, REPOSITORY_PAGES, relinkMarkdown } from './shipped';

/**
 * `dialogwright create-app`: a new app folder from the template in templates/app (and, with
 * `identity`, the files templates/app-identity changes), with the name put in. Plain code, no model:
 * the same name gives the same files. The result passes `pnpm check`, its type check, its tests and
 * its stub regression as it is; the template is real files in the repository so that it can be read,
 * and so that a test builds it.
 *
 * Template files are text. `{{name}}`, `{{display}}`, `{{mark}}` and `{{root}}` are replaced (the
 * app's id, its display name, two letters for its brand mark, and the path from the new folder to the
 * repository root), and so are `{{schemas}}` (the folder of the JSON Schemas, from the app folder),
 * `{{run}}` (how a root command is run: `pnpm` in this repository, `npx dialogwright` in a project of
 * its own) and `{{dependency}}` (the version of `dialogwright` a project of its own depends on);
 * `{{#identity}}...{{/identity}}` keeps what it wraps (whole lines, or words in a
 * line) only with `--identity` and `{{^identity}}...{{/identity}}` only without it. In the identity overlay a file replaces the
 * base's, and a file whose name ends in `.append` is added to the end of the base's file of that
 * name.
 *
 * With `standalone`, the app is a project of its own, outside this repository, on the installed
 * package: the standalone overlay (templates/standalone) replaces the files that name this
 * repository (package.json, tsconfig.json, README.md, CLAUDE.md) and adds a .gitignore (`gitignore`
 * in the template, since a package's .gitignore is not packed); src/regress.ts is left out
 * (`dialogwright regress` runs the regression); and the create-app skill is copied into
 * .claude/skills/create-app, its links to the guide pointing at the installed package's copy.
 */

/** The template folders. */
export const TEMPLATE_DIR = join(PACKAGE_DIR, 'templates', 'app');
export const IDENTITY_TEMPLATE_DIR = join(PACKAGE_DIR, 'templates', 'app-identity');
export const STANDALONE_TEMPLATE_DIR = join(PACKAGE_DIR, 'templates', 'standalone');
export { REPO_ROOT };
/** The create-app skill a project of its own gets: this repository's, or, installed, the copy the package carries. */
export const SKILL_DIR = INSTALLED ? join(PACKAGE_DIR, 'skills', 'create-app') : join(REPO_ROOT, '.claude', 'skills', 'create-app');
/** Where the skill is in this repository (and in a project), which its links are relative to. */
const SKILL_REPO_PATH = '.claude/skills/create-app';
/** Where the package carries its copy. */
const SKILL_PACKAGE_PATH = 'skills/create-app';
/** The engine package's version: a project of its own depends on `^` it unless told otherwise. */
export const ENGINE_VERSION = (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
/** The files the base template has that a project of its own goes without. */
const STANDALONE_DROPS = ['src/regress.ts'];

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
  // Letters and digits only, in any script: "Joe's \"Fix\"" is JF, "Café Niño" is CN.
  const words = display.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w !== '');
  const letters = words.length >= 2 ? words.slice(0, 2).map((w) => [...w][0]!).join('') : [...(words[0] ?? 'App')].slice(0, 2).join('');
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
  /** A project of its own, outside this repository, depending on the installed `dialogwright` (templates/standalone). */
  standalone?: boolean;
  /** With `standalone`: the `dialogwright` dependency its package.json names (a range, or a `file:` path to a packed package). Default: `^` this package's version. */
  dependency?: string;
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
  /** Whether it is a project of its own (--standalone). */
  standalone: boolean;
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split(sep).join('/')]));
}

/**
 * `{{name}}` and the others replaced, and the identity blocks (and the standalone blocks,
 * `{{#standalone}}...{{/standalone}}` and `{{^standalone}}...{{/standalone}}`) kept or dropped. A
 * `{{token}}` left over is a template bug, so it throws. With `file` (the path it is written to), the
 * display name is written as that file's syntax needs it (see below); without, as it is.
 */
export function render(text: string, values: Record<string, string>, identity: boolean, standalone = false, file?: string): string {
  const blocks = (input: string, flag: string, on: boolean): string => {
    const block = (open: string): RegExp => new RegExp(`^[ \\t]*${open}[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\\{\\{/${flag}\\}\\}[ \\t]*\\n`, 'gm');
    const inline = (open: string): RegExp => new RegExp(`${open}(.*?)\\{\\{/${flag}\\}\\}`, 'g');
    return input
      .replace(block(`\\{\\{#${flag}\\}\\}`), (_m, body: string) => (on ? body : ''))
      .replace(block(`\\{\\{\\^${flag}\\}\\}`), (_m, body: string) => (on ? '' : body))
      .replace(inline(`\\{\\{#${flag}\\}\\}`), (_m, body: string) => (on ? body : ''))
      .replace(inline(`\\{\\{\\^${flag}\\}\\}`), (_m, body: string) => (on ? '' : body));
  };
  const withIdentity = blocks(blocks(text, 'identity', identity), 'standalone', standalone);
  // In this repository the schemas and the commands follow from the path to the root, as they did before a project of its own had its own.
  const given: Record<string, string> = values.root === undefined ? values : { schemas: `${values.root}/packages/dialogwright/schemas`, run: 'pnpm', ...values };
  const token = /\{\{(name|display|mark|root|schemas|run|dependency)\}\}/g;
  const valueOf = (key: string): string => {
    const value = given[key];
    if (value === undefined) throw new Error(`template token {{${key}}} has no value here`);
    return value;
  };
  // Line by line, so the display name, the one value a person types freely, is written as each file's
  // own syntax needs it where it lands: inside a JSON string, inside a quoted string of TypeScript, or
  // as a YAML value that would not read back as written.
  const out = withIdentity
    .split('\n')
    .map((line) => {
      const rendered = line.replace(token, (_m, key: string, at: number) => {
        const value = valueOf(key);
        if (key !== 'display' || file === undefined) return value;
        if (file.endsWith('.json')) return JSON.stringify(value).slice(1, -1);
        if (/\.[cm]?[jt]s$/.test(file)) {
          const quote = openQuote(line.slice(0, at));
          return quote === null ? value : jsEscaped(value, quote);
        }
        return value;
      });
      return /\.ya?ml$/.test(file ?? '') && line.includes('{{display}}') ? yamlValueKept(rendered) : rendered;
    })
    .join('\n');
  const left = /\{\{[^}]*\}\}/.exec(out);
  if (left) throw new Error(`template token ${left[0]} is not one create-app knows`);
  return out;
}

/** The quote a string open at the end of `before` (a line of code up to a token) was opened with, or null. */
function openQuote(before: string): "'" | '"' | '`' | null {
  let open: "'" | '"' | '`' | null = null;
  for (let i = 0; i < before.length; i += 1) {
    const c = before[i]!;
    if (c === '\\' && open !== null) i += 1;
    else if (open === null && (c === "'" || c === '"' || c === '`')) open = c;
    else if (c === open) open = null;
  }
  return open;
}

/** `value` inside a string opened with `quote`. */
function jsEscaped(value: string, quote: "'" | '"' | '`'): string {
  const escaped = value.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  return quote === '`' ? escaped.replace(/\$\{/g, '\\${') : escaped;
}

/**
 * A YAML line `key: value` (or `- key: value`) whose plain value would not read back as written (a
 * display name with `: `, ` #`, or a quote or an indicator at its start), with the value double-quoted
 * so it does; any other line, as it is.
 */
function yamlValueKept(line: string): string {
  const m = /^(\s*(?:- )?[A-Za-z_][\w.-]*:[ \t]+)(.*)$/.exec(line);
  if (m === null || line.trimStart().startsWith('#')) return line;
  const value = m[2]!;
  try {
    const read = parse(`k: ${value}`) as { k?: unknown } | null;
    if (read !== null && typeof read === 'object' && read.k === value) return line;
  } catch {
    // It does not read: quote it.
  }
  return `${m[1]}${JSON.stringify(value)}`;
}

/** What goes where: the template's files by path, with the identity overlay applied, and the standalone overlay with `standalone`. */
export function templateFiles(identity: boolean, standalone = false): Map<string, string> {
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
  if (standalone) {
    for (const file of STANDALONE_DROPS) files.delete(file);
    for (const file of listFiles(STANDALONE_TEMPLATE_DIR)) files.set(file === 'gitignore' ? '.gitignore' : file, readFileSync(join(STANDALONE_TEMPLATE_DIR, file), 'utf8'));
  }
  return files;
}

/**
 * The create-app skill as a project of its own gets it, by path under .claude/skills/create-app: each
 * page's links to the authoring guide and the slot pages point at the installed package's copies
 * (node_modules/dialogwright/docs), links between the skill's own pages and to CLAUDE.md (the
 * project's own, where the repository's is) stay, and a link to any other page of this repository
 * points at it on GitHub.
 */
export function standaloneSkill(dir: string = SKILL_DIR, base: string = INSTALLED ? SKILL_PACKAGE_PATH : SKILL_REPO_PATH): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of listFiles(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    files.set(posix.join(SKILL_REPO_PATH, file), file.endsWith('.md') ? projectSkillPage(text, file, base) : text);
  }
  return files;
}

/**
 * A page of the skill, `file` under `base` (where it is read: `.claude/skills/create-app` in this
 * repository, whose links are the repository's; `skills/create-app` in the package, whose copy
 * scripts/shipDocs.ts re-linked within the package), as a project has it under
 * .claude/skills/create-app: the same links whichever it was read from.
 */
export function projectSkillPage(text: string, file: string, base: string): string {
  const from = posix.join(base, file);
  const at = posix.dirname(posix.join(SKILL_REPO_PATH, file));
  const relinked = relinkMarkdown(text, from, (target, anchor) => {
    // The skill's own pages, and CLAUDE.md, which in a project is the project's own, at the same place.
    if (target === base || target.startsWith(`${base}/`)) return null;
    if (target === 'CLAUDE.md') return `${posix.relative(at, 'CLAUDE.md')}${anchor}`;
    const shipped = packagePathOf(target) ?? (target.startsWith('docs/') ? target : null);
    if (shipped !== null && shipped.startsWith('docs/')) return `${posix.relative(at, posix.join('node_modules/dialogwright', shipped))}${anchor}`;
    return `${REPOSITORY_PAGES}${target}${anchor}`;
  });
  // The package's copy links CLAUDE.md on GitHub (the package has none); a project has its own.
  return relinked.split(`](${REPOSITORY_PAGES}CLAUDE.md`).join(`](${posix.relative(at, 'CLAUDE.md')}`);
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
  const standalone = options.standalone === true;
  const dir = resolve(options.dir ?? (standalone ? options.name : join(root, 'apps', options.name)));
  // A project of its own goes outside the DialogWright repository, whose workspace would take it for one of its packages.
  const repository = options.root ?? (INSTALLED ? null : REPO_ROOT);
  if (standalone && repository !== null && existsSync(join(repository, 'pnpm-workspace.yaml')) && (realPath(dir) === realPath(repository) || realPath(dir).startsWith(realPath(repository) + sep))) {
    throw new CreateAppError(`${dir} is inside the DialogWright repository (${repository}); a project of its own goes outside it: give --dir <a folder outside the repository>`);
  }
  if (existsSync(dir)) {
    throw new CreateAppError(`${dir} already exists; create-app never writes into an existing folder. Choose another name, or --dir, or remove the folder first`);
  }
  const display = options.display?.trim() || displayNameOf(options.name);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f{}]/.test(display)) throw new CreateAppError('the display name may not have a line break, another control character or braces');
  const identity = options.identity === true;
  const dependency = options.dependency ?? `^${ENGINE_VERSION}`;
  if (/["\\\n]/.test(dependency)) throw new CreateAppError('the dialogwright dependency may not have a quote, a backslash or a line break');
  const base = { name: options.name, display, mark: markOf(display) };
  const values: Record<string, string> = standalone
    ? { ...base, run: 'npx dialogwright', schemas: 'node_modules/dialogwright/schemas', dependency }
    : (() => {
        const toRoot = relative(realPath(dir), realPath(root)).split(sep).join('/') || '.';
        return { ...base, root: toRoot };
      })();

  const written: string[] = [];
  const files = templateFiles(identity, standalone);
  const rendered = new Map([...files].map(([file, text]) => [file, render(text, values, identity, standalone, file)] as const));
  for (const [file, text] of rendered) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
    written.push(file);
  }
  if (standalone) {
    for (const [file, text] of standaloneSkill()) {
      const to = join(dir, file);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, text);
      written.push(file);
    }
    return { dir, files: written, packageName: options.name, inWorkspace: false, standalone };
  }
  const apps = join(root, 'apps');
  return { dir, files: written, packageName: `@dialogwright/example-${options.name}`, inWorkspace: dirname(dir) === apps && statSync(dir).isDirectory(), standalone };
}

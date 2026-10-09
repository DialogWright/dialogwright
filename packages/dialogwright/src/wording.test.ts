import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository's wording rules, over what people and assistants read and copy: the example apps,
 * the docs, the scaffold's templates, the authoring package (its code and fixtures), the web chat
 * widget, the create-app skill, the CI, the landing page (site/) and the root's own pages. One name
 * this repository never carries is refused everywhere here (written in pieces so that this file keeps
 * to the rule it checks), and no file has an em dash. An app's own words are its own: a foundation
 * repair line's warranty claim or a clinic's insurance card is that app's business.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The one name the repository never carries. */
const NEVER = new RegExp(`\\b${'gene' + 'sys'}\\b`, 'gi');

/** The folders scanned (every file under them), and the root's own pages. */
const FOLDERS = ['apps', 'docs', 'packages/dialogwright/templates', 'packages/kb-author', 'packages/widget', '.claude', '.github', 'site'];
const ROOT_FILES = ['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'llms.txt', 'NOTICE'];

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(path);
    return e.isFile() ? [path] : [];
  });
}

const files = (): string[] => [...FOLDERS.flatMap((f) => walk(join(ROOT, f))), ...ROOT_FILES.map((f) => join(ROOT, f))]
  .filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });

const pathOf = (file: string): string => relative(ROOT, file).split(sep).join('/');

describe('the wording of the apps, the docs, the templates, the skill and the site', () => {
  it('scans the folders it names', () => {
    const paths = files().map(pathOf);
    for (const expected of ['apps/clinic/intents.yaml', 'apps/utility/policy.yaml', 'docs/design.md', 'packages/dialogwright/templates/app/prompts.yaml', '.claude/skills/create-app/SKILL.md', 'llms.txt', 'site/index.html', '.github/workflows/pages.yml']) {
      expect(paths, expected).toContain(expected);
    }
  });

  it('never carries the one name', () => {
    const found: string[] = [];
    for (const file of files()) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\u0000')) continue;
      text.split('\n').forEach((line, i) => {
        if (line.match(NEVER)) found.push(`${pathOf(file)}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('has no em dash', () => {
    const dashed = files().filter((file) => readFileSync(file, 'utf8').includes('\u2014')).map(pathOf);
    expect(dashed).toEqual([]);
  });
});

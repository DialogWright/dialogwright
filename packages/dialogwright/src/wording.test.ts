import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository's vocabulary rule, over what people and assistants read and copy: the example apps,
 * the docs, the scaffold's templates, the create-app skill, the CI, the landing page (site/) and the root's own pages. An
 * example app keeps to neutral words and invented names, as the engine does, so the banned words of
 * one industry and the one name this repository never carries are refused everywhere here, with a short allow-list for
 * the places a word is that app's own. The words are written in pieces so that this file keeps to the
 * rule it checks (as createApp.test.ts and createAppSkill.test.ts do for the templates and the skill).
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** One industry's words, and the private app's name. */
const WORDS = [
  'cla' + 'ims?', 'cover' + 'age', 'insur' + 'ance', 'insur' + 'er', 'bro' + 'ker', 'mem' + 'ber', 'policy' + 'holder',
  'pre' + 'mium', 'deduct' + 'ible', 'lo' + 'ss', 'acci' + 'dent', 'gene' + 'sys',
];
const BANNED = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'gi');

/** The folders scanned (every file under them), and the root's own pages. */
const FOLDERS = ['apps', 'docs', 'packages/dialogwright/templates', '.claude', '.github', 'site'];
const ROOT_FILES = ['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'llms.txt', 'NOTICE'];

/**
 * Where a banned word is the place's own, by path (a folder ends in '/'), with the words allowed there
 * and why. Every entry must still be needed: a test fails when one no longer matches anything.
 */
const ALLOWED: readonly { path: string; words: readonly string[]; reason: string }[] = [
  {
    path: 'apps/clinic/',
    words: ['mem' + 'ber', 'insur' + 'ance', 'cover' + 'age'],
    reason: "a clinic's billing line: its billing form asks for the ID on the caller's health plan card, and its billing intent covers a caller asking whether their plan pays for a visit (the intent's criteria, the corpus, the prompts, the recorded cassette and the snapshots of the questions the model sees)",
  },
  {
    path: 'docs/CLA.md',
    words: ['cla' + 'ims?'],
    reason: 'the contributor agreement is legal text: its patent license is over the patent ones a contributor can license',
  },
];

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

const allows = (path: string, word: string): boolean =>
  ALLOWED.some((a) => (a.path.endsWith('/') ? path.startsWith(a.path) : path === a.path) && a.words.some((w) => new RegExp(`^(?:${w})$`, 'i').test(word)));

/** Every banned word in every scanned file, as `path:line word`, with whether the allow-list covers it. */
function hits(): { at: string; path: string; word: string; allowed: boolean }[] {
  const out: { at: string; path: string; word: string; allowed: boolean }[] = [];
  for (const file of files()) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('\u0000')) continue;
    const path = pathOf(file);
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(BANNED)) out.push({ at: `${path}:${i + 1} ${m[0]}`, path, word: m[0], allowed: allows(path, m[0]) });
    });
  }
  return out;
}

describe('the wording of the apps, the docs, the templates, the skill and the site', () => {
  it('scans the folders it names', () => {
    const paths = files().map(pathOf);
    for (const expected of ['apps/clinic/intents.yaml', 'apps/utility/policy.yaml', 'docs/design.md', 'packages/dialogwright/templates/app/prompts.yaml', '.claude/skills/create-app/SKILL.md', 'llms.txt', 'site/index.html', '.github/workflows/pages.yml']) {
      expect(paths, expected).toContain(expected);
    }
  });

  it("uses none of one industry's words or the private app's name, outside the allow-list", () => {
    expect(hits().filter((h) => !h.allowed).map((h) => h.at)).toEqual([]);
  });

  it('has no em dash', () => {
    const dashed = files().filter((file) => readFileSync(file, 'utf8').includes('\u2014')).map(pathOf);
    expect(dashed).toEqual([]);
  });

  it('allows only what is still there, each with its reason', () => {
    const found = hits().filter((h) => h.allowed);
    for (const a of ALLOWED) {
      expect(a.reason.length, a.path).toBeGreaterThan(20);
      for (const w of a.words) {
        const used = found.some((h) => (a.path.endsWith('/') ? h.path.startsWith(a.path) : h.path === a.path) && new RegExp(`^(?:${w})$`, 'i').test(h.word));
        expect(used, `${a.path} allows "${w}", which it no longer has: take it off the list`).toBe(true);
      }
    }
  });
});

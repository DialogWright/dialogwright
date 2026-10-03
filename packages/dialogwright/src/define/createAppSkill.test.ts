import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The create-app skill (.claude/skills/create-app at the repository root): the procedure an AI coding
 * assistant follows to build an app from a paragraph. It is read by an assistant with no other
 * context, so a link that leads nowhere is a dead end: every relative link in its files must name a
 * file that exists and, where it names a heading, a heading that exists. It is public, so it keeps
 * the repository's vocabulary rule as the scaffold's templates do (createApp.test.ts).
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'create-app');
const read = (file: string): string => readFileSync(file, 'utf8');
const skillFiles = (): string[] => readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md')).map((f) => join(SKILL_DIR, f));

/** The text outside fenced code blocks, where a markdown link means a link. */
const prose = (text: string): string => text.replace(/^```[\s\S]*?^```/gm, '');

/** Every relative link of a markdown file, as written. */
function links(text: string): string[] {
  return [...prose(text).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^[a-z]+:/i.test(t));
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as hyphens. */
const anchorOf = (heading: string): string => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

function anchors(file: string): Set<string> {
  return new Set([...prose(read(file)).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorOf(m[1]!)));
}

describe('the create-app skill', () => {
  it('has a SKILL.md with front matter that names it and says when to use it', () => {
    const text = read(join(SKILL_DIR, 'SKILL.md'));
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front, 'SKILL.md starts with a front matter block between --- lines').not.toBeNull();
    const fields = Object.fromEntries(front![1]!.split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }));
    expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
    expect(fields.name).toBe('create-app');
    expect(fields.description).toMatch(/^Use when /);
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
  });

  it('links only to files and headings that exist', () => {
    const broken: string[] = [];
    for (const file of skillFiles()) {
      for (const link of links(read(file))) {
        const [path, anchor] = link.split('#') as [string, string | undefined];
        const target = path === '' ? file : resolve(dirname(file), path);
        const from = relative(ROOT, file);
        if (!existsSync(target)) broken.push(`${from}: ${link} (no such file)`);
        else if (anchor !== undefined && target.endsWith('.md') && !anchors(target).has(anchor)) broken.push(`${from}: ${link} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps the vocabulary neutral and has no em dash', () => {
    // One industry's words, written in pieces so that this file keeps to the rule it checks.
    const words = ['cla' + 'ims?', 'cover' + 'age', 'insur' + 'ance', 'insur' + 'er', 'bro' + 'ker', 'mem' + 'ber', 'policy' + 'holder', 'pre' + 'mium', 'deduct' + 'ible', 'lo' + 'ss', 'acci' + 'dent', 'gene' + 'sys'];
    const banned = new RegExp(`\\b(${words.join('|')})\\b`, 'i');
    for (const file of skillFiles()) {
      const text = read(file);
      expect(text, relative(ROOT, file)).not.toMatch(banned);
      expect(text, relative(ROOT, file)).not.toContain('—');
    }
  });

  it('is where the root CLAUDE.md, llms.txt and the authoring guide send an assistant', () => {
    for (const doc of ['CLAUDE.md', 'llms.txt', 'docs/authoring-an-app.md']) {
      const text = read(join(ROOT, doc));
      expect(text, doc).toContain('.claude/skills/create-app/SKILL.md');
      expect(text, doc).not.toMatch(/create-app skill[^.]*forthcoming/);
    }
  });
});

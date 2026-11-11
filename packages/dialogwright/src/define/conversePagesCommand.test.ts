import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { converseFixture } from '../testing/converse/app';
import { conversePolicyCardText, conversePolicyMatrixText, converseAppMapText } from '../testing/conversePages';
import { workspaceCopy, type WorkspaceCopy } from './__fixtures__/workspaceCopy';
import { main } from './cli';
import { workspaceRootOf } from './matrixCommand';

/**
 * The pages of a converse app, written from agent.yaml's actions: what each says of the fixture's actions, and
 * the three commands (policy:matrix, policy:card, app:diagram) finding a converse app's folder and writing its
 * pages only when they changed. The commands run on a scratch copy of apps/wheelshop-agent: no test writes a
 * committed page.
 */

const ROOT = workspaceRootOf(dirname(fileURLToPath(import.meta.url)));
const SHOP = 'apps/wheelshop-agent';
const PAGES = ['policy.matrix', 'POLICY.md', 'APP-MAP.md'];

const copies: WorkspaceCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

function scratch(): string {
  const copy = workspaceCopy(ROOT, [SHOP]);
  copies.push(copy);
  return copy.root;
}

describe('the pages of a converse app', () => {
  const { app } = converseFixture();

  it('the matrix: a lookup is open, a change runs only with the caller\'s yes to exactly its values', () => {
    const text = conversePolicyMatrixText(app);
    expect(text).toMatch(/^availability · level 0 · no rules\n {2}every caller {2}ALLOW$/m);
    expect(text).toMatch(/^book · level 0 · confirmed\(.*\)\n {2}every caller {2}confirmed none\|mismatch {2}BLOCK confirmation\n +confirmed match +ALLOW$/m);
    expect(text).toContain('(unlisted)');
  });

  it('the card: each action with its kind, read-back and the confirmation every change needs', () => {
    const text = conversePolicyCardText(app);
    expect(text).toContain('# Policy card:');
    expect(text).toContain('| `availability` | lookup | yes | none | none |');
    expect(text).toMatch(/\| `book` \| change \| yes \| `confirmed\(/);
    expect(text).toContain('Read back before it runs, in these words:');
    expect(text).toContain('the caller\'s yes to a read-back of');
    expect(text).toContain('The conversation is sent to the agent model');
    expect(text).toContain('by its last four digits');
  });

  it('the map: the actions and where a slot value must come from', () => {
    const text = converseAppMapText(app);
    expect(text).toContain('```mermaid');
    expect(text).toMatch(/a_availability -->\|\w+\| a_book/);
  });
});

describe('dialogwright policy:matrix, policy:card and app:diagram on a converse app', () => {
  it('write nothing when the pages are what the app generates', async () => {
    const root = scratch();
    for (const [command, file] of [['policy:matrix', 'policy.matrix'], ['policy:card', 'POLICY.md'], ['app:diagram', 'APP-MAP.md']] as const) {
      const run = io(root);
      expect(await main([command, SHOP], run.io)).toBe(0);
      expect(run.err).toEqual([]);
      expect(run.out).toEqual([`${SHOP}/${file}: unchanged`]);
    }
  });

  it('write a page that changed, as the app generates it', async () => {
    const root = scratch();
    for (const file of PAGES) writeFileSync(join(root, SHOP, file), 'stale\n');
    for (const command of ['policy:matrix', 'policy:card', 'app:diagram']) {
      const run = io(root);
      expect(await main([command, SHOP], run.io)).toBe(0);
      expect(run.out).toEqual([expect.stringMatching(/^wrote apps\/wheelshop-agent\/.* \(\d+ lines\): review the diff before you commit it$/)]);
    }
    for (const file of PAGES) expect(readFileSync(join(root, SHOP, file), 'utf8')).toBe(readFileSync(join(ROOT, SHOP, file), 'utf8'));
  });
});

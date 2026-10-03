import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { danglingReferences, expectAppMap } from './appMap';
import { useTestkit } from './apps';
import { testkitApp } from './testkit';

/**
 * The reviewed app maps of the testkit and the library fixture: APP-MAP.md, beside policy.yaml, is
 * what the app generates today. A difference fails with a diff a reviewer can read and the command
 * that writes the page; CI never writes one. The testkit declares which actions its forms call, so
 * its map reaches every action; the library fixture does not, so its map stops at each form and says so.
 */

useTestkit();

const TESTKIT = fileURLToPath(new URL('./testkit/', import.meta.url));
const LIBRARY = fileURLToPath(new URL('../define/fixture/', import.meta.url));

describe('the app maps', () => {
  it('testkit: APP-MAP.md is the app map its app generates', () => {
    expectAppMap(testkitApp, `${TESTKIT}APP-MAP.md`, 'pnpm app:diagram packages/dialogwright/src/testing/testkit');
  });

  it('library fixture: APP-MAP.md is the app map its app generates', () => {
    expectAppMap(libraryApp, `${LIBRARY}APP-MAP.md`, 'pnpm app:diagram packages/dialogwright/src/define/fixture');
  });

  it('neither app has a dangling reference', () => {
    expect(danglingReferences(testkitApp)).toEqual([]);
    expect(danglingReferences(libraryApp)).toEqual([]);
  });
});

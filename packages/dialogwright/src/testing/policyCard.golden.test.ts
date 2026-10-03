import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { useTestkit } from './apps';
import { expectPolicyCard } from './policyCard';
import { testkitApp } from './testkit';

/**
 * The reviewed policy cards of the testkit and the library fixture: POLICY.md, beside policy.yaml,
 * is what the app generates today. A difference fails with a diff a reviewer can read and the command
 * that writes the page; CI never writes one. The library fixture has no `say` on its actions and no
 * identity, so its card shows the fallbacks.
 */

useTestkit();

const TESTKIT = fileURLToPath(new URL('./testkit/', import.meta.url));
const LIBRARY = fileURLToPath(new URL('../define/fixture/', import.meta.url));

describe('the policy cards', () => {
  it('testkit: POLICY.md is the policy card its app generates', () => {
    expectPolicyCard(testkitApp, `${TESTKIT}POLICY.md`, 'pnpm policy:card packages/dialogwright/src/testing/testkit');
  });

  it('library fixture: POLICY.md is the policy card its app generates', () => {
    expectPolicyCard(libraryApp, `${LIBRARY}POLICY.md`, 'pnpm policy:card packages/dialogwright/src/define/fixture');
  });
});

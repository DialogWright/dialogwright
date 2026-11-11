import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix } from 'dialogwright/testing';
import { wheelshop } from './app';

/**
 * The shop's reviewed policy pages, written from agent.yaml's actions and compared with what the app
 * generates today: policy.matrix (what the gate decides), POLICY.md (the policy card) and APP-MAP.md (the
 * actions, their follow-ons and sources). A change to an action, its rules or its read-back fails here with
 * a diff to review; write the pages deliberately with `pnpm policy:matrix apps/wheelshop-agent`,
 * `pnpm policy:card apps/wheelshop-agent` and `pnpm app:diagram apps/wheelshop-agent`.
 */
const SHOP = fileURLToPath(new URL('../', import.meta.url));
const { app } = wheelshop({ inMemory: true });

describe('the shop\'s policy pages', () => {
  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, `${SHOP}policy.matrix`, 'pnpm policy:matrix apps/wheelshop-agent');
  });

  it('POLICY.md is the policy card the app generates', () => {
    expectPolicyCard(app, `${SHOP}POLICY.md`, 'pnpm policy:card apps/wheelshop-agent');
  });

  it('APP-MAP.md is the app map the app generates', () => {
    expectAppMap(app, `${SHOP}APP-MAP.md`, 'pnpm app:diagram apps/wheelshop-agent');
  });
});

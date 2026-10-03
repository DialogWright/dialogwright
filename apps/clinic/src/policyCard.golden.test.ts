import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { expectPolicyCard } from 'dialogwright/testing';
import { clinicApp } from './index';

/**
 * The clinic's reviewed policy card: POLICY.md, beside policy.yaml, is what the app generates today.
 * A change to the policy fails here with a diff to review; write the page deliberately with
 * `pnpm policy:card apps/clinic`.
 */
const CLINIC = fileURLToPath(new URL('../', import.meta.url));

describe('the clinic\'s policy card', () => {
  it('POLICY.md is the policy card the clinic generates', () => {
    expectPolicyCard(clinicApp, `${CLINIC}POLICY.md`, 'pnpm policy:card apps/clinic');
  });
});

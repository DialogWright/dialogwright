import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { danglingReferences, expectAppMap } from 'dialogwright/testing';
import { clinicApp } from './index';

/**
 * The clinic's reviewed app map: APP-MAP.md, beside policy.yaml, is what the app generates today. A
 * change to the forms or the intents fails here with a diff to review; write the page deliberately
 * with `pnpm app:diagram apps/clinic`. Every form is started by an intent and every action is reached.
 */
const CLINIC = fileURLToPath(new URL('../', import.meta.url));

describe('the clinic\'s app map', () => {
  it('APP-MAP.md is the app map the clinic generates', () => {
    expectAppMap(clinicApp, `${CLINIC}APP-MAP.md`, 'pnpm app:diagram apps/clinic');
  });

  it('has no dangling reference: every form is started by an intent and every action is reached', () => {
    expect(danglingReferences(clinicApp)).toEqual([]);
  });
});

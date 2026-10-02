import type { SlotType } from '../types';
import { slotConformanceChecks, type SlotConformanceOptions } from './checks';

/** The test runner's two functions the kit registers its checks with (vitest's, node:test's or jest's). */
export interface TestRegistrar {
  describe(name: string, fn: () => void): unknown;
  it(name: string, fn: () => void): unknown;
}

/**
 * Registers the conformance checks of `type` as tests: one group per example, one test per check.
 * The runner's `describe` and `it` are passed in, so importing the kit loads no test runner:
 *
 *   import { describe, it } from 'vitest';
 *   import { runSlotConformance } from 'dialogwright/testing';
 *   runSlotConformance(myType, { describe, it, locales: ['en-US', 'es'] });
 */
export function runSlotConformance(type: SlotType<any>, options: TestRegistrar & SlotConformanceOptions): void {
  const { describe, it, ...rest } = options;
  describe(`slot type "${type.type}" conforms`, () => {
    const checks = slotConformanceChecks(type, rest);
    for (const example of [...new Set(checks.map((c) => c.example))]) {
      describe(`example "${example}"`, () => {
        for (const check of checks.filter((c) => c.example === example)) it(`${check.id}: ${check.name}`, check.run);
      });
    }
  });
}

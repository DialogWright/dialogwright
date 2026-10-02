/**
 * The package's test-support entry, `dialogwright/testing`: what an app's regression launchers and
 * tests use to prove a change leaves its calls as they were, kept out of the root entry so the
 * public API stays the engine's. The shadow harness runs a replacement slot beside the slot it
 * replaces and fails on any difference (shadowSlot.ts); `isCassetteMiss` tells a replayed turn the
 * cassette had no answer for.
 */
export {
  shadowSlot, withShadowSlots, shadowFromEnv, shadowModeOf, createShadowReport, formatShadowReport, formatShadowMismatch,
  ShadowMismatchError, SHADOW_ENV,
} from './shadowSlot';
export type { ShadowMethod, ShadowMismatch, ShadowMode, ShadowOptions, ShadowReport } from './shadowSlot';
export { isCassetteMiss } from '../jev/cassette';

import { getApp, registerApp } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import manifest from './prompts/manifest.json';
import { DEPOT_AGENT } from './domain/agent';
import { TESTKIT_FACTS } from './domain/facts';
import { accountIdOf, blockPromptId, depotAnswer, FORMS } from './domain/forms';
import { FORM_INTENTS, INTENTS, MENU } from './domain/intents';
import { TESTKIT_POLICY } from './domain/policy';
import { TESTKIT_BRAND, TESTKIT_CONSOLE, TESTKIT_HANDOFF, TESTKIT_VOICE, TESTKIT_WORDING } from './domain/present';
import { TESTKIT_PRINCIPALS } from './domain/principals';
import { SLOTS } from './domain/slots';
import { DAY_PART_DISPLAY } from './domain/slots/shared';
import { lookupsFor, ParcelSystems, DAY_PARTS } from './domain/systems';
import { TESTKIT_TESTING } from './domain/testing';
import { TESTKIT_TOOLS } from './domain/tools';

/**
 * Example Parcels, a small fictional parcel delivery line: the neutral app the engine's own tests run
 * against. Three forms (track a parcel, a delivery window, report a missing parcel), a customer who
 * verifies with an account ID and a date of birth, depot staff who act for customers with a role,
 * one rule of the app's own, and a downstream depot agent. See README.md.
 */
export const testkitApp: App = {
  id: 'testkit',
  intents: INTENTS,
  menu: MENU,
  forms: FORMS,
  slots: SLOTS,
  identity: {
    subjectKind: 'customer',
    delegateKind: 'agent',
    factorSlots: ['accountId', 'dob'],
    verifyTool: 'verifyCustomer',
    codeTool: 'verifyCode',
    sendCodeTool: 'sendCode',
    sendCodeParams: (s) => ({ accountId: accountIdOf(s) }),
    failedPromptId: 'identity_failed',
  },
  tools: TESTKIT_TOOLS,
  policy: TESTKIT_POLICY,
  facts: TESTKIT_FACTS,
  systems() {
    const sys = new ParcelSystems();
    return { sys, lookups: lookupsFor(sys) };
  },
  services: { depot: DEPOT_AGENT },
  onServiceResult: (c, _service, result) => depotAnswer(c, result),
  blockPromptId,
  wording: TESTKIT_WORDING,
  brand: TESTKIT_BRAND,
  console: TESTKIT_CONSOLE,
  voice: TESTKIT_VOICE,
  handoff: TESTKIT_HANDOFF,
  prompts: {
    manifest,
    tags: {},
    vocabulary: [
      ...FORM_INTENTS.map((i) => ({ id: `intent.${i}`, text: INTENTS[i]!.label, vars: ['intentLabel', 'a', 'b'] })),
      ...DAY_PARTS.map((p) => ({ id: `part.${p}`, text: DAY_PART_DISPLAY[p], vars: ['part'] })),
    ],
    spokenVars: ['accountId', 'dob', 'parcel', 'day', 'expectedDate', 'report', 'phoneLast4'],
    dataVars: ['item', 'days'],
  },
  principals: TESTKIT_PRINCIPALS,
  testing: TESTKIT_TESTING,
  fixtures: { dir: 'src/testing/testkit/fixtures' },
};

/** Registers the testkit once; safe to call again, and after resetAppsForTest. */
export function registerTestkit(): void {
  try {
    getApp(testkitApp.id);
  } catch {
    registerApp(testkitApp);
  }
}

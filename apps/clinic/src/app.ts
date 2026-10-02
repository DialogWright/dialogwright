import { fileURLToPath } from 'node:url';
import { defineApp, type App, type AppCode } from 'dialogwright';
import { CLINIC_FACTS } from './domain/facts';
import { CLINIC_FORM_HOOKS } from './domain/forms';
import { clinicQuestions } from './domain/scheduling';
import { SLOTS } from './domain/slots';
import { CLINIC_TESTING } from './domain/testing';
import { CLINIC_LOOKUPS, CLINIC_TOOLS, ClinicSystems } from './domain/tools';

/**
 * Example Family Practice, built from its folder. The YAML in apps/clinic (app.yaml, intents.yaml,
 * forms.yaml, prompts.yaml, policy.yaml) holds what is data: the intents and the keypad menu, the
 * forms' slots and summaries, every line the caller hears, the gate's tables, and how the line
 * presents itself. This file holds what runs: the slot specs, the tools and the directory behind
 * them, the forms' hooks and the scheduling questions, what the clinic keeps on the session, and the
 * hooks the regression harness and the stubs use. There is no identity.yaml: the clinic verifies no one.
 *
 * `dialogwright check` imports this module (it looks for src/app.ts when the folder has no app.ts)
 * and checks the folder against `code`.
 */

/** The clinic's folder: the one with app.yaml, above this src/. */
export const CLINIC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The clinic's TypeScript parts: everything the YAML names that runs. */
export const code: AppCode = {
  slots: SLOTS,
  tools: CLINIC_TOOLS,
  systems: () => ({ sys: new ClinicSystems(), lookups: CLINIC_LOOKUPS }),
  forms: CLINIC_FORM_HOOKS,
  facts: CLINIC_FACTS,
  // The model is told the caller has an appointment open, beside the engine's own caller fields.
  callerState: () => ({ openAppointment: true }),
  questions: clinicQuestions,
  // What the regression harness and the stub clients need: labels, heuristics, the seeded call.
  testing: CLINIC_TESTING,
};

/** The clinic line: the folder joined with the code above. */
export const clinicApp: App = defineApp(CLINIC_DIR, code, { codeFile: 'src/app.ts' });

import { getApp, registerApp, type App } from 'dialogwright';
import { CLINIC_FACTS } from './domain/facts';
import { FORMS } from './domain/forms';
import { CLINIC_INTENTS, MENU } from './domain/intents';
import { CLINIC_POLICY } from './domain/policy';
import { CLINIC_BRAND, CLINIC_CONSOLE, CLINIC_VOICE } from './domain/present';
import { clinicQuestions } from './domain/scheduling';
import { SLOTS } from './domain/slots';
import { CLINIC_TESTING } from './domain/testing';
import { CLINIC_THRESHOLDS } from './domain/thresholds';
import { CLINIC_LOOKUPS, CLINIC_TOOLS, ClinicSystems } from './domain/tools';
import { CLINIC_HANDOFF, CLINIC_WORDING } from './domain/wording';
import manifest from './prompts/manifest.json';

/**
 * Example Family Practice: the appointment line of a small, fictional clinic. A caller schedules,
 * reschedules, cancels or confirms an appointment with one of eight providers, or is put through to
 * billing with their member ID. The line verifies no one; it looks the caller's booking up from their
 * name, birthday and provider, offers openings it finds, and writes a change only after the caller
 * has said yes to a summary of exactly that change. See README.md.
 */
export const clinicApp: App = {
  id: 'clinic',
  intents: CLINIC_INTENTS,
  menu: MENU,
  forms: FORMS,
  slots: SLOTS,
  tools: CLINIC_TOOLS,
  policy: CLINIC_POLICY,
  facts: CLINIC_FACTS,
  systems: () => ({ sys: new ClinicSystems(), lookups: CLINIC_LOOKUPS }),
  wording: CLINIC_WORDING,
  brand: CLINIC_BRAND,
  console: CLINIC_CONSOLE,
  voice: CLINIC_VOICE,
  // The caller's own details outlast the task, so a second task on the call does not ask for them again.
  carrySlots: ['name', 'dob', 'memberId'],
  thresholds: CLINIC_THRESHOLDS,
  // The model is told the caller has an appointment open, beside the engine's own caller fields.
  callerState: () => ({ openAppointment: true }),
  questions: clinicQuestions,
  handoff: CLINIC_HANDOFF,
  // Text only: the line is spoken by the phone's text-to-speech, with no recorded clips.
  prompts: { manifest, tags: {} },
  // What the regression harness and the stub clients need: labels, heuristics, the seeded call.
  testing: CLINIC_TESTING,
  // The regression fixtures (corpus, scenarios, baseline, cassette), relative to this package.
  fixtures: { dir: 'fixtures' },
};

/** Registers the clinic once; safe to call again, and after resetAppsForTest. */
export function registerClinic(): void {
  try {
    getApp(clinicApp.id);
  } catch {
    registerApp(clinicApp);
  }
}

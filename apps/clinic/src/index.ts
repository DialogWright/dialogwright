import { getApp, registerApp } from 'dialogwright';
import { clinicApp } from './app';

/**
 * Example Family Practice: the appointment line of a small, fictional clinic. A caller schedules,
 * reschedules, cancels or confirms an appointment with one of eight providers, or is put through to
 * billing with their member ID. The line verifies no one; it looks the caller's booking up from their
 * name, birthday and provider, offers openings it finds, and writes a change only after the caller
 * has said yes to a summary of exactly that change. The app is its folder (apps/clinic: the YAML,
 * and src/app.ts for the code); see README.md.
 */
export { clinicApp, code, CLINIC_DIR } from './app';

/** Registers the clinic once; safe to call again, and after resetAppsForTest. */
export function registerClinic(): void {
  try {
    getApp(clinicApp.id);
  } catch {
    registerApp(clinicApp);
  }
}

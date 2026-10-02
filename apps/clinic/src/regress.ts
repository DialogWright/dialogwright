// Launcher for `pnpm regress`: registers the clinic, then runs the engine's regression run.
// With DIALOGWRIGHT_SHADOW set, each slot in CLINIC_SHADOW_PAIRS runs beside the slot it replaces
// (dialogwright/testing); unset, the clinic is registered as it is.
import { registerApp, regressMain } from 'dialogwright';
import { shadowFromEnv } from 'dialogwright/testing';
import { clinicApp } from './index';
import { CLINIC_SHADOW_PAIRS } from './testing/shadowPairs';

registerApp(shadowFromEnv(clinicApp, CLINIC_SHADOW_PAIRS));
await regressMain();

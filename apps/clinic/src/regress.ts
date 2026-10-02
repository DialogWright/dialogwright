// Launcher for `pnpm regress`: registers the clinic, then runs the engine's regression run.
import { registerApp, regressMain } from 'dialogwright';
import { clinicApp } from './index';

registerApp(clinicApp);
await regressMain();

// Launcher for `pnpm cli`: registers the clinic, then runs the engine's text harness.
import { cliMain } from 'dialogwright';
import { registerClinic } from './index';

registerClinic();
await cliMain();

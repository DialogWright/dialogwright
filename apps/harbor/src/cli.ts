// Launcher for `pnpm cli`: registers the app, then runs the engine's text harness.
import { cliMain } from 'dialogwright';
import { registerThisApp } from './index';

registerThisApp();
await cliMain();

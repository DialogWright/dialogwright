// Launcher for `pnpm serve`: registers the app, then runs the engine's server (the phone line and
// the operator console).
import { serverMain } from 'dialogwright';
import { registerThisApp } from './index';

registerThisApp();
await serverMain();

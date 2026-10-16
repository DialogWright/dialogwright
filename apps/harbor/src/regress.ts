// Launcher for `pnpm regress`: registers the app, then runs the engine's regression run.
import { registerApp, regressMain } from 'dialogwright';
import { app } from './index';

registerApp(app);
await regressMain();

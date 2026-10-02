// Launcher for `pnpm regress`: registers the clinic, then runs the engine's regression run.
import { regressMain } from 'dialogwright';
import { registerClinic } from './index';

registerClinic();
await regressMain();

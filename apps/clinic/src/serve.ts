// Launcher for `pnpm serve`: registers the clinic, then runs the engine's server (the phone line and
// the operator console). The clinic has no services or routes of its own to start beside it.
import { serverMain } from 'dialogwright';
import { registerClinic } from './index';

registerClinic();
await serverMain();

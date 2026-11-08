// Launcher for `pnpm serve`: registers the app, then runs the engine's server (the phone line, the web
// chat and the operator console). The texts the line would send are printed until texting is registered.
import { serverMain } from 'dialogwright';
import { printTexts } from './app';
import { registerThisApp } from './index';

printTexts(true);
registerThisApp();
await serverMain();

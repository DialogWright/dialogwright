// Launcher for `pnpm serve`: registers the app, then runs the engine's server (the phone line, the web
// chat and the operator console). A text the line sends goes through the server's sender (TEXT_FROM); with none, it is printed.
import { serverMain } from 'dialogwright';
import { printTexts } from './app';
import { registerThisApp } from './index';

printTexts(true);
registerThisApp();
await serverMain();

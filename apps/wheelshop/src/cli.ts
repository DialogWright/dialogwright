// Launcher for `pnpm cli`: registers the app, then runs the engine's text harness. The texts the line
// sends are printed: the text harness has no sender.
import { cliMain } from 'dialogwright';
import { printTexts } from './app';
import { registerThisApp } from './index';

printTexts(true);
registerThisApp();
await cliMain();

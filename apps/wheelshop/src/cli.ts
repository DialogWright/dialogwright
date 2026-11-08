// Launcher for `pnpm cli`: registers the app, then runs the engine's text harness. The texts the line
// would send are printed until texting is registered.
import { cliMain } from 'dialogwright';
import { printTexts } from './app';
import { registerThisApp } from './index';

printTexts(true);
registerThisApp();
await cliMain();

// Launcher for `pnpm serve`: registers the app, then runs the engine's server (the web chat, the calls to its
// number where VOICE_PROVIDERS lists a carrier, and the console). A text the line sends goes through the server's sender (TEXT_FROM);
// with none, it is printed.
import { registerConverseApp, serverMain } from 'dialogwright';
import { app } from './index';
import { printTexts } from './shop';

printTexts(true);
registerConverseApp(app);
await serverMain();

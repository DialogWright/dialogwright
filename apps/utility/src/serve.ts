// Launcher for `pnpm serve`: registers the app, then runs the engine's server (the phone line and
// the operator console), with the web chat demo page on a laptop (chatDemo.ts).
import { serverMain } from 'dialogwright';
import { chatDemoRoutes } from './chatDemo';
import { registerThisApp } from './index';

registerThisApp();
await serverMain(async () => ({ overrides: { routes: chatDemoRoutes } }));

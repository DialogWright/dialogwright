import { wheelshop } from './app';

export { APP_DIR, shopTools, wheelshop } from './app';

/**
 * The app the server runs (host.yaml, the eval CLI and serve.ts import it by app.yaml's id), with its own
 * systems. Nothing is read as it is imported: the server reads agent.yaml's references and makes the shop page
 * as it starts, from the app's own settings, and the actions read theirs at call time (ctx.env).
 */
export const app = wheelshop().app;

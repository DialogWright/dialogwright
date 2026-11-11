import { wheelshop } from './app';

export { APP_DIR, shopTools, wheelshop } from './app';

/**
 * The app the server runs (host.yaml, the eval CLI and serve.ts import it by app.yaml's id), with its own
 * systems. A converse app's pages are made with the app, so the shop page reads its settings (SHOP_DATA_DIR,
 * PUBLIC_HOST, CONSOLE_AUTH) from the server's environment as the module is imported, and has no sender of the
 * server's: a quote sent from it is printed (DESIGN.md, "Findings"). The actions read theirs at call time, from
 * the app's own settings (ctx.env).
 */
export const app = wheelshop({ env: (name) => process.env[name], log: (line) => console.log(`[wheelshop-agent] ${line}`) }).app;

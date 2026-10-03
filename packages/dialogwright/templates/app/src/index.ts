import { getApp, registerApp } from 'dialogwright';
import { app } from './app';

export { app, code, APP_DIR } from './app';

/** Registers the app once; safe to call again, and after resetAppsForTest. */
export function registerThisApp(): void {
  try {
    getApp(app.id);
  } catch {
    registerApp(app);
  }
}

import { appOf } from './app/registry';
import type { App } from './app/types';

/**
 * The language a session speaks. An app that declares locales (App.locales) speaks each of them; a
 * session speaks the default unless its start names another the app has (matchLocale), and a line
 * is said from the session's locale where it has one, from the default's manifest where it does
 * not (prompts/render.ts). An app without locales speaks en-US alone, and its sessions carry no
 * locale at all, so nothing it writes (session, trace, audit, console) changes.
 */

/** The locale of an app that declares none, and of an app folder whose app.yaml names none. */
export const DEFAULT_LOCALE = 'en-US';

/** The app's default locale: the language of App.prompts.manifest. */
export function defaultLocaleOf(app: App): string {
  return app.locales?.default ?? DEFAULT_LOCALE;
}

/** Every locale the app speaks, the default first, then the others in the order the app lists them. */
export function localesOf(app: App): string[] {
  return app.locales ? [app.locales.default, ...Object.keys(app.locales.prompts)] : [DEFAULT_LOCALE];
}

/** The language subtag of a tag: `es` for `es-US`, lower case. */
const languageOf = (tag: string): string => tag.split('-')[0]!.toLowerCase();

/**
 * Which of the app's locales a locale a channel asks for stands for, or null when none does. The
 * request is a channel's and untrusted: it is only ever compared, never kept, and what comes back is
 * always one of the app's own tags. In order: the same tag (letter case aside; `es-us` is `es-US`);
 * else the app's locale that is the request's language alone (`es-US` finds `es`); else the app's
 * first locale in that language (`es` finds `es-MX`).
 */
export function matchLocale(app: App, requested: string): string | null {
  const want = requested.trim().replace(/_/g, '-').toLowerCase();
  if (want === '') return null;
  const locales = localesOf(app);
  const same = locales.find((l) => l.toLowerCase() === want);
  if (same !== undefined) return same;
  const language = languageOf(want);
  return locales.find((l) => l.toLowerCase() === language) ?? locales.find((l) => languageOf(l) === language) ?? null;
}

/**
 * The locale a session speaks: its own (Session.locale), which only a session of an app that
 * declares locales has, else its app's default.
 */
export function localeOf(s: { readonly appId?: string; readonly locale?: string }): string {
  return s.locale ?? defaultLocaleOf(appOf(s));
}

/**
 * The locale a session's slots hear and say their values in (SlotContext.locale, a partialVars
 * call): the session's (localeOf) for an app that declares locales, and none for an app that does
 * not, whose slots then format as they always have.
 */
export function slotLocaleOf(s: { readonly appId?: string; readonly locale?: string }): string | undefined {
  return appOf(s).locales ? localeOf(s) : undefined;
}

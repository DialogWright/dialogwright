import type { App, Intent } from './types';

/**
 * What the engine reads off an app's intents. Each helper stands in for a constant the engine used
 * to import from an app's domain; order is the app's definition order, because the decision
 * model sees criteria in that order.
 */

/** Every intent id, in definition order. */
export function intentList(app: App): Intent[] {
  return Object.keys(app.intents);
}

/** The intents that start a form, in definition order. */
export function formIntents(app: App): Intent[] {
  return intentList(app).filter((i) => app.intents[i]!.kind === 'form');
}

export function isFormIntent(app: App, intent: string): boolean {
  return app.intents[intent]?.kind === 'form';
}

/** The spoken label for confirmations ("track a parcel"). */
export function intentLabel(app: App, intent: Intent): string {
  return app.intents[intent]!.label;
}

/** The prompt an informational intent plays, or undefined for any other intent. */
export function informationalPrompt(app: App, intent: string): string | undefined {
  const def = app.intents[intent];
  return def?.kind === 'informational' ? def.promptId : undefined;
}

/** Informational intents and their prompt ids. */
export function informationalIntents(app: App): Partial<Record<Intent, string>> {
  const out: Partial<Record<Intent, string>> = {};
  for (const i of intentList(app)) {
    const promptId = informationalPrompt(app, i);
    if (promptId !== undefined) out[i] = promptId;
  }
  return out;
}

/** The criteria the decision model is asked to choose among, every intent in definition order. */
export function intentCriteria(app: App): Record<Intent, string> {
  return Object.fromEntries(intentList(app).map((i) => [i, app.intents[i]!.criteria]));
}

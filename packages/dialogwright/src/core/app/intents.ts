import type { App, FormId, Intent } from './types';

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

/**
 * A form's spoken label, wherever a form id is said (an ack, a bridge, the form the caller is in):
 * its intent's label (intentLabel), or, for a form that is no intent (FormDef.internal, reached only
 * by another form's `next`), the form's own `label`. For an app whose forms are all intents, exactly
 * intentLabel.
 */
export function formLabel(app: App, form: FormId): string {
  const intent = app.intents[form];
  if (intent !== undefined) return intent.label;
  const label = Object.hasOwn(app.forms, form) ? app.forms[form]!.label : undefined;
  if (label === undefined) throw new Error(`form "${form}" of app "${app.id}" has neither an intent nor a label`);
  return label;
}

/** The prompt an informational intent plays, or undefined for any other intent (and for one that says a passage: informationOf). */
export function informationalPrompt(app: App, intent: string): string | undefined {
  const def = app.intents[intent];
  return def?.kind === 'informational' && def.passage === undefined ? def.promptId : undefined;
}

/**
 * What an informational intent does: says its prompt (`promptId`) or a passage of the knowledge base
 * (`passage`, said through kb/answer.ts informationalAnswer), or switches the call to its `locale`
 * (IntentDef.locale), saying its prompt, if any, in that locale; undefined for any other intent.
 */
export type Informs =
  | { readonly promptId: string; readonly passage?: undefined; readonly locale?: string }
  | { readonly passage: string; readonly promptId?: undefined; readonly locale?: undefined }
  | { readonly locale: string; readonly promptId?: undefined; readonly passage?: undefined };

/** What an informational intent does (Informs), or undefined for any other intent and for one that names none of them. */
export function informationOf(app: App, intent: string): Informs | undefined {
  const def = app.intents[intent];
  if (def?.kind !== 'informational') return undefined;
  if (def.passage !== undefined) return { passage: def.passage };
  // A locale only where the intent names one: every other intent's verdict is as it was.
  if (def.promptId !== undefined) return def.locale !== undefined ? { promptId: def.promptId, locale: def.locale } : { promptId: def.promptId };
  return def.locale !== undefined ? { locale: def.locale } : undefined;
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

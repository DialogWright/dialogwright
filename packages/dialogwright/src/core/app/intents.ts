import type { App, FormId, Intent } from './types';
import { lineOf } from '../../prompts/segments';

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

/**
 * Whether `intent` is a task the caller can start: a form, or an informational intent with an answer
 * to say (its line or its knowledge-base passage). Not "none", "done" or a switch of language alone.
 * What ends the frustration ladder's run after a task (App.frustration.after).
 */
export function isTaskIntent(app: App, intent: string): boolean {
  if (isFormIntent(app, intent)) return true;
  const def = app.intents[intent];
  return def?.kind === 'informational' && (def.passage !== undefined || def.promptId !== undefined);
}

/**
 * The label a locale gives an intent or an internal form (AppLocales.labels), or undefined where it gives
 * none, or for the default locale and a session with no locale, whose labels are intents.yaml's and forms.yaml's.
 */
function localeLabel(app: App, id: string, locale: string | undefined): string | undefined {
  const labels = locale !== undefined ? app.locales?.labels : undefined;
  const own = labels !== undefined && Object.hasOwn(labels, locale!) ? labels[locale!] : undefined;
  return own !== undefined && Object.hasOwn(own, id) ? own[id] : undefined;
}

/**
 * The spoken label for confirmations ("track a parcel"), in `locale` (the session's: Session.locale) where
 * that locale gives one, else the default's. A label the decision model is given (core/state.ts) is the
 * default's, as every question and criterion it reads is.
 */
export function intentLabel(app: App, intent: Intent, locale?: string): string {
  return localeLabel(app, intent, locale) ?? app.intents[intent]!.label;
}

/**
 * A form's spoken label, wherever a form id is said (an ack, a bridge, the form the caller is in):
 * its intent's label (intentLabel), or, for a form that is no intent (FormDef.internal, reached only
 * by another form's `next`), the form's own `label`; each in `locale` where it gives one. For an app
 * whose forms are all intents, exactly intentLabel.
 */
export function formLabel(app: App, form: FormId, locale?: string): string {
  const own = localeLabel(app, form, locale);
  if (own !== undefined) return own;
  const intent = app.intents[form];
  if (intent !== undefined) return intent.label;
  const label = Object.hasOwn(app.forms, form) ? app.forms[form]!.label : undefined;
  if (label === undefined) throw new Error(`form "${form}" of app "${app.id}" has neither an intent nor a label`);
  return label;
}

/** The engine's lines that say a label (core/turn.ts), and the variables that hold it. */
export const LABEL_LINE_VARS: Readonly<Record<string, readonly string[]>> = {
  ack_intent: ['intentLabel'],
  confirm_intent_explicit: ['intentLabel'],
  disambiguate_intent: ['a', 'b'],
  ack_intent_then: ['a', 'b'],
  ack_queued: ['intentLabel'],
  bridge_next: ['intentLabel'],
};

/**
 * A label said in `from` (a session's locale before a switch), said in `to`: the intent's or the form's
 * whose label it is in `from`, in `to`'s words; the label as it is when it is no intent's or form's.
 */
export function labelIn(app: App, label: string, from: string | undefined, to: string | undefined): string {
  if (from === to) return label;
  for (const id of [...Object.keys(app.intents), ...Object.keys(app.forms)]) {
    const isForm = !Object.hasOwn(app.intents, id);
    if (isForm && app.forms[id]!.label === undefined) continue;
    if (formLabel(app, id, from) === label) return formLabel(app, id, to);
  }
  return label;
}

/**
 * Lines worded before a switch in the same turn (core/turn.ts switchLocale) that say a request's label,
 * said again in the new locale: an ack_intent or a bridge_next built in the old one names the request in
 * the new one's words, as every other line of the turn is said in it. Every other line, and every other
 * variable, as it was.
 */
export function relabelled<A extends { readonly promptId: string; readonly vars: Readonly<Record<string, string>> }>(app: App, acks: readonly A[], from: string | undefined, to: string | undefined): A[] {
  if (from === to) return [...acks];
  return acks.map((a) => {
    // A line's other wording (`ack_intent.v2`) says the label as the line does.
    const line = lineOf(a.promptId);
    const vars = Object.hasOwn(LABEL_LINE_VARS, line) ? LABEL_LINE_VARS[line]! : [];
    const named = vars.filter((v) => a.vars[v] !== undefined);
    if (named.length === 0) return a;
    return { ...a, vars: { ...a.vars, ...Object.fromEntries(named.map((v) => [v, labelIn(app, a.vars[v]!, from, to)])) } };
  });
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

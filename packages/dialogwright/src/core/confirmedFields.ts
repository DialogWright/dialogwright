import type { App, FormDef, FormId, ToolName } from './app/types';
import { formOf, gateOf } from './app/lookup';

/**
 * The fields a form's read-back is fingerprinted over (FormDef.confirmedParams' hash, which the caller's
 * yes arms and the action's confirmed rule compares): the confirmed fields of the one action the form
 * writes, so each action names only its own (docs/designs/2026-10-18-confirmed-per-action.md). That action
 * is the form's `writes` (forms.yaml), else the one action with a confirmed rule among its `calls`. A form
 * that names neither, one or none of them with a confirmed rule, is fingerprinted over the app's one list
 * (PolicyTables.confirmedFields), as every form was before: `check` requires the lists to agree then.
 */

/** Each action's confirmed fields, by its tool; an action without a confirmed rule is absent. */
function confirmedOfActions(app: App): ReadonlyMap<ToolName, readonly string[]> {
  const out = new Map<ToolName, readonly string[]>();
  for (const [tool, action] of Object.entries(gateOf(app).source.actions)) {
    const rule = action.rules.find((r) => r.rule === 'confirmed');
    if (rule !== undefined && rule.rule === 'confirmed') out.set(tool, rule.fields);
  }
  return out;
}

/** The action a form's read-back confirms: its `writes`, else the one action among its calls with a confirmed rule; null for none, or for more than one. */
export function confirmedActionOf(app: App, form: FormDef): ToolName | null {
  const confirmed = confirmedOfActions(app);
  if (form.writes !== undefined) return confirmed.has(form.writes) ? form.writes : null;
  const among = (form.calls ?? []).filter((tool) => confirmed.has(tool));
  return among.length === 1 ? among[0]! : null;
}

/** The fields `form`'s read-back is fingerprinted over: its action's confirmed fields, else the app's one list. */
export function formConfirmedFields(app: App, form: FormId): readonly string[] {
  const tool = confirmedActionOf(app, formOf(app, form));
  return (tool !== null ? confirmedOfActions(app).get(tool) : undefined) ?? app.policy.confirmedFields;
}

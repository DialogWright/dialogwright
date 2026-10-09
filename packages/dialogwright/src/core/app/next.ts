import type { FormId } from './types';

/**
 * A form's `next` (FormDef.next, forms.yaml `next`) read across the app's forms: which forms lead to
 * a form, and the loops a chain of them would go round. `validateApp` and `check` refuse a loop and
 * an internal form nothing leads to; the app map draws an internal form under the form that leads to
 * it.
 */

/** The part of a form this reads. */
export interface FormNext {
  readonly next?: FormId;
}

/** The forms whose `next` names `form`, in definition order. */
export function formsLeadingTo(forms: Readonly<Record<FormId, FormNext>>, form: FormId): FormId[] {
  return Object.keys(forms).filter((id) => forms[id]!.next === form);
}

/** Every form `form` goes on to through `next`, in the order the chain goes, each once. */
export function formsAfter(forms: Readonly<Record<FormId, FormNext>>, form: FormId): FormId[] {
  const out: FormId[] = [];
  let at = forms[form]?.next;
  while (at !== undefined && at !== form && Object.hasOwn(forms, at) && !out.includes(at)) {
    out.push(at);
    at = forms[at]!.next;
  }
  return out;
}

/**
 * Every loop of `next` (a form that comes back round to itself), each once, as the forms in it in the
 * order the chain goes, starting from the one defined first. A `next` to a form there is not ends a
 * chain (that is a problem of its own).
 */
export function nextCycles(forms: Readonly<Record<FormId, FormNext>>): FormId[][] {
  const cycles: FormId[][] = [];
  const seen = new Set<FormId>();
  for (const start of Object.keys(forms)) {
    if (seen.has(start)) continue;
    const path: FormId[] = [];
    let at: FormId | undefined = start;
    while (at !== undefined && Object.hasOwn(forms, at) && !seen.has(at) && !path.includes(at)) {
      path.push(at);
      at = forms[at]!.next;
    }
    if (at !== undefined && path.includes(at)) {
      const loop = path.slice(path.indexOf(at));
      const first = Object.keys(forms).find((id) => loop.includes(id))!;
      const i = loop.indexOf(first);
      cycles.push([...loop.slice(i), ...loop.slice(0, i)]);
    }
    for (const id of path) seen.add(id);
  }
  return cycles;
}

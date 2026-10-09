import type { FormId, SlotId } from './types';

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

/** The part of a form an outcome reads: its slots and its checks' outcomes. */
export interface FormOutcomes {
  readonly slots: readonly SlotId[];
  readonly checks?: readonly { readonly on?: Readonly<Record<string, { readonly then: string; readonly form?: FormId }>> }[];
}

/** The form a slot's onMaxAttempts enters (`then: form`), or undefined; read from any value, as slots.yaml may hold one not yet checked. */
export function slotOutcomeForm(onMaxAttempts: unknown): FormId | undefined {
  if (typeof onMaxAttempts !== 'object' || onMaxAttempts === null) return undefined;
  const o = onMaxAttempts as { then?: unknown; form?: unknown };
  return o.then === 'form' && typeof o.form === 'string' ? o.form : undefined;
}

/**
 * The forms an outcome goes from to `form` (`then: form`, core/outcome.ts): a form with a check whose
 * outcome enters it, and a form that lists a slot whose onMaxAttempts enters it (`slots`: each slot's
 * onMaxAttempts, as its spec or slots.yaml has it), in definition order. With formsLeadingTo, what
 * reaches an internal form.
 */
export function formsEnteringByOutcome(forms: Readonly<Record<FormId, FormOutcomes>>, slots: Readonly<Record<SlotId, unknown>>, form: FormId): FormId[] {
  return Object.keys(forms).filter((id) => {
    const def = forms[id]!;
    const byCheck = (def.checks ?? []).some((c) => Object.values(c.on ?? {}).some((o) => o.then === 'form' && o.form === form));
    const bySlot = def.slots.some((slot) => Object.hasOwn(slots, slot) && slotOutcomeForm(slots[slot]) === form);
    return byCheck || bySlot;
  });
}

/** Each slot's onMaxAttempts, by id: what formsEnteringByOutcome, factorsEnteringByOutcome and moveCycles read. */
export function slotOutcomesOf(slots: Readonly<Record<SlotId, { readonly onMaxAttempts?: unknown } | undefined>>): Record<SlotId, unknown> {
  return Object.fromEntries(Object.entries(slots).map(([id, spec]) => [id, spec?.onMaxAttempts]));
}

/**
 * The identity factors whose onMaxAttempts enters `form` (`then: form`). A factor is asked by identity,
 * for whichever form needs it (or at the greeting), never listed by a form, so its outcome is
 * identity's: with formsLeadingTo and formsEnteringByOutcome, what reaches an internal form.
 */
export function factorsEnteringByOutcome(factors: readonly SlotId[], slots: Readonly<Record<SlotId, unknown>>, form: FormId): SlotId[] {
  return factors.filter((slot) => Object.hasOwn(slots, slot) && slotOutcomeForm(slots[slot]) === form);
}

/** One move from a form to another: by its `next`, or by an outcome (a check's, or a slot's that it lists). */
export type MoveKind = 'next' | 'outcome';

/**
 * Every loop of moves between forms (a form that comes back round to itself) that goes by at least one
 * outcome (`then: form`) or route after a form (`routes`: by form, the forms its routes enter), each once, as the forms in it in the order the moves go, starting from the
 * one defined first. A loop of `next` alone is nextCycles' (and refused); one through an outcome may be
 * meant (checks that read different values on each pass), so `check` warns of it, and the engine sends
 * a caller who goes round it within one turn to a person (core/turn.ts moveLoops).
 */
export function moveCycles(forms: Readonly<Record<FormId, FormNext & FormOutcomes>>, slots: Readonly<Record<SlotId, unknown>>, routes?: Readonly<Record<FormId, readonly FormId[]>>): FormId[][] {
  const ids = Object.keys(forms);
  const edges = new Map<FormId, Map<FormId, Set<MoveKind>>>();
  const add = (from: FormId, to: FormId | undefined, kind: MoveKind): void => {
    if (to === undefined || !Object.hasOwn(forms, to)) return;
    const out = edges.get(from) ?? new Map<FormId, Set<MoveKind>>();
    out.set(to, (out.get(to) ?? new Set<MoveKind>()).add(kind));
    edges.set(from, out);
  };
  for (const id of ids) {
    const def = forms[id]!;
    add(id, def.next, 'next');
    for (const check of def.checks ?? []) for (const o of Object.values(check.on ?? {})) if (o.then === 'form') add(id, o.form, 'outcome');
    for (const slot of def.slots) if (Object.hasOwn(slots, slot)) add(id, slotOutcomeForm(slots[slot]), 'outcome');
    // A route after the form that enters another (routes.yaml afterForm), a move as an outcome's is.
    for (const to of routes?.[id] ?? []) add(id, to, 'outcome');
  }
  const cycles: FormId[][] = [];
  ids.forEach((start, i) => {
    // Each loop is found once, from the form in it defined first: only forms defined at or after `start` are walked.
    const allowed = new Set(ids.slice(i));
    const walk = (at: FormId, path: FormId[], byOutcome: boolean): void => {
      for (const [to, kinds] of edges.get(at) ?? []) {
        const outcome = byOutcome || kinds.has('outcome');
        if (to === start) {
          if (outcome) cycles.push([...path]);
        } else if (allowed.has(to) && !path.includes(to)) walk(to, [...path, to], outcome);
      }
    };
    walk(start, [start], false);
  });
  return cycles;
}

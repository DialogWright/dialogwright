import type { FormId, GeneratedLine, GeneratedWording, RenderStyle } from '../core/app/types';
import type { FormsYaml, PromptYaml, StyleYaml } from '../define/schema/index';
import { DEFAULT_WORDS } from '../define/schema/style';

/** The persona a generated line has when style.yaml names none. */
export const DEFAULT_PERSONA = 'a calm, plain-spoken agent';

/** The goal of a line its form's switch generates when the line gives none of its own. */
export const DEFAULT_GOAL = 'Say what the fixed line says, in words that fit this moment.';

/** style.yaml with its defaults filled in. */
export function styleOf(style: StyleYaml | null | undefined): RenderStyle {
  return {
    persona: style?.persona ?? DEFAULT_PERSONA,
    words: { voice: style?.words?.voice ?? DEFAULT_WORDS.voice, chat: style?.words?.chat ?? DEFAULT_WORDS.chat },
    avoid: [...(style?.avoid ?? [])],
  };
}

/**
 * The prompt ids that are a form's lines, for its `wording: generative` switch: each of its slots'
 * questions (`ask_<slot>` and every `ask_<slot>_<anything>`: its retry, no-input and partial lines),
 * their read-backs (`confirm_<slot>` and `confirm_<slot>_<anything>`), and its summary. Only ids the
 * prompts have, in the prompts' order.
 */
export function formLineIds(promptIds: readonly string[], slots: readonly string[], summaryPromptId: string | null): string[] {
  const own = (id: string): boolean =>
    id === summaryPromptId || slots.some((slot) => id === `ask_${slot}` || id.startsWith(`ask_${slot}_`) || id === `confirm_${slot}` || id.startsWith(`confirm_${slot}_`));
  return promptIds.filter(own);
}

/**
 * An app folder's generated wording (App.generated): the lines its prompts mark `mode: generative`, and
 * the lines of each form with `wording: generative` that neither say `mode: fixed` nor are prescribed;
 * the prescribed lines; style.yaml; and each other locale's goals. Undefined for a folder that generates
 * no line and prescribes none, so its App is exactly as it was before generated wording.
 */
export function generatedWordingOf(input: {
  prompts: Readonly<Record<string, PromptYaml>>;
  forms: FormsYaml['forms'];
  style: StyleYaml | null;
  localePrompts: Readonly<Record<string, Readonly<Record<string, PromptYaml>>>>;
  /** The variables that hold an identifier (an identity factor, a slot recorded masked): a form's line that names one stays fixed. */
  identifierVars?: ReadonlySet<string>;
}): GeneratedWording | undefined {
  const lines: Record<string, GeneratedLine> = {};
  const ids = Object.keys(input.prompts);
  const prescribed = ids.filter((id) => input.prompts[id]!.prescribed === true).sort();
  const lineOf = (p: PromptYaml, by: GeneratedLine['by']): GeneratedLine => ({
    goal: p.goal ?? DEFAULT_GOAL,
    ...(p.when?.situations !== undefined ? { situations: [...p.when.situations] } : {}),
    ...(p.when?.channels !== undefined ? { channels: [...p.when.channels] } : {}),
    ...(p.from !== undefined ? { from: [...p.from] } : {}),
    by,
  });
  for (const id of ids) {
    const p = input.prompts[id]!;
    if (p.mode === 'generative' && p.prescribed !== true) lines[id] = lineOf(p, 'prompt');
  }
  for (const [form, def] of Object.entries(input.forms) as [FormId, FormsYaml['forms'][string]][]) {
    if (def.wording !== 'generative') continue;
    for (const id of formLineIds(ids, def.slots, def.summaryPromptId)) {
      const p = input.prompts[id]!;
      // A line that names an identifier is never sent to a model: its form's switch leaves it fixed.
      if (Object.hasOwn(lines, id) || p.mode === 'fixed' || p.prescribed === true || identifierVarsOf(p.text, input.identifierVars).length > 0) continue;
      lines[id] = lineOf(p, { form });
    }
  }
  if (Object.keys(lines).length === 0 && prescribed.length === 0) return undefined;
  const localeGoals: Record<string, Record<string, string>> = {};
  for (const [locale, prompts] of Object.entries(input.localePrompts)) {
    const goals = Object.fromEntries(Object.entries(prompts).filter(([id, p]) => p.goal !== undefined && Object.hasOwn(lines, id)).map(([id, p]) => [id, p.goal!]));
    if (Object.keys(goals).length > 0) localeGoals[locale] = goals;
  }
  return { lines, prescribed, style: styleOf(input.style), localeGoals };
}

/** Whether `app` has a line a model may word (App.generated.lines): the one test for "this app generates". */
export function generatesLines(app: { generated?: GeneratedWording }): boolean {
  return app.generated !== undefined && Object.keys(app.generated.lines).length > 0;
}

/** The {variables} of a line's text. */
export function lineVars(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))];
}

/** The variables of `text` that hold an identifier (`identifierVars`), in order. */
export function identifierVarsOf(text: string, identifierVars: ReadonlySet<string> | undefined): string[] {
  return identifierVars === undefined ? [] : lineVars(text).filter((v) => identifierVars.has(v));
}

/**
 * The variables that hold an identifier, which a generated line is never sent: each identity factor
 * slot (an account number, a date of birth: what proves who the caller is), and each slot hidden whole
 * in the records (a slot's `redact: mask`, or `length`). A slot recorded by its last four (a callback
 * number) is a data item a line may carry, as its fixed line does: generating that line is the app's
 * choice, and the policy card lists it. A line that names an identifier is not generated (`pnpm check`
 * refuses `mode: generative` on it, and a form's switch leaves it fixed).
 */
export function identifierVarsFrom(slots: Readonly<Record<string, { redact?: string }>>, factors: readonly string[]): Set<string> {
  return new Set([...factors, ...Object.entries(slots).filter(([, s]) => s.redact === 'mask' || s.redact === 'length').map(([id]) => id)]);
}

/** A problem with an app's generated wording, at its place in a file (the loader's format, unpositioned). */
export interface WordingProblem {
  file: string;
  path: (string | number)[];
  message: string;
  fix: string;
  atKey?: boolean;
}

/**
 * What `pnpm check` holds generated wording to: a prescribed line is never generated; a generated line
 * has a goal, names an identifier in no variable, and its `from` names its own variables; a goal,
 * `when` or `from` on a line that is not generated does nothing; in a locale's prompts.yaml, only a
 * line's goal (mode, prescribed, when and from are prompts.yaml's, for every locale); and a form's
 * switch generates at least one line.
 */
export function generatedWordingProblems(input: {
  prompts: Readonly<Record<string, PromptYaml>>;
  forms: FormsYaml['forms'];
  localePrompts: Readonly<Record<string, Readonly<Record<string, PromptYaml>>>>;
  identifierVars: ReadonlySet<string>;
}): WordingProblem[] {
  const out: WordingProblem[] = [];
  const file = 'prompts.yaml';
  const generated = generatedWordingOf({ ...input, style: null })?.lines ?? {};
  for (const [id, p] of Object.entries(input.prompts)) {
    const at = (key: string): (string | number)[] => ['prompts', id, key];
    if (p.prescribed === true && p.mode === 'generative') {
      out.push({ file, path: at('mode'), message: `the line "${id}" is prescribed (prescribed: true), so it is always said word for word and never generated`, fix: 'delete "mode: generative", or delete "prescribed: true" if a model may word this line' });
      continue;
    }
    if (p.mode === 'generative' && p.goal === undefined) {
      out.push({ file, path: ['prompts', id], message: `the line "${id}" is generated (mode: generative) but has no goal, so the model would not know what the line is for`, fix: `add "goal:" saying what the line must do, for example "Ask for the caller's name; briefly acknowledge what they just said."`, atKey: true });
    }
    const isGenerated = Object.hasOwn(generated, id);
    if (p.mode === 'generative') {
      const ids = identifierVarsOf(p.text, input.identifierVars);
      if (ids.length > 0) out.push({ file, path: at('mode'), message: `the line "${id}" is generated, but it names ${ids.map((v) => `{${v}}`).join(', ')}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a generated line is never sent an identifier`, fix: 'delete "mode: generative" (the line is said word for word), or say the identifier in a fixed line of its own' });
    }
    if (!isGenerated) {
      for (const key of ['goal', 'when', 'from'] as const) {
        if (p[key] !== undefined && !(p.mode === 'generative')) out.push({ file, path: at(key), message: `the line "${id}" is not generated (no mode: generative, and no form that generates its lines), so its "${key}" does nothing`, fix: `add "mode: generative" to generate it, or delete "${key}"`, atKey: true });
      }
    }
    if (p.from !== undefined) {
      const vars = lineVars(p.text);
      p.from.forEach((v, i) => {
        if (!vars.includes(v)) out.push({ file, path: ['prompts', id, 'from', i], message: `the line "${id}" has no {${v}}, so it cannot be generated from it`, fix: `name one of the line's own variables (${vars.length > 0 ? vars.map((x) => `{${x}}`).join(', ') : 'it has none'}), or add {${v}} to its text` });
      });
    }
  }
  for (const [form, def] of Object.entries(input.forms)) {
    if (def.wording !== 'generative') continue;
    const any = Object.values(generated).some((l) => l.by !== 'prompt' && l.by.form === form);
    if (!any) out.push({ file: 'forms.yaml', path: ['forms', form, 'wording'], message: `the form "${form}" says wording: generative, but none of its lines is generated (each is mode: fixed, prescribed, names an identifier, or is not in prompts.yaml)`, fix: 'delete "wording: generative", or let one of its lines be generated' });
  }
  for (const [locale, prompts] of Object.entries(input.localePrompts)) {
    const dir = `locale/${locale}/prompts.yaml`;
    for (const [id, p] of Object.entries(prompts)) {
      for (const key of ['mode', 'prescribed', 'when', 'from'] as const) {
        if (p[key] !== undefined) out.push({ file: dir, path: ['prompts', id, key], message: `"${key}" is read from prompts.yaml, for every locale; a locale gives a generated line only its goal`, fix: `move "${key}" to the line in prompts.yaml, or delete it here`, atKey: true });
      }
      if (p.goal !== undefined && !Object.hasOwn(generated, id)) out.push({ file: dir, path: ['prompts', id, 'goal'], message: `the line "${id}" is not generated in prompts.yaml, so its goal here does nothing`, fix: 'generate it in prompts.yaml (mode: generative), or delete "goal"', atKey: true });
    }
  }
  return out;
}

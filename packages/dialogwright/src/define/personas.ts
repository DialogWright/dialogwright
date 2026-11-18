import { closest, type DataPath } from './problems';
import type { AppYaml, PromptYaml } from './schema/index';
import type { PersonaYaml } from './schema/persona';
import type { PersonaOverlay } from '../core/app/types';
import { chatVariables } from '../prompts/rich';
import { VAR } from '../prompts/segments';

/**
 * Personas (app.yaml's `personas`, each a persona file: ./schema/persona.ts): the rules a persona file
 * is held to once read, beside the app's prompts.yaml and app.yaml, and the overlay the engine runs
 * (App.personas; core/app/personas.ts personaApp applies it).
 */

/** Reports one problem: in `file`, at `path`, or at its key with `atKey`. */
export type PersonaReport = (file: string, path: DataPath, message: string, fix: string, atKey?: boolean) => void;

/** The variables a text names ({name}), each once. */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]!))];
}

/** "{a}, {b}" or "no variable". */
const named = (vars: readonly string[]): string => (vars.length === 0 ? 'no variable' : vars.map((v) => `{${v}}`).join(', '));

/**
 * What app.yaml's personas may not say, beside its schema: `from` names a key callData gives (else no
 * call ever carries the value that picks a persona).
 */
export function personasAppProblems(app: AppYaml, report: PersonaReport): void {
  const personas = app.personas;
  if (personas === undefined) return;
  const keys = Object.keys(app.callData ?? {});
  if (!keys.includes(personas.from)) {
    report(
      'app.yaml',
      ['personas', 'from'],
      `personas.from names "${personas.from}", which is not a key of callData: no call or chat carries the value that picks a persona`,
      keys.length > 0 ? `name one of ${keys.map((k) => `"${k}"`).join(', ')}, or add "${personas.from}" to callData (for a chat page's choice: { from: chat.${personas.from}, redact: keep })` : `add callData: { ${personas.from}: { from: chat.${personas.from}, redact: keep } } (a chat page's choice), or the custom parameter that carries it`,
    );
  }
}

/**
 * What a persona file may not say, against the app's own lines (prompts.yaml, `prompts`): each line it
 * words is one of the app's, never one marked prescribed (regulated wording); its text, each variant and
 * its chat version name only the variables the app's own line names (its text or its variants; a chat
 * version, also its own chat version's), so the code always has the values; a framed line keeps every
 * span its text names; and each span it gives a budget is one the app generates.
 */
export function personaContentProblems(file: string, persona: PersonaYaml, prompts: Readonly<Record<string, PromptYaml>>, report: PersonaReport): void {
  const ids = Object.keys(prompts);
  for (const [id, line] of Object.entries(persona.prompts ?? {})) {
    const own = Object.hasOwn(prompts, id) ? prompts[id]! : undefined;
    if (own === undefined) {
      report(file, ['prompts', id], `the line "${id}" is not in prompts.yaml, so the persona words a line the app never says`, `name one of the app's lines (prompts.yaml), or delete "${id}"${nearest(id, ids)}`, true);
      continue;
    }
    if (own.prescribed === true) {
      report(file, ['prompts', id], `the line "${id}" is prescribed (prompts.yaml's prescribed: true): its words are the app's, fixed for every call, and a persona may not reword it`, `delete "${id}" from the persona, or take prescribed: true off the line if its words are not regulated`, true);
      continue;
    }
    const allowed = new Set([...variablesOf(own.text), ...(own.variants ?? []).flatMap(variablesOf)]);
    const allowedOnChat = new Set([...allowed, ...(own.chat !== undefined ? chatVariables(own.chat) : [])]);
    const extra = (vars: readonly string[], within: ReadonlySet<string>): string[] => vars.filter((v) => !within.has(v));
    const refuse = (path: DataPath, wording: string, unknown: readonly string[], within: ReadonlySet<string>): void => {
      report(file, path, `${wording} names ${named(unknown)}, which the app's own line "${id}" does not: the code gives the line only the values its own words name`, `name only ${named([...within])} here`);
    };
    if (line.text !== undefined) {
      const bad = extra(variablesOf(line.text), allowed);
      if (bad.length > 0) refuse(['prompts', id, 'text'], `the persona's text of "${id}"`, bad, allowed);
      // A framed line (prompts.yaml's generate): each span is a gap in the line its wording fills, so the persona's text keeps every one.
      const spans = Object.keys(own.generate ?? {});
      const kept = new Set(variablesOf(line.text));
      const lost = spans.filter((span) => !kept.has(span));
      if (lost.length > 0) report(file, ['prompts', id, 'text'], `the line "${id}" is framed (prompts.yaml's generate), and the persona's text leaves out its span${lost.length === 1 ? '' : 's'} ${named(lost)}, which a model words into the line`, `name ${named(lost)} in the text, where the span is said`);
    }
    line.variants?.forEach((variant, i) => {
      const bad = extra(variablesOf(variant), allowed);
      if (bad.length > 0) refuse(['prompts', id, 'variants', i], `the persona's variant "${variant}"`, bad, allowed);
    });
    if (line.chat !== undefined) {
      const bad = extra(chatVariables(line.chat), allowedOnChat);
      if (bad.length > 0) refuse(['prompts', id, 'chat'], `the persona's chat version of "${id}"`, bad, allowedOnChat);
    }
  }
  for (const [id, spans] of Object.entries(persona.spans ?? {})) {
    const own = Object.hasOwn(prompts, id) ? prompts[id]! : undefined;
    if (own === undefined) {
      report(file, ['spans', id], `the line "${id}" is not in prompts.yaml, so it has no span to give a budget`, `name a line with generated spans (prompts.yaml's generate), or delete "${id}"${nearest(id, ids)}`, true);
      continue;
    }
    const generated = Object.keys(own.generate ?? {});
    for (const span of Object.keys(spans)) {
      if (generated.includes(span)) continue;
      report(
        file,
        ['spans', id, span],
        generated.length === 0 ? `the line "${id}" has no generated span (prompts.yaml's generate), so "${span}" has no budget to change` : `the line "${id}" generates ${named(generated)}, not {${span}}`,
        generated.length === 0 ? `delete "${id}" from spans` : `name one of ${generated.map((g) => `"${g}"`).join(', ')}, or delete "${span}"`,
        true,
      );
    }
  }
}

/** " (rename it to "x" ...)" for a close id. */
function nearest(word: string, known: readonly string[]): string {
  const close = closest(word, known);
  return close === undefined ? '' : ` (rename it to "${close}" if that is the line)`;
}

/**
 * Each line a persona words as prompts.yaml would have it: the app's own line with the persona's text,
 * variants and chat version in place of its own (every other field kept), for the checks that hold a
 * line's words (check.ts checkVariants, checkChatVersions) to run on the persona's.
 */
export function personaPromptLines(persona: PersonaYaml, prompts: Readonly<Record<string, PromptYaml>>): Record<string, PromptYaml> {
  const out: Record<string, PromptYaml> = {};
  for (const [id, line] of Object.entries(persona.prompts ?? {})) {
    const own = Object.hasOwn(prompts, id) ? prompts[id]! : undefined;
    if (own === undefined) continue;
    out[id] = { ...own, ...(line.text !== undefined ? { text: line.text } : {}), ...(line.variants !== undefined ? { variants: [...line.variants] } : {}), ...(line.chat !== undefined ? { chat: line.chat } : {}) };
  }
  return out;
}

/** A persona file as the engine runs it (App.personas' overlays): only what it gives. */
export function personaOverlayOf(persona: PersonaYaml): PersonaOverlay {
  const words = persona.style?.words;
  return {
    ...(persona.style !== undefined
      ? {
          style: {
            ...(persona.style.persona !== undefined ? { persona: persona.style.persona } : {}),
            ...(words !== undefined ? { words: { ...(words.voice !== undefined ? { voice: words.voice } : {}), ...(words.chat !== undefined ? { chat: words.chat } : {}) } } : {}),
          },
        }
      : {}),
    ...(persona.spans !== undefined ? { spans: Object.fromEntries(Object.entries(persona.spans).map(([id, spans]) => [id, Object.fromEntries(Object.entries(spans).map(([span, s]) => [span, { words: s.words }]))])) } : {}),
    ...(persona.prompts !== undefined
      ? {
          prompts: Object.fromEntries(Object.entries(persona.prompts).map(([id, line]) => [id, { ...(line.text !== undefined ? { text: line.text } : {}), ...(line.variants !== undefined ? { variants: [...line.variants] } : {}), ...(line.chat !== undefined ? { chat: line.chat } : {}) }])),
        }
      : {}),
  };
}

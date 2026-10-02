import type { App } from '../core/app/types';
import type { PromptEntry } from './render';

export type Segment =
  | { kind: 'fixed'; id: string; text: string }
  | { kind: 'var'; name: string };

/**
 * A line that carries data (App.prompts.dataVars: values read from a tool or a knowledge base) is
 * spoken whole by TTS: never recorded, never split into clips. The lines that carry such values are
 * so dense with them that stitching clips around them would be all seams.
 */
export function ttsOnly(app: Pick<App, 'prompts'>, segments: readonly Segment[]): boolean {
  const data = app.prompts.dataVars ?? [];
  return segments.some((s) => s.kind === 'var' && data.includes(s.name));
}

/** The one template grammar: a `{name}` placeholder. Global; use only via matchAll/replace, never .test()/.exec(). */
export const VAR = /\{(\w+)\}/g;
const PAUSE = /^[,.?!;:]/;
const LEADING_PAUSE = new RegExp(`${PAUSE.source}\\s*`);

/** Split a template at its variables; fixed runs are trimmed, empty runs dropped, ids numbered from 0. */
export function segmentTemplate(promptId: string, template: string): Segment[] {
  const out: Segment[] = [];
  let n = 0;
  let last = 0;
  for (const m of template.matchAll(VAR)) {
    const text = template.slice(last, m.index).trim();
    if (text) out.push({ kind: 'fixed', id: `${promptId}.${n++}`, text });
    out.push({ kind: 'var', name: m[1]! });
    last = m.index + m[0].length;
  }
  const tail = template.slice(last).trim();
  if (tail) out.push({ kind: 'fixed', id: `${promptId}.${n++}`, text: tail });
  return out;
}

export function segmentsOf<M extends Record<string, PromptEntry>>(manifest: M): Record<keyof M, Segment[]> {
  return Object.fromEntries(
    Object.entries(manifest).map(([id, entry]) => [id, segmentTemplate(id, entry.text)]),
  ) as Record<keyof M, Segment[]>;
}

/**
 * Join already-substituted pieces the way the templates space them: one space between
 * pieces, none before a piece that starts with punctuation. This is the inverse of the
 * trimming segmentTemplate does to fixed runs, so the clip player (recorded clips with a
 * TTS fallback for variables) can reassemble spoken text from segments the same way
 * renderTemplate assembles it from a single template string.
 */
export function joinSpoken(pieces: string[]): string {
  let out = '';
  for (const p of pieces) {
    if (!p) continue;
    // A possessive ("'s parcel" after a name) is attached to the word before it, like punctuation.
    out += out === '' || PAUSE.test(p) || p.startsWith("'") ? p : ` ${p}`;
  }
  return out;
}

/** Strip a leading pause (comma, period, etc.) and the whitespace after it, e.g. before text that follows a played clip. */
export function stripLeadingPause(text: string): string {
  return text.replace(LEADING_PAUSE, '');
}

/** A fixed segment's text is nothing but a leading pause, e.g. the "." left over from "Thanks, {first}." — never clip-backed. */
export function isPauseOnly(text: string): boolean {
  return stripLeadingPause(text) === '';
}

/**
 * A TTS span inside a recorded sentence is the audible seam, so a spoken variable
 * must end its clause. Vocabulary variables sit between clips and are free, and a line spoken
 * whole by TTS (ttsOnly) has no seam at all.
 *
 * Only the "followed by punctuation or end" half of that rule is enforced here. The other
 * half — a spoken variable preceded by a pause — is deliberately not checked: that seam
 * (e.g. "Your account ID is" -> number) exists in every readback prompt in the manifest, so
 * enforcing it would flag the normal case rather than a real problem.
 */
export function seamViolations(app: Pick<App, 'prompts'>, promptId: string, segments: Segment[]): string[] {
  const out: string[] = [];
  // A line spoken whole by TTS has no recorded clip for a variable to seam against.
  if (ttsOnly(app, segments)) return out;
  const spoken = app.prompts.spokenVars ?? [];
  segments.forEach((s, i) => {
    if (s.kind !== 'var' || !spoken.includes(s.name)) return;
    const next = segments[i + 1];
    if (next && !(next.kind === 'fixed' && PAUSE.test(next.text))) out.push(`${promptId}: {${s.name}} must be followed by punctuation or end the prompt`);
  });
  return out;
}

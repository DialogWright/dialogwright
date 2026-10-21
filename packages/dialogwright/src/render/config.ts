import type { FormId, GeneratedLine, GeneratedSpan, GeneratedWording, RenderStyle } from '../core/app/types';
import type { FormsYaml, PromptYaml, StyleYaml } from '../define/schema/index';
import { DEFAULT_SPAN_WORDS } from '../define/schema/prompts';
import { DEFAULT_WORDS } from '../define/schema/style';
import { ADDED_FIRE, COMPARE_FIRE, DRIFT_ALONE_FIRE, DRIFT_FIRE } from './checks';
import { SPAN_GAP } from './types';

/** The persona a generated line has when style.yaml names none. */
export const DEFAULT_PERSONA = 'a calm, plain-spoken agent';

/** The goal of a line its form's switch generates when the line gives none of its own. */
export const DEFAULT_GOAL = 'Say what the fixed line says, in words that fit this moment.';

/** A framed line's own goal (GeneratedLine.goal), never sent to a model: each of its spans has its own. */
export const FRAMED_GOAL = 'Said as written, but for its generated spans.';

/**
 * What a span's `from` names for a knowledge base's answer (a form's answer line): the approved passage the
 * knowledge completion resolved for the caller, rather than a slot.
 */
export const KB_ANSWER_SOURCE = 'answer';

/**
 * What a span's `from` names for an answer drawn from sections of approved documents (kb.yaml documents;
 * a form's documents answer line): the sections the decision model chose for the caller's question.
 */
export const KB_SECTIONS_SOURCE = 'sections';

/** The word budget of an answer from documents whose span sets no `words`: a sentence or two. */
export const DEFAULT_DOCUMENTS_WORDS = 60;

/**
 * The word budget of a knowledge answer's span the app does not size (`words` unset): room above its
 * passage, so a faithful wording for the caller's question that takes a few more words than the
 * passage (a word of lead-in, the question's own terms) is not cut back to the passage. A quarter more
 * than the passage, and at least ten more (the maintainer's decision, 2026-10-16: give long answers
 * the room their summary needs). What the wording may say is held by the checks and the judge, not by
 * this number.
 */
export function answerWordBudget(passageWords: number): number {
  return Math.max(passageWords + 10, Math.ceil(passageWords * 1.25));
}

/**
 * A framed line's spans (prompts.yaml's `generate`) as the engine holds them, each with its word budget;
 * a span `from: answer` with no `words` of its own is sized to its passage (GeneratedSpan.sizedToPassage,
 * answerWordBudget).
 */
function spansOf(p: PromptYaml): Record<string, GeneratedSpan> | undefined {
  if (p.generate === undefined) return undefined;
  return Object.fromEntries(Object.entries(p.generate).map(([name, s]) => [name, {
    from: s.from ?? '', goal: s.goal, words: s.words ?? (s.from === KB_SECTIONS_SOURCE ? DEFAULT_DOCUMENTS_WORDS : DEFAULT_SPAN_WORDS),
    ...(s.from === KB_ANSWER_SOURCE && s.words === undefined ? { sizedToPassage: true as const } : {}),
    ...(s.speaks === 'to-caller' ? { speaks: 'to-caller' as const } : {}), ...(s.names !== undefined ? { names: [...s.names] } : {}),
    ...(s.retry !== undefined && s.retry > 0 ? { retry: s.retry } : {}),
    ...(s.retryGoal !== undefined ? { retryGoal: s.retryGoal } : {}),
    ...(s.retryLong === true ? { retryLong: true as const } : {}),
    ...(s.retryWords !== undefined ? { retryWords: s.retryWords } : {}),
  }]));
}

/** Whether a generated line's span words a knowledge base's answer: an approved passage (`from: answer`) or sections of approved documents (`from: sections`). */
export function isAnswerSpan(span: GeneratedSpan | undefined): boolean {
  return span?.from === KB_ANSWER_SOURCE || span?.from === KB_SECTIONS_SOURCE;
}

/** Whether a span words an answer from sections of approved documents (`from: sections`). */
export function isSectionsSpan(span: GeneratedSpan | undefined): boolean {
  return span?.from === KB_SECTIONS_SOURCE;
}

/** The line a form's answer from documents is said through (forms.yaml's `answers.documents.answer`, default `kb_documents_answer`). */
export function formDocumentsLine(answers: { readonly documents?: { readonly answer?: string | undefined } | undefined }): string {
  return answers.documents?.answer ?? 'kb_documents_answer';
}

/** The span of `line` that words a knowledge base's answer (`from: answer`), by name, or null. */
export function answerSpanOf(line: GeneratedLine | undefined): { name: string; span: GeneratedSpan } | null {
  for (const [name, span] of Object.entries(line?.spans ?? {})) if (isAnswerSpan(span)) return { name, span };
  return null;
}

/** The line a form's knowledge answer is said through (forms.yaml's `answers.answer`, default `kb_answer`). */
export function formAnswerLine(answers: { readonly answer?: string | undefined }): string {
  return answers.answer ?? KB_ANSWER_LINE_DEFAULT;
}

/** The line a knowledge answer is said through by default (kb/answer.ts KB_ANSWER_PROMPT). */
const KB_ANSWER_LINE_DEFAULT = 'kb_answer';

/**
 * The variables the knowledge completion gives an answer line that words its answer (a span `from:
 * answer`), beside {answer} (the passage, then the topic's account line): the account line alone, said
 * after a wording of the passage as it is after the passage; and the caller's question, in their words,
 * which the wording is for. Never said by a line's text: the engine's own (kb/answer.ts kbCompletion).
 */
export const KB_ACCOUNT_VAR = 'answerAccountLine';
export const KB_QUESTION_VAR = 'answerQuestion';
/** The variable an answer from documents carries the caller's earlier question in, where the app reads follow-ups (kb.yaml documents.followUps): given to the wording, the judge and the lines picker beside the question. */
export const KB_EARLIER_VAR = 'answerEarlier';

/** How each of style.yaml's `figures` is told to the model, as the line's style. */
export const FIGURES: Readonly<Record<'symbols' | 'words', string>> = {
  symbols: 'write amounts, percentages and other numbers as figures with their symbols ($150, 20%, a 30-day supply), as the source writes them',
  words: 'write amounts, percentages and other numbers in words (150 dollars, 20 percent), as they are spoken',
};

/** style.yaml with its defaults filled in. */
export function styleOf(style: StyleYaml | null | undefined): RenderStyle {
  return {
    persona: style?.persona ?? DEFAULT_PERSONA,
    words: { voice: style?.words?.voice ?? DEFAULT_WORDS.voice, chat: style?.words?.chat ?? DEFAULT_WORDS.chat },
    avoid: [...(style?.avoid ?? [])],
    ...(style?.figures !== undefined ? { figures: FIGURES[style.figures] } : {}),
    // Only where style.yaml says one, so an app that says none has the App it had (the turn uses DRIFT_FIRE).
    ...(style?.judge?.refuseAt !== undefined ? { refuseAt: style.judge.refuseAt } : {}),
    ...(style?.judge?.documentsRefuseAt !== undefined ? { documentsRefuseAt: style.judge.documentsRefuseAt } : {}),
    ...(style?.judge?.documentsAsk !== undefined ? { documentsAsk: style.judge.documentsAsk } : {}),
    ...(style?.judge?.documentsAddedAt !== undefined ? { documentsAddedAt: style.judge.documentsAddedAt } : {}),
    ...(style?.judge?.documentsDriftAloneAt !== undefined ? { documentsDriftAloneAt: style.judge.documentsDriftAloneAt } : {}),
    ...(style?.judge?.compareFigures !== undefined ? { compareFigures: { ...style.judge.compareFigures, refuseAt: style.judge.compareFigures.refuseAt ?? COMPARE_FIRE } } : {}),
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
  const lineOf = (p: PromptYaml, by: GeneratedLine['by'], formAcknowledges?: boolean): GeneratedLine => {
    const spans = spansOf(p);
    // A line's own `acknowledge` wins; else its form's, for a line the form's switch generates. A span never acknowledges.
    const acknowledge = spans === undefined ? (p.acknowledge ?? formAcknowledges ?? true) : true;
    return {
      goal: spans !== undefined ? FRAMED_GOAL : (p.goal ?? DEFAULT_GOAL),
      ...(p.when?.situations !== undefined ? { situations: [...p.when.situations] } : {}),
      ...(p.when?.channels !== undefined ? { channels: [...p.when.channels] } : {}),
      ...(p.from !== undefined && spans === undefined ? { from: [...p.from] } : {}),
      by,
      ...(p.summarizesConfirmed === true ? { summarizesConfirmed: true as const } : {}),
      ...(acknowledge ? {} : { acknowledge: false as const }),
      ...(spans !== undefined ? { spans } : {}),
    };
  };
  for (const id of ids) {
    const p = input.prompts[id]!;
    // A framed line (`generate`) is generated by its spans alone, whatever its form says; whole by its own mode.
    if (p.prescribed !== true && (p.generate !== undefined || p.mode === 'generative')) lines[id] = lineOf(p, 'prompt');
  }
  for (const [form, def] of Object.entries(input.forms) as [FormId, FormsYaml['forms'][string]][]) {
    if (def.wording !== 'generative') continue;
    for (const id of formLineIds(ids, def.slots, def.summaryPromptId)) {
      const p = input.prompts[id]!;
      // A line that names an identifier is never sent to a model, and a knowledge base's answer is said word for word: its form's switch leaves either fixed.
      if (Object.hasOwn(lines, id) || p.mode === 'fixed' || p.prescribed === true || identifierVarsOf(p.text, input.identifierVars).length > 0 || saysKbAnswer(p.text)) continue;
      lines[id] = lineOf(p, { form }, def.acknowledge);
    }
  }
  if (Object.keys(lines).length === 0 && prescribed.length === 0) return undefined;
  // The topic slots whose question is kept: each form's whose answer line words its answer (`from: answer`).
  const answerSlots = [...new Set(Object.values(input.forms).flatMap((def) => (def.answers !== undefined && (answerSpanOf(lines[formAnswerLine(def.answers)]) !== null || answerSpanOf(lines[formDocumentsLine(def.answers)]) !== null) ? [def.answers.slot] : [])))];
  const localeGoals: Record<string, Record<string, string>> = {};
  const localeSpanGoals: Record<string, Record<string, Record<string, string>>> = {};
  for (const [locale, prompts] of Object.entries(input.localePrompts)) {
    const goals = Object.fromEntries(Object.entries(prompts).filter(([id, p]) => p.goal !== undefined && Object.hasOwn(lines, id) && lines[id]!.spans === undefined).map(([id, p]) => [id, p.goal!]));
    if (Object.keys(goals).length > 0) localeGoals[locale] = goals;
    // A framed line's spans in this locale: each one this locale gives a goal, of the spans prompts.yaml frames.
    const spanGoals: Record<string, Record<string, string>> = {};
    for (const [id, p] of Object.entries(prompts)) {
      const spans = Object.hasOwn(lines, id) ? lines[id]!.spans : undefined;
      if (spans === undefined || p.generate === undefined) continue;
      const own = Object.fromEntries(Object.entries(p.generate).filter(([name]) => Object.hasOwn(spans, name)).map(([name, sp]) => [name, sp.goal]));
      if (Object.keys(own).length > 0) spanGoals[id] = own;
    }
    if (Object.keys(spanGoals).length > 0) localeSpanGoals[locale] = spanGoals;
  }
  return {
    lines,
    prescribed,
    style: styleOf(input.style),
    localeGoals,
    ...(Object.keys(localeSpanGoals).length > 0 ? { localeSpanGoals } : {}),
    // The model the app names (style.yaml's `model`): only where it names one, so every other App is as it was.
    ...(input.style?.model !== undefined ? { model: { provider: input.style.model.provider, ...(input.style.model.id !== undefined ? { id: input.style.model.id } : {}), ...(input.style.model.thinking !== undefined ? { thinking: input.style.model.thinking } : {}), ...(input.style.model.effort !== undefined ? { effort: input.style.model.effort } : {}), ...(input.style.model.temperature !== undefined ? { temperature: input.style.model.temperature } : {}), ...(input.style.model.retryTemperature !== undefined ? { retryTemperature: input.style.model.retryTemperature } : {}) } } : {}),
    // Only where a form's answer line words its answer, so every other App is as it was.
    ...(answerSlots.length > 0 ? { answerSlots } : {}),
  };
}

/** Whether a generated line is framed (prompts.yaml's `generate`): only its spans are generated. */
export function isFramed(line: GeneratedLine | undefined): line is GeneratedLine & { spans: Readonly<Record<string, GeneratedSpan>> } {
  return line?.spans !== undefined;
}

/** Whether `app` has a line a model may word (App.generated.lines): the one test for "this app generates". */
export function generatesLines(app: { generated?: GeneratedWording }): boolean {
  return app.generated !== undefined && Object.keys(app.generated.lines).length > 0;
}

/**
 * The variable a knowledge base's answer is said in (kb/answer.ts KB_ANSWER_VAR): a line that names it says
 * an approved passage, word for word, and is never generated whole; only a form's answer line framed with a
 * span `from: answer` may have the passage worded, on a topic marked `risk: low`.
 */
export const KB_ANSWER_LINE_VAR = 'answer';

/** Whether a line says a knowledge base's answer (it names {answer}). */
export function saysKbAnswer(text: string): boolean {
  return lineVars(text).includes(KB_ANSWER_LINE_VAR);
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
 * The slots a model may be sent to summarize though the records mask them (SlotSpec.summarized, a
 * `text` slot's `redact: length-summarized`), never an identity factor: the one named exception to "a
 * model is never sent a value the records hide whole", for a framed span or a line generated from it.
 */
export function summarizedVarsFrom(slots: Readonly<Record<string, { summarized?: true }>>, factors: readonly string[]): Set<string> {
  return new Set(Object.entries(slots).filter(([id, s]) => s.summarized === true && !factors.includes(id)).map(([id]) => id));
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

/** Whether a span may speak to the caller (`speaks: to-caller`) in this language: English only, for now (its read-backs and their judge are measured in English only: render/judgeCases). */
export function speaksToCallerIn(language: string | undefined): boolean {
  return language === undefined || /^en(?:-|_|$)/i.test(language);
}

/**
 * The names a to-caller span may say (its `names`), as the engine holds to them where the line is said:
 * each a `choice` slot with no redact setting and no identity factor (`pnpm check` refuses any other,
 * and an app built in code is held the same way here), in the order the span lists them. A value with a
 * digit is left out where the line is said (render/turn.ts).
 */
export function spanNameVars(slots: Readonly<Record<string, { type?: unknown; redact?: string }>>, names: readonly string[] | undefined, factors: readonly string[]): string[] {
  return (names ?? []).filter((v) => Object.hasOwn(slots, v) && !factors.includes(v) && slots[v]!.type === 'choice' && slots[v]!.redact === undefined);
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
  /** Each action's `confirmed` fields (policy.yaml), by tool: a read-back that summarizes one must say so. */
  confirmed?: Readonly<Record<string, readonly string[]>>;
  /** The app's slots, by id: a span is worded from one (its `from`). Absent, a span's `from` is not held to them. */
  slots?: readonly string[];
  /** The slots marked to be summarized though masked in the records (SlotSpec.summarized), each held to a line that summarizes it. */
  summarized?: readonly string[];
  /** The identity factors (identity.yaml): a slot marked to be summarized may be none of them. */
  factors?: readonly string[];
  /** Each slot's type, redact setting and, for a choice, its options as said: what a to-caller span's `names` are held to. Absent, they are held to the line's variables alone. */
  slotSpecs?: Readonly<Record<string, SlotFacts>>;
}): WordingProblem[] {
  const out: WordingProblem[] = [];
  const file = 'prompts.yaml';
  const summarizedSet = summarizedVarsFrom(Object.fromEntries((input.summarized ?? []).map((id) => [id, { summarized: true as const }])), input.factors ?? []);
  const generated = generatedWordingOf({ ...input, style: null })?.lines ?? {};
  // A slot marked to be summarized though masked in the records: never an identity factor, and only
  // where a framed line's span summarizes it; else plain redact applies. A line generated whole from it
  // is refused: what a model wrote of it would be the line itself, said, sent and recorded as such.
  for (const slot of input.summarized ?? []) {
    const at = [slot, 'redact'];
    if ((input.factors ?? []).includes(slot)) {
      out.push({ file: 'slots.yaml', path: at, message: `the slot "${slot}" is an identity factor, and "redact: length-summarized" would send it whole to a model; an identity factor is never sent to one`, fix: 'set redact: length' });
      continue;
    }
    const summarizing = Object.entries(generated).filter(([, l]) => l.spans !== undefined && summarizedFrom(l).includes(slot)).map(([id]) => id);
    if (summarizing.length === 0) out.push({ file: 'slots.yaml', path: at, message: `the slot "${slot}" says "redact: length-summarized", but no framed line's span summarizes it, so nothing would be sent to a model and the setting only names an exception it does not use`, fix: 'set redact: length (masked the same way), or word a framed span from it (generate: { <span>: { from: ' + slot + ', goal: ... } })' });
  }
  for (const [id, p] of Object.entries(input.prompts)) {
    const at = (key: string): (string | number)[] => ['prompts', id, key];
    if (p.prescribed === true && p.mode === 'generative') {
      out.push({ file, path: at('mode'), message: `the line "${id}" is prescribed (prescribed: true), so it is always said word for word and never generated`, fix: 'delete "mode: generative", or delete "prescribed: true" if a model may word this line' });
      continue;
    }
    if (p.exactText !== undefined && (p.generate === undefined || p.prescribed === true)) {
      out.push({ file, path: at('exactText'), message: `the line "${id}" is not framed (no generate${p.prescribed === true ? ', and it is prescribed' : ''}), so it has no span that is said word for word, and "exactText" (a framed line's frame for its exact words) does not apply to it`, fix: p.prescribed === true ? 'delete "exactText": a prescribed line is said as its text, always' : 'delete "exactText", or frame the line (generate) so a span of it is worded by a model', atKey: true });
    }
    if (p.generate !== undefined) {
      out.push(...framedProblems(id, p, { ...input, summarized: summarizedSet }));
      continue;
    }
    if (p.mode === 'generative' && p.goal === undefined) {
      out.push({ file, path: ['prompts', id], message: `the line "${id}" is generated (mode: generative) but has no goal, so the model would not know what the line is for`, fix: `add "goal:" saying what the line must do, for example "Ask for the caller's name; briefly acknowledge what they just said."`, atKey: true });
    }
    const isGenerated = Object.hasOwn(generated, id);
    if (p.mode === 'generative' && saysKbAnswer(p.text)) {
      out.push({ file, path: at('mode'), message: `the line "${id}" says a knowledge base's answer ({answer}), which is an approved passage said word for word, never generated`, fix: 'delete "mode: generative"; generate the lines around the answer instead' });
    }
    if (p.mode === 'generative') {
      const whole = (p.from ?? []).filter((v) => summarizedSet.has(v));
      if (whole.length > 0) out.push({ file, path: at('from'), message: `the line "${id}" is generated whole from ${whole.map((v) => `{${v}}`).join(', ')} (redact: length-summarized), which only a framed line's span may summarize: a line generated whole from it would carry what a model wrote of it in the line itself, said, sent and recorded as the line`, fix: `frame the line: keep it fixed with a span for the summary (generate: { summary: { from: ${whole[0]}, goal: ... } })` });
      const ids = identifierVarsOf(p.text, input.identifierVars).filter((v) => !whole.includes(v));
      if (ids.length > 0) out.push({ file, path: at('mode'), message: `the line "${id}" is generated, but it names ${ids.map((v) => `{${v}}`).join(', ')}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a generated line is never sent an identifier`, fix: 'delete "mode: generative" (the line is said word for word), or say the identifier in a fixed line of its own' });
    }
    if (!isGenerated) {
      for (const key of ['goal', 'when', 'from', 'summarizesConfirmed', 'acknowledge'] as const) {
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
  // A generated line that may summarize a value a confirmed rule holds the caller to: the app says it accepts that.
  const ids = Object.keys(input.prompts);
  for (const [id, p] of Object.entries(input.prompts)) {
    if (!Object.hasOwn(generated, id)) continue;
    const covered = new Set<string>();
    const from = summarizedFrom(generated[id]!);
    for (const def of Object.values(input.forms)) {
      if (!formLineIds(ids, def.slots, def.summaryPromptId).includes(id)) continue;
      for (const tool of def.calls ?? []) for (const f of input.confirmed?.[tool] ?? []) if (from.includes(f)) covered.add(f);
    }
    if (covered.size > 0 && p.summarizesConfirmed !== true) {
      out.push({ file, path: ['prompts', id, p.generate !== undefined ? 'generate' : 'from'], message: `the line "${id}" may summarize ${[...covered].map((v) => `{${v}}`).join(', ')}, which a confirmed rule holds the caller to confirming exactly, so the caller would confirm a value they heard summarized`, fix: p.generate !== undefined ? 'add "summarizesConfirmed: true" to accept it (the value confirmed and sent is still the one kept, and the policy card says so), or let the line say the value whole in its fixed text instead of a span' : 'add "summarizesConfirmed: true" to accept it (the value confirmed and sent is still the one kept, and the policy card says so), or take the variable out of "from" so the line says it whole' });
    }
    if (covered.size === 0 && p.summarizesConfirmed === true) {
      out.push({ file, path: ['prompts', id, 'summarizesConfirmed'], message: `the line "${id}" summarizes no value a confirmed rule covers, so "summarizesConfirmed" does nothing`, fix: 'delete "summarizesConfirmed"', atKey: true });
    }
  }
  for (const [form, def] of Object.entries(input.forms)) {
    if (def.wording !== 'generative') continue;
    const any = Object.values(generated).some((l) => l.by !== 'prompt' && l.by.form === form);
    if (!any) out.push({ file: 'forms.yaml', path: ['forms', form, 'wording'], message: `the form "${form}" says wording: generative, but none of its lines is generated (each is mode: fixed, prescribed, names an identifier, or is not in prompts.yaml)`, fix: 'delete "wording: generative", or let one of its lines be generated' });
  }
  // A form's acknowledge is for the lines its switch generates: without the switch it does nothing.
  for (const [form, def] of Object.entries(input.forms)) {
    if (def.acknowledge !== undefined && def.wording !== 'generative') out.push({ file: 'forms.yaml', path: ['forms', form, 'acknowledge'], message: `the form "${form}" does not generate its lines (no wording: generative), so its "acknowledge" does nothing`, fix: 'add "wording: generative" to generate them, or delete "acknowledge" (a line generated by its own mode: generative takes its own "acknowledge" in prompts.yaml)', atKey: true });
  }
  for (const [locale, prompts] of Object.entries(input.localePrompts)) {
    const dir = `locale/${locale}/prompts.yaml`;
    for (const [id, p] of Object.entries(prompts)) {
      for (const key of ['mode', 'prescribed', 'when', 'from', 'summarizesConfirmed', 'acknowledge'] as const) {
        if (p[key] !== undefined) out.push({ file: dir, path: ['prompts', id, key], message: `"${key}" is read from prompts.yaml, for every locale; a locale gives a generated line only its goal`, fix: `move "${key}" to the line in prompts.yaml, or delete it here`, atKey: true });
      }
      const spans = Object.hasOwn(generated, id) ? generated[id]!.spans : undefined;
      if (p.goal !== undefined && (!Object.hasOwn(generated, id) || spans !== undefined)) {
        out.push(spans !== undefined
          ? { file: dir, path: ['prompts', id, 'goal'], message: `the line "${id}" is framed in prompts.yaml (generate): only its spans are generated, so a goal of the whole line does nothing`, fix: 'give each span its goal here under "generate", or delete "goal"', atKey: true }
          : { file: dir, path: ['prompts', id, 'goal'], message: `the line "${id}" is not generated in prompts.yaml, so its goal here does nothing`, fix: 'generate it in prompts.yaml (mode: generative), or delete "goal"', atKey: true });
      }
      // A framed line in a locale: its text says every span prompts.yaml frames, and gives each span at most its goal.
      if (spans !== undefined) {
        if (p.text.includes(SPAN_GAP)) out.push({ file: dir, path: ['prompts', id, 'text'], message: `the line "${id}" is framed (generate), and its text has "${SPAN_GAP}", which marks a span's place in the sentence its model is shown, so the model could not tell its own gap from the line's words`, fix: 'write it some other way (a dash, or words)' });
        const vars = lineVars(p.text);
        for (const name of Object.keys(spans)) {
          if (!vars.includes(name)) out.push({ file: dir, path: ['prompts', id, 'text'], message: `the line "${id}" is framed in prompts.yaml with a generated span {${name}}, which this locale's text does not say, so the content it gives would never be heard in this locale`, fix: `say {${name}} in this locale's text, where the content belongs` });
        }
      }
      // A frame for the exact words (exactText): a locale mirrors prompts.yaml, each with its own.
      const exactInDefault = input.prompts[id]?.exactText !== undefined;
      if (spans !== undefined && exactInDefault && p.exactText === undefined) {
        out.push({ file: dir, path: ['prompts', id], message: `prompts.yaml gives the line "${id}" a frame of its own for the exact words (exactText), and this locale gives none, so its text would be said with the exact words too`, fix: 'add "exactText:" here, this locale\'s frame for the content word for word, with the same variables as its text', atKey: true });
      }
      if (p.exactText !== undefined && (spans === undefined || !exactInDefault)) {
        out.push({ file: dir, path: ['prompts', id, 'exactText'], message: spans === undefined ? `the line "${id}" is not framed in prompts.yaml, so a frame for its exact words does nothing` : `prompts.yaml gives the line "${id}" no frame of its own for the exact words (exactText), so a locale's own does not apply: a locale mirrors prompts.yaml`, fix: spans === undefined ? 'delete "exactText" here' : 'add "exactText:" to the line in prompts.yaml too, or delete it here', atKey: true });
      } else if (p.exactText !== undefined) {
        const problem = sameVariables(p.text, p.exactText);
        if (problem !== null) out.push({ file: dir, path: ['prompts', id, 'exactText'], message: `the line "${id}"'s frame for the exact words ${problem} this locale's text (${lineVars(p.text).map((x) => `{${x}}`).join(', ')}), so the two would not say the same values`, fix: 'name exactly the variables this locale\'s text names' });
      }
      for (const [name, sp] of Object.entries(p.generate ?? {})) {
        if (spans === undefined || !Object.hasOwn(spans, name)) {
          out.push({ file: dir, path: ['prompts', id, 'generate', name], message: spans === undefined ? `the line "${id}" is not framed in prompts.yaml, so a span here does nothing` : `prompts.yaml frames no span {${name}} in the line "${id}" (it frames ${Object.keys(spans).map((v) => `{${v}}`).join(', ')}), so this one does nothing`, fix: spans === undefined ? 'frame the line in prompts.yaml (generate), or delete it here' : `rename it to one of the spans prompts.yaml frames, or delete it here`, atKey: true });
          continue;
        }
        for (const key of ['from', 'words', 'speaks', 'names'] as const) {
          if (sp[key] !== undefined) out.push({ file: dir, path: ['prompts', id, 'generate', name, key], message: `a span's "${key}" is read from prompts.yaml, for every locale; a locale gives a span only its goal`, fix: `move "${key}" to the span in prompts.yaml, or delete it here`, atKey: true });
        }
      }
    }
  }
  return out;
}

/** Whether a frame for the exact words names other variables than its line's text: the two lists in words, or null when they name the same. */
function sameVariables(text: string, exactText: string): string | null {
  const a = lineVars(text);
  const b = lineVars(exactText);
  if (a.length === b.length && a.every((v) => b.includes(v))) return null;
  const list = (xs: string[]): string => (xs.length === 0 ? 'none' : xs.map((v) => `{${v}}`).join(', '));
  return `names ${list(b)}, not the variables of`;
}

/** The content a generated line may summarize: its own `from`, or its spans' `from`. */
export function summarizedFrom(line: GeneratedLine): string[] {
  return line.spans !== undefined ? [...new Set(Object.values(line.spans).map((s) => s.from))] : [...(line.from ?? [])];
}

/**
 * A framed line's problems (prompts.yaml's `generate`): never prescribed, never with a mode of its own,
 * a goal or a `from` of the whole line; each span one of its text's variables and none of the app's
 * slots (a span is worded, not collected), worded from a slot (`from`) that is no identifier.
 */
/** What `pnpm check` reads of a slot for a to-caller span's `names`: its type, its redact setting, and a choice's options as said. */
export interface SlotFacts {
  readonly type?: unknown;
  readonly redact?: string;
  readonly said?: readonly string[];
}

/**
 * A to-caller span's `names` (who the message is for): only on a span that speaks to the caller; each
 * one of the line's variables, not a span, a `choice` slot (never a `name` slot: the caller's own name is
 * never put for a pronoun), no identity factor, no redact setting, and no option said with a digit.
 */
function spanNamesProblems(id: string, name: string, sp: NonNullable<PromptYaml['generate']>[string], vars: readonly string[], spans: readonly string[], input: { identifierVars: ReadonlySet<string>; factors?: readonly string[]; slotSpecs?: Readonly<Record<string, SlotFacts>> }): WordingProblem[] {
  const out: WordingProblem[] = [];
  if (sp.names === undefined) return out;
  const at = ['prompts', id, 'generate', name, 'names'];
  if (sp.speaks !== 'to-caller') {
    out.push({ file: 'prompts.yaml', path: at, message: `the span "${name}" lists names, which only a span that speaks to the caller (speaks: to-caller) may say for a pronoun, so they do nothing`, fix: 'add "speaks: to-caller" to the span, or delete "names"', atKey: true });
    return out;
  }
  sp.names.forEach((v, i) => {
    const here = [...at, i];
    const spec = input.slotSpecs?.[v];
    if (!vars.includes(v) || spans.includes(v)) out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is not ${spans.includes(v) ? 'a value' : 'a variable'} of the line "${id}", so the span has no name of it to say`, fix: `name a variable of the line's frame that holds who the message is for (${vars.filter((x) => !spans.includes(x)).map((x) => `{${x}}`).join(', ') || 'it has none'})` });
    else if ((input.factors ?? []).includes(v)) out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is an identity factor, which is never sent to a model`, fix: `delete "${v}" from names` });
    else if (input.slotSpecs !== undefined && spec === undefined) out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is not a slot, so nothing holds what it may say: a span's names are choice slots (who the message is for)`, fix: `delete "${v}" from names, or name a choice slot of the line` });
    else if (spec?.type === 'name') out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is a name slot (a name the caller gave, such as their own), and the caller's own name is never put in place of a pronoun of their message`, fix: `delete "${v}" from names; list only who the message is for (a choice slot, such as {recipient})` });
    else if (spec !== undefined && spec.type !== 'choice') out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is a ${String(spec.type ?? 'code')} slot; a span's names are choice slots, whose values the app wrote (who the message is for)`, fix: `delete "${v}" from names` });
    else if (spec?.redact !== undefined || input.identifierVars.has(v)) out.push({ file: 'prompts.yaml', path: here, message: `{${v}} is masked in the records (redact: ${spec?.redact ?? 'mask'}), and a model is never sent a value the records hide`, fix: `delete "${v}" from names` });
    else if ((spec?.said ?? []).some((x) => /\d/.test(x))) out.push({ file: 'prompts.yaml', path: here, message: `{${v}}'s options say a digit (${(spec?.said ?? []).filter((x) => /\d/.test(x)).join(', ')}), which is no name`, fix: `delete "${v}" from names` });
  });
  return out;
}

/**
 * A span that words a knowledge base's answer (`from: answer`): only on a form's answer line (forms.yaml's
 * `answers.answer`, default `kb_answer`), and only as the line's {answer} itself (the approved passage is
 * what it is worded from, and what fills it word for word); never with `speaks` or `names`, which are for a
 * caller's message.
 */
function answerSpanProblems(id: string, name: string, sp: NonNullable<PromptYaml['generate']>[string], vars: readonly string[], answerLines: ReadonlySet<string>, documentLines: ReadonlySet<string> = new Set()): WordingProblem[] {
  const out: WordingProblem[] = [];
  const at = ['prompts', id, 'generate', name];
  if (sp.from === KB_SECTIONS_SOURCE) {
    if (!documentLines.has(id)) out.push({ file: 'prompts.yaml', path: [...at, 'from'], message: `the span "${name}" is worded from sections of documents (from: sections), but "${id}" is no form's documents answer line (forms.yaml's answers.documents.answer, default kb_documents_answer)`, fix: `delete the span, or frame the line a form's answer from documents is said through${documentLines.size > 0 ? ` (${[...documentLines].map((x) => `"${x}"`).join(', ')})` : ''}` });
    else if (name !== KB_ANSWER_LINE_VAR) out.push({ file: 'prompts.yaml', path: at, message: `the span "${name}" is worded from sections (from: sections), but an answer from documents is the line's {${KB_ANSWER_LINE_VAR}} itself, which says the fallback (onFail) whenever it is not worded`, fix: `name the span "${KB_ANSWER_LINE_VAR}" (generate: { ${KB_ANSWER_LINE_VAR}: { from: ${KB_SECTIONS_SOURCE}, goal: ... } }), with {${KB_ANSWER_LINE_VAR}} in the line's text`, atKey: true });
    else if (!vars.includes(name)) out.push({ file: 'prompts.yaml', path: at, message: `the line "${id}" has no {${KB_ANSWER_LINE_VAR}}, so its answer would never be said`, fix: `add {${KB_ANSWER_LINE_VAR}} to the line's text where the answer goes`, atKey: true });
    for (const key of ['speaks', 'names'] as const) {
      if (sp[key] !== undefined) out.push({ file: 'prompts.yaml', path: [...at, key], message: `the span "${name}" words an answer from documents (from: sections), so "${key}", which is for a caller's message read back, does not apply`, fix: `delete "${key}"`, atKey: true });
    }
    return out;
  }
  if (!answerLines.has(id)) {
    out.push({ file: 'prompts.yaml', path: [...at, 'from'], message: `the span "${name}" is worded from the answer (from: answer), but "${id}" is no form's answer line (forms.yaml's answers.answer, default kb_answer), so it has no approved passage to word`, fix: `delete the span, or frame the line a form's knowledge answer is said through (${answerLines.size > 0 ? [...answerLines].map((x) => `"${x}"`).join(', ') : 'no form answers from the knowledge base'})` });
    return out;
  }
  if (name !== KB_ANSWER_LINE_VAR) {
    out.push({ file: 'prompts.yaml', path: at, message: `the span "${name}" is worded from the answer (from: answer), but a knowledge answer's span is the line's {${KB_ANSWER_LINE_VAR}} itself, which the approved passage fills word for word whenever it is not worded`, fix: `name the span "${KB_ANSWER_LINE_VAR}" (generate: { ${KB_ANSWER_LINE_VAR}: { from: ${KB_ANSWER_SOURCE}, goal: ... } }), with {${KB_ANSWER_LINE_VAR}} in the line's text`, atKey: true });
  } else if (!vars.includes(name)) {
    out.push({ file: 'prompts.yaml', path: at, message: `the line "${id}" has no {${KB_ANSWER_LINE_VAR}}, so its answer would never be said`, fix: `add {${KB_ANSWER_LINE_VAR}} to the line's text where the answer goes`, atKey: true });
  }
  for (const key of ['speaks', 'names'] as const) {
    if (sp[key] !== undefined) out.push({ file: 'prompts.yaml', path: [...at, key], message: `the span "${name}" words a knowledge answer (from: answer), so "${key}", which is for a caller's message read back, does not apply`, fix: `delete "${key}"`, atKey: true });
  }
  return out;
}

function framedProblems(id: string, p: PromptYaml, input: { prompts: Readonly<Record<string, PromptYaml>>; forms: FormsYaml['forms']; identifierVars: ReadonlySet<string>; slots?: readonly string[]; summarized: ReadonlySet<string>; factors?: readonly string[]; slotSpecs?: Readonly<Record<string, SlotFacts>> }): WordingProblem[] {
  const out: WordingProblem[] = [];
  const file = 'prompts.yaml';
  const at = (...key: (string | number)[]): (string | number)[] => ['prompts', id, ...key];
  if (p.prescribed === true) {
    out.push({ file, path: at('generate'), message: `the line "${id}" is prescribed (prescribed: true), so it is always said word for word and no span of it is generated`, fix: 'delete "generate" (each span is then said as its content, word for word: write the content\'s variable in the text instead), or delete "prescribed: true"', atKey: true });
    return out;
  }
  if (p.mode !== undefined) out.push({ file, path: at('mode'), message: `the line "${id}" is framed (generate): only its spans are generated and every other word is fixed, so "mode: ${p.mode}" does not apply`, fix: p.mode === 'generative' ? 'delete "mode" to keep the frame fixed, or delete "generate" to generate the whole line' : 'delete "mode", or delete "generate" to say the line word for word', atKey: true });
  if (p.goal !== undefined) out.push({ file, path: at('goal'), message: `the line "${id}" is framed (generate): each span has its own goal, so a goal of the whole line does nothing`, fix: 'move what it says into the goal of a span under "generate", or delete it', atKey: true });
  if (p.from !== undefined) out.push({ file, path: at('from'), message: `the line "${id}" is framed (generate): each span names the content it is worded from in its own "from"`, fix: 'delete "from" here, and name the content in the span\'s "from"', atKey: true });
  if (p.acknowledge !== undefined) out.push({ file, path: at('acknowledge'), message: `the line "${id}" is framed (generate): only its spans are generated, and a span never acknowledges the caller, so "acknowledge" does nothing`, fix: 'delete "acknowledge"; the frame\'s fixed words are said as written', atKey: true });
  // The span's place in the sentence a model is shown (SPAN_GAP): the line's own text may not hold it.
  if (p.text.includes(SPAN_GAP)) out.push({ file, path: at('text'), message: `the line "${id}" is framed (generate), and its text has "${SPAN_GAP}", which marks a span's place in the sentence its model is shown, so the model could not tell its own gap from the line's words`, fix: `write it some other way (a dash, or words)` });
  const vars = lineVars(p.text);
  if (p.exactText !== undefined) {
    const problem = sameVariables(p.text, p.exactText);
    if (problem !== null) out.push({ file, path: at('exactText'), message: `the line "${id}"'s frame for the exact words (exactText) ${problem} its text (${vars.map((x) => `{${x}}`).join(', ')}), so the two would not say the same values`, fix: 'name exactly the variables the text names, each span among them' });
  }
  const slots = input.slots === undefined ? undefined : new Set(input.slots);
  const names = Object.keys(p.generate ?? {});
  // The lines a form's knowledge answer is said through: the only lines a span may word an answer on.
  const answerLines = new Set(Object.values(input.forms).flatMap((def) => (def.answers !== undefined ? [formAnswerLine(def.answers)] : [])));
  const documentLines = new Set(Object.values(input.forms).flatMap((def) => (def.answers !== undefined ? [formDocumentsLine(def.answers)] : [])));
  for (const [name, sp] of Object.entries(p.generate ?? {})) {
    if (sp.from === KB_ANSWER_SOURCE || sp.from === KB_SECTIONS_SOURCE) {
      out.push(...answerSpanProblems(id, name, sp, vars, answerLines, documentLines));
      continue;
    }
    out.push(...spanNamesProblems(id, name, sp, vars, names, input));
    if (!vars.includes(name)) out.push({ file, path: at('generate', name), message: `the line "${id}" has no {${name}}, so the span "${name}" would never be said`, fix: `name one of the line's own variables (${vars.length > 0 ? vars.map((x) => `{${x}}`).join(', ') : 'it has none'}), or add {${name}} to its text where the span goes`, atKey: true });
    else if (slots?.has(name) === true) out.push({ file, path: at('generate', name), message: `{${name}} is a slot, the value the call collected, so it cannot also be a span the model words`, fix: `give the span a name of its own ({summary}, say), write it in the text, and say "from: ${name}"`, atKey: true });
    if (sp.from === undefined) {
      out.push({ file, path: at('generate', name), message: `the span "${name}" of the line "${id}" names no content to be worded from, so it would have nothing to summarize and nothing to say when it is not generated`, fix: 'add "from:" naming the slot it summarizes (the message, the note)', atKey: true });
      continue;
    }
    if (names.includes(sp.from)) out.push({ file, path: at('generate', name, 'from'), message: `the span "${name}" is worded from {${sp.from}}, another span of the line, which is worded, never collected`, fix: 'name the slot the span summarizes' });
    else if (slots !== undefined && !slots.has(sp.from)) out.push({ file, path: at('generate', name, 'from'), message: `the span "${name}" is worded from "${sp.from}", which is not a slot, so there is no content for it`, fix: `name one of the app's slots${input.slots!.length > 0 ? ` (${input.slots!.slice(0, 8).map((x) => `"${x}"`).join(', ')}${input.slots!.length > 8 ? ', ...' : ''})` : ''}: the content the call collected` });
    else if (input.identifierVars.has(sp.from) && !input.summarized.has(sp.from)) out.push({ file, path: at('generate', name, 'from'), message: `the span "${name}" is worded from {${sp.from}}, which holds an identifier (an identity factor, or a slot hidden whole in the records); a model is never sent an identifier`, fix: `delete the span and say {${sp.from}} in the fixed text, or word the span from other content; for a text slot whose words a model may summarize though the records mask them, redact: length-summarized` });
    else {
      // A line of a form is given its form's slots: a span worded from another is worded from nothing.
      const ids = Object.keys(input.prompts);
      for (const [form, def] of Object.entries(input.forms)) {
        if (formLineIds(ids, def.slots, def.summaryPromptId).includes(id) && !def.slots.includes(sp.from)) {
          out.push({ file, path: at('generate', name, 'from'), message: `the span "${name}" is worded from "${sp.from}", which the form "${form}" does not ask, so the line is never given it`, fix: `name one of the form's slots (${def.slots.map((x) => `"${x}"`).join(', ')}), or add "${sp.from}" to the form` });
        }
      }
    }
  }
  return out;
}

/** A warning about an app's generated wording: the app's choice, never a refusal (`pnpm check` prints it). */
export type WordingWarning = WordingProblem;

/**
 * Whether a frame gives its span as the caller's words in the third person, in the sentence before the
 * span, where a span that speaks to the caller ("you need...") reads wrong: it says the caller "said",
 * "says" or "told" it, it "left" a message, someone "wants" someone "to know", or it names the caller (a
 * `name` slot of `nameSlots`, "{caller} ... {summary}"). What it found, or null. A cheap reading of the
 * frame's words, English only.
 */
export function thirdPersonFrame(text: string, span: string, nameSlots: ReadonlySet<string> = new Set()): string | null {
  const at = text.indexOf(`{${span}}`);
  if (at === -1) return null;
  const sentence = text.slice(0, at).split(/[.!?](?:\s|$)/).at(-1) ?? '';
  const said = sentence.match(/\b(?:said|says|saying|told|tells)\b/i);
  if (said !== null) return `says they "${said[0]}" it`;
  if (/\bleft\b.*\bmessage\b/i.test(sentence)) return 'says they "left" a message';
  if (/\bwants?\b.*\bto know\b/i.test(sentence)) return 'says who "wants" someone "to know"';
  const named = [...sentence.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).find((v) => nameSlots.has(v));
  return named !== undefined ? `names the caller in the third person ({${named}})` : null;
}

/**
 * What `pnpm check` warns of in generated wording, never refusing it: a line generated whole from what
 * the caller said (its `from`), where a framed line (a fixed frame that says whose words they are, and a
 * generated span inside it) makes the attribution by design rather than by the checks; and a span that
 * speaks to the caller (`speaks: to-caller`) after a frame that says the caller "said" it, or in a
 * language other than English, where it is worded in the caller's own terms.
 */
export function generatedWordingWarnings(input: {
  prompts: Readonly<Record<string, PromptYaml>>;
  forms: FormsYaml['forms'];
  localePrompts: Readonly<Record<string, Readonly<Record<string, PromptYaml>>>>;
  /** Each slot the records keep masked, by its redact setting: a span worded from one sends the value whole. */
  redacted?: Readonly<Record<string, string>>;
  /** The slots marked to be summarized (SlotSpec.summarized): the app said so, so no warning. */
  summarized?: ReadonlySet<string>;
  /** prompts.yaml's locale (app.yaml's locales.default): a span that speaks to the caller does so in English only. */
  defaultLocale?: string;
  /** The `name` slots: a frame that names one before a to-caller span gives the caller's words in the third person. */
  nameSlots?: ReadonlySet<string>;
  /** style.yaml: a judge cutoff above the default is less cautious, the app's choice, warned of. */
  style?: StyleYaml | null;
  /** kb/topics.yaml's topics, by id, with their risk: an answer line that words its answer where no topic is `risk: low` words nothing. */
  kbTopics?: Readonly<Record<string, { readonly risk: 'regulated' | 'low' }>>;
}): WordingWarning[] {
  const generated = generatedWordingOf({ ...input, style: null })?.lines ?? {};
  const out: WordingWarning[] = [];
  // An answer line that words its answer (from: answer) is worded only on a topic marked risk: low.
  const low = Object.values(input.kbTopics ?? {}).filter((t) => t.risk === 'low').length;
  // A hold line in each language an answer is worded in: the app's kb_hold, or the engine's words in English only.
  for (const [id, line] of Object.entries(generated)) {
    const answer = answerSpanOf(line);
    if (answer === null) continue;
    const held = Object.hasOwn(input.prompts, 'kb_hold');
    if (!held && !speaksToCallerIn(input.defaultLocale)) out.push({ file: 'prompts.yaml', path: ['prompts', id, 'generate', answer.name], message: `the line "${id}" words its answer, and prompts.yaml (${input.defaultLocale}) has no kb_hold, whose words the engine has in English only: no hold line is said while a slow wording is finished, and the answer has only a line's budget`, fix: 'add "kb_hold:" to prompts.yaml, such as "One moment while I gather that information." in the app\'s language, with interruptible: false', atKey: true });
    for (const [locale, prompts] of Object.entries(input.localePrompts)) {
      if (prompts[id]?.generate?.[answer.name] === undefined || Object.hasOwn(prompts, 'kb_hold')) continue;
      out.push({ file: `locale/${locale}/prompts.yaml`, path: ['prompts', id, 'generate', answer.name], message: `the line "${id}" words its answer in ${locale}, which has no kb_hold of its own: no hold line is said there while a slow wording is finished, and the answer has only a line's budget`, fix: `add "kb_hold:" to locale/${locale}/prompts.yaml, in ${locale}, with interruptible: false`, atKey: true });
    }
  }
  for (const [id, line] of Object.entries(generated)) {
    const answer = answerSpanOf(line);
    // An answer from documents' sections (from: sections) is worded whatever the topics' risk.
    if (answer === null || low > 0 || isSectionsSpan(answer.span)) continue;
    out.push({ file: 'prompts.yaml', path: ['prompts', id, 'generate', answer.name, 'from'], message: `the line "${id}" words its answer from the approved passage (from: answer), but ${input.kbTopics === undefined ? 'the app has no knowledge base (kb/topics.yaml)' : 'no topic in kb/topics.yaml is marked risk: low'}, so every answer is said word for word and the span words nothing`, fix: 'mark the topics whose answers may be worded "risk: low" in kb/topics.yaml (the app designer\'s call), or delete the span', atKey: true });
  }
  const documentsRefuseAt = input.style?.judge?.documentsRefuseAt;
  if (documentsRefuseAt !== undefined && documentsRefuseAt > DRIFT_FIRE) {
    out.push({ file: 'style.yaml', path: ['judge', 'documentsRefuseAt'], message: `judge.documentsRefuseAt is ${documentsRefuseAt}, less cautious than the default (${DRIFT_FIRE}): the documents drift judge lets by an answer from documents it holds up to ${Math.round(documentsRefuseAt * 100)}% likely to be unfaithful (the app's choice; the policy card says so)`, fix: `lower it to ${DRIFT_FIRE} or below, or keep it if that is the owner's choice` });
  }
  const documentsDriftAloneAt = input.style?.judge?.documentsDriftAloneAt;
  if (documentsDriftAloneAt !== undefined && documentsDriftAloneAt > DRIFT_ALONE_FIRE) {
    out.push({ file: 'style.yaml', path: ['judge', 'documentsDriftAloneAt'], message: `judge.documentsDriftAloneAt is ${documentsDriftAloneAt}, less cautious than the default (${DRIFT_ALONE_FIRE}): with documentsAsk both, the drift judge refuses on its own only an answer it holds ${Math.round(documentsDriftAloneAt * 100)}% likely to be unfaithful (the app's choice)`, fix: `lower it to ${DRIFT_ALONE_FIRE} or below, or keep it if that is the owner's choice` });
  }
  const documentsAddedAt = input.style?.judge?.documentsAddedAt;
  if (documentsAddedAt !== undefined && documentsAddedAt > ADDED_FIRE) {
    out.push({ file: 'style.yaml', path: ['judge', 'documentsAddedAt'], message: `judge.documentsAddedAt is ${documentsAddedAt}, less cautious than the default (${ADDED_FIRE}): the added reading lets by an answer from documents it holds up to ${Math.round(documentsAddedAt * 100)}% likely to add something of its own (the app's choice)`, fix: `lower it to ${ADDED_FIRE} or below, or keep it if that is the owner's choice` });
  }
  const refuseAt = input.style?.judge?.refuseAt;
  if (refuseAt !== undefined && refuseAt > DRIFT_FIRE) {
    out.push({ file: 'style.yaml', path: ['judge', 'refuseAt'], message: `judge.refuseAt is ${refuseAt}, less cautious than the default (${DRIFT_FIRE}): the drift judge lets by a wording it holds up to ${Math.round(refuseAt * 100)}% likely to be unfaithful, so more of what it doubts is said (the app's choice; the policy card says so)`, fix: `lower it to ${DRIFT_FIRE} or below, or keep it if that is the owner's choice` });
  }
  for (const [id, line] of Object.entries(generated)) {
    for (const [name, span] of Object.entries(line.spans ?? {})) {
      if (span.speaks !== 'to-caller') continue;
      const english = speaksToCallerIn(input.defaultLocale);
      const text = input.prompts[id]?.text ?? '';
      const third = english ? thirdPersonFrame(text, name, input.nameSlots) : null;
      if (third !== null) {
        out.push({ file: 'prompts.yaml', path: ['prompts', id, 'text'], message: `the span "${name}" speaks to the caller (speaks: to-caller: "you need..."), but the line's frame ${third} before it, so the two read wrong together ("...called and said, in short, you need...")`, fix: `word the frame to the caller ("{recipient} gets your message, in short: {${name}}"), or let the span speak in the caller's own terms (delete "speaks: to-caller")` });
      }
      if (input.prompts[id]?.exactText === undefined) {
        out.push({ file: 'prompts.yaml', path: ['prompts', id], message: `the span "${name}" speaks to the caller (speaks: to-caller), but the line has no frame of its own for the exact words, which are the caller's own, in the first person: its text is said with them too ("...in short, I just need him to...")`, fix: `add "exactText:" with a frame for the caller's own words ("... Here it is as you said it: {${name}}. ...")`, atKey: true });
      }
      if (!english) {
        out.push({ file: 'prompts.yaml', path: ['prompts', id, 'generate', name, 'speaks'], message: `the span "${name}" speaks to the caller (speaks: to-caller), which is English only for now, and prompts.yaml's locale is ${input.defaultLocale}: the span is worded in the caller's own terms there`, fix: 'word the frame for the caller\'s own terms ("{caller} left this message: {' + name + '}"), and delete "speaks: to-caller"', atKey: true });
      }
      for (const [locale, prompts] of Object.entries(input.localePrompts)) {
        const own = prompts[id];
        if (own?.generate?.[name] === undefined) continue;
        if (!speaksToCallerIn(locale)) {
          out.push({ file: `locale/${locale}/prompts.yaml`, path: ['prompts', id, 'generate', name], message: `the span "${name}" speaks to the caller in prompts.yaml (speaks: to-caller), which is English only for now: in ${locale} it is worded in the caller's own terms`, fix: `word this locale's frame for the caller's own terms ("... left this message: {${name}}"), or give the span no goal here, so it is said as the caller's exact words`, atKey: true });
        } else {
          const third = thirdPersonFrame(own.text, name, input.nameSlots);
          if (third !== null) out.push({ file: `locale/${locale}/prompts.yaml`, path: ['prompts', id, 'text'], message: `the span "${name}" speaks to the caller (speaks: to-caller), but this locale's frame ${third} before it, so the two read wrong together`, fix: `word the frame to the caller ("... gets your message, in short: {${name}}")` });
        }
      }
    }
    for (const [name, span] of Object.entries(line.spans ?? {})) {
      const redact = input.redacted?.[span.from];
      if (redact === undefined || input.summarized?.has(span.from) === true) continue;
      out.push({
        file: 'prompts.yaml',
        path: ['prompts', id, 'generate', name, 'from'],
        message: `the span "${name}" is worded from {${span.from}}, which the records keep ${redact === 'last4' ? 'by its last four' : 'masked'} (redact: ${redact}), and a model is sent it whole to word the span`,
        fix: `say {${span.from}} in the line's fixed text instead, or keep the span, as the app's choice (the policy card lists it as sent whole)`,
        atKey: true,
      });
    }
    if (line.spans !== undefined || (line.from ?? []).length === 0) continue;
    out.push({
      file: 'prompts.yaml',
      path: ['prompts', id, 'from'],
      message: `the line "${id}" is generated whole from what the caller said (${line.from!.map((v) => `{${v}}`).join(', ')}): whether the line says it as the caller's words, not the agent's own, rests on the checks and on a model's judgement`,
      fix: `frame it instead: keep the line fixed, saying whose words they are, with a generated span for the summary ("{caller} left this message: {summary}", and generate: { summary: { from: ${line.from![0]}, goal: ... } }); or keep it, as the app's choice`,
      atKey: true,
    });
  }
  // A form's acknowledge that reaches no line: every line it generates is generated by its own mode, or says its own acknowledge.
  for (const [form, def] of Object.entries(input.forms)) {
    if (def.acknowledge === undefined || def.wording !== 'generative') continue;
    const reached = Object.entries(generated).some(([id, l]) => l.by !== 'prompt' && l.by.form === form && input.prompts[id]?.acknowledge === undefined);
    if (!reached) out.push({ file: 'forms.yaml', path: ['forms', form, 'acknowledge'], message: `the form "${form}" says acknowledge: ${def.acknowledge}, but no line takes it: each line it generates is generated by its own mode: generative or says its own "acknowledge"`, fix: 'delete it here, or set "acknowledge" on the lines in prompts.yaml', atKey: true });
  }
  return out;
}

/**
 * The values a `confirmed` rule of `tool` holds the caller to that a generated read-back may summarize
 * rather than say whole: the `from` variables of a generated line of a form that calls `tool` (its
 * questions, read-backs or summary) among `fields`. The values confirmed and sent are still the ones
 * kept, word for word. Empty for every app that generates no such line.
 */
export function summarizedFields(app: { generated?: GeneratedWording; forms: Readonly<Record<string, { slots: readonly string[]; summaryPromptId: string | null; calls?: readonly string[] }>>; prompts: { manifest: Readonly<Record<string, unknown>> } }, tool: string, fields: readonly string[]): string[] {
  const lines = app.generated?.lines;
  if (lines === undefined) return [];
  const ids = Object.keys(app.prompts.manifest);
  const out = new Set<string>();
  for (const form of Object.values(app.forms)) {
    if (!(form.calls ?? []).includes(tool)) continue;
    for (const id of formLineIds(ids, form.slots, form.summaryPromptId)) {
      for (const v of lines[id] === undefined ? [] : summarizedFrom(lines[id]!)) if (fields.includes(v)) out.add(v);
    }
  }
  return fields.filter((f) => out.has(f));
}

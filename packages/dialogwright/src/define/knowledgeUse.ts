import { KB_ANSWER_PROMPT, KB_ANSWER_VAR, KB_UNAVAILABLE_PROMPT } from '../kb/answer';
import { approveCommandFor, STATUS_COMMAND, type Locate } from '../kb/rules';
import { VAR } from '../prompts/segments';
import type { LoadedConfig } from './load';
import { closest, formatPath, type DataPath, type Problem } from './problems';

/**
 * Where an app folder says answers from its knowledge base: a form's `answers:` (forms.yaml), whose
 * completion is the engine's (kb/answer.ts kbCompletion), and an informational intent's `passage:`
 * (intents.yaml). The rules that hold them to the rest of the folder:
 *
 *  - links (knowledgeUseProblems): an intent's passage is one the knowledge base has, in its default
 *    locale, and no passage of its topic applies to some callers only (an informational answer is
 *    for every caller, with no gate to read their facts); a form's topic slot is one of its slots;
 *    its action (`via`, else kb.yaml's) is a tool with an action in policy.yaml, and, where the
 *    form says which actions it calls, among them, with every account line's tool; the answer
 *    line says `{answer}` and nothing else, the unavailable line says no variable; and `answer` is
 *    one of app.yaml's prompts.dataVars (a line that carries a passage is spoken whole). defineApp
 *    runs these with the code (crossLink); `check` without it.
 *  - state (knowledgeUseStateProblems): an intent's passage is fresh (approved, nothing it was
 *    approved over changed). Only `check` runs it, beside the knowledge base's own state rules.
 *
 * The lines themselves (kb_answer and kb_unavailable, or a form's own) are references: crossLink
 * holds them to prompts.yaml, and `check` to every locale.
 */

/** The prompts a form that answers from the knowledge base says: its answer line and its unavailable line. */
export function answerPromptsOf(answers: { answer?: string | undefined; unavailable?: string | undefined }): { answer: string; unavailable: string } {
  return { answer: answers.answer ?? KB_ANSWER_PROMPT, unavailable: answers.unavailable ?? KB_UNAVAILABLE_PROMPT };
}

/** Whether the folder says any answer from its knowledge base (a form's answers or an intent's passage). */
export function saysKnowledge(config: LoadedConfig): boolean {
  return Object.values(config.forms.forms).some((f) => f.answers !== undefined) || Object.values(config.intents.intents).some((i) => i.passage !== undefined);
}

/** The lines the folder's knowledge answers are said through, each with where it is named: the references `check` holds to every locale. */
export function knowledgePromptReferences(config: LoadedConfig): { id: string; file: string; path: DataPath; role: 'answer' | 'unavailable' }[] {
  const refs: { id: string; file: string; path: DataPath; role: 'answer' | 'unavailable' }[] = [];
  for (const [id, form] of Object.entries(config.forms.forms)) {
    if (!form.answers) continue;
    const lines = answerPromptsOf(form.answers);
    refs.push({ id: lines.answer, file: 'forms.yaml', path: ['forms', id, 'answers', ...(form.answers.answer !== undefined ? ['answer'] : [])], role: 'answer' });
    refs.push({ id: lines.unavailable, file: 'forms.yaml', path: ['forms', id, 'answers', ...(form.answers.unavailable !== undefined ? ['unavailable'] : [])], role: 'unavailable' });
  }
  for (const [id, intent] of Object.entries(config.intents.intents)) {
    if (intent.passage === undefined) continue;
    refs.push({ id: KB_ANSWER_PROMPT, file: 'intents.yaml', path: ['intents', id, 'passage'], role: 'answer' });
    refs.push({ id: KB_UNAVAILABLE_PROMPT, file: 'intents.yaml', path: ['intents', id, 'passage'], role: 'unavailable' });
  }
  return refs;
}

const rename = (word: string, known: readonly string[]): string => {
  const near = closest(word, known);
  return near ? `rename it to "${near}", or ` : '';
};

/** What the links are checked against beyond the folder: the code's tools (left out: not checked), and how a fix names a place in the code. */
export interface KnowledgeUseInput {
  tools?: readonly string[];
  inCode?: (...segs: readonly string[]) => string;
}

/** The rules that hold a folder's knowledge answers to the rest of it (see above). */
export function knowledgeUseProblems(config: LoadedConfig, locate: Locate, input: KnowledgeUseInput = {}): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string, path: DataPath, message: string, fix: string): void => {
    const where = locate(file, path) ?? { line: 1, column: 1 };
    problems.push({ file, line: where.line, column: where.column, path: formatPath(path), message, fix });
  };
  const inCode = input.inCode ?? ((...segs: readonly string[]) => `the code (${['code', ...segs].join('.')})`);
  const kb = config.knowledge;
  const actions = Object.keys(config.policy.actions);
  const addKb = 'add the knowledge base (kb/kb.yaml, kb/topics.yaml, kb/passages/)';

  // intents.yaml: an informational intent's passage
  for (const [id, intent] of Object.entries(config.intents.intents)) {
    const passageId = intent.passage;
    if (passageId === undefined) continue;
    const path: DataPath = ['intents', id, 'passage'];
    if (!kb) {
      at('intents.yaml', path, `intent "${id}" says the passage "${passageId}", but the app has no knowledge base (kb/)`, `${addKb}, or play a prompt instead (promptId)`);
      continue;
    }
    const passage = Object.hasOwn(kb.passages, passageId) ? kb.passages[passageId]! : undefined;
    if (!passage) {
      const defaults = Object.values(kb.passages).filter((p) => p.locale.toLowerCase() === kb.defaultLocale.toLowerCase()).map((p) => p.id);
      at('intents.yaml', path, `intent "${id}" says the passage "${passageId}", which kb/passages does not have`, `${rename(passageId, defaults)}add kb/passages/${passageId}.yaml, then review and approve it`);
      continue;
    }
    if (passage.locale.toLowerCase() !== kb.defaultLocale.toLowerCase()) {
      at('intents.yaml', path, `intent "${id}" says the passage "${passageId}", which is in ${passage.locale}; an intent names the default locale's passage (${kb.defaultLocale}), and a call in another language hears its translation`, `name the passage it translates${passage.translates !== undefined ? ` ("${passage.translates}")` : ''}`);
      continue;
    }
    for (const p of Object.values(kb.passages)) {
      if (p.topic !== passage.topic || Object.keys(p.applies).length === 0) continue;
      const who = Object.entries(p.applies).map(([fact, values]) => `${fact} ${values.join(' or ')}`).join(', ');
      at(
        'intents.yaml',
        path,
        `intent "${id}" says the passage "${passageId}", whose topic "${passage.topic}" has a passage for some callers only ("${p.id}": ${who}); an informational intent's answer is for every caller, read with no gate`,
        `take the applies out of ${p.file}, or answer "${passage.topic}" through a form that answers from the knowledge base (forms.yaml answers:), whose gated read knows the caller`,
      );
    }
  }

  // forms.yaml: a form's knowledge answer
  for (const [id, form] of Object.entries(config.forms.forms)) {
    const answers = form.answers;
    if (!answers) continue;
    const base: DataPath = ['forms', id, 'answers'];
    if (!form.slots.includes(answers.slot)) {
      at('forms.yaml', [...base, 'slot'], `form "${id}" answers the topic in the slot "${answers.slot}", which is not one of its slots`, `${rename(answers.slot, form.slots)}add "${answers.slot}" to forms.${id}.slots (a topic slot in slots.yaml)`);
    }
    const via = answers.via ?? kb?.settings.action;
    if (via === undefined) {
      at('forms.yaml', base, `form "${id}" answers from the knowledge base, but names no action to read the answer through, and the app has no knowledge base whose action it could use`, `${addKb}, or add "via: <the gated tool that resolves the answer>"`);
      continue;
    }
    const viaPath: DataPath = answers.via !== undefined ? [...base, 'via'] : base;
    const where = answers.via !== undefined ? '' : ' (kb/kb.yaml\'s action)';
    if (!actions.includes(via)) {
      at('forms.yaml', viaPath, `form "${id}" reads its answer through "${via}"${where}, which has no action in policy.yaml: every read the knowledge base makes goes through the gate`, `${rename(via, actions)}add "${via}:" under actions in policy.yaml, with its level and rules`);
    }
    if (input.tools && !input.tools.includes(via)) {
      at('forms.yaml', viaPath, `form "${id}" reads its answer through "${via}"${where}, which is not a tool in the code`, `${rename(via, input.tools)}add it to ${inCode('tools', via)} (kbAnswerTool() resolves a passage of kb/)`);
    }
    if (form.calls !== undefined) {
      const lineTools = kb ? [...new Set(Object.values(kb.topics).flatMap((t) => (t.accountLine ? [t.accountLine.from] : [])))] : [];
      for (const tool of [via, ...lineTools.filter((t) => t !== via)]) {
        if (form.calls.includes(tool)) continue;
        const why = tool === via ? 'the action it reads its answer through' : 'an account line\'s tool (kb/topics.yaml)';
        at('forms.yaml', ['forms', id, 'calls'], `form "${id}" answers from the knowledge base, and its calls leave out "${tool}", ${why}`, `add "${tool}" to forms.${id}.calls`);
      }
    }
  }

  // The lines the answers are said through: the answer line says {answer} and nothing else, the unavailable line no variable.
  const refs = knowledgePromptReferences(config);
  const seen = new Set<string>();
  for (const ref of refs) {
    for (const [locale, prompts] of Object.entries(config.prompts)) {
      const key = `${ref.role}:${ref.id}:${locale}`;
      if (seen.has(key) || !Object.hasOwn(prompts, ref.id)) continue;
      seen.add(key);
      const file = locale === config.defaultLocale ? 'prompts.yaml' : `locale/${locale}/prompts.yaml`;
      const used = [...new Set([...prompts[ref.id]!.text.matchAll(VAR)].map((m) => m[1]!))];
      const line = locale === config.defaultLocale ? `the line "${ref.id}"` : `the ${locale} line "${ref.id}"`;
      if (ref.role === 'answer') {
        if (!used.includes(KB_ANSWER_VAR)) at(file, ['prompts', ref.id, 'text'], `${line} says an answer from the knowledge base, and its text has no {${KB_ANSWER_VAR}}, so the answer is never said`, `write {${KB_ANSWER_VAR}} where the answer goes ("{${KB_ANSWER_VAR}}" alone says it as it is)`);
        const extra = used.filter((name) => name !== KB_ANSWER_VAR);
        if (extra.length > 0) at(file, ['prompts', ref.id, 'text'], `${line} uses ${extra.map((n) => `{${n}}`).join(', ')}, which the knowledge answer does not give it (only {${KB_ANSWER_VAR}}), so saying it would fail`, `take ${extra.length === 1 ? 'it' : 'them'} out of the line`);
      } else if (used.length > 0) {
        at(file, ['prompts', ref.id, 'text'], `${line} is said when there is no answer from the knowledge base, and uses ${used.map((n) => `{${n}}`).join(', ')}, which nothing gives it, so saying it would fail`, 'write the line without variables');
      }
    }
  }

  // app.yaml: a line that carries a passage is spoken whole by text to speech, never stitched from clips.
  if (refs.length > 0 && !(config.app.prompts?.dataVars ?? []).includes(KB_ANSWER_VAR)) {
    const path: DataPath = config.app.prompts?.dataVars !== undefined ? ['prompts', 'dataVars'] : config.app.prompts !== undefined ? ['prompts'] : [];
    at('app.yaml', path, `the app says answers from the knowledge base in {${KB_ANSWER_VAR}}, which is not one of prompts.dataVars, so a line that says one could be split into recorded clips`, `add "${KB_ANSWER_VAR}" to prompts.dataVars in app.yaml`);
  }
  return problems;
}

/** The state rule for an informational intent's passage: it may be said today (approved, nothing it was approved over changed since). Only `check` runs it. */
export function knowledgeUseStateProblems(config: LoadedConfig, locate: Locate): Problem[] {
  const problems: Problem[] = [];
  const kb = config.knowledge;
  if (!kb) return problems;
  for (const [id, intent] of Object.entries(config.intents.intents)) {
    const passageId = intent.passage;
    if (passageId === undefined || !Object.hasOwn(kb.passages, passageId)) continue;
    const passage = kb.passages[passageId]!;
    if (passage.freshness === 'fresh') continue;
    const path: DataPath = ['intents', id, 'passage'];
    const where = locate('intents.yaml', path) ?? { line: 1, column: 1 };
    const why = passage.freshness === 'unapproved' ? 'is not approved' : passage.freshness === 'source-changed' ? 'is stale (its source changed since approval)' : 'was edited after approval';
    problems.push({
      file: 'intents.yaml', ...where, path: formatPath(path),
      message: `intent "${id}" says the passage "${passageId}", which ${why}, so the caller hears that there is no answer and is offered a person`,
      fix: `review ${passage.file} (${STATUS_COMMAND} shows what changed), then ${approveCommandFor(passageId)}`,
    });
  }
  return problems;
}

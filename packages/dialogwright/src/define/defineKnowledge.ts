import { dirname } from 'node:path';
import type { ToolName } from '../core/app/types';
import { kbLinkProblems, kbStateProblems } from '../kb/rules';
import type { KbKnowledge, Retriever } from '../kb/types';
import { AppDefinitionError, codePath } from './defineApp';
import { loadConfigFile, loadKnowledgeFolder, DEFAULT_LOCALE } from './load';
import { declaredFields } from './policyFile';
import type { Problem } from './problems';

/**
 * The knowledge base of an app that is not a folder (so there is no defineApp to read its kb/): the
 * same folder, the same rules, the same messages.
 *
 *   const knowledge = defineKnowledge('src/kb', { tools, policy: 'src/policy.yaml', locales: ['en-US', 'es'] });
 *   const app: App = { ..., knowledge };
 *
 * defineKnowledge throws an AppDefinitionError when the folder does not load, its content breaks a
 * rule (../kb/rules.ts kbContentProblems), or it names a tool, an action or a locale the app does not
 * have (kbLinkProblems; a part of the app left out of the options is not checked). It does not
 * refuse a passage that is unapproved or stale, or a topic with no passage in force today: those
 * change with review and with the date, and at run time such a passage is withheld. knowledgeProblems
 * reports them too, as `pnpm check` does for an app folder: run it in the app's tests or CI.
 */
export interface DefineKnowledgeOptions {
  /** The app's default locale (App.locales.default): kb/passages' and kb/topics.yaml's. Default en-US. */
  locale?: string;
  /** Every locale the app speaks, the default among them: a locale's passages must be in one. */
  locales?: readonly string[];
  /** The app's tools (App.tools): the action and each account line's tool must be one, and an account line's variables its declared fields. */
  tools?: Readonly<Record<ToolName, unknown>>;
  /** policy.yaml, its path or its content: the action and each account line's tool must have an action there. */
  policy?: string | Record<string, unknown>;
  /** A retriever of the app's own (App.knowledge.retriever). */
  retriever?: Retriever;
}

export interface KnowledgeProblemsOptions extends DefineKnowledgeOptions {
  /** The day a passage must be in force on, as an ISO date. Default: today (UTC). */
  todayIso?: string;
}

/** The problems with the knowledge base in `dir`, and the knowledge it makes when there are none of the kinds defineKnowledge refuses. */
function load(dir: string, options: KnowledgeProblemsOptions, state: boolean): { knowledge: KbKnowledge | null; problems: Problem[] } {
  const folder = loadKnowledgeFolder(dir, options.locale ?? DEFAULT_LOCALE);
  const problems: Problem[] = [...folder.problems];
  let actions: Set<string> | undefined;
  if (options.policy !== undefined) {
    const policy = loadConfigFile(options.policy, 'policy');
    problems.push(...policy.problems);
    if (policy.value) actions = new Set(Object.keys(policy.value.actions));
  }
  const kb = folder.kb;
  if (kb) {
    problems.push(
      ...kbLinkProblems(
        kb,
        {
          ...(actions ? { actions } : {}),
          ...(options.tools ? { tools: Object.fromEntries(Object.entries(options.tools).map(([tool, def]) => [tool, declaredFields(def)])) } : {}),
          ...(options.locales ? { locales: options.locales } : {}),
          ...(typeof options.policy === 'string' ? { policyFile: options.policy } : {}),
          inCode: (...segs) => codePath(...segs),
        },
        folder.locate,
        folder.base,
      ),
    );
    if (state) problems.push(...kbStateProblems(kb, options.todayIso ?? new Date().toISOString().slice(0, 10), folder.locate, folder.base));
  }
  // Files are named from the folder's parent; problems name them from where the caller is.
  const parent = dirname(dir);
  const shown = parent === '.' ? problems : problems.map((p) => (p.file.startsWith(`${folder.base}/`) || p.file === folder.base ? { ...p, file: `${parent}/${p.file}` } : p));
  const knowledge = kb && shown.length === 0 ? { kb, ...(options.retriever ? { retriever: options.retriever } : {}) } : null;
  return { knowledge, problems: shown };
}

/** The app's knowledge (App.knowledge) from the knowledge base folder `dir`, checked against the app's tools, policy and locales. */
export function defineKnowledge(dir: string, options: DefineKnowledgeOptions = {}): KbKnowledge {
  const { knowledge, problems } = load(dir, options, false);
  if (!knowledge) throw new AppDefinitionError(dir, problems, `the knowledge base in ${dir}`);
  return knowledge;
}

/** Every problem with the knowledge base folder `dir`: defineKnowledge's, and the approvals and the passages in force on `todayIso` that `pnpm check` reports. */
export function knowledgeProblems(dir: string, options: KnowledgeProblemsOptions = {}): Problem[] {
  return load(dir, options, true).problems;
}

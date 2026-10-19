import type { App } from './app/types';
import type { Action } from '../channel/actions';
import type { KbSource } from './lifecycle';
import { answerSourcesOf, KB_ANSWER_VAR } from '../kb/answer';
import { saidLineOf } from '../prompts/render';

/**
 * Where a knowledge answer comes from, shown under it on a chat (app.yaml's `chat.sources`): the turn's
 * knowledge record, when it says an answer may be said (fresh), names its document and sections
 * (answerSourcesOf), and each line of the turn that says the answer ({answer}) carries them. Only on a
 * channel that shows words; never spoken, and never on a line that says no answer (not found, unavailable).
 */
export function withSources(app: App, actions: Action[], kb: KbSource | null, on: { readonly shown: boolean }): Action[] {
  if (!on.shown || app.chat?.sources !== 'on' || kb === null || !kb.fresh) return actions;
  const knowledge = app.knowledge?.kb;
  if (knowledge === undefined) return actions;
  const sources = answerSourcesOf(knowledge, kb);
  if (sources.length === 0) return actions;
  for (const a of actions) {
    if (a.type !== 'say') continue;
    const said = saidLineOf(a);
    if (said !== undefined && Object.hasOwn(said.vars, KB_ANSWER_VAR)) a.sources = sources.map((s) => ({ ...s }));
  }
  return actions;
}

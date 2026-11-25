import type { App } from './app/types';
import type { Decision, PromptDecision } from './decision';
import type { Action } from '../channel/actions';
import type { SlotContext } from './slots/types';
import { identityOf, slotSpecOf } from './app/lookup';
import { promptText } from '../prompts/render';

/**
 * Answer buttons on a chat (app.yaml's `chat.replies`; docs/designs/2026-10-18-chat-replies.md): under a
 * question with a known set of answers, each answer as a button whose tap sends its words as the
 * person's message, read by the decision model as typed words are, so a tap goes the way a typed
 * answer does (the slot's question, the gate). The engine only offers them; nothing is decided by a tap.
 */

/** The most buttons shown under one question; a question with more answers shows none (the person types). */
export const CHAT_REPLIES_MAX = 8;
/** The fewest: one answer is no choice. */
const CHAT_REPLIES_MIN = 2;
/** The longest a button's words may be: a record said whole fits, a paragraph does not. */
const REPLY_CHARS_MAX = 80;
/** The lines a yes-or-no question's buttons say, where the app gives them (prompts.yaml, in every locale it speaks). */
export const REPLY_YES = 'reply_yes';
export const REPLY_NO = 'reply_no';

/** A line of the app's, said in `locale`, where the app has it; undefined where it does not, or it takes variables. */
function lineOf(app: App, id: string, locale: string | undefined): string | undefined {
  if (!Object.hasOwn(app.prompts.manifest, id)) return undefined;
  try {
    return promptText(app, id, {}, locale, { shown: true });
  } catch {
    return undefined;
  }
}

/** Yes and No: the app's own words (reply_yes, reply_no), else, in English, "Yes" and "No"; none in another language without them. */
function yesNo(app: App, locale: string | undefined): string[] | null {
  const english = locale === undefined || /^en(?:[-_]|$)/i.test(locale);
  const yes = lineOf(app, REPLY_YES, locale) ?? (english ? 'Yes' : undefined);
  const no = lineOf(app, REPLY_NO, locale) ?? (english ? 'No' : undefined);
  return yes !== undefined && no !== undefined ? [yes, no] : null;
}

/**
 * The buttons under a chat's question (`decision`), or null for none: Yes and No for a yes-or-no
 * question (its options), a slot's own answers for its question (SlotSpec.replies: a choice's options,
 * a record slot's records), never an identity factor's; only with app.yaml's `chat.replies: on`, and
 * only two to CHAT_REPLIES_MAX of them, each said once and short. `ctx` is asked only for a slot's.
 */
export function repliesOf(app: App, decision: PromptDecision, locale: string | undefined, ctx: () => SlotContext): string[] | null {
  if (app.chat?.replies !== 'on') return null;
  let answers: readonly string[] | null = null;
  if (decision.options.length === 2 && decision.options[0] === 'yes' && decision.options[1] === 'no') answers = yesNo(app, locale);
  else if (decision.target !== null && Object.hasOwn(app.slots, decision.target) && !identityOf(app).factorSlots.includes(decision.target)) {
    answers = slotSpecOf(app, decision.target).replies?.(ctx()) ?? null;
  }
  if (answers === null) return null;
  const shown = [...new Set(answers.map((a) => a.trim()).filter((a) => a !== '' && a.length <= REPLY_CHARS_MAX))];
  return shown.length >= CHAT_REPLIES_MIN && shown.length <= CHAT_REPLIES_MAX ? shown : null;
}

/**
 * A turn's actions with the buttons its question gets (repliesOf) on the line that asks it, the last:
 * only on a channel that shows words (a chat), only for a prompt. The actions themselves otherwise.
 */
export function withReplies(app: App, decision: Decision, actions: Action[], on: { readonly shown: boolean; readonly locale: string | undefined; readonly ctx: () => SlotContext }): Action[] {
  if (!on.shown || decision.kind !== 'prompt') return actions;
  const replies = repliesOf(app, decision, on.locale, on.ctx);
  const asks = actions.at(-1);
  if (replies !== null && asks?.type === 'say') asks.replies = replies;
  return actions;
}

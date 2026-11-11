import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { App } from '../core/app/types';
import type { Problem } from '../define/problems';
import type { AppRoutes } from '../server/appRoutes';
import { AGENT_FILE, AgentBusinessError, loadAgentBusiness } from './business/load';
import type { AgentBusiness } from './business/schema';
import { policyOf } from './policy';
import { fakeCalendar, type Calendar, type Slot } from './sources/calendar';
import { businessZone } from './state';
import type { ToolImpl } from './turn';

/**
 * A converse app (docs/designs/2026-11-11-agent-runtime.md, "One runtime, chosen per app"): a folder whose
 * agent.yaml is the business, joined with the code of each action it names. The folder's name is the
 * app's id.
 */
export interface ConverseApp {
  mode: 'converse';
  id: string;
  dir: string;
  business: AgentBusiness;
  tools: Record<string, ToolImpl>;
  pages?: AppRoutes;
  onText?: App['onText'];
  /** The app's chat settings (app.yaml's `chat`, where the folder has an app.yaml). */
  chat: ConverseChatSettings;
}

/** What a converse app's chat takes from app.yaml's `chat`. */
export interface ConverseChatSettings {
  /**
   * A chat has no calling number. With this on (app.yaml `chat.callerNumberFromContext: true`), a chat
   * whose start's context names `callerNumber` is taken as calling from it: the account it is recognised
   * as, and the "caller" token of a phone param. Off by default, so a site cannot claim an account.
   */
  callerNumberFromContext: boolean;
}

/** The file beside agent.yaml a converse app's chat settings are read from. */
export const APP_FILE = 'app.yaml';

/**
 * app.yaml's `chat` settings the converse runtime reads (`callerNumberFromContext`), defaults where the
 * folder has no app.yaml or the file names none. Its other keys are app.yaml's schema's to check.
 */
function chatSettingsOf(dir: string, add: (path: string, message: string, fix: string) => void): ConverseChatSettings {
  const file = join(dir, APP_FILE);
  if (!existsSync(file)) return { callerNumberFromContext: false };
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    add('(file)', `${APP_FILE} is not YAML (${e instanceof Error ? e.message.split('\n')[0] : 'unreadable'})`, `fix ${APP_FILE}'s syntax`);
    return { callerNumberFromContext: false };
  }
  const chat = typeof doc === 'object' && doc !== null ? (doc as { chat?: unknown }).chat : undefined;
  const flag = typeof chat === 'object' && chat !== null ? (chat as { callerNumberFromContext?: unknown }).callerNumberFromContext : undefined;
  if (flag !== undefined && typeof flag !== 'boolean') add('chat.callerNumberFromContext', 'must be true or false', 'write true, or delete it (false, the default)');
  return { callerNumberFromContext: flag === true };
}

/**
 * The app of the folder `dir`: its agent.yaml (env.<NAME> numbers read from the environment) and `code`.
 * Refuses (AgentBusinessError, a path and a fix per problem) an action with no code, code for no
 * action, and what the business's gate cannot hold (policyOf); agent.yaml's own check already refuses a
 * follow-on that takes a param its parent has not.
 */
export function defineConverseApp(dir: string, code: { tools: Record<string, ToolImpl>; pages?: AppRoutes; onText?: App['onText'] }): ConverseApp {
  const business = loadAgentBusiness(dir);
  const problems: Problem[] = [];
  const add = (path: string, message: string, fix: string): void => void problems.push({ file: AGENT_FILE, line: 1, column: 1, path, message, fix });
  for (const name of Object.keys(business.actions)) {
    if (!Object.hasOwn(code.tools, name)) add(`actions.${name}`, `the action "${name}" has no code`, `add tools.${name} to the app's code, or delete the action`);
  }
  for (const name of Object.keys(code.tools)) {
    if (!Object.hasOwn(business.actions, name)) add('(code)', `the tool "${name}" is no action`, `add "${name}" under actions in ${AGENT_FILE}, or delete it from the code (actions: ${Object.keys(business.actions).join(', ') || 'none'})`);
  }
  const chat = chatSettingsOf(dir, (path, message, fix) => void problems.push({ file: APP_FILE, line: 1, column: 1, path, message, fix }));
  if (problems.length > 0) throw new AgentBusinessError(problems);
  policyOf(business);
  const abs = resolve(dir);
  return {
    mode: 'converse',
    id: basename(abs),
    dir: abs,
    business,
    tools: { ...code.tools },
    chat,
    ...(code.pages !== undefined ? { pages: code.pages } : {}),
    ...(code.onText !== undefined ? { onText: code.onText } : {}),
  };
}

/** Whether a hosted app is a converse app (the server's dispatch: a converse app's chat runs on the converse runtime). */
export function isConverseApp(app: unknown): app is ConverseApp {
  return typeof app === 'object' && app !== null && (app as { mode?: unknown }).mode === 'converse';
}

/** The business's calendar (agent.yaml sources.calendar), its today in the business's zone (businessZone), or null where it has none. */
export function businessCalendar(b: AgentBusiness, now: () => Date): (Calendar & { bookings: { slotId: string; details: Record<string, string>; key: string }[] }) | null {
  const c = b.sources.calendar;
  if (c === undefined) return null;
  return fakeCalendar({ days: c.days, windows: c.windows, now, timeZone: businessZone(b) });
}

export type { Calendar, Slot };

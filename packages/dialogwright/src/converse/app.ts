import { basename, resolve } from 'node:path';
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
  if (problems.length > 0) throw new AgentBusinessError(problems);
  policyOf(business);
  const abs = resolve(dir);
  return {
    mode: 'converse',
    id: basename(abs),
    dir: abs,
    business,
    tools: { ...code.tools },
    ...(code.pages !== undefined ? { pages: code.pages } : {}),
    ...(code.onText !== undefined ? { onText: code.onText } : {}),
  };
}

/** The business's calendar (agent.yaml sources.calendar), its today in the business's zone (businessZone), or null where it has none. */
export function businessCalendar(b: AgentBusiness, now: () => Date): (Calendar & { bookings: { slotId: string; details: Record<string, string>; key: string }[] }) | null {
  const c = b.sources.calendar;
  if (c === undefined) return null;
  return fakeCalendar({ days: c.days, windows: c.windows, now, timeZone: businessZone(b) });
}

export type { Calendar, Slot };

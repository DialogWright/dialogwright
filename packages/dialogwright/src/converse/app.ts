import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import type { App, AppBrand, ChatPageChoice, ChatPageConfig } from '../core/app/types';
import { positionOf, problemsOfIssues, type Problem } from '../define/problems';
import { appSchema, RENAMED_MODE_FIX } from '../define/schema/app';
import type { JsonSchema } from '../define/schema/json';
import type { AppRoutes } from '../server/appRoutes';
import type { Texts } from '../texts/types';
import { AGENT_FILE, AgentBusinessError, readAgentBusiness, resolveAgentSettings } from './business/load';
import type { AgentBusiness } from './business/schema';
import { readConverseKnowledge, type ConverseKnowledge } from './knowledge';
import { policyOf } from './policy';
import type { CompiledPolicy } from '../gate/compiled';
import { envVariableOf } from '../core/app/envReference';
import { fakeCalendar, type Calendar, type Slot } from './sources/calendar';
import { GOOGLE_CALENDAR_KEY_FILE, googleCalendar } from './sources/googleCalendar';
import { businessZone } from './state';
import type { ToolImpl } from './turn';

/**
 * An agent app (docs/designs/2026-11-11-agent-runtime.md, "One runtime, chosen per app"): a folder whose
 * app.yaml says `mode: agent` and names the app (`id`, as a scripted app's does), and whose agent.yaml
 * is the business, joined with the code of each action it names.
 */
export interface ConverseApp {
  mode: 'converse';
  id: string;
  dir: string;
  business: AgentBusiness;
  tools: Record<string, ToolImpl>;
  /** The app's own pages, under /<id>: routes made with the app, or made by the server as it starts (ConversePagesFactory). */
  pages?: AppRoutes | ConversePagesFactory;
  onText?: App['onText'];
  /** The app's chat settings (app.yaml's `chat`). */
  chat: ConverseChatSettings;
  /** The app's name and look on its chat page (app.yaml's `brand`; the logo an absolute path). */
  brand?: AppBrand;
  /**
   * The app's knowledge base (its kb/ folder beside agent.yaml) and the retriever kb.yaml names: where it has one, the
   * runtime's own lookup (look_up, converse/knowledge.ts) is in the gate, and offered wherever an approved passage is
   * there to be found. Absent: no kb/ folder.
   */
  knowledge?: ConverseKnowledge;
  /**
   * The app made again, with state of its own (its systems, its calendar), where its code keeps any: a test
   * harness starts each simulated call on one (pnpm eval), so no call sees what another booked. Absent, the
   * app keeps no state of its own and is used as it is.
   */
  fresh?: () => ConverseApp;
}

/** What an agent app's pages are made with, as the server starts: as a scripted app's pages are (AppPageDeps), for an app with no scripted parts. */
export interface ConversePageDeps {
  /** The app, its agent.yaml's references read from its own settings. */
  app: ConverseApp;
  /** Where its pages are mounted, `/<app id>`. */
  base: string;
  /** One of the app's settings by name: on a host its own settings file over the server's, on a server of one the server's environment. */
  env(name: string): string | undefined;
  /** The app's sender (TEXT_FROM), each text recorded in its audit; absent where the server has none. */
  texts?: Texts;
  now(): number;
  log(line: string): void;
  /** The server's public name (PUBLIC_HOST), for a form's Origin check. */
  publicHost: string;
  /** The console has a sign-in (CONSOLE_AUTH=token): a console page may offer Sign out. */
  consoleSignIn: boolean;
}

/** An agent app's pages, made by the server as it starts. */
export type ConversePagesFactory = (deps: ConversePageDeps) => AppRoutes;

/** What an agent app's chat takes from app.yaml's `chat`. */
export interface ConverseChatSettings {
  /**
   * A chat has no calling number. With this on (app.yaml `chat.callerNumberFromContext: true`), a chat
   * whose start's context names `callerNumber` is taken as calling from it: the account it is recognised
   * as, and the "caller" token of a phone param. Off by default, so a site cannot claim an account.
   */
  callerNumberFromContext: boolean;
  /** The engine's chat page (app.yaml's `chat.page`), served at /<id>/chat as a scripted app's is. Absent: none. */
  page?: ChatPageConfig;
}

/** The file beside agent.yaml that names an agent app and holds its chat settings. */
export const APP_FILE = 'app.yaml';

type AppYaml = z.output<typeof appSchema>;
let appJsonSchema: JsonSchema | null = null;

/**
 * The problems of an agent app's app.yaml, checked by app.yaml's own schema (as `pnpm check` checks it),
 * and that it says `mode: agent`: each at its line with a fix. The file's value where it has none.
 */
export function converseAppYamlProblems(text: string, file: string = APP_FILE): { problems: Problem[]; value?: AppYaml } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'error', lineCounter: lines, customTags: [] });
  const problems: Problem[] = [];
  for (const e of doc.errors) {
    const at = lines.linePos(e.pos[0]);
    problems.push({ file, line: at.line, column: at.col, path: '(file)', message: e.message.split('\n')[0] ?? e.message, fix: 'correct the YAML at this position (the files are YAML 1.2)' });
  }
  if (problems.length > 0) return { problems };
  const raw = doc.toJS();
  if ((raw as { mode?: unknown } | null)?.mode === 'converse') {
    const at = positionOf(doc, lines, ['mode']);
    return { problems: [{ file, line: at.line, column: at.column, path: 'mode', message: 'app.yaml says "mode: converse", the agent mode\'s name before it was renamed, and there is no alias', fix: RENAMED_MODE_FIX }] };
  }
  const parsed = appSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    appJsonSchema ??= z.toJSONSchema(appSchema, { io: 'input', target: 'draft-7' }) as JsonSchema;
    return { problems: problemsOfIssues(parsed.error.issues, { file, doc, lines, value: raw ?? {}, schema: appJsonSchema }) };
  }
  if (parsed.data.mode !== 'agent') {
    // At the mode key's value where it has one; at the file's start where it names none.
    const at = parsed.data.mode === undefined ? { line: 1, column: 1 } : positionOf(doc, lines, ['mode']);
    return { problems: [{ file, line: at.line, column: at.column, path: 'mode', message: `an agent app's app.yaml says "mode: agent"${parsed.data.mode === undefined ? ', and this one names no mode' : `, and this one says "${parsed.data.mode}"`}`, fix: 'write "mode: agent" in app.yaml' }] };
  }
  return { problems: [], value: parsed.data };
}

/** The app.yaml of an agent app's folder, checked (converseAppYamlProblems); throws AgentBusinessError with its problems. */
function readAppYaml(dir: string): AppYaml {
  let text: string;
  try {
    text = readFileSync(resolve(dir, APP_FILE), 'utf8');
  } catch {
    throw new AgentBusinessError([{ file: APP_FILE, line: 1, column: 1, path: '(file)', message: `${APP_FILE} cannot be read in ${dir}`, fix: `create ${APP_FILE} there, with the app's id and "mode: agent"` }]);
  }
  const { problems, value } = converseAppYamlProblems(text);
  if (!value) throw new AgentBusinessError(problems);
  return value;
}

/**
 * The app of the folder `dir`: its app.yaml (the app's id, `mode: agent`, its chat settings), its
 * agent.yaml (its env.<NAME> references kept as written: the server reads them from the app's own settings
 * as it starts, appWithSettings) and `code`. Refuses (AgentBusinessError, a path
 * and a fix per problem) an app.yaml its schema refuses or that is not converse's, an action with no code,
 * code for no action, and what the business's gate cannot hold (policyOf); agent.yaml's own check already
 * refuses a follow-on that takes a param its parent has not.
 */
export function defineConverseApp(dir: string, code: { tools: Record<string, ToolImpl>; pages?: AppRoutes | ConversePagesFactory; onText?: App['onText']; fresh?: () => ConverseApp }): ConverseApp {
  const yaml = readAppYaml(dir);
  const business = readAgentBusiness(dir);
  const problems: Problem[] = [];
  const add = (path: string, message: string, fix: string): void => void problems.push({ file: AGENT_FILE, line: 1, column: 1, path, message, fix });
  for (const name of Object.keys(business.actions)) {
    if (!Object.hasOwn(code.tools, name)) add(`actions.${name}`, `the action "${name}" has no code`, `add tools.${name} to the app's code, or delete the action`);
  }
  for (const name of Object.keys(code.tools)) {
    if (!Object.hasOwn(business.actions, name)) add('(code)', `the tool "${name}" is no action`, `add "${name}" under actions in ${AGENT_FILE}, or delete it from the code (actions: ${Object.keys(business.actions).join(', ') || 'none'})`);
  }
  if (problems.length > 0) throw new AgentBusinessError(problems);
  const knowledge = readConverseKnowledge(dir);
  policyOf(business, { lookUp: knowledge !== undefined });
  return {
    mode: 'converse',
    id: yaml.id,
    dir: resolve(dir),
    business,
    tools: { ...code.tools },
    chat: { callerNumberFromContext: yaml.chat?.callerNumberFromContext === true, ...(yaml.chat?.page !== undefined ? { page: chatPageOf(yaml.chat.page) } : {}) },
    ...(yaml.brand !== undefined ? { brand: { ...(yaml.brand as AppBrand), ...(yaml.brand.logo !== undefined ? { logo: resolve(dir, yaml.brand.logo) } : {}) } } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
    ...(code.pages !== undefined ? { pages: code.pages } : {}),
    ...(code.onText !== undefined ? { onText: code.onText } : {}),
    ...(code.fresh !== undefined ? { fresh: code.fresh } : {}),
  };
}

/** app.yaml's chat.page as the page is built from it (the same reading a scripted app's gets in defineApp). */
function chatPageOf(page: NonNullable<NonNullable<AppYaml['chat']>['page']>): ChatPageConfig {
  return {
    serve: page.serve,
    ...(page.intro !== undefined ? { intro: page.intro } : {}),
    ...(page.starters !== undefined ? { starters: [...page.starters] } : {}),
    ...(page.phone !== undefined ? { phone: page.phone.replace(/^env\./, '') } : {}),
    ...(page.about !== undefined ? { about: page.about.map((x) => ({ title: x.title, text: x.text })) } : {}),
    ...(page.choose !== undefined ? { choose: chatChoicesOf(page.choose) } : {}),
  };
}

/** The gate of an agent app: agent.yaml's actions, with the runtime's lookup where the app has a knowledge base. */
export function converseAppPolicy(app: Pick<ConverseApp, 'business' | 'knowledge'>): CompiledPolicy {
  return policyOf(app.business, { lookUp: app.knowledge !== undefined });
}

/** The app with agent.yaml's env.<NAME> references read from `settings`, the app's own (the server does this as it starts). */
export function appWithSettings(app: ConverseApp, settings: Record<string, string | undefined>): ConverseApp {
  return { ...app, business: resolveAgentSettings(app.business, settings) };
}

/** Whether a hosted app is an agent app (the server's dispatch: an agent app's chat runs on the converse runtime). */
export function isConverseApp(app: unknown): app is ConverseApp {
  return typeof app === 'object' && app !== null && (app as { mode?: unknown }).mode === 'converse';
}

/**
 * The business's calendar (agent.yaml sources.calendar), its today in the business's zone (businessZone), or
 * null where it has none: the fake calendar for `kind: fake`; for `kind: google`, Google Calendar through a
 * service account (sources/googleCalendar.ts), its key file's path the app's setting GOOGLE_CALENDAR_KEY_FILE
 * and its calendar's id agent.yaml's `calendarId` (an `env.<NAME>` one read from the settings too), both from
 * `o.env` (a tool's ctx.env, or the server's settings). An app keeps the one it makes (its sign-in is kept on
 * it). Throws, saying which setting, where a google calendar's setting is not set; never names the path.
 */
export function businessCalendar(b: AgentBusiness, now: () => Date, o: { env?: (name: string) => string | undefined; fetch?: typeof fetch } = {}): Calendar | null {
  const c = b.sources.calendar;
  if (c === undefined) return null;
  if (c.kind === 'google') {
    const env = o.env ?? (() => undefined);
    const keyFile = env(GOOGLE_CALENDAR_KEY_FILE)?.trim();
    if (keyFile === undefined || keyFile === '') throw new Error(`agent.yaml's calendar is google, and ${GOOGLE_CALENDAR_KEY_FILE} is not set: set it in the app's settings (.env) to the path of the service account's key file`);
    const variable = envVariableOf(c.calendarId);
    const calendarId = variable === null ? c.calendarId : env(variable)?.trim();
    if (calendarId === undefined || calendarId === '') throw new Error(`agent.yaml's google calendar is ${c.calendarId ?? 'not named'}, and ${variable ?? 'calendarId'} is not set: set it to the calendar's id`);
    return googleCalendar({ calendarId, keyFile, business: b, now, ...(o.fetch !== undefined ? { fetch: o.fetch } : {}) });
  }
  return fakeCalendar({ days: c.days, windows: c.windows, now, timeZone: businessZone(b) });
}

export type { Calendar, Slot };

/** app.yaml's chat.page.choose as the page is built from it: one choice as the object it is, a list as a list. */
function chatChoicesOf(choose: NonNullable<NonNullable<NonNullable<AppYaml['chat']>['page']>['choose']>): ChatPageChoice | ChatPageChoice[] {
  const one = (c: Exclude<typeof choose, readonly unknown[]>): ChatPageChoice => ({ key: c.key, label: c.label, options: c.options.map((o) => ({ value: o.value, label: o.label, ...(o.detail !== undefined ? { detail: o.detail } : {}), ...(o.starters !== undefined ? { starters: [...o.starters] } : {}) })) });
  return Array.isArray(choose) ? choose.map(one) : one(choose as Exclude<typeof choose, readonly unknown[]>);
}

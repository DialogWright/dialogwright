import { z } from 'zod';
import { ENV_REFERENCE } from '../../core/app/envReference';
import { E164 } from '../../core/numberLocales';
import { checkAlways, identifier, matching, text } from '../../define/schema/common';
import { policyRuleEntry } from '../../define/schema/policy';
import { MODEL_EFFORTS } from '../model/types';

/**
 * agent.yaml: everything about a business the converse runtime (docs/designs/2026-11-11-agent-runtime.md)
 * may use: who it is and how it sounds, what it does and does not do, what it may say about prices, the
 * lines said in fixed words, the model and its limits, where its calendar and accounts come from, and the
 * actions the agent may call (each a lookup or a change, with its parameters, its read-back, its policy
 * rules and how it is recorded). The file is the business's own word. Every action goes through the gate;
 * every change is read back and confirmed first.
 *
 *   business: { name: Example Co, about: Books visits., hours: "Weekdays, 9 to 5." }
 *   actions:
 *     book:
 *       about: Book a visit into a window.
 *       kind: change
 *       params:
 *         day: { type: date, about: The day of the visit. }
 *       readBack: { en: "A visit on {day}. Is that right?" }
 */

/** The languages a business words its lines in. */
export const LANGS = ['en'] as const;
export type Lang = (typeof LANGS)[number];

const worded = (what: string) =>
  z.strictObject({ en: text().describe(`${what}, in English.`) }).describe(`${what}, per language.`);

/** The runtime's own action, offered to every model: it says the closing line and ends the call. No business action takes its name. */
export const END_CALL = 'end_call';

/** Param types the runtime checks a value by. */
export const PARAM_TYPES = ['date', 'slot', 'choice', 'number', 'text', 'phone'] as const;
/** How a param may be recorded (the same words as policy.yaml's audit). */
export const AUDIT_MASKS = ['last4', 'mask', 'length', 'secret', 'keep'] as const;
/** The providers a model is named through. */
export const MODEL_PROVIDERS = ['anthropic', 'inception', 'openrouter'] as const;

/** A number written out (E.164) or `env.<NAME>`, a setting that holds it. */
const numberOrEnv = () =>
  matching(
    new RegExp(`(?:${E164.source})|(?:${ENV_REFERENCE.source})`),
    'must be an E.164 number like +15555550142, or env.<NAME>',
    'write env.<NAME> (capitals, digits and underscores) and set the variable to the number in the app\'s settings (.env), or write the number with + and the country code, in quotes ("+15555550142")',
  );

const param = z
  .strictObject({
    type: z.enum(PARAM_TYPES).describe('How the value is checked: date (a real date), slot (one the named lookup returned on this call), choice (one of the options), number, text, phone (a phone number).'),
    about: text().describe('What the value is, in plain words, for the model.'),
    options: z.array(text()).optional().describe('For a choice: the values it may take.'),
    from: identifier().optional().describe('For a slot: the lookup action whose results the value must come from.'),
    optional: z.boolean().optional().describe('The model may leave the value out. Default: the value is required.'),
  })
  .describe('One parameter of an action.');

const action = z
  .strictObject({
    about: text().describe('What the action does and when to use it, for the model.'),
    kind: z.enum(['lookup', 'change']).describe('lookup: reads and returns a result. change: does something, and so is read back and confirmed by the caller first.'),
    params: z.record(identifier(), param).default({}).describe('The parameters the call carries, by name.'),
    readBack: worded('The read-back said before a change runs, with each parameter as a {placeholder} named as the parameter; required for a change').optional(),
    then: z.array(identifier()).optional().describe('Actions that run after the confirmed yes with no read-back of their own, each still through the gate. Only on a change.'),
    rules: z.array(policyRuleEntry).optional().describe('The gate\'s rules for this action, in the same shape as policy.yaml\'s.'),
    audit: z.record(identifier(), z.enum(AUDIT_MASKS)).optional().describe('How each param that needs it is recorded: last4, mask, length, secret or keep. Default: mask.'),
  })
  .describe('One action the agent may call.');

const price = z.strictObject({ from: z.number().nonnegative().describe('The low end.'), to: z.number().nonnegative().describe('The high end.'), per: text().describe('What the price is for (a visit, a unit).') }).describe('A price as a range.');

const calendar = z
  .strictObject({
    kind: z.enum(['fake', 'google']).describe('fake: the days and windows below, for a demo. google: reserved for a later release.'),
    days: z.array(text()).default([]).describe('The days the business is open to book, as dates.'),
    windows: z.array(z.strictObject({ name: identifier().describe('The window\'s id.'), label: text().describe('How it is said to a caller (for example "9 to 12").'), capacity: z.number().int().positive().describe('How many visits it holds.') })).default([]).describe('The windows of a day a visit may be booked into, each with its capacity.'),
  })
  .describe('Where availability comes from.');

const account = z.strictObject({ name: text().describe('The account\'s name.'), numbers: z.array(numberOrEnv()).default([]).describe('The numbers it calls from: E.164, or env.<NAME>. A variable that is not set is left out.') }).describe('A caller account, recognised by the numbers it calls from.');

const issue = (ctx: z.core.$RefinementCtx, path: (string | number)[], message: string, fix: string): void => ctx.addIssue({ code: 'custom', path, message, params: { fix } });
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cross-field checks of the whole file; they run even when other parts have problems, so one pass says everything. */
function crossChecks(value: unknown, ctx: z.core.$RefinementCtx): void {
  if (!isMap(value)) return;
  const root = value;
  const model = isMap(root.model) ? root.model : undefined;
  const spec = model?.default;
  if (typeof spec === 'string') {
    const at = spec.indexOf(':');
    const provider = at < 0 ? '' : spec.slice(0, at);
    const name = at < 0 ? '' : spec.slice(at + 1);
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider) || name === '') {
      issue(ctx, ['model', 'default'], `"${spec}" does not name a provider and a model`, `write <provider>:<model> with the provider ${MODEL_PROVIDERS.join(', ')}, for example anthropic:claude-haiku-5-5`);
    } else if (provider === 'openrouter' && /anthropic\/|claude/i.test(name)) {
      issue(ctx, ['model', 'default'], `"${spec}" asks a Claude model through OpenRouter`, `write anthropic:<model>: Claude models go through the Anthropic API only`);
    }
  }
  const calendar = isMap(root.sources) && isMap(root.sources.calendar) ? root.sources.calendar : undefined;
  if (calendar?.kind === 'google') issue(ctx, ['sources', 'calendar', 'kind'], 'the google calendar is not available yet', 'write "fake" and list the days and windows');
  if (Array.isArray(root.services)) {
    root.services.forEach((s, i) => {
      const p = isMap(s) && isMap(s.price) ? s.price : undefined;
      if (p && typeof p.from === 'number' && typeof p.to === 'number' && p.from > p.to) issue(ctx, ['services', i, 'price'], `the price runs from ${p.from} to ${p.to}`, '"from" must not be more than "to"');
    });
  }
  const actions = isMap(root.actions) ? root.actions : {};
  const kindOf = (name: string): unknown => (isMap(actions[name]) ? (actions[name] as Record<string, unknown>).kind : undefined);
  for (const [name, a] of Object.entries(actions)) {
    if (name === END_CALL) issue(ctx, ['actions', name], `"${END_CALL}" is the runtime's own action`, `name the action something else: the runtime always offers "${END_CALL}", which says the closing line and ends the call`);
    if (!isMap(a)) continue;
    const params = isMap(a.params) ? a.params : {};
    if (a.kind === 'change' && a.readBack === undefined) {
      issue(ctx, ['actions', name], `the change "${name}" has no read-back`, 'add readBack: { en: "..." } with each parameter as a {placeholder}: a change is read back and confirmed before it runs');
    }
    if (a.kind === 'lookup' && a.readBack !== undefined) {
      issue(ctx, ['actions', name, 'readBack'], `the lookup "${name}" has a read-back`, 'delete readBack: only a change is read back');
    }
    if (isMap(a.readBack) && typeof a.readBack.en === 'string') {
      for (const m of a.readBack.en.matchAll(/\{([^{}]*)\}/g)) {
        const key = m[1]!;
        if (!Object.hasOwn(params, key)) issue(ctx, ['actions', name, 'readBack', 'en'], `the placeholder {${key}} is no param of "${name}"`, `write one of its params (${Object.keys(params).join(', ') || 'it has none'}) in the braces, or add the param`);
      }
    }
    if (Array.isArray(a.then)) {
      if (a.kind === 'lookup') issue(ctx, ['actions', name, 'then'], `the lookup "${name}" has follow-on actions`, 'delete "then": only a change has follow-on actions');
      a.then.forEach((t, i) => {
        if (typeof t !== 'string') return;
        if (t === name) issue(ctx, ['actions', name, 'then', i], `"${name}" follows itself`, 'delete it from "then"');
        else if (!Object.hasOwn(actions, t)) issue(ctx, ['actions', name, 'then', i], `"${t}" is no action`, `name one of the actions (${Object.keys(actions).join(', ')}), or add "${t}" under actions`);
        else {
          // A follow-on runs with the params of its parent's yes, by name: one it takes that the parent has not would run with a value the caller never heard read back.
          const follow = actions[t];
          const takes = isMap(follow) && isMap(follow.params) ? Object.keys(follow.params) : [];
          const missing = takes.filter((p) => !Object.hasOwn(params, p));
          if (missing.length > 0) issue(ctx, ['actions', name, 'then', i], `the follow-on "${t}" takes ${missing.join(', ')}, which "${name}" has not`, `give "${t}" only params of "${name}" (${Object.keys(params).join(', ') || 'it has none'}): a follow-on runs with the values the caller said yes to, by name`);
          const typeOf = (m: unknown): unknown => (isMap(m) ? m.type : undefined);
          for (const p of takes.filter((k) => Object.hasOwn(params, k))) {
            const theirs = typeOf((follow as Record<string, Record<string, unknown>>).params![p]);
            const ours = typeOf(params[p]);
            if (theirs !== ours) issue(ctx, ['actions', t, 'params', p], `"${p}" is a ${String(theirs)} in the follow-on "${t}" and a ${String(ours)} in "${name}", whose value it takes`, `make "${p}" a ${String(ours)} in "${t}", as in "${name}"`);
          }
        }
      });
    }
    for (const [pname, p] of Object.entries(params)) {
      if (!isMap(p)) continue;
      if (p.type === 'slot') {
        if (typeof p.from !== 'string') issue(ctx, ['actions', name, 'params', pname], `the slot param "${pname}" has no "from"`, 'add from: <lookup action>, the lookup whose results the value must come from');
        else if (!Object.hasOwn(actions, p.from)) issue(ctx, ['actions', name, 'params', pname, 'from'], `"${p.from}" is no action`, `name a lookup action (${Object.keys(actions).filter((k) => kindOf(k) === 'lookup').join(', ') || 'none is defined yet'})`);
        else if (kindOf(p.from) !== 'lookup') issue(ctx, ['actions', name, 'params', pname, 'from'], `"${p.from}" is not a lookup`, 'a slot must come from a lookup: set that action\'s kind to lookup, or name another');
      } else if (p.from !== undefined) {
        issue(ctx, ['actions', name, 'params', pname, 'from'], `"from" belongs to a slot param, and "${pname}" is a ${String(p.type)}`, 'delete "from", or make the param a slot');
      }
      if (p.type === 'choice' && !(Array.isArray(p.options) && p.options.length > 0)) {
        issue(ctx, ['actions', name, 'params', pname], `the choice param "${pname}" has no options`, 'add options: [..], the values it may take');
      }
    }
    if (isMap(a.audit)) {
      for (const key of Object.keys(a.audit)) if (!Object.hasOwn(params, key)) issue(ctx, ['actions', name, 'audit', key], `"${key}" is no param of "${name}"`, `name one of its params (${Object.keys(params).join(', ') || 'it has none'}), or delete the entry`);
    }
  }
}

export const agentBusinessSchema = z
  .strictObject({
    business: z
      .strictObject({
        name: text().describe('The business\'s name.'),
        about: text().describe('What it does, in a sentence or two.'),
        where: text().optional().describe('Where it is.'),
        hours: text().describe('Its days and hours, as the agent may say them.'),
        timezone: text()
          .refine((z) => { try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return true; } catch { return false; } }, 'not an IANA time zone name')
          .optional()
          .describe('The business\'s IANA time zone (for example America/New_York): what "today" means for its calendar. Default: UTC.'),
      })
      .describe('Who the business is.'),
    services: z
      .array(z.strictObject({ name: text().describe('The service\'s name.'), about: text().describe('What it is.'), price: price.optional() }).describe('One service.'))
      .default([])
      .describe('What the business does, with a price range where it has one.'),
    priceCaveat: worded('What the agent says alongside any price (for example that the final price is confirmed once the work is seen)'),
    notOffered: z.array(text()).default([]).describe('What the business does not do.'),
    facts: z.array(text()).default([]).describe('Anything else the agent may say, one fact each.'),
    persona: z
      .strictObject({
        style: text().describe('How the agent speaks.'),
        voices: z.strictObject({ twilio: text().optional().describe('The voice on Twilio.'), telnyx: text().optional().describe('The voice on Telnyx.') }).optional().describe('The voice to use per carrier.'),
      })
      .describe('How the agent sounds.'),
    lines: z
      .strictObject({
        greeting: worded('The greeting'),
        closing: worded('The closing line'),
        recovery: worded('The short line said when the agent did not catch something'),
        handoff: worded('The line said when the call goes to a person'),
        notConfirmed: worded('The line said when the caller did not confirm a read-back').optional(),
        done: worded('The line said when an action the caller confirmed has run but the reply after it failed, so the caller still hears it was done').default({ en: "That's done." }),
      })
      .describe('The lines said word for word.'),
    model: z
      .strictObject({
        default: text().describe('The model, as <provider>:<model> (anthropic, inception or openrouter). Claude models go through anthropic only.'),
        timeoutMs: z.number().int().positive().default(6000).describe('How long a model reply may take before the turn falls back.'),
        maxTokens: z.number().int().positive().default(400).describe('The most tokens a reply may use (a model\'s reasoning counts toward it). A reply cut off at it is a failed turn, never spoken as it was cut.'),
        effort: z.enum(MODEL_EFFORTS).optional().describe('How hard the model reasons: minimal, low, medium or high, sent in each provider\'s own form (Inception\'s reasoning_effort, where minimal is its instant; OpenRouter\'s reasoning.effort; not sent to Anthropic). Default: the provider\'s own.'),
      })
      .describe('The model that leads the conversation.'),
    limits: z
      .strictObject({
        failuresPerCall: z.number().int().positive().default(4).describe('Failed turns in a call before it goes to a person.'),
        refusalsPerAction: z.number().int().positive().default(3).describe('Refusals of the same action before the agent offers a person.'),
      })
      .default({ failuresPerCall: 4, refusalsPerAction: 3 })
      .describe('When to stop trying and offer a person.'),
    sources: z
      .strictObject({
        calendar: calendar.optional(),
        accounts: z.array(account).optional().describe('Caller accounts, recognised by the number they call from.'),
      })
      .default({})
      .describe('Where the calendar and the caller accounts come from.'),
    actions: z.record(identifier(), action).default({}).describe('Every action the agent may call, by name.'),
    transfer: z.strictObject({ number: numberOrEnv().describe('The number to hand a call to: E.164, or env.<NAME>.') }).optional().describe('Where a call goes when it is handed to a person.'),
  })
  .check(checkAlways(crossChecks))
  .describe('agent.yaml: the business the converse runtime speaks for.');

export type AgentBusinessInput = z.input<typeof agentBusinessSchema>;
export type AgentBusiness = z.output<typeof agentBusinessSchema>;
export type Worded = Record<Lang, string>;
export type ParamSpec = z.output<typeof param>;
export type ActionSpec = z.output<typeof action>;

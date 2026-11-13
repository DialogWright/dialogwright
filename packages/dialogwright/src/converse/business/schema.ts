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

/** The openers a persona may ask for (persona.opener). */
export const OPENERS = ['acknowledge'] as const;
export type Opener = (typeof OPENERS)[number];

/**
 * What the check after speaking (docs/designs/2026-11-11-claims-check.md) does with a reply it reads:
 * correct (read every reply, have the model put right what is wrong, record gaps), record (read and record
 * only) or off.
 */
export const CLAIM_MODES = ['correct', 'record', 'off'] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];
/**
 * The check's defaults: off (the maintainer's decision, 2026-11-12: measured on 695 labelled replies, no
 * question set told the real wrong replies from the right ones better than chance; the design's "Measured on
 * its own"), with both bars at 0.7 for an app that turns it on.
 */
export const CLAIM_CHECK_DEFAULTS = { mode: 'off', correctAt: 0.7, gapAt: 0.7 } as const satisfies { mode: ClaimMode; correctAt: number; gapAt: number };

/** A probability a reading is held to: over 0, at most 1. */
const bar = (what: string, d: number) => z.number().gt(0).max(1).default(d).describe(`${what} A number over 0 and at most 1. Default: ${d}.`);

/** The runtime's own action, offered to every model: it says the closing line and ends the call. No business action takes its name. */
export const END_CALL = 'end_call';

/** Param types the runtime checks a value by. */
export const PARAM_TYPES = ['date', 'slot', 'choice', 'number', 'text', 'phone'] as const;
/** The most characters a text param may have where it sets no `max` of its own. */
export const TEXT_MAX = 120;
/** How a param may be recorded (the same words as policy.yaml's audit). */
export const AUDIT_MASKS = ['last4', 'mask', 'length', 'secret', 'keep'] as const;
/** The providers a model is named through. */
export const MODEL_PROVIDERS = ['anthropic', 'inception', 'openrouter', 'meta'] as const;

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
    max: z.number().int().positive().optional().describe(`For a text: the most characters it may have (it is said in the read-back as it was given). Default: ${TEXT_MAX}.`),
  })
  .describe('One parameter of an action.');

const action = z
  .strictObject({
    about: text().describe('What the action does and when to use it, for the model.'),
    kind: z.enum(['lookup', 'change']).describe('lookup: reads and returns a result. change: does something, and so is read back and confirmed by the caller first.'),
    params: z.record(identifier(), param).default({}).describe('The parameters the call carries, by name.'),
    readBack: worded('The read-back said before a change runs, with each parameter as a {placeholder} named as the parameter, an optional one in a part in square brackets said only when it has a value ("[, {details}]"); required for a change').optional(),
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
    windows: z.array(z.strictObject({ name: identifier().describe('The window\'s id.'), label: text().describe('How it is said to a caller (for example "9 to 12").'), capacity: z.number().int().positive().describe('How many visits it holds.'), until: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time such as "08:00"').optional().describe('The last time a car may be dropped off in it, as 24-hour "HH:MM" in the business\'s time zone. Today\'s window is not offered or bookable after it; a later day\'s is unchanged. Absent, the window is offered all day.') })).default([]).describe('The windows of a day a visit may be booked into, each with its capacity.'),
  })
  .describe('Where availability comes from.');

const account = z.strictObject({ name: text().describe('The account\'s name.'), numbers: z.array(numberOrEnv()).default([]).describe('The numbers it calls from: E.164, or env.<NAME>. A variable that is not set is left out.') }).describe('A caller account, recognised by the numbers it calls from.');

const question = z.strictObject({ q: text().describe('A question callers ask, in their words.'), a: text().describe('The business\'s answer, as the agent may say it.') }).describe('One question and its answer.');

/** What a journey may ask of the caller's account, a fact of the call the runtime already has (a recognised account is not an identity). */
export const ACCOUNT_FACTS = ['recognised', 'none'] as const;
export type AccountFact = (typeof ACCOUNT_FACTS)[number];
/** Routing's defaults: the bar a switch to another journey must reach, and how long the decision model may take. */
export const ROUTING_DEFAULTS = { switchAt: 0.6, timeoutMs: 400 } as const;

const journey = z
  .strictObject({
    when: text().describe('The trigger, in plain words: what the caller wants. It is what the decision model reads, and what the root model is told the line can help with. Say what the caller wants, never who they are.'),
    goal: text().describe('What the journey achieves, in one sentence.'),
    instructions: text().optional().describe('What to collect, what to check first, what not to mention. Goals and limits, never wording.'),
    facts: z.array(text()).default([]).describe('This journey\'s own facts, added to the base\'s for this journey only. A journey cannot remove or override a base fact.'),
    questions: z.array(question).default([]).describe('This journey\'s own questions callers ask, with the business\'s answers, added to the base\'s for this journey only.'),
    actions: z.array(identifier()).default([]).describe('The actions it may use, named from the top-level actions. Each action is defined once and may be named by several journeys.'),
    for: z.strictObject({ account: z.enum(ACCOUNT_FACTS).describe('recognised: open only where the number calling is on an account. none: open only where it is on none.') }).optional().describe('Which callers the journey is open to, by a fact of the call. A journey closed to the caller is never one of the decision model\'s options. Absent: open to every caller.'),
    start: z.strictObject({ account: z.literal('recognised').describe('Start where the number calling is on an account.') }).optional().describe('A fact of the call that starts the journey before the caller speaks. At most one journey says it.'),
    completes: z.array(identifier()).optional().describe('The change actions whose confirmed run ends the journey. Default: all the change actions it names that are not follow-ons.'),
    after: text().optional().describe('What the line helps with once the journey is done, in one sentence. Default: "<goal>: done on this call. Answer the caller\'s questions about it."'),
  })
  .describe('One journey: a task the line can take on, with its own instructions, facts and actions.');
export type JourneySpec = z.output<typeof journey>;

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
    } else if (provider !== 'openrouter' && name.includes('@')) {
      issue(ctx, ['model', 'default'], `"${spec}" names hosts after @, which only an OpenRouter model does`, `write ${provider}:<model> with no @`);
    } else if (provider === 'openrouter' && name.includes('@') && name.slice(name.indexOf('@') + 1).split(',').some((h) => h.trim() === '')) {
      issue(ctx, ['model', 'default'], `"${spec}" names no OpenRouter host after @`, 'write openrouter:<vendor>/<model>@<host>, for example openrouter:openai/gpt-oss-120b@groq');
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
  /** The actions another names in its `then`: follow-ons, never offered to the model and never read back themselves. */
  const followed = new Set<string>();
  for (const [name, a] of Object.entries(actions)) if (isMap(a) && Array.isArray(a.then)) for (const t of a.then) if (typeof t === 'string' && t !== name) followed.add(t);
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
      const named = new Set<string>();
      for (const m of a.readBack.en.matchAll(/\{([^{}]*)\}/g)) {
        const key = m[1]!;
        named.add(key);
        if (!Object.hasOwn(params, key)) issue(ctx, ['actions', name, 'readBack', 'en'], `the placeholder {${key}} is no param of "${name}"`, `write one of its params (${Object.keys(params).join(', ') || 'it has none'}) in the braces, or add the param`);
      }
      // The caller's yes confirms every value the change runs with, so its read-back says each one: a required param
      // as it is, an optional one in a part in square brackets, said only when it has a value ("[, {details}]").
      // A follow-on's read-back is never said (it runs on its parent's yes, with values its parent read back), so it is not held to this.
      if (a.kind === 'change' && !followed.has(name)) {
        const inParts = new Set([...a.readBack.en.matchAll(/\[([^[\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]!)));
        for (const [pname, p] of Object.entries(params)) {
          if (!isMap(p)) continue;
          if (p.optional !== true && inParts.has(pname)) issue(ctx, ['actions', name, 'readBack', 'en'], `the read-back of "${name}" says the required {${pname}} in a part in square brackets, said only when it has a value`, `write {${pname}} outside the square brackets`);
          else if (!named.has(pname)) issue(ctx, ['actions', name, 'readBack', 'en'], `the read-back of "${name}" does not say {${pname}}, so the caller's yes would confirm it unheard`, p.optional === true ? `write {${pname}} in a part in square brackets, said only when it has a value ("[, {${pname}}]")` : `write {${pname}} in the read-back, or mark it optional and write it in a part in square brackets`);
        }
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
            else if (ours === 'text') {
              // The follow-on is checked again with the parent's value: a shorter bound would refuse what the caller said yes to.
              const maxOf = (m: unknown): number => (isMap(m) && typeof m.max === 'number' ? m.max : TEXT_MAX);
              const theirMax = maxOf((follow as Record<string, Record<string, unknown>>).params![p]);
              const ourMax = maxOf(params[p]);
              if (theirMax < ourMax) issue(ctx, ['actions', t, 'params', p], `"${p}" may have ${ourMax} characters in "${name}" and only ${theirMax} in the follow-on "${t}", which takes its value`, `give "${p}" max: ${ourMax} in "${t}", as in "${name}"`);
            }
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
      if (p.max !== undefined && p.type !== 'text') {
        issue(ctx, ['actions', name, 'params', pname, 'max'], `"max" belongs to a text param, and "${pname}" is a ${String(p.type)}`, 'delete "max", or make the param a text');
      }
      if (p.type === 'choice' && !(Array.isArray(p.options) && p.options.length > 0)) {
        issue(ctx, ['actions', name, 'params', pname], `the choice param "${pname}" has no options`, 'add options: [..], the values it may take');
      }
    }
    if (isMap(a.audit)) {
      for (const key of Object.keys(a.audit)) if (!Object.hasOwn(params, key)) issue(ctx, ['actions', name, 'audit', key], `"${key}" is no param of "${name}"`, `name one of its params (${Object.keys(params).join(', ') || 'it has none'}), or delete the entry`);
    }
  }

  if (isMap(root.root) && Array.isArray(root.root.actions)) {
    root.root.actions.forEach((n, i) => {
      if (typeof n !== 'string') return;
      if (!Object.hasOwn(actions, n)) issue(ctx, ['root', 'actions', i], `"${n}" is no action`, `name one of the actions (${Object.keys(actions).join(', ')}), or add "${n}" under actions`);
      else if (kindOf(n) !== 'lookup') issue(ctx, ['root', 'actions', i], `the root names the change "${n}"`, 'the root offers lookups only: move the change into a journey');
      else if (followed.has(n)) issue(ctx, ['root', 'actions', i], `the root names "${n}", which is a follow-on`, 'a follow-on is never offered to the model: delete it');
    });
  }
  if (isMap(root.journeys)) {
    const named = new Set<string>();
    const starters: string[] = [];
    for (const [id, j] of Object.entries(root.journeys)) {
      if (!isMap(j)) continue;
      const listed = Array.isArray(j.actions) ? j.actions.filter((n): n is string => typeof n === 'string') : [];
      listed.forEach((n, i) => {
        named.add(n);
        if (!Object.hasOwn(actions, n)) issue(ctx, ['journeys', id, 'actions', i], `"${n}" is no action`, `name one of the actions (${Object.keys(actions).join(', ')}), or add "${n}" under actions`);
        else if (followed.has(n)) issue(ctx, ['journeys', id, 'actions', i], `the journey "${id}" names "${n}", which is a follow-on`, 'a follow-on runs on its parent\'s yes and is never offered to the model: delete it from the journey');
      });
      if (Array.isArray(j.completes)) {
        j.completes.forEach((n, i) => {
          if (typeof n !== 'string') return;
          if (!listed.includes(n)) issue(ctx, ['journeys', id, 'completes', i], `"${n}" is not among the actions of "${id}"`, `name one of its actions (${listed.join(', ') || 'it has none'}), or add "${n}" to its actions`);
          else if (kindOf(n) !== 'change') issue(ctx, ['journeys', id, 'completes', i], `"${n}" is not a change`, 'only a confirmed change ends a journey: name a change action, or delete the entry');
        });
      }
      if (isMap(j.start)) {
        starters.push(id);
        if (isMap(j.for) && j.for.account === 'none') issue(ctx, ['journeys', id, 'start'], `the journey "${id}" starts where the number is on an account and is open only where it is on none`, 'delete "start", or make "for" account: recognised');
      }
    }
    if (starters.length > 1) issue(ctx, ['journeys', starters[1]!, 'start'], `${starters.join(' and ')} both say start, and two would race at the call's start`, `keep "start" on one journey and delete it from ${starters.slice(1).join(', ')}`);
    for (const [name, a] of Object.entries(actions)) {
      if (isMap(a) && a.kind === 'change' && !followed.has(name) && !named.has(name)) issue(ctx, ['actions', name], `the change "${name}" is named by no journey, so it could never be offered`, `add "${name}" to a journey's actions, or delete it`);
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
    questions: z
      .array(question)
      .default([])
      .describe('The questions callers ask and the business\'s answers: what to bring, how long things take, when someone calls back, what it costs to cancel. Where the business has not answered a question, the agent has nothing to go on; the simulated callers\' judge lists such answers as gaps for the owner to fill in here.'),
    persona: z
      .strictObject({
        style: text().describe('How the agent speaks.'),
        opener: z
          .enum(OPENERS)
          .optional()
          .describe('acknowledge: each reply begins with a brief, natural acknowledgement that commits the business to nothing ("Got it."), varied, and left out where it would sound odd, so the caller hears a whole first sentence almost at once. Absent: no opener is asked for.'),
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
        stuck: worded('The line said when the model is still looking things up after its last round of a turn (where nothing the caller confirmed has just run)').default({ en: 'Let me have someone follow up on that.' }),
      })
      .describe('The lines said word for word.'),
    model: z
      .strictObject({
        default: text().describe('The model, as <provider>:<model> (anthropic, inception, openrouter or meta). Claude models go through anthropic only. An OpenRouter model may name the hosts it is asked on after @ (openrouter:openai/gpt-oss-120b@groq), with no fallback to others; OpenRouter is always asked for hosts that collect no data.'),
        timeoutMs: z.number().int().positive().default(6000).describe('How long a model reply may take before the turn falls back.'),
        maxTokens: z.number().int().positive().default(400).describe('The most tokens a reply may use (a model\'s reasoning counts toward it). A reply cut off at it is a failed turn, never spoken as it was cut.'),
        effort: z.enum(MODEL_EFFORTS).optional().describe('How hard the model reasons: minimal, low, medium or high, sent in each provider\'s own form (Inception\'s reasoning_effort, where minimal is its instant; Meta\'s reasoning_effort; OpenRouter\'s reasoning.effort; Anthropic\'s output_config.effort, where minimal is low). Default: the provider\'s own.'),
      })
      .describe('The model that leads the conversation.'),
    limits: z
      .strictObject({
        failuresPerCall: z.number().int().positive().default(4).describe('Failed turns in a call before it goes to a person.'),
        refusalsPerAction: z.number().int().positive().default(3).describe('Refusals of the same action before the agent offers a person.'),
      })
      .default({ failuresPerCall: 4, refusalsPerAction: 3 })
      .describe('When to stop trying and offer a person.'),
    checks: z
      .strictObject({
        claims: z
          .strictObject({
            mode: z.enum(CLAIM_MODES).default(CLAIM_CHECK_DEFAULTS.mode).describe('correct: the decision model reads each reply of the agent model once it has been said; a reply read as contradicted by the business information or the call\'s actions, or as saying something was done that was not, goes back to the model with a note, and its correction is said after it; a gap (a commitment the business information does not address) is recorded. record: each reply is read and its readings recorded, nothing said. off: no reply is read. Default: off (measured, it did not tell wrong replies from right ones; docs/designs/2026-11-11-claims-check.md).'),
            correctAt: bar('The bar a reading of contradicted or of not done must reach for the reply to be corrected (with mode correct) and recorded as such.', CLAIM_CHECK_DEFAULTS.correctAt),
            gapAt: bar('The bar a reading of a gap must reach for it to be recorded as one.', CLAIM_CHECK_DEFAULTS.gapAt),
          })
          .default({ ...CLAIM_CHECK_DEFAULTS })
          .describe('The check after speaking (docs/designs/2026-11-11-claims-check.md): each reply of the agent model read by the decision model once it is said.'),
      })
      .default({ claims: { ...CLAIM_CHECK_DEFAULTS } })
      .describe('Checks the runtime makes of what the agent model says.'),
    sources: z
      .strictObject({
        calendar: calendar.optional(),
        accounts: z.array(account).optional().describe('Caller accounts, recognised by the number they call from.'),
      })
      .default({})
      .describe('Where the calendar and the caller accounts come from.'),
    actions: z.record(identifier(), action).default({}).describe('Every action the agent may call, by name.'),
    root: z
      .strictObject({
        instructions: text().optional().describe('How the line answers when no journey is active: the business\'s own guidance, never a script.'),
        actions: z.array(identifier()).default([]).describe('The actions offered at the root: lookups only. Default: none.'),
      })
      .optional()
      .describe('The line when no journey is active.'),
    routing: z
      .strictObject({
        switchAt: bar('The bar the decision model\'s reading must reach for the line to move to another journey.', ROUTING_DEFAULTS.switchAt),
        timeoutMs: z.number().int().positive().default(ROUTING_DEFAULTS.timeoutMs).describe(`How long the decision model may take to read a turn before the turn goes on with the active journey (or the root). Default: ${ROUTING_DEFAULTS.timeoutMs}.`),
      })
      .default({ ...ROUTING_DEFAULTS })
      .describe('How each caller turn is routed to a journey.'),
    journeys: z.record(identifier(), journey).optional().describe('The tasks the line can take on, by id. Absent: one conversation with every action, as before.'),
    transfer: z.strictObject({ number: numberOrEnv().describe('The number to hand a call to: E.164, or env.<NAME>.') }).optional().describe('Where a call goes when it is handed to a person.'),
  })
  .check(checkAlways(crossChecks))
  .describe('agent.yaml: the business the converse runtime speaks for.');

export type AgentBusinessInput = z.input<typeof agentBusinessSchema>;
export type AgentBusiness = z.output<typeof agentBusinessSchema>;
export type Worded = Record<Lang, string>;
export type ParamSpec = z.output<typeof param>;
export type ActionSpec = z.output<typeof action>;

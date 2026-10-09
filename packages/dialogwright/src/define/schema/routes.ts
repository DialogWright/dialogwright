import { z } from 'zod';
import { checkAlways, identifier, localeTag, name } from './common';
import { whenSchema } from './condition';
import { ROUTE_THEN } from '../../core/app/types';

/**
 * routes.yaml (optional): what the call does at three points, decided by ordered rules, the first whose
 * conditions all hold taken, an `else` last (core/routes.ts judges them, core/turn.ts acts on them):
 * - `start`: once, after the start hook (onStart) and the call-start lookup, before the greeting;
 * - `afterIdentity`: once, the first time the caller reaches level 1, after the identity step's own line;
 * - `afterForm.<form>`: when that form completes as said, before its `next`.
 * A rule is `when` (one condition or a list, all of which hold: core/conditions.ts) and an outcome: a line
 * said first (`say`) and what follows (`then`). Routes are not a state machine: intents, priority intents
 * and the agent intent still decide every turn.
 */

const THEN_WORDS: Record<(typeof ROUTE_THEN)[number], string> = {
  continue: 'continue (the call goes on as if no route were written: at start the greeting, after identity the form that asked for it, after a form its next, else "anything else?")',
  locale: 'locale (the call switches to `locale`, one of the app\'s, as the language intent does, then goes on)',
  end: 'end (say required; the call ends; at start, without the greeting)',
  handoff: 'handoff (to a person, with the line handoff_<reason>; reason default needs-human)',
  form: 'form (the form named by `form` is entered, keeping the slots both list; at start after the welcome, greeting_offer)',
  'anything-else': 'anything-else (say required; not at start: the form closes and "anything else?" is asked)',
};

const outcomeFields = {
  say: identifier()
    .optional()
    .describe('A line said first (a prompt in prompts.yaml). Required for end and anything-else. At start it comes before the greeting.'),
  then: z.enum(ROUTE_THEN).describe(`What follows: ${ROUTE_THEN.map((t) => THEN_WORDS[t]).join('; ')}.`),
  reason: name().optional().describe('For then: handoff, the handoff reason, whose line is handoff_<reason> (and which a transfer target may read). Default needs-human.'),
  form: identifier().optional().describe('For then: form, the form entered: a form in forms.yaml (an internal one too).'),
  locale: localeTag().optional().describe('For then: locale, the locale the call switches to: one of the app\'s (app.yaml\'s locale, or a locale/<tag>/ folder).'),
};

/** The rules every route's outcome is held to: what each then needs, and nothing it does not take. */
const outcomeRules = (where: (key: string) => (string | number)[]) => (value: unknown, ctx: z.core.$RefinementCtx): void => {
  const o = value as { say?: unknown; then?: unknown; reason?: unknown; form?: unknown; locale?: unknown };
  if ((o.then === 'end' || o.then === 'anything-else') && o.say === undefined) {
    ctx.addIssue({ code: 'custom', path: where(''), message: `then: ${o.then} says a line first, and this route names none`, params: { fix: 'add "say: <a prompt id in prompts.yaml>" with the line the caller hears' } });
  }
  if (o.reason !== undefined && o.then !== 'handoff') ctx.addIssue({ code: 'custom', path: where('reason'), message: 'a reason names the handoff line, and this route does not hand off', params: { fix: 'delete "reason", or write "then: handoff"' } });
  if (o.then === 'form' && o.form === undefined) ctx.addIssue({ code: 'custom', path: where(''), message: 'then: form enters a form, and this route names none', params: { fix: 'add "form: <a form id in forms.yaml>"' } });
  if (o.form !== undefined && o.then !== 'form') ctx.addIssue({ code: 'custom', path: where('form'), message: 'a form is entered only by then: form, and this route does something else', params: { fix: 'delete "form", or write "then: form"' } });
  if (o.then === 'locale' && o.locale === undefined) ctx.addIssue({ code: 'custom', path: where(''), message: 'then: locale switches the language, and this route names none', params: { fix: 'add "locale: <one of the app\'s locales>"' } });
  if (o.locale !== undefined && o.then !== 'locale') ctx.addIssue({ code: 'custom', path: where('locale'), message: 'a locale is switched to only by then: locale, and this route does something else', params: { fix: 'delete "locale", or write "then: locale"' } });
};

/** An outcome written out, as an `else` takes it. */
const routeOutcome = z
  .strictObject(outcomeFields)
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    outcomeRules((key) => (key === '' ? [] : [key]))(value, ctx);
  }))
  .describe('What the else does, written out: { say, then, reason, form, locale }.');

/** One route: `when` and an outcome, or the point's `else`. */
const routeRule = z
  .strictObject({
    when: whenSchema.optional(),
    else: z
      .union([z.literal('continue'), routeOutcome])
      .optional()
      .describe('The point\'s last rule, taken when no rule before it is: "continue" (go on as if no route were written), or an outcome written out ({ say, then, ... }).'),
    say: outcomeFields.say,
    then: outcomeFields.then.optional(),
    reason: outcomeFields.reason,
    form: outcomeFields.form,
    locale: outcomeFields.locale,
  })
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const r = value as Record<string, unknown>;
    if (r.else !== undefined) {
      if (r.when !== undefined) ctx.addIssue({ code: 'custom', path: ['when'], message: 'the else is taken when no rule before it is, and has no when', params: { fix: 'delete "when", or write this rule as when: ..., then: ... and add - else: continue after it' } });
      for (const key of ['say', 'then', 'reason', 'form', 'locale']) {
        if (r[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `the else holds its outcome itself, and "${key}" is beside it`, params: { fix: `write else: { ${key}: ..., then: ... }, or else: continue` } });
      }
      return;
    }
    if (r.when === undefined) ctx.addIssue({ code: 'custom', path: [], message: 'a rule names no when, and is not the else', params: { fix: 'add "when: <a condition>" (for example { hours: closed }), or write it as - else: <outcome> at the end' } });
    if (r.then === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'a rule names no then: what it does', params: { fix: `add "then:", one of ${ROUTE_THEN.join(', ')}` } });
      return;
    }
    outcomeRules((key) => (key === '' ? [] : [key]))(r, ctx);
  }))
  .describe('One route: when (one condition, or a list that must all hold) and what follows (say, then, reason, form, locale); or else, the last.');

const routeList = z
  .array(routeRule)
  .min(1, { error: 'lists no rule' })
  .describe('The rules, tried in order: the first whose conditions all hold is taken. The last is the else, required.');

export const routesSchema = z
  .strictObject({
    start: routeList.optional().describe('Once, as the call starts: after the start hook and the call-start lookup, before the greeting. A say comes before the greeting; end ends without it; form enters the form after the welcome (greeting_offer); anything-else is not taken here.'),
    afterIdentity: routeList.optional().describe('Once, the first time the caller reaches level 1 (verified): after the identity step\'s own line, before the form that asked for it goes on. continue is that form going on.'),
    afterForm: z
      .record(identifier(), routeList)
      .optional()
      .describe('By form: when that form completes as said, before its next. continue is what the form does without a route: its next, else "anything else?".'),
  })
  .describe('routes.yaml: what the call does at its start, after identity and after a form, by ordered rules with an else. Not a state machine: what the caller says still decides every turn.');

export type RoutesYaml = z.infer<typeof routesSchema>;
export type RouteRuleYaml = z.infer<typeof routeRule>;

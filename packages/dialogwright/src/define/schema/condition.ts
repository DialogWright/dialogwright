import { z } from 'zod';
import { checkAlways, identifier, matching, name } from './common';
import { CONDITION_LEVELS, yamlConditionIssues } from '../../core/conditions';
import { ENV_REFERENCE } from '../../core/app/envReference';

/**
 * A condition as YAML writes it (core/conditions.ts reads it into the engine's shape and judges it):
 * one subject, by its key, and for a subject with a value, one test beside it. One schema for every
 * place that chooses by condition: app.yaml's transfer targets and routes.yaml's points.
 */

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const values = z.array(scalar).min(1, { error: 'lists nothing' });
const envRef = () => matching(ENV_REFERENCE, 'is not an environment variable', 'write env.<NAME> (capitals, digits and underscores); the number is set in the server\'s environment (.env), never written in YAML');

export const conditionSchema = z
  .strictObject({
    reason: z
      .union([name(), z.array(name()).min(1, { error: 'lists nothing' })])
      .optional()
      .describe('Holds when the handoff\'s reason is this one, or one of this list (for example emergency, or [live-agent, frustrated]).'),
    form: z
      .union([identifier(), z.array(identifier()).min(1, { error: 'lists nothing' })])
      .optional()
      .describe('Holds when the form the caller is in (or, with none open, the last one completed on the call) is this one, or one of this list.'),
    callData: identifier()
      .optional()
      .describe('A key of app.yaml\'s callData, tested by is, in, notIn or present beside it. A key the call came without fails is, in and notIn, and holds present: false.'),
    fact: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, { error: 'is not a fact\'s name: a plain word, or a dotted path to a nested one (account.tier)' })
      .optional()
      .describe('A value in the session\'s facts (what the app\'s code keeps), by its name or a dotted path to a nested one (account.tier), tested by is, in, notIn or present beside it. A fact that is not set (or null) fails is, in and notIn, and holds present: false; one that is a list or a record is present and equals no value.'),
    slot: identifier()
      .optional()
      .describe('A slot\'s value as the call holds it (a form\'s slot, or one carried), tested by is, in, notIn or present beside it. An empty slot fails is, in and notIn, and holds present: false.'),
    level: z
      .union(CONDITION_LEVELS.map((l) => z.literal(l)) as unknown as [z.ZodLiteral<1>, z.ZodLiteral<2>], { error: `must be ${CONDITION_LEVELS.join(' or ')}` })
      .optional()
      .describe('Holds when the caller is verified to at least this level: 1 (identity.yaml\'s factors) or 2 (the one-time code too).'),
    hours: z
      .enum(['open', 'closed'])
      .optional()
      .describe('Holds when app.yaml\'s hours are open, or closed, at the time of the call; with schedule, a named schedule\'s (hours.schedules). An app with no such hours holds neither.'),
    schedule: identifier()
      .optional()
      .describe('For hours: a schedule named under app.yaml\'s hours.schedules, in place of the default.'),
    called: z
      .union([envRef(), z.array(envRef()).min(1, { error: 'lists nothing' })])
      .optional()
      .describe('Holds when the number called is the value of this environment variable (env.<NAME>), or of one of this list. The number called is kept for every call that has one. The numbers stay in the environment, never in YAML.'),
    named: identifier()
      .optional()
      .describe('Holds when the app\'s predicate of this name (code.predicates) returns true, given the session, read-only: for anything the other conditions cannot say.'),
    is: scalar.optional().describe('For callData, fact or slot: holds when the value is this one.'),
    in: values.optional().describe('For callData, fact or slot: holds when the value is one of these.'),
    notIn: values.optional().describe('For callData, fact or slot: holds when there is a value and it is none of these.'),
    present: z.boolean().optional().describe('For callData, fact or slot: true holds when there is a value, false when there is none.'),
  })
  // The shape rules (one subject, and one test for a subject with a value) are core/conditions.ts's, said once.
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const issue of yamlConditionIssues(value)) ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message, params: { fix: issue.fix } });
  }))
  .describe('One condition: a subject (reason, form, callData, fact, slot, level, hours, called or named) and, for callData, fact and slot, one test (is, in, notIn or present).');

/** A `when`: one condition, or a list of them, which all hold. */
export const whenSchema = z
  .union([conditionSchema, z.array(conditionSchema).min(1, { error: 'lists no condition' })])
  .describe('When the rule is taken: one condition, or a list of them that must all hold.');

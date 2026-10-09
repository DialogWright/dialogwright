import { z } from 'zod';
import { checkAlways, identifier, name } from './common';
import { yamlConditionIssues } from '../../core/conditions';

/**
 * A condition as YAML writes it (core/conditions.ts reads it into the engine's shape and judges it):
 * one subject, by its key, and for a subject with a value, one test beside it. One schema for every
 * place that chooses by condition: app.yaml's transfer targets now, routes.yaml later, whose subjects
 * are added here as keys.
 */

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const values = z.array(scalar).min(1, { error: 'lists nothing' });

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
    is: scalar.optional().describe('For callData: holds when the value is this one.'),
    in: values.optional().describe('For callData: holds when the value is one of these.'),
    notIn: values.optional().describe('For callData: holds when the call has the key and its value is none of these.'),
    present: z.boolean().optional().describe('For callData: true holds when the call came with the key, false when it came without it.'),
  })
  // The shape rules (one subject, and one test for a subject with a value) are core/conditions.ts's, said once.
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const issue of yamlConditionIssues(value)) ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message, params: { fix: issue.fix } });
  }))
  .describe('One condition: a subject (reason, form or callData) and, for callData, one test (is, in, notIn or present).');

/** A `when`: one condition, or a list of them, which all hold. */
export const whenSchema = z
  .union([conditionSchema, z.array(conditionSchema).min(1, { error: 'lists no condition' })])
  .describe('When the rule is taken: one condition, or a list of them that must all hold.');

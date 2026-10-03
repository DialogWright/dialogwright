import { z } from 'zod';
import { identifier, level, matching, name, unique } from '../schema/common';
import { policyWording } from '../schema/policy';

/**
 * policy.yaml and identity.yaml in their old shape: the gate's tables (PolicyTables) and the
 * lifecycle's identity configuration (IdentityConfig) written as they are, rules by id. No app
 * folder reads this shape any more; `dialogwright policy:convert` does, to write the files in the
 * shape that is read (../schema/policy.ts, ../schema/identity.ts).
 */

const roleAccess = z.enum(['allow', 'refuse', 'person']);

const subjectParam = z.strictObject({
  param: identifier(),
  via: z.literal('record').optional(),
});

/** The keys only the old policy.yaml has: a file with any of them and no `actions:` is the old shape. */
export const OLD_POLICY_KEYS = ['toolLevel', 'purposeLevel', 'rulesFor', 'subjects', 'confirmedFields', 'serviceFields', 'maxAttempts', 'roles', 'rolePersonReason'] as const;

/** The old policy.yaml. */
export const oldPolicySchema = z.strictObject({
  toolLevel: z.record(identifier(), level(), { error: 'must be a map from tool name to identity level (0, 1 or 2)' }),
  purposeLevel: z.record(name(), level()).default({}),
  rulesFor: z.record(identifier(), unique(name(), 'rule')),
  subjects: z.record(identifier(), subjectParam).default({}),
  confirmedFields: unique(identifier(), 'confirmed field'),
  serviceFields: z.record(identifier(), unique(identifier(), 'field')).default({}),
  maxAttempts: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }),
  roles: z.record(identifier(), z.record(name(), roleAccess)).optional(),
  rolePersonReason: name().optional(),
  wording: policyWording.optional(),
});
export type OldPolicy = z.infer<typeof oldPolicySchema>;

/** The keys only the old identity.yaml has: a file with any of them and neither `principals:` nor `levels:` is the old shape. */
export const OLD_IDENTITY_KEYS = ['subjectKind', 'delegateKind', 'factorSlots', 'verifyTool', 'codeTool', 'sendCodeTool', 'failedPromptId'] as const;

/** The old identity.yaml. */
export const oldIdentitySchema = z.strictObject({
  subjectKind: matching(/^[a-z][a-z0-9_]*$/, 'is not a valid kind: it must be a lowercase word (letters, digits, underscores)', 'write a lowercase word such as "customer" or "patient"'),
  delegateKind: identifier().optional(),
  factorSlots: unique(identifier(), 'factor slot'),
  verifyTool: identifier(),
  codeTool: identifier(),
  sendCodeTool: identifier(),
  failedPromptId: identifier().optional(),
});
export type OldIdentity = z.infer<typeof oldIdentitySchema>;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether parsed policy.yaml content is the old shape: a map with an old key and no `actions:`. */
export function isOldPolicyContent(value: unknown): boolean {
  return isMap(value) && !Object.hasOwn(value, 'actions') && OLD_POLICY_KEYS.some((k) => Object.hasOwn(value, k));
}

/** Whether parsed identity.yaml content is the old shape: a map with an old key and neither `principals:` nor `levels:`. */
export function isOldIdentityContent(value: unknown): boolean {
  return isMap(value) && !Object.hasOwn(value, 'principals') && !Object.hasOwn(value, 'levels') && OLD_IDENTITY_KEYS.some((k) => Object.hasOwn(value, k));
}

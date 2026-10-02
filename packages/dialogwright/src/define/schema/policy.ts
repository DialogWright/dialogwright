import { z } from 'zod';
import { identifier, level, name, text, unique } from './common';

/**
 * policy.yaml: the gate's tables, the whole of what the app's agent may do. Mirrors App.policy
 * (PolicyTables). Rules are referenced by id: the built-in ones (R1, R2, R3, R5, R6, R7) run as
 * the engine defines them, and an app's own rule is a function in code, named here by the id it
 * registers under. Policy never lives in tool code: a tool without a row here cannot be called.
 */

const roleAccess = z.enum(['allow', 'refuse', 'person']);

const wordingFor = z.strictObject({
  record: text().optional().describe('R2\'s description when the tool names its subject by a record id the gate resolves to its owner.'),
  param: text().optional().describe('R2\'s description when the tool names its subject by the subject\'s own id.'),
});

const wording = z
  .strictObject({
    scope: z
      .strictObject({
        subject: wordingFor.optional().describe('R2\'s description when one of the app\'s subjects asks.'),
        delegate: wordingFor.optional().describe('R2\'s description when a party acting for subjects asks.'),
      })
      .optional()
      .describe("R2's description, by who asks and how the tool names its subject. Default: \"The record belongs to someone this caller may see\"."),
    recordOwner: text().optional().describe('What R2\'s compared line calls the owner of a record. Default "record owner".'),
    subject: text().optional().describe('What R2\'s compared line calls a subject named by id. Default "subject".'),
    role: z
      .strictObject({
        allow: text().optional().describe('R5\'s compared line when the role may use the tool. Write {role} and {tool} where they go. Default "role {role} may {tool}: yes".'),
        refuse: text().optional().describe('R5\'s compared line when the role is refused the tool. Default "role {role} may {tool}: no".'),
        person: text().optional().describe('R5\'s compared line when a person takes the call. Default "role {role} may {tool}: with a person".'),
      })
      .optional()
      .describe("R5's compared line for a role, by what the roles table gives it for the tool, as a template with {role} and {tool}."),
  })
  .describe("The words the gate's built-in rules use in their description and compared lines, so the console and the audit read in the app's terms. Without it, neutral words.");

const subjectParam = z
  .strictObject({
    param: identifier().describe('The tool param that names the subject the call acts on.'),
    via: z.literal('record').optional().describe('"record" when the param is a record id the gate resolves to its owner; leave out when it is the subject\'s own id.'),
  })
  .describe("R2's subject for one tool.");

export const policySchema = z
  .strictObject({
    toolLevel: z
      .record(identifier(), level(), { error: 'must be a map from tool name to identity level (0, 1 or 2)' })
      .describe('The identity level each tool needs: 0 anonymous, 1 the factors matched, 2 the factors and the one-time code. A tool without one needs the highest (fails closed). Every tool in rulesFor needs a row.'),
    purposeLevel: z
      .record(name(), level())
      .default({})
      .describe('The identity level each purpose needs (what a caller wants done before any tool is called). Default: none.'),
    rulesFor: z
      .record(identifier(), unique(name(), 'rule'))
      .describe('Per tool, the rules the gate runs before it, by id: the built-ins (R1 level, R2 scope, R3 confirmation, R5 role, R6 attempts, R7 service fields) or a custom rule the app\'s code registers. Every tool of the app needs a row; a tool without one cannot be called.'),
    subjects: z
      .record(identifier(), subjectParam)
      .default({})
      .describe('R2: per tool, the param that names the subject. A tool that runs R2 needs a row. Default: none.'),
    confirmedFields: unique(identifier(), 'confirmed field').describe('R3: the fields a confirmed write carries, in the order the hash is taken over (for example name, dob, provider, date, time).'),
    serviceFields: z
      .record(identifier(), unique(identifier(), 'field'))
      .default({})
      .describe('R7: per tool, the fields it may send on to a downstream service. A tool with no row sends none. Default: none.'),
    maxAttempts: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).describe('R6: failed attempts allowed at each identity check (the factors, the one-time code).'),
    roles: z
      .record(identifier(), z.record(name(), roleAccess))
      .optional()
      .describe('R5: per tool, what each role of a principal that has one (for example depot staff) may do with it: allow, refuse, or person (a person takes the call). A tool or a role with no row is refused. Without the table, every role is refused.'),
    rolePersonReason: name().optional().describe('R5\'s NEEDS_HUMAN reason when a role\'s access is "person" (for example "staff-filing"). Default "role-person".'),
    wording: wording.optional(),
  })
  .describe('policy.yaml: the gate\'s tables. Custom rule functions stay in code; this file only names them.');

export type PolicyYaml = z.infer<typeof policySchema>;

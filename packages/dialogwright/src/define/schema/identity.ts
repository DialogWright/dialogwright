import { z } from 'zod';
import { identifier, matching, name, text, unique } from './common';

/**
 * identity.yaml: who the app serves and how a caller proves who they are. It compiles to
 * App.identity (IdentityConfig) and the attempts the gate's attempts rule allows
 * (../policyFile.ts). Optional: an app without the file verifies no one, every caller stays
 * anonymous, and every action must be level 0.
 *
 *   principals:
 *     subject: customer
 *     delegates:
 *       agent: { roles: [viewer, clerk] }
 *   levels:
 *     1: { name: verified, factors: [accountId, dob], verify: verifyCustomer, failedPrompt: identity_failed }
 *     2: { name: confirmed by code, factors: [{ otp: { length: 6 } }], send: sendCode, verify: verifyCode }
 *   attempts: 3
 *   signIn: { level: 2 }
 *
 * The ladder is cumulative (level 2 is level 1 and its own factors) and has at most two rungs above
 * level 0, which is anonymous. Levels stay numbers everywhere the engine records them; a level's name
 * is a label. The one-time code's call params (`sendCodeParams`) are a function, and stay in code.
 *
 * An app written before this shape (subjectKind, factorSlots, ... : the lifecycle's identity
 * configuration as it is) is converted with `dialogwright policy:convert`; nothing reads that shape
 * any more.
 */

const KIND = /^[a-z][a-z0-9_]*$/;
const kind = () => matching(KIND, 'is not a valid kind: it must be a lowercase word (letters, digits, underscores)', 'write a lowercase word such as "customer" or "patient"');

const delegate = z
  .strictObject({
    roles: unique(name(), 'role')
      .optional()
      .describe('The roles a party of this kind may have, as the policy\'s role rules name them (for example viewer, clerk). A party with no role, or a role not listed in a rule, is refused what the rule governs.'),
  })
  .describe('One kind of party who acts for the app\'s subjects (for example agent), and the roles one may have.');

const principals = z
  .strictObject({
    subject: kind().describe('The kind of principal the app serves and verifies (for example "customer"). A lowercase word, since it is also an audit detail key. Any other kind but anonymous acts for subjects.'),
    delegates: z
      .record(kind(), delegate)
      .optional()
      .describe('The kinds of party who act for subjects (sign in through a portal, say), by their word (for example agent), each with its roles. One kind for now.'),
  })
  .describe('Who the app serves: its subjects, and the parties who act for them with their roles.');

const otpFactor = z
  .strictObject({
    otp: z
      .strictObject({
        length: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(4, { error: 'must be at least 4' }).max(10, { error: 'must be at most 10' }).optional()
          .describe('How many digits the code has. Default 6.'),
      })
      .describe('A one-time code sent to the contact on file and keyed on the keypad: masked, never traced, never a slot.'),
  })
  .describe('The one-time code factor.');

const level1 = z
  .strictObject({
    name: text().describe('What the level is called, as the policy card says it (for example "verified"). A label: the engine records the number.'),
    factors: unique(identifier(), 'factor slot')
      .min(1, { error: 'must name at least one factor' })
      .describe('The slots asked for a step-up to this level (for example accountId, dob), in this order. Each slot id is also the name of the verify tool\'s param that carries its value.'),
    verify: identifier().describe('The tool that checks the factors (for example verifyCustomer). Its action in policy.yaml runs only the attempts rule.'),
    failedPrompt: identifier().optional().describe('The prompt said before the factors are asked again after a failed match. Default "identity_failed".'),
  })
  .describe('Level 1: the factors matched.');

const level2 = z
  .strictObject({
    name: text().describe('What the level is called, as the policy card says it (for example "confirmed by code"). A label: the engine records the number.'),
    factors: z
      .array(otpFactor)
      .length(1, { error: 'must be the one-time code factor, once' })
      .describe('The factors this level adds to level 1: the one-time code, "[{ otp: { length: 6 } }]".'),
    send: identifier().describe('The tool that sends the one-time code (for example sendCode).'),
    verify: identifier().describe('The tool that checks the code (for example verifyCode).'),
  })
  .describe('Level 2: level 1 and a one-time code.');

export const identitySchema = z
  .strictObject({
    principals,
    levels: z
      .strictObject({
        1: level1,
        2: level2.optional(),
      })
      .describe('The identity ladder above level 0 (anonymous), each level with its factors and the tools that check them. Cumulative: level 2 is level 1 and its own factors.'),
    attempts: z
      .number({ error: 'must be a number' })
      .int({ error: 'must be a whole number' })
      .min(1, { error: 'must be at least 1' })
      .describe('Failed tries allowed at each identity check (the factors, the code) before a person takes the call: what the attempts rule (R6) holds an action to.'),
    signIn: z
      .strictObject({
        level: z.literal([1, 2]).describe('The level a sign-in proves. It must be the top level of the ladder.'),
      })
      .optional()
      .describe('What a sign-in proves, for a channel that can sign a caller in (a web portal): the core checks the capability, never the channel\'s name.'),
  })
  .describe('identity.yaml: who the app serves and how a caller proves who they are. Leave the file out for an app that verifies no one.');

export type IdentityYaml = z.infer<typeof identitySchema>;

import { z } from 'zod';
import { identifier, matching, unique } from './common';

/**
 * identity.yaml: how a caller proves who they are. Mirrors App.identity (IdentityConfig). Optional: an
 * app without the file verifies no one, every caller stays anonymous, and every tool must be level 0.
 * `sendCodeParams` is a function and stays in code.
 */
export const identitySchema = z
  .strictObject({
    subjectKind: matching(/^[a-z][a-z0-9_]*$/, 'is not a valid kind: it must be a lowercase word (letters, digits, underscores)', 'write a lowercase word such as "customer" or "patient"')
      .describe('The principal kind the app serves and verifies (for example "customer"). Any other kind but anonymous acts for subjects. A lowercase word, since it is also an audit detail key.'),
    delegateKind: identifier().optional().describe('The app\'s word for a party who acts for subjects (for example "agent"), as the harness\'s errors name one. Default "delegate".'),
    factorSlots: unique(identifier(), 'factor slot').describe('The slots collected on voice for a step-up (for example accountId, dob), asked in this order. Each slot id is also the name of the verify tool\'s param that carries its value.'),
    verifyTool: identifier().describe('The tool that verifies the factors (for example verifyCustomer).'),
    codeTool: identifier().describe('The tool that checks the one-time code (for example verifyCode).'),
    sendCodeTool: identifier().describe('The tool that texts the one-time code.'),
    failedPromptId: identifier().optional().describe('The prompt (an id in prompts.yaml) said before the factors are asked again after a failed match. Default "identity_failed".'),
  })
  .describe('identity.yaml: how a caller proves who they are. Leave the file out for an app that verifies no one.');

export type IdentityYaml = z.infer<typeof identitySchema>;

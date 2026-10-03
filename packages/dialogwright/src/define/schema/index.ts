/**
 * The schema of every file an app folder can hold. Each kind has a zod schema (the source of truth:
 * validation, inferred types) and a JSON Schema generated from it (./json.ts, committed under
 * packages/dialogwright/schemas/ so an editor or an assistant can read it).
 */
import type { z } from 'zod';
import { appSchema } from './app';
import { FILE_KINDS, type FileKind } from './common';
import { formsSchema } from './forms';
import { identitySchema } from './identity';
import { intentsSchema } from './intents';
import { policySchema } from './policy';
import { promptsSchema } from './prompts';
import { localeSlotsSchema, SLOTS_FILE, slotsSchema } from './slots';

export { appSchema, formsSchema, identitySchema, intentsSchema, localeSlotsSchema, policySchema, promptsSchema, slotsSchema };
export { FILE_KINDS, fixForPattern, type FileKind } from './common';
export type { AppYaml, ConsoleFactYaml } from './app';
export type { FormHook, FormYaml, FormsYaml } from './forms';
export { FORM_HOOKS } from './forms';
export type { IdentityYaml } from './identity';
export type { IntentYaml, IntentsYaml } from './intents';
export type { ActionYaml, BareRule, ParamRule, PolicyYaml, RuleEntryYaml, RuleName } from './policy';
export { BARE_RULES, PARAM_RULES, RULE_NAMES, ruleKey } from './policy';
export type { PromptYaml, PromptsYaml } from './prompts';
export { SLOTS_FILE, CODE_SLOT_TYPE } from './slots';
export type { LocaleSlotsYaml, SlotsYaml } from './slots';

/** The schema for each kind of file. */
export const SCHEMAS = {
  app: appSchema,
  intents: intentsSchema,
  forms: formsSchema,
  prompts: promptsSchema,
  policy: policySchema,
  identity: identitySchema,
} as const satisfies Record<FileKind, z.ZodType>;

/** The file each kind is read from, in the app folder. */
export const FILE_NAMES: Readonly<Record<FileKind, string>> = Object.fromEntries(FILE_KINDS.map((kind) => [kind, `${kind}.yaml`])) as Record<FileKind, string>;

/** Kinds whose file an app must have; identity.yaml is optional (an app without it verifies no one). */
export const REQUIRED_KINDS: readonly FileKind[] = ['app', 'intents', 'forms', 'prompts', 'policy'];

/** Every YAML file the loader reads from the folder itself, in the order problems are sorted: the six kinds, then the optional slots.yaml. */
export const FOLDER_FILES: readonly string[] = [...Object.values(FILE_NAMES), SLOTS_FILE];

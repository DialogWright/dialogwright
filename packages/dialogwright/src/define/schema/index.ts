/**
 * The schema of every file an app folder can hold. Each kind has a zod schema (the source of truth:
 * validation, inferred types) and a JSON Schema generated from it (./json.ts, committed under
 * packages/dialogwright/schemas/ so an editor or an assistant can read it).
 */
import type { z } from 'zod';
import { appSchema } from './app';
import { FILE_KINDS, type FileKind } from './common';
import { formsSchema, localeFormsSchema } from './forms';
import { identitySchema } from './identity';
import { intentsSchema, localeIntentsSchema } from './intents';
import { policySchema } from './policy';
import { promptsSchema } from './prompts';
import { localeSlotsSchema, SLOTS_FILE, slotsSchema } from './slots';
import { routesSchema } from './routes';
import { styleSchema } from './style';

export { appSchema, formsSchema, identitySchema, intentsSchema, localeFormsSchema, localeIntentsSchema, localeSlotsSchema, policySchema, promptsSchema, routesSchema, slotsSchema, styleSchema };
export type { StyleYaml } from './style';
export { DEFAULT_WORDS } from './style';
export { RENDER_SITUATIONS, RENDER_CHANNELS, type RenderSituation, type RenderChannel } from './prompts';
export type { RoutesYaml, RouteRuleYaml } from './routes';
export { FILE_KINDS, fixForPattern, type FileKind } from './common';
export type { AppYaml, ConsoleFactYaml } from './app';
export type { FormHook, FormYaml, FormsYaml, LocaleFormsYaml } from './forms';
export { FORM_HOOKS } from './forms';
export type { IdentityYaml, IdentityFile, IdentityWayYaml } from './identity';
export { normalizeIdentity } from './identity';
export type { IntentYaml, IntentsYaml, LocaleIntentsYaml } from './intents';
export type { ActionYaml, BareRule, DateInRangeYaml, LimitYaml, ListYaml, ParamRule, PolicyYaml, RuleEntryYaml, RuleName } from './policy';
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
  routes: routesSchema,
  style: styleSchema,
} as const satisfies Record<FileKind, z.ZodType>;

/** The file each kind is read from, in the app folder. */
export const FILE_NAMES: Readonly<Record<FileKind, string>> = Object.fromEntries(FILE_KINDS.map((kind) => [kind, `${kind}.yaml`])) as Record<FileKind, string>;

/** Kinds whose file an app must have; identity.yaml is optional (an app without it verifies no one), and so are routes.yaml (an app without it routes nothing) and style.yaml (read only by an app that generates a line). */
export const REQUIRED_KINDS: readonly FileKind[] = ['app', 'intents', 'forms', 'prompts', 'policy'];

/** Every YAML file the loader reads from the folder itself, in the order problems are sorted: the kinds, then the optional slots.yaml. */
export const FOLDER_FILES: readonly string[] = [...Object.values(FILE_NAMES), SLOTS_FILE];

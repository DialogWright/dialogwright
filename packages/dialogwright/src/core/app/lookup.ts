import type { App, FormDef, FormId, IdentityConfig, SlotId, ToolDef, ToolName } from './types';
import type { SlotSpec } from '../slots/types';
import { compiledPolicyOf, type CompiledPolicy } from '../../gate/compiled';

/** An app's form by id; an id the app does not define is a bug, named in the error. */
export function formOf(app: App, id: FormId): FormDef {
  if (!Object.hasOwn(app.forms, id)) throw new Error(`unknown form "${id}" in app "${app.id}"`);
  return app.forms[id] as FormDef;
}

/** An app's slot spec by id; an id the app does not define is a bug, named in the error. */
export function slotSpecOf(app: App, id: SlotId): SlotSpec {
  if (!Object.hasOwn(app.slots, id)) throw new Error(`unknown slot "${id}" in app "${app.id}"`);
  return app.slots[id] as SlotSpec;
}

/** An app's tool by name; a name the app does not define is a bug (the gate blocks it first), named in the error. */
export function toolOf(app: App, name: ToolName): ToolDef {
  if (!Object.hasOwn(app.tools, name)) throw new Error(`unknown tool "${name}" in app "${app.id}"`);
  return app.tools[name] as ToolDef;
}

/**
 * What an app without identity verification (App.identity absent) is read as: no factor slots, no
 * identity tools (an empty name, which no tool has: the gate blocks it, R0), and an empty subject
 * kind, which no subject has (validateApp requires a lowercase word), so no party is ever taken for
 * one of the app's subjects. Such an app never steps up: validateApp refuses any tool above level 0.
 */
const NO_IDENTITY: IdentityConfig = Object.freeze({
  subjectKind: '',
  factorSlots: Object.freeze([]) as unknown as SlotId[],
  verifyTool: '',
  codeTool: '',
  sendCodeTool: '',
});

/** An app's identity config: its own (App.identity), or NO_IDENTITY for an app without one. */
export function identityOf(app: App): IdentityConfig {
  return app.identity ?? NO_IDENTITY;
}

/** How many digits a one-time code has where the identity gives none (IdentityConfig.codeLength). */
export const DEFAULT_CODE_LENGTH = 6;

/** The lengths a one-time code may have: long enough not to be guessed in a few tries, short enough to key. */
export const CODE_LENGTHS = { min: 4, max: 8 } as const;

/** How many digits the app's one-time code has: its identity's codeLength, or 6. */
export function codeLengthOf(app: App): number {
  return identityOf(app).codeLength ?? DEFAULT_CODE_LENGTH;
}

/** Whether the identity's ladder has level 2, the one-time code: both its tools are named. */
export function hasCode(identity: IdentityConfig): identity is IdentityConfig & { codeTool: string; sendCodeTool: string } {
  return !!identity.codeTool && !!identity.sendCodeTool;
}

/** The top of the identity's ladder: 2 with the one-time code, else 1 (a ladder of one rung). */
export function topLevelOf(identity: IdentityConfig): 1 | 2 {
  return hasCode(identity) ? 2 : 1;
}

/**
 * The gate an app's calls go through: its own (App.gate), or the policy its tables were compiled
 * from, for its subject kind (gate/compiled.ts compiledPolicyOf), compiled once.
 */
export function gateOf(app: App): CompiledPolicy {
  return app.gate ?? compiledPolicyOf(app.policy, identityOf(app).subjectKind);
}

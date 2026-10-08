import type { AnythingElseSilence, App, ChangeSlotWithValue, FormDef, HandoffUnconfirmed, FormId, IdentityConfig, Intent, SlotId, ToolDef, ToolName, UnsureIntent } from './types';
import type { SlotListen, SlotSpec } from '../slots/types';
import { compiledPolicyOf, identityToolsOf, type CompiledPolicy } from '../../gate/compiled';

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
 * identity tools (an empty name, which no tool has: the gate blocks it as unlisted), and an empty subject
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

/**
 * Where a slot listens outside a form (SlotSpec.listen): `call` for a slot app.yaml carries
 * (App.carrySlots, shorthand for it), else the slot's own, else `up-front`. Null for an identity
 * factor, which listens as identity says (fia.ts activeSlots) whatever the slot sets.
 */
export function listenOf(app: App, id: SlotId): SlotListen | null {
  if (identityOf(app).factorSlots.includes(id)) return null;
  if (app.carrySlots?.includes(id)) return 'call';
  return app.slots[id]?.listen ?? 'up-front';
}

/**
 * Whether a slot outlasts the form that filled it (session.ts closeForm): one app.yaml carries
 * (App.carrySlots, an identity factor among them), or one that listens for the call.
 */
export function isCarried(app: App, id: SlotId): boolean {
  return app.carrySlots?.includes(id) === true || listenOf(app, id) === 'call';
}

/** What an intent the model is unsure of gets: its own setting (IntentDef.unsure), else the app's (App.unsureIntent), else `confirm`. */
export function unsureOf(app: App, intent: Intent): UnsureIntent {
  return app.intents[intent]?.unsure ?? app.unsureIntent ?? 'confirm';
}

/**
 * The threshold a priority intent is read against, by name (IntentDef.priority): PRIORITY_INTENT
 * for `true`, the one it names otherwise. Null for an intent that is not a priority intent.
 */
export function priorityThresholdOf(app: App, intent: Intent): string | null {
  const priority = app.intents[intent]?.priority;
  if (priority === undefined || priority === false) return null;
  return priority === true ? 'PRIORITY_INTENT' : (priority.threshold ?? 'PRIORITY_INTENT');
}

/**
 * Whether a switch to the priority intent `intent` first corrects what the call holds from the
 * switching turn's words (IntentDef.priority `{ correctsForm: true }`). False for every other intent.
 */
export function correctsFormOf(app: App, intent: Intent): boolean {
  const priority = app.intents[intent]?.priority;
  return typeof priority === 'object' && priority !== null && priority.correctsForm === true;
}

/** What a transfer does with a value the caller never confirmed: the app's (HandoffData.unconfirmed), else `send`. */
export function handoffUnconfirmedOf(app: Pick<App, 'handoff'>): HandoffUnconfirmed {
  return app.handoff?.data?.unconfirmed ?? 'send';
}

/** The app's priority intents (IntentDef.priority), in the order it lists them; empty for most apps. */
export function priorityIntentsOf(app: App): Intent[] {
  return Object.keys(app.intents).filter((id) => priorityThresholdOf(app, id) !== null);
}

/** What the change question's reading does beside a new value at a summary: the app's (App.changeSlotWithValue), else `set-aside`. */
export function changeSlotWithValueOf(app: App): ChangeSlotWithValue {
  return app.changeSlotWithValue ?? 'set-aside';
}

/** What a silence turn right after "anything else?" does: the app's (App.anythingElseSilence), else `repeat`. */
export function anythingElseSilenceOf(app: App): AnythingElseSilence {
  return app.anythingElseSilence ?? 'repeat';
}

/** How many digits a one-time code has where the identity gives none (IdentityConfig.codeLength). */
export const DEFAULT_CODE_LENGTH = 6;

/** The lengths a one-time code may have: long enough not to be guessed in a few tries, short enough to key. */
export const CODE_LENGTHS = { min: 4, max: 8 } as const;

/**
 * A token claim's name, as identity.yaml's `signIn.claim` and IdentityConfig.signInClaim give it:
 * printable characters without spaces (`sub`, `account_id`, a namespaced `https://example.com/account`).
 */
export const SIGN_IN_CLAIM = /^[!-~]{1,200}$/;

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
 * from, for its subject kind and with its identity tools kept for the subject (gate/compiled.ts
 * compiledPolicyOf, identityToolsOf), compiled once.
 */
export function gateOf(app: App): CompiledPolicy {
  const identity = identityOf(app);
  return app.gate ?? compiledPolicyOf(app.policy, identity.subjectKind, identityToolsOf(identity));
}

/**
 * Whether an action is a form's check (policy.yaml `check: true`, PolicyAction.check): a question to
 * the gate only, with no tool, so an ALLOW runs nothing (core/lifecycle.ts callTool).
 */
export function isCheckAction(app: App, tool: ToolName): boolean {
  const actions = gateOf(app).source.actions;
  return Object.hasOwn(actions, tool) && actions[tool]!.check === true;
}

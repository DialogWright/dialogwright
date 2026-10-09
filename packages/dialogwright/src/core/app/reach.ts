import type { IdentityConfig, ToolName } from './types';

/**
 * What the app's forms say they reach: the actions (tools) each form's hooks call through the gate
 * (FormDef.calls, forms.yaml's `calls`), and so which actions no form reaches. An action is reached
 * by a form that lists it, or by the identity flow (the lifecycle calls the identity tools itself,
 * not a form); any other action is dangling: a tool the policy allows that no form can ever ask for.
 *
 * A form's calls are declared for every form or for none. With none declared the app does not say
 * where its calls are made, so nothing is reported as unreached (an app written before `calls`);
 * with some declared, a form that leaves it out is reported, and so is every unreached action.
 */

/** The part of a form this reads. */
export interface FormCalls {
  readonly calls?: readonly ToolName[];
  /** The form's checks (FormDef.checks): each reaches its action, which no `calls` lists. */
  readonly checks?: readonly { readonly action: ToolName }[];
}

/** Where the app's forms stand: whether any declares its calls, the forms that do not, and the actions the declared calls reach. */
export interface Reach {
  /** Whether any form declares `calls`. When false, the app does not say where its calls are made. */
  readonly declared: boolean;
  /** The forms that leave `calls` out while another declares it. */
  readonly undeclared: readonly string[];
  /** Every action some form lists, or checks. */
  readonly reached: ReadonlySet<ToolName>;
}

export function reachOf(forms: Readonly<Record<string, FormCalls>>): Reach {
  const ids = Object.keys(forms);
  const declared = ids.some((id) => forms[id]!.calls !== undefined);
  return {
    declared,
    undeclared: declared ? ids.filter((id) => forms[id]!.calls === undefined) : [],
    reached: new Set(ids.flatMap((id) => [...(forms[id]!.calls ?? []), ...(forms[id]!.checks ?? []).map((c) => c.action)])),
  };
}

/** The tools the identity flow calls itself: the factors' check, and the one-time code's send and check. */
export function identityTools(identity: Pick<IdentityConfig, 'verifyTool' | 'codeTool' | 'sendCodeTool'> | undefined): ToolName[] {
  if (!identity) return [];
  return [identity.verifyTool, identity.codeTool, identity.sendCodeTool].filter((t): t is string => typeof t === 'string' && t !== '');
}

/**
 * The actions no form reaches: those that no form lists and the identity flow does not call. Empty
 * when the app declares no calls (nothing is known), in the policy's order otherwise.
 */
export function unreachedActions(actions: readonly ToolName[], forms: Readonly<Record<string, FormCalls>>, identity: Pick<IdentityConfig, 'verifyTool' | 'codeTool' | 'sendCodeTool'> | undefined): ToolName[] {
  const reach = reachOf(forms);
  if (!reach.declared) return [];
  const flow = new Set(identityTools(identity));
  return actions.filter((tool) => !reach.reached.has(tool) && !flow.has(tool));
}

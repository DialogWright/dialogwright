import { DATE_IN_RANGE_REASONS, LIMIT_REASONS } from '../gate/bounded';
import { NONE_OF_REASON, ONE_OF_REASON, VALUE_MISSING } from '../gate/listed';
import { isDefinedRule } from '../gate/defineRule';
import { DEFAULT_ROLE_PERSON_REASON } from '../gate/lines';
import { handoffPromptId } from '../prompts/render';
import type { LoadedConfig } from './load';
import { readRule } from './policyFile';
import { ruleKey } from './schema/policy';
import { closest, type DataPath } from './problems';

/**
 * A form's checks (forms.yaml `checks`, core/checks.ts) against the rest of the folder and the code:
 * what `check` refuses (checkProblems, run by crossLink, so defineApp refuses it too) and what it only
 * warns of (checkWarnings, run by `dialogwright check`, never by defineApp).
 *
 * Refused: a check whose action is not an action of policy.yaml, or not one marked `check: true`; a
 * `with` slot that is not one of the form's slots, or is an identity factor; a check action that lists
 * a confirmed rule (nothing is confirmed part-way through a form), or needs a level above 0 the form's
 * entry does not prove (a form with an entry call whose purpose, policy.yaml `purposes`, needs that
 * level); a line a check says that prompts.yaml does not have (its read-back `confirm` and its `say`,
 * the handoff line, the form's checksPassed). A `check: true` action with a tool in the code, or no
 * form's checks naming it, is policyFile.ts's and reach's to report.
 *
 * Warned: an `on` reason the action can never give (no rule of it refuses for that reason), so the
 * outcome never applies; and a rule of a check action that no action the form calls names, so the
 * write would not hold what the check held.
 */

/** What a form check problem is reported with: crossLink's own reporters. */
export interface FormCheckInput {
  config: LoadedConfig;
  /** A problem at a YAML path (crossLink's `yaml`). */
  report(file: string, path: DataPath, message: string, fix: string, atKey?: boolean): void;
  /** A prompt the default locale must have (crossLink's `promptExists`). */
  promptExists(file: string, path: DataPath, id: string): void;
}

/** The lines a form's checks say: each outcome's read-back (`confirm`) and `say`, the handoff line of each handoff, and checksPassed. */
export function checkPromptReferences(config: LoadedConfig): { id: string; file: string; path: DataPath }[] {
  const refs: { id: string; file: string; path: DataPath }[] = [];
  for (const [id, form] of Object.entries(config.forms.forms)) {
    (form.checks ?? []).forEach((check, i) => {
      for (const [reason, outcome] of Object.entries(check.on ?? {})) {
        const at: DataPath = ['forms', id, 'checks', i, 'on', reason];
        if (outcome.confirm !== undefined) refs.push({ id: outcome.confirm, file: 'forms.yaml', path: [...at, 'confirm'] });
        if (outcome.say !== undefined) refs.push({ id: outcome.say, file: 'forms.yaml', path: [...at, 'say'] });
        if (outcome.then === 'handoff') refs.push({ id: handoffPromptId(outcome.reason ?? reason), file: 'forms.yaml', path: [...at, outcome.reason !== undefined ? 'reason' : 'then'] });
      }
    });
    if (form.checksPassed !== undefined) refs.push({ id: form.checksPassed, file: 'forms.yaml', path: ['forms', id, 'checksPassed'] });
  }
  return refs;
}

/** The actions some form's checks name. */
export function checkActionsNamed(config: LoadedConfig): Set<string> {
  return new Set(Object.values(config.forms.forms).flatMap((form) => (form.checks ?? []).map((c) => c.action)));
}

/** The refusals: see the module comment. */
export function checkProblems(c: FormCheckInput): void {
  const { config, report } = c;
  const actions = config.policy.actions;
  const factors = new Set(config.identity?.levels[1].factors ?? []);
  const hooksOf = (form: string): readonly string[] => config.forms.forms[form]?.hooks ?? [];
  for (const [id, form] of Object.entries(config.forms.forms)) {
    (form.checks ?? []).forEach((check, i) => {
      const at: DataPath = ['forms', id, 'checks', i];
      const action = Object.hasOwn(actions, check.action) ? actions[check.action]! : undefined;
      if (!action) {
        const guess = closest(check.action, Object.keys(actions));
        report('forms.yaml', [...at, 'action'], `form "${id}" checks "${check.action}", which is not an action in policy.yaml`, `${guess ? `rename it to "${guess}", or ` : ''}add "${check.action}:" under actions in policy.yaml with "check: true", its level and its rules`);
      } else if (action.check !== true) {
        report('forms.yaml', [...at, 'action'], `form "${id}" checks "${check.action}", which is an action with a tool, not a check`, `add "check: true" to actions.${check.action} in policy.yaml (and delete its tool from the code), or check an action that has it`);
      } else {
        const level = action.level ?? 2;
        const purpose = config.policy.purposes[id]?.level ?? 0;
        const proven = hooksOf(id).includes('entry') ? purpose : 0;
        if (level > proven) {
          report(
            'policy.yaml',
            action.level !== undefined ? ['actions', check.action, 'level'] : ['actions', check.action],
            `check "${check.action}" of form "${id}" needs identity level ${level}, which the form's entry does not prove first, so the check could only go to a person`,
            hooksOf(id).includes('entry')
              ? `set it to ${proven}, or raise the form's purpose to level ${level} (policy.yaml purposes: ${id}: { level: ${level} })`
              : `set it to 0, or give the form an entry call with a purpose of level ${level} (policy.yaml purposes: ${id}: { level: ${level} })`,
            action.level === undefined,
          );
        }
      }
      check.with.forEach((slot, j) => {
        if (factors.has(slot)) {
          report('forms.yaml', [...at, 'with', j], `check "${check.action}" reads "${slot}", an identity factor`, 'check the form\'s own slots: identity is proven by the entry call, never by a check');
        } else if (!form.slots.includes(slot)) {
          report('forms.yaml', [...at, 'with', j], `check "${check.action}" reads "${slot}", which is not one of form "${id}"'s slots`, `${closest(slot, form.slots) ? `rename it to "${closest(slot, form.slots)}", or ` : ''}add "${slot}" to the form's slots`);
        }
      });
    });
  }
  const named = checkActionsNamed(config);
  for (const [tool, action] of Object.entries(actions)) {
    if (action.check !== true) continue;
    if (!named.has(tool)) report('policy.yaml', ['actions', tool], `check "${tool}" is named by no form's checks, so the gate is never asked it`, `add "- action: ${tool}" with the slots it reads to the checks of a form in forms.yaml, or delete the action`, true);
    // What the check is sent: the slots every form's check of it reads (`with`), each as the param of its name.
    const sent = [...new Set(Object.values(config.forms.forms).flatMap((form) => (form.checks ?? []).filter((x) => x.action === tool).flatMap((x) => x.with)))];
    action.rules.forEach((entry, i) => {
      const rule = readRule(entry);
      if (rule.rule === 'confirmed') {
        report('policy.yaml', ['actions', tool, 'rules', i], `check "${tool}" runs the confirmed rule, but nothing is confirmed part-way through a form, so it would refuse every time`, 'delete the rule: the write the form makes at its completion holds what the caller confirmed');
      } else if ((rule.rule === 'oneOf' || rule.rule === 'noneOf' || rule.rule === 'dateInRange' || rule.rule === 'limit') && named.has(tool) && !sent.includes(rule.field)) {
        // A rule on a param the check is never sent refuses every time (value-missing, not-a-date, ...).
        const guess = closest(rule.field, sent);
        report('policy.yaml', ['actions', tool, 'rules', i, rule.rule, 'field'], `check "${tool}" holds "${rule.field}", which no form's check of it reads (with: ${sent.join(', ') || 'none'}), so it would refuse every time`, `${guess ? `rename it to "${guess}", or ` : ''}add "${rule.field}" to the check's \`with\` in forms.yaml`);
      }
    });
  }
  for (const ref of checkPromptReferences(config)) c.promptExists(ref.file, ref.path, ref.id);
}

/**
 * The reasons an action can refuse for: each built-in rule's (with a range rule's own `reasons`),
 * and each custom rule's from the refusals its examples expect (gate/defineRule.ts). A custom rule
 * not made with defineRule says nothing of its reasons: null, so no `on` key is warned of.
 */
function reasonsOf(rules: readonly unknown[], customRules: Readonly<Record<string, unknown>>): Set<string> | null {
  const out = new Set<string>();
  for (const entry of rules) {
    const rule = readRule(entry as never);
    switch (rule.rule) {
      case 'identity': out.add('identity'); break;
      case 'scope': out.add('scope'); break;
      case 'confirmed': out.add('confirmation'); break;
      case 'role': out.add('role'); out.add(rule.reason ?? DEFAULT_ROLE_PERSON_REASON); break;
      case 'attempts': out.add('attempts'); break;
      case 'fields': out.add('minimization'); break;
      case 'dateInRange': for (const r of Object.values({ ...DATE_IN_RANGE_REASONS, ...rule.reasons })) out.add(r); break;
      case 'limit': for (const r of Object.values({ ...LIMIT_REASONS, ...rule.reasons })) out.add(r); break;
      case 'oneOf': out.add(rule.reason ?? ONE_OF_REASON); out.add(VALUE_MISSING); break;
      case 'noneOf': out.add(rule.reason ?? NONE_OF_REASON); out.add(VALUE_MISSING); break;
      case 'custom': {
        const defined = Object.hasOwn(customRules, rule.id) ? customRules[rule.id] : undefined;
        if (!isDefinedRule(defined)) return null;
        for (const ex of defined.examples) if (ex.expect.reason !== undefined) out.add(ex.expect.reason);
        break;
      }
    }
  }
  return out;
}

/** The warnings: see the module comment. `customRules` are the code's (AppCode.customRules). */
export function checkWarnings(c: Omit<FormCheckInput, 'promptExists'>, customRules: Readonly<Record<string, unknown>>): void {
  const { config, report } = c;
  const actions = config.policy.actions;
  for (const [id, form] of Object.entries(config.forms.forms)) {
    (form.checks ?? []).forEach((check, i) => {
      const action = Object.hasOwn(actions, check.action) ? actions[check.action]! : undefined;
      if (!action || action.check !== true) return;
      const reasons = reasonsOf(action.rules, customRules);
      if (reasons !== null) {
        // Where the reason could come from: a custom rule's examples, or a list or range rule's own reason.
        const custom = action.rules.some((entry) => readRule(entry).rule === 'custom');
        for (const reason of Object.keys(check.on ?? {})) {
          if (reasons.has(reason)) continue;
          const guess = closest(reason, [...reasons]);
          const give = custom ? 'add an example to the custom rule that refuses for it' : 'give it as the reason of the rule that refuses (a list or range rule\'s `reason`)';
          report('forms.yaml', ['forms', id, 'checks', i, 'on', reason], `check "${check.action}" never refuses for "${reason}" (its rules refuse for ${[...reasons].map((r) => `"${r}"`).join(', ') || 'nothing'}), so this outcome never applies`, `${guess ? `rename it to "${guess}", or ` : ''}${give}, or delete it`, true);
        }
      }
      // Defence in depth: the write the form makes names every rule the check holds the caller to.
      const calls = form.calls ?? [];
      if (calls.length === 0) return;
      const written = new Set(calls.flatMap((tool) => (Object.hasOwn(actions, tool) ? actions[tool]!.rules.map(ruleKey) : [])));
      action.rules.forEach((entry, j) => {
        const key = ruleKey(entry);
        if (key === null || key === 'identity' || written.has(key)) return;
        report('policy.yaml', ['actions', check.action, 'rules', j], `check "${check.action}" holds form "${id}" to "${key}", which no action the form calls (${calls.join(', ')}) runs, so the write would not hold what the check held`, `add "${key}" to the rules of the action the form writes with, so the completion still refuses what the check refused`);
      });
    });
  }
}

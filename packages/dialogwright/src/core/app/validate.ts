import { isRuleId } from '../../gate/policy';
import { askedQuestionIdClashes, clashMessage, declaredQuestionIdClashes } from '../questionIds';
import { askedQuestionIds, probeContexts } from './probeQuestions';
import { unknownSlotThresholds, unknownThresholdMessage } from '../slotThresholds';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { CONFIG_HASH, combinedConfigHash } from './configHash';
import { CODE_LENGTHS, topLevelOf } from './lookup';
import type { App, ConfigHashes } from './types';

/** Words a subject kind may not be: the anonymous kind, and the audit detail keys a subject's id is recorded beside. */
const RESERVED_KINDS: readonly string[] = ['anonymous', 'channel', 'principal', 'level', 'factor', 'pass', 'config', 'configFiles'];

/** A subject kind is a plain lowercase word: it is also an audit detail key (core/audit.ts). */
const SUBJECT_KIND = /^[a-z][a-z0-9_]*$/;

/**
 * The element ids the console page (src/server/dashboard/page.html) already uses: an app's header
 * link may not take one, since the link's button would shadow a panel. src/server/dashboard/meta.test.ts
 * checks this list against the page, so it cannot go stale unseen.
 */
export const CONSOLE_ELEMENT_IDS: readonly string[] = [
  'audit', 'back', 'beat', 'beatwrap', 'channel', 'conn', 'conv-aside', 'conv-script', 'conv-turns', 'conversation', 'dot', 'gate', 'handoff',
  'level', 'mode-live', 'mode-replay', 'note', 'now', 'perception', 'play', 'pos', 'presenter', 'rename', 'replaybar', 'reset', 'source',
  'speed', 'speedwrap', 'status', 'step', 'totals', 'trace',
];

/** A console link's id becomes an element id: a lowercase word, hyphens allowed. */
const LINK_ID = /^[a-z][a-z0-9-]*$/;

/** The intents the engine reads by name that every app defines: handing off and replaying the last prompt. */
export const REQUIRED_CONTROL_INTENTS = ['agent', 'repeat_prompt'] as const;

/**
 * The intents the engine reads by name: the required ones, and `done` (the caller is finished, and
 * the call ends with the goodbye), which an app may leave out: its calls then end at a completion,
 * a handoff or a hang-up.
 */
export const CONTROL_INTENTS = [...REQUIRED_CONTROL_INTENTS, 'done'] as const;

/**
 * Checks an app's internal references so a broken one fails when it is registered, not mid-call.
 * Throws on the first problem, naming the app and the bad id.
 */
export function validateApp(app: App): void {
  const fail = (msg: string): never => {
    throw new Error(`app "${app.id}": ${msg}`);
  };
  for (const [formId, form] of Object.entries(app.forms)) {
    for (const slot of form.slots) if (!Object.hasOwn(app.slots, slot)) fail(`form "${formId}" has unknown slot "${slot}"`);
  }
  for (const slot of app.identity?.factorSlots ?? []) if (!Object.hasOwn(app.slots, slot)) fail(`identity factor slot "${slot}" is not a slot`);
  for (const slot of app.carrySlots ?? []) if (!Object.hasOwn(app.slots, slot)) fail(`carried slot "${slot}" is not a slot`);
  // A slot that declares its question ids (SlotSpec.questionIds) is checked here.
  for (const clash of declaredQuestionIdClashes(app.slots)) fail(clashMessage(clash));
  // What each slot asks, tried on a few made-up turns: a hand-written slot that asks the engine's or
  // another slot's id, or one its questionIds leave out, is refused here rather than on that turn.
  const locales = app.locales ? [app.locales.default, ...Object.keys(app.locales.prompts ?? {})] : [];
  const asked = askedQuestionIds(app.slots, probeContexts(locales, app.thresholds ?? {}));
  for (const clash of askedQuestionIdClashes(app.slots, asked)) fail(clashMessage(clash));
  // A threshold a slot's options name must exist, as the engine's or as one of the app's own (App.thresholds).
  for (const u of unknownSlotThresholds(app.slots, app.thresholds)) fail(`${unknownThresholdMessage(u)} (App.thresholds)`);
  if (app.locales) {
    if (typeof app.locales.default !== 'string' || app.locales.default === '') fail('locales has no default locale');
    // The default locale's lines are the manifest; a second copy would be one that is never read.
    for (const locale of Object.keys(app.locales.prompts)) if (locale.toLowerCase() === app.locales.default.toLowerCase()) fail(`locale "${locale}" is the default locale, whose lines are prompts.manifest`);
  }
  if (app.configHashes !== undefined) {
    const hashes: Partial<ConfigHashes> = typeof app.configHashes === 'object' && app.configHashes !== null ? app.configHashes : {};
    const files = hashes.files;
    if (typeof files !== 'object' || files === null || Object.keys(files).length === 0) return fail('configHashes has no files');
    for (const [file, hash] of Object.entries(files)) {
      // A file is one `<file>:<hash>` line of the combined hash: no colon, no line break.
      if (file === '' || /[:\n]/.test(file)) fail(`configHashes file "${file}" is not a file path`);
      if (typeof hash !== 'string' || !CONFIG_HASH.test(hash)) fail(`configHashes file "${file}" has no SHA-256 hash (64 lowercase hex characters)`);
    }
    if (typeof hashes.app !== 'string' || !CONFIG_HASH.test(hashes.app)) fail('configHashes has no combined SHA-256 hash (64 lowercase hex characters)');
    // The combined hash is the files' own, so a call_started row's lines and its combined hash cannot disagree.
    if (hashes.app !== combinedConfigHash(files)) fail("configHashes' combined hash is not the hash of its files' hashes");
  }
  for (const [name, value] of Object.entries(app.thresholds ?? {})) {
    if (Object.hasOwn(DEFAULT_THRESHOLDS, name)) fail(`threshold "${name}" is one of the engine's`);
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`threshold "${name}" is not a number`);
  }
  const change = app.wording?.changeSlot;
  for (const slot of change?.order ?? []) {
    if (!Object.hasOwn(app.slots, slot)) fail(`wording's changeSlot order has unknown slot "${slot}"`);
    if (change?.text && !Object.hasOwn(change.text, slot)) fail(`wording's changeSlot order has slot "${slot}" with no text`);
  }
  for (const slot of Object.keys(change?.text ?? {})) if (!(change?.order ?? []).includes(slot)) fail(`wording's changeSlot text has slot "${slot}", which is not in its order`);
  for (const { digit, intent } of app.menu) if (!Object.hasOwn(app.intents, intent)) fail(`menu digit "${digit}" has unknown intent "${intent}"`);
  for (const [id, def] of Object.entries(app.intents)) {
    if (def.kind === 'form' && !Object.hasOwn(app.forms, id)) fail(`form intent "${id}" has no form`);
    if (def.kind === 'informational' && !def.promptId) fail(`informational intent "${id}" has no promptId`);
  }
  for (const id of Object.keys(app.forms)) {
    if (!Object.hasOwn(app.intents, id) || app.intents[id]?.kind !== 'form') fail(`form "${id}" has no form intent`);
  }
  for (const id of REQUIRED_CONTROL_INTENTS) if (!Object.hasOwn(app.intents, id)) fail(`missing control intent "${id}"`);
  const { rulesFor, toolLevel, purposeLevel, roles, subjects, customRules } = app.policy;
  for (const [id, rule] of Object.entries(customRules ?? {})) {
    if (isRuleId(id) || id === 'R0') fail(`policy's custom rule "${id}" has a built-in rule's id`);
    if (typeof rule !== 'function') fail(`policy's custom rule "${id}" is not a function`);
  }
  for (const [tool, ids] of Object.entries(rulesFor)) {
    if (!Object.hasOwn(app.tools, tool)) fail(`policy has rules for tool "${tool}", which is not a tool`);
    for (const id of ids) {
      if (!isRuleId(id) && !(customRules && Object.hasOwn(customRules, id))) fail(`policy for tool "${tool}" names unknown rule "${id}"`);
    }
    if (ids.includes('R2') && !Object.hasOwn(subjects, tool)) fail(`policy for tool "${tool}" runs R2 but names no subject`);
  }
  for (const [tool, row] of Object.entries(subjects)) {
    if (!Object.hasOwn(rulesFor, tool)) fail(`policy has a subject for tool "${tool}", which has no rules`);
    if (typeof row?.param !== 'string' || row.param === '') fail(`policy's subject for tool "${tool}" names no param`);
    if (row.via !== undefined && row.via !== 'record') fail(`policy's subject for tool "${tool}" has an unknown via "${String(row.via)}"`);
  }
  if (!app.identity) {
    // Fails closed: an app that verifies no one has nothing to step up to, so no call may need a
    // level above 0 (a tool with no level needs the highest).
    for (const tool of Object.keys(rulesFor)) {
      const level = Object.hasOwn(toolLevel, tool) ? toolLevel[tool] : undefined;
      if (level !== 0) fail(`tool "${tool}" needs identity level ${level ?? '2 (it has none)'}, and the app has no identity`);
    }
    for (const [purpose, level] of Object.entries(purposeLevel)) {
      if (level !== 0) fail(`purpose "${purpose}" needs identity level ${level}, and the app has no identity`);
    }
  } else {
    // Not the anonymous kind, and not a word the audit's identity details already use: a subject is
    // recorded under their kind's own word (core/audit.ts), beside these.
    const { subjectKind } = app.identity;
    if (typeof subjectKind !== 'string' || !SUBJECT_KIND.test(subjectKind)) fail(`identity subjectKind "${String(subjectKind)}" is not a lowercase word`);
    if (RESERVED_KINDS.includes(subjectKind)) fail(`identity subjectKind "${subjectKind}" is reserved`);
    const identity = app.identity;
    const { verifyTool, codeTool, sendCodeTool } = identity;
    // Level 2's tools come together: the code is sent and checked, or there is no code (a ladder of one rung).
    if ((codeTool === undefined) !== (sendCodeTool === undefined)) fail(`identity names ${codeTool === undefined ? 'a sendCodeTool but no codeTool' : 'a codeTool but no sendCodeTool'}; level 2 needs both, a ladder of one rung neither`);
    for (const [role, tool] of [['verifyTool', verifyTool], ['codeTool', codeTool], ['sendCodeTool', sendCodeTool]] as const) {
      if (tool === undefined) continue;
      if (!Object.hasOwn(app.tools, tool)) fail(`identity ${role} "${tool}" is not a tool`);
      if (!Object.hasOwn(rulesFor, tool)) fail(`identity ${role} "${tool}" has no rules in the policy`);
    }
    const top = topLevelOf(identity);
    if (top === 1) {
      // Fails closed, as for an app with no identity: a ladder without the code has no level 2, so no
      // call may need it (a tool with no level needs the highest), and the lifecycle never sends a code.
      for (const tool of Object.keys(rulesFor)) {
        const level = Object.hasOwn(toolLevel, tool) ? toolLevel[tool] : undefined;
        if (level === undefined || level > 1) fail(`tool "${tool}" needs identity level ${level ?? '2 (it has none)'}, and the identity's ladder stops at level 1 (it has no one-time code)`);
      }
      for (const [purpose, level] of Object.entries(purposeLevel)) {
        if (level > 1) fail(`purpose "${purpose}" needs identity level ${level}, and the identity's ladder stops at level 1 (it has no one-time code)`);
      }
    }
    const { codeLength, levelNames, maxAttempts } = identity;
    if (codeLength !== undefined) {
      if (top === 1) fail(`identity has a codeLength (${codeLength}) but no one-time code`);
      if (!Number.isInteger(codeLength) || codeLength < CODE_LENGTHS.min || codeLength > CODE_LENGTHS.max) fail(`identity codeLength ${String(codeLength)} is not a whole number from ${CODE_LENGTHS.min} to ${CODE_LENGTHS.max}`);
    }
    if (levelNames !== undefined) {
      const names = top === 2 ? [levelNames[1], levelNames[2]] : [levelNames[1]];
      for (const [i, name] of names.entries()) if (typeof name !== 'string' || name.trim() === '') fail(`identity level ${i + 1} has no name`);
      if (top === 1 && levelNames[2] !== undefined) fail(`identity names a level 2 ("${levelNames[2]}"), and the ladder stops at level 1`);
      if (top === 2 && levelNames[1].trim().toLowerCase() === levelNames[2]!.trim().toLowerCase()) fail(`identity levels 1 and 2 are both called "${levelNames[1]}"`);
    }
    // identity.yaml's attempts are the attempts rule's: a policy compiled without them would hold the checks to another number.
    if (maxAttempts !== undefined && app.policy.maxAttempts !== maxAttempts) fail(`policy's maxAttempts (${app.policy.maxAttempts}) is not identity.yaml's attempts (${maxAttempts}); compile the policy with the identity (definePolicy's identity option)`);
  }
  for (const tool of Object.keys(toolLevel)) if (!Object.hasOwn(rulesFor, tool)) fail(`policy has a level for tool "${tool}", which has no rules`);
  const seenLinks = new Set<string>();
  for (const { id } of app.console?.links ?? []) {
    if (typeof id !== 'string' || !LINK_ID.test(id)) fail(`console link id "${String(id)}" is not a lowercase word`);
    if (CONSOLE_ELEMENT_IDS.includes(id)) fail(`console link id "${id}" is an element id the console page already uses`);
    if (seenLinks.has(id)) fail(`console link id "${id}" is used twice`);
    seenLinks.add(id);
  }
  for (const tool of Object.keys(roles ?? {})) if (!Object.hasOwn(rulesFor, tool)) fail(`policy has roles for tool "${tool}", which has no rules`);
}

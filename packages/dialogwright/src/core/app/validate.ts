import { isRuleId } from '../../gate/policy';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { CONFIG_HASH, combinedConfigHash } from './configHash';
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
    const { verifyTool, codeTool, sendCodeTool } = app.identity;
    for (const [role, tool] of [['verifyTool', verifyTool], ['codeTool', codeTool], ['sendCodeTool', sendCodeTool]] as const) {
      if (!Object.hasOwn(app.tools, tool)) fail(`identity ${role} "${tool}" is not a tool`);
      if (!Object.hasOwn(rulesFor, tool)) fail(`identity ${role} "${tool}" has no rules in the policy`);
    }
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

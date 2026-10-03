import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, LineCounter, Pair, Scalar, YAMLMap, YAMLSeq, isMap, isNode, isScalar, parseDocument, type Node } from 'yaml';
import { z } from 'zod';
import type { IdentityConfig, PolicyTables, RoleAccess } from '../../core/app/types';
import type { JsonSchema } from '../schema/json';
import { formatProblem, problemsOfIssues, type Problem } from '../problems';
import { DEFAULT_CODE_LENGTH, DEFAULT_MAX_ATTEMPTS, DEFAULT_ROLE_TEMPLATES, RULE_ID_OF } from '../policyFile';
import { identitySchema } from '../schema/identity';
import { policySchema } from '../schema/policy';
import {
  isOldIdentityContent, isOldPolicyContent, oldIdentitySchema, oldPolicySchema, type OldIdentity, type OldPolicy,
} from './legacyShape';

/**
 * `dialogwright policy:convert`: policy.yaml and identity.yaml from the old shape (the gate's
 * tables and the identity configuration, written as they are) to the new one (actions with named
 * rules, principals and levels), with the same decisions.
 *
 * It reads an app folder's old files (keeping their comments where the YAML document allows) or a
 * PolicyTables and an IdentityConfig, such as an app that is not a folder wrote in TypeScript.
 * Whatever the old shape said that no rule reads cannot be written in the new one: a subject for an
 * action that runs no scope rule, the roles of one that runs no role rule, and so on. Those rows
 * are dropped, and every one is reported, since they are what a person should look at before the
 * old file goes. What the old shape cannot say at all (an action's `say`, a level's name) is left
 * for the person to write: levels are named "verified" and "confirmed by code".
 *
 * What is written compiles to the same tables less the dropped rows (compilePolicy,
 * compileIdentity); the tests prove it for every app the repository has.
 */

/** What cannot be converted: each problem is a line saying what and how to change the old file. */
export class ConvertError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'ConvertError';
  }
}

export interface ConvertOptions {
  /**
   * Where the schemas are, as a path from the folder the files will be in: written as the files'
   * first line (`# yaml-language-server: $schema=<dir>/policy.schema.json`), so an editor checks
   * them. Default: no such line, unless the old file had one, which is kept.
   */
  schemaDir?: string;
  /** Write `signIn: { level: 2 }`, for an app whose channel can sign a caller in (the old shape cannot say it). */
  signIn?: boolean;
}

/** The converted files, as documents, and what the conversion left out. */
export interface Conversion {
  policy: Document;
  /** Null when the app has no identity (the old shape had no identity.yaml). */
  identity: Document | null;
  /** The old rows no rule reads, each as one line: what was dropped and why. */
  dropped: string[];
  /** Comments of the old files that could not be placed in the new ones, each with where it was: put these back by hand. */
  unplaced: string[];
}

// ---------------------------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Converted {
  policy: Json;
  identity: Json | null;
  dropped: string[];
}

const ID_OF_NAME = Object.fromEntries(Object.entries(RULE_ID_OF).map(([rule, id]) => [id, rule]));

/** One rule of the new shape, as data. */
function ruleOf(id: string, tool: string, old: OldPolicy, problems: string[], used: Used): unknown {
  switch (ID_OF_NAME[id]) {
    case 'identity':
      return 'identity';
    case 'attempts':
      return 'attempts';
    case 'scope': {
      const subject = Object.hasOwn(old.subjects, tool) ? old.subjects[tool] : undefined;
      if (!subject) {
        problems.push(`rulesFor.${tool}: "${tool}" runs R2 but has no row under subjects, so the rule can only refuse; the scope rule needs the param that names the subject -> add "${tool}: { param: <the param> }" under subjects, or take R2 out of its rules`);
        return null;
      }
      used.scope.add(tool);
      return { scope: subject.via === 'record' ? { record: subject.param } : { param: subject.param } };
    }
    case 'confirmed':
      if (old.confirmedFields.length === 0) {
        problems.push(`rulesFor.${tool}: "${tool}" runs R3, but confirmedFields is empty, so the rule blocks every call; the confirmed rule needs at least one field -> list the fields in confirmedFields, or take R3 out of its rules`);
        return null;
      }
      used.confirmed = true;
      return { confirmed: [...old.confirmedFields] };
    case 'role': {
      const row = Object.hasOwn(old.roles ?? {}, tool) ? old.roles![tool]! : {};
      if (Object.keys(row).length === 0) {
        problems.push(`rulesFor.${tool}: "${tool}" runs R5 but has no roles row, so only a subject passes it; the role rule needs the roles it governs -> add "${tool}: { <role>: allow | refuse | person }" under roles, or take R5 out of its rules`);
        return null;
      }
      used.role.add(tool);
      const person = Object.values(row).includes('person');
      if (person) used.reason = true;
      return { role: { ...row, ...(person && old.rolePersonReason !== undefined ? { reason: old.rolePersonReason } : {}) } };
    }
    case 'fields':
      used.fields.add(tool);
      return { fields: [...(Object.hasOwn(old.serviceFields, tool) ? old.serviceFields[tool]! : [])] };
    default:
      return { custom: id };
  }
}

/** What the rules of the new shape read of the old tables: the rest is dropped. */
interface Used {
  scope: Set<string>;
  role: Set<string>;
  fields: Set<string>;
  confirmed: boolean;
  reason: boolean;
}

/** The old files' meaning as the new files' data, and the rows that meant nothing. */
function convertData(old: { policy: OldPolicy; identity: OldIdentity | null }, options: ConvertOptions): Converted {
  const { policy, identity } = old;
  const problems: string[] = [];
  const dropped: string[] = [];
  const used: Used = { scope: new Set(), role: new Set(), fields: new Set(), confirmed: false, reason: false };

  const actions: Record<string, Json> = {};
  for (const [tool, ids] of Object.entries(policy.rulesFor)) {
    const rules = ids.map((id) => ruleOf(id, tool, policy, problems, used));
    actions[tool] = {
      ...(Object.hasOwn(policy.toolLevel, tool) ? { level: policy.toolLevel[tool] } : {}),
      rules,
    };
  }
  if (problems.length > 0) throw new ConvertError(problems);

  const hasRules = (tool: string): boolean => Object.hasOwn(policy.rulesFor, tool);
  const drop = (table: string, tool: string, rule: string, rulesId: string, value: string): void => {
    dropped.push(
      hasRules(tool)
        ? `${table}.${tool} (${value}): "${tool}" runs no ${rule} rule (${rulesId}), so nothing reads it`
        : `${table}.${tool} (${value}): "${tool}" has no row under rulesFor, so it can never be called`,
    );
  };
  for (const [tool, level] of Object.entries(policy.toolLevel)) {
    if (!hasRules(tool)) dropped.push(`toolLevel.${tool} (${level}): "${tool}" has no row under rulesFor, so it can never be called`);
  }
  for (const [tool, subject] of Object.entries(policy.subjects)) {
    if (!used.scope.has(tool)) drop('subjects', tool, 'scope', 'R2', `${subject.param}${subject.via === 'record' ? ', a record' : ''}`);
  }
  for (const [tool, fields] of Object.entries(policy.serviceFields)) {
    if (!used.fields.has(tool)) drop('serviceFields', tool, 'fields', 'R7', fields.join(', '));
  }
  for (const [tool, row] of Object.entries(policy.roles ?? {})) {
    if (!used.role.has(tool)) drop('roles', tool, 'role', 'R5', Object.entries(row).map(([r, a]) => `${r}: ${a}`).join(', '));
  }
  if (policy.rolePersonReason !== undefined && !used.reason) {
    dropped.push(`rolePersonReason (${policy.rolePersonReason}): no role rule hands a call to a person, so no call goes to a person for that reason`);
  }
  if (policy.confirmedFields.length > 0 && !used.confirmed) {
    dropped.push(`confirmedFields (${policy.confirmedFields.join(', ')}): no action runs the confirmed rule (R3)`);
  }
  if (identity === null && policy.maxAttempts !== DEFAULT_MAX_ATTEMPTS) {
    dropped.push(`maxAttempts (${policy.maxAttempts}): the app has no identity file, so no identity check counts tries; the attempts live in identity.yaml`);
  }

  const out: Json = { actions };
  if (Object.keys(policy.purposeLevel).length > 0) out.purposes = Object.fromEntries(Object.entries(policy.purposeLevel).map(([purpose, level]) => [purpose, { level }]));
  if (policy.wording && Object.keys(policy.wording).length > 0) out.wording = policy.wording;

  let identityOut: Json | null = null;
  if (identity) {
    // The roles a delegate may have are every role the old roles table names, dropped rows included.
    const roles = [...new Set(Object.values(policy.roles ?? {}).flatMap((row) => Object.keys(row)))];
    const delegateKind = identity.delegateKind ?? (roles.length > 0 ? 'delegate' : undefined);
    identityOut = {
      principals: {
        subject: identity.subjectKind,
        ...(delegateKind !== undefined ? { delegates: { [delegateKind]: roles.length > 0 ? { roles } : {} } } : {}),
      },
      levels: {
        1: { name: 'verified', factors: [...identity.factorSlots], verify: identity.verifyTool, ...(identity.failedPromptId !== undefined ? { failedPrompt: identity.failedPromptId } : {}) },
        2: { name: 'confirmed by code', factors: [{ otp: { length: DEFAULT_CODE_LENGTH } }], send: identity.sendCodeTool, verify: identity.codeTool },
      },
      attempts: policy.maxAttempts,
      ...(options.signIn ? { signIn: { level: 2 } } : {}),
    };
  }

  // The new files must be valid: a value the old shape allowed and the new one does not is a problem, not a file that fails later.
  const bad = [...issues('policy.yaml', policySchema, out), ...(identityOut ? issues('identity.yaml', identitySchema, identityOut) : [])];
  if (bad.length > 0) throw new ConvertError(bad);
  return { policy: out, identity: identityOut, dropped };
}

/** What a schema finds wrong with data, as lines. */
function issues(file: string, schema: z.ZodType, data: unknown): string[] {
  const parsed = schema.safeParse(data);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${file}: the converted ${issue.path.join('.') || 'file'} is not valid (${issue.message}) -> correct the old file and convert again`);
}

// ---------------------------------------------------------------------------------------------
// The old tables, from TypeScript
// ---------------------------------------------------------------------------------------------

const ACCESS: readonly RoleAccess[] = ['allow', 'refuse', 'person'];

/**
 * The role rule's compared line as templates, when it is one: the function is called with the
 * placeholders themselves, and what it returns is the template when the same function over other
 * words says the same with the words in. A line the engine already says (the default) is left out.
 */
function roleTemplates(line: NonNullable<NonNullable<PolicyTables['wording']>['role']>, dropped: string[]): Partial<Record<RoleAccess, string>> {
  const out: Partial<Record<RoleAccess, string>> = {};
  for (const access of ACCESS) {
    const template = line('{role}', '{tool}', access);
    const fill = (role: string, tool: string): string => template.replace(/\{(role|tool)\}/g, (_, word: string) => (word === 'role' ? role : tool));
    const plain = [['viewer', 'getRecord'], ['a b', 'x_y'], ['{tool}', '{role}']].every(([role, tool]) => line(role!, tool!, access) === fill(role!, tool!));
    if (!plain) {
      dropped.push(`wording.role (${access}): the function is not a template over {role} and {tool}, so its line cannot be written in the file; write wording.role.${access} by hand`);
      continue;
    }
    if (template !== DEFAULT_ROLE_TEMPLATES[access]) out[access] = template;
  }
  return out;
}

/** PolicyTables and IdentityConfig as the old files' contents. */
function oldOfTables(tables: PolicyTables, identity: IdentityConfig | undefined, dropped: string[]): { policy: OldPolicy; identity: OldIdentity | null } {
  const policy: Record<string, unknown> = {
    toolLevel: { ...tables.toolLevel },
    purposeLevel: { ...tables.purposeLevel },
    rulesFor: Object.fromEntries(Object.entries(tables.rulesFor).map(([tool, ids]) => [tool, [...ids]])),
    subjects: { ...tables.subjects },
    confirmedFields: [...tables.confirmedFields],
    serviceFields: Object.fromEntries(Object.entries(tables.serviceFields).map(([tool, fields]) => [tool, [...(fields ?? [])]])),
    maxAttempts: tables.maxAttempts,
  };
  if (tables.roles) policy.roles = Object.fromEntries(Object.entries(tables.roles).map(([tool, row]) => [tool, { ...row }]));
  if (tables.rolePersonReason !== undefined) policy.rolePersonReason = tables.rolePersonReason;
  const { role, ...words } = tables.wording ?? {};
  const wording: Record<string, unknown> = { ...words };
  if (role) {
    const templates = roleTemplates(role, dropped);
    if (Object.keys(templates).length > 0) wording.role = templates;
  }
  if (Object.keys(wording).length > 0) policy.wording = wording;
  // The old shape always had the code: an identity written in code without one is already the new shape's to say.
  if (identity && (identity.codeTool === undefined || identity.sendCodeTool === undefined)) {
    throw new ConvertError(['identity: no codeTool and sendCodeTool, which the old shape always had (a ladder of one rung) -> write identity.yaml by hand, with level 1 only']);
  }
  const oldIdentity: OldIdentity | null = identity
    ? {
        subjectKind: identity.subjectKind,
        ...(identity.delegateKind !== undefined ? { delegateKind: identity.delegateKind } : {}),
        factorSlots: [...identity.factorSlots],
        verifyTool: identity.verifyTool,
        codeTool: identity.codeTool!,
        sendCodeTool: identity.sendCodeTool!,
        ...(identity.failedPromptId !== undefined ? { failedPromptId: identity.failedPromptId } : {}),
      }
    : null;
  return { policy: policy as OldPolicy, identity: oldIdentity };
}

// ---------------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------------

const flow = <T extends YAMLMap | YAMLSeq>(node: T): T => {
  node.flow = true;
  return node;
};

/** A map from plain data, in flow style when `inline`. */
function mapOf(doc: Document, data: object, inline = true): YAMLMap {
  const node = doc.createNode(data) as YAMLMap;
  node.flow = inline;
  return node;
}

/** A rule entry of the new shape as a node: a bare name is a word, a rule with parameters a one-key map whose parameters are flow. */
function ruleNode(doc: Document, rule: unknown): Node {
  if (typeof rule === 'string') return new Scalar(rule);
  const [name, params] = Object.entries(rule as Json)[0]!;
  const map = new YAMLMap();
  const value = Array.isArray(params) ? flow(doc.createNode(params) as YAMLSeq) : typeof params === 'object' && params !== null ? mapOf(doc, params) : new Scalar(params);
  map.items.push(new Pair(new Scalar(name), value));
  return map;
}

/** Comments the new documents carry, by where they go; each a comment's text as the yaml library holds it (the lines after "#"). */
interface Carried {
  header: string[];
  /** Before an action's key (a tool). */
  action: Map<string, string[]>;
  /** Before a top-level key. */
  top: Map<string, string[]>;
  /** Before `levels.1`, `levels.2`, `principals`, `delegates`, `attempts`: by new key. */
  identity: Map<string, string[]>;
  /** The old purposes' own, by purpose. */
  purpose: Map<string, string[]>;
  trailing: string | undefined;
}

const emptyCarried = (): Carried => ({ header: [], action: new Map(), top: new Map(), identity: new Map(), purpose: new Map(), trailing: undefined });

const joined = (comments: readonly string[] | undefined): string | undefined => (comments && comments.length > 0 ? comments.join('\n') : undefined);

function keyNode(key: string | number, comment: string | undefined, spaceBefore = false): Scalar {
  const scalar = new Scalar(key);
  if (comment !== undefined) scalar.commentBefore = comment;
  if (spaceBefore) scalar.spaceBefore = true;
  return scalar;
}

/** The schema line a file starts with, as a comment's text. */
function schemaComment(kind: 'policy' | 'identity', options: ConvertOptions): string[] {
  return options.schemaDir === undefined ? [] : [` yaml-language-server: $schema=${join(options.schemaDir, `${kind}.schema.json`)}`];
}

function policyDocument(data: Json, carried: Carried, options: ConvertOptions, wording: Node | undefined): Document {
  const doc = new Document();
  const actions = new YAMLMap();
  for (const [tool, action] of Object.entries(data.actions as Record<string, Json>)) {
    const map = new YAMLMap();
    if (action.say !== undefined) map.set('say', action.say);
    if (action.level !== undefined) map.set('level', action.level);
    const rules = new YAMLSeq();
    for (const rule of action.rules as unknown[]) rules.items.push(ruleNode(doc, rule));
    rules.flow = (action.rules as unknown[]).every((rule) => typeof rule === 'string');
    map.set('rules', rules);
    actions.items.push(new Pair(keyNode(tool, joined(carried.action.get(tool))), map));
  }
  const root = new YAMLMap();
  const header = [...schemaComment('policy', options), ...carried.header, ...(carried.top.get('actions') ?? [])];
  root.items.push(new Pair(keyNode('actions', joined(header)), actions));
  if (data.purposes) {
    const purposes = new YAMLMap();
    for (const [purpose, value] of Object.entries(data.purposes as Json)) {
      purposes.items.push(new Pair(keyNode(purpose, joined(carried.purpose.get(purpose))), mapOf(doc, value as object)));
    }
    root.items.push(new Pair(keyNode('purposes', joined(carried.top.get('purposes')), true), purposes));
  }
  if (data.wording) root.items.push(new Pair(keyNode('wording', joined(carried.top.get('wording')), true), wording ?? doc.createNode(data.wording)));
  doc.contents = root;
  if (carried.trailing !== undefined) doc.comment = carried.trailing;
  return doc;
}

function identityDocument(data: Json, carried: Carried, options: ConvertOptions): Document {
  const doc = new Document();
  const root = new YAMLMap();
  const principals = data.principals as { subject: string; delegates?: Record<string, object> };
  const principalsMap = new YAMLMap();
  principalsMap.set('subject', principals.subject);
  if (principals.delegates) {
    const delegates = new YAMLMap();
    for (const [kind, value] of Object.entries(principals.delegates)) delegates.items.push(new Pair(new Scalar(kind), mapOf(doc, value)));
    principalsMap.items.push(new Pair(keyNode('delegates', joined(carried.identity.get('delegates'))), delegates));
  }
  const header = [...schemaComment('identity', options), ...carried.header, ...(carried.identity.get('principals') ?? [])];
  root.items.push(new Pair(keyNode('principals', joined(header)), principalsMap));
  const levels = new YAMLMap();
  const levelData = data.levels as Record<string, Json>;
  for (const level of [1, 2]) {
    levels.items.push(new Pair(keyNode(level, joined(carried.identity.get(`level${level}`))), mapOf(doc, levelData[level]!)));
  }
  root.items.push(new Pair(keyNode('levels', undefined), levels));
  root.items.push(new Pair(keyNode('attempts', joined(carried.identity.get('attempts'))), new Scalar(data.attempts)));
  if (data.signIn) root.items.push(new Pair(keyNode('signIn', undefined), mapOf(doc, data.signIn as object)));
  doc.contents = root;
  if (carried.trailing !== undefined) doc.comment = carried.trailing;
  return doc;
}

// ---------------------------------------------------------------------------------------------
// The comments
// ---------------------------------------------------------------------------------------------

const commentsOf = (node: unknown): string[] => {
  const n = node as { commentBefore?: string | null; comment?: string | null } | null | undefined;
  return [n?.commentBefore, n?.comment].filter((c): c is string => typeof c === 'string' && c.trim() !== '');
};

const SCHEMA_LINE = /^\s*yaml-language-server:/;

/** The words a comment is quoted by in a report: its first line, cut. */
const quoted = (comment: string): string => {
  const line = comment.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return `"${line.length > 60 ? `${line.slice(0, 57)}...` : line}"`;
};

/**
 * Carries the comments of the old documents to the new: a comment by a tool's row in any table goes
 * before its action; a comment before a section goes before the section that took its place (the
 * confirmed list before the first action that confirms, the roles before the first that runs a role
 * rule, maxAttempts's before `attempts`); the header at the top stays at the top, and the
 * wording's subtree is carried whole. The rest (a comment that describes a table as a whole, or a
 * dropped row) cannot be placed and is reported.
 */
function carry(
  oldPolicy: Document,
  oldIdentity: Document | null,
  data: { policy: Json; identity: Json | null },
): { policy: Carried; identity: Carried; unplaced: string[]; wording: Node | undefined } {
  const policy = emptyCarried();
  const identity = emptyCarried();
  const unplaced: string[] = [];
  const actions = data.policy.actions as Record<string, Json>;
  let wording: Node | undefined;

  const toAction = (tool: string, comments: string[], where: string): void => {
    if (comments.length === 0) return;
    if (!Object.hasOwn(actions, tool)) {
      for (const c of comments) unplaced.push(`${where}: ${quoted(c)} (its row is dropped)`);
      return;
    }
    const have = policy.action.get(tool) ?? [];
    policy.action.set(tool, [...have, ...comments.filter((c) => !have.includes(c))]);
  };
  const toFirstWith = (rule: string, comments: string[], where: string): void => {
    const tool = Object.entries(actions).find(([, a]) => (a.rules as unknown[]).some((r) => typeof r === 'object' && r !== null && rule in r))?.[0];
    if (tool !== undefined) toAction(tool, comments, where);
    else for (const c of comments) unplaced.push(`${where}: ${quoted(c)} (no action runs the ${rule} rule)`);
  };
  const nameOf = (key: unknown): string => (isScalar(key) ? String(key.value) : '');

  /** The sections of a file: each top-level pair, with the comments it has; the first pair's own comment is the header. */
  const sections = (doc: Document, target: Carried, schema: boolean, place: (key: string, pair: Pair, comments: string[]) => void): void => {
    if (!isMap(doc.contents)) return;
    if (doc.commentBefore) target.header.push(doc.commentBefore);
    doc.contents.items.forEach((pair, index) => {
      if (index === 0) {
        for (const comment of commentsOf(pair.key)) {
          const text = comment.split('\n').filter((line) => !(schema && SCHEMA_LINE.test(line))).join('\n');
          if (text.trim() !== '') target.header.push(text);
        }
      }
      place(nameOf(pair.key), pair, [...(index === 0 ? [] : commentsOf(pair.key)), ...(isMap(pair.value) ? [] : commentsOf(pair.value))]);
    });
    if (doc.comment) target.trailing = doc.comment;
  };

  const TABLES = ['toolLevel', 'rulesFor', 'subjects', 'serviceFields', 'roles'];
  const TABLE_RULE: Record<string, string> = { subjects: 'scope', serviceFields: 'fields', roles: 'role', rolePersonReason: 'role', confirmedFields: 'confirmed' };
  sections(oldPolicy, policy, true, (key, pair, comments) => {
    if (TABLES.includes(key) && isMap(pair.value)) {
      // A comment between `table:` and its first row is the map's own.
      const first = pair.value.items[0];
      const own = pair.value.commentBefore ? [pair.value.commentBefore] : [];
      pair.value.items.forEach((row) => toAction(nameOf(row.key), [...(row === first ? own : []), ...commentsOf(row.key), ...commentsOf(row.value)], `${key}.${nameOf(row.key)}`));
    }
    if (comments.length === 0) return;
    if (key === 'purposeLevel') policy.top.set('purposes', comments);
    else if (key === 'wording') policy.top.set('wording', comments);
    else if (key === 'maxAttempts') {
      if (oldIdentity) identity.identity.set('attempts', comments);
      else for (const c of comments) unplaced.push(`maxAttempts: ${quoted(c)} (the app has no identity file)`);
    } else if (TABLE_RULE[key] !== undefined) toFirstWith(TABLE_RULE[key]!, comments, key);
    else for (const c of comments) unplaced.push(`${key}: ${quoted(c)} (it describes the whole table, which the actions replace)`);
  });
  if (isMap(oldPolicy.contents)) {
    for (const pair of oldPolicy.contents.items) {
      const key = nameOf(pair.key);
      if (key === 'purposeLevel' && isMap(pair.value)) {
        const own = pair.value.commentBefore ? [pair.value.commentBefore] : [];
        for (const row of pair.value.items) {
          const comments = [...(row === pair.value.items[0] ? own : []), ...commentsOf(row.key), ...commentsOf(row.value)];
          if (comments.length > 0) policy.purpose.set(nameOf(row.key), comments);
        }
      } else if (key === 'wording' && isNode(pair.value) && !isScalar(pair.value)) wording = pair.value.clone() as Node;
    }
  }

  if (oldIdentity) {
    const levelOf: Record<string, string> = { subjectKind: 'principals', delegateKind: 'delegates', factorSlots: 'level1', verifyTool: 'level1', failedPromptId: 'level1', codeTool: 'level2', sendCodeTool: 'level2' };
    sections(oldIdentity, identity, true, (key, _pair, comments) => {
      const to = levelOf[key];
      if (to === undefined) for (const c of comments) unplaced.push(`${key}: ${quoted(c)}`);
      else if (comments.length > 0) identity.identity.set(to, [...(identity.identity.get(to) ?? []), ...comments]);
    });
  }
  return { policy, identity, unplaced, wording };
}

// ---------------------------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------------------------

function assemble(
  data: Converted,
  options: ConvertOptions,
  comments?: { oldPolicy: Document; oldIdentity: Document | null },
): Conversion {
  let carried = { policy: emptyCarried(), identity: emptyCarried() };
  let unplaced: string[] = [];
  let wording: Node | undefined;
  if (comments) {
    const result = carry(comments.oldPolicy, comments.oldIdentity, { policy: data.policy, identity: data.identity });
    carried = { policy: result.policy, identity: result.identity };
    unplaced = result.unplaced;
    wording = result.wording;
  }
  const policy = policyDocument(data.policy, carried.policy, options, wording);
  const identity = data.identity ? identityDocument(data.identity, carried.identity, options) : null;
  return { policy, identity, dropped: data.dropped, unplaced };
}

/** A conversion's files as text, as they are written. */
export function toText(doc: Document): string {
  // The library pads a flow list as it pads a flow map ([ a ] and { a: b }); the files write [a] and { a: b }.
  return doc.toString({ lineWidth: 0 }).replace(/\[ (.+?) \]/g, '[$1]');
}

/**
 * The new files for tables an app wrote in TypeScript (PolicyTables, and IdentityConfig when it
 * verifies callers). The wording's role function becomes templates when it is one. No comments.
 */
export function convertTables(tables: PolicyTables, identity?: IdentityConfig, options: ConvertOptions = {}): Conversion {
  const extra: string[] = [];
  const old = oldOfTables(tables, identity, extra);
  const data = convertData(old, options);
  data.dropped.push(...extra);
  return assemble(data, options);
}

const hasKey = (value: unknown, key: string): boolean => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);

/** What reading an old file found: its document, and the data once it is checked. */
function readOld<T>(file: string, text: string, schema: z.ZodType<T>, isOld: (value: unknown) => boolean, isNewShape: (value: unknown) => boolean): { doc: Document; value: T | null; isNew: boolean; problems: string[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false, lineCounter: lines, customTags: [] });
  const bad = (p: Problem): string => formatProblem(p);
  if (doc.errors.length > 0) {
    return { doc, value: null, isNew: false, problems: doc.errors.map((e) => bad({ file, line: lines.linePos(e.pos[0]).line, column: lines.linePos(e.pos[0]).col, path: '(file)', message: e.message.split('\n')[0] ?? e.message, fix: 'correct the YAML, then convert' })) };
  }
  const value = doc.toJS({ maxAliasCount: 20 });
  if (!isOld(value)) {
    return { doc, value: null, isNew: isNewShape(value), problems: [] };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { doc, value: parsed.data, isNew: false, problems: [] };
  const oldSchema = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as JsonSchema;
  return { doc, value: null, isNew: false, problems: problemsOfIssues(parsed.error.issues, { file, doc, lines, value, schema: oldSchema }).map(bad) };
}

/** The files `convertFolder` read and wrote, as text. */
export interface FolderConversion extends Omit<Conversion, 'policy' | 'identity'> {
  /** The new files by name, as text: only those that were in the old shape. */
  files: Record<string, string>;
  /** The files that were already in the new shape, and so were left alone. */
  alreadyNew: string[];
}

/** The folder the package's schemas are in. */
const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas');

/** The path from `dir` to the package's schemas, for a file's schema line. */
function schemaDirFrom(dir: string): string {
  // `dir` may not exist yet: its nearest folder that does, resolved, with the rest after it.
  let existing = resolve(dir);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return relative(join(realpathSync(existing), ...rest), SCHEMAS) || '.';
}

/**
 * The new files for an app folder whose policy.yaml (and identity.yaml, when it has one) are in the
 * old shape, keeping the comments the new shape has a place for. `out` is where the files will be
 * written, so the schema line can name the schemas from there (default: the folder itself).
 * Throws a ConvertError for a file that cannot be read or converted.
 */
export function convertFolder(dir: string, options: ConvertOptions & { out?: string } = {}): FolderConversion {
  const read = (file: string): string | null => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null);
  const policyText = read('policy.yaml');
  if (policyText === null) throw new ConvertError([`${join(dir, 'policy.yaml')}: there is no policy.yaml to convert -> pass an app folder`]);
  const identityText = read('identity.yaml');
  const policy = readOld('policy.yaml', policyText, oldPolicySchema, isOldPolicyContent, (v) => hasKey(v, 'actions'));
  const identity = identityText === null ? null : readOld('identity.yaml', identityText, oldIdentitySchema, isOldIdentityContent, (v) => hasKey(v, 'principals') || hasKey(v, 'levels'));
  const problems = [...policy.problems, ...(identity?.problems ?? [])];
  if (problems.length > 0) throw new ConvertError(problems);
  const alreadyNew = [...(policy.isNew ? ['policy.yaml'] : []), ...(identity?.isNew ? ['identity.yaml'] : [])];
  if (policy.value === null && (identity === null || identity.value === null)) {
    if (!policy.isNew || (identity !== null && !identity.isNew)) throw new ConvertError([`${dir}: policy.yaml and identity.yaml are in neither shape -> see schemas/policy.schema.json and schemas/identity.schema.json`]);
    return { files: {}, dropped: [], unplaced: [], alreadyNew };
  }
  if (policy.value === null || (identity !== null && identity.value === null)) {
    const [old, fresh] = policy.value === null ? ['identity.yaml', 'policy.yaml'] : ['policy.yaml', 'identity.yaml'];
    throw new ConvertError([`${dir}: ${old} is in the old shape and ${fresh} in the new one, and the two convert together (the roles and attempts are the other file's) -> write ${fresh} in the old shape, or ${old} in the new one by hand`]);
  }
  const schemaDir = options.schemaDir ?? schemaDirFrom(options.out ?? dir);
  const data = convertData({ policy: policy.value, identity: identity?.value ?? null }, options);
  const conversion = assemble(data, { ...options, schemaDir }, { oldPolicy: policy.doc, oldIdentity: identity?.doc ?? null });
  const files: Record<string, string> = { 'policy.yaml': toText(conversion.policy) };
  if (conversion.identity) files['identity.yaml'] = toText(conversion.identity);
  return { files, dropped: conversion.dropped, unplaced: conversion.unplaced, alreadyNew };
}

/** Writes a folder conversion's files to `out`, creating it when it is not there. */
export function writeConversion(conversion: FolderConversion, out: string): void {
  mkdirSync(out, { recursive: true });
  for (const [file, text] of Object.entries(conversion.files)) writeFileSync(resolve(out, file), text);
}

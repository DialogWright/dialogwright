import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { defineRule } from '../gate/defineRule';
import { AppDefinitionError } from './defineApp';
import { defineIdentity, definePolicy } from './definePolicy';

/**
 * Every policy.yaml and identity.yaml block in the docs builds: a fenced ```yaml block whose keys are
 * all policy.yaml's (actions, purposes, wording, redact, audit) is a policy file or a piece of one,
 * and one whose keys are identity.yaml's (principals, levels, attempts, signIn) is an identity file;
 * each is read by the loader that reads the real file, with the same schema and the same checks. So a
 * doc example cannot drift from what the loader accepts, as the slots blocks cannot (the slots
 * doc-block test, slots/docBlocks.test.ts).
 *
 * A policy block runs in one world: the identity of the engine's own test app (a customer, depot
 * agents with the roles viewer and clerk, two levels), the custom rules it names (each a stand-in with
 * the two examples a rule needs) and the lookups its references call. What the code supplies is
 * therefore taken as given; what the file says is checked. A block that has no `actions` has none
 * added beyond an empty map, so a fragment is checked as a fragment.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORLD_IDENTITY = parse(readFileSync(join(ROOT, 'packages/dialogwright/src/testing/testkit/identity.yaml'), 'utf8')) as Record<string, unknown>;

const POLICY_KEYS = ['actions', 'purposes', 'wording', 'redact', 'audit'];
const IDENTITY_KEYS = ['principals', 'levels', 'attempts', 'signIn'];

/** The markdown files whose examples an author copies: the repository's docs, READMEs and CONTRIBUTING, and the create-app skill's pages. */
function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) out.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  walk(join(ROOT, 'apps'));
  walk(join(ROOT, '.claude', 'skills'));
  for (const file of ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md']) out.push(join(ROOT, file));
  return out;
}

type Kind = 'policy' | 'identity';

interface Block {
  kind: Kind;
  where: string;
  value: Record<string, unknown>;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which file a parsed block is, by its keys: every key one file's, and for identity the principals. */
function kindOf(value: unknown): Kind | null {
  if (!isMap(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (keys.every((k) => POLICY_KEYS.includes(k))) return 'policy';
  if (keys.every((k) => IDENTITY_KEYS.includes(k)) && keys.includes('principals')) return 'identity';
  return null;
}

/**
 * A block that shows a piece of a file under one of its keys, as the create-app skill's patterns do
 * (a first line `# policy.yaml, under actions:` and the entries indented beneath it), read with that
 * key put back, so the piece is checked as the file it is part of.
 */
function withParentKey(text: string): string {
  const key = /^#\s+[A-Za-z0-9_./<>-]+\.yaml,?\s+under (actions|intents|forms|prompts):/.exec(text.split('\n')[0] ?? '')?.[1];
  return key === undefined ? text : `${key}:\n${text}`;
}

/** Each fenced YAML block that is a policy or an identity file, with where it starts. */
function blocksOf(file: string): Block[] {
  const text = readFileSync(file, 'utf8');
  const out: Block[] = [];
  for (const m of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    const body = withParentKey(m[1]!);
    let value: unknown;
    try {
      value = parse(body);
    } catch {
      continue;
    }
    const kind = kindOf(value);
    if (kind === null) continue;
    out.push({ kind, where: `${relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`, value: value as Record<string, unknown> });
  }
  return out;
}

/** The custom rule ids and the lookups a policy block names, so the stand-ins for the code can be made. */
function namedBy(value: Record<string, unknown>): { customRules: string[]; lookups: string[] } {
  const customRules = new Set<string>();
  const lookups = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\b([A-Za-z]\w*)\(\s*[A-Za-z]\w*\s*\)/g)) lookups.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isMap(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'custom' && typeof x === 'string') customRules.add(x);
        walk(x);
      }
    }
  };
  walk(value);
  return { customRules: [...customRules], lookups: [...lookups] };
}

/** A stand-in for an app's own rule: it has what `check` requires of one (an example the gate allows, one it refuses). */
const standIn = (id: string) => {
  const anyone = { kind: 'anonymous', level: 0 } as const;
  return defineRule({
    id,
    description: `The ${id} rule`,
    run: () => ({ pass: true, compared: 'stand-in' }),
    examples: [
      { name: 'allowed', call: { params: {} }, principal: anyone, expect: { verdict: 'ALLOW' } },
      { name: 'refused', call: { params: {} }, principal: anyone, expect: { verdict: 'BLOCK', reason: 'stand-in' } },
    ],
  });
};

/**
 * The world's identity, with the delegate roles the same markdown file's own identity.yaml blocks
 * declare (the create-app skill declares a `manager`), as a delegate kind of the doc's own: a policy
 * block is read beside the identity its page shows. A role neither declares is still refused.
 */
function worldWithRoles(roles: readonly string[]): Record<string, unknown> {
  const principals = WORLD_IDENTITY.principals as { delegates?: Record<string, { roles: string[] }> };
  const known = new Set(Object.values(principals.delegates ?? {}).flatMap((d) => d.roles));
  const missing = roles.filter((r) => !known.has(r));
  if (missing.length === 0) return WORLD_IDENTITY;
  return { ...WORLD_IDENTITY, principals: { ...principals, delegates: { ...principals.delegates, doc_delegate: { roles: missing } } } };
}

/** What loading a block says is wrong with it, one line each: its path, the message and the fix. */
export function problemsOfBlock(block: Pick<Block, 'kind' | 'value'>, declaredRoles: readonly string[] = []): string[] {
  try {
    if (block.kind === 'identity') {
      defineIdentity(block.value);
    } else {
      const { customRules, lookups } = namedBy(block.value);
      definePolicy({ actions: {}, ...block.value }, {
        identity: worldWithRoles(declaredRoles),
        lookups,
        customRules: Object.fromEntries(customRules.map((id) => [id, standIn(id)])),
      });
    }
  } catch (error) {
    if (!(error instanceof AppDefinitionError)) throw error;
    return error.problems.map((p) => `${p.path}: ${p.message} -> ${p.fix}`);
  }
  return [];
}

describe('the policy and identity YAML in the docs', () => {
  const blocks = docFiles().flatMap(blocksOf);

  it('is found in the authoring guide and the design, in both kinds', () => {
    const where = (kind: Kind) => new Set(blocks.filter((b) => b.kind === kind).map((b) => b.where.split(':')[0]));
    for (const file of ['docs/authoring-an-app.md', 'docs/design.md', '.claude/skills/create-app/patterns.md']) expect(where('policy'), file).toContain(file);
    for (const file of ['docs/authoring-an-app.md', '.claude/skills/create-app/patterns.md']) expect(where('identity'), file).toContain(file);
    expect(blocks.filter((b) => b.kind === 'policy').length).toBeGreaterThanOrEqual(8);
    expect(blocks.filter((b) => b.kind === 'identity').length).toBeGreaterThanOrEqual(2);
  });

  it('shows each rule, in a block that builds', () => {
    const rules = new Set<string>();
    for (const b of blocks.filter((x) => x.kind === 'policy')) {
      const actions = isMap(b.value.actions) ? Object.values(b.value.actions) : [];
      for (const action of actions) {
        for (const entry of isMap(action) && Array.isArray(action.rules) ? action.rules : []) rules.add(typeof entry === 'string' ? entry : Object.keys(entry as object)[0]!);
      }
    }
    expect([...rules].sort()).toEqual(['attempts', 'callerNumber', 'confirmed', 'custom', 'dateInRange', 'fields', 'identity', 'limit', 'noneOf', 'oneOf', 'role', 'scope']);
    // The sections the docs teach: purposes, wording, redact and audit.
    for (const key of ['purposes', 'wording', 'redact', 'audit']) expect(blocks.some((b) => b.kind === 'policy' && key in b.value), key).toBe(true);
  });

  it('builds, every block of it, as written', () => {
    // The delegate roles each page's own identity blocks declare.
    const rolesOf = new Map<string, string[]>();
    for (const b of blocks.filter((x) => x.kind === 'identity')) {
      const delegates = isMap(b.value.principals) && isMap(b.value.principals.delegates) ? Object.values(b.value.principals.delegates) : [];
      const file = b.where.split(':')[0]!;
      for (const d of delegates) if (isMap(d) && Array.isArray(d.roles)) rolesOf.set(file, [...(rolesOf.get(file) ?? []), ...d.roles.map(String)]);
    }
    const failed = blocks.flatMap((b) => problemsOfBlock(b, rolesOf.get(b.where.split(':')[0]!)).map((p) => `${b.where}: ${p}`));
    expect(failed).toEqual([]);
  });

  it('would fail a block that is wrong (the check has teeth)', () => {
    expect(problemsOfBlock({ kind: 'policy', value: { actions: { a: { level: 0, rules: ['idnetity'] } } } }).join('\n')).toContain('rename it to "identity"');
    expect(problemsOfBlock({ kind: 'policy', value: { actions: { a: { level: 2, rules: [{ role: { clerk: 'allow' } }, { dateInRange: { field: 'd', notAfter: 'today+030' } }] } } } }).length).toBeGreaterThan(0);
    expect(problemsOfBlock({ kind: 'policy', value: { actions: { a: { level: 0, rules: [{ role: { guard: 'allow' } }] } } } }).join('\n')).toContain('guard');
    expect(problemsOfBlock({ kind: 'identity', value: { principals: { subject: 'customer' }, levels: { 1: { name: 'verified', factors: ['accountId'], verify: 'verify' }, 2: { name: 'coded', factors: [{ otp: { length: 12 } }], send: 's', verify: 'v' } }, attempts: 3 } }).join('\n')).toContain('at most 8');
  });
});

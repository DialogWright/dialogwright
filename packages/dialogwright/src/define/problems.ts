import { isMap, isScalar, isSeq, type Document, type LineCounter, type Node } from 'yaml';
import type { ZodIssue } from 'zod';
import { fixForPattern } from './schema/common';
import type { JsonSchema } from './schema/json';

/**
 * Turning what went wrong in an app folder into something an author, or an AI coding assistant
 * working for one, can act on.
 *
 * The loader (./load.ts) validates a YAML file against its zod schema and gets back issues whose
 * paths ("forms", "reschedule", "slots", 2) say where in the data, not where in the file. This
 * module maps each issue back to the line and column of the YAML that caused it, words it
 * ("forms.reschedule.slots[2] must be text, but is a number (5)") and says how to fix it
 * ("quote the value: \"5\"").
 */

/** One thing wrong with an app folder, located in the file the author edits. */
export interface Problem {
  /** The file, relative to the app folder and with forward slashes ("forms.yaml", "locale/fr/prompts.yaml"). */
  file: string;
  /** 1-based line of the YAML that is wrong (the line of the parent key where a key is missing). */
  line: number;
  /** 1-based column. */
  column: number;
  /** Where in the file's data, like `forms.reschedule.slots[2]`; `(file)` for a problem with the whole file. */
  path: string;
  /** What is wrong, in a sentence. */
  message: string;
  /** What to change, concretely. */
  fix: string;
}

/**
 * One problem on one line: `file:line:column  path  message  ->  fix`. A problem with no line (one
 * in the app's code, which has no YAML to point at; line 0) is `file  path  message  ->  fix`.
 */
export function formatProblem(p: Problem): string {
  const where = p.line > 0 ? `${p.file}:${p.line}:${p.column}` : p.file;
  return `${where}  ${p.path}  ${p.message}  ->  ${p.fix}`;
}

/** A position in a data tree: object keys and list indexes, from the root of one file. */
export type DataPath = readonly (string | number)[];

/** The path the whole file has. */
export const WHOLE_FILE = '(file)';

/** `forms.reschedule.slots[2]`; a key that is not a plain word is written `["like this"]`. */
export function formatPath(path: DataPath): string {
  if (path.length === 0) return WHOLE_FILE;
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) out += out === '' ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** What a data path leads to in a parsed YAML document. */
export interface Located {
  /** The value's node, when the whole path exists. */
  node: Node | null;
  /** The node of the key that holds the value (the parent's key, for a value that is a list item or the root). */
  keyNode: Node | null;
  /** The deepest node that exists along the path (the root when nothing does). */
  nearest: Node | null;
  /** The key node of `nearest`, where it has one. */
  nearestKey: Node | null;
}

/** Walks `path` through a parsed document; every step is a key of a map or an index of a list. */
export function find(doc: Document, path: DataPath): Located {
  let node: Node | null = (doc.contents as Node | null) ?? null;
  let keyNode: Node | null = null;
  let nearest = node;
  let nearestKey: Node | null = null;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String((p.key as { value: unknown }).value) === String(seg));
      if (!pair) return { node: null, keyNode: null, nearest, nearestKey };
      keyNode = isScalar(pair.key) ? pair.key : null;
      node = (pair.value as Node | null) ?? null;
    } else if (isSeq(node) && typeof seg === 'number') {
      const item = node.items[seg] as Node | undefined;
      if (item === undefined) return { node: null, keyNode: null, nearest, nearestKey };
      keyNode = null;
      node = item;
    } else {
      return { node: null, keyNode: null, nearest, nearestKey };
    }
    if (node) {
      nearest = node;
      nearestKey = keyNode;
    }
  }
  return { node, keyNode, nearest, nearestKey };
}

/** The line and column (1-based) of the YAML a path leads to, where the whole path exists; the deepest part that does, otherwise. */
export function positionOf(doc: Document, lines: LineCounter, path: DataPath): { line: number; column: number } {
  const found = find(doc, path);
  const target = found.node ? (isScalar(found.node) ? found.node : (found.keyNode ?? found.node)) : (found.nearestKey ?? found.nearest);
  return positionOfNode(lines, target, found.nearestKey);
}

/** The line and column of the key that holds the value at `path` (for a problem with the key itself); positionOf where there is no key. */
export function keyPositionOf(doc: Document, lines: LineCounter, path: DataPath): { line: number; column: number } {
  const found = find(doc, path);
  return found.keyNode ? positionOfNode(lines, found.keyNode, null) : positionOf(doc, lines, path);
}

/** A node's position; a key is preferred to a collection, which starts on the line of its first entry. */
function positionOfNode(lines: LineCounter, node: Node | null, fallback: Node | null): { line: number; column: number } {
  const offset = node?.range?.[0] ?? fallback?.range?.[0];
  if (offset === undefined) return { line: 1, column: 1 };
  const { line, col } = lines.linePos(offset);
  return { line, column: col };
}

/** The same lookup against a JSON Schema: the schema nodes a data path can be (a union gives several). */
function schemaNodesAt(root: JsonSchema, path: DataPath, value: unknown, expandLast = true): JsonSchema[] {
  let nodes: JsonSchema[] = [root];
  let at: unknown = value;
  for (const seg of path) {
    const next: JsonSchema[] = [];
    for (const node of nodes.flatMap((n) => expand(n, at))) {
      const properties = node.properties as Record<string, JsonSchema> | undefined;
      const items = node.items;
      if (typeof seg === 'string' && properties && Object.hasOwn(properties, seg)) next.push(properties[seg]!);
      else if (typeof seg === 'string' && isSchema(node.additionalProperties)) next.push(node.additionalProperties);
      else if (typeof seg === 'number' && Array.isArray(items) && isSchema(items[seg])) next.push(items[seg] as JsonSchema);
      else if (typeof seg === 'number' && isSchema(items)) next.push(items);
    }
    nodes = next;
    at = typeof at === 'object' && at !== null ? (at as Record<string | number, unknown>)[seg] : undefined;
  }
  return expandLast ? nodes.flatMap((n) => expand(n, at)) : nodes;
}

const isSchema = (x: unknown): x is JsonSchema => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A union's branches, narrowed by its discriminator (`kind`) where the data names one. */
function expand(node: JsonSchema, data: unknown): JsonSchema[] {
  const branches = (node.oneOf ?? node.anyOf) as JsonSchema[] | undefined;
  if (!branches) return [node];
  const all = branches.flatMap((b) => expand(b, data));
  const kind = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).kind : undefined;
  const matching = all.filter((b) => (b.properties as Record<string, JsonSchema> | undefined)?.kind?.const === kind);
  return matching.length > 0 && kind !== undefined ? matching : all;
}

/** The keys an object at `path` may have, from the file's JSON Schema. */
function knownKeys(schema: JsonSchema, path: DataPath, value: unknown): string[] {
  const keys = new Set<string>();
  for (const node of schemaNodesAt(schema, path, value)) for (const key of Object.keys((node.properties as object | undefined) ?? {})) keys.add(key);
  return [...keys];
}

/** What the schema says about the field at `path`: its description and a short word for what goes there. */
function fieldInfo(schema: JsonSchema, path: DataPath, value: unknown): { description: string; shape: string } {
  // A field's description sits on the field itself, which a union's branches do not repeat.
  const description = schemaNodesAt(schema, path, value, false).map((n) => n.description).find((d): d is string => typeof d === 'string') ?? '';
  const shapes = schemaNodesAt(schema, path, value).flatMap((n) => shapeOf(n));
  return { description, shape: [...new Set(shapes)].join(' or ') || 'a value' };
}

function shapeOf(node: JsonSchema): string[] {
  const options = (node.anyOf ?? node.oneOf) as JsonSchema[] | undefined;
  if (options) return options.flatMap(shapeOf);
  if (Array.isArray(node.enum)) return [`one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`];
  switch (node.type) {
    case 'string': return ['text'];
    case 'number': return ['a number'];
    case 'integer': return ['a whole number'];
    case 'boolean': return ['true or false'];
    case 'array': return ['a list'];
    case 'object': return ['a map'];
    case 'null': return ['null'];
    default: return [];
  }
}

/** The first sentence of a description: enough to say what a field is for in a fix. */
function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/** The closest of `candidates` to `word`, when one is close enough to be a typo of it. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(candidate.length / 3)) && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length]!;
}

/** What a node holds, in words: "a number (5)", "a list", "text (\"abc\")". */
function describeNode(node: Node | null): string {
  if (node === null) return 'empty';
  if (isMap(node)) return 'a map';
  if (isSeq(node)) return 'a list';
  if (!isScalar(node)) return 'an alias';
  const value = node.value;
  const shown = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}...` : s);
  if (value === null) return 'empty (null)';
  if (typeof value === 'string') return `text (${shown(JSON.stringify(value))})`;
  if (typeof value === 'number') return `a number (${value})`;
  if (typeof value === 'boolean') return `true or false (${value})`;
  return shown(String(value));
}

/** The kind a zod `expected` names, in words. */
const EXPECTED: Record<string, string> = {
  string: 'text', number: 'a number', int: 'a whole number', boolean: 'true or false', object: 'a map', record: 'a map', array: 'a list', tuple: 'a list',
};

/** Words for the last part of a path: `"summaryPromptId"` or `"slots[2]"`. */
function subject(path: DataPath): string {
  const last = path[path.length - 1];
  if (last === undefined) return 'the file';
  if (typeof last === 'string') return `"${last}"`;
  const owner = path[path.length - 2];
  return `"${typeof owner === 'string' ? owner : 'list'}[${last}]"`;
}

/** What the loader knows about the file an issue came from. */
export interface IssueSource {
  file: string;
  doc: Document;
  lines: LineCounter;
  /** The data parsed from the file (what the schema saw). */
  value: unknown;
  /** The file's JSON Schema, for descriptions and the keys a typo may have meant. */
  schema: JsonSchema;
  /**
   * The other files of the folder whose top level has a key, for a key this file does not know at
   * its top level (`purposes` in identity.yaml belongs in policy.yaml). None for a file read alone.
   */
  homesOf?: (key: string) => readonly string[];
}

/** The other files a key unknown at a file's top level belongs in, by their names; none below the top level. */
function homesOf(key: string, path: DataPath, src: IssueSource): readonly string[] {
  return path.length === 0 && src.homesOf ? src.homesOf(key) : [];
}

/**
 * The problems a file's zod issues amount to, each once. A key typed wrong is both an unknown key
 * and, when the key it was meant to be is required, a missing one; only the first is reported, as
 * its fix (the rename) clears both.
 */
export function problemsOfIssues(issues: readonly ZodIssue[], src: IssueSource): Problem[] {
  const pathOf = (issue: ZodIssue): (string | number)[] => issue.path.map((seg) => (typeof seg === 'symbol' ? String(seg) : seg)) as (string | number)[];
  const meant = new Set<string>();
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    const path = pathOf(issue);
    const known = knownKeys(src.schema, path, valueAt(src.value, path));
    for (const key of issue.keys) {
      // A key that belongs in another file is moved there, not renamed to a near key of this one.
      if (homesOf(key, path, src).length > 0) continue;
      const guess = closest(key, known);
      if (guess !== undefined) meant.add(JSON.stringify([...path, guess]));
    }
  }
  // A union of shapes says only that the value is none of them; a check of the schema's own that
  // names the same field says what to write instead, so it alone is reported there.
  const explained = new Set(issues.filter((i) => i.code === 'custom').map((i) => JSON.stringify(pathOf(i))));
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const path = pathOf(issue);
    if (issue.code === 'invalid_union' && explained.has(JSON.stringify(path))) continue;
    if ((issue.code === 'invalid_type' || issue.code === 'invalid_union') && meant.has(JSON.stringify(path))) {
      const here = find(src.doc, path);
      if (here.node === null && here.keyNode === null) continue;
    }
    for (const problem of problemsOf(issue, src)) {
      const id = `${problem.line}:${problem.column}:${problem.path}:${problem.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      problems.push(problem);
    }
  }
  return problems;
}

/** The problems one zod issue amounts to (an issue that names several unknown keys is several problems). */
export function problemsOf(issue: ZodIssue, src: IssueSource): Problem[] {
  const make = (path: DataPath, message: string, fix: string, at: DataPath = path): Problem => ({
    file: src.file,
    ...positionOf(src.doc, src.lines, at),
    path: formatPath(path),
    message,
    fix,
  });
  const path = issue.path.map((seg) => (typeof seg === 'symbol' ? String(seg) : seg)) as (string | number)[];
  const here = find(src.doc, path);

  switch (issue.code) {
    case 'unrecognized_keys': {
      const known = knownKeys(src.schema, path, valueAt(src.value, path));
      return issue.keys.map((key) => {
        const where = path.length === 0 ? 'in this file' : `under ${formatPath(path)}`;
        const homes = homesOf(key, path, src);
        if (homes.length > 0) {
          const files = homes.join(' or ');
          return {
            ...make([...path, key], `unknown key "${key}" in this file; "${key}" is a key of ${files}`, `move "${key}" and what is under it to ${files}`),
            ...keyPositionOf(src.doc, src.lines, [...path, key]),
          };
        }
        const guess = closest(key, known);
        const fix = guess
          ? `rename "${key}" to "${guess}"`
          : `delete "${key}"${known.length > 0 ? `; the keys allowed ${where} are ${known.join(', ')}` : ''}`;
        // The key is what is wrong, so the problem points at it, not at the value it holds.
        return { ...make([...path, key], `unknown key "${key}" ${where}`, fix), ...keyPositionOf(src.doc, src.lines, [...path, key]) };
      });
    }

    case 'invalid_key': {
      const nested = issue.issues[0];
      const key = String(path[path.length - 1]);
      const fix = nested && 'pattern' in nested && typeof nested.pattern === 'string' ? fixForPattern(nested.pattern) : undefined;
      // The key is what is wrong, so the problem points at it, not at the value it holds.
      return [{ ...make(path, `the key "${key}" ${nested ? nested.message : 'is not allowed here'}`, fix ?? 'rename the key'), ...keyPositionOf(src.doc, src.lines, path) }];
    }

    case 'invalid_type': {
      if (here.node === null) return [missing(path, src, make)];
      const expected = EXPECTED[issue.expected] ?? issue.expected;
      const received = describeNode(here.node);
      return [make(path, `${subject(path)} must be ${expected}, but is ${received}`, wrongTypeFix(issue.expected, here.node, path))];
    }

    case 'invalid_value': {
      const values = issue.values;
      const given = here.node && isScalar(here.node) ? here.node.value : undefined;
      const shown = given === undefined ? describeNode(here.node) : JSON.stringify(given);
      const guess = typeof given === 'string' ? closest(given, values.map(String)) : undefined;
      const all = values.map((v) => JSON.stringify(v)).join(', ');
      return [
        make(
          path,
          values.length === 1 ? `${subject(path)} is ${shown}, but the only value allowed is ${all}` : `${subject(path)} is ${shown}, which is not allowed here; it must be one of ${all}`,
          guess ? `change it to ${JSON.stringify(guess)}` : values.length === 1 ? `write ${all}` : `use one of ${all}`,
        ),
      ];
    }

    case 'invalid_union': {
      const options = 'options' in issue && Array.isArray(issue.options) ? issue.options.map(String) : [];
      if (options.length === 0) {
        // A union of shapes (a name, or a map with keys of its own): a value that has the shape of one
        // branch alone is wrong inside that branch, so the problem is that branch's, said where it is.
        const branches = 'errors' in issue && Array.isArray(issue.errors) ? (issue.errors as ZodIssue[][]) : [];
        const fitting = branches.filter((b) => b.length > 0 && !b.some((i) => i.code === 'invalid_type' && i.path.length === 0));
        if (fitting.length === 1) return fitting[0]!.flatMap((inner) => problemsOf({ ...inner, path: [...issue.path, ...inner.path] } as ZodIssue, src));
        return [make(path, `${subject(path)} is not one of the shapes allowed here`, 'check the field against the schema')];
      }
      if (here.node === null) return [missing(path, src, make)];
      const given = isScalar(here.node) ? String(here.node.value) : describeNode(here.node);
      const guess = closest(given, options);
      return [
        make(
          path,
          `${subject(path)} is "${given}", which is not one of ${options.map((o) => `"${o}"`).join(', ')}`,
          guess ? `change it to "${guess}"` : `use one of ${options.map((o) => `"${o}"`).join(', ')}`,
        ),
      ];
    }

    case 'invalid_format': {
      const given = here.node && isScalar(here.node) ? JSON.stringify(here.node.value) : describeNode(here.node);
      const fix = typeof issue.pattern === 'string' ? fixForPattern(issue.pattern) : undefined;
      return [make(path, `${given} ${issue.message}`, fix ?? 'correct the value')];
    }

    case 'too_small':
    case 'too_big': {
      const bound = `${issue.code === 'too_small' ? issue.minimum : issue.maximum}`;
      const empty = issue.code === 'too_small' && (issue.origin === 'string' || issue.origin === 'array') && bound === '1';
      const exact = 'exact' in issue && issue.exact === true;
      const fix = empty
        ? 'give it a value, or delete the key'
        : issue.origin === 'array'
          ? `give it ${exact ? 'exactly' : issue.code === 'too_small' ? 'at least' : 'at most'} ${bound} entries`
          : issue.code === 'too_small'
            ? `use a value of at least ${bound}`
            : `use a value of at most ${bound}`;
      return [make(path, `${subject(path)} ${issue.message}`, fix)];
    }

    case 'custom': {
      const params = issue.params as { fix?: unknown } | undefined;
      const fix = typeof params?.fix === 'string' ? params.fix : 'correct the value';
      return [make(path, issue.message, fix)];
    }

    default:
      return [make(path, issue.message, 'correct the value')];
  }
}

/** A required key that is not there: reported on the line of the key that should hold it. */
function missing(
  path: DataPath,
  src: IssueSource,
  make: (path: DataPath, message: string, fix: string, at?: DataPath) => Problem,
): Problem {
  const parent = path.slice(0, -1);
  const key = String(path[path.length - 1]);
  const { description, shape } = fieldInfo(src.schema, path, src.value);
  const where = parent.length === 0 ? 'at the top of the file' : `under ${formatPath(parent)}`;
  const about = description ? ` ${firstSentence(description)}` : '';
  return make(path, `required key "${key}" is missing ${where}`, `add "${key}:" (${shape}) ${where}.${about}`, parent);
}

/** The fix for a value of the wrong kind. */
function wrongTypeFix(expected: string, node: Node | null, path: DataPath): string {
  const received = node !== null && isScalar(node) ? node.value : undefined;
  if (expected === 'string' && (typeof received === 'number' || typeof received === 'boolean')) {
    return `write it as text, in quotes: ${JSON.stringify(String(received))}`;
  }
  if (received === null || node === null) return `give ${subject(path)} a value, or delete the key`;
  if ((expected === 'object' || expected === 'record') && isSeq(node)) return `write ${subject(path)} as indented "key: value" lines, not a list`;
  if ((expected === 'array' || expected === 'tuple') && isMap(node)) return `write ${subject(path)} as a list, one "- item" per line, or [a, b] on one line`;
  if ((expected === 'array' || expected === 'tuple') && isScalar(node)) return `write ${subject(path)} as a list: [${JSON.stringify(received)}] or "- ${String(received)}" on its own line`;
  if (expected === 'boolean') return `write true or false, without quotes`;
  if (expected === 'number' || expected === 'int') return `write a number without quotes`;
  return `use ${EXPECTED[expected] ?? expected} here`;
}

/** The value at a path in parsed data, or undefined. */
function valueAt(value: unknown, path: DataPath): unknown {
  let at = value;
  for (const seg of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[seg];
  }
  return at;
}

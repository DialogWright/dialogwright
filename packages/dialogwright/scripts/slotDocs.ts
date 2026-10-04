/**
 * Writes a docs page for each built-in slot type to docs/slots/<type>.md.
 * Run with `pnpm --filter dialogwright slot-docs`; a test (src/slots/slotDocs.test.ts) fails when a
 * committed page is stale.
 *
 * A page is the type's README (src/slots/<type>/README.md, the hand-written source: what the type is
 * for, the outcomes, the question text, notes) with two markers replaced by what is generated:
 *
 * - `<!-- slot-docs:options -->`: the options table (name, type, default, what it does) read from
 *   the type's options schema and its `.describe(...)` text, then a table of its text parts with
 *   their default templates and a table of its question ids;
 * - `<!-- slot-docs:examples -->`: the type's starter examples (examples.yaml) as slots.yaml
 *   snippets, with what a caller says, the answers the model gives and the outcome expected.
 *
 * Nothing in the generated parts is written by hand, so an option added, renamed or re-described
 * shows up in the page, and a page that was not regenerated fails the test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { slotTypeJsonSchema } from '../src/slots/defineSlot';
import { BUILT_IN_SLOT_TYPES } from '../src/slots/registry';
import type { SlotExample, SlotType, SlotUtterance } from '../src/slots/types';

export const OPTIONS_MARKER = '<!-- slot-docs:options -->';
export const EXAMPLES_MARKER = '<!-- slot-docs:examples -->';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The package's slot library: one folder per type, each with a README.md. */
export const SLOTS_SRC = join(HERE, '..', 'src', 'slots');
/** Where the pages are committed. */
export const SLOT_DOCS_DIR = join(HERE, '..', '..', '..', 'docs', 'slots');

type Json = Record<string, any>;

/** A text part as a type declares it (parts/text.ts TextParts), found among a type module's exports. */
interface PartsLike {
  names: readonly string[];
  defs: Readonly<Record<string, { template: string; vars: readonly string[]; about: string }>>;
}

const isParts = (x: unknown): x is PartsLike =>
  typeof x === 'object' && x !== null && Array.isArray((x as PartsLike).names) && typeof (x as PartsLike).defs === 'object' && typeof (x as { render?: unknown }).render === 'function';

// ---- Markdown helpers -------------------------------------------------------------------------

/** `s` as an inline code span, whatever it contains. */
function code(s: string): string {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const padded = longest > 0 || s.startsWith('`') || s.endsWith('`') ? ` ${s} ` : s;
  return `${fence}${padded}${fence}`.replace(/\|/g, '\\|');
}

/** Prose for a table cell: a pipe is escaped and a bare `<name>` is not taken for an HTML tag; code spans are kept. */
function prose(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/\|/g, '\\|');
      // a placeholder such as ask_<slot>_dtmf becomes a code span; any other angle bracket is escaped
      const spanned = part.replace(/[A-Za-z0-9_./{]*<[A-Za-z0-9_]+>[A-Za-z0-9_./}]*/g, (m) => `\u0000${m}\u0001`);
      return spanned
        .replace(/\|/g, '\\|')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\u0000([^\u0001]*)\u0001/g, (_m, inner: string) => `\`${inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>')}\``);
    })
    .join('')
    .replace(/\n/g, ' ');
}

const table = (head: string[], rows: string[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// ---- Options, read from the JSON Schema -------------------------------------------------------

function typeLabel(s: Json): string {
  if (s.const !== undefined) return code(JSON.stringify(s.const));
  if (Array.isArray(s.enum)) return `one of ${s.enum.map((v: unknown) => code(String(v))).join(', ')}`;
  const alternatives = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (alternatives) return [...new Set(alternatives.map(typeLabel))].join(' or ');
  switch (s.type) {
    case 'integer':
    case 'number': {
      const lo = typeof s.minimum === 'number' ? s.minimum : undefined;
      const hi = typeof s.maximum === 'number' && s.maximum < 1e9 ? s.maximum : undefined;
      const range = lo !== undefined && hi !== undefined ? `, ${lo} to ${hi}` : lo !== undefined ? `, ${lo} or more` : hi !== undefined ? `, up to ${hi}` : '';
      return `${s.type}${range}`;
    }
    case 'array':
      return `list of ${s.items ? typeLabel(s.items) : 'values'}`;
    case 'object':
      if (s.additionalProperties && typeof s.additionalProperties === 'object') return `map of ${typeLabel(s.additionalProperties)}`;
      return 'map';
    default:
      return typeof s.type === 'string' ? s.type : 'value';
  }
}

const defaultOf = (s: Json): string => (!('default' in s) ? 'unset' : code(typeof s.default === 'string' ? s.default : JSON.stringify(s.default)));

interface Row {
  path: string;
  type: string;
  def: string;
  about: string;
}

interface Collected {
  rows: Row[];
  /** `text` and `ids` objects, by path: written out in their own tables. */
  texts: { path: string; schema: Json }[];
  ids: { path: string; schema: Json }[];
}

function collect(schema: Json, prefix: string, out: Collected): void {
  const required = new Set<string>(schema.required ?? []);
  for (const [key, s] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    if (prefix === '' && key === 'type') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === 'text' && s.properties) out.texts.push({ path, schema: s });
    if (key === 'ids' && s.properties) out.ids.push({ path, schema: s });
    const isGroup = (key === 'text' || key === 'ids') && s.properties;
    out.rows.push({
      path,
      type: typeLabel(s),
      def: required.has(key) ? 'required' : defaultOf(s),
      about: typeof s.description === 'string' ? s.description : '',
    });
    if (isGroup) continue;
    if (s.type === 'object' && s.properties) collect(s, path, out);
    const value = s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object' ? (s.additionalProperties as Json) : undefined;
    if (value) {
      const branches = (value.anyOf ?? [value]) as Json[];
      for (const branch of branches) if (branch.type === 'object' && branch.properties) collect(branch, `${path}.<key>`, out);
    }
  }
}

function optionsSection(type: SlotType<any, any>, parts: PartsLike[]): string {
  const schema = slotTypeJsonSchema(type) as Json;
  const out: Collected = { rows: [], texts: [], ids: [] };
  collect(schema, '', out);
  const lines: string[] = [];
  lines.push(
    `A slot of this type is written under its id in slots.yaml, with \`type: ${type.type}\` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.`,
    '',
    table(
      ['Option', 'Type', 'Default', 'What it does'],
      out.rows.map((r) => [code(r.path), r.type, r.def, prose(r.about)]),
    ),
  );

  const partRows: string[][] = [];
  for (const { path, schema: group } of out.texts) {
    const keys = Object.keys(group.properties as object);
    const parts_ = parts.find((p) => p.names.length === keys.length && keys.every((k) => p.names.includes(k)));
    for (const key of keys) {
      const def = parts_?.defs[key];
      const about = def?.about ?? (group.properties[key].description as string | undefined) ?? '';
      const vars = def && def.vars.length > 0 ? ` Variables: ${def.vars.map((v) => code(`{${v}}`)).join(', ')}.` : '';
      partRows.push([code(`${path}.${key}`), prose(about) + vars, def ? (def.template === '' ? 'none (empty)' : code(def.template)) : 'see the type\'s notes']);
    }
  }
  if (partRows.length > 0) {
    lines.push(
      '',
      '### Text parts',
      '',
      'The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.',
      '',
      table(['Part', 'What it is', 'Default'], partRows),
    );
  }

  const idRows: string[][] = [];
  for (const { path, schema: group } of out.ids) {
    for (const [key, s] of Object.entries(group.properties as Record<string, Json>)) idRows.push([code(`${path}.${key}`), prose(String(s.description ?? ''))]);
  }
  if (idRows.length > 0) {
    lines.push(
      '',
      '### Question ids',
      '',
      'A question\'s id is the slot\'s id followed by the part\'s name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.',
      '',
      table(['Key', 'What it renames'], idRows),
    );
  }
  return lines.join('\n');
}

// ---- Examples ---------------------------------------------------------------------------------

const yamlOf = (value: unknown): string => stringify(value, { lineWidth: 0 }).trimEnd();

function answerCell(answers: SlotUtterance['answers']): string {
  if (!answers || Object.keys(answers).length === 0) return 'none';
  return Object.entries(answers)
    .map(([id, a]) => {
      if ('noul' in a) return `${code(id)}: yes ${a.noul}`;
      const probs = 'choice' in a ? a.choice : a.score;
      return `${code(id)}: ${Object.entries(probs).map(([label, p]) => `${code(label)} ${p}`).join(', ')}`;
    })
    .join('<br>');
}

function contextNote(context: SlotUtterance['context']): string {
  if (!context) return '';
  const bits = Object.entries(context).map(([k, v]) => {
    if (v === true) return k;
    // Nominations as the topics' ids, best first, rather than the whole records.
    if (k === 'nominated' && Array.isArray(v)) return `nominated ${v.length === 0 ? 'nothing' : v.map((n: { topic: string }) => n.topic).join(', ')}`;
    return `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  });
  return bits.length > 0 ? `<br>_${prose(bits.join('; '))}_` : '';
}

function outcomeCell(e: SlotUtterance['expect']): string {
  const { kind, displays, ...rest } = e;
  const bits = Object.entries(rest).map(([k, v]) => `${k} ${code(String(v))}`);
  for (const [locale, shown] of Object.entries(displays ?? {})) bits.push(`display in ${locale} ${code(shown)}`);
  return bits.length > 0 ? `${kind}: ${bits.join(', ')}` : kind;
}

function exampleSection(type: SlotType<any, any>, example: SlotExample): string {
  const lines: string[] = [`#### ${example.name}`, ''];
  if (example.about) lines.push(example.about, '');
  lines.push('```yaml', yamlOf({ [example.slot]: { type: type.type, ...example.config } }), '```', '');
  if (example.topics) {
    const rows = example.topics.map((t) => [code(t.id), prose(t.title), Object.entries(t.titles ?? {}).map(([tag, title]) => `${tag}: ${prose(title)}`).join('<br>') || 'none']);
    lines.push('Built with the knowledge topics:', '', table(['Topic', 'Title', 'Titles by locale'], rows), '');
  }
  if (example.wording) {
    for (const [tag, wording] of Object.entries(example.wording)) lines.push(`In \`locale/${tag}/slots.yaml\`:`, '', '```yaml', yamlOf({ [example.slot]: wording }), '```', '');
  }
  const utterances = example.utterances.map((u) => [prose(u.text) + contextNote(u.context), answerCell(u.answers), prose(outcomeCell(u.expect))]);
  lines.push(`<details><summary>Starter utterances (${utterances.length})</summary>`, '', table(['The caller says', 'The model answers', 'The slot gives'], utterances), '', '</details>');
  if (example.keypad && example.keypad.length > 0) {
    const keys = example.keypad.map((k) => [code(k.digits), k.locale ?? 'any', k.expect ? `${code(k.expect.value)}${k.expect.display ? `, said ${code(k.expect.display)}` : ''}` : 'no value']);
    lines.push('', `<details><summary>Keypad (${keys.length})</summary>`, '', table(['Keys', 'Locale', 'The slot gives'], keys), '', '</details>');
  }
  return lines.join('\n');
}

function examplesSection(type: SlotType<any, any>): string {
  return [
    '### Starter examples',
    '',
    'Each configuration below is built and run by the type\'s tests (the conformance kit), so what it shows is what the slot does. A slot reads the model\'s answers, not the caller\'s words, so an utterance lists both.',
    '',
    ...type.examples.flatMap((e) => [exampleSection(type, e), '']),
  ]
    .join('\n')
    .trimEnd();
}

// ---- Pages ------------------------------------------------------------------------------------

/** The type's page: its README with the generated sections in place of the markers. */
export function renderSlotPage(type: SlotType<any, any>, readme: string, parts: PartsLike[]): string {
  for (const marker of [OPTIONS_MARKER, EXAMPLES_MARKER]) {
    if (readme.split(marker).length !== 2) throw new Error(`the README of the "${type.type}" type must have the line ${marker} exactly once`);
  }
  const notice = `> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/${type.type}/README.md), and the options, text parts, question ids and examples are read from its options schema and \`examples.yaml\`. To change it, edit those and run \`pnpm --filter dialogwright slot-docs\`.`;
  const body = readme.replace(OPTIONS_MARKER, optionsSection(type, parts)).replace(EXAMPLES_MARKER, examplesSection(type));
  const [title, ...rest] = body.split('\n');
  return `${title}\n\n${notice}\n${rest.join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Every built-in type's page, by file name (`digits.md`). */
export async function slotPages(): Promise<Record<string, string>> {
  const pages: Record<string, string> = {};
  for (const type of Object.values(BUILT_IN_SLOT_TYPES)) {
    const module = (await import(`../src/slots/${type.type}/index`)) as Record<string, unknown>;
    const parts = Object.values(module).filter(isParts);
    const readme = readFileSync(join(SLOTS_SRC, type.type, 'README.md'), 'utf8');
    pages[`${type.type}.md`] = renderSlotPage(type, readme, parts);
  }
  return pages;
}

async function main(): Promise<void> {
  mkdirSync(SLOT_DOCS_DIR, { recursive: true });
  for (const [file, text] of Object.entries(await slotPages())) {
    writeFileSync(join(SLOT_DOCS_DIR, file), text);
    console.log(`wrote ${join(SLOT_DOCS_DIR, file)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { contentHash } from '../core/app/configHash';
import { identityOf } from '../core/app/lookup';
import type { App, SlotId } from '../core/app/types';
import type { LibrarySlotSpec } from '../slots/types';
import { lineDiff } from './policyMatrix';

/**
 * Support for the pages the framework writes from an app's configuration (the policy card, the app
 * map): the words they share, Mermaid and Markdown escaping, the config hash of a file beside the
 * page, and the golden check and write each page has, as policy.matrix has. A page is a golden: a test
 * compares the file with what the app generates today (expectGeneratedPage) and fails with a line
 * diff and the command that writes it; only the command writes it (writeGeneratedPage), never CI.
 */

/** A word for an id: `missingNote` is "missing note", `accountId` "account ID", `report_missing` "report missing". */
export function humanize(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_.-]+/).filter(Boolean).map((w) => w.toLowerCase());
  return words.map((w) => (w === 'id' ? 'ID' : w)).join(' ');
}

/** A label as running text: its first letter lower case unless the first word is an acronym ("Date of birth" is "date of birth", "Account ID" is "account ID", "ID card" stays). */
export function lowerFirst(label: string): string {
  const first = label.split(' ')[0] ?? '';
  return first.length > 1 && first === first.toUpperCase() ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The words for a slot in running text: the type's own noun, else the console's label, else its id spelled out. */
export function slotNoun(app: App, slot: SlotId): string {
  const spec = Object.hasOwn(app.slots, slot) ? (app.slots[slot] as Partial<LibrarySlotSpec<{ noun?: unknown }>>) : undefined;
  const noun = spec?.config?.noun;
  if (typeof noun === 'string' && noun !== '') return noun;
  const label = app.console?.slotLabels?.[slot];
  return label ? lowerFirst(label) : humanize(slot);
}

/** The words for a param of a call: a slot's noun where the param is a slot, else the param spelled out. */
export function paramNoun(app: App, param: string): string {
  return Object.hasOwn(app.slots, param) ? slotNoun(app, param) : humanize(param);
}

/** An intent or form in words: its label in the console, else its intent's, else an internal form's own, else the id spelled out. */
export function formWords(app: App, form: string): string {
  return app.console?.formLabels?.[form] ?? app.intents[form]?.label ?? (Object.hasOwn(app.forms, form) ? app.forms[form]!.label : undefined) ?? humanize(form);
}

/** A level as the identity names it: "verified"; level 0 is "anonymous", and a level the ladder does not name is "level N". */
export function levelName(app: App, level: number): string {
  if (level === 0) return 'anonymous';
  const names = identityOf(app).levelNames as Readonly<Record<number, string | undefined>> | undefined;
  return names?.[level] ?? `level ${level}`;
}

/** Text inside a quoted Mermaid label: quotes and angle brackets as entities, line breaks as <br/>. */
export function mermaidText(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\r?\n/g, '<br/>');
}

/** A quoted Mermaid label from lines (joined by <br/>). */
export function mermaidLabel(...lines: string[]): string {
  return `"${lines.map(mermaidText).join('<br/>')}"`;
}

/** A Mermaid node id from a word: letters, digits and underscores only, so no id is a reserved word or breaks the syntax. */
export function nodeId(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/** Text in a Markdown table cell: a pipe and a line break would end it. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Text in code font, as Markdown writes it (a backtick in it is swapped for a quote, since a nested one would end the span). */
export function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/** A list in words: "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The content hash of a config file in `dir`, as the engine records it (App.configHashes), or null when there is no such file. */
function fileHash(dir: string, file: string): string | null {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  const doc = parseDocument(readFileSync(path, 'utf8'), { version: '1.2', schema: 'core', logLevel: 'error', customTags: [] });
  return contentHash(doc.toJS({ maxAliasCount: 100 }));
}

/**
 * The config hash of one of the app's files: the one the app was built with (App.configHashes, for an
 * app folder), else the hash of the file in `dir` (an app that loads its policy and identity with
 * definePolicy and defineIdentity has none); null when there is no such file.
 */
export function configHashOf(app: App, dir: string, file: string): string | null {
  return app.configHashes?.files[file] ?? fileHash(dir, file);
}

/**
 * Fails, with a line diff, when `file` is not `text`, the page the app generates today ("-" the file,
 * "+" what the app generates). `regenerate` is the command that writes it. Never writes the file.
 */
export function expectGeneratedPage(app: App, file: string, text: string, regenerate: string, what: string): void {
  if (!existsSync(file)) throw new Error(`there is no ${what} at ${file}: write it with \`${regenerate}\`, then review it and commit it`);
  const expected = readFileSync(file, 'utf8');
  if (expected === text) return;
  throw new Error([
    `${file} is not the ${what} "${app.id}" generates today ("-" the file, "+" what it generates):`,
    lineDiff(expected, text),
    `If the change is meant, write it with \`${regenerate}\` and review the diff before you commit it.`,
  ].join('\n'));
}

/** Writes `text` to `file` when it differs; whether it changed and how many lines it has. For a command, never a test. */
export function writeGeneratedPage(file: string, text: string): { changed: boolean; lines: number } {
  const changed = !existsSync(file) || readFileSync(file, 'utf8') !== text;
  if (changed) writeFileSync(file, text);
  return { changed, lines: text.split('\n').length - 1 };
}

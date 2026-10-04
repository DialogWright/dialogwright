import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, Document as YamlDocument, isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';
import { isOldIdentityContent, isOldPolicyContent } from './convert/legacyShape';
import { WHOLE_FILE, closest, formatPath, keyPositionOf, positionOf, problemsOfIssues, type DataPath, type Problem } from './problems';
import {
  FILE_KINDS, FILE_NAMES, FOLDER_FILES, REQUIRED_KINDS, SCHEMAS, SLOTS_FILE, localeSlotsSchema, slotsSchema,
  type AppYaml, type FileKind, type FormsYaml, type IdentityYaml, type IntentsYaml, type LocaleSlotsYaml, type PolicyYaml, type PromptYaml,
  type PromptsYaml, type SlotsYaml,
} from './schema/index';
import { jsonSchemaFor, type JsonSchema } from './schema/json';
import { z } from 'zod';
import { DEFAULT_LOCALE } from '../core/locale';
import { configHashesOf } from '../core/app/configHash';
import type { ConfigHashes } from '../core/app/types';
import { readKbFolder, type KbEntry, type KbFolderIo } from '../kb/folder';
import { kbContentProblems } from '../kb/rules';
import { KB_KINDS, type KbKind } from '../kb/schema';
import type { KnowledgeBase } from '../kb/types';

export type { Problem } from './problems';

/**
 * Reads an app folder: its YAML files, parsed safely, checked against their schemas, and put into
 * typed configuration. Every problem found comes back with the file, line, column, path and a fix;
 * nothing is thrown for bad input, so one pass shows an author everything that is wrong.
 *
 * What the folder holds (see ./schema for each file's contents):
 *
 *   app.yaml  intents.yaml  forms.yaml  prompts.yaml  policy.yaml     required
 *   identity.yaml                                                     optional (no file: the app verifies no one)
 *   slots.yaml                                                        optional (no file: every slot is the code's)
 *   locale/<tag>/prompts.yaml                                         the prompts of another locale
 *   locale/<tag>/slots.yaml                                           optional: its wording for the library slots
 *   kb/                                                               optional: the knowledge base (../kb/folder.ts)
 *
 * The YAML is only ever data. It is parsed with the YAML 1.2 core schema (no custom tags, no
 * timestamps or binary, no merge keys), duplicate keys are errors, aliases are capped, and nothing
 * in it is evaluated. The loader reads only files that resolve to a place inside the folder, so a
 * link that points elsewhere cannot make it read a file it was not given.
 */

/** The parsed, valid configuration of an app folder. */
export interface LoadedConfig {
  app: AppYaml;
  intents: IntentsYaml;
  forms: FormsYaml;
  /** policy.yaml: the actions and their rules. */
  policy: PolicyYaml;
  /** Null when the folder has no identity.yaml: the app verifies no one. */
  identity: IdentityYaml | null;
  /**
   * slots.yaml as parsed: each slot's `type` and options, in the file's order (the order of
   * `App.slots`). Null when the folder has no slots.yaml: every slot is the code's. Only the outer
   * shape is checked here; the options of a library type are checked when the slots are built
   * (defineApp, `check`), since they depend on the types the app registers.
   */
  slots: SlotsYaml | null;
  /** The locale of prompts.yaml: app.yaml's `locale`, else en-US. */
  defaultLocale: string;
  /** Every prompt of each locale, by locale tag then prompt id. The default locale's come from prompts.yaml, the others' from locale/<tag>/prompts.yaml. */
  prompts: Record<string, Record<string, PromptYaml>>;
  /**
   * Each other locale's wording for the library slots (locale/<tag>/slots.yaml), by locale tag then
   * slot id, for the locales that have the file. Only the outer shape is checked here; what each
   * entry may hold is the slot type's to say, checked when the slots are built (slots/wording.ts).
   */
  localeSlots: Record<string, LocaleSlotsYaml>;
  /**
   * The knowledge base, when the folder has a kb/ (../kb/folder.ts reads it; the rules that need
   * only the knowledge base itself, ../kb/rules.ts kbContentProblems, have passed). Absent without one.
   */
  knowledge?: KnowledgeBase;
  /**
   * The content hash of every file read (app.yaml, ..., identity.yaml and slots.yaml when there are, and each
   * locale/<tag>/prompts.yaml and locale/<tag>/slots.yaml, and every file of kb/ the knowledge base is read from: not
   * its drafts in kb/pending, which are never read, nor its hidden kb/.index), by its path in the folder, and the combined hash (App.configHashes;
   * core/app/configHash.ts). Each is taken over the file's parsed content, so comments, whitespace
   * and quoting do not change it; key order does, since it is meaning (slots.yaml's is the slot order).
   */
  hashes: ConfigHashes;
}

export interface LoadResult {
  /** The configuration when the folder has no problems; otherwise null (a partly valid folder is not an app). */
  config: LoadedConfig | null;
  /** Everything wrong with the folder, ordered by file then position; empty when it is valid. */
  problems: Problem[];
  /**
   * Where a data path is in a file that was read: for a check that finds a problem after loading
   * (a prompt that does not exist, say) and wants to point at the line. `file` is relative to the
   * folder ("forms.yaml"); null when the file was not read or the path is not in it.
   */
  locate(file: string, path: DataPath): { line: number; column: number } | null;
  /** Where the key that holds the value at `path` is (for a problem with the key itself, such as a label for a form that does not exist); as `locate` otherwise. */
  locateKey?(file: string, path: DataPath): { line: number; column: number } | null;
  /** The parsed YAML of a file that was read, with its line table, for a check that builds something from it and positions its problems (slots.yaml's library slots). */
  document?(file: string): { doc: Document; lines: LineCounter } | null;
}

/** The locale an app has when it does not say (core/locale.ts). */
export { DEFAULT_LOCALE };

/** A YAML file bigger than this is refused: configuration is hand-written text, and parsing is bounded by size. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * The yaml library's `maxAliasCount`: a bound on how much aliases may expand, not on how many a file
 * has. Each time an alias (`*name`) is resolved, its anchor's use count goes up by one, and that
 * count times the anchor's own expansion (1 for an anchored value with no aliases inside; for one
 * that holds aliases, the largest such product among them) must stay at or under this. So a plain
 * anchor may be referred to 20 times, and an anchor whose value itself refers to others far fewer:
 * the nested "billion laughs" expansion is refused. Apps need no aliases.
 */
const MAX_ALIAS_COUNT = 20;

/** Keys JavaScript objects give a meaning of their own: as an id they are dropped or shadow the object's own properties. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A language tag as a locale directory or `locale:` names it. */
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** What each file starts with, for a missing or empty file's fix. */
const STARTS_WITH: Record<Kind, string> = {
  ...(Object.fromEntries(Object.entries(KB_KINDS).map(([kind, def]) => [kind, def.startsWith])) as Record<KbKind, string>),
  app: 'an id, for example "id: my-app"',
  intents: 'the "intents:" map and the "menu:" list',
  forms: 'the "forms:" map',
  prompts: 'the "prompts:" map',
  policy: '"actions:", each tool with its level and rules, for example "actions: { getRecord: { level: 1, rules: [identity] } }"',
  identity: '"principals:", "levels:" and "attempts:"',
  slots: 'a slot id and its type, for example "note: { type: code }"',
  localeSlots: 'a slot id and what it says in this locale, for example "branch: { options: { north: Norte } }"',
};

/** A kind of file the loader checks: the six, the optional slots.yaml, a locale's optional slots.yaml, and the knowledge base's. */
type Kind = FileKind | 'slots' | 'localeSlots' | KbKind;
const SCHEMAS_OF: Record<Kind, z.ZodType> = {
  ...SCHEMAS,
  slots: slotsSchema,
  localeSlots: localeSlotsSchema,
  ...(Object.fromEntries(Object.entries(KB_KINDS).map(([kind, def]) => [kind, def.schema])) as unknown as Record<KbKind, z.ZodType>),
};
const isKbKind = (kind: Kind): kind is KbKind => Object.hasOwn(KB_KINDS, kind);

/** What to do about each kind of YAML syntax error (the codes are the `yaml` library's). */
const SYNTAX_FIXES: Record<string, string> = {
  DUPLICATE_KEY: 'delete one of the two keys, or rename one if both are meant',
  TAB_AS_INDENT: 'indent with spaces: YAML does not allow tabs for indentation',
  BAD_INDENT: 'indent with spaces so the line lines up with its siblings (each level two spaces further in)',
  MISSING_CHAR: 'add the missing character shown in the message (a closing quote, bracket or colon)',
  BLOCK_AS_IMPLICIT_KEY: 'write "key: value" with a space after the colon, and one key per line',
  BAD_DQ_ESCAPE: 'fix or remove the backslash escape in the double-quoted text, or use single quotes, where a backslash is just a backslash',
  MULTIPLE_DOCS: 'keep one YAML document per file: delete the extra "---" and what follows it, or move it to its own file',
  TAG_RESOLVE_FAILED: 'delete the "!tag": these files are plain data, with no custom tags',
  BAD_ALIAS: 'delete the alias, or define its anchor (&name) earlier in the file',
  UNEXPECTED_TOKEN: 'remove or correct the text at this position; check for a missing colon after a key or a stray character',
};

/**
 * Loads the app folder at `dir`. Never throws for what is in the folder: a missing folder, an
 * unreadable file, bad YAML and a value of the wrong kind all come back as problems.
 */
export function loadAppFolder(dir: string): LoadResult {
  const problems: Problem[] = [];
  const documents = new Map<string, { doc: Document; lines: LineCounter }>();
  const locate: LoadResult['locate'] = (file, path) => {
    const read = documents.get(file);
    return read ? positionOf(read.doc, read.lines, path) : null;
  };
  const locateKey: LoadResult['locateKey'] = (file, path) => {
    const read = documents.get(file);
    return read ? keyPositionOf(read.doc, read.lines, path) : null;
  };
  let config: LoadedConfig | null = null;
  try {
    config = load(dir, problems, documents);
  } catch (error) {
    // Nothing in a folder should get here; if something does, it is reported, not thrown at the caller.
    problems.push(problemAt('.', WHOLE_FILE, `the app folder could not be loaded (${error instanceof Error ? error.message : String(error)})`, 'check the folder is readable and its files are plain text'));
  }
  const document: LoadResult['document'] = (file) => documents.get(file) ?? null;
  return { config: problems.length === 0 ? config : null, problems: sortProblems(problems), locate, locateKey, document };
}

function load(dir: string, problems: Problem[], documents: Map<string, { doc: Document; lines: LineCounter }>): LoadedConfig | null {
  // Each valid file's parsed content, by its path in the folder: what the hashes are taken over.
  const contents: Record<string, unknown> = {};
  const root = resolveRoot(dir);
  if ('problem' in root) {
    problems.push(root.problem);
    return null;
  }

  const valid: Partial<{ app: AppYaml; intents: IntentsYaml; forms: FormsYaml; prompts: PromptsYaml; policy: PolicyYaml; identity: IdentityYaml; slots: SlotsYaml }> = {};
  const top = listTopLevel(root.real);
  for (const kind of [...(Object.keys(FILE_NAMES) as FileKind[]), 'slots' as const]) {
    const file = kind === 'slots' ? SLOTS_FILE : FILE_NAMES[kind];
    const read = readFile(root.real, file);
    if (read.kind === 'missing') {
      if (kind !== 'slots' && REQUIRED_KINDS.includes(kind)) problems.push(missingFile(file, kind, top));
      continue;
    }
    if (read.kind === 'problem') {
      problems.push(read.problem);
      continue;
    }
    const checked = checkFile(file, kind, read.text, problems, documents, contents);
    if (checked !== undefined) (valid as Record<string, unknown>)[kind] = checked;
  }
  strayYamlFiles(top, problems);

  const defaultLocale = valid.app?.locale ?? DEFAULT_LOCALE;
  const prompts: Record<string, Record<string, PromptYaml>> = {};
  const localeSlots: Record<string, LocaleSlotsYaml> = {};
  if (valid.prompts) prompts[defaultLocale] = valid.prompts.prompts;
  for (const { tag, dirName } of listLocales(root.real, problems)) {
    if (tag.toLowerCase() === defaultLocale.toLowerCase() && valid.app) {
      problems.push({
        file: `locale/${dirName}`,
        line: 1,
        column: 1,
        path: WHOLE_FILE,
        message: `locale/${dirName} is the app's default locale (${defaultLocale}), whose prompts are in prompts.yaml`,
        fix: `move the prompts you want into prompts.yaml and delete locale/${dirName}, or give app.yaml a different "locale:" if ${tag} is not the default`,
      });
      continue;
    }
    const file = `locale/${dirName}/prompts.yaml`;
    const read = readFile(root.real, file);
    if (read.kind === 'missing') {
      problems.push({
        file: `locale/${dirName}`,
        line: 1,
        column: 1,
        path: WHOLE_FILE,
        message: `locale/${dirName} has no prompts.yaml, so the locale ${tag} has no prompts`,
        fix: `add locale/${dirName}/prompts.yaml with a "prompts:" map (same shape as prompts.yaml), or delete the folder`,
      });
      continue;
    }
    if (read.kind === 'problem') {
      problems.push(read.problem);
      continue;
    }
    const checked = checkFile(file, 'prompts', read.text, problems, documents, contents);
    if (checked) prompts[tag] = (checked as { prompts: Record<string, PromptYaml> }).prompts;
    // The locale's wording for the library slots, when it has any.
    const slotsFile = `locale/${dirName}/${SLOTS_FILE}`;
    const slotsRead = readFile(root.real, slotsFile);
    if (slotsRead.kind === 'problem') problems.push(slotsRead.problem);
    if (slotsRead.kind !== 'ok') continue;
    const wording = checkFile(slotsFile, 'localeSlots', slotsRead.text, problems, documents, contents);
    if (wording !== undefined) localeSlots[tag] = wording as LocaleSlotsYaml;
  }

  // The knowledge base, when there is one.
  let knowledge: KnowledgeBase | null = null;
  if (existsNoFollow(join(root.real, 'kb'))) {
    const io = kbIo(root.real, problems, documents, contents);
    const before = problems.length;
    knowledge = readKbFolder({ base: 'kb', defaultLocale, io, problems });
    if (knowledge && problems.length === before) problems.push(...kbContentProblems(knowledge, io.locate));
  }

  if (!valid.app || !valid.intents || !valid.forms || !valid.policy || !valid.prompts) return null;
  return {
    app: valid.app,
    intents: valid.intents,
    forms: valid.forms,
    policy: valid.policy,
    identity: valid.identity ?? null,
    slots: valid.slots ?? null,
    defaultLocale,
    prompts,
    localeSlots,
    ...(knowledge ? { knowledge } : {}),
    hashes: configHashesOf(contents),
  };
}

/** How the knowledge base's files are read: with this loader's own reading and parsing, under the folder's real path. */
function kbIo(root: string, problems: Problem[], documents: Map<string, { doc: Document; lines: LineCounter }>, contents: Record<string, unknown>): KbFolderIo & { locate: (file: string, path: DataPath) => { line: number; column: number } | null } {
  return {
    read: (file) => readFile(root, file),
    readData: (file, maxBytes) => readFile(root, file, maxBytes),
    parse: (file, kind, text) => checkFile(file, kind, text, problems, documents, contents),
    list: (dir) => listDir(root, dir),
    locate: (file, path) => {
      const read = documents.get(file);
      return read ? positionOf(read.doc, read.lines, path) : null;
    },
  };
}

/**
 * The entries of a folder (a path from the app folder), each a folder or not, links followed: a
 * link to a folder inside the app folder counts as one. A link that leads out of the app folder, or
 * nowhere, counts as a file, which is refused when it is read; a folder that is itself such a link
 * is 'outside', and none of it is read.
 */
function listDir(root: string, dir: string): KbEntry[] | 'missing' | 'not-a-directory' | 'outside' {
  const abs = join(root, ...dir.split('/'));
  if (!existsNoFollow(abs)) return 'missing';
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return 'not-a-directory';
  }
  if (!isInside(root, real)) return 'outside';
  try {
    if (!statSync(real).isDirectory()) return 'not-a-directory';
  } catch {
    return 'not-a-directory';
  }
  try {
    return readdirSync(real, { withFileTypes: true }).map((e) => {
      if (!e.isSymbolicLink()) return { name: e.name, dir: e.isDirectory() };
      try {
        const target = realpathSync(join(real, e.name));
        return { name: e.name, dir: isInside(root, target) && statSync(target).isDirectory() };
      } catch {
        return { name: e.name, dir: false };
      }
    });
  } catch {
    return 'not-a-directory';
  }
}

// ---------------------------------------------------------------------------------------------
// The folder and its files
// ---------------------------------------------------------------------------------------------

function problemAt(file: string, path: string, message: string, fix: string, line = 1, column = 1): Problem {
  return { file, line, column, path, message, fix };
}

/** The folder's real path (links resolved), or why there is none. */
function resolveRoot(dir: string): { real: string } | { problem: Problem } {
  try {
    const real = realpathSync(resolve(dir));
    if (!statSync(real).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    return { real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'does not exist' : code === 'ENOTDIR' ? 'is not a directory' : `cannot be read (${code ?? String(error)})`;
    return { problem: problemAt('.', WHOLE_FILE, `the app folder "${dir}" ${why}`, 'pass the path of the folder that holds app.yaml, intents.yaml, forms.yaml, prompts.yaml and policy.yaml') };
  }
}

/** Whether `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

type ReadResult = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'problem'; problem: Problem };

/**
 * Reads `file` (relative to the folder) as UTF-8 text, if it is a plain file that resolves to a
 * place inside the folder: a link to anywhere else is refused, as are directories, huge files and
 * text that is not UTF-8.
 */
function readFile(root: string, file: string, maxBytes: number = MAX_FILE_BYTES): ReadResult {
  const abs = join(root, ...file.split('/'));
  try {
    if (!existsNoFollow(abs)) return { kind: 'missing' };
    const real = realpathSync(abs);
    if (!isInside(root, real)) {
      return {
        kind: 'problem',
        problem: problemAt(
          file,
          WHOLE_FILE,
          `${file} resolves to ${real}, which is outside the app folder`,
          `replace the link with a regular file (or a link to a file) inside the app folder; files outside it are never read`,
        ),
      };
    }
    const stat = statSync(real);
    if (!stat.isFile()) return { kind: 'problem', problem: problemAt(file, WHOLE_FILE, `${file} is not a regular file`, `make ${file} a file of YAML text, not a directory or device`) };
    if (stat.size > maxBytes) {
      return { kind: 'problem', problem: problemAt(file, WHOLE_FILE, `${file} is ${stat.size} bytes, over the ${maxBytes} byte limit`, 'split the content, or remove what does not belong in a configuration file') };
    }
    const bytes = readFileSync(real);
    try {
      return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, '') };
    } catch {
      return { kind: 'problem', problem: problemAt(file, WHOLE_FILE, `${file} is not valid UTF-8 text`, 'save the file as UTF-8') };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // existsNoFollow found something at the path, so what is missing is the file it links to.
      return { kind: 'problem', problem: problemAt(file, WHOLE_FILE, `${file} is a link to a file that does not exist`, `point the link at a file inside the app folder, or replace it with the file itself`) };
    }
    return { kind: 'problem', problem: problemAt(file, WHOLE_FILE, `${file} could not be read (${code ?? String(error)})`, 'check the file exists and is readable') };
  }
}

/** Whether something is at `path`, a link included (a dangling link exists, and is then refused when read). */
function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The names in the folder itself (not below it). */
function listTopLevel(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** The fix for a required file that is not there: a near miss in the folder is the likely cause. */
function missingFile(file: string, kind: Kind, top: readonly string[]): Problem {
  const stem = file.replace(/\.yaml$/, '');
  const near = top.find((name) => name === `${stem}.yml`) ?? closest(file, top.filter((name) => /\.ya?ml$/.test(name)));
  const hint = near ? ` There is a "${near}" here: rename it to ${file}.` : '';
  return problemAt(file, WHOLE_FILE, `${file} is missing`, `create ${file}; it starts with ${STARTS_WITH[kind]}.${hint}`);
}

/** YAML files in the folder that DialogWright does not read: almost always a misspelled name. */
function strayYamlFiles(top: readonly string[], problems: Problem[]): void {
  const known = new Set<string>(FOLDER_FILES);
  for (const name of top) {
    if (!/\.ya?ml$/.test(name) || known.has(name)) continue;
    const near = closest(name.replace(/\.ya?ml$/, '.yaml'), [...known]);
    problems.push(
      problemAt(
        name,
        WHOLE_FILE,
        `${name} is not a file DialogWright reads; the YAML files are ${[...known].join(', ')}`,
        near ? `rename ${name} to ${near}` : `delete ${name}, or move it out of the app folder`,
      ),
    );
  }
}

/**
 * The locale directories (locale/<tag>), each with a valid language tag and each tag once (a tag's
 * letter case does not make it another locale). A file where a locale folder belongs is a problem;
 * a hidden file (an editor's or the system's, like .DS_Store) is not.
 */
function listLocales(root: string, problems: Problem[]): { tag: string; dirName: string }[] {
  const base = join(root, 'locale');
  let entries: string[];
  try {
    const all = readdirSync(base, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    for (const e of all.filter((x) => !x.isDirectory() && !x.isSymbolicLink())) {
      problems.push(
        problemAt(
          `locale/${e.name}`,
          WHOLE_FILE,
          `locale/${e.name} is a file; locale/ holds one folder per locale, each with its prompts.yaml`,
          e.name === FILE_NAMES.prompts
            ? 'move it into a folder named for its language tag: locale/<tag>/prompts.yaml (for example locale/fr/prompts.yaml)'
            : `delete locale/${e.name}, or move it out of the app folder`,
        ),
      );
    }
    entries = all.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      problems.push(problemAt('locale', WHOLE_FILE, 'locale is a file; it must be a folder with one folder per locale (locale/<tag>/prompts.yaml)', 'delete the file, or make locale a folder'));
    }
    return [];
  }
  const locales: { tag: string; dirName: string }[] = [];
  const twins = caseTwins(entries);
  for (const name of entries.sort()) {
    const same = twins.get(name);
    if (same !== undefined) {
      problems.push(
        problemAt(
          `locale/${name}`,
          WHOLE_FILE,
          `locale/${name} and locale/${same} are the same locale: a language tag's letter case does not make it another`,
          `merge the two into one folder, with the tag written the usual way (language lowercase, region uppercase, as in pt-BR)`,
        ),
      );
      continue;
    }
    if (!LOCALE_TAG.test(name)) {
      problems.push(
        problemAt(
          `locale/${name}`,
          WHOLE_FILE,
          `locale/${name} is not a language tag like "fr" or "pt-BR"`,
          `rename the folder to the locale's language tag (for example locale/fr or locale/pt-BR)`,
        ),
      );
      continue;
    }
    locales.push({ tag: name, dirName: name });
  }
  return locales;
}

// ---------------------------------------------------------------------------------------------
// One file: parse, then validate
// ---------------------------------------------------------------------------------------------

/**
 * The other app files (app.yaml, intents.yaml, ...) whose top level has `key`, for a key a file of
 * `kind` does not know at its top level. Only the six kinds: slots.yaml's top-level keys are slot ids.
 */
function homesOf(kind: Kind, key: string): string[] {
  if (kind === 'slots' || kind === 'localeSlots' || isKbKind(kind)) return [];
  return FILE_KINDS.filter((other) => other !== kind && Object.hasOwn((jsonSchemaOf(other).properties as object | undefined) ?? {}, key)).map((other) => FILE_NAMES[other]);
}

/** JSON Schemas are generated once per kind: the problem messages read keys and descriptions from them. */
const jsonSchemas = new Map<string, JsonSchema>();
function jsonSchemaOf(kind: Kind): JsonSchema {
  let schema = jsonSchemas.get(kind);
  if (!schema) {
    // slots.yaml's published schema is the full union over the types (and a locale's, over their wording); the loader checks the outer shape, whose schema is this.
    schema = kind === 'slots' || kind === 'localeSlots' || isKbKind(kind) ? (z.toJSONSchema(SCHEMAS_OF[kind], { io: 'input', target: 'draft-7' }) as JsonSchema) : jsonSchemaFor(kind);
    jsonSchemas.set(kind, schema);
  }
  return schema;
}

/** Whether parsed content is policy.yaml or identity.yaml in the shape before the actions and levels (the tables as they are). */
function isOldShape(kind: Kind, value: unknown): boolean {
  return (kind === 'policy' && isOldPolicyContent(value)) || (kind === 'identity' && isOldIdentityContent(value));
}

/** The one problem an old-shape file is: what it is, and the command that converts it. */
function oldShape(file: string, kind: Kind): Problem {
  const keys = kind === 'policy' ? 'toolLevel, rulesFor, ...' : 'subjectKind, factorSlots, ...';
  return problemAt(
    file,
    WHOLE_FILE,
    `${file} is in the old shape (${keys}), which is not read any more`,
    `convert it with "dialogwright policy:convert <app folder>" (or "--from-tables <module>" for tables written in TypeScript), which keeps its decisions and its comments, then check the result: it starts with ${STARTS_WITH[kind]}`,
  );
}

/**
 * Parses `text` as YAML and checks it against `kind`'s schema. Returns the valid data (and keeps
 * the parsed content in `contents`, under `file`, for its hash), or undefined after adding to
 * `problems` everything wrong with it.
 */
function checkFile(
  file: string,
  kind: Kind,
  text: string,
  problems: Problem[],
  documents: Map<string, { doc: Document; lines: LineCounter }>,
  contents: Record<string, unknown>,
): unknown {
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
    // Warnings are collected into doc.warnings and reported as problems; none is printed to the console.
    logLevel: 'error',
    lineCounter: lines,
    // No custom tags: `customTags` is empty, so `!!js/function` and the like are unresolved, which is a problem below.
    customTags: [],
  });
  documents.set(file, { doc, lines });
  const before = problems.length;
  const syntax = (code: string, message: string, offset: number | undefined, fix?: string) => {
    const at = lines.linePos(offset ?? 0);
    problems.push({ file, line: at.line, column: at.col, path: WHOLE_FILE, message, fix: fix ?? SYNTAX_FIXES[code] ?? 'correct the YAML at this position (the files are YAML 1.2)' });
  };

  for (const error of doc.errors) {
    // The library's "Map keys must be unique" does not say which; the source at its position does.
    const key = error.code === 'DUPLICATE_KEY' ? (/^[^:\n]*/.exec(text.slice(error.pos[0]))?.[0] ?? '').trim().replace(/^["']|["']$/g, '') : '';
    syntax(error.code, key ? `the key "${key}" appears twice in the same map` : (error.message.split('\n')[0] ?? error.message), error.pos[0]);
  }
  for (const warning of doc.warnings) syntax(warning.code, warning.message.split('\n')[0] ?? warning.message, warning.pos[0]);
  if (doc.directives.yaml.explicit) syntax('BAD_DIRECTIVE', 'a %YAML directive is not allowed: these files are YAML 1.2', 0, 'delete the %YAML line (and the --- under it if nothing else needs it)');
  if (problems.length > before) return undefined;

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const said = /excessive alias count/i.test(message)
      ? `the file's aliases (*name) expand too far: an anchor may be used at most ${MAX_ALIAS_COUNT} times, and fewer when its value holds aliases itself`
      : `the file cannot be read as data (${message})`;
    syntax('ALIAS', said, 0, 'write the values out in full instead of with anchors (&name) and aliases (*name); configuration needs none');
    return undefined;
  }
  // zod drops a "__proto__" key without a word, and the other reserved names shadow an object's own properties.
  const reserved = reservedKeys(doc);
  for (const { path, offset } of reserved) {
    const at = lines.linePos(offset);
    const key = String(path[path.length - 1]);
    problems.push({
      file,
      line: at.line,
      column: at.col,
      path: formatPath(path),
      message: `the key "${key}" is a name JavaScript objects reserve, so it cannot be a key in these files`,
      fix: `rename "${key}" to a name of the app's own`,
    });
  }
  if (value === null || value === undefined) {
    problems.push(problemAt(file, WHOLE_FILE, `${file} is empty`, `add its content; the file starts with ${STARTS_WITH[kind]}`));
    return undefined;
  }

  if (isOldShape(kind, value)) {
    problems.push(oldShape(file, kind));
    return undefined;
  }
  const result = SCHEMAS_OF[kind].safeParse(value);
  if (result.success) {
    if (reserved.length > 0) return undefined;
    // Hashed as parsed, before the schema reads it: the file's own content, whatever the schema makes of it.
    contents[file] = value;
    return result.data;
  }
  problems.push(...problemsOfIssues(result.error.issues, { file, doc, lines, value, schema: jsonSchemaOf(kind), homesOf: (key) => homesOf(kind, key) }));
  return undefined;
}

/**
 * The names that differ from an earlier one only by letter case, each mapped to that earlier one
 * (names in sorted order: "pt-BR" comes before "pt-br"). On a file system that ignores case the two
 * cannot both exist; on one that does not, they would be two folders for one locale.
 */
export function caseTwins(names: readonly string[]): Map<string, string> {
  const first = new Map<string, string>();
  const twins = new Map<string, string>();
  for (const name of [...names].sort()) {
    const same = first.get(name.toLowerCase());
    if (same === undefined) first.set(name.toLowerCase(), name);
    else twins.set(name, same);
  }
  return twins;
}

/** Every key in the document that RESERVED_KEYS names: its data path and where the key starts. */
function reservedKeys(doc: Document): { path: DataPath; offset: number }[] {
  const found: { path: DataPath; offset: number }[] = [];
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const key = String(pair.key.value);
        if (RESERVED_KEYS.has(key)) found.push({ path: [...path, key], offset: pair.key.range?.[0] ?? 0 });
        walk(pair.value, [...path, key]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, [...path, i]));
    }
  };
  walk(doc.contents as Node | null, []);
  return found;
}

function sortProblems(problems: readonly Problem[]): Problem[] {
  const order = [...FOLDER_FILES];
  const rank = (file: string) => {
    const i = order.indexOf(file);
    return i === -1 ? order.length : i;
  };
  return [...problems].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

/** What loadKnowledgeFolder found. */
export interface KnowledgeFolder {
  /** The knowledge base, when the folder has no problems; otherwise null. */
  kb: KnowledgeBase | null;
  /** Everything wrong with reading it, and with its content (../kb/rules.ts kbContentProblems); empty when it is valid. */
  problems: Problem[];
  /** Where a data path is in one of its files (the files named as the problems name them, before `display`). */
  locate(file: string, path: DataPath): { line: number; column: number } | null;
  /** The content hash of each file read, by its path from the folder's parent (kb/kb.yaml, ...), and the combined one. */
  hashes: ConfigHashes;
  /** The folder's name, as its files' paths start ("kb"). */
  base: string;
}

/**
 * Reads a knowledge base folder on its own, for an app that is not a folder (defineKnowledge): the
 * same reading, layout and content rules as an app folder's kb/ (../kb/folder.ts), with the folder's
 * parent as the place nothing may be read from outside of. Problems name files from that parent
 * (kb/passages/x.yaml for the folder src/kb). `defaultLocale` is the app's default locale.
 */
export function loadKnowledgeFolder(dir: string, defaultLocale: string = DEFAULT_LOCALE): KnowledgeFolder {
  const problems: Problem[] = [];
  const documents = new Map<string, { doc: Document; lines: LineCounter }>();
  const contents: Record<string, unknown> = {};
  const base = basename(resolve(dir));
  let root: string;
  try {
    root = realpathSync(dirname(resolve(dir)));
  } catch {
    root = '';
  }
  const io = kbIo(root, problems, documents, contents);
  const none = (): KnowledgeFolder => ({ kb: null, problems, locate: io.locate, hashes: configHashesOf(contents), base });
  if (root === '' || !existsNoFollow(join(root, base))) {
    problems.push(problemAt(base, WHOLE_FILE, `the knowledge base folder "${dir}" does not exist`, 'pass the path of the folder that holds kb.yaml, topics.yaml and passages/'));
    return none();
  }
  const kb = readKbFolder({ base, defaultLocale, io, problems });
  if (kb && problems.length === 0) problems.push(...kbContentProblems(kb, io.locate, base));
  return { kb: problems.length === 0 ? kb : null, problems: sortProblems(problems), locate: io.locate, hashes: configHashesOf(contents), base };
}

/**
 * Reads one knowledge base file's text as the loader reads it (YAML 1.2 with no tags, duplicate keys
 * refused, aliases capped, then its kind's schema): the data, or null with its problems, positioned
 * in `file` (a path as problems name it). For a file the loader does not read itself: a draft in
 * kb/pending, which `pnpm kb:approve` checks before it moves it into kb/passages.
 */
export function parseKbFile(file: string, kind: KbKind, text: string): { data: unknown; problems: Problem[] } {
  const problems: Problem[] = [];
  const data = checkFile(file, kind, text, problems, new Map(), {});
  return { data: problems.length === 0 ? data : null, problems: sortProblems(problems) };
}

/** What loadSlotsFile found: the parsed slots (null when there is a problem) and the document, to position later problems. */
export interface SlotsFile {
  slots: SlotsYaml | null;
  doc: Document;
  lines: LineCounter;
  /** Every problem with reading and parsing the file; empty when it is valid. */
  problems: Problem[];
}

/**
 * Reads one slots.yaml, for an app that is not a folder (defineSlots): the same safe reading and
 * parsing as the folder's file (no tags, no aliases past the cap, a file inside its folder, size
 * bounded), the outer shape checked. `path` is also the file name problems carry.
 */
export function loadSlotsFile(path: string): SlotsFile {
  const problems: Problem[] = [];
  const documents = new Map<string, { doc: Document; lines: LineCounter }>();
  const none = (): SlotsFile => ({ slots: null, doc: new YamlDocument(), lines: new LineCounter(), problems });
  let root: string;
  try {
    root = realpathSync(dirname(resolve(path)));
  } catch {
    problems.push(problemAt(path, WHOLE_FILE, `${path} cannot be read: its folder does not exist`, 'pass the path of the slots.yaml file'));
    return none();
  }
  const read = readFile(root, basename(path));
  if (read.kind === 'missing') {
    problems.push(problemAt(path, WHOLE_FILE, `${path} does not exist`, `create it, or pass the slots as an object; it starts with ${STARTS_WITH.slots}`));
    return none();
  }
  if (read.kind === 'problem') {
    problems.push({ ...read.problem, file: path });
    return none();
  }
  const checked = checkFile(path, 'slots', read.text, problems, documents, {});
  const parsed = documents.get(path)!;
  return { slots: problems.length === 0 ? (checked as SlotsYaml) : null, doc: parsed.doc, lines: parsed.lines, problems };
}

/** What loadConfigFile found: the parsed file (null when there is a problem), the name its problems carry, and the document, to position later problems. */
export interface ConfigFile<T> {
  value: T | null;
  /** The file the problems name: the path given, or `<kind>.yaml` for content given as an object. */
  file: string;
  doc: Document;
  lines: LineCounter;
  /** Whether problems can point at a line: false for content given as an object (its problems have line 0). */
  located: boolean;
  /** Every problem with reading and parsing the file; empty when it is valid. */
  problems: Problem[];
}

/**
 * Reads one policy.yaml or identity.yaml in the new shape, for an app that is not a folder
 * (definePolicy, defineIdentity): from a path, with the same safe reading and parsing as the
 * folder's files and problems at their lines; or from content already parsed, with problems that
 * name paths but no line. A file in the old shape (toolLevel, rulesFor, ...) is refused with one
 * problem that says how to convert it.
 */
export function loadConfigFile(source: string | Record<string, unknown>, kind: 'policy'): ConfigFile<PolicyYaml>;
export function loadConfigFile(source: string | Record<string, unknown>, kind: 'identity'): ConfigFile<IdentityYaml>;
export function loadConfigFile(source: string | Record<string, unknown>, kind: 'policy' | 'identity'): ConfigFile<PolicyYaml | IdentityYaml> {
  const problems: Problem[] = [];
  if (typeof source !== 'string') {
    const file = FILE_NAMES[kind];
    const doc = new YamlDocument(source);
    const lines = new LineCounter();
    if (isOldShape(kind, source)) return { value: null, file, doc, lines, located: false, problems: [{ ...oldShape(file, kind), line: 0, column: 0 }] };
    const parsed = SCHEMAS[kind].safeParse(source);
    if (parsed.success) return { value: parsed.data as PolicyYaml | IdentityYaml, file, doc, lines, located: false, problems };
    const found = problemsOfIssues(parsed.error.issues, { file, doc, lines, value: source, schema: jsonSchemaOf(kind), homesOf: (key) => homesOf(kind, key) });
    return { value: null, file, doc, lines, located: false, problems: found.map((p) => ({ ...p, line: 0, column: 0 })) };
  }
  const file = source;
  const none = (): ConfigFile<PolicyYaml | IdentityYaml> => ({ value: null, file, doc: new YamlDocument(), lines: new LineCounter(), located: true, problems });
  let root: string;
  try {
    root = realpathSync(dirname(resolve(source)));
  } catch {
    problems.push(problemAt(file, WHOLE_FILE, `${file} cannot be read: its folder does not exist`, `pass the path of the ${FILE_NAMES[kind]} file`));
    return none();
  }
  const read = readFile(root, basename(source));
  if (read.kind === 'missing') {
    problems.push(problemAt(file, WHOLE_FILE, `${file} does not exist`, `create it, or pass the content as an object; it starts with ${STARTS_WITH[kind]}`));
    return none();
  }
  if (read.kind === 'problem') {
    problems.push({ ...read.problem, file });
    return none();
  }
  const documents = new Map<string, { doc: Document; lines: LineCounter }>();
  const checked = checkFile(file, kind, read.text, problems, documents, {});
  const parsed = documents.get(file)!;
  const value = problems.length === 0 ? (checked as PolicyYaml | IdentityYaml) : null;
  return { value, file, doc: parsed.doc, lines: parsed.lines, located: true, problems };
}

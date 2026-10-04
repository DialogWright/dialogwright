import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { formatProblem, kbPlaceOf, loadAppFolder, loadKnowledgeFolder, type KbPlace, type KnowledgeBase } from 'dialogwright';
import { Document, parseDocument } from 'yaml';

/**
 * Where a knowledge base is and what it holds, for the commands that work on one already made
 * (kb:draft, kb:review, kb:refresh): an app folder with kb/kb.yaml, or a kb folder itself, found
 * and read as dialogwright's kb:approve finds and reads it, so every command sees the same thing.
 */

export type { KbPlace };

/** The knowledge base at `dir` (an app folder with kb/kb.yaml, or a kb folder), or why there is none. */
export function findKb(dir: string, label: string): KbPlace | string {
  return kbPlaceOf(dir, label);
}

/** A knowledge base read: the knowledge base, or the problems that kept it from loading. */
export interface LoadedKb {
  kb: KnowledgeBase | null;
  problems: string[];
}

/** Reads the knowledge base as kb:approve does: through its app folder (its default locale), or on its own. */
export function loadKb(place: KbPlace): LoadedKb {
  if (place.appDir !== null) {
    const loaded = loadAppFolder(place.appDir);
    return { kb: loaded.config?.knowledge ?? null, problems: loaded.config ? [] : loaded.problems.map(formatProblem) };
  }
  const folder = loadKnowledgeFolder(place.kbDir);
  return { kb: folder.kb, problems: folder.problems.map(formatProblem) };
}

/** The .yaml files of a folder of the knowledge base, by id (the file name without .yaml), sorted; none when it is not there. */
export function yamlIds(dir: string, skip: readonly string[] = []): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.yaml') && !n.startsWith('.') && !skip.includes(n))
      .map((n) => n.slice(0, -'.yaml'.length))
      .sort();
  } catch {
    return [];
  }
}

/** The editor schema comment's path from `dir` to dialogwright's `<name>.schema.json`, when it can be found above it. */
export function schemaPathFrom(dir: string, name: string): string | undefined {
  for (let at = dirname(dir); ; at = dirname(at)) {
    for (const candidate of [join(at, 'packages', 'dialogwright', 'schemas', `${name}.schema.json`), join(at, 'node_modules', 'dialogwright', 'schemas', `${name}.schema.json`)]) {
      if (existsSync(candidate)) return relative(dir, candidate).split(sep).join('/');
    }
    if (dirname(at) === at) return undefined;
  }
}

/** A YAML file's text for `value`, with the editor schema comment when the schema can be found from `dir`. */
export function yamlFile(value: unknown, dir: string, schema: string): string {
  const doc = new Document(value);
  const path = schemaPathFrom(dir, schema);
  if (path !== undefined) doc.commentBefore = ` yaml-language-server: $schema=${path}`;
  return doc.toString({ lineWidth: 0 });
}

/** A YAML file read for editing (its comments and layout kept), or null when it is not there. */
export function readForEdit(path: string): Document | null {
  if (!existsSync(path)) return null;
  return parseDocument(readFileSync(path, 'utf8'), { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: false });
}

/** Today, as an ISO date (UTC). */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

import { createHash } from 'node:crypto';
import type { ConfigHashes } from './types';

/**
 * The content hashes of an app's configuration (App.configHashes). A file's hash is taken over its
 * parsed content, not its bytes: the value as JSON with object keys in document order at every level,
 * arrays in order and no whitespace (orderedJson below), so a comment, a blank line, flow or block
 * style or another quoting style leaves it as it was, and a changed value, or the same keys in
 * another order, changes it. Order is content: slots.yaml's key order is the app's slot order, which
 * decides fill order and which slot's acknowledgement is spoken. (The cassette's key, jev/cassette.ts
 * canonicalJson, sorts keys; that is a different job and is not used here.) The
 * combined hash is taken over the files' `<file>:<hash>` lines, sorted by file, so it changes when
 * any file changes, or when one is added or removed.
 */

/** A SHA-256 hex digest of `text` (UTF-8). */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What every hash is: a SHA-256, 64 lowercase hex characters. */
export const CONFIG_HASH = /^[0-9a-f]{64}$/;

/**
 * JSON with object keys in the order the parsed document has them (a YAML map's keys, in the order
 * written), arrays in order, no whitespace. Keys whose value is undefined are dropped; any other
 * value JSON.stringify cannot represent becomes null. A JavaScript object lists integer-like keys
 * ("1", "20") first, in ascending order, whatever order they were written in; nothing in an app's
 * configuration depends on that, and the parsed value is all this can see.
 */
export function orderedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${Array.from(value, orderedJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  const parts = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${orderedJson(o[k])}`);
  return `{${parts.join(',')}}`;
}

/** The hash of one file's parsed content: SHA-256 of its orderedJson. */
export function contentHash(value: unknown): string {
  return sha256(orderedJson(value));
}

/** The files' `<file>:<hash>` lines, sorted by file: what the combined hash is taken over, and what call_started records. */
export function configHashLines(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files).sort().map((file) => `${file}:${files[file]}`);
}

/** The combined hash of the files' hashes. */
export function combinedConfigHash(files: Readonly<Record<string, string>>): string {
  return sha256(configHashLines(files).join('\n'));
}

/** The hashes of parsed files, by their paths in the app folder: each file's, sorted by path, and the combined one. */
export function configHashesOf(contents: Readonly<Record<string, unknown>>): ConfigHashes {
  const files = Object.fromEntries(Object.keys(contents).sort().map((file) => [file, contentHash(contents[file])]));
  return { app: combinedConfigHash(files), files };
}

/**
 * What the call_started audit row adds for an app with hashes: the combined hash, and every file's
 * line, so the row alone shows which configuration was in force and the combined hash can be
 * recomputed from it. Nothing for an app without hashes, whose row is as it was.
 */
export function configAuditDetail(hashes: ConfigHashes | undefined): { config: string; configFiles: string[] } | Record<string, never> {
  return hashes ? { config: hashes.app, configFiles: configHashLines(hashes.files) } : {};
}

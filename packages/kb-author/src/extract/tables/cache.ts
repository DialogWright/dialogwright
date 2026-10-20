import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelTable } from './model';

/**
 * The grids a model proposed for a knowledge base's PDF pages (./model.ts), kept beside it in
 * `kb/.tables/grids.json`, by the hash of each page's layout (the text the model was given): a re-import
 * or a refresh with no key, on any machine, reads the same tables, and a model is asked again only for a
 * page whose text or placing changed. Commit it with the sources. Each entry names the model that gave it.
 */

export const TABLES_DIR = '.tables';
export const TABLES_FILE = 'grids.json';

interface Entry {
  readonly model: string;
  readonly tables: readonly ModelTable[];
}

/** A page layout's key: the SHA-256 of its text, the first 16 hex characters. */
export const layoutKey = (layout: string): string => createHash('sha256').update(layout).digest('hex').slice(0, 16);

export class TablesCache {
  private readonly entries = new Map<string, Entry>();
  private changed = false;

  /** The cache of a knowledge base folder (empty where it has none, or one that does not read). */
  static load(kbDir: string): TablesCache {
    const cache = new TablesCache();
    const path = join(kbDir, TABLES_DIR, TABLES_FILE);
    if (!existsSync(path)) return cache;
    try {
      const json = JSON.parse(readFileSync(path, 'utf8')) as { pages?: Record<string, Entry> };
      for (const [key, entry] of Object.entries(json.pages ?? {})) {
        if (typeof entry?.model === 'string' && Array.isArray(entry.tables)) cache.entries.set(key, entry);
      }
    } catch {
      // A cache that does not read is no cache: its pages are asked again, or read without a model.
    }
    return cache;
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  set(key: string, model: string, tables: readonly ModelTable[]): void {
    this.entries.set(key, { model, tables });
    this.changed = true;
  }

  get dirty(): boolean {
    return this.changed;
  }

  /** Written where anything was added, its pages in key order (the same entries give the same bytes). */
  save(kbDir: string): void {
    if (!this.changed) return;
    const dir = join(kbDir, TABLES_DIR);
    mkdirSync(dir, { recursive: true });
    const pages = Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(join(dir, TABLES_FILE), `${JSON.stringify({ version: 1, pages }, null, 1)}\n`);
    this.changed = false;
  }
}

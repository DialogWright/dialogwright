import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { App } from '../core/app/types';
import { isPauseOnly, segmentsOf, stripLeadingPause, ttsOnly } from './segments';

/** wav/mp3 file extension → content type. discovery lowercases a discovered filename's extension before looking this up, so keys stay lowercase here even though discovery itself is case-insensitive. */
export const AUDIO_TYPES: Readonly<Record<string, string>> = { wav: 'audio/wav', mp3: 'audio/mpeg' };
/** Filename shape a recorded clip must match: id, dot, extension (wav/mp3, case-insensitive). Shared with src/server/http.ts, which serves clips under this same shape. */
export const CLIP_FILE = new RegExp(`^([A-Za-z0-9_.-]+)\\.(${Object.keys(AUDIO_TYPES).join('|')})$`, 'i');

/** clip id → filename, from the directory listing; a missing directory is an empty index. */
export function discoverClips(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return out;
    throw err;
  }
  const names = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name).sort();
  for (const name of names) {
    const m = CLIP_FILE.exec(name);
    if (!m) continue;
    const id = m[1]!;
    const prev = out.get(id);
    if (prev) throw new Error(`clip ${id} is recorded twice: ${prev} and ${name}`);
    out.set(id, name);
  }
  return out;
}

/**
 * clip id → filename with a `?v=<hash>` suffix, the first 10 hex characters of the sha1 of the
 * file's bytes. Twilio's media fetcher caches a clip URL for a day (`cache-control: public,
 * max-age=86400`); when a clip is regenerated under the same filename, the old URL would still
 * serve the stale cached recording for up to a day. Content-hashing the URL means a changed
 * file is a new URL, so the cache is never stale.
 */
export function clipVersions(dir: string, clips: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, filename] of clips) {
    const hash = createHash('sha1').update(readFileSync(join(dir, filename))).digest('hex').slice(0, 10);
    out.set(id, `${filename}?v=${hash}`);
  }
  return out;
}

/**
 * The clip id for a vocabulary variable's display value, or null when it is spoken by TTS: the
 * app's vocabulary entry (App.prompts.vocabulary) whose text is the display and whose vars name
 * the variable. A name no entry lists (a caller's first name, a date) is always TTS.
 */
export function vocabularyClipId(app: App, name: string, display: string): string | null {
  return app.prompts.vocabulary?.find((v) => v.text === display && v.vars.includes(name))?.id ?? null;
}

export interface RecordableClip { id: string; text: string; note: 'open' | 'closed' }

/**
 * Every clip the app's manifest and vocabulary can use, each once, with the text to record. A line
 * that carries data (ttsOnly) is spoken whole by TTS and contributes none.
 *
 * A fixed segment that is only punctuation (e.g. the "." left over from "Thanks, {first}.")
 * has nothing left to say once its leading punctuation is stripped; segmentsOf still keeps
 * that segment (the renderer needs it to merge text back together), but it is not a
 * recordable row here.
 */
export function recordableClips(app: App): RecordableClip[] {
  const rows: RecordableClip[] = [];
  for (const segments of Object.values(segmentsOf(app.prompts.manifest))) {
    // A line that carries data is spoken whole by TTS, so none of it is recorded.
    if (ttsOnly(app, segments)) continue;
    segments.forEach((s, i) => {
      if (s.kind !== 'fixed' || isPauseOnly(s.text)) return;
      const next = segments[i + 1];
      rows.push({ id: s.id, text: stripLeadingPause(s.text), note: next?.kind === 'var' ? 'open' : 'closed' });
    });
  }
  for (const v of app.prompts.vocabulary ?? []) rows.push({ id: v.id, text: v.text, note: 'closed' });
  return rows;
}

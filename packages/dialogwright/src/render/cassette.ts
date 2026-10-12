import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cassetteFileName } from '../jev/provider';
import { RenderClientError, type Generation, type RenderClient, type RenderRequest } from './types';

/**
 * Generated lines recorded and replayed, as the decision model's answers are (jev/cassette.ts): one
 * file per model, keyed by the act and its line (render/prompt.ts renderKey), so a regression replays
 * exactly the words a model gave for the same line asked the same way, and re-runs every check on
 * them. Recording is the maintainer's step (`regress --client record`, with the author's own key);
 * no test and no CI run records.
 */

export interface RenderCassetteLine {
  v: 1;
  key: string;
  /** The prompt id the line is, so a person can grep the file. */
  promptId: string;
  model: string;
  /** The words the model gave, as given (before any check). */
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  recordedAt: string;
}

/** Later lines for the same key win. A missing file is an empty cassette. */
export function loadRenderCassette(path: string): Map<string, RenderCassetteLine> {
  const out = new Map<string, RenderCassetteLine>();
  if (!existsSync(path)) return out;
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let l: Partial<RenderCassetteLine> | null;
    try {
      l = JSON.parse(raw) as Partial<RenderCassetteLine> | null;
    } catch {
      throw new Error(`render cassette ${path} line ${i + 1}: not JSON; the file is append-only, delete this line and record again`);
    }
    if (!l || l.v !== 1 || typeof l.key !== 'string' || typeof l.text !== 'string' || typeof l.model !== 'string' || typeof l.usage?.inputTokens !== 'number' || typeof l.usage.outputTokens !== 'number') {
      throw new Error(`render cassette ${path} line ${i + 1}: expected v:1 with key, model, text and usage; the file is append-only, delete this line and record again`);
    }
    out.set(l.key, l as RenderCassetteLine);
  });
  return out;
}

/** Where a model's generated lines are recorded, beside the decision model's cassettes: `<recorded>/render/<model>.jsonl`. */
export function renderCassettePath(recordedDir: string, model: string): string {
  return join(recordedDir, 'render', cassetteFileName(model));
}

/**
 * Replays recorded generations; in record mode a line it has not got goes to the inner client (a
 * model) and is appended. A replay's miss rejects with `cassette-miss`, so the line is said fixed and
 * the run counts it, rather than a different wording passing silently.
 */
export class RenderCassette implements RenderClient {
  private lines: Map<string, RenderCassetteLine> | null = null;

  constructor(private readonly opts: { path: string; mode: 'replay' | 'record'; model: string; inner?: RenderClient; now?: () => number }) {
    if (opts.mode === 'record' && !opts.inner) throw new Error('RenderCassette: record mode needs an inner client');
  }

  get model(): string {
    return this.opts.model;
  }

  get path(): string {
    return this.opts.path;
  }

  private load(): Map<string, RenderCassetteLine> {
    this.lines ??= loadRenderCassette(this.opts.path);
    return this.lines;
  }

  /** Load now, so a corrupt file fails before the run does. */
  preload(): void {
    this.load();
  }

  async generate(req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    const hit = this.load().get(req.key);
    if (hit) return { text: hit.text, model: hit.model, usage: { ...hit.usage }, latencyMs: 0, source: 'recorded' };
    if (this.opts.mode === 'replay') throw new RenderClientError(`render cassette miss: ${req.key} ${req.promptId} (${this.opts.path})`, 'cassette-miss');
    const g = await this.opts.inner!.generate(req, signal);
    const line: RenderCassetteLine = { v: 1, key: req.key, promptId: req.promptId, model: g.model, text: g.text, usage: { ...g.usage }, recordedAt: new Date((this.opts.now ?? Date.now)()).toISOString() };
    mkdirSync(dirname(this.opts.path), { recursive: true });
    appendFileSync(this.opts.path, `${JSON.stringify(line)}\n`);
    this.load().set(req.key, line);
    return g;
  }
}

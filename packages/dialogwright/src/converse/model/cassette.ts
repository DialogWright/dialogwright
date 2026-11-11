import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConverseModel, ModelEvent, ModelRequest } from './types';

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The key of a request: the sha256 of its canonical body (no key of any API is part of a request). */
export const requestKey = (req: ModelRequest): string => createHash('sha256').update(canonical(req)).digest('hex');

interface Entry {
  key: string;
  attempt: number;
  /** The id of the model that answered, kept so a replay prices the run. */
  model?: string;
  events: ModelEvent[];
}

/**
 * Records a model's answers to a file (one JSON line each) and replays them: by the request's key and the
 * attempt for that key (the same request asked twice replays the first answer, then the second). With
 * `inner` a missing answer is asked and recorded; without it a miss is an `error` event.
 */
export function cassetteModel(o: { path: string; inner: ConverseModel | null; id?: string }): ConverseModel {
  const attempts = new Map<string, number>();
  const read = (): Entry[] => (existsSync(o.path) ? readFileSync(o.path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Entry) : []);
  return {
    // The recording model's id: the inner's, else the option's, else the one the file was recorded with.
    get id(): string {
      return o.inner?.id ?? o.id ?? read().find((e) => e.model !== undefined)?.model ?? 'cassette';
    },
    async *stream(req, signal): AsyncIterable<ModelEvent> {
      const key = requestKey(req);
      const attempt = attempts.get(key) ?? 0;
      attempts.set(key, attempt + 1);
      const found = read().find((e) => e.key === key && e.attempt === attempt);
      if (found) {
        yield* found.events;
        return;
      }
      if (o.inner === null) {
        yield { type: 'error', kind: 'http', detail: 'cassette miss' };
        return;
      }
      const events: ModelEvent[] = [];
      for await (const e of o.inner.stream(req, signal)) {
        events.push(e);
        yield e;
      }
      // A transient failure (a timeout, an HTTP failure, the provider's rate limit) is not an answer: it is not kept, so it never replays.
      const last = events.at(-1);
      if (last?.type === 'error' && (last.kind === 'timeout' || last.kind === 'http' || last.kind === 'rate_limited')) {
        attempts.set(key, attempt);
        return;
      }
      mkdirSync(dirname(o.path), { recursive: true });
      appendFileSync(o.path, `${JSON.stringify({ key, attempt, model: o.inner.id, events } satisfies Entry)}\n`);
    },
  };
}

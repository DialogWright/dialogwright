import { performance } from 'node:perf_hooks';
import type { AppKnowledge, NominateInput, Nomination, NominationVia } from '../kb/types';
import type { RetrievalRecord } from '../trace/types';

/**
 * How long a turn waits for the app's retriever, in milliseconds. Retrieval sits before the model is
 * asked, so the caller waits on it; one that is not back in time nominates nothing (the turn asks no
 * knowledge question) and the call goes on. Fixed, not a threshold: it is a latency budget, not a
 * judgment, and a retriever that runs near it would nominate differently from one run to the next,
 * which a cassette replay could not match.
 */
export const RETRIEVE_BUDGET_MS = 150;

/** What the retrieval step gives the turn: the nominations, and, when a retriever ran, its trace record and how long it took. */
export interface Retrieved {
  readonly nominated: readonly Nomination[];
  /** The trace's record of the run (TraceRecord.retrieval); null when the app has no retriever, so nothing ran. */
  readonly record: RetrievalRecord | null;
  /** How long the retriever took (TraceTiming.retrieveMs); null when nothing ran. */
  readonly ms: number | null;
}

const VIA: ReadonlySet<NominationVia> = new Set(['keyword', 'dense', 'app']);

/** `value` as nominations, each copied to exactly its four fields; null when it is not a list of them. */
function nominationsOf(value: unknown): Nomination[] | null {
  if (!Array.isArray(value)) return null;
  const out: Nomination[] = [];
  for (const n of value as unknown[]) {
    if (typeof n !== 'object' || n === null) return null;
    const { topic, title, score, via } = n as Record<string, unknown>;
    if (typeof topic !== 'string' || typeof title !== 'string' || typeof score !== 'number' || !Number.isFinite(score) || typeof via !== 'string' || !VIA.has(via as NominationVia)) return null;
    out.push({ topic, title, score, via: via as NominationVia });
  }
  return out;
}

const LATE = Symbol('late');

/**
 * Runs the app's retriever once for a turn's words, within `budgetMs`. It fails open: a retriever
 * that throws, rejects, returns something other than a list of nominations, or is not back within
 * the budget nominates nothing, and the record says which. An app with a knowledge base but no
 * retriever nominates nothing, and nothing is recorded (nothing ran).
 *
 * The budget bounds a retriever that returns a promise. One that answers synchronously runs to its
 * end before the timer can fire (JavaScript cannot interrupt it), so its answer is taken however
 * long it took: a retriever that may be slow must be asynchronous. The engine's own answer
 * synchronously in well under a millisecond.
 */
export async function retrieve(knowledge: AppKnowledge, input: NominateInput, budgetMs: number = RETRIEVE_BUDGET_MS): Promise<Retrieved> {
  const retriever = knowledge.retriever;
  if (retriever === undefined) return { nominated: [], record: null, ms: null };
  const base = { retrieverId: retriever.id, ...(retriever.indexHash !== undefined ? { indexHash: retriever.indexHash } : {}) };
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: { value: unknown } | { error: unknown } | typeof LATE;
  try {
    // Settled as it is made, so a retriever left behind as late never surfaces as an unhandled rejection.
    const settled = Promise.resolve()
      .then(() => retriever.nominate(input))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    const late = new Promise<typeof LATE>((resolve) => {
      timer = setTimeout(() => resolve(LATE), budgetMs);
    });
    outcome = await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
  const ms = performance.now() - t0;
  if (outcome === LATE) return { nominated: [], record: { ...base, nominated: [], failed: 'late' }, ms };
  if ('error' in outcome) {
    const e = outcome.error;
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { nominated: [], record: { ...base, nominated: [], failed: 'error', message }, ms };
  }
  const nominated = nominationsOf(outcome.value);
  if (nominated === null) return { nominated: [], record: { ...base, nominated: [], failed: 'invalid' }, ms };
  return { nominated, record: { ...base, nominated: nominated.map(({ topic, score, via }) => ({ topic, score, via })) }, ms };
}

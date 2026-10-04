import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS, DEFAULT_THRESHOLDS, defineApp, HeuristicStubClient, mockCodeVerifier, newSession, registerApp, VOICE_RELAY, type App, type Nomination, type Retriever } from 'dialogwright';
import { BASE, codeFor, folder, KbLibrarySystems, TODAY } from 'dialogwright/kb/__fixtures__/libraryKbApp';
import { speechEvent, startEvent } from 'dialogwright/channel/events';
import { runTurn, type RunOptions } from 'dialogwright/run/turn';
import { choice, noul } from 'dialogwright/testing/answers';
import { TraceWriter } from 'dialogwright/trace/writer';
import type { AnswerMap, JevClient } from 'dialogwright/jev/types';

/**
 * Calls for kb:gaps's tests: scripted calls to a scratch copy of Example Town Library's knowledge
 * base app (dialogwright's own fixture), run through runTurn with a scripted model client, each call's
 * turns written by the engine's own trace writer, so the trace records are the ones a real server
 * writes: the retrieval record, the topic question and the model's answer, the knowledge record, the
 * gate events and the masked slots. The retriever nominates what each step's words are listed for;
 * the model answers as each step says (the intent and the topic question), and as the heuristics do
 * for everything else.
 */

/** One turn of a scripted call: the words, what retrieval nominates for them, and the model's answers. */
export interface Step {
  say: string;
  nominates?: readonly string[];
  /** The model's intent (a label of the app's intents); default `none`. */
  intent?: string;
  /** The model's answer to the topic question: probabilities by label. */
  topic?: Record<string, number>;
  /** Other answers, as the corpus writes them. */
  answers?: AnswerMap;
  /** The retriever throws on these words (a failed retrieval). */
  explode?: boolean;
}

/** One scripted call. */
export interface CallScript {
  id: string;
  /** The day the call starts (ISO); each turn is a minute after the last. */
  day: string;
  /** The day the knowledge answers for (todayIso). Default: the fixture's. */
  today?: string;
  locale?: string;
  /** The library's records have no card kind for the caller (no facts). */
  noCard?: boolean;
  steps: readonly Step[];
}

/** A scratch copy of the library app folder with a source changed (late fees section) and uncited sections added. */
export function scratchApp(id: string, opts: { stale?: boolean } = {}): string {
  const dir = folder(id);
  const source = join(dir, 'kb', 'sources', 'patron-guide.yaml');
  let text = readFileSync(source, 'utf8');
  if (opts.stale) text = text.replace('for each day an item is overdue, up to 5', 'for every day an item is overdue, up to 5');
  text += `  "4.1":
    heading: Meeting rooms
    text: A meeting room may be booked for up to three hours at a time by any card holder. Rooms seat eight people.
  "4.2":
    heading: Printing and copying
    text: Printing and copying cost ten cents a page. Payment is at the self-service kiosk by the front desk.
`;
  writeFileSync(source, text);
  return dir;
}

/** A retriever that nominates the topics listed for each words, and throws on words an `explode` step says. */
function retrieverFor(steps: readonly Step[]): Retriever {
  const by = new Map(steps.map((s) => [s.say, s]));
  return {
    id: 'scripted',
    nominate({ text }): readonly Nomination[] {
      const step = by.get(text);
      if (step?.explode) throw new Error('the index is not there');
      return (step?.nominates ?? []).map((topic, i) => ({ topic, title: topic, score: 1 - i / 10, via: 'app' as const }));
    },
  };
}

/** The app of `dir`, its knowledge base's retriever scripted by every call's steps. */
export function appOf(dir: string, scripts: readonly CallScript[]): App {
  const code = codeFor(dir);
  const app = defineApp(dir, { ...code, knowledge: { retriever: retrieverFor(scripts.flatMap((c) => c.steps)) } });
  registerApp(app);
  return app;
}

/** Runs the calls against `app`, writing `<id>.jsonl` into `traces` for each, and returns the trace files' paths. */
export async function runCalls(app: App, scripts: readonly CallScript[], traces: string): Promise<string[]> {
  const heuristic = new HeuristicStubClient({ app, todayIso: TODAY });
  const files: string[] = [];
  for (const script of scripts) {
    const file = join(traces, `${script.id}.jsonl`);
    files.push(file);
    let given: AnswerMap = {};
    const client: JevClient = {
      async ask(req) {
        const r = await heuristic.ask(req);
        const all: AnswerMap = { ...BASE, ...given };
        return { ...r, answers: { ...r.answers, ...Object.fromEntries(Object.keys(req.questions).filter((k) => Object.hasOwn(all, k)).map((k) => [k, all[k]!])) } };
      },
    };
    const systems = app.systems();
    if (script.noCard) (systems.sys as KbLibrarySystems).cardKind = null;
    let clock = Date.parse(`${script.day}T09:00:00Z`);
    const opts: RunOptions = {
      client,
      thresholds: { ...DEFAULT_THRESHOLDS },
      todayIso: script.today ?? TODAY,
      now: () => clock,
      tools: { ...systems, codes: mockCodeVerifier },
      trace: new TraceWriter(file),
    };
    let session = newSession(script.id, clock, VOICE_RELAY, ANONYMOUS, app.id);
    session = (await runTurn(session, startEvent({}, script.locale), opts)).result.session;
    for (const step of script.steps) {
      clock += 60_000;
      given = {
        intent: choice({ [step.intent ?? 'none']: 0.95, none: 0.05 }),
        ...(step.topic ? { libraryTopicTopic: choice(step.topic) } : {}),
        ...(step.answers ?? {}),
      };
      session = (await runTurn(session, speechEvent(step.say, true), opts)).result.session;
    }
  }
  return files;
}

/** A card number said whole, as the library's card slot reads it (the answers that fill it). */
export const SAYS_CARD: AnswerMap = {
  cardGiven: noul(0.95),
  cardSpan: choice({ 'five five five two zero four one seven': 0.9, none: 0.1 }),
  cardComplete: noul(0.9),
};

const scratch: string[] = [];

/** A scratch folder for traces and reports (deleted by `cleanGaps`). */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-kb-gaps-'));
  scratch.push(dir);
  return dir;
}

export function cleanGaps(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Appends a line that is not a trace record to a trace file. */
export function appendJunk(file: string, line: string): void {
  appendFileSync(file, `${line}\n`);
}

export { cpSync };

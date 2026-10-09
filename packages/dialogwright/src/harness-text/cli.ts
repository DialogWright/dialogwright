import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { keyEvents, silenceEvent, startEvent, withCalledNumber, withCallerNumber, type SessionEvent } from '../channel/events';
import { usesCalledNumber, usesCallerNumber } from '../core/callerNumber';
import { appOf } from '../core/app/registry';
import { demoTools } from '../core/tools';
import { newSession, type Session } from '../core/session';
import { loadCorpus } from '../jev/corpus';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { followEffects, loadScenarios, runCorpusEntry, runScenario, runTurn, saidEvent, type RunOptions, type TurnRun } from './runner';
import { replayFrameLog } from './replay';
import { summarize } from './metrics';
import { formatAnswers, formatDecision, formatGates, formatMetrics, formatSlots } from './print';
export { buildThresholds, buildClient, defaultCorpusFile } from '../run/client';
import { buildThresholds, buildClient, defaultCorpusFile, isClientKind, modelHeader, providerFor } from '../run/client';
import { defaultTimeZone, localDateIso } from '../run/clock';
import { VOICE_RELAY } from '../channel/caps';
import { parseScreenMode } from '../core/screen';
import { loadHarnessEnv } from '../server/envFile';
import { REAL_MODEL_KINDS } from './regressDiff';

/** Parsed inside main() so a bad flag reports through the same clean error path as a bad run. */
function parseCliArgs() {
  return parseArgs({
    options: {
      corpus: { type: 'string' },
      scenarios: { type: 'string' },
      replay: { type: 'string' },
      client: { type: 'string', default: 'stub' },
      trace: { type: 'string' },
      threshold: { type: 'string', multiple: true, default: [] },
      today: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      'corpus-file': { type: 'string' },
      // Where the injection screen is asked: inline (default) or separate (core/screen.ts ScreenMode).
      screen: { type: 'string' },
      // The number the REPL's call comes from (SessionStart.callerNumber), for an app with a slot that offers it or that keeps it.
      'caller-number': { type: 'string' },
      // The number the REPL's call is to (SessionStart.calledNumber), for an app that keeps it (app.yaml callerNumber.called).
      'called-number': { type: 'string' },
    },
  }).values;
}

/** The fixture stub reads --corpus-file; running a corpus defaults it to that same file. */
export function corpusFileOf(corpusFile: string | undefined, corpus: string | undefined): string {
  return corpusFile ?? corpus ?? defaultCorpusFile();
}

/**
 * --today is unset (not merely defaulted by parseArgs) only when the caller never passed it.
 * The fallback is the host's wall-clock date, not the UTC one: an evening run west of Greenwich
 * would otherwise resolve "tomorrow" a day early.
 */
export function resolveTodayIso(today: string | undefined): string {
  return today ?? localDateIso(Date.now(), defaultTimeZone());
}

function printRun(run: TurnRun, quiet: boolean): void {
  if (quiet) return;
  const { result, questions, response } = run;
  if (questions && response) {
    console.log(formatAnswers(questions, response.answers));
    console.log('');
  }
  if (result.rows.length) {
    console.log(formatGates(result.rows));
    console.log('');
  }
  const slots = formatSlots(result.session.slots);
  if (slots) {
    console.log(slots);
    console.log('');
  }
  if (run.error) console.log(`client error: ${run.error.name}: ${run.error.message}`);
  console.log(formatDecision(result.decision, result.actions));
  console.log(`timing ms  ask ${run.record.timing.askMs.toFixed(1)}  total ${run.record.timing.totalMs.toFixed(1)}   source ${run.record.source}`);
  console.log('');
}

async function repl(opts: RunOptions, quiet: boolean, callerNumber?: string, calledNumber?: string): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  // One book of business for the whole session, so a record created on one call is there on the next.
  const o: RunOptions = { ...opts, tools: opts.tools ?? demoTools() };
  let session: Session = newSession(`repl-${Date.now()}`, Date.now(), VOICE_RELAY);
  /** A turn, then the side effects it left (a downstream service's answer after a filed report), each printed. */
  const turn = async (event: SessionEvent, show: (run: TurnRun) => boolean = () => true) => {
    const run = await runTurn(session, event, o);
    const all = [run, ...(await followEffects(run, o))];
    for (const r of all) {
      session = r.result.session;
      records.push(r.record);
      if (show(r)) printRun(r, quiet);
    }
  };
  // The call's number, for an app with a slot that offers it or that keeps it (--caller-number), and the
  // number called, for an app that keeps it (--called-number); every other app's start is as it was.
  const start = () => turn(withCalledNumber(withCallerNumber(startEvent(), usesCallerNumber(appOf(session)) ? callerNumber : undefined), usesCalledNumber(appOf(session)) ? calledNumber : undefined));
  await start();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'caller> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/reset') {
      session = newSession(`repl-${Date.now()}`, Date.now(), VOICE_RELAY);
      await start();
    } else if (text.startsWith('dtmf:')) {
      for (const event of keyEvents(text.slice(5))) await turn(event, (r) => r.result.decision.kind !== 'ignore');
    } else if (text === '/silence' || text === '') {
      // An empty line stands in for the caller saying nothing, same as /silence.
      if (!session.ended) await turn(silenceEvent());
    } else if (text) {
      if (!session.ended) await turn(saidEvent(session, text));
    }
    if (session.ended) console.log('(call ended; /reset to start another)');
    rl.prompt();
  }
  return records;
}

async function run(): Promise<void> {
  const args = parseCliArgs();
  // Against a model or its cassette, the app's settings as `pnpm start` reads them (regress.ts).
  if (REAL_MODEL_KINDS.has(args.client!)) {
    const loaded = loadHarnessEnv();
    if (loaded !== null) console.error(loaded);
  }
  const thresholds = buildThresholds(args.threshold ?? []);
  const todayIso = resolveTodayIso(args.today);
  // Resolved once, so the header names the model the client asks; buildClient refuses an unknown kind.
  const kind = args.client!;
  const provider = isClientKind(kind) ? providerFor(kind) : null;
  if (isClientKind(kind)) for (const line of modelHeader(kind, provider)) console.log(line);
  const client = buildClient(kind, corpusFileOf(args['corpus-file'], args.corpus), thresholds, todayIso, provider ?? undefined);
  const trace = args.trace ? new TraceWriter(args.trace) : null;
  const opts: RunOptions = { client, thresholds, todayIso, trace, screen: parseScreenMode(args.screen, '--screen') };
  const records: TraceRecord[] = [];

  if (args.corpus) {
    for (const entry of loadCorpus(args.corpus)) {
      const { run, setup, outcome } = await runCorpusEntry(entry, opts);
      records.push(setup.record, run.record);
      if (!args.quiet) {
        console.log(`=== ${entry.id}  "${entry.text}"  [${entry.context}]`);
        printRun(run, false);
      } else {
        console.log(`${entry.id.padEnd(16)} ${outcome.decision.padEnd(9)} ${outcome.promptId ?? outcome.reason ?? ''}`);
      }
    }
  }

  if (args.scenarios) {
    let failed = 0;
    for (const scenario of loadScenarios(args.scenarios)) {
      const r = await runScenario(scenario, opts);
      for (const run of r.runs) records.push(run.record);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${scenario.id}`);
      for (const m of r.mismatches) console.log(`      ${m}`);
      if (!r.pass) failed += 1;
      if (!args.quiet && !r.pass) for (const run of r.runs) printRun(run, false);
    }
    if (failed) process.exitCode = 1;
  }

  if (args.replay) {
    // A replay defaults to the call's own date; --today only overrides it when the flag was
    // actually passed (in either `--today VALUE` or `--today=VALUE` form).
    const replayOptions = args.today !== undefined ? { todayIsoOverride: args.today } : undefined;
    const r = await replayFrameLog(args.replay, opts, (run) => printRun(run, args.quiet!), replayOptions);
    records.push(...r.records);
    for (const s of r.skipped) console.log(`skipped ${s}`);
  }

  if (!args.corpus && !args.scenarios && !args.replay) {
    records.push(...(await repl(opts, args.quiet!, args['caller-number'], args['called-number'])));
  }

  if (records.length) {
    console.log('');
    console.log(formatMetrics(summarize(records)));
  }
}

/**
 * The process entry point, run by an app's launcher after it has registered the app. This module
 * does not run itself, so tests can import the builders without starting a REPL.
 */
export async function main(): Promise<void> {
  await run().catch((e) => {
    if (e instanceof Error) console.error(`error: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
}

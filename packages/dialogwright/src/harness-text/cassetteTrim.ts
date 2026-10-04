import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { isCassetteMiss, loadCassette, requestKey, trimCassette } from '../jev/cassette';
import type { JevClient } from '../jev/types';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { recordedCassette } from '../run/client';
import { defaultCorpusFile, scenariosDir } from '../run/fixtures';
import { REGRESS_TODAY } from './baseline';
import { loadScenarios } from './runner';
import { runAll } from './runAll';
import { parseScreenMode } from '../core/screen';

/**
 * The cassette trim: replay the whole regression run from the cassette, note every request it
 * makes, and rewrite the file with only those answers. Nothing is written unless the replay was
 * complete: a miss means the cassette is behind the questions, and trimming it then would throw
 * away answers a re-record is about to need. Spends nothing; the model is never called.
 */
async function run(): Promise<void> {
  // The screen mode the cassette was recorded in (`--screen inline|separate`, default inline): the
  // replay must make the same requests, or every turn misses and nothing is written.
  const { values: args } = parseArgs({ options: { screen: { type: 'string' } } });
  const screen = parseScreenMode(args.screen, '--screen');
  // The resolved model's cassette (jev/provider.ts), as `--client recorded` replays it.
  const replay = recordedCassette();
  const path = replay.path;
  const used = new Set<string>();
  const client: JevClient = {
    ask: (req) => {
      used.add(requestKey(req));
      return replay.ask(req);
    },
  };
  let misses = 0;
  const count = (record: Parameters<typeof isCassetteMiss>[0]): void => {
    if (isCassetteMiss(record)) misses += 1;
  };
  await runAll(loadCorpus(defaultCorpusFile()), loadScenarios(scenariosDir()), {
    client,
    thresholds: { ...DEFAULT_THRESHOLDS },
    todayIso: REGRESS_TODAY,
    now: () => 0,
    screen,
  }, {
    onCorpus: (_done, _total, _entry, record) => count(record),
    onScenario: (_done, _total, _scenario, records) => records.forEach(count),
  });
  if (misses > 0) {
    console.error(`${path}: ${misses} requests missed; re-record the cassette (run the regression with --client record) before trimming. Nothing written.`);
    process.exitCode = 1;
    return;
  }
  const lines = loadCassette(path);
  const kept = trimCassette(lines, used);
  writeFileSync(path, kept.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${path}: ${lines.size} answers, kept the ${kept.length} a regression run asks for`);
}

/** The process entry point, run by an app's launcher after it has registered the app. */
export async function main(): Promise<void> {
  await run().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}

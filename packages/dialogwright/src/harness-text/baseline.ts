import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Outcome } from './runner';
import { expectedDir } from '../run/fixtures';

/** Fixed so recorded outcomes never depend on the wall clock. */
export const REGRESS_TODAY = '2026-09-18';

export type ScenarioOutcome = Outcome & { pass: boolean; mismatches: string[] };

export interface Baseline {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
}

function readExpected<T>(file: string, dir: string = expectedDir()): Record<string, T> {
  const path = `${dir}/${file}`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>) : {};
}

export function readBaseline(dir: string = expectedDir()): Baseline {
  return { corpus: readExpected<Outcome>('corpus.json', dir), scenarios: readExpected<ScenarioOutcome>('scenarios.json', dir) };
}

export function writeExpected(baseline: Baseline, dir: string = expectedDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/corpus.json`, JSON.stringify(baseline.corpus, null, 2) + '\n');
  writeFileSync(`${dir}/scenarios.json`, JSON.stringify(baseline.scenarios, null, 2) + '\n');
}

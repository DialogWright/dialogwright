import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadKnowledgeFolder } from '../../define/load';
import type { KnowledgeBase, NominateInput, Nomination } from '../types';

/**
 * What the retrieval tests share: the library knowledge base (./kb), its paraphrase set
 * (./paraphrases.yaml), and the goldens of every retriever's nominations for that set
 * (./nominations.golden.json: per retriever, each line's nominations as "topic score via").
 */

export const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const TODAY = '2026-10-03';

/** The library knowledge base, loaded. */
export const libraryKb = (): KnowledgeBase => loadKnowledgeFolder(join(FIXTURES, 'kb'), 'en-US').kb!;

/** Every line of the paraphrase set, topics' then none's, in the file's order. */
export function paraphraseLines(): string[] {
  const data = parse(readFileSync(join(FIXTURES, 'paraphrases.yaml'), 'utf8')) as Record<string, string[]>;
  return [...Object.entries(data).filter(([k]) => k !== 'none').flatMap(([, v]) => v), ...(data.none ?? [])];
}

/** The nominations goldens, by retriever. */
export const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, 'nominations.golden.json'), 'utf8')) as Record<string, Record<string, string[]>>;

/** Nominations as the golden writes them. */
export const shown = (ns: readonly Nomination[]): string[] => ns.map((n) => `${n.topic} ${n.score} ${n.via}`);

/** A nominate input in English, today. */
export const en = (text: string): NominateInput => ({ text, locale: 'en-US', todayIso: TODAY });

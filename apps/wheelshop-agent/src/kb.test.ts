import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { bakeoff, defaultRetriever, loadKnowledgeFolder, parseParaphrases } from 'dialogwright';

/**
 * The knowledge base's retrieval held to its paraphrases (fixtures/kb/paraphrases.yaml): what callers say about each
 * topic in words the topics do not use. kb.yaml's floor and cap were chosen on them with pnpm kb:bakeoff --sweep; a change
 * to a topic's words or the retrieval that loses recall fails here, not on a call.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));

it('nominates the right topic for what callers say in their own words', async () => {
  const kb = loadKnowledgeFolder(`${APP}kb`).kb!;
  const paraphrases = parseParaphrases(readFileSync(`${APP}fixtures/kb/paraphrases.yaml`, 'utf8'), kb);
  const result = await bakeoff(defaultRetriever(kb).retriever, paraphrases, 'en-US', '2026-11-27');
  expect(result.recall).toBeGreaterThanOrEqual(0.95);
  expect(result.noneCandidates).toBeLessThanOrEqual(2);
});

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadKnowledgeFolder } from '../define/load';
import { approveDocument, placeOf } from './approval';
import { KB_FIXTURE, TODAY, VISITOR_GUIDE } from './__fixtures__/libraryKbApp';
import { kbIndexCommand } from './commands';
import type { Embedder } from './embed/types';
import { LazyOnnxEmbedder, onnxIdOf, onnxIndexIdOf, onnxSha256, type OnnxEmbedderOptions, type OnnxEmbedder } from './onnx';
import { kbSectionsIndexProblems } from './rules';
import { defaultSectionRetriever, SectionRetriever } from './sections';
import type { DocumentsEmbedder, KnowledgeBase } from './types';
import { allIndexTexts, parseIndex, sectionsIndexTexts } from './vectorIndex';

/**
 * The sections' own embedding model (kb.yaml documents.embedder, an ONNX model): their vectors in an
 * index of their own, written by kb:index and held to their texts by pnpm check, and a retriever that
 * finds them by its meaning alone (documents.retrieval: dense) or fused with keywords, the model loaded
 * when the server starts (warm) and the keywords kept when it cannot be. A fake model stands in for the
 * package, which a test never installs.
 */

const MODEL: DocumentsEmbedder = { onnx: 'Example/tiny-model', revision: 'a'.repeat(40), pooling: 'cls', dtype: 'fp32' };

/** A deterministic stand-in for the ONNX model: each text's vector its words' letters folded into eight numbers. */
function fakeModel(): Embedder & { calls: number } {
  const fake = {
    id: onnxIdOf(MODEL),
    revision: MODEL.revision,
    sha256: onnxSha256(MODEL.onnx, MODEL.revision, MODEL.dtype, MODEL.pooling),
    dim: 8,
    calls: 0,
    embed(texts: readonly string[]) {
      fake.calls += 1;
      return texts.map((t) => {
        const v = new Float64Array(8);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) v[w.charCodeAt(0) % 8]! += 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return fake;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The library's kb with the visitor guide approved for summarizing and the sections' own model named. */
function kbWith(retrieval: 'hybrid' | 'dense' = 'dense'): { dir: string; kb: () => KnowledgeBase } {
  const root = mkdtempSync(join(tmpdir(), 'dialogwright-kb-documents-embedder-'));
  scratch.push(root);
  const dir = join(root, 'kb');
  cpSync(KB_FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'sources', 'visitor-guide.yaml'), VISITOR_GUIDE);
  const kbYaml = join(dir, 'kb.yaml');
  writeFileSync(kbYaml, `${readFileSync(kbYaml, 'utf8').trimEnd()}\ndocuments:\n  summarize: on\n  retrieval: ${retrieval}\n  floor: 0.5\n  embedder:\n    onnx: ${MODEL.onnx}\n    revision: ${MODEL.revision}\n`);
  const place = placeOf(dir, 'kb');
  if (typeof place === 'string') throw new Error(place);
  expect(approveDocument(place, 'visitor-guide', { by: 'Riley Moreno', owner: 'Branch Services', today: TODAY })).toMatchObject({ outcome: 'approved' });
  return { dir, kb: () => loadKnowledgeFolder(dir, 'en-US').kb! };
}

const io = (dir: string, model: Embedder, out: string[]) => ({ out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`), cwd: join(dir, '..'), onnxEmbedderFor: async () => model });
const locate = () => null;

describe('the sections\' own model', () => {
  it('reads documents.embedder, and its sections leave retrieval.embedder\'s index for one of their own', () => {
    const kb = kbWith().kb();
    expect(kb.settings.documents).toMatchObject({ summarize: 'on', retrieval: 'dense', embedder: MODEL });
    expect(allIndexTexts(kb).some((t) => t.field === 'section')).toBe(false);
    expect(new Set(sectionsIndexTexts(kb).map((t) => t.topic))).toEqual(new Set(['visitor-guide#wifi', 'visitor-guide#printing', 'visitor-guide#parking', 'visitor-guide#lost-card']));
    expect(onnxIndexIdOf(MODEL)).toBe('onnx-example-tiny-model');
  });

  it('has its index written by kb:index (the sections only, by that model) and held to the sections by pnpm check', async () => {
    const { dir, kb } = kbWith();
    expect(kbSectionsIndexProblems(kb(), locate).map((p) => p.message)).toEqual([expect.stringContaining('kb/.index/onnx-example-tiny-model.json is missing')]);
    const out: string[] = [];
    expect(await kbIndexCommand([dir], io(dir, fakeModel(), out), () => [])).toBe(0);
    const file = join(dir, '.index', 'onnx-example-tiny-model.json');
    expect(existsSync(file)).toBe(true);
    const data = parseIndex(readFileSync(file, 'utf8'));
    if (typeof data === 'string') throw new Error(data);
    expect(data.embedder).toMatchObject({ id: 'onnx:Example/tiny-model', revision: MODEL.revision, dim: 8 });
    expect(data.entries.every((e) => e.field === 'section')).toBe(true);
    expect(kbSectionsIndexProblems(kb(), locate)).toEqual([]);
    // A section changed: its texts have no vector, and its old ones are for text it no longer has.
    const guide = join(dir, 'sources', 'visitor-guide.yaml');
    writeFileSync(guide, readFileSync(guide, 'utf8').replace('free Wi-Fi', 'fast Wi-Fi'));
    expect(kbSectionsIndexProblems(loadKnowledgeFolder(dir, 'en-US').kb!, locate).map((p) => p.message)).toEqual([expect.stringMatching(/stale for the sections: no vector for 1 text of visitor-guide#wifi; 1 vector for text no section has any more \(visitor-guide#wifi\)/)]);
  });

  it('refuses an index another model wrote, naming both', async () => {
    const { dir, kb } = kbWith();
    const other = { ...fakeModel(), id: 'onnx:Example/other-model', sha256: 'f'.repeat(64) };
    await kbIndexCommand([dir], io(dir, other, []), () => []);
    expect(kbSectionsIndexProblems(kb(), locate).map((p) => p.message)).toEqual([expect.stringMatching(/was written by onnx:Example\/other-model .* not by onnx:Example\/tiny-model/)]);
  });
});

describe('its retriever', () => {
  it('is the default with its index there: by meaning alone (dense), its model loaded on warm, never before', async () => {
    const { dir, kb } = kbWith('dense');
    await kbIndexCommand([dir], io(dir, fakeModel(), []), () => []);
    const r = defaultSectionRetriever(kb(), undefined)!;
    expect(r.id).toBe('sections:dense:onnx:Example/tiny-model');
    expect(r.indexHash).toMatch(/^[0-9a-f]{64}$/);
    // The package is not installed in a test: warm fails, and the sections are found by their keywords.
    await expect(r.warm()).rejects.toThrow(/@huggingface\/transformers/);
    expect((await r.nominate({ text: 'how much does printing cost', locale: 'en-US', todayIso: TODAY }))[0]).toMatchObject({ topic: 'visitor-guide#printing', via: 'keyword' });
  });

  it('loads its model once, on warm or the first question, and finds by meaning alone or fused', async () => {
    const { dir, kb } = kbWith('dense');
    const model = fakeModel();
    await kbIndexCommand([dir], io(dir, model, []), () => []);
    const index = kb().sectionsIndex!;
    if (!('data' in index)) throw new Error('no index');
    let created = 0;
    const lazy = new LazyOnnxEmbedder(MODEL, 8, '/apps/example', async (o: OnnxEmbedderOptions) => {
      created += 1;
      // The package is found from the app's own folder (an app installs it there), never from inside kb/.
      expect(o).toMatchObject({ model: MODEL.onnx, revision: MODEL.revision, pooling: 'cls', dtype: 'fp32', from: '/apps/example' });
      return model as unknown as OnnxEmbedder;
    });
    expect(lazy).toMatchObject({ id: model.id, sha256: model.sha256, dim: 8 });
    const dense = new SectionRetriever(kb(), { dense: { embedder: lazy, vectors: index.data, floor: 0.5 }, keywords: false });
    expect(created).toBe(0);
    expect(await dense.warm()).toBe(true);
    const got = await dense.nominate({ text: 'free wifi at every branch', locale: 'en-US', todayIso: TODAY });
    expect(got.every((n) => n.via === 'dense')).toBe(true);
    expect(created).toBe(1);
    const hybrid = new SectionRetriever(kb(), { dense: { embedder: lazy, vectors: index.data, floor: 0.5 } });
    expect(hybrid.id).toBe('sections:hybrid:onnx:Example/tiny-model');
    expect(await new SectionRetriever(kb(), {}).warm()).toBe(false);
  });
});

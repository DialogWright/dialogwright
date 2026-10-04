import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OnnxEmbedder, OnnxUnavailableError, onnxAvailable } from './onnx';

const here = dirname(fileURLToPath(import.meta.url));

describe('the optional ONNX embedder (dialogwright/kb/onnx)', async () => {
  const available = await onnxAvailable();

  const PINNED = 'a'.repeat(40);

  it('needs a pinned revision, a commit, before anything is loaded: no branch, no default', async () => {
    for (const revision of [undefined, 'main', 'v1.0', 'A'.repeat(40), 'a'.repeat(39)]) {
      await expect(OnnxEmbedder.create({ revision } as unknown as { revision: string }), String(revision)).rejects.toThrow('the ONNX embedder needs a pinned revision');
    }
    await expect((OnnxEmbedder.create as unknown as () => Promise<unknown>)()).rejects.toThrow('the ONNX embedder needs a pinned revision');
  });

  it.skipIf(available)('without its package, says which package to install', async () => {
    await expect(OnnxEmbedder.create({ revision: PINNED })).rejects.toThrow(OnnxUnavailableError);
    await expect(OnnxEmbedder.create({ revision: PINNED })).rejects.toThrow('pnpm add @huggingface/transformers');
  });

  it.skipIf(!available)('with its package, embeds texts as unit vectors of its dimension', async () => {
    const embedder = await OnnxEmbedder.create({ revision: process.env.DIALOGWRIGHT_ONNX_REVISION ?? PINNED });
    const [v] = await embedder.embed(['When are you open?']);
    expect(v!.length).toBe(embedder.dim);
    expect(Math.abs(Math.hypot(...v!) - 1)).toBeLessThan(1e-3);
  });

  it('is a subpath of the package, not a dependency of it', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(pkg.exports!['./kb/onnx']).toBe('./src/kb/onnx.ts');
    expect(pkg.dependencies!['@huggingface/transformers']).toBeUndefined();
    expect(pkg.peerDependenciesMeta!['@huggingface/transformers']).toEqual({ optional: true });
  });
});

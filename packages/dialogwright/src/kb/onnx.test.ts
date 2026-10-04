import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OnnxEmbedder, OnnxUnavailableError, onnxAvailable } from './onnx';

const here = dirname(fileURLToPath(import.meta.url));

describe('the optional ONNX embedder (dialogwright/kb/onnx)', async () => {
  const available = await onnxAvailable();

  it.skipIf(available)('without its package, says which package to install', async () => {
    await expect(OnnxEmbedder.create()).rejects.toThrow(OnnxUnavailableError);
    await expect(OnnxEmbedder.create()).rejects.toThrow('pnpm add @huggingface/transformers');
  });

  it.skipIf(!available)('with its package, embeds texts as unit vectors of its dimension', async () => {
    const embedder = await OnnxEmbedder.create();
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

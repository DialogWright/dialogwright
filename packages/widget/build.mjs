// Builds the script a site loads: dist/dialogwright-widget.js (a classic script: a <script> tag
// mounts it from its data-* attributes, and it sets window.DialogWright) and
// dist/dialogwright-widget.mjs (the same as an ES module, for a site's own bundler).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const common = {
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  target: ['es2020'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...common, format: 'iife', outfile: 'dist/dialogwright-widget.js' });
await build({ ...common, format: 'esm', outfile: 'dist/dialogwright-widget.mjs' });

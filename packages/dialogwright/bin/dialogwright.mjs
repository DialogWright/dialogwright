#!/usr/bin/env node
// The `dialogwright` command of an installed package (its package.json's publishConfig.bin; in this
// repository the bin is src/define/cli.ts, run by tsx). It registers tsx's loader first, since the
// commands that read an app's own code (check, regress, policy:matrix, policy:card, app:diagram)
// import its TypeScript, then runs the one command line, src/define/cli.ts: from dist/ in a package,
// or from src/ where there is one (this repository, which needs no build).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const source = new URL('../src/define/cli.ts', import.meta.url);
const entry = existsSync(fileURLToPath(source)) ? source : new URL('../dist/define/cli.js', import.meta.url);
const { main } = await import(entry.href);
process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env node
// `npm create dialogwright@latest <name>` (npm runs this package's bin): a DialogWright project of
// your own, written by the dialogwright package's own command, `dialogwright create-app <name>
// --standalone`, so there is one scaffold. The options are its: --identity, --display <text>,
// --dir <path>, and --dialogwright <spec> (the dependency the project names; default: ^ the version
// of dialogwright installed with this package).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The installed dialogwright package's folder: the nearest folder above its entry with its package.json. */
function dialogwrightDir() {
  let at = dirname(createRequire(import.meta.url).resolve('dialogwright'));
  for (;;) {
    const manifest = join(at, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'dialogwright') return at;
    if (dirname(at) === at) throw new Error('create-dialogwright: the dialogwright package is not installed beside it');
    at = dirname(at);
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log('usage: npm create dialogwright@latest <name> -- [--identity] [--display "<business name>"] [--dir <path>]');
  console.log('  (with pnpm: pnpm create dialogwright <name> [--identity] ...; npm passes the options on after --)');
  console.log('  name: lowercase letters, digits and hyphens; the project is <name> in this folder unless --dir says where');
  console.log('  --identity: callers verify with two factors (an account number and a birth date) before the booking');
  console.log('  --display: the name the greeting and the console use');
  process.exit(args.length === 0 ? 2 : 0);
}
const bin = join(dialogwrightDir(), 'bin', 'dialogwright.mjs');
const run = spawnSync(process.execPath, [bin, 'create-app', ...args, '--standalone'], { stdio: 'inherit' });
process.exit(run.status ?? 1);

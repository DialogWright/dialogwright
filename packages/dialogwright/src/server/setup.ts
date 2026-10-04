import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { carrierSteps } from './carrierSteps';
import type { Env } from './config';
import { main as diagnose } from './doctor';
import { checkSecretOf } from './voice/registry';
import { resolveJevProvider } from '../jev/provider';
import { findApp, workspaceApps, WORKSPACE_ROOT, appList, type WorkspaceApp } from './workspace';

/**
 * `pnpm configure`: the first hour's settings, asked for and written. It asks, in order: which app; to
 * try it on this computer with no keys (the web chat and the console, the app understanding by its own
 * examples) or as a phone line; for a phone line, the carrier and its secret, and the decision model and
 * its key; and the number a call goes to for a person. It writes `<app>/.env`, readable by its owner
 * alone (mode 600), and never over an existing one without --force; runs `pnpm diagnose --offline` on
 * it; and says what to run next and where to paste the webhook in the carrier's console.
 *
 * Every question is also a flag, for a script: --app, --mode try|phone, --carrier telnyx|twilio,
 * --model typesafe|openrouter|vercel|custom|none (custom: --base-url, --model-id), --handoff,
 * --public-host, --port, --force and --non-interactive. A key is never a flag (a flag is kept in the
 * shell's history and shown by ps): it comes from the environment variable of its own name
 * (TELNYX_PUBLIC_KEY, OPENROUTER_API_KEY, ...) when that is set, and is otherwise asked for with the
 * echo off. A key is never printed (its length is), and nothing here sends one anywhere: it goes into
 * the file and nowhere else.
 */

export interface Prompt {
  /** Asks a question and resolves with the answer, trimmed; with `secret`, what is typed is not shown. */
  ask(question: string, opts?: { secret?: boolean }): Promise<string>;
  close?(): void;
}

export interface SetupIo {
  out(line: string): void;
  /** Where answers come from; null asks nothing (flags alone). */
  prompt: Prompt | null;
  /** The environment: where a key may already be. */
  env: Env;
  /** Where the command was run (pnpm's INIT_CWD). */
  invokedFrom: string;
  /** The repository root. */
  root?: string;
}

/**
 * Questions read from `input` a line at a time, the answers to come queued (so answers piped in all at
 * once are each taken by their own question). At a terminal, what is typed for a secret is not echoed:
 * the line editor's output is muted while it is read.
 */
export function linePrompt(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream, onInterrupt?: () => void): Prompt {
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  // No history: the up arrow at a later question would otherwise bring back, and show, a key typed earlier.
  const rl = createInterface({ input, output: sink, terminal: input.isTTY === true, historySize: 0 });
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const w of waiting.splice(0)) w(null);
  });
  if (onInterrupt) rl.on('SIGINT', onInterrupt);
  return {
    async ask(question, opts) {
      output.write(`${question} `);
      muted = opts?.secret === true;
      const line = lines.length > 0 ? lines.shift()! : ended ? null : await new Promise<string | null>((resolve) => waiting.push(resolve));
      muted = false;
      if (opts?.secret === true) output.write('\n');
      if (line === null) throw new Error('no answer: the input ended');
      return line.trim();
    },
    close: () => rl.close(),
  };
}

type Mode = 'try' | 'phone';
type Carrier = 'telnyx' | 'twilio';
type Model = 'typesafe' | 'openrouter' | 'vercel' | 'custom' | 'none';

interface Flags {
  app?: string;
  mode?: Mode;
  carrier?: Carrier;
  model?: Model;
  baseUrl?: string;
  modelId?: string;
  handoff?: string;
  publicHost?: string;
  port?: string;
  force: boolean;
  nonInteractive: boolean;
}

export const SETUP_USAGE = [
  'usage: pnpm configure [--app <name>] [--mode try|phone] [--carrier telnyx|twilio]',
  '         [--model typesafe|openrouter|vercel|custom|none] [--base-url <url> --model-id <id>]',
  '         [--handoff <E.164>] [--public-host <host>] [--port <n>] [--force] [--non-interactive]',
  '  a key is never a flag: it is read from the environment variable of its name, or asked for with the echo off',
].join('\n');

/** A refusal of the command line: exit 2, with the message. */
class UsageError extends Error {}

const MODES = ['try', 'phone'] as const;
const CARRIERS = ['telnyx', 'twilio'] as const;
const MODELS = ['typesafe', 'openrouter', 'vercel', 'custom', 'none'] as const;

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    const list = allowed.length === 2 ? `${allowed[0]} or ${allowed[1]}` : `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)!}`;
    throw new UsageError(`${flag} must be ${list}, got "${value}"`);
  }
  return value as T;
}

function parseFlags(argv: readonly string[]): Flags {
  const f: Flags = { force: false, nonInteractive: false };
  const valued = new Set(['--app', '--mode', '--carrier', '--model', '--base-url', '--model-id', '--handoff', '--public-host', '--port']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--force') f.force = true;
    else if (a === '--non-interactive') f.nonInteractive = true;
    else if (valued.has(a) && argv[i + 1] !== undefined) {
      const v = argv[++i]!;
      if (a === '--app') f.app = v;
      else if (a === '--mode') f.mode = oneOf(a, v, MODES);
      else if (a === '--carrier') f.carrier = oneOf(a, v, CARRIERS);
      else if (a === '--model') f.model = oneOf(a, v, MODELS);
      else if (a === '--base-url') f.baseUrl = v;
      else if (a === '--model-id') f.modelId = v;
      else if (a === '--handoff') f.handoff = v;
      else if (a === '--public-host') f.publicHost = v.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      else f.port = v;
    } else throw new UsageError(SETUP_USAGE);
  }
  return f;
}

/** Each carrier's secret: the variable, how it is asked for, and what it must be. */
const CARRIER_SECRET: Record<Carrier, { label: string; variable: string; question: string; check(v: string): string | null }> = {
  telnyx: {
    label: 'Telnyx',
    variable: 'TELNYX_PUBLIC_KEY',
    question: 'Telnyx public key (Mission Control: Account settings, Keys & Credentials, Public Key; not shown as you type):',
    check: (v) => {
      try {
        checkSecretOf('telnyx', v);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  },
  twilio: {
    label: 'Twilio',
    variable: 'TWILIO_AUTH_TOKEN',
    question: 'Twilio auth token (Console, Account Info; not shown as you type):',
    check: (v) => (/^[0-9a-fA-F]{32}$/.test(v) ? null : `a Twilio auth token is 32 hexadecimal characters; that was ${v.length}`),
  },
};

/** Each hosted model provider's key. */
const MODEL_KEY: Record<'typesafe' | 'openrouter' | 'vercel', { label: string; variable: string }> = {
  typesafe: { label: 'TypeSafe', variable: 'TYPESAFE_API_KEY' },
  openrouter: { label: 'OpenRouter', variable: 'OPENROUTER_API_KEY' },
  vercel: { label: 'Vercel AI Gateway', variable: 'AI_GATEWAY_API_KEY' },
};

const E164 = /^\+\d{8,15}$/;
const TRY_HANDOFF = '+15555550123';
/** The most times a question is asked again before the wizard gives up. */
const TRIES = 3;

/** A value as a settings file line; a value a line cannot hold is refused rather than written wrong. */
function envLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new UsageError(`${name} cannot hold a line break`);
  if (/^[A-Za-z0-9_@%+=:,./~-]*$/.test(value)) return `${name}=${value}`;
  if (value.includes("'")) throw new UsageError(`${name} cannot be written with both spaces or symbols and a ' in it`);
  return `${name}='${value}'`;
}

/** What a settings file says, in groups, each with its comment. */
interface Section {
  comment: string[];
  lines: { name: string; value: string; secret?: boolean; commented?: boolean }[];
}

export async function runSetup(argv: readonly string[], io: SetupIo): Promise<number> {
  const out = io.out;
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const interactive = !flags.nonInteractive && io.prompt !== null;
  const root = io.root ?? WORKSPACE_ROOT;
  try {
    return await wizard(flags, io, interactive, root);
  } catch (e) {
    if (e instanceof UsageError) {
      out(e.message);
      return 2;
    }
    out(`stopped: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function wizard(flags: Flags, io: SetupIo, interactive: boolean, root: string): Promise<number> {
  const out = io.out;
  const ask = async (question: string, secret = false): Promise<string> => {
    if (!interactive || io.prompt === null) throw new Error(`cannot ask "${question}" with --non-interactive`);
    return io.prompt.ask(question, { secret });
  };
  /** A flag's value, or the question's answer; with --non-interactive, a missing flag is refused. */
  const need = (flag: string, what: string) => new UsageError(`${flag} is needed with --non-interactive (${what})`);
  const choose = async <T extends string>(question: string, options: readonly { value: T; label: string }[]): Promise<T> => {
    out(question);
    options.forEach((o, i) => out(`  ${i + 1}) ${o.label}`));
    for (let tries = 0; tries < TRIES; tries++) {
      const a = (await ask(`Choose 1 to ${options.length} [1]:`)).toLowerCase();
      if (a === '') return options[0]!.value;
      const n = Number(a);
      const picked = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : options.find((o) => o.value === a);
      if (picked) return picked.value;
      out(`  ${a} is not one of them`);
    }
    throw new Error('no choice made');
  };
  /** A secret from the environment variable of its name, else asked for with the echo off, checked each time. */
  const secret = async (variable: string, question: string, check: (v: string) => string | null, optional = false): Promise<string> => {
    const fromEnv = io.env[variable]?.trim();
    if (fromEnv) {
      const problem = check(fromEnv);
      if (problem === null) {
        out(`${variable} from the environment (${fromEnv.length} chars)`);
        return fromEnv;
      }
      if (!interactive) throw new UsageError(`${variable} in the environment will not do: ${problem}`);
      out(`${variable} in the environment will not do (${problem}); asking instead`);
    }
    if (!interactive) {
      if (optional) return '';
      throw new UsageError(`${variable} is needed in the environment with --non-interactive (a key is never a flag)`);
    }
    for (let tries = 0; tries < TRIES; tries++) {
      const v = await ask(question, true);
      if (v === '' && optional) return '';
      const problem = v === '' ? 'nothing was entered' : check(v);
      if (problem === null) return v;
      out(`  ${problem}`);
    }
    throw new Error(`no ${variable} that will do`);
  };
  /** A plain answer from a flag or a question, checked; `fallback` is taken for an empty answer. */
  const answer = async (flagValue: string | undefined, flag: string, what: string, question: string, check: (v: string) => string | null, fallback?: string): Promise<string> => {
    if (flagValue !== undefined) {
      const problem = check(flagValue);
      if (problem !== null) throw new UsageError(problem);
      return flagValue;
    }
    if (!interactive) {
      if (fallback !== undefined) return fallback;
      throw need(flag, what);
    }
    for (let tries = 0; tries < TRIES; tries++) {
      const v = (await ask(question)) || fallback || '';
      const problem = v === '' ? 'nothing was entered' : check(v);
      if (problem === null) return v;
      out(`  ${problem}`);
    }
    throw new Error(`no ${what} that will do`);
  };

  // Which app.
  const apps = workspaceApps(root);
  if (apps.length === 0) {
    out('no app in this workspace yet: make one with pnpm create-app <name>, then run pnpm configure again');
    return 1;
  }
  let app: WorkspaceApp;
  if (flags.app !== undefined) {
    const found = findApp(apps, flags.app, io.invokedFrom);
    if (found === null) throw new UsageError(`no app "${flags.app}" in this workspace (apps: ${appList(apps)})`);
    app = found;
  } else if (apps.length === 1) {
    app = apps[0]!;
  } else if (!interactive) {
    throw need('--app', `one of ${appList(apps)}`);
  } else {
    const dir = await choose('Which app?', apps.map((a) => ({ value: a.dir, label: `${basename(a.dir)} (${a.name})` })));
    app = apps.find((a) => a.dir === dir)!;
  }
  const short = basename(app.dir);
  out(`App: ${short} (${app.folder})`);
  const file = join(app.dir, '.env');
  if (existsSync(file) && !flags.force) {
    out(`${file} exists: pnpm configure --force replaces it (keep a copy of its keys first)`);
    return 1;
  }

  // How to try it.
  const mode: Mode = flags.mode ?? (flags.carrier !== undefined ? 'phone' : !interactive ? 'try' : await choose('How do you want to try it?', [
    { value: 'try', label: 'on this computer, with no keys: the web chat and the console, the app understanding by its own examples' },
    { value: 'phone', label: 'as a phone line: a carrier (Telnyx or Twilio), a decision model, and a tunnel (no account for a quick one)' },
  ]));
  const port = flags.port ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new UsageError(`--port must be a port number, got "${port}"`);
  const sections: Section[] = [];
  const checkHandoff = (v: string) => (E164.test(v) ? null : `HANDOFF_NUMBER must be an E.164 number like +15551234567, got "${v}"`);

  if (mode === 'try') {
    const handoff = await answer(flags.handoff, '--handoff', 'an E.164 number', `The number a call goes to for a person (E.164; Enter for ${TRY_HANDOFF}, which goes nowhere):`, checkHandoff, TRY_HANDOFF);
    const widget = join(root, 'packages', 'widget', 'dist', 'dialogwright-widget.js');
    const signIn = (() => {
      try {
        return /^\s*signIn\s*:/m.test(readFileSync(join(app.dir, 'identity.yaml'), 'utf8'));
      } catch {
        return false;
      }
    })();
    sections.push(
      {
        comment: ['This computer only: nothing public reaches localhost, so no carrier calls it and its secret is never used.'],
        lines: [
          { name: 'PUBLIC_HOST', value: 'localhost' },
          { name: 'PORT', value: port },
          { name: 'VOICE_PROVIDERS', value: 'twilio' },
          { name: 'TWILIO_AUTH_TOKEN', value: 'not-used-on-a-laptop' },
          { name: 'SIGNATURE_CHECK', value: 'on' },
        ],
      },
      { comment: ['Where a call goes when the caller wants a person (E.164).'], lines: [{ name: 'HANDOFF_NUMBER', value: handoff }] },
      { comment: ['No model: the app understands by its own labelled examples and keywords. Enough to walk every path.'], lines: [{ name: 'JEV_CLIENT', value: 'heuristic' }] },
      {
        comment: ["The engine's web chat, for pages on this computer.", ...(signIn ? ['A chat signs in with mock:<id>, which only a laptop allows.'] : [])],
        lines: [
          { name: 'CHAT', value: 'on' },
          { name: 'CHAT_ALLOWED_ORIGINS', value: `http://localhost:${port}` },
          ...(signIn ? [{ name: 'CHAT_SIGNIN', value: 'mock' }] : []),
        ],
      },
      existsSync(widget)
        ? { comment: ["The chat widget's script, served on /widget.js."], lines: [{ name: 'WIDGET', value: 'on' }, { name: 'WIDGET_FILE', value: widget }] }
        : { comment: ["The chat widget's script, served on /widget.js, once it is built: pnpm --filter @dialogwright/widget build."], lines: [{ name: 'WIDGET', value: 'on', commented: true }, { name: 'WIDGET_FILE', value: widget, commented: true }] },
    );
  } else {
    // The carrier, and its secret.
    const carrier: Carrier = flags.carrier ?? (!interactive ? (() => { throw need('--carrier', 'telnyx or twilio'); })() : await choose('Which carrier answers the number?', [
      { value: 'telnyx', label: 'Telnyx' },
      { value: 'twilio', label: 'Twilio' },
    ]));
    const c = CARRIER_SECRET[carrier];
    const carrierSecret = await secret(c.variable, c.question, c.check);
    // The model, and its key.
    const model: Model = flags.model ?? (!interactive ? (() => { throw need('--model', MODELS.join(', ')); })() : await choose('Which decision model understands the callers?', [
      { value: 'typesafe', label: 'TypeSafe (Jev), with a TYPESAFE_API_KEY' },
      { value: 'openrouter', label: 'OpenRouter, with an OPENROUTER_API_KEY' },
      { value: 'vercel', label: 'the Vercel AI Gateway, with an AI_GATEWAY_API_KEY' },
      { value: 'custom', label: 'a compatible endpoint, such as a model on this machine (its URL and model; a key only if it asks)' },
      { value: 'none', label: 'none for now: the app understands by its own examples' },
    ]));
    const modelLines: Section['lines'] = [];
    if (model === 'none') modelLines.push({ name: 'JEV_CLIENT', value: 'heuristic' });
    else if (model === 'custom') {
      const checkCustom = (base: string, id: string) => {
        try {
          resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: base, JEV_MODEL: id });
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      const modelId = await answer(flags.modelId, '--model-id', "the endpoint's model", 'The model to ask (JEV_MODEL):', (v) => (v.trim() ? null : 'a model is needed'));
      const base = await answer(flags.baseUrl, '--base-url', "the endpoint's URL", 'Its base URL (https, or http on this machine, like http://localhost:8000):', (v) => checkCustom(v, modelId));
      const key = await secret('JEV_API_KEY', 'Its key, if it asks for one (Enter for none; not shown as you type):', () => null, true);
      modelLines.push({ name: 'JEV_CLIENT', value: 'jev' }, { name: 'JEV_PROVIDER', value: 'custom' }, { name: 'JEV_BASE_URL', value: base }, { name: 'JEV_MODEL', value: modelId });
      if (key) modelLines.push({ name: 'JEV_API_KEY', value: key, secret: true });
    } else {
      const k = MODEL_KEY[model];
      const key = await secret(k.variable, `${k.label} key (not shown as you type):`, () => null);
      modelLines.push({ name: 'JEV_CLIENT', value: 'jev' }, { name: 'JEV_PROVIDER', value: model }, { name: k.variable, value: key, secret: true });
    }
    const handoff = await answer(flags.handoff, '--handoff', 'an E.164 number', 'The number a call goes to when the caller wants a person (E.164, like +15551234567):', checkHandoff);
    sections.push(
      {
        comment: [`The carrier: ${c.label} answers on /voice/${carrier}. ${c.variable} checks that each webhook is ${c.label}'s.`],
        lines: [{ name: 'VOICE_PROVIDERS', value: carrier }, { name: c.variable, value: carrierSecret, secret: true }, { name: 'SIGNATURE_CHECK', value: 'on' }],
      },
      {
        comment: [
          'Where the carrier reaches this server, the bare hostname. Unset, pnpm start opens a quick tunnel each run',
          "(no account; a new hostname every time) and sets it. For one that stays, set your named tunnel's hostname.",
        ],
        lines: [flags.publicHost ? { name: 'PUBLIC_HOST', value: flags.publicHost } : { name: 'PUBLIC_HOST', value: 'ivr.example.com', commented: true }, { name: 'PORT', value: port }],
      },
      { comment: ['Where a call goes when the caller wants a person, or the line cannot help (E.164).'], lines: [{ name: 'HANDOFF_NUMBER', value: handoff }] },
      { comment: ['The decision model, which reads what callers say.'], lines: modelLines },
    );
    out('');
    writeSettings(file, app, sections, out);
    await check(file, app, io);
    const webhook = flags.publicHost ? `https://${flags.publicHost}/voice/${carrier}` : `https://<the hostname pnpm start prints>/voice/${carrier}`;
    out('');
    out('Next:');
    out(`  pnpm start --app ${short}`);
    out(
      flags.publicHost
        ? `  (PUBLIC_HOST is set: start the named tunnel for ${flags.publicHost} too, or its service)`
        : '  It opens a quick tunnel (cloudflared; no account) and prints your webhook URL, which changes every run.',
    );
    out('Then point the carrier at it:');
    for (const line of carrierSteps(carrier, webhook)) out(`  ${line}`);
    out(
      flags.publicHost
        ? `Then call your number. While it runs, pnpm diagnose --app ${short} checks it end to end, through the tunnel.`
        : 'Then call your number. While it runs, the pnpm diagnose line pnpm start prints checks it end to end, through the tunnel.',
    );
    out(`To keep the settings elsewhere (outside the repository, for a machine that stays up), move the file and name it: ENV_FILE=<path> pnpm start --app ${short}`);
    return 0;
  }
  out('');
  writeSettings(file, app, sections, out);
  await check(file, app, io);
  out('');
  out('Next:');
  out(`  pnpm start --app ${short}`);
  out(`  then open http://localhost:${port}/dashboard, the console (on this machine only), to watch each call and chat.`);
  out(`  To type to the app: pnpm --filter ${app.name} cli --client heuristic`);
  out(`  An app with a chat page (the utility example's is http://localhost:${port}/chat-demo) shows the widget there.`);
  out('  For a phone line, run pnpm configure --force again and choose one.');
  return 0;
}

/** The file, written readable by its owner alone (a temporary file of mode 600, renamed over the old), then a summary that shows no key. */
function writeSettings(file: string, app: WorkspaceApp, sections: Section[], out: (line: string) => void): void {
  const text = [
    `# ${app.name}'s settings, written by pnpm configure. It holds keys: it is readable by you alone (mode 600)`,
    '# and git-ignored. Never commit it, paste it or send it. pnpm start reads it (as ENV_FILE), and so do the',
    '# server and pnpm diagnose when ENV_FILE or --env-file names it; a variable already in the environment wins',
    '# over the file. Every other setting, with its default, is in .env.example beside it.',
    ...sections.flatMap((s) => ['', ...s.comment.map((c) => `# ${c}`), ...s.lines.map((l) => `${l.commented ? '# ' : ''}${envLine(l.name, l.value)}`)]),
    '',
  ].join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  out(`wrote ${file} (readable by you alone):`);
  for (const s of sections) {
    for (const l of s.lines) {
      if (l.commented) continue;
      out(l.secret ? `  ${l.name} set (${l.value.length} chars)` : `  ${l.name}=${l.value}`);
    }
  }
}

/** pnpm diagnose --offline on the file just written. */
async function check(file: string, app: WorkspaceApp, io: SetupIo): Promise<void> {
  io.out('');
  io.out('Checking it (pnpm diagnose --offline):');
  await diagnose(['--app', app.folder, '--env-file', file, '--offline'], { out: (l) => io.out(`  ${l}`), env: io.env, invokedFrom: io.invokedFrom, root: io.root });
}

// Run when invoked directly (tsx setup.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const prompt = linePrompt(process.stdin, process.stdout, () => {
    process.stdout.write('\nstopped; nothing was written\n');
    process.exit(130);
  });
  try {
    process.exitCode = await runSetup(process.argv.slice(2), {
      out: (line) => console.log(line),
      prompt,
      env: process.env,
      invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
    });
  } finally {
    prompt.close?.();
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseEnv } from 'node:util';
import { envLine, linePrompt, runSetup, type Prompt, type SetupIo } from './setup';

/**
 * `pnpm configure` (setup.ts): the wizard with scripted answers, and with flags alone. Every key is a
 * throwaway value made here, and every settings file is written in a temp workspace.
 */

const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const MODEL_KEY = 'or-test-key-made-up-for-this-test';
const TWILIO_TOKEN = 'abcdef0123456789abcdef0123456789';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace with the apps named, each an app folder with a serve script. */
function workspace(names: string[] = ['alpha']): { root: string; dir: (name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'configure-'));
  dirs.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  for (const n of names) {
    mkdirSync(join(root, 'apps', n), { recursive: true });
    writeFileSync(join(root, 'apps', n, 'package.json'), JSON.stringify({ name: `@example/${n}`, scripts: { serve: 'tsx src/serve.ts', cli: 'tsx src/cli.ts' } }));
    writeFileSync(join(root, 'apps', n, 'app.yaml'), `id: ${n}\n`);
  }
  return { root, dir: (name) => join(root, 'apps', name) };
}

interface Asked {
  question: string;
  secret: boolean;
}

/** A prompt that answers from a script, in order, and records what it was asked. */
function scripted(answers: string[]): Prompt & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    ask: async (question, opts) => {
      asked.push({ question, secret: opts?.secret === true });
      const a = answers.shift();
      if (a === undefined) throw new Error(`no scripted answer for: ${question}`);
      return a;
    },
  };
}

function io(root: string, prompt: Prompt | null, env: Record<string, string> = {}): SetupIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), prompt, env, invokedFrom: root, root };
}

const settings = (file: string) => parseEnv(readFileSync(file, 'utf8'));
const mode = (file: string) => statSync(file).mode & 0o777;

describe('pnpm configure, answering its questions', () => {
  it('writes a phone line on Telnyx with a model, readable by its owner alone, and never prints a key', async () => {
    const w = workspace(['alpha', 'beta']);
    // app 2 (beta); a phone line; Telnyx and its key; OpenRouter and its key; the handoff number
    const prompt = scripted(['2', '2', '1', TELNYX_KEY, '2', MODEL_KEY, '+15555550123']);
    const o = io(w.root, prompt);
    expect(await runSetup([], o)).toBe(0);
    const file = join(w.dir('beta'), '.env');
    expect(mode(file)).toBe(0o600);
    expect(settings(file)).toEqual({
      VOICE_PROVIDERS: 'telnyx',
      TELNYX_PUBLIC_KEY: TELNYX_KEY,
      SIGNATURE_CHECK: 'on',
      PORT: '3000',
      HANDOFF_NUMBER: '+15555550123',
      JEV_CLIENT: 'jev',
      JEV_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: MODEL_KEY,
      // The retention policy a new settings file starts with; the audit left to its owner (a comment).
      TRACE_RETENTION_DAYS: '30',
      TRACE_MAX_GB: '5',
      DISK_WARN_FREE_GB: '2',
      LOG_MAX_MB: '10',
      LOG_KEEP: '5',
    });
    expect(readFileSync(file, 'utf8')).toContain('\n# AUDIT_RETENTION_DAYS=\n');
    // The keys were asked for with the echo off, and nothing printed carries them.
    expect(prompt.asked.filter((a) => a.secret).map((a) => a.question)).toEqual([
      expect.stringContaining('Telnyx public key'),
      expect.stringContaining('OpenRouter key'),
    ]);
    const said = o.lines.join('\n');
    expect(said).not.toContain(TELNYX_KEY);
    expect(said).not.toContain(MODEL_KEY);
    expect(said).toContain('TELNYX_PUBLIC_KEY set (44 chars)');
    expect(said).toContain(`wrote ${file}`);
    // The doctor ran, offline, and the next steps name the command and the carrier's console.
    expect(said).toContain('config loads');
    expect(said).toContain('pnpm start --app beta');
    expect(said).toContain('Send a TeXML Webhook to the URL');
    expect(said).toContain('https://<the hostname pnpm start prints>/voice/telnyx');
    expect(said).toContain('ENV_FILE=<path> pnpm start --app beta');
    // The offline check says the file it wrote is its owner's alone.
    expect(said).toContain(`ok    ${file} is readable by its owner alone`);
  });

  it('asks again for a key that cannot be the carrier\'s, and for a number that is not E.164', async () => {
    const w = workspace();
    const prompt = scripted(['2', '2', 'not-a-token', TWILIO_TOKEN, '5', '555-0123', '+15555550123']);
    const o = io(w.root, prompt);
    expect(await runSetup([], o)).toBe(0);
    const env = settings(join(w.dir('alpha'), '.env'));
    expect(env).toMatchObject({ VOICE_PROVIDERS: 'twilio', TWILIO_AUTH_TOKEN: TWILIO_TOKEN, JEV_CLIENT: 'heuristic', HANDOFF_NUMBER: '+15555550123' });
    expect(o.lines.join('\n')).toContain('a Twilio auth token is 32 hexadecimal characters; that was 11');
    expect(o.lines.join('\n')).toContain('HANDOFF_NUMBER must be an E.164 number like +15551234567');
    expect(o.lines.join('\n')).not.toContain('not-a-token');
  });

  it('writes a laptop with no keys: the web chat on, the app understanding by its examples', async () => {
    const w = workspace();
    const o = io(w.root, scripted(['1', '']));
    expect(await runSetup([], o)).toBe(0);
    const env = settings(join(w.dir('alpha'), '.env'));
    expect(env).toMatchObject({
      PUBLIC_HOST: 'localhost',
      VOICE_PROVIDERS: 'none',
      HANDOFF_NUMBER: '+15555550123',
      JEV_CLIENT: 'heuristic',
      CHAT: 'on',
      CHAT_ALLOWED_ORIGINS: 'http://localhost:3000',
    });
    // No phone line, so no carrier's secret: nothing public reaches a laptop.
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(env.SIGNATURE_CHECK).toBeUndefined();
    expect(o.lines.join('\n')).toContain('http://localhost:3000/dashboard');
    expect(o.lines.join('\n')).toContain('pnpm --filter @example/alpha cli --client heuristic');
  });

  it('refuses to replace a settings file without --force, before asking anything, and replaces it with it', async () => {
    const w = workspace();
    const file = join(w.dir('alpha'), '.env');
    writeFileSync(file, 'PORT=1\n');
    chmodSync(file, 0o644);
    const refused = io(w.root, scripted([]));
    expect(await runSetup([], refused)).toBe(1);
    expect(refused.lines.join('\n')).toContain(`${file} exists: pnpm configure --force replaces it (keep a copy of its keys first)`);
    expect(readFileSync(file, 'utf8')).toBe('PORT=1\n');
    expect(await runSetup(['--force'], io(w.root, scripted(['1', ''])))).toBe(0);
    expect(settings(file).PUBLIC_HOST).toBe('localhost');
    expect(mode(file)).toBe(0o600);
  });

  it('says to make an app first when there is none', async () => {
    const w = workspace([]);
    const o = io(w.root, scripted([]));
    expect(await runSetup([], o)).toBe(1);
    expect(o.lines.join('\n')).toContain('no app in this workspace yet: make one with pnpm create-app <name>');
  });
});

describe('pnpm configure, a decision model and no phone line (to record the app)', () => {
  it('asks for the model and its key with the echo off, writes the laptop with the model in place of the examples, and prints the recording command', async () => {
    const w = workspace();
    // a model, no phone line; TypeSafe and its key; the handoff number's default
    const prompt = scripted(['3', '1', MODEL_KEY, '']);
    const o = io(w.root, prompt);
    expect(await runSetup([], o)).toBe(0);
    const file = join(w.dir('alpha'), '.env');
    expect(mode(file)).toBe(0o600);
    const env = settings(file);
    expect(env).toMatchObject({ PUBLIC_HOST: 'localhost', HANDOFF_NUMBER: '+15555550123', JEV_CLIENT: 'jev', JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: MODEL_KEY, CHAT: 'on' });
    // No carrier: no phone line on a laptop.
    expect(env.VOICE_PROVIDERS).toBe('none');
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(env.TELNYX_PUBLIC_KEY).toBeUndefined();
    expect(prompt.asked.filter((a) => a.secret).map((a) => a.question)).toEqual([expect.stringContaining('TypeSafe key')]);
    // The model's question offers no "none": this mode is for a model.
    expect(o.lines.some((l) => l.includes('none for now'))).toBe(false);
    const said = o.lines.join('\n');
    expect(said).not.toContain(MODEL_KEY);
    expect(said).toContain('TYPESAFE_API_KEY set');
    expect(said).toContain('config loads');
    expect(said).toContain('pnpm --filter @example/alpha regress --client record --threshold JEV_TIMEOUT_MS=15000');
    expect(said).toContain('pnpm --filter @example/alpha regress --client recorded');
    expect(said).not.toContain('--client heuristic');
  });

  it('takes --mode model with flags alone, the key from its variable, and refuses --model none', async () => {
    const w = workspace();
    const run = async (argv: string[], env: Record<string, string> = {}) => {
      const o = io(w.root, null, env);
      const code = await runSetup(argv, o);
      return { code, said: o.lines.join('\n') };
    };
    const base = ['--app', 'alpha', '--mode', 'model', '--non-interactive'];
    expect(await run(base)).toEqual({ code: 2, said: expect.stringContaining('--model is needed with --non-interactive (typesafe, openrouter, vercel, custom)') });
    expect(await run([...base, '--model', 'none'])).toEqual({ code: 2, said: expect.stringContaining('--model none goes with --mode try or phone') });
    expect(await run([...base, '--model', 'openrouter'])).toEqual({ code: 2, said: expect.stringContaining('OPENROUTER_API_KEY is needed in the environment with --non-interactive (a key is never a flag)') });
    const ok = await run([...base, '--model', 'openrouter'], { OPENROUTER_API_KEY: MODEL_KEY });
    expect(ok.code).toBe(0);
    expect(settings(join(w.dir('alpha'), '.env'))).toMatchObject({ JEV_CLIENT: 'jev', JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: MODEL_KEY, PUBLIC_HOST: 'localhost' });
    expect(ok.said).not.toContain(MODEL_KEY);
  });

  it('keeps the model key of the .env it replaces when a phone line is added with --force and the same provider, and asks for another provider\'s', async () => {
    const w = workspace();
    const file = join(w.dir('alpha'), '.env');
    expect(await runSetup(['--app', 'alpha', '--mode', 'model', '--model', 'typesafe', '--non-interactive'], io(w.root, null, { TYPESAFE_API_KEY: MODEL_KEY }))).toBe(0);
    const phone = ['--app', 'alpha', '--mode', 'phone', '--carrier', 'twilio', '--handoff', '+15555550123', '--non-interactive', '--force'];
    const same = io(w.root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN });
    expect(await runSetup([...phone, '--model', 'typesafe'], same)).toBe(0);
    expect(settings(file)).toMatchObject({ VOICE_PROVIDERS: 'twilio', TWILIO_AUTH_TOKEN: TWILIO_TOKEN, JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: MODEL_KEY });
    expect(same.lines.join('\n')).toContain(`TYPESAFE_API_KEY kept from the .env it replaces (${MODEL_KEY.length} chars)`);
    expect(same.lines.join('\n')).not.toContain(MODEL_KEY);
    // Another provider's key is not in the old file: it is needed, as ever.
    const other = io(w.root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN });
    expect(await runSetup([...phone, '--model', 'openrouter'], other)).toBe(2);
    expect(other.lines.join('\n')).toContain('OPENROUTER_API_KEY is needed in the environment');
    // Asked at a terminal, the kept key is not asked for again.
    const prompt = scripted(['2', '2', TWILIO_TOKEN, '1', '+15555550123']);
    expect(await runSetup(['--force'], io(w.root, prompt))).toBe(0);
    expect(prompt.asked.filter((a) => a.secret).map((a) => a.question)).toEqual([expect.stringContaining('Twilio auth token')]);
    expect(settings(file).TYPESAFE_API_KEY).toBe(MODEL_KEY);
  });
});

describe('pnpm configure with flags alone', () => {
  it('takes every answer from a flag, and each key from the environment variable of its name, never from a flag', async () => {
    const w = workspace(['alpha', 'beta']);
    const o = io(w.root, null, { TELNYX_PUBLIC_KEY: TELNYX_KEY, TYPESAFE_API_KEY: MODEL_KEY });
    const argv = ['--app', 'alpha', '--mode', 'phone', '--carrier', 'telnyx', '--model', 'typesafe', '--handoff', '+15555550123', '--public-host', 'ivr.example.com', '--port', '3200', '--non-interactive'];
    expect(await runSetup(argv, o)).toBe(0);
    const file = join(w.dir('alpha'), '.env');
    expect(settings(file)).toMatchObject({ PUBLIC_HOST: 'ivr.example.com', PORT: '3200', TELNYX_PUBLIC_KEY: TELNYX_KEY, JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: MODEL_KEY });
    const said = o.lines.join('\n');
    expect(said).toContain('TELNYX_PUBLIC_KEY from the environment (44 chars)');
    expect(said).toContain('https://ivr.example.com/voice/telnyx');
    expect(said).not.toContain(MODEL_KEY);
  });

  it('asks for the numbers app.yaml names (its transfer targets, a number callers dial), each checked, Enter a 555 number on a laptop', async () => {
    const w = workspace();
    writeFileSync(join(w.dir('alpha'), 'app.yaml'), [
      'id: alpha',
      'startParameters:',
      '  brand: env.BRAND_CODE',
      'transfer:',
      '  targets:',
      '    - when: { called: env.SALES_LINE }',
      '      to: env.SALES_DESK',
      '    - when: { reason: urgent }',
      '      to: env.HANDOFF_NUMBER',
      '  default: env.STUDIO_MAIN_LINE',
      '  send:',
      '    headers:',
      '      X-Desk: env.DESK_CODE',
      '',
    ].join('\n'));
    // A laptop: the handoff number by Enter; SALES_LINE not E.164 then by Enter; SALES_DESK a sip: URI; STUDIO_MAIN_LINE from the environment.
    const prompt = scripted(['1', '', '555-0100', '', 'sip:desk@pbx.example.com']);
    const o = io(w.root, prompt, { STUDIO_MAIN_LINE: '+15555550177' });
    expect(await runSetup([], o)).toBe(0);
    const file = join(w.dir('alpha'), '.env');
    expect(settings(file)).toMatchObject({ HANDOFF_NUMBER: '+15555550123', SALES_LINE: '+15555550100', SALES_DESK: 'sip:desk@pbx.example.com', STUDIO_MAIN_LINE: '+15555550177' });
    expect(settings(file).BRAND_CODE).toBeUndefined();
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\n# BRAND_CODE=\n');
    // A value under transfer that is no target (a header sent with it) is not taken for a number.
    expect(text).toContain('\n# DESK_CODE=\n');
    expect(text).toContain("# The other values alpha's YAML names (app.yaml's startParameters.brand, app.yaml's transfer.send.headers.X-Desk): set each; the server will not start without them.");
    expect(prompt.asked.map((a) => a.question).slice(2)).toEqual([
      "SALES_LINE, a number callers dial (E.164), as app.yaml's transfer.targets.0.when.called names it (Enter for +15555550100, which goes nowhere):",
      "SALES_LINE, a number callers dial (E.164), as app.yaml's transfer.targets.0.when.called names it (Enter for +15555550100, which goes nowhere):",
      "SALES_DESK, where a call is put through (E.164, or a sip: URI), as app.yaml's transfer.targets.0.to names it (Enter for +15555550101, which goes nowhere):",
    ]);
    expect(prompt.asked.every((a) => !a.secret)).toBe(true);
    const said = o.lines.join('\n');
    expect(said).toContain('SALES_LINE must be an E.164 number like +15551234567');
    expect(said).toContain('STUDIO_MAIN_LINE from the environment: +15555550177');
    expect(said).toContain('  STUDIO_MAIN_LINE=+15555550177');
  });

  it('takes the numbers from --number with --non-interactive: on a laptop each left out is a 555 number, on a phone line each is needed', async () => {
    const w = workspace();
    writeFileSync(join(w.dir('alpha'), 'app.yaml'), 'id: alpha\ntransfer:\n  default: env.STUDIO_MAIN_LINE\n');
    const laptop = io(w.root, null);
    expect(await runSetup(['--mode', 'try', '--non-interactive'], laptop)).toBe(0);
    expect(settings(join(w.dir('alpha'), '.env')).STUDIO_MAIN_LINE).toBe('+15555550100');
    // A fresh phone line: no .env to keep a number from.
    rmSync(join(w.dir('alpha'), '.env'));
    const base = ['--force', '--mode', 'phone', '--carrier', 'twilio', '--model', 'none', '--handoff', '+15555550123', '--non-interactive'];
    const run = async (argv: string[]) => {
      const o = io(w.root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN });
      const code = await runSetup(argv, o);
      return { code, said: o.lines.join('\n') };
    };
    expect(await run(base)).toEqual({ code: 2, said: expect.stringContaining('--number STUDIO_MAIN_LINE=<number> is needed with --non-interactive') });
    expect(await run([...base, '--number', 'STUDIO_MAIN_LINE=555'])).toEqual({ code: 2, said: expect.stringContaining('STUDIO_MAIN_LINE is neither an E.164 number') });
    expect(await run([...base, '--number', 'OTHER_LINE=+15555550177'])).toEqual({ code: 2, said: expect.stringContaining("--number OTHER_LINE=...: alpha's YAML names no number OTHER_LINE (it names STUDIO_MAIN_LINE)") });
    expect(await run([...base, '--number', 'lower=+1'])).toEqual({ code: 2, said: expect.stringContaining('--number must be <NAME>=<number>') });
    expect((await run([...base, '--number', 'STUDIO_MAIN_LINE=+15555550177'])).code).toBe(0);
    expect(settings(join(w.dir('alpha'), '.env')).STUDIO_MAIN_LINE).toBe('+15555550177');
    // Run again with --force: the number the .env it replaces holds is kept, so no --number is needed.
    const again = await run(base);
    expect(again.code).toBe(0);
    expect(again.said).toContain('STUDIO_MAIN_LINE kept from the .env it replaces: +15555550177');
    expect(settings(join(w.dir('alpha'), '.env')).STUDIO_MAIN_LINE).toBe('+15555550177');
    // Asked at a terminal, it is the default Enter takes.
    const prompt = scripted(['']);
    expect(await runSetup(base.filter((a) => a !== '--non-interactive'), io(w.root, prompt, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN }))).toBe(0);
    expect(prompt.asked.map((q) => q.question)).toEqual(["STUDIO_MAIN_LINE, where a call is put through (E.164, or a sip: URI), as app.yaml's transfer.default names it (Enter for +15555550177, from the .env it replaces):"]);
    expect(settings(join(w.dir('alpha'), '.env')).STUDIO_MAIN_LINE).toBe('+15555550177');
  });

  it('names the flag or the variable that is missing', async () => {
    const w = workspace();
    const base = ['--app', 'alpha', '--mode', 'phone', '--non-interactive'];
    const run = async (argv: string[], env: Record<string, string> = {}) => {
      const o = io(w.root, null, env);
      const code = await runSetup(argv, o);
      return { code, said: o.lines.join('\n') };
    };
    expect(await run([...base])).toEqual({ code: 2, said: expect.stringContaining('--carrier is needed with --non-interactive (telnyx or twilio)') });
    expect(await run([...base, '--carrier', 'twilio'])).toEqual({ code: 2, said: expect.stringContaining('TWILIO_AUTH_TOKEN is needed in the environment with --non-interactive (a key is never a flag)') });
    expect(await run(['--app', 'alpha', '--carrier', 'fax', '--non-interactive'])).toEqual({ code: 2, said: expect.stringContaining('--carrier must be telnyx or twilio, got "fax"') });
  });

  it('writes a compatible endpoint with its URL and model, and no key when it needs none', async () => {
    const w = workspace();
    const argv = ['--app', 'alpha', '--mode', 'phone', '--carrier', 'twilio', '--model', 'custom', '--base-url', 'http://localhost:8000', '--model-id', 'example-local-model', '--handoff', '+15555550123', '--non-interactive'];
    expect(await runSetup(argv, io(w.root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN }))).toBe(0);
    const env = settings(join(w.dir('alpha'), '.env'));
    expect(env).toMatchObject({ JEV_CLIENT: 'jev', JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://localhost:8000', JEV_MODEL: 'example-local-model' });
    expect(env.JEV_API_KEY).toBeUndefined();
    const bad = io(w.root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN });
    expect(await runSetup([...argv.filter((a) => a !== 'http://localhost:8000' && a !== '--base-url'), '--base-url', 'http://jev.example.com', '--force'], bad)).toBe(2);
    expect(bad.lines.join('\n')).toContain('JEV_BASE_URL must be https unless its host is localhost');
  });
});

/**
 * What a shell reads from a settings file: `set -a; . ./file; set +a`, as the README's recording steps
 * source it, then each variable named, as JSON. HOME is set, so a `~` the shell expanded would show.
 */
function sourced(file: string, names: readonly string[]): Record<string, string | undefined> {
  const script = `set -a; . "$1"; set +a; shift; exec "$NODE" -e 'const o={};for(const n of process.argv.slice(1))o[n]=process.env[n];process.stdout.write(JSON.stringify(o))' "$@"`;
  const out = execFileSync('/bin/sh', ['-c', script, 'sh', file, ...names], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/example', NODE: process.execPath },
    encoding: 'utf8',
  });
  return JSON.parse(out) as Record<string, string | undefined>;
}

describe('the settings file, read alike by a shell and by the server', () => {
  const TRICKY = [
    'plain', '', 'two words', 'speaker-events tokens-played', '$HOME', 'a#b', '#lead', '~/x', 'a:~/b', 'semi;colon', 'and&', 'pipe|',
    'glob*?', '[x]', '(paren)', '<in>', 'bang!', 'tab\there', ' padded ', 'say "hi"', 'back\\slash', 'tick`s`', "it's", "it's (fine)",
    'naïve café', 'x=y', 'a,b:c@d%e+f',
  ];

  it('writes each value so that sh and parseEnv both read the value itself, or refuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'configure-sh-'));
    dirs.push(dir);
    const lines: string[] = [];
    const written: Record<string, string> = {};
    TRICKY.forEach((value, i) => {
      lines.push(envLine(`V${i}`, value));
      written[`V${i}`] = value;
    });
    const file = join(dir, '.env');
    writeFileSync(file, `# a comment with a ' in it\n${lines.join('\n')}\n`);
    expect(sourced(file, Object.keys(written))).toEqual(written);
    expect(parseEnv(readFileSync(file, 'utf8'))).toEqual(written);
    // A bare ~ would be the shell's home; it is quoted instead.
    expect(envLine('V', '~/x')).toBe("V='~/x'");
    expect(envLine('V', "it's")).toBe('V="it\'s"');
  });

  it("refuses a value no quoting reads alike, and a line break, naming the variable and never the value", () => {
    for (const value of [`it's $HOME`, `it's "quoted"`, "it's \\", "it's `x`"]) {
      expect(() => envLine('JEV_API_KEY', value), value).toThrow(/^JEV_API_KEY cannot be written so that a shell and the server read it alike/);
    }
    expect(() => envLine('JEV_API_KEY', 'a\nb')).toThrow('JEV_API_KEY cannot hold a line break');
  });

  it('writes files a shell sources, as the server reads them: a laptop under a folder with a space in its name, and a key with a quote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'configure with space-'));
    dirs.push(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    mkdirSync(join(root, 'apps', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'apps', 'alpha', 'package.json'), JSON.stringify({ name: '@example/alpha', scripts: { serve: 'tsx src/serve.ts' } }));
    writeFileSync(join(root, 'apps', 'alpha', 'app.yaml'), 'id: alpha\n');
    // The widget's script, so its path (with the space) is written uncommented.
    mkdirSync(join(root, 'packages', 'widget', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'widget', 'dist', 'dialogwright-widget.js'), '');
    const file = join(root, 'apps', 'alpha', '.env');
    expect(await runSetup(['--app', 'alpha', '--mode', 'try', '--non-interactive'], io(root, null))).toBe(0);
    const laptop = settings(file);
    expect(laptop.WIDGET_FILE).toContain('configure with space-');
    expect(sourced(file, Object.keys(laptop))).toEqual(laptop);

    const key = "made-up key with a ' in it";
    const argv = ['--app', 'alpha', '--mode', 'phone', '--carrier', 'twilio', '--model', 'custom', '--base-url', 'http://localhost:8000', '--model-id', 'example local model', '--handoff', '+15555550123', '--force', '--non-interactive'];
    expect(await runSetup(argv, io(root, null, { TWILIO_AUTH_TOKEN: TWILIO_TOKEN, JEV_API_KEY: key }))).toBe(0);
    const phone = settings(file);
    expect(phone).toMatchObject({ JEV_API_KEY: key, JEV_MODEL: 'example local model' });
    expect(sourced(file, Object.keys(phone))).toEqual(phone);
  });
});

describe('linePrompt', () => {
  it('does not echo a key typed at a terminal, and echoes an ordinary answer', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    let shown = '';
    const output = new PassThrough();
    output.on('data', (d: Buffer) => (shown += d.toString('utf8')));
    const prompt = linePrompt(input, output);
    const plain = prompt.ask('Your name:');
    input.write('alex\r');
    expect(await plain).toBe('alex');
    const secret = prompt.ask('Key (not shown):', { secret: true });
    input.write('hunter2-made-up\r');
    expect(await secret).toBe('hunter2-made-up');
    prompt.close?.();
    expect(shown).toContain('Your name:');
    expect(shown).toContain('alex');
    expect(shown).toContain('Key (not shown):');
    expect(shown).not.toContain('hunter2');
  });

  it('keeps no history a later question could bring a key back from (the up arrow)', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    let shown = '';
    const output = new PassThrough();
    output.on('data', (d: Buffer) => (shown += d.toString('utf8')));
    const prompt = linePrompt(input, output);
    const secret = prompt.ask('Key (not shown):', { secret: true });
    input.write('hunter2-made-up\r');
    await secret;
    const next = prompt.ask('Number:');
    input.write('\u001b[A');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\r');
    await next;
    prompt.close?.();
    expect(shown).not.toContain('hunter2');
  });

  it('reads answers piped in all at once, one per question', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = linePrompt(input, output);
    input.end('1\n2\n');
    expect(await prompt.ask('first?')).toBe('1');
    expect(await prompt.ask('second?', { secret: true })).toBe('2');
    await expect(prompt.ask('third?')).rejects.toThrow('no answer: the input ended');
  });
});

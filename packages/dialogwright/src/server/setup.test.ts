import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseEnv } from 'node:util';
import { linePrompt, runSetup, type Prompt, type SetupIo } from './setup';

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
    });
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
      VOICE_PROVIDERS: 'twilio',
      SIGNATURE_CHECK: 'on',
      HANDOFF_NUMBER: '+15555550123',
      JEV_CLIENT: 'heuristic',
      CHAT: 'on',
      CHAT_ALLOWED_ORIGINS: 'http://localhost:3000',
    });
    // A carrier secret the laptop never uses, since nothing public reaches it.
    expect(env.TWILIO_AUTH_TOKEN).toBe('not-used-on-a-laptop');
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

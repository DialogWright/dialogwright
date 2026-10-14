import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { envFileNames, envFilePathsOf, harnessEnvFilePath, harnessEnvFilePaths, joinEnvFiles, loadHarnessEnv, readEnvFile, readEnvFiles, resolveEnvFiles } from './envFile';

/** The settings file's loader (envFile.ts): quotes are taken as dotenv takes them, so a file can be quoted for a shell too. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fileWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'envfile-'));
  dirs.push(dir);
  const path = join(dir, 'app.env');
  writeFileSync(path, text);
  return path;
}

describe('readEnvFile', () => {
  it('reads a quoted value with a space without its quotes, as it reads the same value bare', () => {
    const vars = readEnvFile(fileWith('TELNYX_EVENTS="speaker-events tokens-played"\nOTHER=speaker-events tokens-played\nSINGLE=\'a b\'\n'));
    expect(vars.TELNYX_EVENTS).toBe('speaker-events tokens-played');
    expect(vars.OTHER).toBe('speaker-events tokens-played');
    expect(vars.SINGLE).toBe('a b');
  });

  it('gives the config the event streams of a quoted TELNYX_EVENTS', () => {
    const vars = readEnvFile(fileWith('TELNYX_EVENTS="speaker-events tokens-played"\n'));
    const config = loadConfig({ PUBLIC_HOST: 'voice.example.com', HANDOFF_NUMBER: '+15555550100', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=', ...vars });
    expect(config.telnyxEvents).toBe('speaker-events tokens-played');
  });
});

describe('loadHarnessEnv: the settings regress, the cli and the trim read', () => {
  function appDir(env?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-env-'));
    dirs.push(dir);
    if (env !== undefined) writeFileSync(join(dir, '.env'), env);
    return dir;
  }

  it("reads the app's own .env in the folder it runs in, a variable already in the environment winning, and never says a value", () => {
    const dir = appDir("JEV_PROVIDER=openrouter\nOPENROUTER_API_KEY='made-up key for this test'\nJEV_MODEL=from-the-file\n");
    const env: Record<string, string | undefined> = { JEV_MODEL: 'from-the-environment' };
    const said = loadHarnessEnv(env, dir);
    expect(env).toEqual({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'made-up key for this test', JEV_MODEL: 'from-the-environment' });
    expect(said).toBe(`settings from ${join(dir, '.env')} (2 set, 1 already in the environment, which wins)`);
    expect(said).not.toContain('made-up');
  });

  it('reads the file ENV_FILE names instead, relative to where the command was run (INIT_CWD)', () => {
    const dir = appDir('JEV_MODEL=from-the-app\n');
    const elsewhere = appDir();
    writeFileSync(join(elsewhere, 'other.env'), 'JEV_MODEL=from-elsewhere\n');
    const env: Record<string, string | undefined> = { ENV_FILE: 'other.env', INIT_CWD: elsewhere };
    expect(harnessEnvFilePath(env, dir)).toBe(join(elsewhere, 'other.env'));
    expect(loadHarnessEnv(env, dir)).toBe(`settings from ${join(elsewhere, 'other.env')} (1 set)`);
    expect(env.JEV_MODEL).toBe('from-elsewhere');
  });

  it('reads nothing when there is no .env and ENV_FILE is unset, and refuses an ENV_FILE that is not there', () => {
    const dir = appDir();
    const env: Record<string, string | undefined> = {};
    expect(loadHarnessEnv(env, dir)).toBeNull();
    expect(env).toEqual({});
    expect(() => loadHarnessEnv({ ENV_FILE: join(dir, 'missing.env') }, dir)).toThrow(`ENV_FILE does not exist: ${join(dir, 'missing.env')}`);
  });
});

describe('ENV_FILE naming several files (the secretary demo, live findings, item 20)', () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'env-files-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it('splits on commas, trims each and leaves out empty ones, resolving each from where the command was run', () => {
    expect(envFileNames(' a.env , ,/abs/b.env,')).toEqual(['a.env', '/abs/b.env']);
    expect(envFilePathsOf([], { ENV_FILE: 'a.env,/abs/b.env', INIT_CWD: '/here' }, '/elsewhere')).toEqual(['/here/a.env', '/abs/b.env']);
    expect(envFilePathsOf(['--env-file', 'c.env,d.env'], { ENV_FILE: 'a.env' }, '/x')).toEqual(['/x/c.env', '/x/d.env']);
    expect(envFilePathsOf([], { ENV_FILE: ' , ' }, '/x')).toBeNull();
    expect(joinEnvFiles(['/a/x.env', '/b/y.env'])).toBe('/a/x.env,/b/y.env');
    // A shell expands ~ at the start of the value only: one after a comma is the home folder here.
    expect(resolveEnvFiles('a.env,~/keys/render.env', '/here', '/home/someone')).toEqual(['/here/a.env', '/home/someone/keys/render.env']);
  });

  it('reads each in turn, a later file winning over an earlier one, and the environment over them all', () => {
    const dir = dirWith({ 'app.env': 'JEV_MODEL=from-app\nRENDER_PROVIDER=openrouter\nPORT=3000\n', 'render.env': "RENDER_PROVIDER=anthropic\nANTHROPIC_API_KEY='made-up key for this test'\n" });
    expect(readEnvFiles([join(dir, 'app.env'), join(dir, 'render.env')])).toEqual({ JEV_MODEL: 'from-app', RENDER_PROVIDER: 'anthropic', PORT: '3000', ANTHROPIC_API_KEY: 'made-up key for this test' });
    const env: Record<string, string | undefined> = { ENV_FILE: 'app.env,render.env', INIT_CWD: dir, PORT: '3001' };
    const said = loadHarnessEnv(env, '/nowhere');
    expect(env).toMatchObject({ JEV_MODEL: 'from-app', RENDER_PROVIDER: 'anthropic', PORT: '3001', ANTHROPIC_API_KEY: 'made-up key for this test' });
    expect(said).toBe(`settings from ${join(dir, 'app.env')}, ${join(dir, 'render.env')} (3 set, 1 already in the environment, which wins)`);
    expect(said).not.toContain('made-up');
    expect(harnessEnvFilePaths({ ENV_FILE: 'app.env,render.env', INIT_CWD: dir }, '/nowhere')).toEqual([join(dir, 'app.env'), join(dir, 'render.env')]);
  });

  it('refuses a list with a file that is not there, naming it', () => {
    const dir = dirWith({ 'app.env': 'PORT=3000\n' });
    expect(() => loadHarnessEnv({ ENV_FILE: `app.env,missing.env`, INIT_CWD: dir }, dir)).toThrow(`ENV_FILE does not exist: ${join(dir, 'missing.env')}`);
  });
});

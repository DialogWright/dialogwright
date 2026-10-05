import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { readEnvFile } from './envFile';

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

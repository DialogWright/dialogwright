import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { ConsoleAuth, type LinkFile } from './auth';
import { LINK_USAGE, main } from './linkCli';

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SETTINGS = 'PUBLIC_HOST=demo.example.net\nTWILIO_AUTH_TOKEN=t\nHANDOFF_NUMBER=+15551234567\n';

/** A folder with a settings file, and (unless `serve` is false) a server in token mode whose link file it names. */
async function setup(extra = 'CONSOLE_AUTH=token\n', serve = true) {
  const dir = mkdtempSync(join(tmpdir(), 'console-link-'));
  dirs.push(dir);
  const linkFile = join(dir, '.console-link', 'link.json');
  const envFile = join(dir, '.env');
  writeFileSync(envFile, `${SETTINGS}TRACE_DIR=${join(dir, 'traces')}\n${extra}`, { mode: 0o600 });
  let auth: ConsoleAuth | null = null;
  if (serve) {
    const config = loadConfig({ PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', CONSOLE_AUTH: 'token', CONSOLE_LINK_FILE: linkFile });
    const made = new ConsoleAuth({ settings: config.consoleAuth!, publicHost: 'demo.example.net' });
    auth = made;
    server = createServer((req, res) => {
      if (!made.handle(req, res, (req.url ?? '/').split('?')[0]!)) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    made.start((server.address() as { port: number }).port);
  }
  const out: string[] = [];
  const run = (argv: string[] = [], env: Record<string, string> = {}) => main(argv, { out: (l) => out.push(l), env: { ENV_FILE: envFile, ...env }, invokedFrom: dir, root: dir });
  return { dir, linkFile, envFile, auth, out, run };
}

describe('pnpm console:link', () => {
  it('prints a new sign-in link, and the one the file held stops working', async () => {
    const s = await setup();
    const before = JSON.parse(readFileSync(s.linkFile, 'utf8')) as LinkFile;
    expect(await s.run()).toBe(0);
    const printed = s.out.find((l) => l.startsWith('https://'))!;
    expect(printed).toMatch(/^https:\/\/demo\.example\.net\/dashboard\/login\?code=[0-9a-f]{64}$/);
    expect(printed).not.toBe(before.url);
    expect(s.out.join('\n')).toMatch(/works once, for 10 minutes/);
    expect((JSON.parse(readFileSync(s.linkFile, 'utf8')) as LinkFile).url).toBe(printed);
  });

  it('says there is nothing to sign in to with CONSOLE_AUTH=local', async () => {
    const s = await setup('', false);
    expect(await s.run()).toBe(1);
    expect(s.out.join('\n')).toContain('CONSOLE_AUTH is local: the console needs no link; open http://localhost:3000/dashboard on this machine');
  });

  it('says to start the server when there is no link file', async () => {
    const s = await setup('CONSOLE_AUTH=token\n', false);
    expect(await s.run()).toBe(1);
    expect(s.out.join('\n')).toContain(`no sign-in link file at ${s.linkFile}: start the server with CONSOLE_AUTH=token (pnpm start), which writes it`);
  });

  it('says the server is not answering when the file is from a server that has stopped', async () => {
    const s = await setup();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    expect(await s.run()).toBe(1);
    expect(s.out.join('\n')).toMatch(/the server is not answering on port \d+: is it running\?/);
  });

  it('trusts no link file that others can read or write', async () => {
    if (process.platform === 'win32') return;
    const s = await setup();
    chmodSync(s.linkFile, 0o644);
    expect(await s.run()).toBe(1);
    expect(s.out.join('\n')).toContain(`${s.linkFile} can be read by others (mode 644): it holds the key that makes sign-in links; chmod 600 ${s.linkFile}`);
  });

  it('says what the server said when it refuses the key', async () => {
    const s = await setup();
    const file = JSON.parse(readFileSync(s.linkFile, 'utf8')) as LinkFile;
    writeFileSync(s.linkFile, JSON.stringify({ ...file, key: 'f'.repeat(64) }), { mode: 0o600 });
    expect(await s.run()).toBe(1);
    expect(s.out.join('\n')).toContain('the server refused the link file\'s key: the file is from an earlier run; restart the server');
  });

  it('finds the link file where CONSOLE_LINK_FILE names it, from the app\'s folder', async () => {
    const s = await setup();
    const elsewhere = join(s.dir, 'private');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, 'link.json'), readFileSync(s.linkFile), { mode: 0o600 });
    rmSync(s.linkFile);
    expect(await s.run([], { CONSOLE_LINK_FILE: 'private/link.json' })).toBe(0);
  });

  it('is the workspace\'s pnpm console:link', () => {
    const root = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts['console:link']).toBe('tsx packages/dialogwright/src/server/console/linkCli.ts');
  });

  it('answers a command line it does not understand with its usage', async () => {
    const s = await setup('', false);
    expect(await s.run(['--rotate'])).toBe(2);
    expect(s.out).toEqual([LINK_USAGE]);
  });
});

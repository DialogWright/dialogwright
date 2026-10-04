import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, renderService, servicePath, type ServiceInputs } from './serviceFile';

/** `pnpm service` (serviceFile.ts): the files it writes for fixed inputs, word for word, and the command around them. */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INPUTS: Omit<ServiceInputs, 'kind'> = {
  label: 'com.example.ivr',
  app: '@dialogwright/example-myline',
  root: '/Users/alex/dialogwright',
  envFile: '/Users/alex/ivr/myline.env',
  pnpm: '/opt/homebrew/bin/pnpm',
  path: '/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin',
  logDir: '/Users/alex/Library/Logs/com.example.ivr',
  stopSeconds: 40,
};

const LAUNCHD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by pnpm service: the DialogWright app @dialogwright/example-myline, run from the repository with its settings file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.ivr</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/pnpm</string>
    <string>--filter</string>
    <string>@dialogwright/example-myline</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/alex/dialogwright</string>
  <!-- The server reads the settings file itself (ENV_FILE). launchd starts with a short PATH: these hold node and pnpm. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENV_FILE</key>
    <string>/Users/alex/ivr/myline.env</string>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>COREPACK_ENABLE_DOWNLOAD_PROMPT</key>
    <string>0</string>
  </dict>
  <!-- Start when loaded, and again whenever it exits, at most once every 10 seconds. -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <!-- On stop: SIGTERM, which starts the drain, then this many seconds (DRAIN_MS and 10 more) before SIGKILL. -->
  <key>ExitTimeOut</key>
  <integer>40</integer>
  <key>StandardOutPath</key>
  <string>/Users/alex/Library/Logs/com.example.ivr/out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/alex/Library/Logs/com.example.ivr/err.log</string>
</dict>
</plist>
`;

const SYSTEMD = `# Written by pnpm service: the DialogWright app @dialogwright/example-myline, run from the repository with its settings file.
[Unit]
Description=DialogWright: @dialogwright/example-myline
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/Users/alex/dialogwright
# The server reads the settings file itself (ENV_FILE), as pnpm start and pnpm diagnose do.
Environment="ENV_FILE=/Users/alex/ivr/myline.env"
Environment="PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin"
Environment="COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
ExecStart=/opt/homebrew/bin/pnpm --filter @dialogwright/example-myline serve
Restart=always
RestartSec=10
# On stop: SIGTERM to pnpm, which passes it to the server and waits while it drains; the rest of
# the service gets SIGKILL only if it is still there after TimeoutStopSec (DRAIN_MS and 10 more).
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=40

[Install]
WantedBy=default.target
`;

/** A small XML reader: the elements nest and close, and a plist dict holds a value after each key. */
function wellFormed(xml: string): { ok: boolean; why?: string; keys: string[] } {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack: string[] = [];
  const keys: string[] = [];
  const tags = /<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let lastKey: string | null = null;
  while ((m = tags.exec(body)) !== null) {
    if (m[5] !== undefined) {
      if (/[<>]/.test(m[5]) || (/&/.test(m[5]) && !/&(amp|lt|gt|quot|apos);/.test(m[5]))) return { ok: false, why: `bad text ${m[5]}`, keys };
      if (stack.at(-1) === 'key') lastKey = m[5];
      continue;
    }
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      if (stack.pop() !== name) return { ok: false, why: `</${name}> closes nothing open`, keys };
      if (name === 'key' && lastKey !== null) keys.push(lastKey);
    } else if (!selfClosing) stack.push(name!);
  }
  return stack.length === 0 ? { ok: true, keys } : { ok: false, why: `unclosed ${stack.join(', ')}`, keys };
}

describe('the service files', () => {
  it('writes the launchd agent for fixed inputs, word for word, as valid XML', () => {
    const plist = renderService({ kind: 'launchd', ...INPUTS });
    expect(plist).toBe(LAUNCHD);
    const parsed = wellFormed(plist);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.keys).toEqual(expect.arrayContaining(['Label', 'ProgramArguments', 'WorkingDirectory', 'EnvironmentVariables', 'ENV_FILE', 'KeepAlive', 'RunAtLoad', 'ProcessType', 'ExitTimeOut', 'StandardOutPath', 'StandardErrorPath']));
  });

  it('writes the systemd unit for fixed inputs, word for word', () => {
    expect(renderService({ kind: 'systemd', ...INPUTS })).toBe(SYSTEMD);
  });

  it('escapes what XML and systemd would read otherwise', () => {
    const odd = { ...INPUTS, root: '/Users/alex/R&D <lines>', envFile: '/Users/alex/ivr/100% line.env' };
    const plist = renderService({ kind: 'launchd', ...odd });
    expect(wellFormed(plist).ok).toBe(true);
    expect(plist).toContain('<string>/Users/alex/R&amp;D &lt;lines&gt;</string>');
    const unit = renderService({ kind: 'systemd', ...odd });
    expect(unit).toContain('Environment="ENV_FILE=/Users/alex/ivr/100%% line.env"');
    expect(unit).toContain('WorkingDirectory=/Users/alex/R&D <lines>');
  });

  it('puts each in the place its manager reads, by label', () => {
    expect(servicePath('launchd', 'com.example.ivr', '/Users/alex')).toBe('/Users/alex/Library/LaunchAgents/com.example.ivr.plist');
    expect(servicePath('systemd', 'com.example.ivr', '/home/alex')).toBe('/home/alex/.config/systemd/user/com.example.ivr.service');
  });
});

describe('pnpm service', () => {
  function workspace(): { root: string; envFile: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), 'service-'));
    dirs.push(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    mkdirSync(join(root, 'apps', 'myline'), { recursive: true });
    writeFileSync(join(root, 'apps', 'myline', 'package.json'), JSON.stringify({ name: '@dialogwright/example-myline', scripts: { serve: 'tsx src/serve.ts' } }));
    writeFileSync(join(root, 'apps', 'myline', 'app.yaml'), 'id: myline\n');
    const envFile = join(root, 'myline.env');
    writeFileSync(envFile, 'DRAIN_MS=50000\nTELNYX_PUBLIC_KEY=not-read-into-the-file\n');
    const home = join(root, 'home');
    mkdirSync(home);
    return { root, envFile, home };
  }

  const run = async (argv: string[], w: { root: string; home: string }) => {
    const out: string[] = [];
    const code = await main(argv, {
      out: (l) => out.push(l), invokedFrom: w.root, root: w.root, home: w.home, platform: 'darwin',
      which: (c) => (c === 'pnpm' ? '/opt/homebrew/bin/pnpm' : null), nodeDir: '/opt/homebrew/opt/node@24/bin',
    });
    return { code, out: out.join('\n') };
  };

  it('writes the file with absolute paths resolved here, its stop time from DRAIN_MS, and prints the commands rather than running them', async () => {
    const w = workspace();
    const out = join(w.root, 'agent.plist');
    const r = await run(['launchd', '--app', 'myline', '--env-file', 'myline.env', '--label', 'com.example.ivr', '--out', 'agent.plist'], w);
    expect(r.code).toBe(0);
    const plist = readFileSync(out, 'utf8');
    expect(plist).toContain(`<string>${w.envFile}</string>`);
    expect(plist).toContain(`<string>${w.root}</string>`);
    expect(plist).toContain('<integer>60</integer>');
    expect(plist).toContain(`<string>${join(w.home, 'Library/Logs/com.example.ivr')}/out.log</string>`);
    expect(plist).not.toContain('not-read-into-the-file');
    for (const p of [...plist.matchAll(/<string>([^<@]*\/[^<]*)<\/string>/g)].map((m) => m[1]!)) {
      for (const part of p.split(':')) expect(isAbsolute(part), part).toBe(true);
    }
    expect(r.out).toContain(`wrote ${out}`);
    expect(r.out).toContain(`launchctl bootstrap gui/$(id -u) ${out}`);
    expect(r.out).toContain(`mkdir -p ${join(w.home, 'Library/Logs/com.example.ivr')}`);
  });

  it('writes a systemd user unit, to its usual place by default, and says how to start it at boot', async () => {
    const w = workspace();
    const r = await run(['systemd', '--app', '@dialogwright/example-myline', '--env-file', w.envFile], w);
    expect(r.code).toBe(0);
    const unit = join(w.home, '.config/systemd/user/com.dialogwright.myline.service');
    expect(existsSync(unit)).toBe(true);
    expect(readFileSync(unit, 'utf8')).toContain('TimeoutStopSec=60');
    expect(r.out).toContain('systemctl --user enable --now com.dialogwright.myline');
    expect(r.out).toContain('loginctl enable-linger');
  });

  it('needs the settings file, and one that exists', async () => {
    const w = workspace();
    expect(await run(['launchd', '--app', 'myline'], w)).toEqual({ code: 2, out: expect.stringContaining('--env-file <path> is needed: the settings file the service reads') });
    expect(await run(['launchd', '--app', 'myline', '--env-file', 'missing.env'], w)).toEqual({ code: 1, out: expect.stringContaining(`ENV_FILE does not exist: ${join(w.root, 'missing.env')}`) });
    expect(await run(['upstart', '--app', 'myline', '--env-file', w.envFile], w)).toEqual({ code: 2, out: expect.stringContaining('usage: pnpm service <launchd|systemd>') });
  });

  it('refuses to replace a file without --force', async () => {
    const w = workspace();
    const argv = ['launchd', '--app', 'myline', '--env-file', w.envFile, '--out', 'agent.plist'];
    expect((await run(argv, w)).code).toBe(0);
    const again = await run(argv, w);
    expect(again.code).toBe(1);
    expect(again.out).toContain('exists: pnpm service ... --force replaces it');
    expect((await run([...argv, '--force'], w)).code).toBe(0);
  });

  it('is a script at the repository root, with its templates beside the app templates', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.service).toBe('tsx packages/dialogwright/src/server/serviceFile.ts');
    expect(existsSync(join(ROOT, 'packages/dialogwright/templates/service/launchd.plist'))).toBe(true);
    expect(existsSync(join(ROOT, 'packages/dialogwright/templates/service/systemd.service'))).toBe(true);
  });
});

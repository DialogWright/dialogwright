import { accessSync, constants, existsSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Env, type ServerConfig } from './config';
import { readEnvFile } from './envFile';
import { isLoopbackHost } from './localOnly';
import { chooseApp, findApp, workspaceApps, WORKSPACE_ROOT, type WorkspaceApp } from './workspace';

/**
 * `[ENV_FILE=<path>] pnpm diagnose [--app <name>] [--offline]`: what is misconfigured, before a caller
 * finds out. It reads the settings the server would (the app's `.env`, or the file ENV_FILE or
 * `--env-file <path>` names, with a variable already in the environment winning, as the server takes
 * them), says whether that file is readable by its owner alone, and checks, one line each with `ok`,
 * `warn`, `fail` or `skip` and a fix:
 *
 *   1. the config loads, with the server's own messages;
 *   2. PUBLIC_HOST resolves and https://PUBLIC_HOST/health answers within five seconds (through the tunnel);
 *   3. https://PUBLIC_HOST/dashboard answers 404 (the console is not public); with CONSOLE_AUTH=token, it
 *      sends a browser with no cookie to the sign-in page (302) and the console's data answers 401;
 *   4. each enabled carrier's secret has the right shape, and signatures are checked;
 *   5. the model: which one and from where, and its key variable set (no request is made); a stub is a warning;
 *   6. HANDOFF_NUMBER is not a 555 number;
 *   7. the trace and audit folders can be written, and 8. there is more than a gigabyte free;
 *   9. this machine's clock is within a minute of another machine's: the Date that the carrier's API host
 *      (or else the model provider's) answers a HEAD with. Not PUBLIC_HOST's: through a tunnel that is
 *      this machine's own clock, passed back.
 *
 * It calls no carrier and no model: the only requests are DNS, two GETs to the server's own address
 * (three with CONSOLE_AUTH=token), and one HEAD with no key and no body to a host the setup already
 * relies on, for its clock; none with --offline (what `pnpm configure` runs). Exit 0 when nothing fails.
 */

export type CheckId = 'settings' | 'config' | 'reach' | 'console' | 'carrier' | 'model' | 'handoff' | 'folders' | 'space' | 'clock';
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  message: string;
  fix?: string;
}

/** What the checks reach outside: stubbed in tests. */
export interface DoctorDeps {
  fetch: typeof fetch;
  lookup(host: string): Promise<unknown>;
  now(): number;
  /** Bytes free to this user on the disk `dir` is on, or null when that cannot be told. */
  freeBytes(dir: string): number | null;
}

export const defaultDoctorDeps: DoctorDeps = {
  fetch: (...args) => fetch(...args),
  lookup: (host) => dnsLookup(host),
  now: () => Date.now(),
  freeBytes: (dir) => {
    try {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  },
};

export interface DoctorOptions {
  /** The settings, as the server would have them. */
  env: Env;
  /** Where the server runs (the app's folder, under `pnpm --filter`): relative TRACE_DIR and AUDIT_DIR are from here. */
  cwd: string;
  /** Ask nothing over the network (checks 2, 3 and 9 are skipped). */
  offline?: boolean;
}

/** A hostname loadConfig takes while PUBLIC_HOST waits for the quick tunnel's, shaped like one. */
const QUICK_PLACEHOLDER = 'quick-tunnel.trycloudflare.com';
const ASK_MS = 5_000;
const CLOCK_TOLERANCE_MS = 60_000;
const LOW_SPACE_BYTES = 1024 ** 3;
const UNREACHABLE = 'the carrier cannot reach this server: is the tunnel running?';
/**
 * Each carrier's public API host, asked by the clock check alone, for the Date it answers with: a HEAD
 * with no key, no body and nothing of the settings in it. The engine never calls these otherwise.
 */
export const CARRIER_CLOCK_URLS: Readonly<Record<string, string>> = {
  telnyx: 'https://api.telnyx.com/',
  twilio: 'https://api.twilio.com/',
};

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    if (typeof code === 'string') return code;
    if (typeof cause?.code === 'string') return cause.code;
    if (err.name === 'TimeoutError') return `no answer in ${ASK_MS / 1000} seconds`;
    return err.message;
  }
  return String(err);
}

/** The folder itself, or the nearest one above it that exists: what decides whether it can be made and written. */
function nearestExisting(dir: string): string {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

function writable(dir: string): boolean {
  const at = nearestExisting(dir);
  try {
    if (!statSync(at).isDirectory()) return false;
    accessSync(at, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A 555 number in the North American plan: a fictional exchange or area code, which no one answers. */
const FICTIONAL = /^\+1(?:555\d{7}|\d{3}555\d{4})$/;
const TWILIO_TOKEN = /^[0-9a-fA-F]{32}$/;

export async function runDoctor(o: DoctorOptions, deps: DoctorDeps = defaultDoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const raw = o.env.PUBLIC_HOST?.trim();
  const quick = !raw || raw === 'quick';

  // 1. The config, as the server would load it.
  let config: ServerConfig;
  try {
    config = loadConfig(quick ? { ...o.env, PUBLIC_HOST: QUICK_PLACEHOLDER } : o.env);
  } catch (e) {
    results.push({ id: 'config', status: 'fail', message: e instanceof Error ? e.message : String(e), fix: 'fix it in the settings file (pnpm configure writes one)' });
    return results;
  }
  const summary = `port ${config.port}, ${config.voiceProviders.join(' and ')}, JEV_CLIENT ${config.jevClient}`;
  results.push(
    quick
      ? { id: 'config', status: 'warn', message: `config loads (${summary}), but PUBLIC_HOST is not set: pnpm start --tunnel quick sets it each run, a new hostname every time`, fix: "for a hostname that stays, set PUBLIC_HOST to a named tunnel's or your own domain's" }
      : { id: 'config', status: 'ok', message: `config loads (${summary})` },
  );
  const host = config.publicHost;
  const laptop = !quick && isLoopbackHost(host);
  const base = `https://${host}`;

  // 2. Reaching the server through its public address.
  let health: Response | null = null;
  const notAsked = o.offline
    ? 'not asked (--offline): run pnpm diagnose while the server and its tunnel run'
    : quick
      ? "no PUBLIC_HOST to ask: a quick tunnel's changes each run (PUBLIC_HOST=<the hostname pnpm start printed> pnpm diagnose)"
      : laptop
        ? `PUBLIC_HOST is ${host}: a laptop, which no carrier reaches`
        : null;
  if (notAsked !== null) {
    results.push({ id: 'reach', status: 'skip', message: notAsked });
  } else {
    let resolved = true;
    try {
      await deps.lookup(host);
    } catch (e) {
      resolved = false;
      results.push({ id: 'reach', status: 'fail', message: `${host} does not resolve (${messageOf(e)})`, fix: UNREACHABLE });
    }
    if (resolved) {
      try {
        const res = await deps.fetch(`${base}/health`, { signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
        if (res.status !== 200) {
          results.push({ id: 'reach', status: 'fail', message: `${base}/health answered ${res.status}`, fix: UNREACHABLE });
        } else {
          const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
          if (body?.ok === true) {
            health = res;
            results.push({ id: 'reach', status: 'ok', message: `${base}/health answers through the tunnel` });
          } else {
            results.push({ id: 'reach', status: 'fail', message: `${base}/health answered, but not as this server's health`, fix: 'is the tunnel pointed at this server\'s port?' });
          }
        }
      } catch (e) {
        results.push({ id: 'reach', status: 'fail', message: `${base}/health did not answer (${messageOf(e)})`, fix: UNREACHABLE });
      }
    }
  }

  // 3. The console is not public: with CONSOLE_AUTH=token, it asks for sign-in and gives nothing without one.
  if (health === null) {
    results.push({ id: 'console', status: 'skip', message: "whether the console is public: not asked, as the server's health was not" });
  } else if (config.consoleAuth) {
    results.push(await signInCheck(base, deps));
  } else {
    try {
      const res = await deps.fetch(`${base}/dashboard`, { signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
      if (res.status === 404) results.push({ id: 'console', status: 'ok', message: 'the console is not public (404 through the tunnel)' });
      else {
        results.push({
          id: 'console',
          status: 'fail',
          message: `${base}/dashboard answered ${res.status}: the console is public`,
          fix: config.consoleLocalOnly
            ? 'the tunnel makes its requests look local: it must keep the headers a proxy adds (anyone could watch calls)'
            : 'set CONSOLE_LOCAL_ONLY=on (the default): anyone could watch calls',
        });
      }
    } catch (e) {
      results.push({ id: 'console', status: 'warn', message: `${base}/dashboard did not answer (${messageOf(e)})`, fix: 'run pnpm diagnose again' });
    }
  }

  // 4. The carriers' secrets.
  if (laptop) {
    results.push({ id: 'carrier', status: 'skip', message: `PUBLIC_HOST is ${host}: no carrier reaches a laptop` });
  } else {
    const said: string[] = [];
    let problem: CheckResult | null = null;
    for (const id of config.voiceProviders) {
      const secret = config.providerSecrets[id] ?? '';
      if (id === 'twilio') {
        if (TWILIO_TOKEN.test(secret)) said.push('TWILIO_AUTH_TOKEN has the shape of an auth token');
        else {
          problem ??= {
            id: 'carrier',
            status: config.signatureCheck ? 'fail' : 'warn',
            message: `TWILIO_AUTH_TOKEN is ${secret.length} characters, not the 32 hexadecimal characters of an auth token`,
            fix: "copy the account's auth token from the Twilio Console: every call would be refused as unsigned",
          };
        }
      } else if (id === 'telnyx') {
        // loadConfig has parsed it already (registry.ts checkSecret).
        said.push('TELNYX_PUBLIC_KEY is an Ed25519 public key');
      }
    }
    if (problem === null && !config.signatureCheck) {
      problem = { id: 'carrier', status: 'warn', message: 'SIGNATURE_CHECK is off on a public host', fix: 'set SIGNATURE_CHECK=on: anyone could post a webhook' };
    }
    results.push(problem ?? { id: 'carrier', status: 'ok', message: said.join('; ') });
  }

  // 5. The model.
  const p = config.jevProvider;
  if (config.jevClient !== 'jev' || p === null) {
    results.push({ id: 'model', status: 'warn', message: `JEV_CLIENT is ${config.jevClient}: callers will be understood only by examples`, fix: 'set JEV_CLIENT=jev and a model key (pnpm configure asks)' });
  } else {
    const key = p.apiKey === null ? `no key (${p.keyVar} unset)` : `key in ${p.keyVar}`;
    const message = `model ${p.model} from ${p.provider}, ${key}`;
    results.push(
      p.official
        ? { id: 'model', status: 'ok', message }
        : { id: 'model', status: 'warn', message: `${message}: its probabilities are not Jev's`, fix: 'record a cassette with it and compare with regress before callers rely on it' },
    );
  }

  // 6. The handoff number.
  results.push(
    FICTIONAL.test(config.handoffNumber)
      ? { id: 'handoff', status: 'warn', message: `HANDOFF_NUMBER ${config.handoffNumber} is a 555 number: calls handed off will go nowhere`, fix: 'set it to a phone a person answers' }
      : { id: 'handoff', status: 'ok', message: `HANDOFF_NUMBER ${config.handoffNumber}` },
  );

  // 7. The folders, read from where the server runs.
  const traceDir = resolve(o.cwd, config.traceDir);
  const auditDir = resolve(o.cwd, config.auditDir);
  const unwritable = ([['TRACE_DIR', traceDir], ['AUDIT_DIR', auditDir]] as const).find(([, dir]) => !writable(dir));
  results.push(
    unwritable
      ? { id: 'folders', status: 'fail', message: `${unwritable[0]} ${unwritable[1]} cannot be written`, fix: `make it writable by the user the server runs as, or point ${unwritable[0]} elsewhere` }
      : { id: 'folders', status: 'ok', message: `traces in ${traceDir}, audit in ${auditDir}` },
  );

  // 8. The space.
  const free = [traceDir, auditDir].map((d) => deps.freeBytes(nearestExisting(d))).filter((n): n is number => n !== null);
  if (free.length === 0) results.push({ id: 'space', status: 'skip', message: 'the free space could not be read' });
  else {
    const least = Math.min(...free);
    const gb = `${(least / 1024 ** 3).toFixed(1)} GB free`;
    results.push(
      least < LOW_SPACE_BYTES
        ? { id: 'space', status: 'warn', message: `${gb} for the traces and audit`, fix: 'free some space, or set TRACE_RETENTION_DAYS' }
        : { id: 'space', status: 'ok', message: gb },
    );
  }

  // 9. The clock, against another machine's: a host this setup relies on, never PUBLIC_HOST (through a
  // tunnel to this machine, its Date is this machine's own clock).
  if (o.offline) {
    results.push({ id: 'clock', status: 'skip', message: 'the clock: not asked (--offline)' });
  } else {
    const sources = clockSources(config, laptop);
    let read: { url: string; at: number } | null = null;
    for (const url of sources) {
      try {
        const res = await deps.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
        const at = Date.parse(res.headers.get('date') ?? '');
        if (!Number.isNaN(at)) {
          read = { url, at };
          break;
        }
      } catch {
        // The next one, if there is one.
      }
    }
    if (read === null) {
      results.push({
        id: 'clock',
        status: 'skip',
        message: sources.length === 0
          ? 'the clock: no other server this setup uses to compare it with (no carrier on a laptop, no hosted model)'
          : `the clock: no Date from ${sources.map((u) => new URL(u).host).join(' or ')}`,
      });
    } else {
      const off = deps.now() - read.at;
      const other = new URL(read.url).host;
      results.push(
        Math.abs(off) > CLOCK_TOLERANCE_MS
          ? { id: 'clock', status: 'fail', message: `the clock is ${Math.round(Math.abs(off) / 1000)} s ${off > 0 ? 'ahead of' : 'behind'} ${other}`, fix: 'let the clock set itself (Telnyx refuses a webhook whose signature is more than five minutes off)' }
          : { id: 'clock', status: 'ok', message: `the clock is within a minute of ${other}` },
      );
    }
  }
  return results;
}

/**
 * The servers whose clocks the clock check reads, in order: each enabled carrier's API host (none on a
 * laptop, where no carrier is used), then the model provider's, unless that is on this machine.
 */
export function clockSources(config: ServerConfig, laptop: boolean): string[] {
  const urls = laptop ? [] : config.voiceProviders.map((id) => CARRIER_CLOCK_URLS[id]).filter((u): u is string => u !== undefined);
  const p = config.jevClient === 'jev' ? config.jevProvider : null;
  if (p) {
    try {
      const base = new URL(p.baseURL);
      if (!isLoopbackHost(base.hostname)) urls.push(`${base.origin}/`);
    } catch {
      // loadConfig has checked it; a URL that does not parse is simply not asked.
    }
  }
  return [...new Set(urls)];
}

/**
 * Check 3 with CONSOLE_AUTH=token: through the tunnel, https://PUBLIC_HOST/dashboard must send a browser
 * with no cookie to the sign-in page (302 to /dashboard/login), never the console, and the console's data
 * (its trace list) must answer 401.
 */
async function signInCheck(base: string, deps: DoctorDeps): Promise<CheckResult> {
  const PUBLIC_FIX = 'restart the server with these settings (CONSOLE_AUTH=token): anyone could watch calls';
  let page: Response;
  try {
    page = await deps.fetch(`${base}/dashboard`, { signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
  } catch (e) {
    return { id: 'console', status: 'warn', message: `${base}/dashboard did not answer (${messageOf(e)})`, fix: 'run pnpm diagnose again' };
  }
  if (page.status === 404) {
    return { id: 'console', status: 'warn', message: `${base}/dashboard answered 404: the running server keeps the console local, though CONSOLE_AUTH is token here`, fix: 'restart the server to take CONSOLE_AUTH=token' };
  }
  const location = page.headers.get('location') ?? '';
  if (page.status !== 302 || location !== '/dashboard/login') {
    return page.status === 200
      ? { id: 'console', status: 'fail', message: `${base}/dashboard answered 200 without a sign-in: the console is public`, fix: PUBLIC_FIX }
      : { id: 'console', status: 'fail', message: `${base}/dashboard answered ${page.status}${location ? ` to ${location}` : ''}, not the sign-in page`, fix: PUBLIC_FIX };
  }
  let data: Response;
  try {
    data = await deps.fetch(`${base}/dashboard/traces`, { signal: AbortSignal.timeout(ASK_MS), redirect: 'manual' });
  } catch (e) {
    return { id: 'console', status: 'warn', message: `${base}/dashboard/traces did not answer (${messageOf(e)})`, fix: 'run pnpm diagnose again' };
  }
  if (data.status !== 401) {
    return { id: 'console', status: 'fail', message: `${base}/dashboard/traces answered ${data.status} without a sign-in: the calls are public`, fix: PUBLIC_FIX };
  }
  return { id: 'console', status: 'ok', message: 'the console asks for sign-in through the tunnel (CONSOLE_AUTH=token): /dashboard goes to /dashboard/login, and its data answers 401' };
}

/** One check as a line: its status, what it found, and the fix. */
export function formatResult(r: Pick<CheckResult, 'status' | 'message' | 'fix'> & { id?: CheckId }): string {
  return `${r.status.padEnd(4)}  ${r.message}${r.fix ? `  ->  ${r.fix}` : ''}`;
}

/** The settings file holds keys: readable by its owner alone (mode 600), as pnpm configure writes it. */
export function settingsFileCheck(file: string, platform: NodeJS.Platform = process.platform): CheckResult {
  if (platform === 'win32') return { id: 'settings', status: 'skip', message: `${file}: who may read it is not checked on Windows` };
  const mode = statSync(file).mode & 0o777;
  return mode & 0o077
    ? { id: 'settings', status: 'warn', message: `${file} can be read by others (mode ${mode.toString(8)}), and it holds keys`, fix: `chmod 600 ${file}` }
    : { id: 'settings', status: 'ok', message: `${file} is readable by its owner alone` };
}

export interface DoctorIo {
  out(line: string): void;
  /** The environment, which wins over the settings file. */
  env: Env;
  /** Where the command was run (pnpm's INIT_CWD), which relative paths are from. */
  invokedFrom: string;
  /** The repository root, where the apps are found. */
  root?: string;
}

export const DOCTOR_USAGE = 'usage: [ENV_FILE=<path>] pnpm diagnose [--app <name>] [--offline]   (ENV_FILE names a settings file other than <app>/.env)';

/** The command; returns its exit code (0 nothing failed, 1 something did, 2 a command line it does not understand). */
export async function main(argv: readonly string[], io: DoctorIo, deps: DoctorDeps = defaultDoctorDeps): Promise<number> {
  let appName: string | undefined;
  let envFileArg: string | undefined;
  let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--offline') offline = true;
    else if ((a === '--app' || a === '--env-file') && argv[i + 1] !== undefined) {
      if (a === '--app') appName = argv[++i];
      else envFileArg = argv[++i];
    } else {
      io.out(DOCTOR_USAGE);
      return 2;
    }
  }
  const apps = workspaceApps(io.root ?? WORKSPACE_ROOT);
  let app: WorkspaceApp | null = null;
  if (appName !== undefined) {
    app = findApp(apps, appName, io.invokedFrom);
    if (app === null) {
      io.out(`no app "${appName}" in this workspace`);
      return 2;
    }
  }
  const named = envFileArg ?? (io.env.ENV_FILE?.trim() || undefined);
  let file: string;
  if (named !== undefined) file = isAbsolute(named) ? named : resolve(io.invokedFrom, named);
  else {
    if (app === null) {
      const chosen = chooseApp(apps, undefined, io.invokedFrom, 'diagnose');
      if ('error' in chosen) {
        io.out(chosen.error);
        return 2;
      }
      app = chosen.app;
    }
    file = join(app.dir, '.env');
  }
  let fromFile: Record<string, string>;
  try {
    fromFile = readEnvFile(file);
  } catch (e) {
    io.out(formatResult({ status: 'fail', message: e instanceof Error ? e.message : String(e), fix: 'run pnpm configure, or name the file: ENV_FILE=<path> pnpm diagnose' }));
    return 1;
  }
  const env: Env = { ...fromFile };
  for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
  // A file named with no --app: the folders are read from the app's folder still, when it is plain which app that is.
  if (app === null) {
    const here = apps.find((a) => io.invokedFrom === a.dir || io.invokedFrom.startsWith(a.dir + sep));
    app = here ?? (apps.length === 1 ? apps[0]! : null);
  }
  io.out(`${app ? `${app.name}: ` : ''}settings from ${file}${offline ? ' (offline)' : ''}`);
  const results = [settingsFileCheck(file), ...(await runDoctor({ env, cwd: app?.dir ?? io.invokedFrom, offline }, deps))];
  for (const r of results) io.out(formatResult(r));
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const skipped = count('skip');
  io.out(`${results.length} checks: ${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail${skipped ? `, ${skipped} skipped` : ''}`);
  return count('fail') > 0 ? 1 : 0;
}

// Run when invoked directly (tsx doctor.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    env: process.env,
    invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
  });
}

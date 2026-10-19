import { E164, numberName, targetValueProblem } from './transfer';
import { clashingNumbers, numberLocalesOf } from '../core/numberLocales';
import type { EnvReference } from '../core/app/envReference';
import { isSipTarget } from './voice/dial';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gb as gbOf, loadConfig, recognitionFor, recordsSettingFor, type Env, type ServerConfig } from './config';
import { bareSpeechTags, bareTagFinding, englishOnlyFinding, englishOnlyHearings, namesSpeechLanguages, speechLocalesOfFolder, speechTagsOf } from '../channel/speechLanguages';
import { VOICE_PROVIDER_IDS } from '../channel/voiceProviders';
import { readEnvFile, readEnvFiles, resolveEnvFiles } from './envFile';
import { appYamlEnvReferences } from '../define/envReferences';
import { loadAppFolder } from '../define/load';
import { generatedWordingOf, identifierVarsFrom } from '../render/config';
import { buildSlot } from '../slots/defineSlot';
import { appModelKeyMissing, appModelLabel, renderModelSource, renderModelSourceLabel, renderSettings, resolveAppRenderProvider, thinkingLabel } from '../render/providers';
import { CALL_DATA_VALUE_MAX, writableValue } from '../channel/callData';
import { isLoopbackHost } from './localOnly';
import { chooseApp, findApp, projectRoot, workspaceApps, type WorkspaceApp } from './workspace';
import { maskConnectionString, maskSecrets, openPgClient, PgUnavailableError, type SqlClient } from './stores/sql';
import { databaseNowMs, POSTGRES_SCHEMA_VERSION, probeLease, schemaVersion } from './stores/postgres';
import { NOTICE_TABLES, NOTICES_SCHEMA_VERSION, probeNoticeWrite } from './stores/notices';
import { AUDIT_SCHEMA_VERSION, AUDIT_TABLES, probeAuditWrite } from '../audit/postgres';
import { describeTraceStore, type S3TraceSetting } from '../trace/store';
import { S3Client } from '../trace/s3/client';
import { randomBytes } from 'node:crypto';
import { hostFileOf, resolveHostFile, type ResolvedHost } from '../define/host';
import { appEnvironment, hostNumbers, hostRouting, ownSettingsLines, ownVariablesOf, OWN_SERVER_SETTING_FIX } from './host';
import { parse as parseYaml } from 'yaml';
import type { App } from '../core/app/types';

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
 *   6. HANDOFF_NUMBER is not a 555 number; and each variable app.yaml names (env.<NAME>) is set, said by its
 *      length, never its value; a transfer target's holds an E.164 number or a sip: URI, and not a 555 number;
 *   7. the trace and audit folders can be written, and 8. there is more than a gigabyte free, and what
 *      the retention policy keeps (traces, the audit, the free-space warning, the server's own log);
 *   9. this machine's clock is within a minute of another machine's: the Date that the carrier's API host
 *      (or else the model provider's) answers a HEAD with. Not PUBLIC_HOST's: through a tunnel that is
 *      this machine's own clock, passed back;
 *  10. with SESSION_STORE=file:<dir> (and only then, after the folders), its folder can be written, is not
 *      on a temporary filesystem a reboot empties, and is not readable by others; with SESSION_STORE=
 *      postgres://... (not with --offline), the database answers, its session tables are at the version
 *      this server reads (or not made yet), and this server can take a test lease and give it up. The
 *      connection string is said with its password masked, and so is any message the driver gives;
 *  11. with AUDIT_STORE=postgres://... (not with --offline), the database answers, its audit tables are at
 *      the version this server reads (or not made yet), and an entry can be written (in a transaction
 *      rolled back, so the audit is never written to by a check);
 *  12. with TRACE_STORE=s3://... (not with --offline), the bucket takes a small test object, lists it,
 *      gives it back and deletes it, under the prefix and outside any call's folder. Neither key is ever said.
 *
 * It calls no carrier and no model: the only requests are DNS, two GETs to the server's own address
 * (three with CONSOLE_AUTH=token), one HEAD with no key and no body to a host the setup already relies
 * on, for its clock, and with SESSION_STORE=postgres a connection to that database; none with
 * --offline (what `pnpm configure` runs). Exit 0 when nothing fails.
 */

export type CheckId = 'settings' | 'host' | 'config' | 'reach' | 'console' | 'carrier' | 'model' | 'handoff' | 'variables' | 'folders' | 'store' | 'audit' | 'traces' | 'space' | 'retention' | 'clock' | 'wording' | 'languages' | 'records';
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
  /** Whether `dir` is on a temporary filesystem a reboot empties; onTemporaryFilesystem when absent. */
  temporary?(dir: string): boolean;
  /** A connection to SESSION_STORE's Postgres (the check closes it); the pg driver's when absent. Tests give PGlite. */
  postgres?(url: string): Promise<SqlClient>;
  /** How TRACE_STORE's bucket is reached (check 12); the global fetch when absent. Tests give their own store. */
  s3Fetch?: typeof fetch;
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
  /**
   * The app's folder, whose app.yaml may name environment variables (`env.<NAME>`: startParameters):
   * each is said set or unset, by its length, never its value. Absent, none is checked.
   */
  appDir?: string;
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
  const summary = `port ${config.port}, ${config.voiceProviders.length === 0 ? 'no phone line (the web chat alone)' : config.voiceProviders.join(' and ')}, JEV_CLIENT ${config.jevClient}`;
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
  if (config.voiceProviders.length === 0) {
    results.push({ id: 'carrier', status: 'skip', message: 'VOICE_PROVIDERS is none: no phone line, so no carrier secret is needed' });
  } else if (laptop) {
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

  // 6. The handoff number (none needed without a phone line: a chat's handoff goes to the page).
  results.push(
    config.handoffNumber === ''
      ? { id: 'handoff', status: 'skip', message: 'HANDOFF_NUMBER unset: no phone line, so a handoff goes to the chat page (the widget\'s onTransfer)' }
      : FICTIONAL.test(config.handoffNumber)
      ? { id: 'handoff', status: 'warn', message: `HANDOFF_NUMBER ${config.handoffNumber} is a 555 number: calls handed off will go nowhere`, fix: 'set it to a phone a person answers' }
      : { id: 'handoff', status: 'ok', message: `HANDOFF_NUMBER ${config.handoffNumber}` },
  );

  // 6b. The variables app.yaml names (env.<NAME>), read from the YAML alone: set or not, and how long, never the value.
  if (o.appDir !== undefined) results.push(...variableChecks(o.appDir, o.env));
  // Generated wording, for an app that generates a line: who words it, from the settings alone (no model is asked).
  if (o.appDir !== undefined) results.push(...wordingChecks(o.appDir, o.env));
  if (o.appDir !== undefined) results.push(...recordsChecks(o.appDir, config));
  // The app's languages as the carriers listed are sent them: a tag with no region, a recognizer that hears English only.
  if (o.appDir !== undefined) results.push(...languageChecks(o.appDir, config));

  // 7. The folders, read from where the server runs.
  const traceDir = resolve(o.cwd, config.traceDir);
  const auditDir = resolve(o.cwd, config.auditDir);
  const unwritable = ([['TRACE_DIR', traceDir], ['AUDIT_DIR', auditDir]] as const).find(([, dir]) => !writable(dir));
  results.push(
    unwritable
      ? { id: 'folders', status: 'fail', message: `${unwritable[0]} ${unwritable[1]} cannot be written`, fix: `make it writable by the user the server runs as, or point ${unwritable[0]} elsewhere` }
      : { id: 'folders', status: 'ok', message: `traces in ${traceDir}, audit in ${auditDir}` },
  );

  // 10. The session store's folder, when there is one (the memory store has none to check), or its database.
  if (config.sessionStore?.kind === 'file') results.push(storeCheck(resolve(o.cwd, config.sessionStore.dir), deps.temporary ?? onTemporaryFilesystem));
  if (config.sessionStore?.kind === 'postgres') results.push(await postgresCheck(config.sessionStore.url, o.offline === true, deps));
  // 11. The audit's database, and 12. the trace store's bucket, when they are set.
  if (config.auditStore) results.push(await auditStoreCheck(config.auditStore.url, o.offline === true, deps));
  if (config.traceStore) results.push(await traceStoreCheck(config.traceStore, o.offline === true, deps));

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
  // 8b. The retention policy: what is removed, and when, and where the server's own log goes.
  results.push(retentionCheck(config));

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

/** The folders a reboot empties, or this machine's temporary folder: where a session store is lost. */
const TEMPORARY_ROOTS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/dev/shm', '/run'];

/** The real path of `dir`, or of the nearest folder above it that exists, with the rest as written. */
/**
 * One line per environment variable the app folder's app.yaml names (define/envReferences.ts): set, by
 * its length, or not set, with the fix. The server refuses to start while one is unset, empty, longer
 * than a custom parameter may be, or has a control character, so each of those fails here too. None
 * for an app.yaml that names none, so every other app's diagnosis is as it was.
 */
/**
 * app.yaml's records (what the records keep of the numbers): a setting that keeps the caller's number or
 * name whole, with the console behind sign-in (CONSOLE_AUTH=token) or off (DASHBOARD=off), as the server
 * says at start; one with a console that needs no sign-in fails, as the server refuses to start with it. Nothing for an app that
 * keeps the defaults, or a folder that cannot be read (pnpm check says why).
 */
export function recordsChecks(appDir: string, console: { readonly dashboard: boolean; readonly consoleAuth?: unknown }): CheckResult[] {
  const loaded = loadAppFolder(appDir).config;
  if (loaded === null || loaded.app.records === undefined) return [];
  try {
    const line = recordsSettingFor({ records: loaded.app.records }, console);
    return line === null ? [] : [{ id: 'records', status: 'ok', message: line }];
  } catch (e) {
    return [{ id: 'records', status: 'fail', message: `${messageOf(e)}: the server will not start`, fix: 'set CONSOLE_AUTH=token (or DASHBOARD=off) in the settings file, or let app.yaml\'s records keep the defaults' }];
  }
}

/**
 * Generated wording (prompts.yaml's mode: generative, a form's wording: generative): which model words
 * the app's generated lines (the environment's, over the one style.yaml names), with its key's variable
 * (never the key), RENDER_SHARE and the budget; that every line is said fixed with RENDER_PROVIDER unset
 * and no model named, or with the named model's key unset; and a setting the server would refuse. Nothing for
 * an app that generates no line, or a folder that cannot be read (pnpm check says why). No model is asked.
 */
export function wordingChecks(appDir: string, env: Env): CheckResult[] {
  const loaded = loadAppFolder(appDir).config;
  if (loaded === null) return [];
  // The identifiers, as the app is built: its identity factors, and each library slot hidden whole in the
  // records (a slot in code, which this reads no code for, counts as none).
  const slots: Record<string, { redact?: string; summarized?: true }> = {};
  for (const [id, entry] of Object.entries(loaded.slots ?? {})) {
    const built = buildSlot(id, entry);
    if (built.ok) slots[id] = { ...(built.spec.redact !== undefined ? { redact: built.spec.redact } : {}), ...(built.spec.summarized === true ? { summarized: true as const } : {}) };
  }
  const g = generatedWordingOf({
    prompts: loaded.prompts[loaded.defaultLocale] ?? {}, forms: loaded.forms.forms, style: loaded.style, localePrompts: {},
    identifierVars: identifierVarsFrom(slots, loaded.identity?.levels[1].factors ?? []),
  });
  const lines = g === undefined ? 0 : Object.keys(g.lines).length;
  if (lines === 0) return [];
  const said = `${lines} generated line${lines === 1 ? '' : 's'}`;
  // The model the app names (style.yaml's `model`), under the environment's settings.
  const model = g!.model;
  const missing = appModelKeyMissing(env, model);
  if (missing !== null) return [{ id: 'wording', status: 'warn', message: `${said}, worded by ${appModelLabel(model!)}, but ${missing} is unset: every line is said fixed`, fix: `set ${missing} in the settings file to have them generated` }];
  try {
    const p = resolveAppRenderProvider(env, model);
    if (p === null) return [{ id: 'wording', status: 'warn', message: `${said}, but RENDER_PROVIDER is unset: every line is said fixed`, fix: 'set RENDER_PROVIDER to openrouter or anthropic, and its key (OPENROUTER_API_KEY or ANTHROPIC_API_KEY), to have them generated, or name the model in style.yaml (model: { provider, id })' }];
    const r = renderSettings(env);
    // Where the model came from: style.yaml, or the environment (over it, or alone).
    const source = renderModelSourceLabel(renderModelSource(env, model));
    return [{ id: 'wording', status: 'ok', message: `${said}, worded by ${p.model} from ${p.provider} (${source}; key in ${p.keyVar}${p.thinking !== undefined ? `; ${thinkingLabel(p.thinking)}` : ''}), ${r.share}% of calls, within ${r.timeoutMs.voice} ms on a call and ${r.timeoutMs.chat} ms in a chat, its checks ${r.checkTimeoutMs.voice} and ${r.checkTimeoutMs.chat} ms` }];
  } catch (e) {
    return [{ id: 'wording', status: 'fail', message: `${said}: ${messageOf(e)}: the server will not start`, fix: 'fix the setting in the settings file' }];
  }
}

/**
 * The app's languages as the server's carriers would be sent them (channel/speechLanguages.ts), for an app
 * whose start document names its languages; nothing for any other, or a folder that cannot be read (pnpm
 * check says why). A locale spoken or heard as a tag with no region fails on a server that answers on
 * Twilio, which refused such a tag as a <Language> code on a live call and ended the call with an error,
 * where the tag is the locale's tts (the code); a bare transcription alone, and anything on Telnyx alone,
 * is a warning, since neither is known. A language other than English heard by a recognizer that hears
 * English only fails on Twilio where its own element names that model (its own recognizer, or the
 * server's TWILIO_SPEECH_MODEL for the default locale), and warns where it names none and another
 * language's may be kept (one live call's reading), and on Telnyx. Otherwise one line names each locale's
 * languages. (Provisional, the maintainer's to confirm: which of these fail.)
 */
export function languageChecks(appDir: string, config: Pick<ServerConfig, 'voiceProviders' | 'twilioTranscriptionProvider' | 'twilioSpeechModel' | 'telnyxTranscriptionProvider'>): CheckResult[] {
  const loaded = loadAppFolder(appDir).config;
  if (loaded === null) return [];
  const speech = speechLocalesOfFolder(loaded);
  if (!namesSpeechLanguages(speech)) return [];
  const carriers = VOICE_PROVIDER_IDS.filter((id) => config.voiceProviders.includes(id));
  const out: CheckResult[] = [];
  const bare = bareSpeechTags(speech);
  for (const locale of [...new Set(bare.map((b) => b.locale))]) {
    const mine = bare.filter((b) => b.locale === locale);
    const { message, fix } = bareTagFinding(locale, mine);
    // A bare tts is the <Language> code, which Twilio refused on a live call: certain to fail there. A bare
    // transcription alone is not yet seen on a call, and on Telnyx neither is known: warnings.
    out.push(carriers.includes('twilio') && mine.some((b) => b.field === 'tts')
      ? { id: 'languages', status: 'fail', message: `${message}: Twilio, which this server answers on, will refuse it`, fix }
      : { id: 'languages', status: 'warn', message, fix });
  }
  for (const h of englishOnlyHearings(speech, (c) => recognitionFor(config, c), carriers)) {
    const { message, fix } = englishOnlyFinding(h, true);
    // On Twilio, a language whose own element names an English-only model (its own, or the server's for the
    // default locale) is heard with it for certain: a fail. One that names none and may be heard with
    // another language's is a reading of one live call: a warning.
    out.push({ id: 'languages', status: h.carrier === 'twilio' && h.how !== 'another' ? 'fail' : 'warn', message, fix });
  }
  if (out.length > 0) return out;
  const named = (speech.locales ?? []).map((l) => {
    const t = speechTagsOf(speech, l);
    return t.tts === t.transcription ? `${l} as ${t.tts}` : `${l} spoken as ${t.tts}, heard as ${t.transcription}`;
  });
  return [{ id: 'languages', status: 'ok', message: `languages: ${named.join('; ')}, each with its region, and none heard by a recognizer that hears English only` }];
}

/** The server's settings as `pnpm start` would load them, PUBLIC_HOST aside; null where they do not load (the config check says why). */
function serverConfigOf(env: Env): ServerConfig | null {
  const raw = env.PUBLIC_HOST?.trim();
  try {
    return loadConfig(!raw || raw === 'quick' ? { ...env, PUBLIC_HOST: QUICK_PLACEHOLDER } : env);
  } catch {
    return null;
  }
}

export function variableChecks(appDir: string, env: Env): CheckResult[] {
  const refs = appYamlEnvReferences(appDir);
  if (refs === null) return [{ id: 'variables', status: 'skip', message: 'the variables app.yaml names: app.yaml cannot be read (pnpm check says why)' }];
  return [...referenceChecks(refs, env), ...numberClashChecks(appDir, env)];
}

/**
 * Two entries of app.yaml's voice.numbers that are one number in two locales, as the server will read
 * them (server/transfer.ts voiceNumbersFrom refuses to start on one): a fail each, the numbers by their
 * last four. Nothing where app.yaml cannot be read (the variables check says so) or lists no numbers.
 */
function numberClashChecks(appDir: string, env: Env): CheckResult[] {
  let voice: unknown;
  try {
    voice = (parseYaml(readFileSync(join(appDir, 'app.yaml'), 'utf8')) as { voice?: unknown } | null)?.voice;
  } catch {
    return [];
  }
  const numbers = typeof voice === 'object' && voice !== null ? (voice as { numbers?: unknown }).numbers : undefined;
  if (typeof numbers !== 'object' || numbers === null || Array.isArray(numbers)) return [];
  const listed = Object.fromEntries(Object.entries(numbers).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const read = numberLocalesOf({ numbers: listed }, (name) => env[name]).numbers.filter((n) => E164.test(n.number));
  return clashingNumbers(read).map(([a, b]) => ({
    id: 'variables' as const, status: 'fail' as const,
    message: `app.yaml's voice.numbers starts ${numberName(a)} in ${a.locale} and ${numberName(b)}, the same number, in ${b.locale}: the server will not start`,
    fix: 'give each locale a number of its own',
  }));
}

function referenceChecks(refs: readonly EnvReference[], env: Env): CheckResult[] {
  return refs.map(({ path, variable, file, kind }) => {
    const value = env[variable];
    const where = `${file ?? 'app.yaml'}'s ${path} reads ${variable}`;
    if (value === undefined || value.trim() === '') return { id: 'variables', status: 'fail', message: `${where}, which is not set: the server will not start`, fix: `set ${variable} in the settings file` };
    // A called condition (a route's or a transfer target's): the E.164 number callers dial, as the server holds it (server/transfer.ts calledVariablesFrom).
    if (kind === 'called') {
      return E164.test(value.trim())
        ? { id: 'variables', status: 'ok', message: `${where}: set, a phone number (the number called is compared with it)` }
        : { id: 'variables', status: 'fail', message: `${where}: set, but it is not an E.164 number: the server will not start`, fix: `set ${variable} to the number callers dial, like +15551234567` };
    }
    // A transfer target: an E.164 number or a sip: URI, as the server holds it (server/transfer.ts); a 555 number warned of, as HANDOFF_NUMBER is.
    if (path.startsWith('transfer.')) return targetCheck(where, variable, value.trim());
    if (value.length > CALL_DATA_VALUE_MAX) return { id: 'variables', status: 'fail', message: `${where}: set, ${value.length} characters, more than the ${CALL_DATA_VALUE_MAX} a custom parameter takes`, fix: `shorten ${variable}` };
    if (!writableValue(value)) return { id: 'variables', status: 'fail', message: `${where}: set, ${value.length} characters, with a control character a start document cannot carry`, fix: `write ${variable} on one line, with no tab or other control character` };
    return { id: 'variables', status: 'ok', message: `${where}: set, ${value.length} characters` };
  });
}

/** One transfer target's variable: what kind of target it holds, never the value itself. */
function targetCheck(where: string, variable: string, value: string): CheckResult {
  const problem = targetValueProblem(value);
  if (problem !== null) return { id: 'variables', status: 'fail', message: `${where}: set, but it ${problem}: the server will not start`, fix: `set ${variable} to an E.164 number like +15551234567 or a sip: URI like sip:desk@pbx.example.com` };
  if (FICTIONAL.test(value)) return { id: 'variables', status: 'warn', message: `${where}: a 555 number, so calls handed off there will go nowhere`, fix: `set ${variable} to a phone a person answers` };
  return { id: 'variables', status: 'ok', message: `${where}: set, ${isSipTarget(value) ? 'a SIP address' : 'a phone number'}` };
}

function realOf(dir: string): string {
  const at = nearestExisting(dir);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {
    // As written.
  }
  return join(real, dir.slice(at.length));
}

/** The mount points of tmpfs and ramfs filesystems on Linux (from /proc/mounts); none elsewhere. */
function memoryMounts(): string[] {
  try {
    return readFileSync('/proc/mounts', 'utf8').split('\n').flatMap((line) => {
      const [, mount, type] = line.split(' ');
      return mount !== undefined && (type === 'tmpfs' || type === 'ramfs') ? [mount] : [];
    });
  } catch {
    return [];
  }
}

/** Whether `dir` is under a temporary folder (this machine's, /tmp and the like) or, on Linux, a tmpfs mount. */
export function onTemporaryFilesystem(dir: string): boolean {
  const real = realOf(resolve(dir));
  const under = (root: string): boolean => root !== '/' && (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
  return [...TEMPORARY_ROOTS, realOf(tmpdir()), ...memoryMounts()].some(under);
}

/** Check 10: SESSION_STORE's folder can be written, outlives a reboot, and is its owner's alone. */
function storeCheck(dir: string, temporary: (dir: string) => boolean): CheckResult {
  if (!writable(dir)) return { id: 'store', status: 'fail', message: `SESSION_STORE folder ${dir} cannot be written`, fix: 'make it writable by the user the server runs as, or point SESSION_STORE elsewhere' };
  if (temporary(dir)) {
    return {
      id: 'store', status: 'warn', message: `SESSION_STORE folder ${dir} is on a temporary filesystem: a reboot empties it, and the calls in it with it`,
      fix: 'point SESSION_STORE at a folder that outlives a reboot, beside the app (file:sessions)',
    };
  }
  if (existsSync(dir)) {
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) return { id: 'store', status: 'warn', message: `SESSION_STORE folder ${dir} can be read by others than its owner (mode ${mode.toString(8)})`, fix: `chmod 700 ${dir}` };
  }
  return { id: 'store', status: 'ok', message: `sessions in ${dir}: a restart resumes the calls under way (a carrier that calls back while no server listens needs its fallback document: pnpm fallback)` };
}

/** Check 10 with SESSION_STORE=postgres://...: reachable, the tables' version, and a test lease taken and given up. Never the password. */
async function postgresCheck(url: string, offline: boolean, deps: DoctorDeps): Promise<CheckResult> {
  const named = `SESSION_STORE ${maskConnectionString(url)}`;
  if (offline) return { id: 'store', status: 'skip', message: `${named}: not asked (--offline)` };
  let sql: SqlClient;
  try {
    sql = await (deps.postgres ?? ((u: string) => openPgClient(u, { max: 1, connectTimeoutMs: ASK_MS })))(url);
  } catch (err) {
    if (err instanceof PgUnavailableError) return { id: 'store', status: 'fail', message: `${named}: the pg package is not installed here`, fix: 'pnpm add pg (or npm install pg) in the project' };
    return { id: 'store', status: 'fail', message: `${named}: ${maskSecrets(dbMessage(err), url)}`, fix: UNREACHABLE_DB };
  }
  try {
    let version: number | null;
    try {
      version = await schemaVersion(sql);
    } catch (err) {
      return { id: 'store', status: 'fail', message: `${named} cannot be reached: ${maskSecrets(dbMessage(err), url)}`, fix: UNREACHABLE_DB };
    }
    if (version === null) {
      return { id: 'store', status: 'ok', message: `${named} answers; its session tables are made when the server first starts (version ${POSTGRES_SCHEMA_VERSION})` };
    }
    if (version !== POSTGRES_SCHEMA_VERSION) {
      return {
        id: 'store', status: 'fail', message: `${named}: its session tables are version ${version}, and this server reads ${POSTGRES_SCHEMA_VERSION}`,
        fix: version > POSTGRES_SCHEMA_VERSION ? 'run the newer server, or point SESSION_STORE at another database' : 'point SESSION_STORE at a new database, or run the server that made them',
      };
    }
    try {
      await probeLease(sql);
    } catch (err) {
      return { id: 'store', status: 'fail', message: `${named}: a test lease could not be taken and given up: ${maskSecrets(dbMessage(err), url)}`, fix: 'give the user in SESSION_STORE the right to read and write the dw_ tables' };
    }
    // For information: leases are timed by the database's clock, so this machine's may differ; a large
    // difference still says one of the two clocks is wrong.
    let offset = '';
    try {
      const off = (await databaseNowMs(sql)) - deps.now();
      offset = `; its clock is ${(off / 1000).toFixed(1)} s from this machine's (leases are timed by the database's)`;
    } catch {
      // Said without it.
    }
    // The notices between the servers (the console's events, a chat moved), made beside the session tables.
    try {
      const notices = await schemaVersion(sql, NOTICE_TABLES.row);
      if (notices !== null && notices !== NOTICES_SCHEMA_VERSION) {
        return { id: 'store', status: 'fail', message: `${named}: its notice table is version ${notices}, and this server reads ${NOTICES_SCHEMA_VERSION}`, fix: 'run the server that made it, or point SESSION_STORE at another database' };
      }
      if (notices !== null) {
        try {
          await probeNoticeWrite(sql);
        } catch (err) {
          return { id: 'store', status: 'fail', message: `${named}: a notice could not be written: ${maskSecrets(dbMessage(err), url)}`, fix: 'give the user in SESSION_STORE the right to select, insert and delete on dw_notices and to use the sequence dw_notices_id_seq' };
        }
      }
    } catch {
      // Read with the session tables' version just above; a failure here is said by the server at start.
    }
    return { id: 'store', status: 'ok', message: `${named} answers, its session tables are version ${version}, and a test lease was taken and given up: the servers on it share their calls${offset}` };
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/** The retention policy as the settings have it, said in one line (always ok: each is a choice). */
export function retentionCheck(c: ServerConfig): CheckResult {
  const traces = c.traceRetentionDays === undefined && c.traceMaxBytes === undefined
    ? 'traces kept for ever'
    : `traces kept ${c.traceRetentionDays === undefined ? 'for ever' : `${c.traceRetentionDays} days`}${c.traceMaxBytes !== undefined ? ` and at most ${gbOf(c.traceMaxBytes)}` : ''}`;
  const audit = c.auditRetentionDays === undefined ? 'the audit kept for ever (a record: AUDIT_RETENTION_DAYS only for how long it must be kept)' : `the audit kept ${c.auditRetentionDays} days`;
  const warn = c.diskWarnFreeBytes === undefined ? 'no free-space warning' : `/health warns under ${gbOf(c.diskWarnFreeBytes)} free`;
  const log = c.logFile ? `the server's log in ${c.logFile.file}, rolled at ${Math.round(c.logFile.maxBytes / 1024 ** 2)} MB, ${c.logFile.keep} kept` : "the server's log where its service manager puts it (no LOG_FILE)";
  const where = c.traceStore ? ` on ${describeTraceStore(c.traceStore)}` : '';
  return { id: 'retention', status: 'ok', message: `${traces}${where}; ${audit}; ${warn}; ${log}` };
}

/** Check 11 with AUDIT_STORE=postgres://...: reachable, the audit tables' version, and an entry written in a transaction undone. Never the password. */
async function auditStoreCheck(url: string, offline: boolean, deps: DoctorDeps): Promise<CheckResult> {
  const named = `AUDIT_STORE ${maskConnectionString(url)}`;
  const unreachable = UNREACHABLE_DB.replace('SESSION_STORE', 'AUDIT_STORE');
  if (offline) return { id: 'audit', status: 'skip', message: `${named}: not asked (--offline)` };
  let sql: SqlClient;
  try {
    sql = await (deps.postgres ?? ((u: string) => openPgClient(u, { max: 1, connectTimeoutMs: ASK_MS })))(url);
  } catch (err) {
    if (err instanceof PgUnavailableError) return { id: 'audit', status: 'fail', message: `${named}: the pg package is not installed here`, fix: 'pnpm add pg (or npm install pg) in the project' };
    return { id: 'audit', status: 'fail', message: `${named}: ${maskSecrets(dbMessage(err), url)}`, fix: unreachable };
  }
  try {
    let version: number | null;
    try {
      version = await schemaVersion(sql, AUDIT_TABLES.row);
    } catch (err) {
      return { id: 'audit', status: 'fail', message: `${named} cannot be reached: ${maskSecrets(dbMessage(err), url)}`, fix: unreachable };
    }
    if (version === null) return { id: 'audit', status: 'ok', message: `${named} answers; its audit tables are made when the server first starts (version ${AUDIT_SCHEMA_VERSION})` };
    if (version !== AUDIT_SCHEMA_VERSION) {
      return {
        id: 'audit', status: 'fail', message: `${named}: its audit tables are version ${version}, and this server reads ${AUDIT_SCHEMA_VERSION}`,
        fix: version > AUDIT_SCHEMA_VERSION ? 'run the newer server, or point AUDIT_STORE at another database' : 'point AUDIT_STORE at a new database, or run the server that made them',
      };
    }
    try {
      await probeAuditWrite(sql);
    } catch (err) {
      return { id: 'audit', status: 'fail', message: `${named}: an entry could not be written: ${maskSecrets(dbMessage(err), url)}`, fix: 'give the user in AUDIT_STORE the right to read and insert into dw_audit_entries and dw_audit_anchors' };
    }
    return { id: 'audit', status: 'ok', message: `${named} answers, its audit tables are version ${version}, and an entry can be written (tried in a transaction undone): pnpm audit:verify reads it` };
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/** Check 12 with TRACE_STORE=s3://...: a small object written, read back and deleted, outside any call's folder. Never a key. */
async function traceStoreCheck(setting: S3TraceSetting, offline: boolean, deps: DoctorDeps): Promise<CheckResult> {
  const named = `TRACE_STORE ${describeTraceStore(setting)}`;
  if (offline) return { id: 'traces', status: 'skip', message: `${named}: not asked (--offline)` };
  const client = new S3Client(setting, { timeoutMs: ASK_MS, ...(deps.s3Fetch ? { fetch: deps.s3Fetch } : {}) });
  const key = `${setting.prefix}dw-diagnose-${randomBytes(4).toString('hex')}.txt`;
  const fix = 'check S3_ENDPOINT, S3_REGION, the bucket, and that S3_ACCESS_KEY_ID may put, get, list and delete under the prefix (and S3_FORCE_PATH_STYLE=on for a store such as MinIO)';
  try {
    await client.put(key, 'dialogwright diagnose\n');
    const back = await client.get(key);
    const listed = await client.list(key, { maxPages: 1 });
    await client.delete(key);
    if (back !== 'dialogwright diagnose\n') return { id: 'traces', status: 'fail', message: `${named}: a test object came back other than it was written`, fix };
    if (!listed.objects.some((o) => o.key === key)) return { id: 'traces', status: 'fail', message: `${named}: a test object was written but a listing does not show it`, fix };
    return { id: 'traces', status: 'ok', message: `${named} takes a test object, lists it, gives it back and deletes it: each server writes its calls' segments there` };
  } catch (err) {
    return { id: 'traces', status: 'fail', message: `${named}: ${err instanceof Error ? err.message : String(err)}`, fix };
  }
}

/** A database error as said: its message (a driver's names what failed), or its code when it has none. */
function dbMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  if (err.message !== '') return err.message;
  return typeof code === 'string' ? code : err.name;
}

/** What to look at when the session store's database does not answer. */
const UNREACHABLE_DB = 'check the host, the port, the database, the user and the password in SESSION_STORE, and that this machine may connect to it (the database\'s allowed hosts, a firewall)';

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

export const DOCTOR_USAGE = 'usage: [ENV_FILE=<path>[,<path>...]] pnpm diagnose [--app <name> | --host <file>] [--offline]   (ENV_FILE names a settings file other than <app>/.env, or for a host file the .env beside it; several, comma-separated, are read in turn, a later one winning)';

/**
 * The checks of a host file's apps (host.yaml: several apps on one server), after the server's own: the
 * numbers it names, each set, E.164 and its own; then, for each app, its own settings file and every
 * variable its YAML names, as the server will read it for that app (its own file's value, else the
 * server's), and the variables its own file sets that its YAML does not name (its code's, through ctx.env;
 * not the server's under a host). Names and lengths only,
 * never a value.
 */
export function hostChecks(host: ResolvedHost, env: Env, platform: NodeJS.Platform = process.platform): CheckResult[] {
  const out: CheckResult[] = [];
  try {
    const numbers = hostNumbers(host.numbers, host.apps.map((a) => a.id), env);
    out.push(numbers.length === 0
      ? { id: 'host', status: 'ok', message: `host.yaml names no number: every call reaches ${host.defaultApp}, the default` }
      : { id: 'host', status: 'ok', message: `host.yaml's numbers: ${numbers.map((n) => `${n.variable} (${n.app})`).join(', ')}, each set and its own; any other number reaches ${host.defaultApp}` });
    for (const twin of hostRouting({ apps: host.apps.map((a) => ({ id: a.id, app: {} as App, env: {}, own: [], ignored: [] })), numbers: host.numbers, defaultApp: host.defaultApp, env }).warnings) {
      out.push({ id: 'host', status: 'warn', message: twin, fix: 'deliver the number called in E.164 (the carrier\'s number settings), or give the two apps numbers that differ in their last ten digits' });
    }
  } catch (e) {
    out.push({ id: 'host', status: 'fail', message: `${e instanceof Error ? e.message : String(e)}: the server will not start`, fix: 'set the number in the server\'s settings file' });
  }
  const signIn = env.CHAT?.trim() === 'on' && env.CHAT_SIGNIN?.trim() === 'jwt';
  const audiences = new Map<string, string[]>();
  for (const app of host.apps) {
    const tag = (r: CheckResult): CheckResult => ({ ...r, message: `app ${app.id}: ${r.message}` });
    let own: Record<string, string> | null = null;
    if (existsSync(app.envFile)) {
      own = readEnvFile(app.envFile);
      out.push(tag(settingsFileCheck(app.envFile, platform)));
    } else if (app.envNamed) {
      out.push(tag({ id: 'settings', status: 'fail', message: `${app.envFile} does not exist`, fix: 'create it with the app\'s own variables, or take "env" out of host.yaml' }));
    }
    const read = appEnvironment(env, own, ownVariablesOf(app));
    out.push(...variableChecks(app.dir, read.env).map(tag));
    out.push(...wordingChecks(app.dir, read.env).map(tag));
    const server = serverConfigOf(env);
    if (server !== null) out.push(...languageChecks(app.dir, server).map(tag));
    // Its services' URLs, as host.yaml names them: each set to an http(s) URL, said by its host only.
    for (const [name, variable] of Object.entries(app.services)) {
      const url = read.env[variable]?.trim();
      let parsed: URL | null = null;
      try {
        parsed = url ? new URL(url) : null;
      } catch {
        parsed = null;
      }
      out.push(tag(parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        ? { id: 'variables', status: 'ok', message: `host.yaml's services.${name} reads ${variable}: set, ${parsed.host}` }
        : { id: 'variables', status: 'warn', message: `host.yaml's services.${name} reads ${variable}, which is ${url ? 'not an http(s) URL' : 'not set'}: the service's requests are answered with no result`, fix: `set ${variable} to the service's URL in the app's own settings file` }));
    }
    // With several apps, one with no transfer targets and no HANDOFF_NUMBER of its own hands off to the server's
    // (on a phone line: with none, VOICE_PROVIDERS=none, a handoff goes to the chat page).
    if (host.apps.length > 1 && server?.voiceProviders.length !== 0 && !hasTransfer(app.dir) && !read.own.includes('HANDOFF_NUMBER')) {
      out.push(tag({ id: 'handoff', status: 'warn', message: 'no transfer targets and no HANDOFF_NUMBER of its own: its handoffs go to the server\'s HANDOFF_NUMBER', fix: 'set HANDOFF_NUMBER in the app\'s own settings file, or give it transfer targets (app.yaml)' }));
    }
    if (signIn) {
      const key = `${read.env.CHAT_ISSUER ?? ''} ${read.env.CHAT_AUDIENCE ?? ''}`;
      audiences.set(key, [...(audiences.get(key) ?? []), app.id]);
      // Its own identity provider's keys, when its own settings file names them: an https URL, as the server's must be.
      if (read.own.includes('CHAT_JWKS_URL')) {
        const url = read.env.CHAT_JWKS_URL?.trim() ?? '';
        let https = false;
        try {
          https = new URL(url).protocol === 'https:';
        } catch {
          https = false;
        }
        out.push(tag(https
          ? { id: 'variables', status: 'ok', message: `its own chat sign-in: keys at ${new URL(url).host}${read.own.includes('CHAT_ISSUER') ? `, issuer ${read.env.CHAT_ISSUER}` : ', the server\'s issuer'}` }
          : { id: 'variables', status: 'fail', message: 'its own CHAT_JWKS_URL is not an https URL: the server will not start', fix: 'set CHAT_JWKS_URL in the app\'s own settings file to its identity provider\'s https JWKS URL' }));
        if (!read.own.includes('CHAT_ISSUER')) out.push(tag({ id: 'variables', status: 'warn', message: 'its own CHAT_JWKS_URL with the server\'s CHAT_ISSUER: a token from its own identity provider names that provider as its issuer', fix: 'set CHAT_ISSUER in the app\'s own settings file too' }));
      }
    }
    if (read.ignored.length > 0) {
      // A server setting left here (from before the host, say) does nothing: a warning. The rest is the
      // app's code's (ctx.env), not a fault. Names, never a value.
      const { warn, info } = ownSettingsLines(app.envFile, read.ignored);
      if (warn !== null) out.push(tag({ id: 'settings', status: 'warn', message: warn, fix: OWN_SERVER_SETTING_FIX }));
      if (info !== null) out.push(tag({ id: 'settings', status: 'ok', message: info }));
    }
  }
  for (const ids of audiences.values()) {
    if (ids.length > 1) out.push({ id: 'host', status: 'warn', message: `CHAT_SIGNIN=jwt: ${ids.join(', ')} take tokens for one audience, so a token for one's portal signs in at the others' chats`, fix: 'give each app its own CHAT_AUDIENCE in its own settings file' });
  }
  return out;
}

/** Whether an app folder's app.yaml has transfer targets (`transfer:`), read from the YAML alone. */
function hasTransfer(dir: string): boolean {
  try {
    const doc = parseYaml(readFileSync(join(dir, 'app.yaml'), 'utf8')) as { transfer?: unknown } | null;
    return doc?.transfer !== undefined && doc.transfer !== null;
  } catch {
    return false;
  }
}

/** The command; returns its exit code (0 nothing failed, 1 something did, 2 a command line it does not understand). */
export async function main(argv: readonly string[], io: DoctorIo, deps: DoctorDeps = defaultDoctorDeps): Promise<number> {
  let appName: string | undefined;
  let hostFlag: string | undefined;
  let envFileArg: string | undefined;
  let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--offline') offline = true;
    else if ((a === '--app' || a === '--env-file' || a === '--host') && argv[i + 1] !== undefined) {
      if (a === '--app') appName = argv[++i];
      else if (a === '--host') hostFlag = argv[++i];
      else envFileArg = argv[++i];
    } else {
      io.out(DOCTOR_USAGE);
      return 2;
    }
  }
  if (appName !== undefined && hostFlag !== undefined) {
    io.out('--app diagnoses one app and --host a host file\'s apps: give one of them');
    return 2;
  }
  const root = io.root ?? projectRoot(io.invokedFrom);
  // A host file (host.yaml: several apps on one server): --host, else HOST_FILE, else host.yaml beside the apps.
  const hostFile = appName === undefined ? hostFileOf(hostFlag, io.env, io.invokedFrom, root) : null;
  if (hostFile !== null) return hostMain(hostFile, envFileArg, offline, io, deps);
  const apps = workspaceApps(root);
  let app: WorkspaceApp | null = null;
  if (appName !== undefined) {
    app = findApp(apps, appName, io.invokedFrom);
    if (app === null) {
      io.out(`no app "${appName}" in this workspace`);
      return 2;
    }
  }
  // ENV_FILE (or --env-file) may name several files, comma-separated: read in turn, a later one winning.
  const named = envFileArg ?? (io.env.ENV_FILE?.trim() || undefined);
  let files: string[];
  if (named !== undefined) {
    try {
      files = resolveEnvFiles(named, io.invokedFrom);
    } catch (e) {
      io.out(formatResult({ status: 'fail', message: e instanceof Error ? e.message : String(e), fix: 'name a settings file: ENV_FILE=<path> pnpm diagnose, or several separated by commas' }));
      return 1;
    }
  } else {
    if (app === null) {
      const chosen = chooseApp(apps, undefined, io.invokedFrom, 'diagnose');
      if ('error' in chosen) {
        io.out(chosen.error);
        return 2;
      }
      app = chosen.app;
    }
    files = [join(app.dir, '.env')];
  }
  let fromFile: Record<string, string>;
  try {
    fromFile = readEnvFiles(files);
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
  io.out(`${app ? `${app.name}: ` : ''}settings from ${files.join(', ')}${offline ? ' (offline)' : ''}`);
  const results = [...files.map((f) => settingsFileCheck(f)), ...(await runDoctor({ env, cwd: app?.dir ?? io.invokedFrom, offline, ...(app ? { appDir: app.dir } : {}) }, deps))];
  for (const r of results) io.out(formatResult(r));
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const skipped = count('skip');
  io.out(`${results.length} checks: ${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail${skipped ? `, ${skipped} skipped` : ''}`);
  return count('fail') > 0 ? 1 : 0;
}

/** `pnpm diagnose` for a host file: the server's checks with its settings, then the host's and each app's. */
async function hostMain(hostFile: string, envFileArg: string | undefined, offline: boolean, io: DoctorIo, deps: DoctorDeps): Promise<number> {
  if (!existsSync(hostFile)) {
    io.out(formatResult({ status: 'fail', message: `no host file at ${hostFile}`, fix: 'name one with --host <file>, or HOST_FILE' }));
    return 1;
  }
  const { host, problems } = resolveHostFile(hostFile);
  if (host === null) {
    for (const p of problems) io.out(formatResult({ status: 'fail', message: `${p.file}:${p.line}:${p.column}  ${p.message}`, fix: p.fix }));
    return 1;
  }
  const named = envFileArg ?? (io.env.ENV_FILE?.trim() || undefined);
  let files: string[];
  let fromFile: Record<string, string>;
  try {
    files = named === undefined ? [join(host.dir, '.env')] : resolveEnvFiles(named, io.invokedFrom);
    fromFile = readEnvFiles(files);
  } catch (e) {
    io.out(formatResult({ status: 'fail', message: e instanceof Error ? e.message : String(e), fix: 'write the server\'s settings there (what every app shares), or name the file: ENV_FILE=<path> pnpm diagnose --host <file>' }));
    return 1;
  }
  const env: Env = { ...fromFile };
  for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
  io.out(`the apps of ${hostFile} (${host.apps.map((a) => a.id).join(', ')}): settings from ${files.join(', ')}${offline ? ' (offline)' : ''}`);
  const results = [...files.map((f) => settingsFileCheck(f)), ...(await runDoctor({ env, cwd: host.dir, offline }, deps)), ...hostChecks(host, env)];
  for (const r of results) io.out(formatResult(r));
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const skipped = count('skip');
  io.out(`${results.length} checks: ${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail${skipped ? `, ${skipped} skipped` : ''}`);
  return count('fail') > 0 ? 1 : 0;
}

/** `dialogwright diagnose`: the command with this process's output, environment and folder; returns its exit code. */
export function commandLine(argv: readonly string[]): Promise<number> {
  return main(argv, {
    out: (line) => console.log(line),
    env: process.env,
    invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
  });
}

// Run when invoked directly (tsx doctor.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await commandLine(process.argv.slice(2));
}

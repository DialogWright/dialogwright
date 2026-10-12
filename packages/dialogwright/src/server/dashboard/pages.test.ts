import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest, type DashboardDeps, type HealthAnswer, type InsightsAnswer, type KnowledgeApp } from './routes';
import { forgetSummaries } from './calls';
import { DayCounters, latencyOf, ServersSeen, verifyAudit, type HealthSource } from './health';
import { useTestkit } from '../../testing/apps';
import { writeFolderCall } from '../../testing/consoleCalls';
import { defaultAppId, getApp } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import type { KbPassage, KnowledgeBase } from '../../kb/types';
import { GENESIS, entryHash } from '../../audit/log';
import type { AuditEntry } from '../../audit/types';
import type { DashboardEvent } from './events';

/**
 * The console's pages of figures (server/dashboard/routes.ts): Insights for a range and an app, the
 * Knowledge page, the Health page and the audit verified on demand; each input checked, one Insights
 * read at a time per session, and nothing shown that the console may not (counts and durations).
 */

useTestkit();

const OPENER = 'my parcel never arrived';
const ACCOUNT = 'five five five zero one two three four';
const D = Date.parse('2026-09-18T15:00:00Z');
const DAY = [Date.parse('2026-09-18T00:00:00Z'), Date.parse('2026-09-18T23:59:59.999Z')] as const;

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'console-pages-'));
  dirs.push(d);
  return d;
}

async function serve(deps: Partial<DashboardDeps> & { bus?: DashboardBus } = {}): Promise<{ base: string; dir: string; bus: DashboardBus }> {
  const dir = deps.traceDir ?? tmp();
  const bus = deps.bus ?? new DashboardBus();
  server = createServer((req, res) => {
    if (!handleDashboardRequest(req, res, { traceDir: dir, enabled: true, ...deps, bus })) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, dir, bus };
}

const getJson = async <T>(url: string): Promise<T> => (await (await fetch(url)).json()) as T;

describe('Insights (/dashboard/insights)', () => {
  it('a range\'s figures from the traces: calls, containment, hang-ups and errors, transfers by reason, abandonment by step; redacted', async () => {
    const { base, dir } = await serve();
    await writeFolderCall(dir, 'CA_1', [OPENER, ACCOUNT], 'hangup', D, { from: '+15555550110' });
    await writeFolderCall(dir, 'CA_2', [OPENER, 'let me talk to a person'], 'handoff', D + 60_000, { from: '+15555550122' });
    await writeFolderCall(dir, 'CA_3', [OPENER], 'completed', D + 120_000);
    const res = await fetch(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const a = JSON.parse(text) as InsightsAnswer;
    expect(a.insights.totals).toMatchObject({ calls: 3, ended: 3, contained: 1, toPerson: 1, hungUp: 1, errors: 0 });
    expect(a.insights.transfers.map((r) => [r.key, r.value])).toEqual([['live-agent', 1]]);
    expect(a.insights.abandoned.map((r) => r.label)).toEqual(['Report a missing parcel · Date of birth']);
    expect(a.insights.carrier).toBeNull();
    expect(a.knowledge).toBeNull();
    for (const said of ['+1555', '5555550110', 'parcel never', 'talk to', 'five five']) expect(text).not.toContain(said);
  });

  it('the carrier\'s cost only with a rate set', async () => {
    const { base, dir } = await serve({ carrierRates: { twilio: 0.02 } });
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D);
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D + 1_000, { provider: 'telnyx' });
    // A call recorded before the carrier was logged names none: its minute is counted, not priced.
    await writeFolderCall(dir, 'CA_3', [OPENER], 'hangup', D + 2_000, { provider: null });
    const a = await getJson<InsightsAnswer>(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`);
    expect(a.insights.carrier).toEqual({ usd: 0.02, byCarrier: [{ carrier: 'twilio', minutes: 1, ratePerMin: 0.02, usd: 0.02 }], unpriced: 2 });
    expect(a.insights.totals.billedMinutes).toEqual({ twilio: 1, telnyx: 1, unknown: 1 });
  });

  it('refuses a range that is missing, backwards, malformed or longer than a quarter', async () => {
    const { base } = await serve();
    for (const q of ['', `?from=${DAY[0]}`, `?from=${DAY[1]}&to=${DAY[0]}`, '?from=abc&to=1', `?from=0&to=${93 * 86_400_000}`, `?from=-1&to=5`]) {
      const res = await fetch(`${base}/dashboard/insights${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it('one read at a time per session: a second while the first is held is refused (429), and goes once it answers', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const { base } = await serve({ holdInsights: () => (first ? ((first = false), held) : Promise.resolve()) });
    const one = fetch(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`)).status).toBe(429);
    release();
    expect((await one).status).toBe(200);
    expect((await fetch(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`)).status).toBe(200);
  });

  it('on a host: every app\'s calls, or the one `?app=` names; each row with its app', async () => {
    const a = tmp();
    const b = tmp();
    const app = getApp(defaultAppId());
    const { base } = await serve({ apps: [{ id: 'north', app: { ...app, brand: { name: 'North Line' } } as App, traceDir: a }, { id: 'south', app, traceDir: b }] });
    await writeFolderCall(a, 'CA_a', [OPENER], 'completed', D);
    await writeFolderCall(b, 'CA_b', [OPENER, 'let me talk to a person'], 'handoff', D);
    const all = await getJson<InsightsAnswer>(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}`);
    expect(all.insights.totals.calls).toBe(2);
    expect(all.insights.transfers.map((r) => r.app)).toEqual(['Example Parcels']);
    expect(all.insights.tasks.map((r) => r.app).sort()).toEqual(['Example Parcels', 'North Line']);
    const one = await getJson<InsightsAnswer>(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}&app=north`);
    expect(one.insights.totals.calls).toBe(1);
    expect(one.insights.transfers).toEqual([]);
    // An app the host does not run is no filter: every app.
    expect((await getJson<InsightsAnswer>(`${base}/dashboard/insights?from=${DAY[0]}&to=${DAY[1]}&app=nowhere`)).insights.totals.calls).toBe(2);
  });
});

describe('today\'s figures: the carrier\'s cost beside the model\'s when a rate is set', () => {
  it('null with no rate; the billed minutes at the rate with one', async () => {
    const plain = await serve();
    expect((await getJson<{ carrierUsd: number | null }>(`${plain.base}/dashboard/today?since=0`)).carrierUsd).toBeNull();
    server!.close();
    server = null;
    const rated = await serve({ carrierRates: { twilio: 0.5 } });
    await writeFolderCall(rated.dir, 'CA_1', [OPENER], 'hangup', Date.now() - 60_000);
    const t = await getJson<{ carrierUsd: number | null; billedMinutes: Record<string, number> }>(`${rated.base}/dashboard/today?since=${Date.now() - 3_600_000}`);
    expect(t.billedMinutes).toEqual({ twilio: 1 });
    expect(t.carrierUsd).toBe(0.5);
  });
});

/** A passage in a given state, as the loader gives it (only what the counts read). */
const passage = (id: string, freshness: KbPassage['freshness'], approved = true): KbPassage => ({ id, freshness, ...(approved ? { approval: { owner: 'Help desk', approvedBy: 'Dana Example', on: '2026-09-01', sourceHash: 'a', hash: `h-${id}` } } : {}) }) as unknown as KbPassage;

describe('Knowledge (/dashboard/knowledge)', () => {
  it('each app\'s passages by state as kb:status counts them, the drafts waiting, and the unanswered questions by nearest topic', async () => {
    const appDir = tmp();
    mkdirSync(join(appDir, 'kb', 'pending'), { recursive: true });
    writeFileSync(join(appDir, 'kb', 'pending', 'parking-fee.yaml'), 'id: parking-fee\n');
    writeFileSync(join(appDir, 'kb', 'pending', 'topics.yaml'), 'parking: { title: Parking }\n');
    const kb = {
      topics: { hours: { id: 'hours', title: 'Opening hours' }, pets: { id: 'pets', title: 'Pets on site' } },
      passages: { a: passage('a', 'fresh'), b: passage('b', 'fresh'), c: passage('c', 'source-changed'), d: passage('d', 'edited'), e: passage('e', 'unapproved', false) },
      approvalLog: { file: 'kb/approvals.jsonl', lines: [{ id: 'a', hash: 'h-a', from: 'passage' }] },
      defaultLocale: 'en-US',
    } as unknown as KnowledgeBase;
    const app = { ...getApp(defaultAppId()), knowledge: { kb } } as App;
    const { base } = await serve({ apps: [{ id: 'kbapp', app, traceDir: tmp(), dir: appDir }, { id: 'plain', app: getApp(defaultAppId()), traceDir: tmp() }] });
    const k = await getJson<{ days: number; apps: KnowledgeApp[] }>(`${base}/dashboard/knowledge?days=7`);
    expect(k.days).toBe(7);
    const [withKb, without] = k.apps;
    expect(withKb!.status).toEqual({ kind: 'kb', topics: 2, passages: { total: 5, fresh: 1, outside: 1, sourceChanged: 1, edited: 1, unapproved: 1 }, drafts: 1, proposedTopics: true });
    expect(withKb!.unanswered).toEqual({ total: 0, top: [] });
    expect(without!.status).toEqual({ kind: 'none', topics: 0, drafts: null, proposedTopics: null });
    // Days other than 7, 30 and 90 are 30.
    expect((await getJson<{ days: number }>(`${base}/dashboard/knowledge?days=1000`)).days).toBe(30);
  });
});

/** An audit day file of `n` chained entries, as audit/log.ts writes it. */
function auditFile(path: string, n: number): void {
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const rest = { seq: i, at: '2026-09-18T15:00:00.000Z', callId: `CA${i}`, channel: 'voice', type: 'note', detail: {}, prevHash: prev } as unknown as Omit<AuditEntry, 'hash'>;
    const hash = entryHash(rest);
    appendFileSync(path, JSON.stringify({ ...rest, hash }) + '\n');
    prev = hash;
  }
}

describe('Health (/dashboard/health) and the audit verified on demand', () => {
  it('this server and the others heard from, /health\'s numbers, the model\'s latency over the last hour, and today\'s reconnects and fallback dials', async () => {
    const bus = new DashboardBus();
    latencyOf(bus);
    const counters = new DayCounters(() => '2026-10-12');
    counters.count('reconnects');
    counters.count('fallbacks');
    counters.count('fallbacks');
    const seen = new ServersSeen();
    seen.heard('web-2-abcd', JSON.stringify({ calls: 3, chats: 1, reconnects: 4, fallbacks: 0, day: '2026-10-12', caller: '+15555550110' }));
    const health: HealthSource = {
      self: () => ({ server: 'web-1-1234', calls: 2, chats: 0, ...counters.now() }),
      numbers: () => ({ sessions: 2, retained: 1, disk: { traceBytes: 100, auditBytes: 50 } }),
      peers: () => seen.list(),
    };
    const { base } = await serve({ bus, health });
    bus.publish({ type: 'call_started', callSid: 'CA1', at: 1, from: '…0110', todayIso: '2026-10-12', thresholds: {} });
    for (const ms of [100, 200, 300, 400, 2_000]) bus.publish({ type: 'turn', callSid: 'CA1', at: 1, record: { questions: {}, timing: { askMs: ms } }, spoken: '' } as unknown as DashboardEvent);
    const h = await getJson<HealthAnswer>(`${base}/dashboard/health`);
    expect(h.servers.map((s) => [s.server, s.calls, s.reconnects, s.fallbacks, s.self])).toEqual([['web-1-1234', 2, 1, 2, true], ['web-2-abcd', 3, 4, 0, false]]);
    // What another server said is held to numbers: nothing else it sent is kept.
    expect(JSON.stringify(h)).not.toContain('5555550110');
    expect(h.shared).toBe(true);
    expect(h.numbers).toEqual({ sessions: 2, retained: 1, disk: { traceBytes: 100, auditBytes: 50 } });
    expect(h.latency).toEqual({ asks: 5, medianMs: 300, p95Ms: 2_000 });
    expect(h.audit).toEqual({ available: false, label: null, running: false, last: null });
    expect((await fetch(`${base}/dashboard/health/audit`)).status).toBe(404);
  });

  it('the audit verified, one at a time: day files intact, then one broken; the last result kept for the page', async () => {
    const audit = tmp();
    auditFile(join(audit, '2026-09-18.jsonl'), 1500);
    mkdirSync(join(audit, 'north'));
    auditFile(join(audit, 'north', '2026-09-18.jsonl'), 3);
    let runs = 0;
    const health: HealthSource = {
      self: () => ({ server: 's', calls: 0, chats: 0, reconnects: 0, fallbacks: 0, day: '' }),
      numbers: () => ({ sessions: 0, retained: 0 }),
      verify: () => { runs += 1; return verifyAudit({ dir: audit }); },
      auditLabel: audit,
    };
    const { base } = await serve({ health });
    const [x, y] = await Promise.all([getJson<{ ok: boolean; chains: number; entries: number }>(`${base}/dashboard/health/audit`), getJson<{ ok: boolean }>(`${base}/dashboard/health/audit`)]);
    expect(x).toMatchObject({ ok: true, kind: 'files', chains: 2, entries: 1503, breaks: [] });
    expect(y).toEqual(x);
    expect(runs).toBe(1);
    expect((await getJson<HealthAnswer>(`${base}/dashboard/health`)).audit).toMatchObject({ available: true, label: audit, running: false, last: { ok: true, entries: 1503 } });
    appendFileSync(join(audit, 'north', '2026-09-18.jsonl'), JSON.stringify({ seq: 4, prevHash: 'nope', hash: 'x' }) + '\n');
    const broken = await getJson<{ ok: boolean; breaks: string[] }>(`${base}/dashboard/health/audit`);
    expect(broken).toMatchObject({ ok: false, breaks: ['north/2026-09-18.jsonl: BROKEN at line 4 of 4 (broken link)'] });
  });

  it('today\'s counts start again on a new day', () => {
    let day = '2026-10-12';
    const c = new DayCounters(() => day);
    c.count('reconnects');
    expect(c.now()).toEqual({ reconnects: 1, fallbacks: 0, day: '2026-10-12' });
    day = '2026-10-13';
    expect(c.now()).toEqual({ reconnects: 0, fallbacks: 0, day: '2026-10-13' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest, type ConsoleApp, type DashboardDeps } from './routes';
import { forgetSummaries, listCalls, PAGE_SIZE } from './calls';
import { LiveCalls } from './live';
import type { CallRow } from './view.js';
import type { DashboardEvent } from './events';
import { scripted } from '../../testing/scripted';
import { defaultAppId, getApp } from '../../core/app/registry';
import { useTestkit } from '../../testing/apps';
import { FakeS3 } from '../../testing/fakeS3';
import { S3TraceStore, traceStoreSettingOf } from '../../trace/store';

/**
 * The console's new routes (server/dashboard/routes.ts): a call's own feed (`?call=`), the feed that
 * follows the newest call (as the console always has), the Live list's feed (`?view=calls`), the Calls
 * page's list (`/dashboard/calls`) and today's figures (`/dashboard/today`), each redacted as the
 * console already is: a number by its last four, no value a caller gave.
 */

useTestkit();

const OPENER = 'a parcel is missing, it was a small box left at the back door';
/** What the caller says for the account ID: its digits must never reach a list. */
const ACCOUNT_ID = 'five five five zero one two three four';
/** The number the scripted call's session start carries in full (testing/scripted.ts): never in a list. */
const WHOLE = '+15550000001';

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
});

async function serve(deps: Partial<DashboardDeps> & { bus: DashboardBus }): Promise<{ base: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'console-routes-'));
  dirs.push(dir);
  server = createServer((req, res) => {
    if (!handleDashboardRequest(req, res, { traceDir: dir, enabled: true, ...deps })) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, dir };
}

/** An event stream read as it comes: each block's event name and data. */
async function stream(url: string): Promise<{ blocks: () => { event: string; data: unknown }[]; until: (n: number) => Promise<void>; close: () => Promise<void> }> {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const blocks = (): { event: string; data: unknown }[] => buf.split('\n\n').slice(0, -1)
    .filter((b) => b.includes('data: '))
    .map((b) => ({ event: /^event: (\S+)$/m.exec(b)?.[1] ?? 'message', data: JSON.parse(b.split('data: ')[1]!) as unknown }))
    .filter((b) => b.event !== 'boot');
  const until = async (n: number): Promise<void> => {
    while (blocks().length < n) buf += dec.decode((await reader.read()).value, { stream: true });
  };
  return { blocks, until, close: () => reader.cancel() };
}

const started = (callSid: string, at: number, app?: string): DashboardEvent => ({ type: 'call_started', callSid, at, from: '…0110', todayIso: '2026-10-12', thresholds: {}, channel: 'voice', provider: 'twilio', ...(app ? { app } : {}) });
const dtmf = (callSid: string, digit: string): DashboardEvent => ({ type: 'dtmf', callSid, at: 2, digit });

describe('the live feed of one call, and of the newest', () => {
  it('?call=<id>: that call\'s history and events only', async () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1', 1));
    bus.publish(started('CA2', 2));
    bus.publish(dtmf('CA1', '4'));
    const { base } = await serve({ bus });
    const s = await stream(`${base}/dashboard/events?call=CA1`);
    try {
      await s.until(2);
      bus.publish(dtmf('CA2', '7'));
      bus.publish(dtmf('CA1', '5'));
      await s.until(3);
      expect(s.blocks().map((b) => [(b.data as DashboardEvent).type, (b.data as DashboardEvent).callSid])).toEqual([['call_started', 'CA1'], ['dtmf', 'CA1'], ['dtmf', 'CA1']]);
    } finally {
      await s.close();
    }
    expect((await fetch(`${base}/dashboard/events?call=..%2Fetc`)).status).toBe(404);
  });

  it('no query: the newest call, as the console always followed it, switching to each call that starts', async () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1', 1));
    bus.publish(started('CA2', 2));
    bus.publish(dtmf('CA1', '4'));
    const { base } = await serve({ bus });
    const s = await stream(`${base}/dashboard/events`);
    try {
      await s.until(1);
      bus.publish(dtmf('CA1', '5'));
      bus.publish(started('CA3', 3));
      bus.publish(dtmf('CA2', '6'));
      bus.publish(dtmf('CA3', '7'));
      await s.until(3);
      expect(s.blocks().map((b) => [(b.data as DashboardEvent).type, (b.data as DashboardEvent).callSid])).toEqual([['call_started', 'CA2'], ['call_started', 'CA3'], ['dtmf', 'CA3']]);
    } finally {
      await s.close();
    }
  });

  it('tells a viewer catching up on a call whose kept history was trimmed how many events it lost', async () => {
    const bus = new DashboardBus(3);
    bus.publish(started('CA1', 1));
    for (let i = 0; i < 5; i++) bus.publish(dtmf('CA1', String(i)));
    const { base } = await serve({ bus });
    const s = await stream(`${base}/dashboard/events?call=CA1`);
    try {
      await s.until(2);
      expect(s.blocks()[0]).toEqual({ event: 'missed', data: { count: 3 } });
      expect((s.blocks()[1]!.data as DashboardEvent).type).toBe('call_started');
    } finally {
      await s.close();
    }
  });

  it('on a host with ?app=: the newest of that app\'s calls', async () => {
    const bus = new DashboardBus();
    const app = getApp(defaultAppId());
    bus.publish(started('CA1', 1, 'one'));
    bus.publish(started('CA2', 2, 'two'));
    const apps: ConsoleApp[] = [{ id: 'one', app, traceDir: '/nowhere' }, { id: 'two', app, traceDir: '/nowhere' }];
    const { base } = await serve({ bus, apps });
    const s = await stream(`${base}/dashboard/events?app=one`);
    try {
      await s.until(1);
      bus.publish(started('CA3', 3, 'two'));
      bus.publish(dtmf('CA1', '5'));
      await s.until(2);
      expect(s.blocks().map((b) => (b.data as DashboardEvent).callSid)).toEqual(['CA1', 'CA1']);
    } finally {
      await s.close();
    }
  });
});

describe('the Live list\'s feed (?view=calls)', () => {
  it('sends every kept call\'s row, then each row that changed, then each call no longer kept; no value a caller gave', async () => {
    const bus = new DashboardBus(2000, 0);
    const { base } = await serve({ bus });
    // On the real clock: the list settles a call silent for half an hour as ended (view.js settledRow).
    const { events } = await scripted([OPENER, ACCOUNT_ID], { callSid: 'CA1', startMs: Date.now() });
    // The first two turns now, the rest once the viewer is watching.
    const cut = events.findIndex((e) => e.type === 'asked');
    for (const e of events.slice(0, cut)) bus.publish(e);
    bus.publish(started('CA2', Date.now()));
    const s = await stream(`${base}/dashboard/events?view=calls`);
    try {
      await s.until(1);
      const first = s.blocks()[0]!;
      expect(first.event).toBe('rows');
      expect((first.data as { rows: CallRow[] }).rows.map((r) => [r.callSid, r.status])).toEqual([['CA1', 'on-track'], ['CA2', 'on-track']]);
      for (const e of events.slice(cut)) bus.publish(e);
      await s.until(2);
      const changed = s.blocks().slice(1).filter((b) => b.event === 'row').map((b) => b.data as CallRow);
      expect(changed.at(-1)).toMatchObject({ callSid: 'CA1', from: '…0199', task: { label: 'Report a missing parcel' } });
      // A call that ends (and, with no room kept for ended calls, is dropped) leaves the list.
      bus.publish({ type: 'ended', callSid: 'CA2', at: 9, reason: 'hangup' });
      while (!s.blocks().some((b) => b.event === 'gone')) await s.until(s.blocks().length + 1);
      expect(s.blocks().find((b) => b.event === 'gone')!.data).toEqual({ callSid: 'CA2' });
    } finally {
      await s.close();
    }
  });

  it('carries no value a caller gave, and no whole number', async () => {
    const bus = new DashboardBus();
    const { events } = await scripted([OPENER, ACCOUNT_ID, 'april twelfth nineteen eighty five'], { callSid: 'CA1' });
    for (const e of events) bus.publish(e);
    const { base } = await serve({ bus });
    const s = await stream(`${base}/dashboard/events?view=calls`);
    try {
      await s.until(1);
      const text = JSON.stringify(s.blocks());
      expect(text).toContain('…0199');
      expect(text).not.toMatch(/5550|1234|1985|april|back door/i);
    } finally {
      await s.close();
    }
  });
});

/** Writes a scripted call's trace (raw, as the writer would) and a frame log that ends it as `end` says. */
async function writeCall(dir: string, callSid: string, steps: Parameters<typeof scripted>[0], end: 'hangup' | 'handoff' | 'completed' | 'none', startMs: number, from?: string): Promise<void> {
  const { records } = await scripted(steps, { callSid, startMs });
  const raw = records.map((r) => (from && r.event.type === 'session.start' ? { ...r, event: { ...r.event, provider: { ...r.event.provider, from } } } : r));
  writeFileSync(join(dir, `${callSid}.jsonl`), raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const last = new Date(startMs + 5_000 * steps.length + 1_000).toISOString();
  const frames = end === 'hangup' ? [{ ts: last, dir: 'log', msg: { socketClosed: true, ended: false } }]
    : end === 'handoff' || end === 'completed' ? [{ ts: last, dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: end === 'handoff' ? 'live-agent' : 'completed' }) } }]
      : [];
  writeFileSync(join(dir, `${callSid}.frames.jsonl`), frames.map((f) => JSON.stringify(f)).join('\n') + (frames.length ? '\n' : ''));
}

/** A day in the past, so a store's own write times (the real clock's) are after it, as a server's always are. */
const DAY = Date.parse('2026-09-18T15:00:00Z');

describe('the Live list on the server (live.ts)', () => {
  it('settles a call silent for half an hour as ended, so a server that stopped with it never leaves it in progress', async () => {
    let t = Date.parse('2026-10-12T15:00:00Z');
    const bus = new DashboardBus(2000, 20, 500, { now: () => t });
    const list = new LiveCalls(bus, () => null, () => t);
    bus.publish(started('CA1', t));
    expect(list.snapshot().map((r) => [r.callSid, r.status])).toEqual([['CA1', 'on-track']]);
    const changes: string[] = [];
    list.watch((c) => changes.push(c.type === 'row' ? `${c.row.callSid} ${c.row.status} ${c.row.ending?.text ?? ''}` : `gone ${c.callSid}`));
    t += 31 * 60_000;
    list.settleStale();
    expect(changes).toEqual(['CA1 ended no end recorded']);
    expect(bus.hasEnded('CA1')).toBe(true);
  });
});

describe('the Calls page\'s list (/dashboard/calls)', () => {
  it('lists past calls newest first, each with how it ended, filtered by the last four, the ending, the task and the dates; redacted', async () => {
    const bus = new DashboardBus();
    const { base, dir } = await serve({ bus });
    await writeCall(dir, 'CA_old', [OPENER, ACCOUNT_ID], 'hangup', DAY - 86_400_000, '+15555550110');
    await writeCall(dir, 'CA_mid', [OPENER, 'let me talk to a person'], 'handoff', DAY, '+15555550122');
    await writeCall(dir, 'CA_new', [], 'hangup', DAY + 60_000, '+15555550110');
    // Newest first by the last write.
    utimesSync(join(dir, 'CA_old.jsonl'), new Date(DAY - 86_000_000), new Date(DAY - 86_000_000));
    utimesSync(join(dir, 'CA_mid.jsonl'), new Date(DAY + 1_000), new Date(DAY + 1_000));
    utimesSync(join(dir, 'CA_new.jsonl'), new Date(DAY + 100_000), new Date(DAY + 100_000));
    const get = async (q: string) => (await (await fetch(`${base}/dashboard/calls${q}`)).json()) as { rows: CallRow[]; more: boolean; partial: boolean; pageSize: number };
    const all = await get('');
    expect(all.rows.map((r) => r.callSid)).toEqual(['CA_new', 'CA_mid', 'CA_old']);
    expect(all).toMatchObject({ more: false, partial: false, pageSize: PAGE_SIZE });
    expect(all.rows.map((r) => r.from)).toEqual(['…0110', '…0122', '…0110']);
    expect(all.rows[2]).toMatchObject({ ending: { kind: 'hangup', where: 'Report a missing parcel · Date of birth' }, tasks: [{ id: 'report_missing', label: 'Report a missing parcel' }] });
    expect(all.rows[1]).toMatchObject({ ending: { kind: 'person', reason: 'live-agent', text: 'to a person · caller asked for a person' } });
    expect(all.rows[0]).toMatchObject({ ending: { kind: 'hangup', where: 'the greeting' } });
    expect((await get('?last4=0110')).rows.map((r) => r.callSid)).toEqual(['CA_new', 'CA_old']);
    expect((await get('?ending=person')).rows.map((r) => r.callSid)).toEqual(['CA_mid']);
    expect((await get('?ending=hangup&task=report_missing')).rows.map((r) => r.callSid)).toEqual(['CA_old']);
    expect((await get(`?from=${DAY - 3_600_000}&to=${DAY + 3_600_000}`)).rows.map((r) => r.callSid)).toEqual(['CA_new', 'CA_mid']);
    // A malformed filter is not applied: it is no filter at all, never an error.
    expect((await get('?last4=12&ending=sideways&from=yesterday')).rows).toHaveLength(3);
    const text = JSON.stringify(all);
    expect(text).not.toContain('+1555');
    expect(text).not.toContain(WHOLE);
    expect(text).not.toMatch(/5550123|1234|back door/);
  });

  it('narrows a date range by the files\' last writes both ways: a day long ago is found without reading the newer calls', async () => {
    const bus = new DashboardBus();
    const { dir } = await serve({ bus });
    const old = DAY - 7 * 86_400_000;
    await writeCall(dir, 'CA_old', [], 'hangup', old);
    utimesSync(join(dir, 'CA_old.jsonl'), new Date(old + 10_000), new Date(old + 10_000));
    for (let i = 0; i < 30; i++) {
      await writeCall(dir, `CA_new${i}`, [], 'hangup', DAY);
      utimesSync(join(dir, `CA_new${i}.jsonl`), new Date(DAY + i), new Date(DAY + i));
    }
    const source = [{ id: null, app: getApp(defaultAppId()), traceDir: dir }];
    // Found among the old day's files alone: the newer ones, written after the range and a day, are never read.
    const found = await listCalls(source, { fromMs: old - 3_600_000, toMs: old + 3_600_000, page: 0 }, Date.now());
    expect(found.rows.map((r) => r.callSid)).toEqual(['CA_old']);
    expect(found.partial).toBe(false);
  });

  it('answers one search at a time per session: a second one while the first runs is refused (429)', async () => {
    const bus = new DashboardBus();
    const { base, dir } = await serve({ bus });
    for (let i = 0; i < 40; i++) await writeCall(dir, `CA_${i}`, [OPENER], 'hangup', DAY + i);
    const [a, b] = await Promise.all([fetch(`${base}/dashboard/calls?last4=0199`), fetch(`${base}/dashboard/calls?last4=0199`)]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect((await fetch(`${base}/dashboard/calls?last4=0199`)).status).toBe(200);
  });

  it('pages', async () => {
    const bus = new DashboardBus();
    const { base, dir } = await serve({ bus });
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      const sid = `CA_${String(i).padStart(2, '0')}`;
      await writeCall(dir, sid, [], 'hangup', DAY + i * 1_000);
      utimesSync(join(dir, `${sid}.jsonl`), new Date(DAY + i * 1_000), new Date(DAY + i * 1_000));
    }
    const first = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: CallRow[]; more: boolean };
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.more).toBe(true);
    expect(first.rows[0]!.callSid).toBe(`CA_${PAGE_SIZE + 1}`);
    const second = (await (await fetch(`${base}/dashboard/calls?page=1`)).json()) as { rows: CallRow[]; more: boolean };
    expect(second.rows.map((r) => r.callSid)).toEqual(['CA_01', 'CA_00']);
    expect(second.more).toBe(false);
  });

  it('on a host: every app\'s calls with the app on each row, or one app\'s with ?app=', async () => {
    const bus = new DashboardBus();
    const a = mkdtempSync(join(tmpdir(), 'console-a-'));
    const b = mkdtempSync(join(tmpdir(), 'console-b-'));
    dirs.push(a, b);
    const app = getApp(defaultAppId());
    const { base } = await serve({ bus, apps: [{ id: 'one', app, traceDir: a }, { id: 'two', app, traceDir: b }] });
    await writeCall(a, 'CA_a', [], 'hangup', DAY);
    await writeCall(b, 'CA_b', [], 'hangup', DAY);
    const all = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: (CallRow & { appName?: string })[] };
    expect(all.rows.map((r) => [r.callSid, r.app]).sort()).toEqual([['CA_a', 'one'], ['CA_b', 'two']]);
    const one = (await (await fetch(`${base}/dashboard/calls?app=two`)).json()) as { rows: CallRow[] };
    expect(one.rows.map((r) => r.callSid)).toEqual(['CA_b']);
  });
});

describe('the Calls page on the trace store (TRACE_STORE=s3://...)', () => {
  it('lists the store\'s calls through the one reader, narrowed by the day folders, each with how it ended; redacted', async () => {
    const keys = { accessKeyId: 'AKIDCONSOLECALLS', secretAccessKey: 'a-secret-the-fake-store-checks' };
    const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: keys });
    try {
      const setting = traceStoreSettingOf({ TRACE_STORE: 's3://call-traces/prod/traces', S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: keys.accessKeyId, S3_SECRET_ACCESS_KEY: keys.secretAccessKey, S3_FORCE_PATH_STYLE: 'on' })!;
      // Near the real clock: the store's own write times are the real clock's, as a server's are.
      const near = Date.now() - 3_600_000;
      for (const [sid, startMs] of [['CA_s1', near - 3 * 86_400_000], ['CA_s2', near]] as const) {
        const { records } = await scripted([OPENER], { callSid: sid, startMs });
        // The frame log on the call's own clock, after its last turn, as a server writes it.
        const store = new S3TraceStore(setting, { server: 'a-1', now: () => startMs + 20_000 });
        const sinks = store.open(sid, () => ({ turn: 1, gen: 0, startedAtMs: startMs, held: true }));
        for (const r of records) sinks.trace.write(r.event.type === 'session.start' ? { ...r, event: { ...r.event, provider: { ...r.event.provider, from: '+15555550133' } } } : r);
        sinks.frames.write('log', { socketClosed: true, ended: false });
        await store.flush();
      }
      const { base } = await serve({ bus: new DashboardBus(), traces: new S3TraceStore(setting, { server: 'reader' }).reader() });
      const all = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: CallRow[] };
      expect(all.rows.map((r) => r.callSid).sort()).toEqual(['CA_s1', 'CA_s2']);
      expect(all.rows.map((r) => [r.from, r.ending?.kind])).toEqual([["…0133", "hangup"], ["…0133", "hangup"]]);
      expect(JSON.stringify(all)).not.toContain('+1555');
      const ranged = (await (await fetch(`${base}/dashboard/calls?from=${near - 3_600_000}&to=${near + 3_600_000}`)).json()) as { rows: CallRow[] };
      // A range a week back: its day folders hold nothing, and nothing written since is read.
      const before = s3.requests.length;
      const old = (await (await fetch(`${base}/dashboard/calls?from=${near - 9 * 86_400_000}&to=${near - 8 * 86_400_000}`)).json()) as { rows: CallRow[] };
      expect(old.rows).toEqual([]);
      expect(s3.requests.slice(before).filter((r) => r.method === 'GET' && /\.jsonl/.test(r.key)).length).toBe(0);
      expect(ranged.rows.map((r) => r.callSid)).toEqual(['CA_s2']);
    } finally {
      await s3.close();
    }
  });
});

describe('today\'s figures (/dashboard/today)', () => {
  it('counts the calls that started since the viewer\'s midnight, how many a person took, and the model\'s cost', async () => {
    const bus = new DashboardBus();
    const { base, dir } = await serve({ bus });
    await writeCall(dir, 'CA_y', [OPENER], 'hangup', DAY - 86_400_000);
    await writeCall(dir, 'CA_1', [OPENER, 'let me talk to a person'], 'handoff', DAY);
    await writeCall(dir, 'CA_2', [OPENER], 'hangup', DAY + 1_000);
    await writeCall(dir, 'CA_3', [OPENER], 'completed', DAY + 2_000);
    // Each file last written as its call ended: yesterday's before the viewer's midnight, so it is never read.
    for (const [sid, at] of [['CA_y', DAY - 86_000_000], ['CA_1', DAY + 10_000], ['CA_2', DAY + 11_000], ['CA_3', DAY + 12_000]] as const) utimesSync(join(dir, `${sid}.jsonl`), new Date(at), new Date(at));
    const today = (await (await fetch(`${base}/dashboard/today?since=${DAY - 3_600_000}`)).json()) as { calls: number; ended: number; toPerson: number; containment: number; costUsd: number };
    // Containment is the calls the agent handled to the end: a hang-up is not counted as handled.
    expect(today).toMatchObject({ calls: 3, ended: 3, toPerson: 1, hungUp: 1, errors: 0, contained: 1 });
    expect(today.containment).toBeCloseTo(1 / 3);
    expect(today.costUsd).toBeGreaterThan(0);
    // Kept: a poll a moment later is answered without reading the traces again, until a call ends.
    await writeCall(dir, 'CA_4', [OPENER], 'completed', DAY + 3_000);
    utimesSync(join(dir, 'CA_4.jsonl'), new Date(DAY + 13_000), new Date(DAY + 13_000));
    const again = (await (await fetch(`${base}/dashboard/today?since=${DAY - 3_600_000}`)).json()) as { calls: number };
    expect(again.calls).toBe(3);
    bus.publish(started('CA_4', DAY));
    bus.publish({ type: 'ended', callSid: 'CA_4', at: DAY, reason: 'completed' });
    const after = (await (await fetch(`${base}/dashboard/today?since=${DAY - 3_600_000}`)).json()) as { calls: number; contained: number };
    expect(after).toMatchObject({ calls: 4, contained: 2 });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest, type DashboardDeps } from './routes';
import { forgetSummaries } from './calls';
import { replayHref, traceName, type CallRow } from './view.js';
import type { DashboardEvent } from './events';
import { safeFileStem } from '../fileStem';
import { writeFolderCall } from '../../testing/consoleCalls';
import { defaultAppId, getApp } from '../../core/app/registry';
import { useTestkit } from '../../testing/apps';

/**
 * A call is found by its trace's name (live findings, 2026-10-14): a trace is written as
 * `<safeFileStem(callId)>.jsonl`, and a Telnyx call id holds a colon (`v3:...`), so its trace is
 * `v3_....jsonl`. Every lookup of a call by its id maps the id the same way: the replay route on the
 * server, and the page's links to a replay (view.js `traceName`, which mirrors safeFileStem exactly).
 */

useTestkit();

/** An invented Telnyx call control id: `v3:` and an opaque token. */
const TELNYX = 'v3:6FrQ7inventedCallControlIdForTheConsoleTests0000';
const STEM = 'v3_6FrQ7inventedCallControlIdForTheConsoleTests0000';
const D = Date.parse('2026-10-14T15:00:00Z');

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'console-trace-name-'));
  dirs.push(d);
  return d;
}

async function serve(deps: Partial<DashboardDeps> & { traceDir: string }): Promise<string> {
  const bus = deps.bus ?? new DashboardBus();
  server = createServer((req, res) => {
    if (!handleDashboardRequest(req, res, { enabled: true, ...deps, bus })) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

/** The id and the query a page's address names, as page.html's addressOf reads `#/replay/<id>?<query>`. */
function addressOf(hash: string): { name: string; id: string | null; query: URLSearchParams } {
  const h = hash.replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const [name, ...rest] = (q < 0 ? h : h.slice(0, q)).split('/');
  return { name: name!, id: rest.length ? decodeURIComponent(rest.join('/')) : null, query: new URLSearchParams(q < 0 ? '' : h.slice(q + 1)) };
}

describe('the page\'s traceName mirrors the server\'s safeFileStem', () => {
  it('on a Telnyx id, a Twilio id, dots, an id longer than 64 and an empty one', () => {
    const samples = [TELNYX, 'v3:abc', `CA${'0123456789abcdef'.repeat(2)}`, 'CA1.frames', '../etc/passwd', `v3:${'x'.repeat(80)}`, '', 'chat-5550100'];
    for (const id of samples) expect(traceName(id)).toBe(safeFileStem(id));
    expect(traceName(TELNYX)).toBe(STEM);
  });
});

describe('a Telnyx call\'s replay, by its call id', () => {
  it('on a server of one app: /dashboard/traces/<call id> answers the trace named by its stem', async () => {
    const dir = tmp();
    await writeFolderCall(dir, TELNYX, ['my parcel never arrived'], 'hangup', D);
    expect(existsSync(join(dir, `${STEM}.jsonl`))).toBe(true);
    const base = await serve({ traceDir: dir });
    const res = await fetch(`${base}/dashboard/traces/${encodeURIComponent(TELNYX)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { sessionId: string }[]; frames: unknown[] };
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records[0]!.sessionId).toBe(TELNYX);
    expect(body.frames.length).toBeGreaterThan(0);
    // By its stem, as the replay picker lists it, it is the same trace.
    expect((await fetch(`${base}/dashboard/traces/${STEM}`)).status).toBe(200);
    // The check is still the boundary: what is not a call's trace is not found.
    expect((await fetch(`${base}/dashboard/traces/..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${base}/dashboard/traces/v3%3Anothere`)).status).toBe(404);
  });

  it('on a host: /dashboard/traces/<call id>?app=<id> answers the trace in that app\'s folder', async () => {
    const a = tmp();
    const b = tmp();
    const app = getApp(defaultAppId());
    await writeFolderCall(b, TELNYX, ['my parcel never arrived'], 'hangup', D);
    const base = await serve({ traceDir: a, apps: [{ id: 'north', app, traceDir: a }, { id: 'south', app, traceDir: b }] });
    const res = await fetch(`${base}/dashboard/traces/${encodeURIComponent(TELNYX)}?app=south`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { sessionId: string }[]; app: string };
    expect(body.app).toBe('south');
    expect(body.records[0]!.sessionId).toBe(TELNYX);
    // Without the app named, it is still found in the app that has it.
    expect((await fetch(`${base}/dashboard/traces/${encodeURIComponent(TELNYX)}`)).status).toBe(200);
    expect((await fetch(`${base}/dashboard/traces/${encodeURIComponent(TELNYX)}?app=north`)).status).toBe(404);
  });

  it('the Calls page\'s row opens a replay that reaches the trace, on a host and on one app', async () => {
    for (const host of [true, false]) {
      const dir = tmp();
      const app = getApp(defaultAppId());
      await writeFolderCall(dir, TELNYX, ['my parcel never arrived'], 'hangup', D);
      const base = await serve(host ? { traceDir: dir, apps: [{ id: 'south', app, traceDir: dir }] } : { traceDir: dir });
      const { rows } = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: CallRow[] };
      expect(rows).toHaveLength(1);
      // The row names the call by its id, as the trace's records do.
      expect(rows[0]!.callSid).toBe(TELNYX);
      const href = replayHref(rows[0]!);
      const a = addressOf(href);
      expect(a.name).toBe('replay');
      expect(a.id).toBe(STEM);
      const byApp = a.query.get('app');
      expect(byApp).toBe(host ? 'south' : null);
      // What the page fetches for that address.
      const res = await fetch(`${base}/dashboard/traces/${encodeURIComponent(a.id!)}${byApp ? `?app=${encodeURIComponent(byApp)}` : ''}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { records: unknown[] }).records.length).toBeGreaterThan(0);
      // The replay picker's list names the same trace, so the selection matches a row of it.
      const list = (await (await fetch(`${base}/dashboard/traces`)).json()) as { callSid: string }[];
      expect(list.map((r) => r.callSid)).toContain(a.id);
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it('a Twilio call\'s link is as it was', () => {
    const sid = `CA${'0123456789abcdef'.repeat(2)}`;
    expect(replayHref({ callSid: sid } as CallRow)).toBe(`#/replay/${sid}`);
    expect(replayHref({ callSid: sid, app: 'north' } as CallRow)).toBe(`#/replay/${sid}?app=north`);
  });
});

describe('a Telnyx call\'s live feed, by its trace\'s name', () => {
  it('/dashboard/events?call=<traceName(call id)>, as the page asks for it, streams that call\'s events', async () => {
    const bus = new DashboardBus();
    const started: DashboardEvent = { type: 'call_started', callSid: TELNYX, at: 1, from: '…0110', todayIso: '2026-10-14', thresholds: {}, channel: 'voice', provider: 'telnyx' };
    bus.publish({ type: 'call_started', callSid: 'v3:another', at: 0, from: '…0111', todayIso: '2026-10-14', thresholds: {}, channel: 'voice', provider: 'telnyx' });
    bus.publish(started);
    bus.publish({ type: 'dtmf', callSid: TELNYX, at: 2, digit: '4' });
    const base = await serve({ traceDir: tmp(), bus });
    const res = await fetch(`${base}/dashboard/events?call=${encodeURIComponent(traceName(TELNYX))}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events = (): DashboardEvent[] => buf.split('\n\n').slice(0, -1)
      .filter((b) => b.includes('data: ') && !/^event: /m.test(b))
      .map((b) => JSON.parse(b.split('data: ')[1]!) as DashboardEvent);
    try {
      while (events().length < 2) buf += dec.decode((await reader.read()).value, { stream: true });
      expect(events().map((e) => [e.type, e.callSid])).toEqual([['call_started', TELNYX], ['dtmf', TELNYX]]);
    } finally {
      await reader.cancel();
    }
    // The name is still the boundary: what is not one is refused.
    expect((await fetch(`${base}/dashboard/events?call=..%2Fetc`)).status).toBe(404);
  });
});

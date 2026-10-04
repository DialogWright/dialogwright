import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { BOOT_ID, handleDashboardRequest } from './routes';
import { consoleMetaOf } from './meta';
import { defaultAppId, getApp } from '../../core/app/registry';
import { useTestkit } from '../../testing/apps';

useTestkit();

function serve(bus: DashboardBus, traceDir: string) {
  const server = createServer((req, res) => {
    const handled = handleDashboardRequest(req, res, { bus, traceDir, enabled: true });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe('dashboard routes', () => {
  it('serves the page and the view module with no-store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(new DashboardBus(), dir);
    const page = await fetch(`${s.base}/dashboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const js = await fetch(`${s.base}/dashboard/view.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toBe('no-store');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams history then live events over SSE', async () => {
    const bus = new DashboardBus();
    bus.publish({ type: 'call_started', callSid: 'CA1', at: 1, from: '…0199', todayIso: '2026-09-21', thresholds: {} });
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(bus, dir);
    const res = await fetch(`${s.base}/dashboard/events`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    // One decoder for the whole stream, in streaming mode: a multi-byte character (the `…` of a
    // masked number) can be split across two reads, and a fresh decoder per read would corrupt it.
    const dec = new TextDecoder();
    let buf = '';
    // The last block is whatever has arrived of the event still in flight; only whole ones parse.
    const events = () => buf.split('\n\n').slice(0, -1)
      .filter((b) => b.includes('data: ') && !b.startsWith('event: boot'))
      .map((b) => JSON.parse(b.split('data: ')[1]!) as { type: string });
    const readUntil = async (n: number) => {
      while (events().length < n) buf += dec.decode((await reader.read()).value, { stream: true });
    };
    try {
      await readUntil(1);
      bus.publish({ type: 'dtmf', callSid: 'CA1', at: 2, digit: '1' });
      await readUntil(2);
      expect(events().map((e) => e.type)).toEqual(['call_started', 'dtmf']);
      expect(buf).toMatch(/^id: 1\n/m);
      // The named boot event comes first, carrying this process's id; the page reloads when it changes.
      expect(buf).toContain(`event: boot\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
      expect(buf.indexOf('event: boot')).toBeLessThan(buf.indexOf('id: 1'));
    } finally {
      await reader.cancel();
    }
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the trace of a Telnyx call by its file stem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const stem = 'v2_T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ';
    const rec = { v: 1, sessionId: stem, turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: '+15555550199', to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, `${stem}.jsonl`), JSON.stringify(rec) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const res = await fetch(`${s.base}/dashboard/traces/${stem}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(1);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists traces and returns one with its frames; refuses a bad sid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA9', turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: '+15555550199', to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, 'CA9.jsonl'), JSON.stringify(rec) + '\n');
    writeFileSync(join(dir, 'CA9.frames.jsonl'), JSON.stringify({ ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'setup', callSid: 'CA9', from: '+15555550199', to: '+15550000002' } }) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json();
    expect(list).toEqual([{ callSid: 'CA9', startedAt: '2026-09-21T00:00:00.000Z', turns: 1, sizeBytes: expect.any(Number) }]);
    const one = await (await fetch(`${s.base}/dashboard/traces/CA9`)).json() as {
      records: { event: { type: string; provider?: { from?: string; to?: string } }; spokenText: string }[];
      frames: { msg: { from?: string } }[];
    };
    expect(one.records).toHaveLength(1);
    expect(one.frames).toHaveLength(1);
    // The route is unauthenticated, so neither the setup record nor the raw setup frame may carry
    // the caller's whole number, and the page never has to render a decision itself.
    // A v1 record (its event the setup frame) is upgraded to the session start it was, then redacted.
    expect(one.records[0]!.event).toMatchObject({ type: 'session.start', provider: { from: '…0199', to: '…0002' } });
    expect(one.frames[0]!.msg).toMatchObject({ from: '…0199' });
    expect(one.records[0]!.spokenText).toMatch(/\S/);
    expect((await fetch(`${s.base}/dashboard/traces/..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/traces/CA404`)).status).toBe(404);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts turns in the listing as the console does, not trace records: a keyed code is one turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = (turnIndex: number, event: Record<string, unknown>) => JSON.stringify({ v: 1, sessionId: 'CA5', turnIndex, ts: `2026-09-21T00:00:0${turnIndex}.000Z`, event, decision: { kind: 'ignore' }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} });
    // The greeting, a spoken turn, then six digits of a code: the digits share turn 3.
    const lines = [rec(1, { type: 'setup' }), rec(2, { type: 'prompt', voicePrompt: 'parcel status' }), ...Array.from({ length: 6 }, () => rec(3, { type: 'dtmf', digit: '•' }))];
    writeFileSync(join(dir, 'CA5.jsonl'), lines.join('\n') + '\n');
    const s = await serve(new DashboardBus(), dir);
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json() as { callSid: string; turns: number }[];
    expect(list).toMatchObject([{ callSid: 'CA5', turns: 3 }]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a record whose decision cannot render an empty spokenText', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA8', turnIndex: 1, ts: '2026-09-21T00:00:00.000Z', event: { type: 'prompt' }, decision: { kind: 'prompt', promptId: 'no-such-prompt-id', vars: {}, acks: [] } };
    writeFileSync(join(dir, 'CA8.jsonl'), JSON.stringify(rec) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const one = await (await fetch(`${s.base}/dashboard/traces/CA8`)).json() as { records: { spokenText: string }[] };
    expect(one.records[0]!.spokenText).toBe('');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a truncated trailing line rather than failing the trace', async () => {
    // What a killed process leaves behind: the last line was half-written.
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA7', turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: '+15555550199', to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, 'CA7.jsonl'), JSON.stringify(rec) + '\n' + '{"v":1,"sessionId":"CA7","turnIn');
    writeFileSync(join(dir, 'CA7.frames.jsonl'), JSON.stringify({ ts: '2026-09-21T00:00:00.000Z', dir: 'log', msg: { socketClosed: true } }) + '\n' + '{"ts":"2026');
    const s = await serve(new DashboardBus(), dir);
    const one = await fetch(`${s.base}/dashboard/traces/CA7`);
    expect(one.status).toBe(200);
    const body = await one.json() as { records: unknown[]; frames: unknown[] };
    expect(body.records).toHaveLength(1);
    expect(body.frames).toHaveLength(1);
    // The listing counts the turns it could parse, and does not blow up on the partial one.
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json() as { callSid: string; turns: number }[];
    expect(list).toMatchObject([{ callSid: 'CA7', turns: 1 }]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a JSON null (or array, or scalar) line rather than failing the trace', async () => {
    // A line that parses but isn't a plain object would otherwise reach redactRecord and throw --
    // as malformed, for this route's purposes, as a line that doesn't parse at all.
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA6', turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: '+15555550199', to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, 'CA6.jsonl'), [JSON.stringify(rec), 'null', '[1,2,3]', '"just a string"', '42'].join('\n') + '\n');
    const s = await serve(new DashboardBus(), dir);
    const one = await fetch(`${s.base}/dashboard/traces/CA6`);
    expect(one.status).toBe(200);
    const body = await one.json() as { records: unknown[] };
    expect(body.records).toHaveLength(1);
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json() as { callSid: string; turns: number }[];
    expect(list).toMatchObject([{ callSid: 'CA6', turns: 1 }]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists nothing when the trace directory does not exist yet', async () => {
    // Nothing creates the directory until the first call, so a fresh checkout hits this.
    const dir = join(mkdtempSync(join(tmpdir(), 'dash-')), 'not-created-yet');
    const s = await serve(new DashboardBus(), dir);
    const res = await fetch(`${s.base}/dashboard/traces`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect((await fetch(`${s.base}/dashboard/traces/CA1`)).status).toBe(404);
    s.close();
  });

  it('answers HEAD on the page and the view module with headers and no body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(new DashboardBus(), dir);
    const page = await fetch(`${s.base}/dashboard`, { method: 'HEAD' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(Number(page.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await page.text()).toBe('');
    const js = await fetch(`${s.base}/dashboard/view.js`, { method: 'HEAD' });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toBe('');
    // Everything else is still refused.
    expect((await fetch(`${s.base}/dashboard`, { method: 'POST' })).status).toBe(405);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not handled when disabled', async () => {
    const server = createServer((req, res) => {
      const handled = handleDashboardRequest(req, res, { bus: new DashboardBus(), traceDir: tmpdir(), enabled: false });
      res.writeHead(handled ? 200 : 404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/dashboard`)).status).toBe(404);
    server.close();
  });

  it('answers the boot id for a page in Replay mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(new DashboardBus(), dir);
    const res = await fetch(`${s.base}/dashboard/boot`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bootId: BOOT_ID, app: consoleMetaOf(getApp(defaultAppId())) });
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

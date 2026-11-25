import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest, type ReplayRecord } from './routes';
import { forgetSummaries } from './calls';
import { factsOfTrace } from './figures';
import { reduce, replayEvents, scriptOf, type CallRow } from './view.js';
import type { FrameLogLine } from '../frameLog';
import type { DashboardEvent } from './events';
import { scripted } from '../../testing/scripted';
import { useTestkit } from '../../testing/apps';
import { defaultAppId, getApp } from '../../core/app/registry';
import type { TraceRecord } from '../../trace/types';

/**
 * A call the old agent mode took (app.yaml `mode: agent` with a business.yaml, taken out in plan 3), read
 * from its trace after the mode is gone: its records hold the fields that mode wrote (`agent`, `filler`,
 * `timing.agentMs`, a decision's `agent` line), which nothing reads now. The call still lists on the Calls
 * page and its call view opens, by the fields every call has (the caller's words, the lines said, the
 * slots, the ending, the decision model's cost); its agent-only detail is no longer shown (decision 5).
 */

useTestkit();

const START = Date.parse('2026-11-09T15:00:00Z');
const CALL = 'CA_old_agent';
const STEPS = ['a parcel is missing, it was a small box left at the back door', 'let me talk to a person'];

/** What a turn of the old agent mode added to its record, as that mode's trace record types held it. */
function oldAgentFields(r: TraceRecord, i: number): Record<string, unknown> {
  if (r.event.type === 'session.start') return {};
  return {
    timing: { ...r.timing, agentMs: 420 },
    decision: { ...r.decision, agent: { reply: 'Happy to help with that.' } },
    agent: {
      ms: 420,
      use: i === 1 ? 'used' : 'dropped',
      ...(i === 1 ? {} : { dropped: 'handoff' }),
      values: [{ field: 'item', slot: 'item', value: 'a small box', words: 'a small box', outcome: 'accepted', shown: 'a small box' }],
      reply: 'Happy to help with that.',
      action: 'none',
      fromFacts: false,
      replySaid: i === 1,
      line: { promptId: r.decision.kind === 'prompt' ? r.decision.promptId : 'agent', mode: 'generated', fixed: 'What was it?', said: 'Happy to help with that.', source: 'agent', judge: { score: 0.04, refuseAt: 0.5 } },
      usage: { inputTokens: 900, outputTokens: 40 },
      costUsd: 0.25,
      sent: { form: null, fields: [], actions: ['submit'], conversation: [{ who: 'caller', text: 'a parcel is missing' }], caller: { account: null }, channel: 'voice', overLine: false, today: '2026-11-09' },
    },
    filler: { promptId: 'agent_wait_1', atMs: 1203, said: true },
  };
}

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
});

async function serve(): Promise<{ base: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'old-agent-'));
  dirs.push(dir);
  const bus = new DashboardBus();
  server = createServer((req, res) => {
    if (!handleDashboardRequest(req, res, { bus, traceDir: dir, enabled: true })) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, dir };
}

/** The old call's trace and frame log, as its server wrote them: ended by a handoff to a person. */
async function writeOldAgentCall(dir: string): Promise<TraceRecord[]> {
  const { records } = await scripted(STEPS, { callSid: CALL, startMs: START });
  const raw = records.map((r, i) => ({ ...r, ...oldAgentFields(r, i) }) as TraceRecord);
  const end = START + 5_000 * STEPS.length + 1_000;
  writeFileSync(join(dir, `${CALL}.jsonl`), raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const frames = [
    { ts: new Date(START).toISOString(), dir: 'log', msg: { provider: 'twilio' } },
    { ts: new Date(end).toISOString(), dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: 'live-agent' }) } },
  ];
  writeFileSync(join(dir, `${CALL}.frames.jsonl`), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  utimesSync(join(dir, `${CALL}.jsonl`), end / 1000, end / 1000);
  utimesSync(join(dir, `${CALL}.frames.jsonl`), end / 1000, end / 1000);
  return raw;
}

describe('an old agent-mode trace in the console', () => {
  it('an old agent-mode trace lists and opens in the console', async () => {
    const { base, dir } = await serve();
    const raw = await writeOldAgentCall(dir);
    expect(raw.filter((r) => 'agent' in r)).toHaveLength(2);

    // The Calls page lists it by the fields every call has.
    const listed = await fetch(`${base}/dashboard/calls`);
    expect(listed.status).toBe(200);
    const { rows } = (await listed.json()) as { rows: CallRow[] };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callSid: CALL, from: '…0001', status: 'with-person', ending: { kind: 'person', reason: 'live-agent' } });
    expect(rows[0]!.turns).toBeGreaterThan(0);

    // Its call view opens: the caller's words and the lines said, with no agent detail and no error.
    const opened = await fetch(`${base}/dashboard/traces/${CALL}`);
    expect(opened.status).toBe(200);
    const one = (await opened.json()) as { records: ReplayRecord[]; frames: FrameLogLine[]; deliveries: DashboardEvent[] };
    expect(one.records).toHaveLength(raw.length);
    const v = reduce(replayEvents(one.records, one.frames, { deliveries: one.deliveries }), { fromTrace: true });
    expect(v.lines.filter((l) => l.kind === 'caller').map((l) => l.text)).toEqual(STEPS);
    const said = v.lines.filter((l) => l.kind === 'system');
    expect(said.length).toBeGreaterThan(0);
    for (const l of said) expect(l.text).toMatch(/\S/);
    expect(v.lines.some((l) => 'agent' in l)).toBe(false);
    expect(v.turnCount).toBeGreaterThan(0);
    // The decision model's cost only: the old agent model's (costUsd 0.25 a turn) is agent-only detail.
    expect(v.totals.usd).toBeLessThan(0.25);
    const script = scriptOf(v.lines, v.turnsView);
    expect(script.filter((l) => l.who === 'caller').map((l) => l.text)).toEqual(STEPS);
    expect(script.some((l) => 'agent' in l)).toBe(false);

    // Insights counts it as any call, with no figures of the agent model.
    const facts = factsOfTrace(raw, getApp(defaultAppId()));
    expect(facts).not.toHaveProperty('agent');
  });
});

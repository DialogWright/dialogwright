import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scripted, type Step } from './scripted';
import { S3TraceStore, type S3TraceSetting } from '../trace/store';
import type { FrameDir } from '../server/frameLog';

/**
 * Calls that happened, written as a server writes them, for the console's tests (the Calls page,
 * Insights and its daily figures cache): a scripted call's trace (raw, as the writer writes it) and a
 * frame log that ends it as `end` says, in a trace folder with the files' times at the call's end, or as
 * segments on a trace store. Not a test file; the default app's (the testkit unless a test registers another).
 */

export type CallEnd = 'hangup' | 'handoff' | 'completed' | 'none';

export interface WrittenCall {
  /** The number its session start carries in full (the console shows only its last four). */
  from?: string;
  /** The handoff's reason code (`end: 'handoff'`), default `live-agent`. */
  reason?: string;
}

/** The frame lines that end a call as `end` says, at `at`. */
function endFrames(end: CallEnd, at: string, reason: string): { ts: string; dir: string; msg: unknown }[] {
  if (end === 'hangup') return [{ ts: at, dir: 'log', msg: { socketClosed: true, ended: false } }];
  if (end === 'handoff' || end === 'completed') return [{ ts: at, dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: end === 'handoff' ? reason : 'completed' }) } }];
  return [];
}

/** A call's trace and frame log in a trace folder, last written as the call ended (5 s a step, and a second). */
export async function writeFolderCall(dir: string, callSid: string, steps: Step[], end: CallEnd, startMs: number, o: WrittenCall = {}): Promise<void> {
  const { records } = await scripted(steps, { callSid, startMs });
  const raw = records.map((r) => (o.from && r.event.type === 'session.start' ? { ...r, event: { ...r.event, provider: { ...r.event.provider, from: o.from } } } : r));
  const endMs = startMs + 5_000 * steps.length + 1_000;
  const trace = join(dir, `${callSid}.jsonl`);
  const frames = join(dir, `${callSid}.frames.jsonl`);
  writeFileSync(trace, raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const lines = endFrames(end, new Date(endMs).toISOString(), o.reason ?? 'live-agent');
  writeFileSync(frames, lines.map((f) => JSON.stringify(f)).join('\n') + (lines.length ? '\n' : ''));
  utimesSync(trace, endMs / 1000, endMs / 1000);
  utimesSync(frames, endMs / 1000, endMs / 1000);
}

/** The same call as segments on a trace store (its folder under the day it started). */
export async function writeStoreCall(setting: S3TraceSetting, callSid: string, steps: Step[], end: CallEnd, startMs: number, o: WrittenCall = {}): Promise<void> {
  const { records } = await scripted(steps, { callSid, startMs });
  const store = new S3TraceStore(setting, { server: 'a-1', now: () => startMs + 5_000 * steps.length + 1_000 });
  const sinks = store.open(callSid, () => ({ turn: 1, gen: 0, startedAtMs: startMs, held: true }));
  for (const r of records) sinks.trace.write(o.from && r.event.type === 'session.start' ? { ...r, event: { ...r.event, provider: { ...r.event.provider, from: o.from } } } : r);
  for (const f of endFrames(end, '', o.reason ?? 'live-agent')) sinks.frames.write(f.dir as FrameDir, f.msg);
  await store.flush();
}

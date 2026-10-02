/**
 * Scripted calls for the dashboard: a real run through the real observer and the real bus, so the
 * events are the ones the page receives -- the observer's `asked`/`turn` (with the redacted record
 * and the spoken line) plus the moments the adapter publishes itself.
 *
 * Not a test file: the console's view tests build their fixtures from here, and a by-hand check of the
 * page can import the same function to produce an event list without placing a call. It runs against
 * the default app (the one a test registers, testkit by default); the steps are the app's.
 */
import { CODE_DIGIT, runTurn, type RunOptions } from '../run/turn';
import { sensitiveDigit, type SensitiveDigit } from '../core/turn';
import { newSession, type Session } from '../core/session';
import { keyEvents, silenceEvent, speechEvent, startEvent } from '../channel/events';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { defaultCorpusFile } from '../run/client';
import { defaultAppId, getApp } from '../core/app/registry';
import { spokenText } from '../prompts/render';
import type { TraceRecord } from '../trace/types';
import type { SessionStore } from '../server/sessions';
import { DashboardBus, type PublishedEvent } from '../server/dashboard/bus';
import { makeObserver } from '../server/dashboard/observer';
import { redactRecord } from '../server/dashboard/events';
import { redactRecordSlots } from '../trace/redact';
import { upgradeTraceRecord } from '../trace/read';
import { GENESIS, entryHash } from '../audit/log';
import type { AuditDraft, AuditEntry } from '../audit/types';
import type { AuditSink } from '../run/turn';
import { followEffects } from '../harness-text/runner';
import { VOICE_RELAY } from '../channel/caps';

export const TODAY = '2026-09-18';
export const CALL = 'CA1';
/** What the page shows instead of a caller number; the bus is handed the masked form. */
export const FROM = '…0199';

export type Step = string | { dtmf: string } | { silence: true };

export interface ScriptedOptions {
  /** Defaults to the fixture corpus with the heuristic stub behind it. */
  client?: RunOptions['client'];
  callSid?: string;
  /**
   * Chain each turn's audit drafts in memory, so the events include the observer's `audit` batches
   * as a live call's do. Off by default: the replay tests compare event lists, and a trace never
   * carries these.
   */
  audit?: boolean;
  /**
   * Answer a downstream service's effect straight away, as the scenario runner does (followEffects); the answer is a turn of its own. Off by default, so a scripted call
   * ends on the turn that left the effect, as the view tests expect.
   */
  services?: boolean;
  /** The call's clock at the start, in epoch ms; each step is five seconds after the last. */
  startMs?: number;
  /** The masked caller number the bus is handed (default FROM). */
  from?: string;
}

/**
 * The server's AuditLog without the file: the same hash chain (seq from 1, GENESIS first), kept in
 * memory. For the scripted calls here and the dashboard demo feed, which must not write the real log.
 */
export class MemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  append(callId: string, channel: string, d: AuditDraft): AuditEntry {
    const last = this.entries.at(-1);
    const base = { ...d, seq: (last?.seq ?? 0) + 1, at: new Date(this.now()).toISOString(), callId, channel, prevHash: last?.hash ?? GENESIS };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    this.entries.push(entry);
    return entry;
  }
}

/** The corpus is read from disk, so one client is shared by every scripted call in a process. */
let shared: RunOptions['client'] | null = null;
function defaultClient(): RunOptions['client'] {
  shared ??= new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  return shared;
}

export interface Scripted {
  events: PublishedEvent[];
  records: TraceRecord[];
}

/** Runs `steps` as one call, five seconds apart, and returns everything both consumers saw. */
export async function scripted(steps: Step[], options: ScriptedOptions = {}): Promise<Scripted> {
  const callSid = options.callSid ?? CALL;
  const events: PublishedEvent[] = [];
  const records: TraceRecord[] = [];
  const bus = new DashboardBus();
  bus.subscribe((e) => events.push(e));
  let session: Session = newSession(callSid, 0, VOICE_RELAY);
  // makeObserver reads the live turn counter through the store, exactly as the server wires it.
  const store = { get: () => ({ session }) } as unknown as SessionStore;
  let t = options.startMs ?? 1_000;
  const opts: RunOptions = {
    client: options.client ?? defaultClient(),
    thresholds: { ...DEFAULT_THRESHOLDS },
    todayIso: TODAY,
    // One system of record for the whole call, as the server shares one: a record filed on one turn
    // is there on the next.
    tools: demoTools(),
    now: () => t,
    observe: makeObserver(bus, store, callSid),
    audit: options.audit ? new MemoryAuditLog(() => t) : null,
  };
  const step = async (frame: Parameters<typeof runTurn>[1], sensitive?: SensitiveDigit): Promise<void> => {
    const run = await runTurn(session, frame, opts, sensitive === undefined ? undefined : { sensitive });
    records.push(run.record);
    session = run.result.session;
    if (!options.services) return;
    for (const next of await followEffects(run, opts)) {
      records.push(next.record);
      session = next.result.session;
    }
  };
  bus.publish({ type: 'call_started', callSid, at: t, from: options.from ?? FROM, todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS, channel: session.channel, caller: null });
  // What the voice adapter starts a call with (frameToEvent of Twilio's setup), caller number and all:
  // the page must never render it.
  await step(startEvent({ sessionId: callSid, callSid: `CA-${callSid}`, from: '+15550000001', to: '+15550000002' }));
  for (const s of steps) {
    t += 5_000;
    if (typeof s === 'string') await step(speechEvent(s));
    else if ('dtmf' in s) {
      for (const f of keyEvents(s.dtmf)) {
        // As the adapter does: a digit of the code, account ID or birth date is published as keyed, never as itself.
        const sensitive = sensitiveDigit(session, f);
        bus.publish({ type: 'dtmf', callSid, at: t, digit: sensitive !== null ? CODE_DIGIT : f.digit });
        await step(f, sensitive);
      }
    } else {
      bus.publish({ type: 'silence', callSid, at: t, promptId: session.lastPromptId });
      await step(silenceEvent());
    }
  }
  return { events, records };
}

/**
 * What `/dashboard/traces/<sid>` hands the page: the record as the trace writer wrote it (identity
 * slots masked, the statement by its length), redacted again by the route, plus the line the caller heard.
 */
export function replayRecords(records: TraceRecord[]): Array<TraceRecord & { spokenText: string }> {
  // A trace record does not carry its session's app, so a stored trace is read as the default app's.
  const app = getApp(defaultAppId());
  return records.map((raw) => {
    const r = redactRecord(redactRecordSlots(upgradeTraceRecord(raw), 'length'));
    return { ...r, spokenText: spokenText(app, r.decision, r.locale) };
  });
}

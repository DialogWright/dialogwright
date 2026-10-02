import type { SessionEvent } from '../channel/events';
import type { Session } from '../core/session';
import type { AuditEntry } from '../audit/types';
import { runTurn, type AuditSink, type RunOptions } from '../run/turn';
import { appOf } from '../core/app/registry';
import { spokenText } from '../prompts/render';
import { resolveService, type ServiceUrls } from './services';
import { summarizeHandoff as summarizeHandoffDefault } from '../handoff/summary';
import type { DashboardBus } from './dashboard/bus';

/** What a chat session keeps between turns, whichever chat it is. */
export interface ChatTurnEntry {
  readonly id: string;
  session: Session;
  /** The session's audit entries as chained: each turn's are pushed, the handoff summary reads them. */
  readonly auditEntries: AuditEntry[];
  readonly opts: RunOptions;
  lastActivityMs: number;
}

export interface ChatTurnDeps {
  audit: AuditSink;
  bus?: DashboardBus;
  /** Where each of the app's downstream services is reached (adapter.ts AdapterDeps.serviceUrls). */
  serviceUrls?: ServiceUrls;
  log: (line: string) => void;
  anthropicApiKey?: string | null;
  handoffSummaryOn?: boolean;
  /** Tests replace the Claude Haiku call. */
  summarizeHandoff?: typeof summarizeHandoffDefault;
  /** Tests replace the turn runner, to hand the chat a turn result it cannot otherwise produce. */
  runTurn?: typeof runTurn;
}

/**
 * One turn, then what it left for the channel to do; returns what the person is shown, in order.
 * `handoffTo` is who the console says a handoff goes to (the app's chat names its own desk).
 */
export async function runChatTurn(d: ChatTurnDeps, entry: ChatTurnEntry, event: SessionEvent, now: () => number, handoffTo: string): Promise<string[]> {
  entry.lastActivityMs = now();
  const out: string[] = [];
  const r = await (d.runTurn ?? runTurn)(entry.session, event, entry.opts);
  entry.session = r.result.session;
  // Kept on the session's own entry whether or not the console is on: the handoff summary reads it.
  entry.auditEntries.push(...r.audit);
  const text = spokenText(appOf(entry.session), r.result.decision);
  if (text) out.push(text);
  const decision = r.result.decision;
  if (decision.kind === 'handoff') {
    d.bus?.publish({ type: 'handoff', callSid: entry.id, at: now(), reason: decision.reason, number: handoffTo });
    fireHandoffSummary(d, entry, now);
  }
  if (decision.kind === 'handoff' || decision.kind === 'complete') {
    d.bus?.publish({ type: 'ended', callSid: entry.id, at: now(), reason: decision.kind === 'complete' ? 'completed' : 'handoff' });
    return out;
  }
  // A downstream service's answer (to work a tool handed it this turn): awaited here,
  // since a chat reply can wait for it where a caller on the phone would hear silence (the voice
  // adapter queues it as a turn instead).
  for (const effect of r.result.effects) {
    if (effect.kind !== 'service' || entry.session.ended) continue;
    const answer = await resolveService(appOf(entry.session), effect, d.serviceUrls);
    out.push(...(await runChatTurn(d, entry, answer, now, handoffTo)));
  }
  return out;
}

export function fireHandoffSummary(d: ChatTurnDeps, entry: ChatTurnEntry, now: () => number): void {
  const apiKey = d.anthropicApiKey ?? null;
  const enabled = (d.handoffSummaryOn ?? true) && apiKey !== null;
  const summarize = d.summarizeHandoff ?? summarizeHandoffDefault;
  const summary = enabled ? summarize(entry.auditEntries, { apiKey: apiKey! }, appOf(entry.session).handoff) : Promise.resolve(null);
  void summary
    .then((text) => {
      d.bus?.publish({ type: 'handoff_summary', callSid: entry.id, at: now(), text });
      const words = text === null ? 0 : text.trim().split(/\s+/).filter(Boolean).length;
      const entryOut = d.audit.append(entry.id, 'chat', { type: 'handoff_summary', detail: { generated: text !== null, words } });
      entry.auditEntries.push(entryOut);
    })
    .catch((err: unknown) => d.log(`chat ${entry.id}: handoff summary failed: ${err instanceof Error ? err.message : String(err)}`));
}

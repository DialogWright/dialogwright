import type { QuestionMap } from '../../jev/types';
import type { TurnState } from '../../core/state';
import type { TraceRecord } from '../../trace/types';
import type { Thresholds } from '../../core/thresholds';
import type { FrameLogLine } from '../frameLog';
import type { AuditEntry } from '../../audit/types';
import { consoleKbSource, redactHandoffData, redactRecordSlots } from '../../trace/redact';

interface Base { callSid: string; at: number }

export type DashboardEvent =
  /**
   * `channel` and `caller` are optional so an older publisher (a test, a stored fixture) still
   * satisfies the type; the view treats a missing one as 'voice' / null, which is what every
   * publisher before this sent anyway. For chat, `caller` names who is chatting (an app's chat says how); for
   * voice it is always null -- the dashboard route is unauthenticated and never shows the
   * caller's own name. `provider` is a voice call's carrier (`twilio`, say), absent for chat.
   */
  | (Base & { type: 'call_started'; from: string; todayIso: string; thresholds: Partial<Thresholds>; channel?: string; provider?: string; caller?: string | null })
  /**
   * `turnIndex` is the index the record of the turn now starting will carry -- except on a turn
   * that resolves to ignore or hold, where `bookkeep` does not increment the session's counter and
   * this is therefore one ahead of the `turn` event that follows. Pair an `asked` with its `turn`
   * by arrival order (the bus preserves it), never by index.
   */
  | (Base & { type: 'asked'; turnIndex: number; questions: QuestionMap; turnState: TurnState })
  /**
   * `spoken` is the line the caller heard on this turn, as the observer renders it live. The
   * replay route (routes.ts) computes the same string from the trace record and calls it
   * `spokenText` there instead (see `ReplayRecord`), since a stored record has no `spoken` field
   * of its own.
   */
  | (Base & { type: 'turn'; record: TraceRecord; spoken: string })
  | (Base & { type: 'silence'; promptId: string | null })
  | (Base & { type: 'dtmf'; digit: string })
  /** A turn's audit entries, as chained: already free of PHI (core/audit.ts). */
  | (Base & { type: 'audit'; entries: readonly AuditEntry[] })
  | (Base & { type: 'interrupt'; utteranceUntilInterrupt: string | null })
  | (Base & { type: 'reconnect'; attempt: number })
  | (Base & { type: 'handoff'; reason: string; number: string })
  /**
   * Claude Haiku's note for the human agent (src/handoff/summary.ts); null when no key or the switch
   * is off. `demo` is set only by an app's scripted console demo, whose text is scripted, not written
   * by a model: the card says so. Live calls never set it.
   */
  | (Base & { type: 'handoff_summary'; text: string | null; demo?: boolean })
  | (Base & { type: 'ended'; reason: 'completed' | 'hangup' | 'handoff' | 'error' });

export type DashboardEventType = DashboardEvent['type'];

/** The last four digits only; the page never shows a whole caller number. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  const digits = n.replace(/\D/g, '');
  return `…${digits.slice(-4)}`;
}

/**
 * Caller identity travels under a handful of names that Twilio spells differently per surface --
 * `from`/`to` on the setup frame, `From`/`To`/`Caller`/`Called` on the `/cr-action` form post --
 * and the dashboard route is unauthenticated, so redaction works by key name on any object rather
 * than by frame type. These are matched case-insensitively.
 */
const MASK_KEYS = new Set(['from', 'to', 'caller', 'called', 'forwardedfrom']);
/** Masked to a fixed string rather than to digits: a name has nothing worth keeping. */
const NAME_KEYS = new Set(['callername']);
/** Dropped outright; the account id identifies the Twilio account, not the call. */
const DROP_KEYS = new Set(['accountsid']);
/** `FromCity`, `CallerState`, `ToZip`, `CalledCountry`, ... -- the geo lookup Twilio attaches. */
const DROP_SUFFIXES = ['city', 'state', 'zip', 'country'];
/** A session start's provider details carry each Twilio custom parameter under this prefix (channel/relay/map.ts frameToEvent). */
const PARAM_PREFIX = 'param.';
/** Real frames and form posts are shallow; the bound is only there so a cycle cannot hang a request. */
const MAX_DEPTH = 6;

/**
 * Walks `value` and returns a structurally identical copy with the caller-identity keys masked or
 * dropped at every level. Every other key, and every non-object value, is passed through unchanged.
 *
 * Exported for the frame log's own write sites (adapter.ts's setup frame, http.ts's `/cr-action`
 * form post): both hold the caller's whole number, and masking there means the number never
 * touches disk at all, rather than only being hidden when the dashboard reads it back.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // By the key's last dotted segment: a session start's provider details carry a custom
    // parameter `from` as `param.from` (channel/relay/map.ts frameToEvent).
    const k = key.toLowerCase().split('.').pop()!;
    if (DROP_KEYS.has(k) || DROP_SUFFIXES.some((s) => k.endsWith(s))) continue;
    if (typeof v === 'string' && NAME_KEYS.has(k)) out[key] = 'redacted';
    else if (typeof v === 'string' && MASK_KEYS.has(k)) out[key] = maskNumber(v);
    // Every other custom parameter (`param.*`): the core never reads them, so none is worth showing.
    else if (typeof v === 'string' && key.toLowerCase().startsWith(PARAM_PREFIX)) out[key] = 'redacted';
    else out[key] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * The dashboard route is unauthenticated, and a session start's event carries the raw setup
 * frame's details (its `provider`: the caller's whole number, city, account id and custom parameters). Only `event` is walked by key: it is the one inbound
 * part of the record, and `turnState` would itself trip the `State` suffix rule. The identity slots
 * are masked wherever the record carries them (redactRecordSlots), as each slot's spec says: an
 * identifier to its last four, a date to its year. A slot redacted only by length stays, because
 * the console shows the caller's words; the audit log never has them.
 */
export function redactRecord(record: TraceRecord): TraceRecord {
  const slots = redactRecordSlots(record, 'keep');
  // Whom a passage answered (the caller's facts) only as policy.yaml's audit: declares each fact.
  const kb = slots.kb ? { kb: consoleKbSource(slots.kb) } : {};
  return { ...slots, ...kb, event: redactDeep(slots.event) as TraceRecord['event'] };
}

/**
 * The frame-log counterpart of {@link redactRecord}, for `/dashboard/traces/<sid>`'s raw frame
 * lines. Applied to every line whatever its `dir`: the `/cr-action` form post that `http.ts` logs
 * carries no `type` and spells the caller's number four different ways.
 */
export function redactFrameLine(line: FrameLogLine): FrameLogLine {
  const msg = redactDeep(line.msg);
  // The `end` frame's handoff data carries what the call collected, identity slots included.
  if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'end') {
    const end = msg as { handoffData?: unknown };
    if (typeof end.handoffData === 'string') return { ...line, msg: { ...end, handoffData: redactHandoffData(end.handoffData, 'keep') } };
  }
  return { ...line, msg };
}

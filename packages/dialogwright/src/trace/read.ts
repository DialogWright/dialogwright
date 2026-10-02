import type { InboundFrame, OutboundFrame } from '../channel/relay/frames';
import { frameToEvent, isInboundFrameType } from '../channel/relay/map';
import { endAction, sayAction, transferAction, type Action, type SayPart } from '../channel/actions';
import type { TraceRecord } from './types';

/**
 * A trace record as read back from disk, in the current shape. A v1 record (written before the
 * channel event model) carried the ConversationRelay frame the turn ran on and the frames it sent;
 * its event is that frame's SessionEvent and its actions are those frames read back as actions.
 * Any other record is returned as it is.
 */
export function upgradeTraceRecord(raw: unknown): TraceRecord {
  const r = raw as Record<string, unknown>;
  const event = r.event as { type?: unknown } | null | undefined;
  // A record whose event is not a frame this build knows is returned as it is, never half-upgraded.
  if (r.v !== 1 || typeof event !== 'object' || event === null || !isInboundFrameType(event.type)) return raw as TraceRecord;
  const frame = event as InboundFrame;
  const { frames, ...rest } = r;
  return { ...rest, v: 2, event: frameToEvent(frame), actions: Array.isArray(frames) ? framesToActions(frames as OutboundFrame[]) : [] } as unknown as TraceRecord;
}

/**
 * The actions a v1 record's frames were sent for. Consecutive text and play frames with the same
 * `interruptible` are one `say` (a v1 record no longer knows where one prompt ended and the next
 * began; the relay sends the same frames either way). An `end` frame is a transfer unless it is a
 * plain completion.
 */
export function framesToActions(frames: readonly OutboundFrame[]): Action[] {
  const actions: Action[] = [];
  for (const f of frames) {
    if (f.type === 'text' || f.type === 'play') {
      const part: SayPart = f.type === 'text' ? { text: f.token } : { audio: f.source };
      const last = actions.at(-1);
      if (last?.type === 'say' && last.interruptible === f.interruptible) last.parts.push(part);
      else actions.push(sayAction([part], f.interruptible));
    } else if (f.type === 'end') actions.push(endOf(f.handoffData));
    else if (f.type === 'sendDigits') actions.push({ type: 'send_digits', digits: f.digits });
    else if (f.type === 'language') actions.push({ type: 'set_language', tts: f.ttsLanguage, transcription: f.transcriptionLanguage });
    // Any other frame type is not one this build knows how to read back as an action: skipped.
  }
  return actions;
}

/** An end frame's handoff data read back: what was completed, queued and collected, and why. */
function endOf(handoffData: string): Action {
  let d: { reasonCode?: unknown; completed?: unknown; queued?: unknown; slots?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(handoffData);
    if (typeof parsed === 'object' && parsed !== null) d = parsed;
  } catch {
    // An unreadable end is still the end of the call.
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const reason = typeof d.reasonCode === 'string' ? d.reasonCode : 'completed';
  const slots: Record<string, string> = {};
  if (typeof d.slots === 'object' && d.slots !== null) for (const [k, v] of Object.entries(d.slots)) if (typeof v === 'string') slots[k] = v;
  const queued = strings(d.queued);
  // Only a plain completion is an end: anything carrying queued forms or slots is kept whole as a transfer.
  if (reason === 'completed' && queued.length === 0 && Object.keys(slots).length === 0) return endAction(strings(d.completed));
  return transferAction(reason, strings(d.completed), queued, slots);
}

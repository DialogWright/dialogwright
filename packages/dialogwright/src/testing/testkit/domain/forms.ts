import type { AppContext, Completion, CompletionContext, EntryContext, FormDef, Refused } from '../../../core/app/types';
import { blockAck } from '../../../core/lifecycle';
import { handoff, prompt, type Decision } from '../../../core/decision';
import { describeDay } from '../../../core/extract/date';
import type { Ack } from '../../../core/fia';
import type { Session } from '../../../core/session';
import type { GateDecision, Principal, ToolCall } from '../../../gate/types';
import { reportFact, setAccountFact, setParcelsFact, setReportFact } from './facts';
import type { TestkitForm } from './intents';
import { dayPartDisplay } from './slots/shared';
import type { AccountView, ParcelView } from './systems';
import type { TestkitTool, TestkitToolValues } from './tools';

/** A call through the gate, its value typed. */
function call<T extends TestkitTool>(c: AppContext, toolCall: ToolCall & { tool: T }): { decision: GateDecision; value: TestkitToolValues[T] | null } {
  return c.callTool(toolCall) as { decision: GateDecision; value: TestkitToolValues[T] | null };
}

/** The verified customer's account ID; '' for anyone else, which the gate never lets past R1 or R2. */
export function accountIdOf(s: Session): string {
  return s.principal.kind === 'customer' ? s.principal.id : '';
}

/** A refused call's line: someone else's parcel (in staff terms for staff), or a role that may not report. */
export function blockPromptId(reason: string | undefined, p: Principal): string | null {
  if (reason === 'scope') return p.kind === 'agent' ? 'parcel_blocked_scope_agent' : 'parcel_blocked_scope';
  if (reason === 'role') return 'report_blocked_role';
  return null;
}

/** The values a report is filed with: exactly R3's fields. */
export function reportParams(s: Session): { accountId: string; missingNote: string; expectedDate: string } {
  return { accountId: accountIdOf(s), missingNote: s.slots.missingNote!.value ?? '', expectedDate: s.slots.expectedDate!.value ?? '' };
}

/**
 * Staff may not report for a customer through the line: the report is probed (an 'entry-check',
 * evaluated, never run) before a single question, so a viewer hears why and a clerk goes to a person.
 */
function staffReportCheck(c: EntryContext): Decision | Refused | null {
  const { s } = c;
  const { decision } = call(c, { tool: 'createReport', params: {}, purpose: 'entry-check' });
  if (decision.rules.some((r) => r.id === 'R5' && r.pass)) return null;
  const acks = c.acks.filter((a) => a.promptId !== 'ack_intent');
  if (decision.verdict === 'BLOCK') {
    const ack = blockAck(s, decision.reason);
    if (ack) return { kind: 'refused', acks: [...acks, ack] };
  }
  if (decision.verdict === 'NEEDS_HUMAN' && decision.reason === 'role-person') return handoff(s, 'role-person', acks);
  return handoff(s, 'needs-human', acks);
}

/** Tracking: the parcel looked up by the gate. Someone else's, or none, is refused alike (R2). */
function trackParcel(c: CompletionContext): Completion {
  const { s, acks } = c;
  const { decision, value } = call(c, { tool: 'getParcel', params: { parcel: s.slots.parcelSelect!.value ?? '' } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  if (!value) return { kind: 'refused', acks: [...acks, blockAck(s, 'scope')!] };
  return { kind: 'said', acks: [...acks, { promptId: `parcel_status_${value.status}`, vars: { parcel: value.number, item: value.item, day: describeDay(value.day) } }] };
}

/** A delivery window: whether one is open on the day and part of the day asked for. */
function deliveryWindow(c: CompletionContext): Completion {
  const { s, acks } = c;
  const day = s.slots.deliveryDay!.value ?? '';
  const part = s.slots.deliveryPart!.value ?? '';
  const { decision, value } = call(c, { tool: 'getWindows', params: { accountId: accountIdOf(s), deliveryDay: day, deliveryPart: part } });
  if (decision.verdict !== 'ALLOW' || value === null) return c.refusal(decision);
  const vars = { part: dayPartDisplay(part), day: describeDay(day) };
  return { kind: 'said', acks: [...acks, { promptId: value.open ? 'window_open' : 'window_full', vars }] };
}

/**
 * The summary's yes: the confirmation armed, the values read again, the report filed through the
 * gate. Changed since the summary: R3 refuses and the summary is read again. A parcel delivered that
 * day: a person checks first (R8). Filed: the depot agent is asked after the turn.
 */
function reportMissing(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const params = reportParams(s);
  const { decision, value } = call(c, { tool: 'createReport', params });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict === 'NEEDS_HUMAN' && decision.reason === 'delivered') return { kind: 'decision', decision: handoff(s, 'delivered', acks) };
  if (decision.verdict !== 'ALLOW' || value === null) return c.refusal(decision);
  s.pendingHash = null;
  const report = value.number;
  const notify = call(c, { tool: 'notifyDepot', params: { report, missingNote: params.missingNote, expectedDate: params.expectedDate } });
  if (notify.decision.verdict !== 'ALLOW') {
    return { kind: 'said', acks: [...acks, { promptId: 'report_filed', vars: { report } }, { promptId: 'depot_unavailable', vars: {} }] };
  }
  s.pendingService = 'depot';
  setReportFact(s.facts, report);
  return { kind: 'decision', decision: prompt('report_filed', null, { report }, acks) };
}

/** The depot agent's answer, checked: a whole number of days from one to seven, or nothing. */
export function depotDays(result: unknown): number | null {
  const days = (result as { searchDays?: unknown } | null)?.searchDays;
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 7 ? days : null;
}

/** The depot agent's answer as the caller hears it, through approved lines only. */
export function depotAnswer(c: AppContext, result: unknown): Ack {
  const days = depotDays(result);
  if (days === null || reportFact(c.s.facts) === null) return { promptId: 'depot_unavailable', vars: {} };
  return { promptId: 'depot_result', vars: { days: String(days) } };
}

function entryFor(form: TestkitForm): FormDef['entry'] {
  return (s) => (form === 'track_parcel'
    ? { tool: 'listParcels', params: { accountId: accountIdOf(s) } }
    : { tool: 'getAccount', params: { accountId: accountIdOf(s) }, purpose: form });
}

/** What an allowed entry call leaves: the parcels (one is the one they mean), or the account. */
function onEntryFor(form: TestkitForm): NonNullable<FormDef['onEntry']> {
  return (s, value) => {
    if (form !== 'track_parcel') {
      setAccountFact(s.facts, value as AccountView | null);
      return;
    }
    const parcels = value as ParcelView[];
    setParcelsFact(s.facts, parcels);
    const [only] = parcels;
    const slot = s.slots.parcelSelect!;
    if (parcels.length === 1 && only && slot.value === null) Object.assign(slot, { value: only.number, display: only.number, confirmed: true, window: null });
  };
}

export const FORMS: Record<TestkitForm, FormDef> = {
  track_parcel: {
    slots: ['parcelSelect'],
    summaryPromptId: null,
    entry: entryFor('track_parcel'),
    onEntry: onEntryFor('track_parcel'),
    // Staff name a parcel by number: there is no list of their own to read first.
    principalEntry: () => null,
    complete: trackParcel,
  },
  delivery_window: {
    slots: ['deliveryDay', 'deliveryPart'],
    summaryPromptId: null,
    entry: entryFor('delivery_window'),
    onEntry: onEntryFor('delivery_window'),
    // Booking for a customer is not something staff do on this line.
    principalEntry: (c) => handoff(c.s, 'needs-human', c.acks),
    complete: deliveryWindow,
  },
  report_missing: {
    slots: ['missingNote', 'expectedDate'],
    summaryPromptId: 'confirm_report',
    entry: entryFor('report_missing'),
    onEntry: onEntryFor('report_missing'),
    principalEntry: staffReportCheck,
    confirmedParams: reportParams,
    complete: reportMissing,
  },
};

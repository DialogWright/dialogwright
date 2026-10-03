import type { AppContext, GateDecision, GateLookups, ToolCall, ToolDef } from 'dialogwright';
import { DemoDirectory, type AppointmentDirectory, type Booking } from './directory';

/** What each tool returns when the gate allows it. */
export interface ClinicToolValues {
  findAppointment: Booking | null;
  listOpenings: string[];
  bookAppointment: { ref: string };
  moveAppointment: { ref: string };
  cancelAppointment: { ref: string };
}
export type ClinicTool = keyof ClinicToolValues;

/** A change the line made to the schedule, as the demo systems keep it. */
export interface ScheduleChange {
  ref: string;
  kind: 'book' | 'move' | 'cancel';
  provider: string;
  date: string;
  time: string;
}

/**
 * The clinic's systems for one call: the directory (deterministic, from the day it is asked on, so
 * it is built per call from the turn's date) and the changes made on the call. A real deployment
 * puts its scheduling system behind the same tools.
 */
export class ClinicSystems {
  readonly changes: ScheduleChange[] = [];

  directory(todayIso: string): AppointmentDirectory {
    return new DemoDirectory(todayIso);
  }

  record(change: Omit<ScheduleChange, 'ref'>): string {
    const ref = `A${1001 + this.changes.length}`;
    this.changes.push({ ref, ...change });
    return ref;
  }
}

/** No call names a subject (the clinic verifies no one, so no tool runs R2): the lookups have nothing to find. */
export const CLINIC_LOOKUPS: GateLookups = { ownerOf: () => null, scopeOf: () => [] };

/** A call through the gate, its value typed: null unless the gate allowed it. */
export function callClinic<T extends ClinicTool>(c: AppContext, call: ToolCall & { tool: T }): { decision: GateDecision; value: ClinicToolValues[T] | null } {
  return c.callTool(call) as { decision: GateDecision; value: ClinicToolValues[T] | null };
}

type Run<T extends ClinicTool> = (p: ToolCall['params'], sys: ClinicSystems, ctx: Parameters<ToolDef['run']>[2]) => { value: ClinicToolValues[T]; summary: string; ref?: string };

/**
 * A tool and the params its calls carry (ToolDef.params): what `check` holds to being recorded as
 * declared, each a slot with a redact setting or a param policy.yaml's `audit:` names.
 */
function tool<T extends ClinicTool>(params: readonly string[], run: Run<T>): ToolDef {
  return { params, run: (call, sys, ctx) => run(call.params, sys as ClinicSystems, ctx) };
}

/** What every write carries, in the order the confirmed rule takes its hash over: who, with whom, and when. */
const WRITE_PARAMS = ['name', 'dob', 'provider', 'date', 'time'] as const;

/** A write: recorded as a change, with a reference the audit row carries. */
function write(kind: ScheduleChange['kind'], done: string): ToolDef {
  return tool(WRITE_PARAMS, (p, sys) => {
    const ref = sys.record({ kind, provider: p.provider ?? '', date: p.date ?? '', time: p.time ?? '' });
    return { value: { ref }, summary: `${done} ${ref}`, ref };
  });
}

/**
 * The clinic's tools. Each runs only after the gate allowed it; none decides anything itself. The
 * two reads look the schedule up; the three writes change it, each after the caller confirmed the
 * summary that named exactly what is written (R3).
 */
export const CLINIC_TOOLS: { readonly [T in ClinicTool]: ToolDef } = {
  findAppointment: tool<'findAppointment'>(['name', 'dob', 'provider'], (p, sys, { tc }) => {
    const found = sys.directory(tc.todayIso).find(p.name ?? '', p.dob ?? '', p.provider ?? '');
    return { value: found, summary: found ? 'appointment found' : 'no appointment' };
  }),
  listOpenings: tool<'listOpenings'>(['provider', 'date'], (p, sys, { tc }) => {
    const times = sys.directory(tc.todayIso).openings(p.provider ?? '', p.date ?? '');
    return { value: times, summary: `${times.length} opening${times.length === 1 ? '' : 's'}` };
  }),
  bookAppointment: write('book', 'booked'),
  moveAppointment: write('move', 'moved'),
  cancelAppointment: write('cancel', 'cancelled'),
};

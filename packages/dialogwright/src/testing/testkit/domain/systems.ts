import type { GateLookups } from '../../../gate/types';
import { CUSTOMERS, customerById, PARCELS, type Customer, type Parcel, type ParcelStatus } from './data';

/** A parcel as the tools return it. */
export interface ParcelView {
  readonly number: string;
  readonly item: string;
  readonly status: ParcelStatus;
  readonly day: string;
  /** Where it may be left; withheld from a depot viewer (policy.yaml redact, the tools' fields). */
  readonly safePlace: string | null;
}

/** A missing-parcel report the line filed. */
export interface Report {
  readonly number: string;
  readonly owner: string;
  readonly missingNote: string;
  readonly expectedDate: string;
}

/** The parts of the day a delivery can be booked in, in keypad order (1, 2, 3). */
export const DAY_PARTS = ['morning', 'afternoon', 'evening'] as const;
export type DayPart = (typeof DAY_PARTS)[number];

/** The account a verified customer has, as the forms read it. */
export interface AccountView {
  readonly id: string;
  readonly first: string;
  readonly depotId: string;
}

function view(p: Parcel): ParcelView {
  return { number: p.number, item: p.item, status: p.status, day: p.day, safePlace: p.safePlace };
}

/** Sunday is 0, as Date reads it. */
function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * Example Parcels' systems, in memory and deterministic: a fresh copy per call (App.systems), so a report
 * filed on one call is never seen by the next.
 */
export class ParcelSystems {
  private readonly reports: Report[] = [];
  /** Each report by the idempotency key of the write that filed it. */
  private readonly byKey = new Map<string, Report>();
  private nextReport = 9001;
  /** Texts sent, newest last: only whom and what, never a code. */
  readonly texts: Array<{ to: string; what: string }> = [];

  verify(accountId: string, dob: string): Customer | null {
    const c = customerById(accountId);
    return c && c.dob === dob ? c : null;
  }

  account(id: string): AccountView | null {
    const c = customerById(id);
    return c ? { id: c.id, first: c.first, depotId: c.depotId } : null;
  }

  listParcels(owner: string): ParcelView[] {
    return PARCELS.filter((p) => p.owner === owner).map(view);
  }

  getParcel(number: string): ParcelView | null {
    const p = PARCELS.find((x) => x.number === number);
    return p ? view(p) : null;
  }

  /** The customer a parcel or a report belongs to, or null for neither. */
  ownerOf(record: string): string | null {
    return PARCELS.find((p) => p.number === record)?.owner ?? this.reports.find((r) => r.number === record)?.owner ?? null;
  }

  /** The customers a depot serves. */
  depotScope(depotId: string): string[] {
    return CUSTOMERS.filter((c) => c.depotId === depotId).map((c) => c.id);
  }

  /** Whether a delivery can be booked: never on a Sunday, and no evenings on a Saturday. */
  windowOpen(day: string, part: string): boolean {
    const wd = weekdayOf(day);
    if (wd === 0) return false;
    return !(wd === 6 && part === 'evening');
  }

  /** Whether a parcel of the customer's shows as delivered on `day`. */
  deliveredOn(owner: string, day: string): boolean {
    return PARCELS.some((p) => p.owner === owner && p.status === 'delivered' && p.day === day);
  }

  /**
   * Files a report, or, for a key it has seen (the write's idempotency key, core/idempotency.ts), hands
   * back the report that key filed: a write repeated after a crash files nothing new.
   */
  createReport(r: Omit<Report, 'number'>, key?: string): Report {
    const seen = key === undefined ? undefined : this.byKey.get(key);
    if (seen) return seen;
    const report = { ...r, number: String(this.nextReport++) };
    this.reports.push(report);
    if (key !== undefined) this.byKey.set(key, report);
    return report;
  }

  /** The reports filed for a customer, oldest first. */
  reportsOf(owner: string): Report[] {
    return this.reports.filter((r) => r.owner === owner);
  }

  /** Texts the phone on file; null when there is no such customer. */
  sendText(to: string, what: string): { phoneLast4: string } | null {
    const c = customerById(to);
    if (!c) return null;
    this.texts.push({ to, what });
    return { phoneLast4: c.phoneLast4 };
  }
}

/** Example Parcels' lookups: the gate's, and the delivered-day check its own rule (R8) reads. */
export interface ParcelLookups extends GateLookups {
  deliveredOn(owner: string, day: string): boolean;
}

/** The gate's lookups over the systems. Scope comes from the verified principal only. */
export function lookupsFor(sys: ParcelSystems): ParcelLookups {
  return {
    ownerOf: (record) => sys.ownerOf(record),
    scopeOf: (p) => (p.level === 0 ? [] : p.kind === 'customer' ? [p.id] : p.kind === 'agent' ? sys.depotScope(p.attrs?.depotId ?? '') : []),
    deliveredOn: (owner, day) => sys.deliveredOn(owner, day),
  };
}

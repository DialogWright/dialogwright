/**
 * Example Parcels' fictional book: three customers, two depot staff, a handful of parcels. Every name,
 * number and date is made up; phone numbers are in the 555 range.
 */

export interface Customer {
  /** The account ID, eight digits: the record key and the first identity factor. */
  readonly id: string;
  readonly first: string;
  readonly last: string;
  /** ISO date of birth, the second identity factor. */
  readonly dob: string;
  /** The last four digits of the phone on file, where the one-time code goes. */
  readonly phoneLast4: string;
  /** The depot that serves the customer: the staff of that depot may see their parcels. */
  readonly depotId: string;
}

export type StaffRole = 'viewer' | 'clerk';

/** Depot staff who sign in to the staff chat and act for the customers their depot serves. */
export interface Staff {
  /** The sign-in id ("taylor"). */
  readonly id: string;
  /** The staff number the principal is keyed by. */
  readonly staffNo: string;
  readonly name: string;
  readonly depot: string;
  readonly depotId: string;
  readonly role: StaffRole;
}

export type ParcelStatus = 'in_transit' | 'out_for_delivery' | 'delivered' | 'held';

export interface Parcel {
  /** Four digits. */
  readonly number: string;
  readonly owner: string;
  /** What the parcel is, as the line says it ("a box of books"). */
  readonly item: string;
  readonly status: ParcelStatus;
  /** ISO: the day it is due, or the day it was delivered. */
  readonly day: string;
}

export const CUSTOMERS: readonly Customer[] = [
  { id: '55501234', first: 'Alex', last: 'Rivera', dob: '1985-04-12', phoneLast4: '0101', depotId: 'D1' },
  { id: '55505678', first: 'Sam', last: 'Okoro', dob: '1979-11-03', phoneLast4: '0102', depotId: 'D1' },
  { id: '55509012', first: 'Casey', last: 'Moreno', dob: '1992-07-21', phoneLast4: '0103', depotId: 'D2' },
];

export const STAFF: readonly Staff[] = [
  { id: 'taylor', staffNo: 'S-101', name: 'Taylor Quinn', depot: 'North Depot', depotId: 'D1', role: 'viewer' },
  { id: 'morgan', staffNo: 'S-102', name: 'Morgan Blake', depot: 'North Depot', depotId: 'D1', role: 'clerk' },
];

export const PARCELS: readonly Parcel[] = [
  { number: '7101', owner: '55501234', item: 'a box of books', status: 'in_transit', day: '2026-09-21' },
  { number: '7102', owner: '55501234', item: 'a pair of boots', status: 'delivered', day: '2026-09-16' },
  { number: '7103', owner: '55501234', item: 'a desk lamp', status: 'out_for_delivery', day: '2026-09-18' },
  { number: '7201', owner: '55505678', item: 'a coffee grinder', status: 'in_transit', day: '2026-09-22' },
  { number: '7301', owner: '55509012', item: 'a rain jacket', status: 'held', day: '2026-09-17' },
];

export function customerById(id: string): Customer | undefined {
  return CUSTOMERS.find((c) => c.id === id);
}

export function staffById(id: string): Staff | undefined {
  return STAFF.find((s) => s.id === id);
}

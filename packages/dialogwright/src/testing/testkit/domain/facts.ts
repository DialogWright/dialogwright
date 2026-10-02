import type { FactsConfig } from '../../../core/app/types';
import type { SessionFacts } from '../../../core/session';
import type { AccountView, ParcelView } from './systems';

/**
 * What the tools returned about the caller, kept for the rest of the call: their account, their
 * parcels (until a form closes), and the report this call filed. Read and written only here.
 */
export type TestkitFacts = {
  account: AccountView | null;
  parcels: ParcelView[] | null;
  report?: string;
};

export const accountFact = (f: Readonly<SessionFacts>): AccountView | null => (f.account ?? null) as AccountView | null;
export const parcelsFact = (f: Readonly<SessionFacts>): ParcelView[] | null => (f.parcels ?? null) as ParcelView[] | null;
export const reportFact = (f: Readonly<SessionFacts>): string | null => (typeof f.report === 'string' ? f.report : null);

export function setAccountFact(f: SessionFacts, a: AccountView | null): void {
  f.account = a;
}
export function setParcelsFact(f: SessionFacts, p: ParcelView[] | null): void {
  f.parcels = p;
}
export function setReportFact(f: SessionFacts, report: string): void {
  f.report = report;
}

export const TESTKIT_FACTS: FactsConfig = {
  initial: (): TestkitFacts => ({ account: null, parcels: null }),
  clone: (f): TestkitFacts => {
    const account = accountFact(f);
    const parcels = parcelsFact(f);
    const report = reportFact(f);
    return { account: account ? { ...account } : null, parcels: parcels ? parcels.map((p) => ({ ...p })) : null, ...(report !== null ? { report } : {}) };
  },
  // The parcel list is listed again for the next form; the account and the report stay.
  onFormClosed: (f) => setParcelsFact(f, null),
  // The customer's parcels, to choose one by what is in it.
  forSlots: (f) => ({ records: (parcelsFact(f) ?? []).map((p) => ({ number: p.number, item: p.item, day: p.day })) }),
};

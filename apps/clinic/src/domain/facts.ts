import type { FactsConfig, Session, SessionFacts } from 'dialogwright';
import { isDaypart, type Booking, type Daypart } from './directory';

/** The openings offered on a scheduling form: the summary names `times[index]`. */
export interface Offer {
  provider: string;
  date: string;
  times: string[];
  index: number;
}

/**
 * What the clinic keeps on the session (Session.facts), read and written only through this module:
 * - `daypart`: the part of the day the caller asked for, if they ever did; read, never asked, and
 *   kept for the rest of the call (a second booking on the call is wanted at the same time of day);
 * - `offer`: the openings the scheduling summary offers, and which one;
 * - `existing`: the booking the directory found for the caller, which a summary reads back;
 * - `summaryHeard`: the form, provider and caller the last whole summary named; while they still
 *   match, a re-read says only the day and time (confirm_time).
 */
export type ClinicFacts = {
  daypart: Daypart | null;
  offer: Offer | null;
  existing: Booking | null;
  summaryHeard: string | null;
};

/** The clinic's facts on a session, to read and write. */
export function factsOf(s: Session): ClinicFacts {
  return s.facts as unknown as ClinicFacts;
}

function copy(f: Readonly<SessionFacts>): ClinicFacts {
  const offer = f.offer as Offer | null | undefined;
  const existing = f.existing as Booking | null | undefined;
  return {
    daypart: isDaypart(f.daypart) ? f.daypart : null,
    offer: offer ? { ...offer, times: [...offer.times] } : null,
    existing: existing ? { ...existing } : null,
    summaryHeard: typeof f.summaryHeard === 'string' ? f.summaryHeard : null,
  };
}

export const CLINIC_FACTS: FactsConfig = {
  initial: (): ClinicFacts => ({ daypart: null, offer: null, existing: null, summaryHeard: null }),
  clone: (f) => copy(f),
  // The offer, the booking found and what was heard belong to the form just closed; the part of the
  // day stays, as the caller's name and birthday do (App.carrySlots).
  onFormClosed: (f) => {
    f.offer = null;
    f.existing = null;
    f.summaryHeard = null;
  },
};

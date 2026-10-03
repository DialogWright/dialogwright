/**
 * Fixture data behind the stub tools: the days until the first opening for each service, and the
 * accounts a caller can verify as. Invented names and numbers (the 555 range), for the demo and the
 * tests; the real system replaces them.
 */
export const FIRST_OPENING_IN_DAYS: Readonly<Record<string, number>> = {
  repair: 1,
  inspection: 3,
  installation: 7,
};

export interface Account {
  accountId: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  first: string;
}

export const ACCOUNTS: readonly Account[] = [
  { accountId: '55501234', dob: '1980-04-12', first: 'Avery' },
  { accountId: '55505678', dob: '1975-06-14', first: 'Morgan' },
];

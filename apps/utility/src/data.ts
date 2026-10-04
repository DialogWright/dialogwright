/**
 * Fixture data behind the stub tools: the accounts a caller can verify as, with their balances and
 * the last outage at each, and the property managers who act for some of them. Invented names, streets and numbers (the 555
 * range), for the demo and the tests; the real billing and outage systems replace them.
 */

export interface Account {
  accountId: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  first: string;
  last: string;
  /** The last four digits of the phone on the account, where the one-time code is texted. */
  phoneLast4: string;
  /** The service address. */
  address: string;
  /** The current balance, a plain decimal. */
  balance: string;
  /** The day the balance is due, as an ISO date. */
  due: string;
  /** The last outage on record at the service address (its first day, as an ISO date, and how many hours it lasted), or null for none. */
  lastOutage: { day: string; hours: number } | null;
}

export const ACCOUNTS: readonly Account[] = [
  { accountId: '55501234', dob: '1980-04-12', first: 'Avery', last: 'Quill', phoneLast4: '0142', address: '14 Birch Lane', balance: '240.00', due: '2026-10-05', lastOutage: { day: '2026-09-02', hours: 26 } },
  { accountId: '55505678', dob: '1975-06-14', first: 'Morgan', last: 'Vale', phoneLast4: '0177', address: '200 Heron Row, unit 3', balance: '312.00', due: '2026-10-09', lastOutage: { day: '2026-08-14', hours: 3 } },
  { accountId: '55503456', dob: '1968-11-30', first: 'Casey', last: 'Rowe', phoneLast4: '0163', address: '200 Heron Row, unit 7', balance: '180.00', due: '2026-10-12', lastOutage: { day: '2026-08-14', hours: 3 } },
  { accountId: '55509012', dob: '1990-01-01', first: 'Jordan', last: 'Pike', phoneLast4: '0119', address: '9 Fernhill Court', balance: '0.00', due: '2026-10-20', lastOutage: null },
];

/** Someone who manages several accounts (the buildings they look after), and signs in on the chat. */
export interface Manager {
  id: string;
  first: string;
  name: string;
  /** The accounts they act for. */
  accounts: readonly string[];
}

export const MANAGERS: readonly Manager[] = [
  { id: 'riley', first: 'Riley', name: 'Riley Stone', accounts: ['55505678', '55503456'] },
];

export const accountOf = (accountId: string): Account | undefined => ACCOUNTS.find((a) => a.accountId === accountId);

/** What is owed on an account, or null for one that does not exist: the bound on an arrangement. */
export const amountDue = (accountId: string): string | null => accountOf(accountId)?.balance ?? null;

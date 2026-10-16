/**
 * Harbor Mutual's fictional book of business: three members, their claims, two brokers of one office
 * and the members that office is agent of record for, and this year's use of the benefits the
 * knowledge base adds a usage line to. Every name, date and number is invented (phones in the 555
 * range); the dates fit the regression's day, 2026-09-18. The real systems replace them.
 */

/** The two plans: Accident Advantage and Accident Advantage Plus (kb.yaml's `plan` fact). */
export type PlanId = 'advantage' | 'advantage_plus';

export type LossType = 'accident_injury' | 'hospital_stay' | 'diagnosis';
export type ClaimStatus = 'received' | 'in_review' | 'approved' | 'paid' | 'needs_info';
export type BrokerRole = 'service_rep' | 'office_admin';

export interface Member {
  /** Eight digits. */
  id: string;
  first: string;
  last: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  /** The phone on file, where the one-time code and the upload link are texted. */
  phone: string;
  plan: PlanId;
  /** The coverage window, both ends inclusive; null `coverageTo` for coverage with no end. */
  coverageFrom: string;
  coverageTo: string | null;
}

/** The services a claim can be for, as the claims system names them (and the lines say them). */
export const SERVICES = [
  'emergency room visit', 'physical therapy', 'hospital stay', 'urgent care visit',
  'accident injury', 'covered diagnosis',
] as const;

export interface Claim {
  /** Four digits. */
  number: string;
  memberId: string;
  type: LossType;
  /** What the claim was for, as the member says it ("emergency room visit"). */
  service: (typeof SERVICES)[number];
  serviceDate: string;
  receivedDate: string;
  status: ClaimStatus;
  /** Medical: never shown to a broker (policy.yaml redact). */
  diagnosis: string;
  /** The paid or approved amount, a plain decimal; null until there is one. */
  amount: string | null;
  /** Typical business days to a decision. */
  decisionDays: number;
  /** For needs_info: the document the claim waits on, by its code (said by its approved line, doc_<code>). */
  missing: DocumentCode | null;
  /** The member's own words, for a claim filed on a call. Never shown to a broker. */
  statement: string | null;
}

export interface Broker {
  /** The broker portal's id for them. */
  id: string;
  first: string;
  name: string;
  office: string;
  officeId: string;
  role: BrokerRole;
}

export const MEMBERS: readonly Member[] = [
  { id: '42716358', first: 'Jordan', last: 'Ellis', dob: '1984-08-21', phone: '+15555550101', plan: 'advantage_plus', coverageFrom: '2025-01-01', coverageTo: null },
  { id: '55203318', first: 'Margaret', last: 'Hale', dob: '1948-11-22', phone: '+15555550102', plan: 'advantage', coverageFrom: '2024-07-01', coverageTo: null },
  { id: '60914477', first: 'Luis', last: 'Ortega', dob: '1991-07-09', phone: '+15555550103', plan: 'advantage', coverageFrom: '2026-01-01', coverageTo: null },
  // A member no broker here acts for, with coverage that ended: the policy read back's member out of everyone's scope.
  { id: '72046185', first: 'Sam', last: 'Porter', dob: '1979-03-30', phone: '+15555550104', plan: 'advantage', coverageFrom: '2025-06-01', coverageTo: '2026-05-31' },
];

export const CLAIMS: readonly Claim[] = [
  { number: '4702', memberId: '42716358', type: 'accident_injury', service: 'emergency room visit', serviceDate: '2026-09-14', receivedDate: '2026-09-16', status: 'in_review', diagnosis: 'wrist sprain', amount: null, decisionDays: 10, missing: null, statement: null },
  { number: '4655', memberId: '42716358', type: 'accident_injury', service: 'physical therapy', serviceDate: '2026-08-03', receivedDate: '2026-08-05', status: 'paid', diagnosis: 'ankle sprain', amount: '300.00', decisionDays: 10, missing: null, statement: null },
  { number: '4711', memberId: '55203318', type: 'hospital_stay', service: 'hospital stay', serviceDate: '2026-09-10', receivedDate: '2026-09-15', status: 'in_review', diagnosis: 'hip fracture', amount: null, decisionDays: 15, missing: null, statement: null },
  { number: '4720', memberId: '60914477', type: 'accident_injury', service: 'urgent care visit', serviceDate: '2026-09-02', receivedDate: '2026-09-04', status: 'needs_info', diagnosis: 'forearm laceration', amount: null, decisionDays: 10, missing: 'discharge_summary', statement: null },
  { number: '4690', memberId: '72046185', type: 'accident_injury', service: 'urgent care visit', serviceDate: '2026-03-14', receivedDate: '2026-03-18', status: 'paid', diagnosis: 'finger fracture', amount: '150.00', decisionDays: 10, missing: null, statement: null },
];

export const BROKERS: readonly Broker[] = [
  { id: 'dana', first: 'Dana', name: 'Dana Ruiz', office: 'Lakeside Benefits', officeId: 'LB-01', role: 'service_rep' },
  { id: 'priya', first: 'Priya', name: 'Priya Shah', office: 'Lakeside Benefits', officeId: 'LB-01', role: 'office_admin' },
];

/** Agent of record: an office's id to the members it represents. The only source of a broker's scope. */
export const AGENT_OF_RECORD: Readonly<Record<string, readonly string[]>> = {
  'LB-01': ['55203318', '60914477'],
};

/** This calendar year's use of a benefit, by member and knowledge-base topic. */
export const USAGE: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  '42716358': { physical_therapy: 4, follow_up: 1 },
  '55203318': { hospital_stay: 5 },
  '60914477': { urgent_care: 1 },
};

/** New claim numbers start here and count up. */
export const FIRST_NEW_CLAIM = 4730;

/** The documents the claims intake service may ask for, by code: each has an approved line (doc_<code>). */
export const DOCUMENT_CODES = ['discharge_summary', 'imaging_report', 'admission_dates', 'itemized_bill', 'physician_statement', 'loss_description'] as const;
export type DocumentCode = (typeof DOCUMENT_CODES)[number];

/** A member by id, or undefined. */
export const memberOf = (id: string): Member | undefined => MEMBERS.find((m) => m.id === id);

/** A broker by their portal id, or undefined. */
export const brokerOf = (id: string): Broker | undefined => BROKERS.find((b) => b.id === id);

/** The last four digits of a phone number. */
export const last4 = (phone: string): string => phone.slice(-4);

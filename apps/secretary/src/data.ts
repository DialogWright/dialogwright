/**
 * Fixture data behind the stub tools: the studio's inbox addresses, one per person and one for anyone,
 * and each person's status as the studio's calendar reports it. Invented, for the demo and the tests
 * (example.com); the real systems replace them.
 */
export const INBOX_OF: Readonly<Record<string, string>> = {
  riley: 'riley@example.com',
  sam: 'sam@example.com',
  jordan: 'jordan@example.com',
  anyone: 'frontdesk@example.com',
};

/** The statuses a person's calendar can report: the closed list the status tool's reply is checked against. */
export const STATUSES = ['available', 'out_of_office', 'in_training', 'in_a_meeting'] as const;
export type Status = (typeof STATUSES)[number];

/** The day an out-of-office note says the person is back on. */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A person's status, as a calendar or presence system reports it: the status, and the day they are back on where the note gives one. */
export interface Presence {
  status: Status;
  back: Weekday | null;
}

/**
 * Each person's status today, as each of them set it in the studio's calendar: Riley is in, Sam is
 * out of the office until Monday, Jordan is in training. Only the three people have one: "the team"
 * (anyone) is no one's calendar.
 */
export const PRESENCE_OF: Readonly<Record<string, Presence>> = {
  riley: { status: 'available', back: null },
  sam: { status: 'out_of_office', back: 'Monday' },
  jordan: { status: 'in_training', back: null },
};

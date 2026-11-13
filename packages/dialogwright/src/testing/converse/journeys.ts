/**
 * YAML fragments the journeys tests append to the fixture business (agent.yaml in this folder), in this
 * order: LEAVE_NOTE_ACTION, which goes on the end of the fixture's `actions:` block (the last top-level
 * key, so its two-space indent continues that map), then one journeys fragment, whose `root:` and
 * `journeys:` are new top-level keys. `fixtureWith(...)` in a test is `base + LEAVE_NOTE_ACTION + JOURNEYS_YAML`.
 */

/** A change action, `leave_note`, indented to join the fixture's `actions:`. */
export const LEAVE_NOTE_ACTION = `  leave_note:
    about: Leave a note asking for a call back.
    kind: change
    params:
      name: { type: text, about: The name to leave the note under. }
      phone: { type: phone, about: The number to call back on. }
    readBack:
      en: "A note for {name}, to call back on {phone}. Is that right?"
    audit: { name: length, phone: last4 }
`;

/** The root with guidance and no actions, and two journeys: a visit (availability, book) and a note (leave_note). */
export const JOURNEYS_YAML = `root:
  instructions: >-
    Answer what you can from the business information. For anything else, say plainly that it is not
    something we can help with, and offer what we can do.
journeys:
  visit:
    when: The caller wants a visit booked, or wants to know about one.
    goal: Book a visit into a window, read back and confirmed by the caller.
    instructions: >-
      Check the day they want before offering a window.
    facts: [Visits last about an hour.]
    questions:
      - { q: How long does a visit take?, a: About an hour. }
    actions: [availability, book]
  note:
    when: The caller wants to speak with someone, or wants a call back.
    goal: Leave a note asking for a call back, read back and confirmed by the caller.
    actions: [leave_note]
`;

/** As JOURNEYS_YAML, with an account journey that starts where the number is on an account and a visit closed to such callers. */
export const ACCOUNT_JOURNEYS_YAML = `root:
  instructions: >-
    Answer what you can from the business information. For anything else, say plainly that it is not
    something we can help with, and offer what we can do.
journeys:
  visit:
    when: The caller wants a visit booked, or wants to know about one.
    for: { account: none }
    goal: Book a visit into a window, read back and confirmed by the caller.
    instructions: >-
      Check the day they want before offering a window.
    facts: [Visits last about an hour.]
    questions:
      - { q: How long does a visit take?, a: About an hour. }
    actions: [availability, book]
  visit_account:
    when: The caller wants visits booked for their account.
    for: { account: recognised }
    start: { account: recognised }
    goal: Book the account's visits into a window, read back and confirmed by the caller.
    actions: [availability, book]
  note:
    when: The caller wants to speak with someone, or wants a call back.
    goal: Leave a note asking for a call back, read back and confirmed by the caller.
    actions: [leave_note]
`;
